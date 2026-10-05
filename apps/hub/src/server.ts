import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { normalizeOtlpPayload, parseClientMsg } from "@drone-city/model";
import type { OtlpCounters, SessionEvent } from "@drone-city/model";
import { Broadcaster } from "./broadcaster.ts";
import type { HubConfig } from "./config.ts";
import { SessionStore } from "./store.ts";
import type { Changes, Clock } from "./store.ts";

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

const consoleLogger: Logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {} };

export interface BackfillStats {
  ran: boolean;
  dirs: number;
  sessions: number;
  files: number;
  lines: number;
  events: number;
  ignored: number;
  malformed: number;
  unreadable: number;
}

export interface HubCounters {
  /** POST /v1/logs requests received. */
  requests: number;
  /** Request bodies that were not valid JSON / not an OTLP logs payload. */
  badRequests: number;
  /** Requests rejected for a non-JSON content type (e.g. protobuf). */
  unsupportedMediaType: number;
  tooLarge: number;
  /** Log records seen across all accepted requests. */
  records: number;
  accepted: number;
  /** Dropped by the vcs.repository.name filter. */
  filtered: number;
  /** Unmapped event names, by name. */
  unknown: Record<string, number>;
  /** Records that were structurally unusable. */
  malformed: number;
  /** Events dropped because the same (kind, id) was already ingested. */
  duplicates: number;
}

export interface Hub {
  readonly server: Server;
  readonly store: SessionStore;
  readonly counters: HubCounters;
  readonly backfill: BackfillStats;
  readonly broadcaster: Broadcaster;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  /** Feed already-normalized events (used by backfill). */
  ingest(events: SessionEvent[]): Changes;
  /** Run one lifecycle pass now (also runs on an interval once listening). */
  tick(): Changes;
  health(): Record<string, unknown>;
}

export interface HubDeps {
  clock?: Clock;
  logger?: Logger;
}

const PROTOBUF_MESSAGE =
  "Unsupported Content-Type. This hub accepts OTLP/HTTP with JSON encoding only " +
  "(Content-Type: application/json). Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json " +
  "(or OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json) on the Claude Code client.";

class BodyTooLarge extends Error {}

/** Beyond this many bytes we stop draining an oversized upload and cut the connection. */
const DRAIN_LIMIT = 64 * 1024 * 1024;

/**
 * Collect the request body up to `limit` bytes. An oversized body is drained (not stored) so the
 * client can still read our 413, then rejects with BodyTooLarge.
 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > DRAIN_LIMIT) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => (tooLarge ? reject(new BodyTooLarge()) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

export function createHub(config: HubConfig, deps: HubDeps = {}): Hub {
  const clock = deps.clock ?? { now: () => Date.now() };
  const log = deps.logger ?? consoleLogger;
  const store = new SessionStore();
  const startedAt = clock.now();

  const counters: HubCounters = {
    requests: 0,
    badRequests: 0,
    unsupportedMediaType: 0,
    tooLarge: 0,
    records: 0,
    accepted: 0,
    filtered: 0,
    unknown: {},
    malformed: 0,
    duplicates: 0,
  };
  const backfill: BackfillStats = {
    ran: false,
    dirs: 0,
    sessions: 0,
    files: 0,
    lines: 0,
    events: 0,
    ignored: 0,
    malformed: 0,
    unreadable: 0,
  };

  const broadcaster = new Broadcaster({
    coalesceMs: config.coalesceMs,
    maxQueued: config.maxQueued,
    highWaterBytes: config.highWaterBytes,
    snapshot: () => store.snapshot(clock.now()),
  });

  const publish = (c: Changes): Changes => {
    counters.duplicates += c.duplicates;
    broadcaster.publish(c);
    return c;
  };

  function addCounters(c: OtlpCounters): void {
    counters.records += c.records;
    counters.accepted += c.accepted;
    counters.filtered += c.filtered;
    counters.malformed += c.malformed;
    for (const [name, n] of Object.entries(c.unknown)) {
      const key =
        name in counters.unknown || Object.keys(counters.unknown).length < 64 ? name : "(other)";
      counters.unknown[key] = (counters.unknown[key] ?? 0) + n;
    }
  }

  async function handleLogs(req: IncomingMessage, res: ServerResponse): Promise<void> {
    counters.requests++;
    const contentType = (req.headers["content-type"] ?? "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      counters.unsupportedMediaType++;
      req.resume();
      sendJson(res, 415, { error: PROTOBUF_MESSAGE });
      return;
    }
    let raw: Buffer;
    try {
      raw = await readBody(req, config.maxBodyBytes);
    } catch (err) {
      if (err instanceof BodyTooLarge) {
        counters.tooLarge++;
        sendJson(res, 413, { error: `Request body exceeds ${config.maxBodyBytes} bytes.` });
      } else {
        counters.badRequests++;
        sendJson(res, 400, { error: "Could not read request body." });
      }
      return;
    }
    let payload: unknown;
    try {
      const encoding = (req.headers["content-encoding"] ?? "").toLowerCase();
      const body =
        encoding === "gzip" ? gunzipSync(raw, { maxOutputLength: config.maxBodyBytes * 4 }) : raw;
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      counters.badRequests++;
      sendJson(res, 400, { error: "Body is not valid JSON." });
      return;
    }
    const result = normalizeOtlpPayload(payload, {
      targetRepo: config.targetRepo,
      now: () => clock.now(),
    });
    if (!result.valid) {
      counters.badRequests++;
      sendJson(res, 400, { error: "Body is not an OTLP logs payload (missing resourceLogs[])." });
      return;
    }
    addCounters(result.counters);
    publish(store.ingest(result.events, clock.now()));
    // OTLP success response: an empty ExportLogsServiceResponse.
    sendJson(res, 200, {});
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://hub.invalid");
    const route = (): void => {
      if (url.pathname === "/v1/logs") {
        if (req.method !== "POST") {
          res.setHeader("allow", "POST");
          sendJson(res, 405, { error: "Use POST." });
          return;
        }
        handleLogs(req, res).catch((err: unknown) => {
          log.warn(`hub: unexpected error handling /v1/logs: ${String(err)}`);
          if (!res.headersSent) sendJson(res, 500, { error: "Internal error." });
        });
        return;
      }
      if (url.pathname === "/health" && (req.method === "GET" || req.method === "HEAD")) {
        sendJson(res, 200, health());
        return;
      }
      sendJson(res, 404, { error: "Not found. Endpoints: POST /v1/logs, GET /health, GET /ws." });
    };
    route();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://hub.invalid");
    if (url.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const detach = broadcaster.add(ws);
      ws.on("message", (data) => {
        const msg = parseClientMsg(data.toString());
        if (msg?.type === "hello") broadcaster.resync(ws);
      });
      ws.on("close", detach);
      ws.on("error", () => {
        detach();
        ws.terminate();
      });
    });
  });

  let tickTimer: NodeJS.Timeout | undefined;

  function health(): Record<string, unknown> {
    return {
      ok: true,
      uptimeSec: Math.round((clock.now() - startedAt) / 1000),
      sessions: store.size,
      wsClients: broadcaster.size,
      counters,
      backfill,
      ws: broadcaster.stats,
    };
  }

  const hub: Hub = {
    server,
    store,
    counters,
    backfill,
    broadcaster,
    ingest: (events) => publish(store.ingest(events, clock.now())),
    tick: () => publish(store.tick(clock.now())),
    health,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          tickTimer = setInterval(() => hub.tick(), config.tickMs);
          tickTimer.unref();
          const addr = server.address() as AddressInfo;
          resolve({ host: addr.address, port: addr.port });
        });
      });
    },
    close() {
      if (tickTimer) clearInterval(tickTimer);
      broadcaster.close();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.closeAllConnections();
      return new Promise((resolve) => {
        if (!server.listening) resolve();
        else server.close(() => resolve());
      });
    },
  };
  return hub;
}
