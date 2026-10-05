import { create } from "zustand";
import { REORDER_EVERY_MS } from "./config";
import { DOCK_MS, dispatchEvent, dockChild, dropRT, ensureChild, getRT, hooks } from "./runtime";
import type { Session, SessionEvent } from "./types";

export type Conn = "demo" | "connecting" | "open" | "offline";

interface Store {
  /** Session objects are mutated in place by applyEvents (no React churn). */
  sessions: Record<string, Session>;
  order: string[];
  selectedId: string | null;
  /** Bumped (throttled) on structural change: sessions added/removed, state/role
   *  change, subagent launch/dock. React components key off this. */
  struct: number;
  conn: Conn;
  connNote: string;
  setConn: (c: Conn, note?: string) => void;
  select: (id: string | null) => void;
  snapshot: (list: Session[]) => void;
  upsert: (s: Session) => void;
  remove: (id: string) => void;
  applyEvents: (evs: SessionEvent[]) => void;
}

const stateRank = { active: 0, idle: 1, ended: 2 } as const;

// Layout order: state (active, idle, ended), then "entered this state at"
// descending. The contract sorts by lastEventAt, but on a busy feed that value
// changes every few ms and districts would shuffle constantly; the time a
// session entered its current state only changes on a real transition, so the
// grid stays calm and a session that wakes up still surfaces at the top.
const entered = new Map<string, { state: string; at: number }>();
function enteredAt(s: Session): number {
  const e = entered.get(s.id);
  if (!e || e.state !== s.state) {
    const at = e ? Date.now() : s.state === "active" ? s.startedAt : s.lastEventAt;
    entered.set(s.id, { state: s.state, at });
    return at;
  }
  return e.at;
}

function computeOrder(sessions: Record<string, Session>): string[] {
  return Object.values(sessions)
    .sort((a, b) => {
      const s = stateRank[a.state] - stateRank[b.state];
      if (s) return s;
      return enteredAt(b) - enteredAt(a) || (a.id < b.id ? -1 : 1);
    })
    .map((s) => s.id);
}

let structTimer: ReturnType<typeof setTimeout> | null = null;

export const useStore = create<Store>((set, get) => {
  const bumpStruct = () => {
    if (structTimer) return;
    structTimer = setTimeout(() => {
      structTimer = null;
      set((st) => ({ struct: st.struct + 1 }));
    }, 90);
  };
  hooks.struct = bumpStruct;

  const reconcileSubs = (s: Session) => {
    const rt = getRT(s.id);
    const now = performance.now();
    for (const sub of Object.values(s.subagents)) {
      if (sub.state === "running") ensureChild(rt, sub.id, sub.type, now, true);
      else dockChild(rt, sub.id, now);
    }
  };

  return {
    sessions: {},
    order: [],
    selectedId: null,
    struct: 0,
    conn: "connecting",
    connNote: "",
    setConn: (conn, connNote = "") => set({ conn, connNote }),
    select: (selectedId) => set({ selectedId }),

    snapshot: (list) => {
      const sessions: Record<string, Session> = {};
      for (const s of list) sessions[s.id] = s;
      list.forEach(reconcileSubs);
      set({ sessions, order: computeOrder(sessions) });
      bumpStruct();
    },

    upsert: (s) => {
      const prev = get().sessions[s.id];
      const sessions = get().sessions;
      sessions[s.id] = s;
      reconcileSubs(s);
      if (!prev || prev.state !== s.state || prev.role !== s.role) {
        set({ order: computeOrder(sessions) });
        bumpStruct();
      }
    },

    remove: (id) => {
      const sessions = get().sessions;
      delete sessions[id];
      dropRT(id);
      set({ order: computeOrder(sessions), selectedId: get().selectedId === id ? null : get().selectedId });
      bumpStruct();
    },

    applyEvents: (evs) => {
      const sessions = get().sessions;
      let structural = false;
      for (const ev of evs) {
        let s = sessions[ev.sessionId];
        if (!s) {
          s = stubSession(ev);
          sessions[s.id] = s;
          structural = true;
        }
        s.lastEventAt = Math.max(s.lastEventAt, ev.ts);
        if (s.state !== "active") {
          s.state = "active";
          s.endedAt = null;
          structural = true;
        }
        if (ev.model) s.model = ev.model;
        if (ev.tokens) {
          s.tokens.input += ev.tokens.input;
          s.tokens.output += ev.tokens.output;
          s.tokens.cacheRead += ev.tokens.cacheRead;
          s.tokens.cacheWrite += ev.tokens.cacheWrite;
        }
        if (ev.costUsd) s.costUsd += ev.costUsd;
        s.recent.push(ev);
        if (s.recent.length > 50) s.recent.shift();
        if (ev.kind === "subagent_spawn" || ev.agentId) {
          const id = ev.agentId ?? ev.id;
          const sub = s.subagents[id];
          if (ev.kind === "subagent_spawn" && (!sub || sub.state === "docked")) {
            s.subagents[id] = { id, type: ev.detail ?? null, state: "running", startedAt: ev.ts };
          } else if (ev.kind === "subagent_done" && sub) {
            sub.state = "docked";
            sub.endedAt = ev.ts;
          } else if (!sub && ev.agentId) {
            s.subagents[id] = { id, type: null, state: "running", startedAt: ev.ts };
          }
        }
        dispatchEvent(ev);
      }
      if (structural) {
        set({ order: computeOrder(sessions) });
        bumpStruct();
      }
    },
  };
});

function stubSession(ev: SessionEvent): Session {
  return {
    id: ev.sessionId,
    shortId: ev.sessionId.slice(0, 8),
    label: ev.sessionId.slice(0, 8),
    machine: ev.machine,
    role: "session",
    state: "active",
    model: ev.model ?? null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
    startedAt: ev.ts,
    lastEventAt: ev.ts,
    endedAt: null,
    subagents: {},
    recent: [],
  };
}

// Throttled re-sort so districts glide at most every few seconds, not every event.
setInterval(() => {
  const st = useStore.getState();
  const next = computeOrder(st.sessions);
  const same = next.length === st.order.length && next.every((id, i) => id === st.order[i]);
  if (!same) useStore.setState({ order: next });
}, REORDER_EVERY_MS);

export { DOCK_MS };
