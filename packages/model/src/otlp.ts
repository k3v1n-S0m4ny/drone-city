import { isAgentTool, sanitizeDetail, toolDetail } from "./detail.ts";
import type { EventKind, SessionEvent } from "./types.ts";

// ---------------------------------------------------------------------------
// OTLP/HTTP JSON value parsing
// ---------------------------------------------------------------------------

export type AttrValue = string | number | boolean | null | AttrValue[] | { [k: string]: AttrValue };
export type Attrs = Record<string, AttrValue>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse an OTLP AnyValue. `intValue` may arrive as a string (64-bit ints are JSON strings). */
export function parseAnyValue(v: unknown): AttrValue {
  if (!isObject(v)) return null;
  if ("stringValue" in v) return typeof v.stringValue === "string" ? v.stringValue : null;
  if ("intValue" in v) {
    const n = typeof v.intValue === "number" ? v.intValue : Number(v.intValue);
    return Number.isFinite(n) ? n : null;
  }
  if ("doubleValue" in v) {
    const n = typeof v.doubleValue === "number" ? v.doubleValue : Number(v.doubleValue);
    return Number.isFinite(n) ? n : null;
  }
  if ("boolValue" in v) {
    if (typeof v.boolValue === "boolean") return v.boolValue;
    if (v.boolValue === "true") return true;
    if (v.boolValue === "false") return false;
    return null;
  }
  if ("arrayValue" in v) {
    const values = isObject(v.arrayValue) ? v.arrayValue.values : undefined;
    return Array.isArray(values) ? values.map(parseAnyValue) : [];
  }
  if ("kvlistValue" in v) {
    const values = isObject(v.kvlistValue) ? v.kvlistValue.values : undefined;
    return parseAttributes(values);
  }
  if ("bytesValue" in v) return typeof v.bytesValue === "string" ? v.bytesValue : null;
  return null;
}

/** Parse an OTLP `attributes[]` array into a plain object. Later keys win. */
export function parseAttributes(list: unknown): Attrs {
  const out: Attrs = {};
  if (!Array.isArray(list)) return out;
  for (const item of list as unknown[]) {
    if (isObject(item) && typeof item.key === "string") out[item.key] = parseAnyValue(item.value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Attribute coercion helpers (Claude Code sends several numbers/bools as strings)
// ---------------------------------------------------------------------------

export function attrString(v: AttrValue | undefined): string | undefined {
  if (typeof v === "string") return v === "" ? undefined : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

export function attrNumber(v: AttrValue | undefined): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function attrBool(v: AttrValue | undefined): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

function attrJsonObject(v: AttrValue | undefined): Record<string, unknown> | undefined {
  if (typeof v === "string") {
    try {
      const parsed: unknown = JSON.parse(v);
      return isObject(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return isObject(v) ? v : undefined;
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

export const MAIN_THREAD_SOURCE = "repl_main_thread";

/**
 * Request sources that are not subagents even though they are not the main thread.
 * (Assumption: `compact` is the conversation-compaction request of the main drone.)
 */
const MAIN_LIKE_SOURCES = new Set([MAIN_THREAD_SOURCE, "compact"]);

export interface OtlpNormalizeOptions {
  /** Keep only records whose vcs.repository.name equals this (case-insensitive). Omit to keep all. */
  targetRepo?: string;
  /** Used when a record carries no usable timestamp. */
  now: () => number;
}

export interface OtlpCounters {
  /** Log records seen. */
  records: number;
  /** Records turned into SessionEvents. */
  accepted: number;
  /** Dropped by the repository filter. */
  filtered: number;
  /** Event names we do not map, by name. */
  unknown: Record<string, number>;
  /** Records that were structurally unusable (no session.id, not an object...). */
  malformed: number;
}

export function emptyCounters(): OtlpCounters {
  return { records: 0, accepted: 0, filtered: 0, unknown: {}, malformed: 0 };
}

export type RecordResult =
  | { status: "event"; event: SessionEvent }
  | { status: "filtered" }
  | { status: "unknown"; name: string }
  | { status: "malformed" };

function stripPrefix(name: string): string {
  return name.startsWith("claude_code.") ? name.slice("claude_code.".length) : name;
}

function recordTimestamp(attrs: Attrs, record: Record<string, unknown>, now: () => number): number {
  const iso = attrString(attrs["event.timestamp"]);
  if (iso) {
    const t = Date.parse(iso);
    if (Number.isFinite(t)) return t;
  }
  for (const key of ["timeUnixNano", "observedTimeUnixNano"]) {
    const raw = record[key];
    if (typeof raw === "string" || typeof raw === "number") {
      try {
        const ms = Number(BigInt(raw) / 1_000_000n);
        if (ms > 0) return ms;
      } catch {
        // not an integer; try the next candidate
      }
    }
  }
  return now();
}

/**
 * Normalize one OTLP log record. `resourceAttrs` and the record attributes are merged
 * (record wins) before reading anything.
 */
export function normalizeOtlpRecord(
  resourceAttrs: Attrs,
  record: unknown,
  opts: OtlpNormalizeOptions,
): RecordResult {
  if (!isObject(record)) return { status: "malformed" };
  const attrs: Attrs = { ...resourceAttrs, ...parseAttributes(record.attributes) };

  const sessionId = attrString(attrs["session.id"]);
  if (!sessionId) return { status: "malformed" };

  const bodyName = isObject(record.body) ? parseAnyValue(record.body) : null;
  const rawName = attrString(attrs["event.name"]) ?? attrString(bodyName ?? undefined);
  if (!rawName) return { status: "malformed" };
  const name = stripPrefix(rawName);

  if (opts.targetRepo !== undefined) {
    const repo = attrString(attrs["vcs.repository.name"]);
    if (repo === undefined || repo.toLowerCase() !== opts.targetRepo.toLowerCase()) {
      return { status: "filtered" };
    }
  }

  const ts = recordTimestamp(attrs, record, opts.now);
  const machine = attrString(attrs["machine.name"]) ?? "unknown";
  const seq = attrNumber(attrs["event.sequence"]);

  const querySource = attrString(attrs["query_source"]);
  const agentName = attrString(attrs["agent.name"]);
  const agentId =
    querySource === undefined || MAIN_LIKE_SOURCES.has(querySource)
      ? null
      : (agentName ?? querySource);

  const synthId = (suffix?: string): string =>
    `otel:${sessionId}:${name}:${seq ?? ts}${suffix ? `:${suffix}` : ""}`;

  const base = { sessionId, agentId, ts, machine, source: "otel" as const };
  // Replay-only extension attributes (never sent by Claude Code): drone.label, drone.agent_id.
  const label = attrString(attrs["drone.label"]);
  const agentTypeAttr = attrString(attrs["agent_type"]);
  const duration = attrNumber(attrs["duration_ms"]);
  const model = attrString(attrs["model"]);

  const params = attrJsonObject(attrs["tool_parameters"]);
  const input = attrJsonObject(attrs["tool_input"]);
  let tool = attrString(attrs["tool_name"]);
  if (tool === "mcp_tool" && params) {
    const server = typeof params.mcp_server_name === "string" ? params.mcp_server_name : undefined;
    const t = typeof params.mcp_tool_name === "string" ? params.mcp_tool_name : undefined;
    if (server && t) tool = `mcp__${server}__${t}`;
  }
  const toolUseId = attrString(attrs["tool_use_id"]);

  const make = (kind: EventKind, id: string, extra: Partial<SessionEvent> = {}): RecordResult => {
    const event: SessionEvent = { id, kind, ...base, ...extra };
    if (label) event.label = label;
    if (event.agentId !== null && event.agentType === undefined && agentTypeAttr) {
      event.agentType = agentTypeAttr;
    }
    return { status: "event", event };
  };

  switch (name) {
    case "user_prompt":
      // Prompt text is never read, only the fact that a prompt happened.
      return make(
        "prompt",
        attrString(attrs["message.uuid"]) ?? synthId(attrString(attrs["prompt.id"])),
        { agentId: null },
      );

    case "api_request":
      return make("api_request", attrString(attrs["request_id"]) ?? synthId(), {
        model,
        durationMs: duration,
        tokens: {
          input: attrNumber(attrs["input_tokens"]) ?? 0,
          output: attrNumber(attrs["output_tokens"]) ?? 0,
          cacheRead: attrNumber(attrs["cache_read_tokens"]) ?? 0,
          cacheWrite: attrNumber(attrs["cache_creation_tokens"]) ?? 0,
        },
        costUsd: attrNumber(attrs["cost_usd"]),
        ok: true,
      });

    case "assistant_response":
      return make(
        "response",
        attrString(attrs["message.uuid"]) ?? attrString(attrs["request_id"]) ?? synthId(),
        { model },
      );

    case "tool_decision": {
      const accepted = attrString(attrs["decision"]) !== "reject";
      const spawn = isAgentTool(tool) && accepted;
      return make(spawn ? "subagent_spawn" : "tool_decision", toolUseId ?? synthId(tool), {
        tool,
        detail: toolDetail(tool, params, input),
        ok: accepted,
        // The spawning call is made by the caller, never by the subagent itself.
        ...(spawn ? { agentId: null, spawnId: toolUseId } : {}),
      });
    }

    case "tool_result":
      return make("tool_result", toolUseId ?? synthId(tool), {
        tool,
        detail: toolDetail(tool, params, input),
        ok: attrBool(attrs["success"]) ?? true,
        durationMs: duration,
      });

    case "subagent_completed": {
      const agentType = agentTypeAttr;
      return make("subagent_done", synthId(agentType), {
        // Claude Code gives no subagent key here; the reducer docks by type unless the replay
        // extension attribute names the exact subagent.
        agentId: attrString(attrs["drone.agent_id"]) ?? null,
        agentType,
        detail: sanitizeDetail(agentType),
        durationMs: duration,
        model,
        ok: true,
      });
    }

    case "compaction":
      return make("compaction", synthId(), {
        durationMs: duration,
        ok: attrBool(attrs["success"]) ?? true,
        detail: sanitizeDetail(attrString(attrs["trigger"])),
      });

    case "api_error": {
      const status = attrNumber(attrs["status_code"]);
      return make("error", attrString(attrs["request_id"]) ?? synthId(), {
        model,
        durationMs: duration,
        ok: false,
        detail: status !== undefined ? `HTTP ${status}` : "api error",
      });
    }

    default:
      return { status: "unknown", name };
  }
}

export interface OtlpPayloadResult {
  events: SessionEvent[];
  counters: OtlpCounters;
  /** False when the body is not an OTLP logs payload at all. */
  valid: boolean;
}

/** Cap on distinct unknown event names we track, to bound memory against hostile input. */
const MAX_UNKNOWN_NAMES = 64;

export function addUnknown(counters: OtlpCounters, name: string): void {
  const key =
    name in counters.unknown || Object.keys(counters.unknown).length < MAX_UNKNOWN_NAMES
      ? name
      : "(other)";
  counters.unknown[key] = (counters.unknown[key] ?? 0) + 1;
}

/** Normalize a full OTLP/HTTP-JSON `ExportLogsServiceRequest`. Never throws. */
export function normalizeOtlpPayload(
  payload: unknown,
  opts: OtlpNormalizeOptions,
): OtlpPayloadResult {
  const counters = emptyCounters();
  const events: SessionEvent[] = [];
  if (!isObject(payload) || !Array.isArray(payload.resourceLogs)) {
    return { events, counters, valid: false };
  }
  for (const rl of payload.resourceLogs as unknown[]) {
    if (!isObject(rl)) {
      counters.malformed++;
      continue;
    }
    const resourceAttrs = parseAttributes(
      isObject(rl.resource) ? rl.resource.attributes : undefined,
    );
    const scopeLogs = Array.isArray(rl.scopeLogs) ? (rl.scopeLogs as unknown[]) : [];
    for (const sl of scopeLogs) {
      if (!isObject(sl) || !Array.isArray(sl.logRecords)) {
        counters.malformed++;
        continue;
      }
      for (const rec of sl.logRecords as unknown[]) {
        counters.records++;
        const r = normalizeOtlpRecord(resourceAttrs, rec, opts);
        switch (r.status) {
          case "event":
            counters.accepted++;
            events.push(r.event);
            break;
          case "filtered":
            counters.filtered++;
            break;
          case "unknown":
            addUnknown(counters, r.name);
            break;
          case "malformed":
            counters.malformed++;
            break;
        }
      }
    }
  }
  return { events, counters, valid: true };
}
