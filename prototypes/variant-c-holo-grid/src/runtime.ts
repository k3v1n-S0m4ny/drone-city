// Non-reactive per-session runtime state, read by the render loop every frame.
// (Zustand holds the slow, React-visible state; this holds the fast stuff.)
import type { SessionEvent } from "./types";
import { toolFamily, type Family } from "./symbols";

export interface SessionRT {
  /** events received but not yet consumed by the drone's frame loop */
  queue: SessionEvent[];
  /** wall-clock arrival times (performance.now) inside the sliding window */
  arrivals: number[];
  counts: Record<Family, number>;
  lastEventAtLocal: number;
}

export const rt = new Map<string, SessionRT>();
export const globalArrivals: number[] = [];

export function getRT(id: string): SessionRT {
  let r = rt.get(id);
  if (!r) {
    r = {
      queue: [],
      arrivals: [],
      counts: { read: 0, edit: 0, bash: 0, web: 0, agent: 0, mcp: 0, other: 0 },
      lastEventAtLocal: 0,
    };
    rt.set(id, r);
  }
  return r;
}

export function pushEventRT(ev: SessionEvent, now: number) {
  const r = getRT(ev.sessionId);
  if (ev.kind === "tool_decision") {
    // decisions are announced to the model-side counters only; the tool_result is the visible act
    if (ev.tool !== "Agent" && ev.tool !== "Task") return;
  }
  r.queue.push(ev);
  if (r.queue.length > 400) r.queue.splice(0, r.queue.length - 400);
  r.arrivals.push(now);
  globalArrivals.push(now);
  r.lastEventAtLocal = now;
  if (ev.kind === "tool_result") r.counts[toolFamily(ev.tool)]++;
}

export function rateOf(arr: number[], now: number, windowMs: number): number {
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  return (arr.length * 1000) / windowMs;
}

export function seedCounts(id: string, evs: SessionEvent[]) {
  const r = getRT(id);
  if (r.lastEventAtLocal !== 0) return;
  for (const e of evs) if (e.kind === "tool_result") r.counts[toolFamily(e.tool)]++;
  r.lastEventAtLocal = -1;
}
