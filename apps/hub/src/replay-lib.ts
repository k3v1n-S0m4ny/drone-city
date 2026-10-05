import { detailKeyForTool, MAIN_THREAD_SOURCE } from "@drone-city/model";
import type { SessionEvent } from "@drone-city/model";

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

export type Speed = number | "burst";

/** In burst mode, gaps longer than this are compressed to this; shorter gaps stay real-time. */
export const BURST_MAX_GAP_MS = 2000;

export function parseSpeed(raw: string): Speed {
  if (raw === "burst") return "burst";
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`invalid --speed "${raw}" (use 1, 10, 0.5, ... or burst)`);
  return n;
}

/**
 * Offsets (ms from the start of the replay) at which each event should be sent.
 * `timestamps` must be ascending. Numeric speed divides every gap; `burst` keeps gaps up to
 * BURST_MAX_GAP_MS real-time and compresses longer ones to BURST_MAX_GAP_MS.
 */
export function scheduleOffsets(timestamps: readonly number[], speed: Speed): number[] {
  const out: number[] = [];
  let at = 0;
  for (let i = 0; i < timestamps.length; i++) {
    if (i > 0) {
      const gap = Math.max(0, (timestamps[i] as number) - (timestamps[i - 1] as number));
      at += speed === "burst" ? Math.min(gap, BURST_MAX_GAP_MS) : gap / speed;
    }
    out.push(at);
  }
  return out;
}

export interface ReplayItem {
  at: number;
  event: SessionEvent;
}

/** Each session starts at offset 0 (simulating a batch that launched together); merged by time. */
export function buildItems(sessions: readonly SessionEvent[][], speed: Speed): ReplayItem[] {
  const items: ReplayItem[] = [];
  for (const events of sessions) {
    const sorted = [...events].sort((a, b) => a.ts - b.ts);
    const offsets = scheduleOffsets(
      sorted.map((e) => e.ts),
      speed,
    );
    sorted.forEach((event, i) => items.push({ at: offsets[i] as number, event }));
  }
  return items.sort((a, b) => a.at - b.at);
}

/** Make ids unique for loop iteration n >= 1 so the hub does not de-duplicate them away. */
export function withIteration(e: SessionEvent, n: number): SessionEvent {
  if (n === 0) return e;
  const suffix = `~${n}`;
  return {
    ...e,
    id: `${e.id}${suffix}`,
    sessionId: `${e.sessionId}${suffix}`,
    ...(e.spawnId !== undefined ? { spawnId: `${e.spawnId}${suffix}` } : {}),
  };
}

// ---------------------------------------------------------------------------
// SessionEvent -> OTLP/HTTP JSON log record
// ---------------------------------------------------------------------------

type OtlpValue =
  { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };

export interface OtlpKeyValue {
  key: string;
  value: OtlpValue;
}

export interface OtlpLogRecord {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  severityText: string;
  body: { stringValue: string };
  attributes: OtlpKeyValue[];
}

type AttrIn = string | number | boolean | undefined;

function toKeyValues(attrs: Record<string, AttrIn>): OtlpKeyValue[] {
  const out: OtlpKeyValue[] = [];
  for (const [key, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (typeof v === "string") out.push({ key, value: { stringValue: v } });
    else if (typeof v === "boolean") out.push({ key, value: { boolValue: v } });
    else if (Number.isInteger(v)) out.push({ key, value: { intValue: String(v) } });
    else out.push({ key, value: { doubleValue: v } });
  }
  return out;
}

export interface RecordOptions {
  repo: string;
  /** Wall-clock time to stamp on the record (ms). */
  wallTs: number;
  sequence: number;
  /**
   * Only api_request/assistant_response carry the subagent key, as in real Claude Code output.
   * Default false: every event carries it so prototypes can attribute tool activity to subagents.
   */
  faithfulAttribution?: boolean;
}

const EVENT_NAMES: Record<SessionEvent["kind"], string> = {
  prompt: "user_prompt",
  api_request: "api_request",
  response: "assistant_response",
  tool_decision: "tool_decision",
  subagent_spawn: "tool_decision",
  tool_result: "tool_result",
  subagent_done: "subagent_completed",
  compaction: "compaction",
  error: "api_error",
};

/** Convert a normalized event back into the log record Claude Code would have exported. */
export function eventToRecord(e: SessionEvent, o: RecordOptions): OtlpLogRecord {
  const name = EVENT_NAMES[e.kind];
  const attrs: Record<string, AttrIn> = {
    "event.name": name,
    "event.timestamp": new Date(o.wallTs).toISOString(),
    "event.sequence": o.sequence,
    "session.id": e.sessionId,
    "machine.name": e.machine,
    "vcs.repository.name": o.repo,
  };
  if (e.label) attrs["drone.label"] = e.label;

  const attribution = o.faithfulAttribution
    ? e.kind === "api_request" || e.kind === "response"
    : e.kind !== "subagent_spawn" && e.kind !== "subagent_done" && e.kind !== "prompt";
  if (attribution) {
    attrs["query_source"] = e.agentId === null ? MAIN_THREAD_SOURCE : "subagent";
    if (e.agentId !== null) {
      attrs["agent.name"] = e.agentId;
      if (e.agentType) attrs["agent_type"] = e.agentType;
    }
  }

  const toolParams = (): void => {
    const tool = e.tool ?? (e.kind === "subagent_spawn" ? "Agent" : undefined);
    if (!tool) return;
    attrs["tool_name"] = tool;
    attrs["tool_use_id"] = e.id;
    if (e.detail !== undefined) {
      const { bag, key } = detailKeyForTool(tool);
      attrs[bag === "params" ? "tool_parameters" : "tool_input"] = JSON.stringify({
        [key]: e.detail,
      });
    }
  };

  switch (e.kind) {
    case "api_request":
      attrs["request_id"] = e.id;
      attrs["model"] = e.model;
      attrs["input_tokens"] = e.tokens?.input;
      attrs["output_tokens"] = e.tokens?.output;
      attrs["cache_read_tokens"] = e.tokens?.cacheRead;
      attrs["cache_creation_tokens"] = e.tokens?.cacheWrite;
      attrs["cost_usd"] = e.costUsd;
      attrs["duration_ms"] = e.durationMs;
      break;
    case "response":
      attrs["message.uuid"] = e.id;
      attrs["model"] = e.model;
      break;
    case "tool_decision":
    case "subagent_spawn":
      toolParams();
      attrs["decision"] = e.ok === false ? "reject" : "accept";
      break;
    case "tool_result":
      toolParams();
      attrs["success"] = e.ok === false ? "false" : "true";
      attrs["duration_ms"] = e.durationMs;
      break;
    case "subagent_done":
      attrs["agent_type"] = e.agentType ?? e.detail;
      if (e.agentId !== null) attrs["drone.agent_id"] = e.agentId;
      attrs["duration_ms"] = e.durationMs;
      break;
    case "compaction":
      attrs["trigger"] = e.detail ?? "auto";
      attrs["success"] = e.ok === false ? "false" : "true";
      break;
    case "error":
      attrs["model"] = e.model;
      break;
    case "prompt":
      attrs["message.uuid"] = e.id;
      break;
  }

  const nano = String(BigInt(Math.round(o.wallTs)) * 1_000_000n);
  return {
    timeUnixNano: nano,
    observedTimeUnixNano: nano,
    severityText: "INFO",
    body: { stringValue: `claude_code.${name}` },
    attributes: toKeyValues(attrs),
  };
}

export function buildPayload(
  records: readonly OtlpLogRecord[],
  resource: { repo: string; machine: string },
): unknown {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: toKeyValues({
            "service.name": "claude-code",
            "machine.name": resource.machine,
            "vcs.repository.name": resource.repo,
          }),
        },
        scopeLogs: [{ scope: { name: "com.anthropic.claude_code.events" }, logRecords: records }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunOptions {
  items: readonly ReplayItem[];
  repo: string;
  machine: string;
  /** Send one OTLP payload. Resolve true on success. */
  post: (payload: unknown) => Promise<boolean>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Items due within this window are sent together. */
  batchMs?: number;
  iteration?: number;
  faithfulAttribution?: boolean;
  /** Cap on records per POST. */
  maxBatch?: number;
  shouldStop?: () => boolean;
  /** Shared sequence counter across iterations. */
  nextSequence?: () => number;
}

export interface RunResult {
  sent: number;
  batches: number;
  failedBatches: number;
}

/**
 * Send the scheduled items, honoring their offsets against the injected clock. Record
 * timestamps are `start + offset`, so the hub sees the replay as live activity.
 */
export async function runReplay(opts: RunOptions): Promise<RunResult> {
  const batchMs = opts.batchMs ?? 50;
  const maxBatch = opts.maxBatch ?? 200;
  const iteration = opts.iteration ?? 0;
  let seq = 0;
  const nextSeq = opts.nextSequence ?? (() => seq++);
  const start = opts.now();
  const result: RunResult = { sent: 0, batches: 0, failedBatches: 0 };
  let i = 0;
  while (i < opts.items.length) {
    if (opts.shouldStop?.()) break;
    const first = opts.items[i] as ReplayItem;
    const wait = start + first.at - opts.now();
    if (wait > 0) await opts.sleep(wait);
    const horizon = opts.now() - start + batchMs;
    const records: OtlpLogRecord[] = [];
    while (i < opts.items.length && records.length < maxBatch) {
      const item = opts.items[i] as ReplayItem;
      if (item.at > horizon) break;
      records.push(
        eventToRecord(withIteration(item.event, iteration), {
          repo: opts.repo,
          wallTs: start + item.at,
          sequence: nextSeq(),
          faithfulAttribution: opts.faithfulAttribution,
        }),
      );
      i++;
    }
    const ok = await opts.post(buildPayload(records, { repo: opts.repo, machine: opts.machine }));
    result.batches++;
    result.sent += records.length;
    if (!ok) result.failedBatches++;
  }
  return result;
}
