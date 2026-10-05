import type { ClientMsg, ServerMsg, Session, SessionEvent } from "./types.ts";
import { applyEvent } from "./session.ts";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse and shape-check a hub -> browser frame. Returns undefined for anything unrecognised. */
export function parseServerMsg(raw: string): ServerMsg | undefined {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isObject(m) || m.v !== 1) return undefined;
  switch (m.type) {
    case "snapshot":
      return typeof m.now === "number" && Array.isArray(m.sessions)
        ? (m as unknown as ServerMsg)
        : undefined;
    case "events":
      return Array.isArray(m.events) ? (m as unknown as ServerMsg) : undefined;
    case "session":
      return isObject(m.session) && typeof m.session.id === "string"
        ? (m as unknown as ServerMsg)
        : undefined;
    case "remove":
      return typeof m.sessionId === "string" ? (m as unknown as ServerMsg) : undefined;
    default:
      return undefined;
  }
}

export function parseClientMsg(raw: string): ClientMsg | undefined {
  try {
    const m: unknown = JSON.parse(raw);
    return isObject(m) && m.v === 1 && m.type === "hello" ? { v: 1, type: "hello" } : undefined;
  } catch {
    return undefined;
  }
}

export type SessionMap = Record<string, Session>;

/**
 * Client-side reducer for hub frames. `snapshot` replaces everything, `session` is
 * authoritative, `events` are applied for animation between upserts (a session the client
 * has never seen is created from its events), `remove` drops one.
 */
export function applyServerMsg(state: SessionMap, msg: ServerMsg): SessionMap {
  switch (msg.type) {
    case "snapshot":
      return Object.fromEntries(msg.sessions.map((s) => [s.id, s]));
    case "session":
      return { ...state, [msg.session.id]: msg.session };
    case "remove": {
      const { [msg.sessionId]: _gone, ...rest } = state;
      return rest;
    }
    case "events": {
      const next = { ...state };
      for (const e of msg.events as SessionEvent[])
        next[e.sessionId] = applyEvent(next[e.sessionId], e);
      return next;
    }
  }
}
