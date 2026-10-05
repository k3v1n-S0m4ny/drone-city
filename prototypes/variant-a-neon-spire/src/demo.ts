// Synthetic feed. Everything here is invented. It mimics the real shape:
// one conductor + 6-10 subagents, ~12 lane sessions on 2 machines, quiet
// stretches, tool_result storms (20-100 ev/s), sessions going idle and ending.
import { DEMO } from "./config";
import { useStore } from "./store";
import type { EventKind, Machine, Session, SessionEvent } from "./types";

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const ri = (a: number, b: number) => Math.floor(rnd(a, b + 1));
const pick = <T,>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];
const hex = (n: number) => Array.from({ length: n }, () => ((Math.random() * 16) | 0).toString(16)).join("");

type Mode = "quiet" | "work" | "storm";
interface DSub {
  id: string;
  type: string;
  until: number;
  rate: number;
  stormUntil: number;
}
interface DS {
  id: string;
  machine: Machine;
  conductor: boolean;
  mode: Mode;
  modeUntil: number;
  stormRate: number;
  liveUntil: number; // stops emitting after this (-> idle -> ended)
  wakeAt: number; // optional nap/wake
  subs: DSub[];
  spawned: number;
  maxSubs: number;
  nextSpawn: number;
  model: string;
}

const FILES = ["scheduler.ts", "queue.ts", "router.tsx", "auth/session.ts", "db/migrate.sql", "ui/Panel.tsx", "worker.ts", "config.json", "index.css", "parser.rs", "lib/cache.py", "README.md", "tests/api.spec.ts", "store.ts"];
const CMDS = ["npm run build", "npm test", "cargo check", "git status", "pytest -q", "tsc --noEmit", "ls -la", "docker compose up -d", "npm run lint"];
const SUBTYPES = ["explorer", "reviewer", "test-runner", "planner", "refactorer", "doc-writer", "migrator"];
const MCP = ["mcp__docs__search", "mcp__tracker__get_issue", "mcp__browser__snapshot", "mcp__db__query"];
const MODELS = ["claude-opus-4", "claude-sonnet-4"];

const live: DS[] = [];
let seq = 0;
const timers: ReturnType<typeof setInterval | typeof setTimeout>[] = [];
let startedAt = 0;

function makeSession(opts: { conductor?: boolean; ageMs?: number; silentMs?: number; machine?: Machine }): DS {
  const now = Date.now();
  const id = `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
  const machine = opts.machine ?? (Math.random() < 0.55 ? "laptop" : "vps");
  const label = Math.random() < 0.75 ? `t${ri(120, 480)}` : id.slice(0, 8);
  const model = pick(MODELS);
  const silent = opts.silentMs ?? 0;
  const ended = silent > DEMO.endAfterMs;
  const idle = silent > DEMO.idleAfterMs;
  const s: Session = {
    id,
    shortId: id.slice(0, 8),
    label,
    machine,
    role: opts.conductor ? "conductor" : "session",
    state: ended ? "ended" : idle ? "idle" : "active",
    model,
    tokens: { input: ri(20_000, 400_000), output: ri(2_000, 60_000), cacheRead: ri(100_000, 3_000_000), cacheWrite: ri(10_000, 200_000) },
    costUsd: rnd(0.4, 14),
    startedAt: now - (opts.ageMs ?? 0),
    lastEventAt: now - silent,
    endedAt: ended ? now - silent + DEMO.endAfterMs : null,
    subagents: {},
    recent: [],
  };
  useStore.getState().upsert(s);
  const d: DS = {
    id,
    machine,
    conductor: !!opts.conductor,
    mode: "work",
    modeUntil: now + rnd(4000, 12000),
    stormRate: 0,
    liveUntil: silent > 0 ? now - 1 : now + rnd(45_000, 150_000),
    wakeAt: 0,
    subs: [],
    spawned: 0,
    maxSubs: opts.conductor ? 8 : Math.random() < 0.25 ? 2 : 0,
    nextSpawn: now + rnd(500, 1500),
    model,
  };
  if (!opts.conductor && silent === 0 && Math.random() < 0.3) d.wakeAt = 0;
  live.push(d);
  return d;
}

function mk(d: DS, kind: EventKind, extra: Partial<SessionEvent> = {}, agentId: string | null = null): SessionEvent {
  return {
    id: `ev${seq++}`,
    sessionId: d.id,
    agentId,
    kind,
    ts: Date.now(),
    machine: d.machine,
    source: "jsonl",
    ...extra,
  };
}

function toolEvent(d: DS, agentId: string | null, bias: "read" | "mixed"): SessionEvent {
  const r = Math.random();
  const fail = Math.random() < 0.025;
  if (bias === "read" && r < 0.7) {
    const t = pick(["Read", "Grep", "Glob", "Read", "Read"]);
    return mk(d, "tool_result", { tool: t, detail: pick(FILES), ok: !fail, durationMs: ri(8, 120) }, agentId);
  }
  if (r < 0.30) return mk(d, "tool_result", { tool: pick(["Read", "Grep", "Glob"]), detail: pick(FILES), ok: !fail, durationMs: ri(8, 160) }, agentId);
  if (r < 0.50) return mk(d, "tool_result", { tool: pick(["Edit", "Write", "Edit"]), detail: pick(FILES), ok: !fail, durationMs: ri(20, 200) }, agentId);
  if (r < 0.74) return mk(d, "tool_result", { tool: "Bash", detail: pick(CMDS), ok: !fail, durationMs: ri(60, 4000) }, agentId);
  if (r < 0.84) return mk(d, "tool_result", { tool: pick(["WebFetch", "WebSearch"]), detail: "docs lookup", ok: !fail, durationMs: ri(300, 2500) }, agentId);
  if (r < 0.92) return mk(d, "tool_result", { tool: pick(MCP), detail: "query", ok: !fail, durationMs: ri(100, 900) }, agentId);
  return mk(d, "tool_result", { tool: pick(["TodoWrite", "Skill"]), detail: "update", ok: true, durationMs: 5 }, agentId);
}

function turnEvent(d: DS, agentId: string | null, storm: boolean): SessionEvent {
  const r = Math.random();
  if (storm) {
    if (r < 0.02) return mk(d, "error", { tool: "Bash", detail: "exit 1", ok: false }, agentId);
    if (r < 0.04) return mk(d, "api_request", apiExtra(d), agentId);
    return toolEvent(d, agentId, "read");
  }
  if (r < 0.06) return mk(d, "prompt", { detail: "user turn" }, agentId);
  if (r < 0.20) return mk(d, "api_request", apiExtra(d), agentId);
  if (r < 0.27) return mk(d, "response", { model: d.model }, agentId);
  if (r < 0.31) return mk(d, "tool_decision", { tool: "Bash", detail: "accept" }, agentId);
  if (r < 0.315) return mk(d, "compaction", {}, agentId);
  if (r < 0.33) return mk(d, "error", { tool: "api", detail: "overloaded", ok: false }, agentId);
  return toolEvent(d, agentId, "mixed");
}

function apiExtra(d: DS): Partial<SessionEvent> {
  const input = ri(300, 9000);
  const output = ri(80, 1800);
  return {
    model: d.model,
    durationMs: ri(900, 9000),
    tokens: { input, output, cacheRead: ri(0, 60_000), cacheWrite: ri(0, 4000) },
    costUsd: (input * 3 + output * 15) / 1e6,
  };
}

const count = (rate: number, dt: number) => {
  const x = rate * dt;
  return Math.floor(x) + (Math.random() < x - Math.floor(x) ? 1 : 0);
};

function tick(dtMs: number) {
  const now = Date.now();
  const dt = dtMs / 1000;
  const out: SessionEvent[] = [];
  const store = useStore.getState();

  for (const d of live) {
    const s = store.sessions[d.id];
    if (!s) continue;
    // nap / wake: an idle session may spring back to life
    if (d.wakeAt && now > d.wakeAt) {
      d.wakeAt = 0;
      d.liveUntil = now + rnd(15_000, 40_000);
    }
    if (now > d.liveUntil) continue;

    // mode machine
    if (now > d.modeUntil && d.mode !== "storm") {
      d.mode = Math.random() < 0.35 ? "quiet" : "work";
      d.modeUntil = now + (d.mode === "quiet" ? rnd(3000, 8000) : rnd(4000, 12000));
    }
    if (d.mode === "storm" && now > d.modeUntil) {
      d.mode = "work";
      d.modeUntil = now + rnd(3000, 8000);
    }
    const base = d.mode === "quiet" ? 0.7 : d.mode === "work" ? 3.2 : d.stormRate;
    const n = count(base, dt);
    for (let i = 0; i < n; i++) out.push(turnEvent(d, null, d.mode === "storm"));

    // subagents
    if (d.maxSubs > 0) {
      d.subs = d.subs.filter((sub) => {
        if (now > sub.until) {
          out.push(mk(d, "subagent_done", { tool: "Agent", detail: sub.type, ok: true }, sub.id));
          return false;
        }
        const storming = now < sub.stormUntil;
        const k = count(storming ? sub.rate * 3.2 : sub.rate, dt);
        for (let i = 0; i < k; i++) out.push(turnEvent(d, sub.id, storming));
        return true;
      });
      const want = d.conductor ? ri(6, 10) : 1;
      if (now > d.nextSpawn && d.subs.length < Math.min(want, d.maxSubs + (d.conductor ? 2 : 0))) {
        const sub: DSub = { id: `agent-${hex(6)}`, type: pick(SUBTYPES), until: now + rnd(9_000, 34_000), rate: rnd(1.2, 5), stormUntil: 0 };
        d.subs.push(sub);
        d.spawned++;
        out.push(mk(d, "subagent_spawn", { tool: "Agent", detail: sub.type }, sub.id));
        d.nextSpawn = now + rnd(300, d.conductor ? 1400 : 9000);
        if (d.conductor && d.spawned === 3) {
          const cur = useStore.getState().sessions[d.id];
          if (cur) useStore.getState().upsert({ ...cur, role: "conductor" });
        }
      } else if (now > d.nextSpawn) d.nextSpawn = now + 800;
    }
  }
  if (out.length) useStore.getState().applyEvents(out);
}

function lifecycle() {
  const now = Date.now();
  const st = useStore.getState();
  for (const s of Object.values(st.sessions)) {
    const since = now - s.lastEventAt;
    if (s.state === "active" && since > DEMO.idleAfterMs) st.upsert({ ...s, state: "idle" });
    else if (s.state === "idle" && since > DEMO.endAfterMs) st.upsert({ ...s, state: "ended", endedAt: now });
    else if (s.state === "ended" && s.endedAt && now - s.endedAt > DEMO.removeAfterMs) {
      st.remove(s.id);
      const i = live.findIndex((d) => d.id === s.id);
      if (i >= 0) live.splice(i, 1);
    }
  }
  // wake some idle sessions occasionally so districts re-surface
  const idle = live.filter((d) => st.sessions[d.id]?.state === "idle" && !d.wakeAt && !d.conductor);
  if (idle.length && Math.random() < 0.08) pick(idle).wakeAt = now + 100;
}

function scheduleStorm(delay: number) {
  timers.push(
    setTimeout(() => {
      const now = Date.now();
      const st = useStore.getState();
      const candidates = live.filter((d) => st.sessions[d.id]?.state === "active" && now < d.liveUntil);
      const conductor = candidates.find((d) => d.conductor);
      const chosen = new Set<DS>();
      if (conductor) chosen.add(conductor);
      while (chosen.size < Math.min(3, candidates.length)) chosen.add(pick(candidates));
      const dur = rnd(4000, 8500);
      for (const d of chosen) {
        d.mode = "storm";
        d.stormRate = d.conductor ? rnd(12, 24) : rnd(16, 38);
        d.modeUntil = now + dur;
        for (const sub of d.subs) {
          sub.stormUntil = now + dur;
          sub.rate = Math.max(sub.rate, rnd(2.5, 6));
        }
      }
      scheduleStorm(rnd(DEMO.stormEveryMs[0], DEMO.stormEveryMs[1]));
    }, delay),
  );
}

function scheduleArrivals() {
  timers.push(
    setTimeout(() => {
      if (Object.keys(useStore.getState().sessions).length < DEMO.maxSessions) makeSession({});
      scheduleArrivals();
    }, rnd(7000, 14000)),
  );
}

export function startDemo(): () => void {
  startedAt = Date.now();
  useStore.getState().setConn("demo", "synthetic feed");
  makeSession({ conductor: true, ageMs: 20_000, machine: "laptop" });
  for (let i = 0; i < DEMO.lanes; i++) {
    const silent = i < 8 ? 0 : i < 10 ? ri(26_000, 60_000) : i === 10 ? ri(30_000, 70_000) : DEMO.endAfterMs + 5000;
    makeSession({ ageMs: ri(60_000, 900_000), silentMs: silent });
  }
  // one idle lane that will wake up later
  const sleepers = live.filter((d) => !d.conductor && Date.now() > d.liveUntil);
  if (sleepers[0]) sleepers[0].wakeAt = Date.now() + 14_000;
  useStore.getState().setConn("demo", "synthetic feed");

  timers.push(setInterval(() => tick(50), 50));
  timers.push(setInterval(lifecycle, 1000));
  scheduleStorm(DEMO.firstStormInMs);
  scheduleArrivals();
  void startedAt;
  return () => {
    timers.splice(0).forEach((t) => {
      clearInterval(t as never);
      clearTimeout(t as never);
    });
    live.length = 0;
  };
}
