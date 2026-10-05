import {
  CONDUCTOR_MIN_CONCURRENT,
  CONDUCTOR_MIN_SPAWNS,
  END_AFTER_MS,
  FADE_AFTER_MS,
  IDLE_AFTER_MS,
  RECENT_LIMIT,
} from "./types.ts";
import type {
  Session,
  SessionEvent,
  SessionRole,
  SessionState,
  SubagentInfo,
  TokenCounts,
} from "./types.ts";

const zeroTokens = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function newSession(event: SessionEvent): Session {
  const shortId = event.sessionId.slice(0, 8);
  return {
    id: event.sessionId,
    shortId,
    label: event.label ?? shortId,
    machine: event.machine,
    role: "session",
    state: "active",
    model: null,
    tokens: zeroTokens(),
    costUsd: 0,
    startedAt: event.ts,
    lastEventAt: event.ts,
    endedAt: null,
    subagents: {},
    recent: [],
  };
}

// ---------------------------------------------------------------------------
// Conductor classification
// ---------------------------------------------------------------------------

/**
 * A conductor is a session that orchestrates other agents: it has spawned at least
 * CONDUCTOR_MIN_SPAWNS subagents in total, or has at least CONDUCTOR_MIN_CONCURRENT running at
 * the same time. Everything else is a plain session. Pure; the reducer makes it sticky.
 */
export function classifyRole(subagents: Record<string, SubagentInfo>): SessionRole {
  const all = Object.values(subagents);
  const running = all.filter((s) => s.state === "running").length;
  return all.length >= CONDUCTOR_MIN_SPAWNS || running >= CONDUCTOR_MIN_CONCURRENT
    ? "conductor"
    : "session";
}

// ---------------------------------------------------------------------------
// Subagent bookkeeping
// ---------------------------------------------------------------------------

type Subagents = Record<string, SubagentInfo>;

/** Spawn entries not yet bound to the subagent's own key (OTel gives no id at spawn time). */
function isUnbound(s: SubagentInfo): boolean {
  return s.spawnId !== undefined && s.id === s.spawnId;
}

function oldest(list: SubagentInfo[]): SubagentInfo | undefined {
  let best: SubagentInfo | undefined;
  for (const s of list) if (!best || s.startedAt < best.startedAt) best = s;
  return best;
}

function eventAgentType(event: SessionEvent): string | undefined {
  return event.agentType ?? (event.kind === "subagent_spawn" ? event.detail : undefined);
}

/** Find the subagent a "done" event refers to. */
function findForDone(subagents: Subagents, event: SessionEvent): SubagentInfo | undefined {
  if (event.agentId !== null && subagents[event.agentId]) return subagents[event.agentId];
  const all = Object.values(subagents);
  if (event.spawnId !== undefined) {
    const bySpawn = all.find((s) => s.spawnId === event.spawnId);
    if (bySpawn) return bySpawn;
  }
  const running = all.filter((s) => s.state === "running");
  const type = event.agentType ?? event.detail;
  const typed = type ? running.filter((s) => s.type === type) : [];
  return oldest(typed) ?? oldest(running);
}

/** Bind an event from an unknown subagent key to a pending spawn, or create a new entry. */
function adoptSubagent(subagents: Subagents, event: SessionEvent, key: string): void {
  const unbound = Object.values(subagents).filter(isUnbound);
  let match: SubagentInfo | undefined;
  if (event.spawnId !== undefined) match = unbound.find((s) => s.spawnId === event.spawnId);
  if (!match) {
    const type = event.agentType ?? key;
    match = oldest(unbound.filter((s) => s.type === type)) ?? oldest(unbound);
  }
  if (match) {
    delete subagents[match.id];
    subagents[key] = { ...match, id: key, type: match.type ?? event.agentType ?? null };
  } else {
    subagents[key] = {
      id: key,
      type: event.agentType ?? null,
      state: "running",
      startedAt: event.ts,
      ...(event.spawnId !== undefined ? { spawnId: event.spawnId } : {}),
    };
  }
}

/** Events that show a subagent doing work (as opposed to bookkeeping events about it). */
const ACTIVITY_KINDS = new Set(["api_request", "response", "tool_decision", "tool_result"]);

function applySubagents(prev: Subagents, event: SessionEvent): Subagents {
  const next: Subagents = { ...prev };

  if (event.kind === "subagent_spawn") {
    const key = event.spawnId ?? event.id;
    const exists =
      next[key] !== undefined ||
      (event.spawnId !== undefined && Object.values(next).some((s) => s.spawnId === event.spawnId));
    if (!exists) {
      next[key] = {
        id: key,
        type: eventAgentType(event) ?? null,
        state: "running",
        startedAt: event.ts,
        spawnId: key,
      };
    }
    return next;
  }

  if (event.kind === "subagent_done") {
    const target = findForDone(next, event);
    if (target && target.state === "running") {
      next[target.id] = { ...target, state: "docked", endedAt: event.ts };
    }
    return next;
  }

  if (event.agentId !== null) {
    const key = event.agentId;
    if (!next[key]) adoptSubagent(next, event, key);
    const cur = next[key];
    if (cur) {
      let updated = cur;
      if (cur.type === null && event.agentType) updated = { ...updated, type: event.agentType };
      if (
        cur.state === "docked" &&
        ACTIVITY_KINDS.has(event.kind) &&
        event.ts > (cur.endedAt ?? 0)
      ) {
        const { endedAt: _drop, ...rest } = updated;
        updated = { ...rest, state: "running" };
      }
      if (event.ts < updated.startedAt) updated = { ...updated, startedAt: event.ts };
      if (updated !== cur) next[key] = updated;
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function insertRecent(recent: SessionEvent[], event: SessionEvent): SessionEvent[] {
  const out = recent.slice();
  let i = out.length;
  while (i > 0 && (out[i - 1] as SessionEvent).ts > event.ts) i--;
  out.splice(i, 0, event);
  return out.length > RECENT_LIMIT ? out.slice(out.length - RECENT_LIMIT) : out;
}

/**
 * Fold one event into a session (creating it when `prev` is undefined). Pure: returns a new
 * object and never mutates `prev`. State is set to "active" because an event just arrived;
 * run `tick` to settle it against the clock (relevant for backfilled, old events).
 */
export function applyEvent(prev: Session | undefined, event: SessionEvent): Session {
  const base = prev ?? newSession(event);
  const subagents = applySubagents(base.subagents, event);

  let tokens = base.tokens;
  let costUsd = base.costUsd;
  if (event.kind === "api_request") {
    if (event.tokens) {
      tokens = {
        input: tokens.input + event.tokens.input,
        output: tokens.output + event.tokens.output,
        cacheRead: tokens.cacheRead + event.tokens.cacheRead,
        cacheWrite: tokens.cacheWrite + event.tokens.cacheWrite,
      };
    }
    if (event.costUsd !== undefined) costUsd += event.costUsd;
  }

  let model = base.model;
  if (event.model && (event.agentId === null || model === null)) model = event.model;

  let label = base.label;
  if (event.label && event.label !== label) label = event.label;

  const machine =
    base.machine === "unknown" && event.machine !== "unknown" ? event.machine : base.machine;

  const role: SessionRole =
    base.role === "conductor" || classifyRole(subagents) === "conductor" ? "conductor" : "session";

  return {
    ...base,
    label,
    machine,
    role,
    state: "active",
    model,
    tokens,
    costUsd,
    startedAt: Math.min(base.startedAt, event.ts),
    lastEventAt: Math.max(base.lastEventAt, event.ts),
    endedAt: null,
    subagents,
    recent: insertRecent(base.recent, event),
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** active (< IDLE_AFTER_MS since last event) -> idle (< END_AFTER_MS) -> ended. */
export function stateAt(lastEventAt: number, now: number): SessionState {
  const quiet = now - lastEventAt;
  if (quiet < IDLE_AFTER_MS) return "active";
  if (quiet < END_AFTER_MS) return "idle";
  return "ended";
}

/** True once an ended session has faded for FADE_AFTER_MS after its end. */
export function isRemovable(session: Pick<Session, "lastEventAt">, now: number): boolean {
  return now - (session.lastEventAt + END_AFTER_MS) >= FADE_AFTER_MS;
}

export interface TickResult {
  /** Sessions whose state (or docked subagents) changed; new objects. Unchanged ones are omitted. */
  updated: Session[];
  /** Ids to drop (ended for FADE_AFTER_MS). */
  removed: string[];
}

/**
 * Settle every session against `now`: active -> idle -> ended, removal after the fade, and
 * docking of subagents still marked running once their session has ended. Pure.
 */
export function tick(sessions: Iterable<Session>, now: number): TickResult {
  const updated: Session[] = [];
  const removed: string[] = [];
  for (const s of sessions) {
    if (isRemovable(s, now)) {
      removed.push(s.id);
      continue;
    }
    const state = stateAt(s.lastEventAt, now);
    const endedAt = state === "ended" ? s.lastEventAt + END_AFTER_MS : null;
    let subagents = s.subagents;
    if (state === "ended" && Object.values(subagents).some((a) => a.state === "running")) {
      subagents = Object.fromEntries(
        Object.entries(subagents).map(([k, a]) => [
          k,
          a.state === "running"
            ? { ...a, state: "docked" as const, endedAt: endedAt as number }
            : a,
        ]),
      );
    }
    if (state !== s.state || endedAt !== s.endedAt || subagents !== s.subagents) {
      updated.push({ ...s, state, endedAt, subagents });
    }
  }
  return { updated, removed };
}

// ---------------------------------------------------------------------------
// Layout ordering
// ---------------------------------------------------------------------------

const STATE_RANK: Record<SessionState, number> = { active: 0, idle: 1, ended: 2 };

/** state (active, idle, ended), then lastEventAt descending, then id for a stable order. */
export function compareSessions(a: Session, b: Session): number {
  return (
    STATE_RANK[a.state] - STATE_RANK[b.state] ||
    b.lastEventAt - a.lastEventAt ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function orderForLayout(sessions: Iterable<Session>): Session[] {
  return [...sessions].sort(compareSessions);
}
