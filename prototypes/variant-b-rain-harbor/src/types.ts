// Mirrors docs/data-model.md (wire contract). Keep in sync by hand in this prototype.
export type Machine = string;
export type EventKind =
  | "prompt"
  | "api_request"
  | "response"
  | "tool_decision"
  | "tool_result"
  | "subagent_spawn"
  | "subagent_done"
  | "compaction"
  | "error";

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  agentId: string | null;
  kind: EventKind;
  ts: number;
  machine: Machine;
  source: "otel" | "jsonl";
  tool?: string;
  detail?: string;
  ok?: boolean;
  durationMs?: number;
  model?: string;
  tokens?: Tokens;
  costUsd?: number;
}

export type SessionRole = "session" | "conductor";
export type SessionState = "active" | "idle" | "ended";

export interface SubagentInfo {
  id: string;
  type: string | null;
  state: "running" | "docked";
  startedAt: number;
  endedAt?: number;
}

export interface Session {
  id: string;
  shortId: string;
  label: string;
  machine: Machine;
  role: SessionRole;
  state: SessionState;
  model: string | null;
  tokens: Tokens;
  costUsd: number;
  startedAt: number;
  lastEventAt: number;
  endedAt: number | null;
  subagents: Record<string, SubagentInfo>;
  recent: SessionEvent[];
}

export type ServerMsg =
  | { v: 1; type: "snapshot"; now: number; sessions: Session[] }
  | { v: 1; type: "events"; events: SessionEvent[] }
  | { v: 1; type: "session"; session: Session }
  | { v: 1; type: "remove"; sessionId: string };
