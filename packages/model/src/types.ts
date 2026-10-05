/**
 * Normalized model. The binding contract is docs/data-model.md; keep both in sync.
 */

export type Machine = string; // "laptop" | "vps" | "unknown" | ...

export type EventKind =
  | "prompt" // user_prompt
  | "api_request" // api_request (model call finished)
  | "response" // assistant_response
  | "tool_decision" // tool_decision (OTel) / tool_use (JSONL)
  | "tool_result" // tool_result
  | "subagent_spawn" // Agent/Task call
  | "subagent_done" // subagent_completed (OTel) or finished Agent/Task result (JSONL)
  | "compaction"
  | "error"; // api_error

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionEvent {
  /** Stable id: tool_use_id / request_id / message uuid / synthesized. Unique per (kind, id). */
  id: string;
  sessionId: string;
  /** null = main drone; else subagent key (query_source/agent.name or JSONL agentId). */
  agentId: string | null;
  kind: EventKind;
  /** Epoch ms. */
  ts: number;
  machine: Machine;
  source: "otel" | "jsonl";
  /** Tool name ("Bash", "Edit", "mcp__x__y", "Agent"...). */
  tool?: string;
  /** Short, single line, <= 120 chars. Never prompt text. */
  detail?: string;
  ok?: boolean;
  durationMs?: number;
  model?: string;
  tokens?: TokenCounts;
  costUsd?: number;
  /** Ticket label hint (e.g. "t245"), derived from the working dir when known. */
  label?: string;
  /** tool_use_id of the Agent/Task call that launched this event's subagent, when known. */
  spawnId?: string;
  /** Subagent type, when known (JSONL meta, OTel subagent_completed). */
  agentType?: string;
}

export type SessionRole = "session" | "conductor";
export type SessionState = "active" | "idle" | "ended";

export interface SubagentInfo {
  id: string;
  type: string | null;
  state: "running" | "docked";
  startedAt: number;
  endedAt?: number;
  /** Set while a spawn is not yet bound to the subagent's own key (OTel gives no id at spawn). */
  spawnId?: string;
}

export interface Session {
  id: string;
  shortId: string;
  label: string;
  machine: Machine;
  role: SessionRole;
  state: SessionState;
  model: string | null;
  tokens: TokenCounts;
  costUsd: number;
  startedAt: number;
  lastEventAt: number;
  endedAt: number | null;
  subagents: Record<string, SubagentInfo>;
  /** Ring buffer, last RECENT_LIMIT events, for the inspect panel. */
  recent: SessionEvent[];
}

export type ServerMsg =
  | { v: 1; type: "snapshot"; now: number; sessions: Session[] }
  | { v: 1; type: "events"; events: SessionEvent[] }
  | { v: 1; type: "session"; session: Session }
  | { v: 1; type: "remove"; sessionId: string };

export type ClientMsg = { v: 1; type: "hello" };

/** No events for this long -> idle. */
export const IDLE_AFTER_MS = 60_000;
/** No events for this long -> ended (OTel has no explicit end event). */
export const END_AFTER_MS = 30 * 60_000;
/** Ended sessions are removed this long after endedAt. */
export const FADE_AFTER_MS = 15 * 60_000;
/** Ring buffer size of Session.recent. */
export const RECENT_LIMIT = 50;
/** Max length of SessionEvent.detail. */
export const DETAIL_MAX = 120;
/** Conductor: spawned at least this many subagents in total... */
export const CONDUCTOR_MIN_SPAWNS = 3;
/** ...or has at least this many running at once. */
export const CONDUCTOR_MIN_CONCURRENT = 2;
/** Default ticket label regex source; group 1 is the label. */
export const DEFAULT_TICKET_LABEL_RE = "-worktrees-(t\\d+)$";
