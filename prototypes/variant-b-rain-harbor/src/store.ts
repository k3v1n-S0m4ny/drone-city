// Scene state. Session objects are mutated in place (hot path: 100 events/s) and the React side
// re-renders from a throttled `version` bump. Both the hub feed and the demo feed call the same apply* functions.
import { create } from "zustand";
import { CFG } from "./config";
import { sim } from "./sim";
import type { ServerMsg, Session, SessionEvent } from "./types";

export type FeedStatus = "connecting" | "live" | "demo" | "offline";

interface UiState {
  version: number;
  order: string[];
  selected: string | null;
  status: FeedStatus;
  statusText: string;
}

export const useStore = create<UiState>(() => ({
  version: 0,
  order: [],
  selected: null,
  status: "connecting",
  statusText: "",
}));

export const world = {
  sessions: {} as Record<string, Session>,
  events: 0, // total applied
  evWindow: [] as number[], // arrival times for eps
};

const rank = (s: Session) => (s.state === "active" ? 0 : s.state === "idle" ? 1 : 2);

let bumpTimer: number | undefined;
function scheduleBump() {
  if (bumpTimer !== undefined) return;
  bumpTimer = window.setTimeout(() => {
    bumpTimer = undefined;
    useStore.setState((s) => ({ version: s.version + 1 }));
  }, 140);
}

let lastSig = "";
let lastOrderAt = 0;
function recomputeOrder(force = false) {
  const now = performance.now();
  const all = Object.values(world.sessions);
  const sig = all.map((s) => s.id + rank(s)).sort().join("|");
  if (!force && sig === lastSig && now - lastOrderAt < CFG.REORDER_EVERY_MS) return;
  lastSig = sig;
  lastOrderAt = now;
  const prev = useStore.getState().order;
  const prevIdx = new Map(prev.map((id, i) => [id, i] as const));
  const bucket = (s: Session) => Math.floor(s.lastEventAt / CFG.ORDER_BUCKET_MS);
  const sorted = [...all].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    const bd = bucket(b) - bucket(a);
    if (bd) return bd;
    const ia = prevIdx.get(a.id) ?? -1; // brand-new sessions sort first within the bucket
    const ib = prevIdx.get(b.id) ?? -1;
    if (ia !== ib) return ia - ib;
    return a.id < b.id ? -1 : 1;
  });
  const order = sorted.map((s) => s.id);
  const same = order.length === prev.length && order.every((id, i) => id === prev[i]);
  if (!same) useStore.setState({ order });
}

function pruneSubagents() {
  const now = performance.now();
  let changed = false;
  for (const s of Object.values(world.sessions)) {
    for (const sa of Object.values(s.subagents)) {
      if (sa.state !== "docked") continue;
      const rt = sim.rt(s.id, sa.id);
      if (rt.launchAt < 0 || (rt.dockAt > 0 && now - rt.dockAt > 4000)) {
        delete s.subagents[sa.id];
        sim.dropOne(s.id, sa.id);
        changed = true;
      }
    }
  }
  if (changed) scheduleBump();
}

setInterval(() => {
  pruneSubagents();
  recomputeOrder(false);
}, 1000);

function reconcileSubagents(s: Session, now: number) {
  for (const sa of Object.values(s.subagents)) {
    if (sa.state === "running") sim.launch(s.id, sa.id, now);
    else sim.dock(s.id, sa.id, now);
  }
}

export function applySnapshot(msg: Extract<ServerMsg, { type: "snapshot" }>) {
  const now = performance.now();
  for (const id of Object.keys(world.sessions)) sim.drop(id);
  world.sessions = {};
  for (const s of msg.sessions) {
    world.sessions[s.id] = s;
    reconcileSubagents(s, now - 5000); // already in the air: skip the launch moment
  }
  recomputeOrder(true);
  scheduleBump();
}

export function applySession(s: Session) {
  const now = performance.now();
  const old = world.sessions[s.id];
  if (old && s.recent.length < old.recent.length) s.recent = old.recent; // keep our richer local ring
  world.sessions[s.id] = s;
  reconcileSubagents(s, now);
  recomputeOrder(false);
  scheduleBump();
}

export function applyRemove(id: string) {
  delete world.sessions[id];
  sim.drop(id);
  if (useStore.getState().selected === id) useStore.setState({ selected: null });
  recomputeOrder(true);
  scheduleBump();
}

let synth = 0;
export function applyEvents(events: SessionEvent[]) {
  const now = performance.now();
  let membership = false;
  for (const ev of events) {
    let s = world.sessions[ev.sessionId];
    if (!s) {
      membership = true;
      s = world.sessions[ev.sessionId] = {
        id: ev.sessionId,
        shortId: ev.sessionId.slice(0, 8),
        label: ev.sessionId.slice(0, 8),
        machine: ev.machine,
        role: "session",
        state: "active",
        model: null,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0,
        startedAt: ev.ts,
        lastEventAt: ev.ts,
        endedAt: null,
        subagents: {},
        recent: [],
      };
    }
    s.lastEventAt = Math.max(s.lastEventAt, ev.ts);
    if (s.state !== "active") s.state = "active";
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

    // subagent bookkeeping (client-side mirror of what the hub's `session` msg will confirm)
    if (ev.agentId && !s.subagents[ev.agentId]) {
      // adopt a placeholder created by an agentId-less spawn, else create
      const ph = Object.values(s.subagents).find((x) => x.id.startsWith("pending-") && x.state === "running");
      if (ph) {
        delete s.subagents[ph.id];
        sim.rt(s.id, ev.agentId).launchAt = sim.rt(s.id, ph.id).launchAt;
        sim.dropOne(s.id, ph.id);
      }
      s.subagents[ev.agentId] = { id: ev.agentId, type: null, state: "running", startedAt: performance.now() };
      sim.launch(s.id, ev.agentId, now);
    }
    if (ev.kind === "subagent_spawn" && !ev.agentId) {
      const id = `pending-${++synth}`;
      s.subagents[id] = { id, type: ev.detail ?? null, state: "running", startedAt: performance.now() };
      sim.launch(s.id, id, now);
    }
    if (ev.kind === "subagent_done") {
      const id = ev.agentId ?? Object.values(s.subagents).find((x) => x.state === "running")?.id;
      const sa = id ? s.subagents[id] : undefined;
      if (sa && sa.state === "running") {
        sa.state = "docked";
        sa.endedAt = performance.now();
        sim.dock(s.id, sa.id, now);
      }
    }

    sim.onEvent(ev, now);
    world.events++;
    world.evWindow.push(now);
  }
  if (membership) recomputeOrder(true);
  scheduleBump();
}

export function applyMsg(msg: ServerMsg) {
  switch (msg.type) {
    case "snapshot": return applySnapshot(msg);
    case "events": return applyEvents(msg.events);
    case "session": return applySession(msg.session);
    case "remove": return applyRemove(msg.sessionId);
  }
}

export function eventsPerSecond(): number {
  const now = performance.now();
  const w = world.evWindow;
  while (w.length && now - w[0] > 1000) w.shift();
  return w.length;
}

export function setStatus(status: FeedStatus, statusText = "") {
  useStore.setState({ status, statusText });
}
export function select(id: string | null) {
  useStore.setState({ selected: id });
}
