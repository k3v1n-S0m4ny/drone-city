import { describe, expect, it } from "vitest";
import type { ServerMsg, Session, SessionEvent } from "@drone-city/model";
import { applyEvent } from "@drone-city/model";
import { Broadcaster } from "./broadcaster.ts";
import type { Socket } from "./broadcaster.ts";

class FakeSocket implements Socket {
  readyState = 1;
  bufferedAmount = 0;
  sent: ServerMsg[] = [];
  terminated = false;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMsg);
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }
  types(): string[] {
    return this.sent.map((m) => m.type);
  }
}

/** Manual timer queue so tests control coalescing deterministically. */
function manualTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    setTimer: (fn: () => void) => {
      const id = next++;
      pending.set(id, fn);
      return id;
    },
    clearTimer: (t: unknown) => {
      pending.delete(t as number);
    },
    fire(): void {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    count: () => pending.size,
  };
}

const ev = (id: string, sessionId = "00000000-0000-4000-8000-0000000000aa"): SessionEvent => ({
  id,
  sessionId,
  agentId: null,
  kind: "prompt",
  ts: 1,
  machine: "laptop",
  source: "otel",
});
const sess = (id = "00000000-0000-4000-8000-0000000000aa"): Session =>
  applyEvent(undefined, ev("x", id));

function setup(over: { maxQueued?: number; highWaterBytes?: number } = {}) {
  const timers = manualTimers();
  const snapshotMsg = (): ServerMsg => ({ v: 1, type: "snapshot", now: 5, sessions: [] });
  const b = new Broadcaster({
    coalesceMs: 50,
    maxQueued: over.maxQueued ?? 100,
    highWaterBytes: over.highWaterBytes ?? 1000,
    snapshot: snapshotMsg,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { b, timers };
}

describe("Broadcaster", () => {
  it("sends a snapshot immediately on add", () => {
    const { b } = setup();
    const s = new FakeSocket();
    b.add(s);
    expect(s.types()).toEqual(["snapshot"]);
  });

  it("coalesces many publishes into one flush: events, then session, then remove", () => {
    const { b, timers } = setup();
    const s = new FakeSocket();
    b.add(s);
    b.publish({ events: [ev("1")], upserts: [sess()], removes: [] });
    b.publish({ events: [ev("2")], upserts: [sess()], removes: ["gone"] });
    expect(timers.count()).toBe(1);
    expect(s.types()).toEqual(["snapshot"]);
    timers.fire();
    expect(s.types()).toEqual(["snapshot", "events", "session", "remove"]);
    const events = s.sent[1];
    expect(events?.type === "events" && events.events.map((e) => e.id)).toEqual(["1", "2"]);
  });

  it("keeps only the latest upsert per session, and a remove cancels a pending upsert", () => {
    const { b, timers } = setup();
    const s = new FakeSocket();
    b.add(s);
    b.publish({ events: [], upserts: [sess("a"), sess("b")], removes: [] });
    b.publish({ events: [], upserts: [sess("a")], removes: ["b"] });
    timers.fire();
    expect(s.types()).toEqual(["snapshot", "session", "remove"]);
  });

  it("splits very large batches into several event frames", () => {
    const { b, timers } = setup({ maxQueued: 100_000 });
    const s = new FakeSocket();
    b.add(s);
    b.publish({
      events: Array.from({ length: 1200 }, (_, i) => ev(`e${i}`)),
      upserts: [],
      removes: [],
    });
    timers.fire();
    expect(s.types()).toEqual(["snapshot", "events", "events", "events"]);
  });

  it("when a client queue exceeds the bound, drops it and sends a fresh snapshot instead", () => {
    const { b, timers } = setup({ maxQueued: 3 });
    const s = new FakeSocket();
    b.add(s);
    b.publish({ events: [ev("1"), ev("2"), ev("3"), ev("4")], upserts: [], removes: [] });
    b.publish({ events: [ev("5")], upserts: [], removes: [] });
    timers.fire();
    expect(s.types()).toEqual(["snapshot", "snapshot"]);
    expect(b.stats.resyncs).toBe(1);
    // and it recovers: later changes flow as deltas again
    b.publish({ events: [ev("6")], upserts: [], removes: [] });
    timers.fire();
    expect(s.types()).toEqual(["snapshot", "snapshot", "events"]);
  });

  it("a slow socket (buffer above high water) gets nothing until it drains, then a snapshot", () => {
    const { b, timers } = setup({ highWaterBytes: 1000 });
    const slow = new FakeSocket();
    const fast = new FakeSocket();
    b.add(slow);
    b.add(fast);
    slow.bufferedAmount = 5000;
    b.publish({ events: [ev("1")], upserts: [], removes: [] });
    timers.fire();
    expect(slow.types()).toEqual(["snapshot"]); // nothing new piled on
    expect(fast.types()).toEqual(["snapshot", "events"]); // others unaffected

    b.publish({ events: [ev("2")], upserts: [], removes: [] }); // queued events are dropped for slow
    slow.bufferedAmount = 0;
    timers.fire();
    expect(slow.types()).toEqual(["snapshot", "snapshot"]);
    expect(b.stats.resyncs).toBe(1);
  });

  it("terminates a client whose buffer is hopelessly behind", () => {
    const { b, timers } = setup({ highWaterBytes: 10 });
    const s = new FakeSocket();
    b.add(s);
    s.bufferedAmount = 10 * 16 + 1;
    b.publish({ events: [ev("1")], upserts: [], removes: [] });
    timers.fire();
    expect(s.terminated).toBe(true);
    expect(b.size).toBe(0);
  });

  it("detaches closed sockets and ignores publishes with no changes", () => {
    const { b, timers } = setup();
    const s = new FakeSocket();
    const detach = b.add(s);
    b.publish({ events: [], upserts: [], removes: [] });
    expect(timers.count()).toBe(0);
    detach();
    expect(b.size).toBe(0);
    b.publish({ events: [ev("1")], upserts: [], removes: [] });
    expect(timers.count()).toBe(0);
  });

  it("resync sends a fresh snapshot on request", () => {
    const { b, timers } = setup();
    const s = new FakeSocket();
    b.add(s);
    b.resync(s);
    timers.fire();
    expect(s.types()).toEqual(["snapshot", "snapshot"]);
  });
});
