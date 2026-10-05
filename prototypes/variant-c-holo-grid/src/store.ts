import { create } from "zustand";
import type { ServerMsg, Session, SessionEvent } from "./types";
import { pushEventRT, rt, seedCounts } from "./runtime";

export type FeedStatus = "connecting" | "live" | "offline" | "demo";

interface CityState {
  sessions: Record<string, Session>;
  selectedId: string | null;
  feedStatus: FeedStatus;
  feedMode: "hub" | "demo";
  select: (id: string | null) => void;
  setStatus: (s: FeedStatus) => void;
}

export const useCity = create<CityState>((set) => ({
  sessions: {},
  selectedId: null,
  feedStatus: "connecting",
  feedMode: "hub",
  select: (id) => set({ selectedId: id }),
  setStatus: (feedStatus) => set({ feedStatus }),
}));

// ---- message handling -------------------------------------------------------
// Events are applied to the local copy lazily (every 250 ms) so the React tree
// is not re-rendered at the event rate; animation reads rt queues directly.
const pending = new Map<string, SessionEvent[]>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  flushTimer = null;
  if (!pending.size) return;
  const st = useCity.getState().sessions;
  const next: Record<string, Session> = { ...st };
  for (const [id, evs] of pending) {
    const s = next[id];
    if (!s) continue;
    const have = new Set(s.recent.map((e) => e.id));
    const fresh = evs.filter((e) => !have.has(e.id));
    if (!fresh.length) continue;
    const last = fresh[fresh.length - 1];
    next[id] = {
      ...s,
      recent: [...s.recent, ...fresh].slice(-50),
      lastEventAt: Math.max(s.lastEventAt, last.ts),
    };
  }
  pending.clear();
  useCity.setState({ sessions: next });
}

export function handleMsg(msg: ServerMsg) {
  const now = performance.now();
  switch (msg.type) {
    case "snapshot": {
      const sessions: Record<string, Session> = {};
      rt.clear();
      for (const s of msg.sessions) {
        sessions[s.id] = s;
        seedCounts(s.id, s.recent);
      }
      pending.clear();
      useCity.setState({ sessions });
      break;
    }
    case "session": {
      const s = msg.session;
      seedCounts(s.id, s.recent);
      useCity.setState((st) => ({ sessions: { ...st.sessions, [s.id]: s } }));
      break;
    }
    case "remove": {
      rt.delete(msg.sessionId);
      useCity.setState((st) => {
        const sessions = { ...st.sessions };
        delete sessions[msg.sessionId];
        return { sessions, selectedId: st.selectedId === msg.sessionId ? null : st.selectedId };
      });
      break;
    }
    case "events": {
      const known = useCity.getState().sessions;
      for (const ev of msg.events) {
        if (!known[ev.sessionId]) continue;
        pushEventRT(ev, now);
        let p = pending.get(ev.sessionId);
        if (!p) pending.set(ev.sessionId, (p = []));
        p.push(ev);
      }
      if (!flushTimer) flushTimer = setTimeout(flush, 250);
      break;
    }
  }
}
