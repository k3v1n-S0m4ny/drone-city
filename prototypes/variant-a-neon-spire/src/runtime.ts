// Mutable, non-React animation runtime. The store pushes events in here; the
// scene reads it every frame. Keeping this out of React state is what keeps
// 100 events/s cheap.
import type { Object3D } from "three";
import { Vector3 } from "three";
import {
  ANIM_MS,
  ANIM_TIME_SCALE,
  BUBBLE_MIN_INTERVAL_MS,
  CHILD_ANIM_MS,
} from "./config";
import { SYMBOLS, TOWER_FAMILY, eventFamily, type Family } from "./symbols";
import type { EventKind, SessionEvent } from "./types";

export const PADS = 8;
export const LAUNCH_MS = 1100;
export const DOCK_MS = 1200;

export function hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Tower {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
}
export interface Layout {
  towers: Tower[];
  maxH: number;
  hue: number; // 0 = magenta leaning, 1 = cyan leaning
}

export function makeLayout(id: string, block: number): Layout {
  const r = rng(hash32(id));
  const n = 3 + Math.floor(r() * 4); // 3..6
  const slots: [number, number][] = [];
  for (let j = 0; j < 2; j++) for (let i = 0; i < 3; i++) slots.push([i, j]);
  for (let i = slots.length - 1; i > 0; i--) {
    const k = Math.floor(r() * (i + 1));
    [slots[i], slots[k]] = [slots[k], slots[i]];
  }
  const towers: Tower[] = slots.slice(0, n).map(([i, j]) => {
    const w = 1.0 + r() * 0.7;
    const d = 1.0 + r() * 0.7;
    const back = j === 0;
    const h = Math.min(3.9, 1.5 + r() * 1.6 + (back ? 0.6 : 0));
    const sp = block / 3.1;
    return {
      x: (i - 1) * sp + (r() - 0.5) * 0.5,
      z: (j - 0.5) * sp * 0.95 + (r() - 0.5) * 0.4,
      w,
      d,
      h,
    };
  });
  // stable: sort by x then z so tower index ~ left-to-right
  towers.sort((a, b) => a.x - b.x || a.z - b.z);
  return { towers, maxH: Math.max(...towers.map((t) => t.h)), hue: r() };
}

export interface Anim {
  family: Family;
  kind: EventKind;
  t0: number;
  dur: number;
  tower: number;
  ok: boolean;
  color: string;
}

export interface ChildRT {
  id: string;
  type: string | null;
  state: "running" | "docked";
  t0: number;
  endedAt: number;
  pad: number;
  seed: number;
  anim: Anim | null;
  busyUntil: number;
  lastBubbleAt: number;
  root: Object3D | null;
  rate: number;
  count: number;
}

export interface DroneRT {
  id: string;
  root: Object3D | null; // main drone object (for world position)
  anim: Anim | null;
  busyUntil: number;
  lastBubbleAt: number;
  count: number; // events since last frame
  rate: number; // smoothed events / s
  bursting: number; // 0..1, decays; >0 while bubbles are being shot
  layout: Layout;
  towerPulse: Float32Array; // 6
  towerColor: string[]; // per tower pulse colour
  padFlash: Float32Array; // PADS
  nextPad: number;
  children: Map<string, ChildRT>;
  errFlash: number;
  lastGlyph: Family;
}

export const stats = { events: 0, bubbles: 0 };

export const hooks = {
  struct: () => {},
  bubble: null as null | ((p: Vector3, fam: Family, size: number) => void),
};

const rts = new Map<string, DroneRT>();
let blockSize = 5.2;
export const setBlockSize = (b: number) => (blockSize = b);

export function getRT(id: string): DroneRT {
  let rt = rts.get(id);
  if (!rt) {
    const layout = makeLayout(id, blockSize);
    rt = {
      id,
      root: null,
      anim: null,
      busyUntil: 0,
      lastBubbleAt: 0,
      count: 0,
      rate: 0,
      bursting: 0,
      layout,
      towerPulse: new Float32Array(6),
      towerColor: new Array(6).fill("#ffffff"),
      padFlash: new Float32Array(PADS),
      nextPad: 0,
      children: new Map(),
      errFlash: 0,
      lastGlyph: "other",
    };
    rts.set(id, rt);
  }
  return rt;
}
export function dropRT(id: string) {
  rts.delete(id);
}
export function allRTs() {
  return rts;
}

export function towerFor(rt: DroneRT, fam: Family): number {
  let i = TOWER_FAMILY.indexOf(fam);
  if (i < 0) i = fam === "agent" ? 4 : fam === "error" ? 2 : 5;
  return i % rt.layout.towers.length;
}

export function ensureChild(rt: DroneRT, id: string, type: string | null, now: number, quiet = false): ChildRT {
  let c = rt.children.get(id);
  if (c && c.state === "running") return c;
  const pad = rt.nextPad++ % PADS;
  c = {
    id,
    type,
    state: "running",
    t0: quiet ? now - LAUNCH_MS - 200 : now,
    endedAt: 0,
    pad,
    seed: hash32(id),
    anim: null,
    busyUntil: 0,
    lastBubbleAt: 0,
    root: null,
    rate: 0,
    count: 0,
  };
  rt.children.set(id, c);
  if (!quiet) rt.padFlash[pad] = 1;
  hooks.struct();
  return c;
}

export function dockChild(rt: DroneRT, id: string, now: number) {
  const c = rt.children.get(id);
  if (!c || c.state === "docked") return;
  c.state = "docked";
  c.endedAt = now;
  rt.padFlash[c.pad] = 0.6;
  setTimeout(hooks.struct, DOCK_MS + 400);
  hooks.struct();
}

const tmp = new Vector3();

function shootBubble(root: Object3D | null, fam: Family, size: number) {
  if (!root || !hooks.bubble) return;
  root.getWorldPosition(tmp);
  stats.bubbles++;
  hooks.bubble(tmp, fam, size);
}

function animFor(ev: SessionEvent, fam: Family, rt: DroneRT, now: number, child: boolean): Anim {
  const base = child ? CHILD_ANIM_MS : ANIM_MS[ev.kind];
  return {
    family: fam,
    kind: ev.kind,
    t0: now,
    dur: base * ANIM_TIME_SCALE,
    tower: towerFor(rt, fam),
    ok: ev.ok !== false,
    color: SYMBOLS[fam].color,
  };
}

/** The core burst rule: busy drone => bubble, idle drone => animate. */
export function dispatchEvent(ev: SessionEvent) {
  const rt = getRT(ev.sessionId);
  const now = performance.now();
  const fam = eventFamily(ev);
  rt.count++;
  stats.events++;
  rt.lastGlyph = fam;

  // tower window flash always happens (cheap, spatial, shows load)
  const tw = towerFor(rt, fam);
  if (ev.kind === "tool_result" || ev.kind === "error") {
    rt.towerPulse[tw] = Math.min(1.4, rt.towerPulse[tw] + 0.55);
    rt.towerColor[tw] = SYMBOLS[fam].color;
  }
  if (fam === "error") rt.errFlash = 1;

  // --- subagent routing -------------------------------------------------
  if (ev.kind === "subagent_spawn") {
    ensureChild(rt, ev.agentId ?? ev.id, ev.detail ?? null, now);
  } else if (ev.kind === "subagent_done") {
    if (ev.agentId) dockChild(rt, ev.agentId, now);
  }
  let child: ChildRT | null = null;
  if (ev.agentId) {
    child = rt.children.get(ev.agentId) ?? null;
    if (!child && ev.kind !== "subagent_done") child = ensureChild(rt, ev.agentId, null, now);
  }

  if (child) {
    child.count++;
    if (ev.kind === "subagent_spawn" || ev.kind === "subagent_done") return; // launch/dock anim drives itself
    const busy = now < child.busyUntil;
    if (busy) {
      if (now - child.lastBubbleAt >= BUBBLE_MIN_INTERVAL_MS) {
        child.lastBubbleAt = now;
        shootBubble(child.root, fam, 0.8);
      }
    } else {
      child.anim = animFor(ev, fam, rt, now, true);
      child.busyUntil = now + child.anim.dur;
    }
    return;
  }

  // --- main drone ------------------------------------------------------
  if (ev.kind === "tool_decision" && now < rt.busyUntil) return;
  const busy = now < rt.busyUntil;
  if (busy) {
    rt.bursting = 1;
    if (now - rt.lastBubbleAt >= BUBBLE_MIN_INTERVAL_MS) {
      rt.lastBubbleAt = now;
      shootBubble(rt.root, fam, 1);
    }
  } else {
    rt.anim = animFor(ev, fam, rt, now, false);
    rt.busyUntil = now + rt.anim.dur;
  }
}
