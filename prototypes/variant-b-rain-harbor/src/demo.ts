// Synthetic feed that mimics the wire contract: 1 conductor spawning 6-10 subagents, ~13 lane sessions on two
// machines, quiet stretches, 20-100 events/s tool storms, sessions going idle and ending. All data is invented.
import { CFG } from "./config";
import type { ServerMsg, Session, SessionEvent } from "./types";

type Emit = (m: ServerMsg) => void;
type Mode = "quiet" | "turn" | "storm" | "sleep";

interface Agent {
  id: string | null;
  mode: Mode;
  until: number;
  rate: number; // events / s while turn/storm
  endsAt?: number; // subagents only
}
interface Lane {
  s: Session;
  main: Agent;
  subs: Agent[];
  conductor: boolean;
  nextWave: number;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];
const wpick = <T,>(xs: readonly (readonly [T, number])[]): T => {
  const sum = xs.reduce((a, x) => a + x[1], 0);
  let r = Math.random() * sum;
  for (const [v, w] of xs) if ((r -= w) <= 0) return v;
  return xs[0][0];
};
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");

const TOOLS = [
  ["Read", 26], ["Grep", 11], ["Glob", 5], ["Edit", 18], ["Write", 4], ["Bash", 22],
  ["WebFetch", 3], ["WebSearch", 2], ["mcp__docs__lookup", 3], ["mcp__tracker__issue", 2],
  ["Skill", 1], ["TodoWrite", 4],
] as const;
const FILES = ["router.ts", "schema.sql", "layout.tsx", "queue.go", "worker.py", "config.yaml", "README.md", "auth.rs", "index.css", "store.ts", "parser.ts"];
const CMDS = ["npm test", "git status", "cargo build", "ls src", "pnpm lint", "go vet ./...", "make check", "docker ps"];
const MODELS = ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4"];
const SUBTYPES = ["explorer", "reviewer", "refactor", "tester", "doc-scan", "migrator"];

export class DemoFeed {
  private lanes: Lane[] = [];
  private timer: number | undefined;
  private last = 0;
  private seq = 0;
  private tickets = new Set<number>();
  private stormUntil = 0;
  constructor(private emit: Emit) {}

  start() {
    const now = Date.now();
    this.tickets.add(200); // reserved for the conductor label
    this.lanes.push(this.mkLane(now, { conductor: true, machine: "laptop", label: "t200", state: "active" }));
    const plan: Array<"active" | "idle" | "ended"> = [
      ...Array(CFG.DEMO_LANE_SESSIONS - 4).fill("active"), "idle", "idle", "idle", "ended",
    ];
    for (const st of plan) this.lanes.push(this.mkLane(now, { state: st }));
    this.emit({ v: 1, type: "snapshot", now, sessions: this.lanes.map((l) => this.copy(l.s)) });
    this.last = performance.now();
    this.timer = window.setInterval(() => this.tick(), 50);
    (window as any).__demo = { storm: (ms = 7000) => this.storm(ms), lanes: this.lanes };
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  storm(ms = 7000) {
    this.stormUntil = performance.now() + ms;
  }

  // ---------------------------------------------------------------------------
  private copy(s: Session): Session {
    return JSON.parse(JSON.stringify({ ...s, recent: [] }));
  }
  private mkLane(
    now: number,
    o: { conductor?: boolean; machine?: string; label?: string; state: "active" | "idle" | "ended" },
  ): Lane {
    const id = hex(8) + "-" + hex(4) + "-" + hex(4) + "-" + hex(12);
    let label = o.label;
    if (!label) {
      if (Math.random() < 0.2) label = id.slice(0, 8);
      else {
        let n = 0;
        do n = 120 + Math.floor(Math.random() * 160); while (this.tickets.has(n));
        this.tickets.add(n);
        label = "t" + n;
      }
    }
    const age = o.state === "active" ? 0 : o.state === "idle" ? CFG.DEMO_IDLE_AFTER_MS * 1.8 : CFG.DEMO_END_AFTER_MS * 1.25;
    const s: Session = {
      id, shortId: id.slice(0, 8), label,
      machine: o.machine ?? (Math.random() < 0.5 ? "laptop" : "vps"),
      role: o.conductor ? "conductor" : "session",
      state: o.state,
      model: pick(MODELS),
      tokens: { input: Math.floor(rnd(5e3, 9e4)), output: Math.floor(rnd(1e3, 2e4)), cacheRead: Math.floor(rnd(2e4, 6e5)), cacheWrite: Math.floor(rnd(5e3, 6e4)) },
      costUsd: rnd(0.2, 9),
      startedAt: now - rnd(60_000, 900_000),
      lastEventAt: now - age,
      endedAt: o.state === "ended" ? now - 5000 : null,
      subagents: {},
      recent: [],
    };
    const mode: Mode = o.state === "active" ? "quiet" : "sleep";
    return {
      s,
      conductor: !!o.conductor,
      main: { id: null, mode, until: performance.now() + (mode === "sleep" ? rnd(12000, 50000) : rnd(100, 2500)), rate: 3 },
      subs: [],
      nextWave: performance.now() + (o.conductor ? 2500 : rnd(8000, 30000)),
    };
  }

  private ev(l: Lane, agent: string | null, kind: SessionEvent["kind"], extra: Partial<SessionEvent> = {}): SessionEvent {
    const e: SessionEvent = {
      id: "e" + ++this.seq, sessionId: l.s.id, agentId: agent, kind, ts: Date.now(),
      machine: l.s.machine, source: "jsonl", ...extra,
    };
    return e;
  }

  private toolEvent(l: Lane, agent: string | null): SessionEvent {
    const tool = wpick(TOOLS);
    const fail = Math.random() < 0.035;
    const detail = tool === "Bash" ? pick(CMDS) : tool.startsWith("mcp__") ? "lookup" : pick(FILES);
    if (fail) return this.ev(l, agent, "error", { tool, detail, ok: false });
    return this.ev(l, agent, "tool_result", { tool, detail, ok: true, durationMs: Math.floor(rnd(20, 900)) });
  }

  private apiEvent(l: Lane, agent: string | null): SessionEvent {
    const tokens = {
      input: Math.floor(rnd(300, 9000)), output: Math.floor(rnd(80, 2400)),
      cacheRead: Math.floor(rnd(8000, 90000)), cacheWrite: Math.floor(rnd(0, 4000)),
    };
    return this.ev(l, agent, "api_request", { model: l.s.model ?? undefined, tokens, costUsd: rnd(0.005, 0.12), durationMs: Math.floor(rnd(800, 9000)) });
  }

  // ---------------------------------------------------------------------------
  private tick() {
    const nowP = performance.now();
    const dt = Math.min(0.2, (nowP - this.last) / 1000);
    this.last = nowP;
    const now = Date.now();
    const out: SessionEvent[] = [];
    const dirty = new Set<Lane>();
    const stormOn = nowP < this.stormUntil;

    for (const l of this.lanes) {
      if (l.s.state === "ended") continue;
      this.stepAgent(l, l.main, nowP, dt, out, stormOn);

      // subagents
      for (const sa of [...l.subs]) {
        this.stepAgent(l, sa, nowP, dt, out, stormOn);
        if (sa.endsAt && nowP > sa.endsAt) {
          out.push(this.ev(l, sa.id, "subagent_done", { tool: "Agent", ok: true, detail: l.s.subagents[sa.id!]?.type ?? "" }));
          const info = l.s.subagents[sa.id!];
          if (info) { info.state = "docked"; info.endedAt = now; }
          l.subs.splice(l.subs.indexOf(sa), 1);
          dirty.add(l);
        }
      }

      for (const [sid, info] of Object.entries(l.s.subagents)) {
        if (info.state === "docked" && info.endedAt && now - info.endedAt > 8000) { delete l.s.subagents[sid]; }
      }
      // spawn waves
      if (nowP > l.nextWave && l.s.state === "active") {
        const n = l.conductor ? Math.floor(rnd(6, 11)) : Math.random() < 0.5 ? 0 : Math.floor(rnd(1, 3));
        for (let i = 0; i < n; i++) {
          const delay = i * rnd(250, 700);
          window.setTimeout(() => this.spawnSub(l), delay);
        }
        l.nextWave = nowP + (l.conductor ? rnd(26000, 40000) : rnd(25000, 60000));
      }

      // lifecycle by silence
      const quiet = now - l.s.lastEventAt;
      if (l.s.state === "active" && quiet > CFG.DEMO_IDLE_AFTER_MS) { l.s.state = "idle"; dirty.add(l); }
    }

    // apply events locally to demo's own session bookkeeping, then emit
    if (out.length) {
      for (const e of out) {
        const l = this.lanes.find((x) => x.s.id === e.sessionId);
        if (!l) continue;
        l.s.lastEventAt = e.ts;
        if (l.s.state !== "active") { l.s.state = "active"; dirty.add(l); }
        if (e.tokens) {
          l.s.tokens.input += e.tokens.input; l.s.tokens.output += e.tokens.output;
          l.s.tokens.cacheRead += e.tokens.cacheRead; l.s.tokens.cacheWrite += e.tokens.cacheWrite;
        }
        if (e.costUsd) l.s.costUsd += e.costUsd;
      }
      this.emit({ v: 1, type: "events", events: out });
    }

    // idle sessions wake up now and then; idle -> ended
    for (const l of this.lanes) {
      if (l.s.state === "idle") {
        if (Math.random() < dt * 0.012) { l.main.mode = "quiet"; l.main.until = nowP; }
        else if (now - l.s.lastEventAt > CFG.DEMO_END_AFTER_MS) { l.s.state = "ended"; l.s.endedAt = now; dirty.add(l); }
      }
    }
    // ended -> removed, replaced by a fresh lane
    for (const l of [...this.lanes]) {
      if (l.s.state === "ended" && l.s.endedAt && now - l.s.endedAt > 28000) {
        this.lanes.splice(this.lanes.indexOf(l), 1);
        this.emit({ v: 1, type: "remove", sessionId: l.s.id });
        if (!l.conductor) {
          const nl = this.mkLane(now, { state: "active" });
          this.lanes.push(nl);
          this.emit({ v: 1, type: "session", session: this.copy(nl.s) });
        }
      }
    }
    for (const l of dirty) this.emit({ v: 1, type: "session", session: this.copy(l.s) });
  }

  private spawnSub(l: Lane) {
    if (!this.lanes.includes(l) || l.s.state === "ended") return;
    const id = "sa-" + hex(6);
    const type = pick(SUBTYPES);
    const life = rnd(7000, 20000);
    const a: Agent = { id, mode: "turn", until: performance.now() + 1500, rate: rnd(3, 9), endsAt: performance.now() + life };
    l.subs.push(a);
    l.s.subagents[id] = { id, type, state: "running", startedAt: Date.now() };
    const spawn = this.ev(l, null, "subagent_spawn", { tool: "Agent", detail: type });
    this.emit({ v: 1, type: "events", events: [spawn] });
    this.emit({ v: 1, type: "session", session: this.copy(l.s) });
    l.s.lastEventAt = Date.now();
  }

  private stepAgent(l: Lane, a: Agent, nowP: number, dt: number, out: SessionEvent[], stormOn: boolean) {
    const active = l.s.state === "active" || l.s.state === "idle";
    if (!active) return;
    if (a.mode === "sleep") {
      if (nowP >= a.until) { a.mode = "quiet"; a.until = nowP; }
      return;
    }
    if (stormOn && a.mode !== "storm" && l.s.state === "active") {
      a.mode = "storm"; a.rate = rnd(18, 60); a.until = this.stormUntil;
    }
    if (nowP >= a.until) {
      switch (a.mode) {
        case "quiet":
          if (!a.endsAt && !l.conductor && Math.random() < 0.08) { a.mode = "sleep"; a.until = nowP + rnd(32000, 70000); break; }
          out.push(this.ev(l, a.id, "prompt"));
          out.push(this.apiEvent(l, a.id));
          a.mode = "turn"; a.rate = rnd(1.2, 5); a.until = nowP + rnd(3500, 11000);
          break;
        case "turn":
          out.push(this.apiEvent(l, a.id));
          out.push(this.ev(l, a.id, "response"));
          if (Math.random() < 0.04) out.push(this.ev(l, null, "compaction"));
          if (Math.random() < (l.conductor ? 0.5 : 0.28) && !stormOn) { a.mode = "storm"; a.rate = rnd(20, 90); a.until = nowP + rnd(1800, 4200); }
          else { a.mode = "quiet"; a.until = nowP + (a.endsAt ? rnd(600, 2000) : rnd(2500, 11000)); }
          break;
        case "storm":
          a.mode = "quiet"; a.until = nowP + rnd(1500, 5000);
          break;
      }
    }
    if (a.mode === "turn" || a.mode === "storm") {
      let n = a.rate * dt;
      let k = Math.floor(n);
      if (Math.random() < n - k) k++;
      for (let i = 0; i < k; i++) {
        if (a.mode === "turn" && Math.random() < 0.12) out.push(this.apiEvent(l, a.id));
        else out.push(this.toolEvent(l, a.id));
      }
    }
  }
}
