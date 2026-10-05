import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { END_AFTER_MS, FADE_AFTER_MS, IDLE_AFTER_MS } from "@drone-city/model";
import type { ServerMsg, Session, SessionEvent } from "@drone-city/model";
import { createHub, silentLogger } from "./server.ts";
import type { Hub } from "./server.ts";
import { SID1, SID2, otlpPayload, otlpRecord, testConfig } from "./test-helpers.ts";

const T0 = 1_760_000_000_000;

class Frames {
  readonly all: ServerMsg[] = [];
  private waiters: Array<{ pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }> = [];
  readonly ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as ServerMsg;
      this.all.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(msg)) return true;
        w.resolve(msg);
        return false;
      });
    });
  }
  /** Resolves with the first frame (already received or future) matching `pred`. */
  waitFor(pred: (m: ServerMsg) => boolean, ms = 3000): Promise<ServerMsg> {
    const existing = this.all.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`timeout; got ${JSON.stringify(this.all.map((m) => m.type))}`)),
        ms,
      );
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
  }
}

async function connect(base: string): Promise<Frames> {
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
  const frames = new Frames(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return frames;
}

describe("hub (HTTP + WebSocket integration)", () => {
  let hub: Hub;
  let base: string;
  let now = T0;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    now = T0;
    hub = createHub(testConfig(), { clock: { now: () => now }, logger: silentLogger });
    const addr = await hub.listen();
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await hub.close();
  });

  async function client(): Promise<Frames> {
    const f = await connect(base);
    sockets.push(f.ws);
    return f;
  }

  const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${base}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
    });

  it("sends a snapshot on connect, then the normalized event and the session upsert", async () => {
    const c = await client();
    const snap = await c.waitFor((m) => m.type === "snapshot");
    expect(snap).toMatchObject({ v: 1, type: "snapshot", sessions: [] });

    const res = await post(
      otlpPayload([
        otlpRecord({ "event.name": "user_prompt", "prompt.id": "p1" }, T0),
        otlpRecord(
          {
            "event.name": "api_request",
            request_id: "req_1",
            model: "model-x",
            input_tokens: 10,
            output_tokens: 20,
            cache_read_tokens: 300,
            cache_creation_tokens: 4,
            cost_usd: 0.01,
            query_source: "repl_main_thread",
          },
          T0 + 1000,
        ),
      ]),
    );
    expect(res.status).toBe(200);

    const events = (await c.waitFor((m) => m.type === "events")) as Extract<
      ServerMsg,
      { type: "events" }
    >;
    const req = events.events.find((e: SessionEvent) => e.kind === "api_request");
    expect(req).toMatchObject({
      id: "req_1",
      sessionId: SID1,
      agentId: null,
      machine: "laptop",
      source: "otel",
      model: "model-x",
      tokens: { input: 10, output: 20, cacheRead: 300, cacheWrite: 4 },
      costUsd: 0.01,
      ts: T0 + 1000,
    });

    const upsert = (await c.waitFor((m) => m.type === "session")) as Extract<
      ServerMsg,
      { type: "session" }
    >;
    expect(upsert.session).toMatchObject({
      id: SID1,
      machine: "laptop",
      state: "active",
      model: "model-x",
      tokens: { input: 10, output: 20, cacheRead: 300, cacheWrite: 4 },
    });
    expect(upsert.session.recent.map((e) => e.kind)).toEqual(["prompt", "api_request"]);
  });

  it("gives a late joiner the full snapshot", async () => {
    await post(otlpPayload([otlpRecord({ "event.name": "user_prompt" }, T0)]));
    const c = await client();
    const snap = (await c.waitFor((m) => m.type === "snapshot")) as Extract<
      ServerMsg,
      { type: "snapshot" }
    >;
    expect(snap.sessions.map((s: Session) => s.id)).toEqual([SID1]);
    expect(snap.now).toBe(T0);
  });

  it("coalesces a burst of POSTs into few event frames", async () => {
    const c = await client();
    await c.waitFor((m) => m.type === "snapshot");
    for (let i = 0; i < 10; i++) {
      await post(
        otlpPayload([
          otlpRecord(
            {
              "event.name": "tool_result",
              tool_name: "Bash",
              tool_use_id: `t${i}`,
              success: "true",
            },
            T0 + i,
          ),
        ]),
      );
    }
    await c.waitFor((m) => m.type === "events" && m.events.some((e) => e.id === "t9"));
    const frames = c.all.filter((m) => m.type === "events");
    const total = frames.reduce((n, m) => n + (m.type === "events" ? m.events.length : 0), 0);
    expect(total).toBe(10);
    expect(frames.length).toBeLessThan(10);
  });

  it("filters by repository and counts unknown, filtered and malformed records", async () => {
    const res = await post(
      otlpPayload([
        otlpRecord({ "event.name": "user_prompt" }, T0),
        otlpRecord({ "event.name": "user_prompt", "vcs.repository.name": "someone-else" }, T0),
        otlpRecord({ "event.name": "hook_registered" }, T0),
        { attributes: kvOnly("event.name", "user_prompt") },
      ]),
    );
    expect(res.status).toBe(200);
    const health = (await (await fetch(`${base}/health`)).json()) as {
      ok: boolean;
      sessions: number;
      counters: Record<string, unknown>;
    };
    expect(health.ok).toBe(true);
    expect(health.sessions).toBe(1);
    expect(health.counters).toMatchObject({
      requests: 1,
      records: 4,
      accepted: 1,
      filtered: 1,
      malformed: 1,
      unknown: { hook_registered: 1 },
    });
  });

  it("does not broadcast other repositories' events", async () => {
    const c = await client();
    await c.waitFor((m) => m.type === "snapshot");
    await post(
      otlpPayload([
        otlpRecord({ "event.name": "user_prompt", "vcs.repository.name": "other" }, T0),
      ]),
    );
    await new Promise((r) => setTimeout(r, 60));
    expect(c.all.map((m) => m.type)).toEqual(["snapshot"]);
  });

  it("dedupes repeated events by (kind, id)", async () => {
    const rec = otlpRecord(
      { "event.name": "tool_result", tool_name: "Bash", tool_use_id: "dup", success: "true" },
      T0,
    );
    await post(otlpPayload([rec]));
    await post(otlpPayload([rec]));
    expect(hub.counters.duplicates).toBe(1);
    expect(hub.store.sessions.get(SID1)?.recent).toHaveLength(1);
  });

  it("answers 415 with a clear message for protobuf (and other non-JSON) bodies", async () => {
    const res = await fetch(`${base}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: new Uint8Array([0x0a, 0x00]),
    });
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("OTEL_EXPORTER_OTLP_PROTOCOL=http/json");
    expect(hub.counters.unsupportedMediaType).toBe(1);

    const noType = await fetch(`${base}/v1/logs`, { method: "POST", body: "{}" });
    expect(noType.status).toBe(415); // text/plain by default
  });

  it("answers 400 for invalid JSON and non-OTLP bodies, 413 for oversized bodies", async () => {
    expect((await post("{nope")).status).toBe(400);
    expect((await post({ hello: "world" })).status).toBe(400);
    expect(hub.counters.badRequests).toBe(2);
    const big = await post(JSON.stringify({ resourceLogs: [], pad: "x".repeat(2 * 1024 * 1024) }));
    expect(big.status).toBe(413);
    expect(hub.counters.tooLarge).toBe(1);
  });

  it("accepts gzip-encoded JSON", async () => {
    const body = gzipSync(
      JSON.stringify(otlpPayload([otlpRecord({ "event.name": "user_prompt" }, T0)])),
    );
    const res = await post(body, { "content-encoding": "gzip" });
    expect(res.status).toBe(200);
    expect(hub.store.size).toBe(1);
  });

  it("routes: 404 for unknown paths, 405 for GET /v1/logs", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    const get = await fetch(`${base}/v1/logs`);
    expect(get.status).toBe(405);
  });

  it("rejects websocket upgrades on other paths", async () => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/other`);
    sockets.push(ws);
    await new Promise<void>((resolve) => {
      ws.once("error", () => resolve());
      ws.once("open", () => resolve());
    });
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  });

  it("lifecycle tick pushes idle/ended upserts and then a remove", async () => {
    const c = await client();
    await c.waitFor((m) => m.type === "snapshot");
    await post(otlpPayload([otlpRecord({ "event.name": "user_prompt" }, T0)]));
    await c.waitFor((m) => m.type === "session" && m.session.state === "active");

    now = T0 + IDLE_AFTER_MS;
    hub.tick();
    await c.waitFor((m) => m.type === "session" && m.session.state === "idle");

    now = T0 + END_AFTER_MS;
    hub.tick();
    await c.waitFor((m) => m.type === "session" && m.session.state === "ended");

    now = T0 + END_AFTER_MS + FADE_AFTER_MS;
    hub.tick();
    const removed = await c.waitFor((m) => m.type === "remove");
    expect(removed).toEqual({ v: 1, type: "remove", sessionId: SID1 });
    expect(hub.store.size).toBe(0);
  });

  it("tracks subagents under the parent session from OTel events", async () => {
    const c = await client();
    await c.waitFor((m) => m.type === "snapshot");
    await post(
      otlpPayload([
        otlpRecord(
          {
            "event.name": "tool_decision",
            tool_name: "Agent",
            tool_use_id: "toolu_a",
            decision: "accept",
            tool_parameters: JSON.stringify({ subagent_type: "reviewer" }),
          },
          T0,
        ),
        otlpRecord(
          { "event.name": "api_request", request_id: "r1", query_source: "reviewer" },
          T0 + 500,
        ),
        otlpRecord({ "event.name": "subagent_completed", agent_type: "reviewer" }, T0 + 900),
      ]),
    );
    const m = (await c.waitFor(
      (x) =>
        x.type === "session" &&
        Object.keys(x.session.subagents).length > 0 &&
        x.session.subagents["reviewer"]?.state === "docked",
    )) as Extract<ServerMsg, { type: "session" }>;
    expect(m.session.subagents["reviewer"]).toMatchObject({ type: "reviewer", state: "docked" });
    expect(m.session.id).toBe(SID1);
  });

  it("handles two sessions independently", async () => {
    await post(
      otlpPayload([
        otlpRecord({ "event.name": "user_prompt", "session.id": SID2 }, T0),
        otlpRecord({ "event.name": "user_prompt" }, T0 + 1),
      ]),
    );
    expect(new Set(hub.store.sessions.keys())).toEqual(new Set([SID1, SID2]));
  });
});

function kvOnly(key: string, value: string): unknown[] {
  return [{ key, value: { stringValue: value } }];
}
