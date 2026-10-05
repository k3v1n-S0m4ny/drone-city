import { applyEvent, tick } from "@drone-city/model";
import type { ServerMsg, Session, SessionEvent } from "@drone-city/model";

/** Distinct (kind, id) pairs remembered per session for de-duplication. */
const SEEN_LIMIT = 5000;

export interface Clock {
  now(): number;
}

export interface Changes {
  /** Events that were new and belong to a surviving session. */
  events: SessionEvent[];
  /** Sessions to upsert (new state after the batch). */
  upserts: Session[];
  /** Sessions to drop. */
  removes: string[];
  /** Events dropped as duplicates. */
  duplicates: number;
}

export const noChanges = (): Changes => ({ events: [], upserts: [], removes: [], duplicates: 0 });

/** Live session state: event de-duplication, the reducer, and the lifecycle tick. */
export class SessionStore {
  readonly sessions = new Map<string, Session>();
  private readonly seen = new Map<string, Set<string>>();

  get size(): number {
    return this.sessions.size;
  }

  ingest(events: SessionEvent[], now: number): Changes {
    const accepted: SessionEvent[] = [];
    const touched = new Set<string>();
    const knownBefore = new Set(this.sessions.keys());
    let duplicates = 0;

    for (const e of events) {
      let seen = this.seen.get(e.sessionId);
      if (!seen) {
        seen = new Set();
        this.seen.set(e.sessionId, seen);
      }
      const key = `${e.kind}|${e.id}`;
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      if (seen.size > SEEN_LIMIT) {
        const oldest = seen.values().next();
        if (!oldest.done) seen.delete(oldest.value);
      }
      this.sessions.set(e.sessionId, applyEvent(this.sessions.get(e.sessionId), e));
      touched.add(e.sessionId);
      accepted.push(e);
    }

    // Settle against the clock: backfilled history may already be idle, ended or expired.
    const removes: string[] = [];
    const upserts: Session[] = [];
    const dropped = new Set<string>();
    for (const id of touched) {
      const s = this.sessions.get(id);
      if (!s) continue;
      const t = tick([s], now);
      if (t.removed.length > 0) {
        this.drop(id);
        // A session that never became visible needs no remove frame.
        if (knownBefore.has(id)) removes.push(id);
        dropped.add(id);
        continue;
      }
      const settled = t.updated[0] ?? s;
      this.sessions.set(id, settled);
      upserts.push(settled);
    }
    return {
      events: accepted.filter((e) => !dropped.has(e.sessionId)),
      upserts,
      removes,
      duplicates,
    };
  }

  /** Lifecycle pass: returns upserts for sessions whose state changed and removes for expired ones. */
  tick(now: number): Changes {
    const t = tick(this.sessions.values(), now);
    for (const s of t.updated) this.sessions.set(s.id, s);
    for (const id of t.removed) this.drop(id);
    return { events: [], upserts: t.updated, removes: t.removed, duplicates: 0 };
  }

  snapshot(now: number): ServerMsg {
    return { v: 1, type: "snapshot", now, sessions: [...this.sessions.values()] };
  }

  private drop(id: string): void {
    this.sessions.delete(id);
    this.seen.delete(id);
  }
}
