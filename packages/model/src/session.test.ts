import { describe, expect, it } from "vitest";
import {
  applyEvent,
  classifyRole,
  compareSessions,
  isRemovable,
  orderForLayout,
  stateAt,
  tick,
} from "./session.ts";
import {
  END_AFTER_MS,
  FADE_AFTER_MS,
  IDLE_AFTER_MS,
  RECENT_LIMIT,
  type Session,
  type SessionEvent,
} from "./types.ts";

const SID = "00000000-0000-4000-8000-000000000001";
const T0 = 1_700_000_000_000;

let n = 0;
function ev(partial: Partial<SessionEvent> & Pick<SessionEvent, "kind">): SessionEvent {
  n++;
  return {
    id: `e${n}`,
    sessionId: SID,
    agentId: null,
    ts: T0,
    machine: "laptop",
    source: "otel",
    ...partial,
  };
}

function fold(events: SessionEvent[]): Session {
  let s: Session | undefined;
  for (const e of events) s = applyEvent(s, e);
  if (!s) throw new Error("no events");
  return s;
}

describe("applyEvent", () => {
  it("creates a session from the first event", () => {
    const s = applyEvent(undefined, ev({ kind: "prompt", ts: T0, label: "t7" }));
    expect(s).toMatchObject({
      id: SID,
      shortId: "00000000",
      label: "t7",
      machine: "laptop",
      role: "session",
      state: "active",
      model: null,
      startedAt: T0,
      lastEventAt: T0,
      endedAt: null,
      subagents: {},
    });
  });

  it("defaults the label to the short id", () => {
    expect(applyEvent(undefined, ev({ kind: "prompt" })).label).toBe("00000000");
  });

  it("is pure: does not mutate the previous session", () => {
    const a = applyEvent(undefined, ev({ kind: "prompt" }));
    const snapshot = JSON.stringify(a);
    applyEvent(a, ev({ kind: "tool_result", tool: "Bash", ts: T0 + 5 }));
    expect(JSON.stringify(a)).toBe(snapshot);
  });

  it("accumulates tokens and cost from api_request events only", () => {
    const s = fold([
      ev({
        kind: "api_request",
        model: "m1",
        tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite: 1 },
        costUsd: 0.5,
      }),
      ev({
        kind: "api_request",
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        costUsd: 0.25,
      }),
      ev({ kind: "response", model: "m2" }),
    ]);
    expect(s.tokens).toEqual({ input: 11, output: 7, cacheRead: 103, cacheWrite: 5 });
    expect(s.costUsd).toBeCloseTo(0.75);
    expect(s.model).toBe("m2");
  });

  it("subagent models do not override the main model once set", () => {
    const s = fold([
      ev({ kind: "api_request", model: "main-model" }),
      ev({ kind: "api_request", model: "sub-model", agentId: "a1" }),
    ]);
    expect(s.model).toBe("main-model");
  });

  it("tracks first/last event time regardless of arrival order", () => {
    const s = fold([ev({ kind: "prompt", ts: T0 + 100 }), ev({ kind: "prompt", ts: T0 })]);
    expect(s.startedAt).toBe(T0);
    expect(s.lastEventAt).toBe(T0 + 100);
  });

  it("keeps a ts-ordered ring buffer of the last 50 events", () => {
    let s: Session | undefined;
    for (let i = 0; i < RECENT_LIMIT + 10; i++)
      s = applyEvent(s, ev({ kind: "prompt", ts: T0 + i }));
    expect(s?.recent).toHaveLength(RECENT_LIMIT);
    expect(s?.recent[0]?.ts).toBe(T0 + 10);
    const late = applyEvent(s, ev({ kind: "prompt", ts: T0 + 30 }));
    const ts = late.recent.map((e) => e.ts);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it("upgrades machine from unknown, and revives an ended session", () => {
    const a = applyEvent(undefined, ev({ kind: "prompt", machine: "unknown" }));
    const b = applyEvent(
      { ...a, state: "ended", endedAt: T0 + 5 },
      ev({ kind: "prompt", machine: "vps", ts: T0 + 9 }),
    );
    expect(b.machine).toBe("vps");
    expect(b.state).toBe("active");
    expect(b.endedAt).toBeNull();
  });
});

describe("subagents and conductor classification", () => {
  const spawn = (id: string, type: string, ts: number): SessionEvent =>
    ev({ kind: "subagent_spawn", tool: "Agent", detail: type, id, spawnId: id, ts });

  it("OTel flow: spawn, then first event of a new key binds to the pending spawn", () => {
    const s = fold([
      spawn("toolu_a", "reviewer", T0),
      ev({ kind: "api_request", agentId: "reviewer", ts: T0 + 10 }),
    ]);
    expect(Object.keys(s.subagents)).toEqual(["reviewer"]);
    expect(s.subagents["reviewer"]).toMatchObject({
      state: "running",
      type: "reviewer",
      startedAt: T0,
    });
  });

  it("subagent_completed docks the oldest running subagent of that type", () => {
    const s = fold([
      spawn("toolu_a", "reviewer", T0),
      spawn("toolu_b", "reviewer", T0 + 1),
      spawn("toolu_c", "builder", T0 + 2),
      ev({ kind: "subagent_done", agentId: null, agentType: "reviewer", ts: T0 + 100 }),
    ]);
    expect(s.subagents["toolu_a"]).toMatchObject({ state: "docked", endedAt: T0 + 100 });
    expect(s.subagents["toolu_b"]?.state).toBe("running");
    expect(s.subagents["toolu_c"]?.state).toBe("running");
  });

  it("falls back to the oldest running subagent when no type matches; ignores done with none running", () => {
    const s = fold([
      spawn("toolu_a", "reviewer", T0),
      ev({ kind: "subagent_done", agentType: "custom", ts: T0 + 1 }),
      ev({ kind: "subagent_done", agentType: "custom", ts: T0 + 2 }),
    ]);
    expect(s.subagents["toolu_a"]).toMatchObject({ state: "docked", endedAt: T0 + 1 });
  });

  it("JSONL flow: exact binding through spawnId, type from meta", () => {
    const s = fold([
      spawn("toolu_x", "Explore", T0),
      spawn("toolu_y", "Explore", T0 + 1),
      ev({
        kind: "tool_decision",
        agentId: "agent-2",
        spawnId: "toolu_y",
        agentType: "Explore",
        ts: T0 + 5,
      }),
      ev({ kind: "subagent_done", agentId: "agent-2", spawnId: "toolu_y", ts: T0 + 9 }),
    ]);
    expect(s.subagents["agent-2"]).toMatchObject({
      state: "docked",
      endedAt: T0 + 9,
      type: "Explore",
    });
    expect(s.subagents["toolu_x"]?.state).toBe("running");
    expect(s.subagents["toolu_y"]).toBeUndefined();
  });

  it("a docked subagent that works again is revived", () => {
    const s = fold([
      ev({ kind: "api_request", agentId: "a1", ts: T0 }),
      ev({ kind: "subagent_done", agentId: "a1", ts: T0 + 5 }),
      ev({ kind: "tool_result", agentId: "a1", ts: T0 + 10 }),
    ]);
    expect(s.subagents["a1"]).toMatchObject({ state: "running" });
    expect(s.subagents["a1"]?.endedAt).toBeUndefined();
  });

  it("does not duplicate a spawn that was already bound via JSONL meta", () => {
    const s = fold([
      ev({
        kind: "tool_decision",
        agentId: "agent-9",
        spawnId: "toolu_z",
        agentType: "Plan",
        ts: T0,
      }),
      spawn("toolu_z", "Plan", T0 + 1),
    ]);
    expect(Object.keys(s.subagents)).toEqual(["agent-9"]);
  });

  it("classifyRole: <3 spawns and <2 concurrent is a session", () => {
    const one = fold([spawn("a", "x", T0)]);
    expect(one.role).toBe("session");
    const two = fold([
      spawn("a", "x", T0),
      ev({ kind: "subagent_done", ts: T0 + 1 }),
      spawn("b", "x", T0 + 2),
    ]);
    expect(two.role).toBe("session");
  });

  it("classifyRole: 2 concurrent is a conductor", () => {
    const s = fold([spawn("a", "x", T0), spawn("b", "x", T0 + 1)]);
    expect(s.role).toBe("conductor");
  });

  it("classifyRole: 3 sequential spawns is a conductor, and the role is sticky", () => {
    const events: SessionEvent[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(spawn(`t${i}`, "x", T0 + i * 10));
      events.push(ev({ kind: "subagent_done", agentType: "x", ts: T0 + i * 10 + 5 }));
    }
    const s = fold(events);
    expect(Object.values(s.subagents).every((a) => a.state === "docked")).toBe(true);
    expect(s.role).toBe("conductor");
    expect(applyEvent(s, ev({ kind: "prompt", ts: T0 + 999 })).role).toBe("conductor");
  });

  it("classifyRole is pure over the subagent map", () => {
    expect(classifyRole({})).toBe("session");
  });
});

describe("lifecycle", () => {
  const base = fold([ev({ kind: "prompt", ts: T0 })]);

  it("stateAt follows the contract constants exactly", () => {
    expect(stateAt(T0, T0)).toBe("active");
    expect(stateAt(T0, T0 + IDLE_AFTER_MS - 1)).toBe("active");
    expect(stateAt(T0, T0 + IDLE_AFTER_MS)).toBe("idle");
    expect(stateAt(T0, T0 + END_AFTER_MS - 1)).toBe("idle");
    expect(stateAt(T0, T0 + END_AFTER_MS)).toBe("ended");
  });

  it("uses the contract defaults", () => {
    expect(IDLE_AFTER_MS).toBe(60_000);
    expect(END_AFTER_MS).toBe(30 * 60_000);
    expect(FADE_AFTER_MS).toBe(15 * 60_000);
  });

  it("tick: active -> idle -> ended -> removed, with an injected clock", () => {
    expect(tick([base], T0 + 1000)).toEqual({ updated: [], removed: [] });

    const idle = tick([base], T0 + IDLE_AFTER_MS);
    expect(idle.updated[0]).toMatchObject({ state: "idle", endedAt: null });

    const ended = tick([base], T0 + END_AFTER_MS);
    expect(ended.updated[0]).toMatchObject({ state: "ended", endedAt: T0 + END_AFTER_MS });

    const justBefore = tick([base], T0 + END_AFTER_MS + FADE_AFTER_MS - 1);
    expect(justBefore.removed).toEqual([]);
    const gone = tick([base], T0 + END_AFTER_MS + FADE_AFTER_MS);
    expect(gone.removed).toEqual([base.id]);
    expect(isRemovable(base, T0 + END_AFTER_MS + FADE_AFTER_MS)).toBe(true);
  });

  it("tick is idempotent: an already settled session is not reported again", () => {
    const idle = tick([base], T0 + IDLE_AFTER_MS).updated[0] as Session;
    expect(tick([idle], T0 + IDLE_AFTER_MS + 1000).updated).toEqual([]);
  });

  it("tick does not mutate its input and reports only changed sessions", () => {
    const fresh = fold([
      ev({ kind: "prompt", ts: T0 + IDLE_AFTER_MS, sessionId: "other-session-id" }),
    ]);
    const before = JSON.stringify(base);
    const r = tick([base, fresh], T0 + IDLE_AFTER_MS);
    expect(JSON.stringify(base)).toBe(before);
    expect(r.updated.map((s) => s.id)).toEqual([base.id]);
  });

  it("tick docks running subagents when the session ends", () => {
    const s = fold([
      ev({ kind: "subagent_spawn", id: "a", spawnId: "a", detail: "x", ts: T0 }),
      ev({ kind: "subagent_spawn", id: "b", spawnId: "b", detail: "x", ts: T0 }),
    ]);
    const ended = tick([s], T0 + END_AFTER_MS).updated[0] as Session;
    expect(Object.values(ended.subagents).map((a) => a.state)).toEqual(["docked", "docked"]);
    expect(ended.subagents["a"]?.endedAt).toBe(T0 + END_AFTER_MS);
  });

  it("a very old backfilled session goes straight to removed", () => {
    const old = fold([ev({ kind: "prompt", ts: T0 - 3 * 60 * 60_000 })]);
    expect(tick([old], T0).removed).toEqual([old.id]);
  });

  it("a new event revives an idle session", () => {
    const idle = tick([base], T0 + IDLE_AFTER_MS).updated[0] as Session;
    const revived = applyEvent(idle, ev({ kind: "tool_result", ts: T0 + IDLE_AFTER_MS + 5 }));
    expect(revived.state).toBe("active");
    expect(tick([revived], T0 + IDLE_AFTER_MS + 6).updated).toEqual([]);
  });
});

describe("layout ordering", () => {
  const mk = (id: string, state: Session["state"], last: number): Session => ({
    ...fold([ev({ kind: "prompt", sessionId: id, ts: last })]),
    state,
  });

  it("orders by state, then lastEventAt descending", () => {
    const list = [
      mk("ended-new", "ended", T0 + 9),
      mk("idle-old", "idle", T0 + 1),
      mk("active-old", "active", T0 + 2),
      mk("active-new", "active", T0 + 8),
      mk("idle-new", "idle", T0 + 5),
    ];
    expect(orderForLayout(list).map((s) => s.id)).toEqual([
      "active-new",
      "active-old",
      "idle-new",
      "idle-old",
      "ended-new",
    ]);
  });

  it("is deterministic on ties and does not mutate its input", () => {
    const a = mk("aaa", "active", T0);
    const b = mk("bbb", "active", T0);
    const input = [b, a];
    expect(orderForLayout(input).map((s) => s.id)).toEqual(["aaa", "bbb"]);
    expect(input[0]).toBe(b);
    expect(compareSessions(a, a)).toBe(0);
  });
});
