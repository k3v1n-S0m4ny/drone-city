// Data feed. `?feed=hub` (default) speaks the hub wire contract over a WebSocket;
// `?feed=demo` runs a synthetic generator that emits the very same messages.
import type { ServerMsg, Session, SessionEvent, Tokens } from "./types";
import { handleMsg, useCity } from "./store";
import { getRT } from "./runtime";

const HUB_URL_DEFAULT = "ws://127.0.0.1:8787/ws";

export function startFeed(): () => void {
  const q = new URLSearchParams(location.search);
  const mode = q.get("feed") === "demo" ? "demo" : "hub";
  useCity.setState({ feedMode: mode });
  return mode === "demo" ? startDemo() : startHub(q.get("hub") || HUB_URL_DEFAULT);
}

// ---------------------------------------------------------------- hub -------
function startHub(url: string): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const connect = () => {
    if (stopped) return;
    useCity.getState().setStatus("connecting");
    ws = new WebSocket(url);
    ws.onopen = () => {
      useCity.getState().setStatus("live");
      ws?.send(JSON.stringify({ v: 1, type: "hello" }));
    };
    ws.onmessage = (m) => {
      try {
        const msg = JSON.parse(String(m.data)) as ServerMsg;
        if (msg && msg.v === 1) handleMsg(msg);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (stopped) return;
      useCity.getState().setStatus("offline");
      retry = setTimeout(connect, 1500);
    };
    ws.onerror = () => ws?.close();
  };
  connect();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}

// --------------------------------------------------------------- demo -------
// Lifecycle timers are shortened vs. the hub defaults (60 s / 30 min / 15 min)
// so state changes are visible within a minute of watching.
const DEMO_IDLE_MS = 22_000;
const DEMO_END_MS = 80_000;
const DEMO_REMOVE_MS = 45_000;

const FILES = ["router.ts", "schema.sql", "cache.ts", "auth.go", "index.md", "queue.py", "theme.css", "config.yaml", "parser.rs", "worker.ts", "store.ts", "layout.tsx"];
const BASH = ["run unit tests", "build packages", "lint workspace", "list changed files", "type-check", "start dev server"];
const WEB = ["fetch API reference", "search changelog", "fetch RFC page"];
const MCP = ["mcp__ledger__query", "mcp__tracker__get_item", "mcp__docs__search"];
const SUBTYPES = ["explorer", "reviewer", "planner", "tester", "refactorer"];
const MODELS = ["model-large-4", "model-large-4", "model-mid-4"];

type Mode = "quiet" | "normal" | "burst";
interface Sub { id: string; doneAt: number }
interface DSess {
  s: Session;
  mode: Mode;
  modeUntil: number;
  nextAt: number;
  burstRate: number;
  burstCarry: number;
  turn: number;
  stopAt: number;
  subs: Sub[];
  subCap: number;
  nextSpawnAt: number;
  seq: number;
  dirty: boolean;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");

function startDemo(): () => void {
  useCity.getState().setStatus("demo");
  const sessions = new Map<string, DSess>();
  const outbox: SessionEvent[] = [];
  let ticketNo = 214;
  let stopped = false;
  const t0 = Date.now();

  const mk = (opts: { label?: string; machine: string; role?: "conductor" | "session"; age?: number; idleFor?: number; stopIn?: number; subCap?: number }): DSess => {
    const id = hex(8) + "-" + hex(4) + "-" + hex(4) + "-" + hex(4) + "-" + hex(12);
    const now = Date.now();
    const last = now - (opts.idleFor ?? rnd(0, 4000));
    const ended = opts.idleFor !== undefined && opts.idleFor > DEMO_END_MS;
    const s: Session = {
      id,
      shortId: id.slice(0, 8),
      label: opts.label ?? id.slice(0, 8),
      machine: opts.machine,
      role: opts.role ?? "session",
      state: ended ? "ended" : opts.idleFor !== undefined && opts.idleFor > DEMO_IDLE_MS ? "idle" : "active",
      model: pick(MODELS),
      tokens: { input: Math.floor(rnd(20_000, 400_000)), output: Math.floor(rnd(4_000, 90_000)), cacheRead: Math.floor(rnd(100_000, 2_000_000)), cacheWrite: Math.floor(rnd(10_000, 200_000)) },
      costUsd: rnd(0.4, 14),
      startedAt: now - (opts.age ?? rnd(120_000, 1_800_000)),
      lastEventAt: last,
      endedAt: ended ? last + DEMO_END_MS : null,
      subagents: {},
      recent: [],
    };
    const d: DSess = {
      s, mode: "normal", modeUntil: now + rnd(3000, 9000), nextAt: now + rnd(100, 1500), burstRate: 40, burstCarry: 0, turn: 0,
      stopAt: opts.stopIn !== undefined ? now + opts.stopIn : Infinity,
      subs: [], subCap: opts.subCap ?? 0, nextSpawnAt: now + rnd(1000, 6000), seq: 0, dirty: true,
    };
    sessions.set(id, d);
    return d;
  };

  const emit = (d: DSess, partial: Partial<SessionEvent> & Pick<SessionEvent, "kind">) => {
    const now = Date.now();
    const ev: SessionEvent = {
      id: `${d.s.shortId}-${d.seq++}`, sessionId: d.s.id, agentId: null, ts: now, machine: d.s.machine, source: "otel", ...partial,
    };
    outbox.push(ev);
    d.s.recent.push(ev);
    if (d.s.recent.length > 50) d.s.recent.shift();
    d.s.lastEventAt = now;
    if (d.s.state !== "active") d.s.state = "active";
    d.s.endedAt = null;
    d.dirty = true;
    return ev;
  };

  const toolEvent = (d: DSess, agentId: string | null, burst: boolean) => {
    const r = Math.random();
    let tool: string, detail: string;
    if (burst) {
      if (r < 0.4) { tool = "Read"; detail = pick(FILES); }
      else if (r < 0.65) { tool = "Grep"; detail = "pattern in " + pick(FILES); }
      else if (r < 0.77) { tool = "Glob"; detail = "**/" + pick(FILES); }
      else if (r < 0.88) { tool = "Bash"; detail = pick(BASH); }
      else if (r < 0.94) { tool = "Edit"; detail = pick(FILES); }
      else if (r < 0.97) { tool = "WebFetch"; detail = pick(WEB); }
      else { tool = pick(MCP); detail = "query"; }
    } else {
      if (r < 0.28) { tool = "Read"; detail = pick(FILES); }
      else if (r < 0.40) { tool = "Grep"; detail = "pattern in " + pick(FILES); }
      else if (r < 0.52) { tool = "Edit"; detail = pick(FILES); }
      else if (r < 0.60) { tool = "Write"; detail = pick(FILES); }
      else if (r < 0.74) { tool = "Bash"; detail = pick(BASH); }
      else if (r < 0.82) { tool = "WebSearch"; detail = pick(WEB); }
      else if (r < 0.90) { tool = pick(MCP); detail = "query"; }
      else { tool = "TodoWrite"; detail = "update plan"; }
    }
    const fail = Math.random() < (burst ? 0.03 : 0.07);
    emit(d, { kind: "tool_result", agentId, tool, detail, ok: !fail, durationMs: Math.floor(rnd(20, burst ? 200 : 4000)) });
  };

  const apiEvent = (d: DSess, agentId: string | null) => {
    const tokens: Tokens = { input: Math.floor(rnd(1500, 30_000)), output: Math.floor(rnd(200, 3500)), cacheRead: Math.floor(rnd(30_000, 150_000)), cacheWrite: Math.floor(rnd(0, 8000)) };
    const cost = rnd(0.01, 0.12);
    d.s.tokens = { input: d.s.tokens.input + tokens.input, output: d.s.tokens.output + tokens.output, cacheRead: d.s.tokens.cacheRead + tokens.cacheRead, cacheWrite: d.s.tokens.cacheWrite + tokens.cacheWrite };
    d.s.costUsd += cost;
    emit(d, { kind: "api_request", agentId, model: d.s.model ?? undefined, tokens, costUsd: cost, durationMs: Math.floor(rnd(900, 9000)) });
  };

  const spawnSub = (d: DSess) => {
    const id = "agent-" + hex(7);
    const type = pick(SUBTYPES);
    d.subs.push({ id, doneAt: Date.now() + rnd(22_000, 55_000) });
    d.s.subagents[id] = { id, type, state: "running", startedAt: Date.now() };
    emit(d, { kind: "subagent_spawn", agentId: id, tool: "Agent", detail: type + ": scoped investigation" });
  };
  const dockSub = (d: DSess, sub: Sub) => {
    d.subs = d.subs.filter((x) => x !== sub);
    const info = d.s.subagents[sub.id];
    if (info) { info.state = "docked"; info.endedAt = Date.now(); }
    emit(d, { kind: "subagent_done", agentId: sub.id, tool: "Agent", detail: info?.type ?? "agent", ok: true, durationMs: Date.now() - (info?.startedAt ?? Date.now()) });
  };

  // ---- initial population ------------------------------------------------
  const conductor = mk({ label: "t201", machine: "laptop", role: "conductor", age: 40 * 60_000, subCap: 8 });
  const lanes: DSess[] = [];
  const labelFor = (i: number) => (i === 4 || i === 9 ? undefined : "t" + (202 + i));
  for (let i = 0; i < 12; i++) {
    const idleFor = i === 10 ? 95_000 : i === 11 ? 40_000 : undefined;
    lanes.push(mk({
      label: labelFor(i), machine: i % 3 === 1 || i % 5 === 3 ? "vps" : "laptop",
      idleFor, stopIn: idleFor !== undefined ? 0 : i === 6 ? 14_000 : i === 8 ? 26_000 : undefined, subCap: i === 2 || i === 5 ? 2 : 0,
    }));
  }
  // a burst is imminent from the first second
  lanes[0].mode = "burst"; lanes[0].burstRate = 55; lanes[0].modeUntil = Date.now() + 6000;
  conductor.mode = "burst"; conductor.burstRate = 85; conductor.modeUntil = Date.now() + 9000;

  const snap = (d: DSess): Session => ({
    ...d.s, tokens: { ...d.s.tokens }, subagents: JSON.parse(JSON.stringify(d.s.subagents)), recent: d.s.recent.slice(-50),
  });
  handleMsg({ v: 1, type: "snapshot", now: Date.now(), sessions: [...sessions.values()].map(snap) });
  // give towers some history so the skyline is not flat at t=0
  const seedTowers = (d: DSess) => {
    const c = getRT(d.s.id).counts;
    const scale = d.s.role === "conductor" ? 2.2 : 1;
    for (const k of ["read", "edit", "bash", "web", "agent", "mcp"] as const) c[k] = Math.floor(rnd(2, 60) * scale * (k === "read" ? 1.8 : k === "edit" || k === "bash" ? 1.2 : 0.5));
  };
  sessions.forEach(seedTowers);

  // ---- main loop -----------------------------------------------------------
  let lastUpsert = 0;
  let nextGlobalBurst = Date.now() + 9000;
  const DT = 50;

  const step = () => {
    const now = Date.now();

    // global burst scheduler: keep a storm happening somewhere
    if (now > nextGlobalBurst) {
      const act = [...sessions.values()].filter((d) => d.s.state === "active" && now < d.stopAt);
      if (act.length) {
        const d = Math.random() < 0.45 ? conductor : pick(act);
        d.mode = "burst"; d.burstRate = Math.floor(rnd(20, 100)); d.modeUntil = now + rnd(1800, 4500);
      }
      nextGlobalBurst = now + rnd(2500, 6000);
    }

    for (const d of [...sessions.values()]) {
      const s = d.s;
      // lifecycle
      const quiet = now - s.lastEventAt;
      if (s.state === "active" && quiet > DEMO_IDLE_MS) { s.state = "idle"; d.dirty = true; }
      if (s.state !== "ended" && quiet > DEMO_END_MS) { s.state = "ended"; s.endedAt = now; d.dirty = true; }
      if (s.state === "ended" && s.endedAt && now - s.endedAt > DEMO_REMOVE_MS) {
        sessions.delete(s.id);
        handleMsg({ v: 1, type: "remove", sessionId: s.id });
        // a fresh lane takes its place a little later
        setTimeout(() => {
          if (stopped) return;
          const n = mk({ label: "t" + ticketNo++, machine: Math.random() < 0.35 ? "vps" : "laptop", age: 5000 });
          handleMsg({ v: 1, type: "session", session: snap(n) });
          seedTowers(n);
        }, 9000);
        continue;
      }
      if (now >= d.stopAt) continue; // silent session -> idles out naturally

      // subagents
      if (d.subCap > 0) {
        if (d.subs.length < d.subCap && now >= d.nextSpawnAt) { spawnSub(d); d.nextSpawnAt = now + rnd(900, 2600); }
        for (const sub of [...d.subs]) {
          if (now >= sub.doneAt) { dockSub(d, sub); d.nextSpawnAt = Math.max(d.nextSpawnAt, now + rnd(2500, 6000)); continue; }
          if (Math.random() < (d.mode === "burst" ? 0.5 : 0.045)) {
            if (Math.random() < 0.12) apiEvent(d, sub.id); else toolEvent(d, sub.id, d.mode === "burst");
          }
        }
      }

      // mode switching
      if (now > d.modeUntil) {
        const r = Math.random();
        if (r < 0.32) { d.mode = "quiet"; d.modeUntil = now + rnd(3000, 9000); }
        else if (r < 0.85) { d.mode = "normal"; d.modeUntil = now + rnd(4000, 10000); }
        else { d.mode = "burst"; d.burstRate = Math.floor(rnd(20, 100)); d.modeUntil = now + rnd(1500, 4000); }
      }

      if (d.mode === "burst") {
        d.burstCarry += (d.burstRate * DT) / 1000;
        while (d.burstCarry >= 1) { d.burstCarry -= 1; toolEvent(d, null, true); }
      } else if (now >= d.nextAt) {
        const beat = d.turn++ % 6; // one beat of a user turn
        if (beat === 0) emit(d, { kind: "prompt", detail: "user turn" });
        else if (beat === 1 || beat === 4) apiEvent(d, null);
        else if (beat === 5) {
          if (Math.random() < 0.06) emit(d, { kind: "error", detail: "api overloaded", ok: false });
          else emit(d, { kind: "response", detail: "assistant reply", ok: true });
        } else toolEvent(d, null, false);
        d.nextAt = now + (d.mode === "quiet" ? rnd(1500, 5500) : rnd(240, 900));
      }
    }

    if (outbox.length) handleMsg({ v: 1, type: "events", events: outbox.splice(0) });
    if (now - lastUpsert > 1000) {
      lastUpsert = now;
      for (const d of sessions.values()) if (d.dirty) { d.dirty = false; handleMsg({ v: 1, type: "session", session: snap(d) }); }
    }
  };

  const timer = setInterval(step, DT);

  // debug hook for screenshots / poking from the console
  (window as unknown as Record<string, unknown>).__demo = {
    burst(i = 0, rate = 80, ms = 4000) {
      const d = i === 0 ? conductor : lanes[i - 1];
      d.mode = "burst"; d.burstRate = rate; d.modeUntil = Date.now() + ms;
    },
    elapsed: () => Date.now() - t0,
  };
  return () => { stopped = true; clearInterval(timer); };
}
