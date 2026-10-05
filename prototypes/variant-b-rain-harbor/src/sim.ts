// Mutable per-drone runtime: current animation, burst-bubble chips, subagent flight timing.
// Lives outside React on purpose; the scene reads it every frame.
import { Vector3 } from "three";
import { CFG } from "./config";
import { Family, FAMILIES, familyOf, codeOf } from "./symbols";
import type { SessionEvent } from "./types";

export interface Anim {
  fam: Family;
  t0: number;
  dur: number;
  seed: number;
}

export interface Chip {
  id: number;
  fam: Family;
  code: string;
  count: number;
  born: number;
  touched: number;
}

export const LAUNCH_MS = 1500;
export const DOCK_MS = 1400;

export class DroneRT {
  anim: Anim | null = null;
  busyUntil = 0;
  chips: Chip[] = [];
  overflow = 0;
  overflowAt = 0;
  lastChipAt = 0;
  rate = 0; // smoothed events / s
  lastRateAt = 0;
  /** local-to-district hover position, written by the craft component */
  pos = new Vector3();
  /** screen-space anchor for bubbles (css px), written by the craft component */
  screen = { x: 0, y: 0, on: false, lift: 0 };
  launchAt = -1e12;
  dockAt = -1e12;
  slot = 0;
  /** counters shown in the inspect panel / used by the HUD */
  animated = 0;
  bubbled = 0;
  constructor(public key: string, public sessionId: string, public agentId: string | null) {}

  phase(now: number): "docked" | "launching" | "working" | "docking" {
    if (this.launchAt < 0) return "docked";
    if (this.dockAt > this.launchAt) {
      if (now < this.dockAt) return "working";
      return now < this.dockAt + DOCK_MS ? "docking" : "docked";
    }
    return now < this.launchAt + LAUNCH_MS ? "launching" : "working";
  }
}

let chipSeq = 1;
const runtimes = new Map<string, DroneRT>();
export const keyOf = (sessionId: string, agentId: string | null) => (agentId ? `${sessionId}::${agentId}` : sessionId);

export const sim = {
  rt(sessionId: string, agentId: string | null): DroneRT {
    const key = keyOf(sessionId, agentId);
    let r = runtimes.get(key);
    if (!r) {
      r = new DroneRT(key, sessionId, agentId);
      runtimes.set(key, r);
    }
    return r;
  },
  has: (key: string) => runtimes.has(key),
  dropOne(sessionId: string, agentId: string | null) {
    runtimes.delete(keyOf(sessionId, agentId));
  },
  drop(sessionId: string) {
    for (const [k, r] of runtimes) if (r.sessionId === sessionId) runtimes.delete(k);
  },
  all: () => runtimes.values(),
  launch(sessionId: string, agentId: string, now: number) {
    const r = this.rt(sessionId, agentId);
    if (r.phase(now) === "docked" || r.dockAt > r.launchAt) {
      r.launchAt = now;
      r.dockAt = -1e12;
    }
  },
  dock(sessionId: string, agentId: string, now: number) {
    const r = this.rt(sessionId, agentId);
    if (r.launchAt > 0 && r.dockAt < r.launchAt) r.dockAt = now;
  },

  /** Decide: animation, or burst chip. `now` is performance.now(). */
  onEvent(ev: SessionEvent, now: number) {
    const fam = familyOf(ev);
    if (!fam) return;
    let r = this.rt(ev.sessionId, ev.agentId);
    // events from a docked subagent (late stragglers) are credited to the parent drone
    if (ev.agentId && r.phase(now) === "docked") r = this.rt(ev.sessionId, null);

    // smoothed rate
    const dt = Math.max(1, now - (r.lastRateAt || now - 1000));
    r.rate = r.rate * Math.exp(-dt / 1200) + 1000 / 1200;
    r.lastRateAt = now;

    const forced = fam === "error" || fam === "spawn" || fam === "done";
    const free = now >= r.busyUntil - CFG.BUBBLE_THRESHOLD_MS;
    if (forced || free) {
      const dur = FAMILIES[fam].dur;
      r.anim = { fam, t0: now, dur, seed: Math.random() };
      r.busyUntil = now + dur;
      r.animated++;
      // spawn / done / error are rare and important: tick a chip as well
      if (forced) this.chip(r, fam, codeOf(ev, fam), now, true);
    } else {
      r.bubbled++;
      this.chip(r, fam, codeOf(ev, fam), now, false);
    }
  },

  chip(r: DroneRT, fam: Family, code: string, now: number, force: boolean) {
    const last = r.chips[r.chips.length - 1];
    if (last && last.fam === fam && last.code === code && now - last.touched < CFG.BUBBLE_MERGE_MS) {
      last.count++;
      last.touched = now;
      return;
    }
    if (!force && now - r.lastChipAt < CFG.BUBBLE_MIN_GAP_MS) {
      r.overflow++;
      r.overflowAt = now;
      return;
    }
    r.lastChipAt = now;
    r.chips.push({ id: chipSeq++, fam, code, count: 1, born: now, touched: now });
    const max = r.agentId ? Math.min(3, CFG.BUBBLE_MAX_VISIBLE) : CFG.BUBBLE_MAX_VISIBLE;
    while (r.chips.length > max) {
      r.chips.shift();
      r.overflow++;
      r.overflowAt = now;
    }
  },
};
