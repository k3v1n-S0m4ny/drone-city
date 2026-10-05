import { Vector3 } from "three";
import { CFG } from "../config";

export const SQ = Math.SQRT1_2;

/** Shared camera/scroll state (mutated by the camera rig, read by atmosphere shaders + HUD). */
export const view = {
  /** scroll offset in local-z units (0 = top row) */
  scroll: 0,
  scrollTarget: 0,
  maxScroll: 0,
  /** current camera look-at in WORLD space (follows scroll) */
  target: new Vector3(),
  zoom: 36,
};

export const BASE_Z = CFG.ROW_H * 0.42;

/** local (screen-aligned) layout coords -> world coords (root group is rotated 45deg about Y) */
export function localToWorld(x: number, z: number, out = new Vector3()) {
  return out.set((x + z) * SQ, 0, (z - x) * SQ);
}

export function slotPos(index: number): [number, number] {
  const c = index % CFG.COLUMNS;
  const r = Math.floor(index / CFG.COLUMNS);
  return [(c - (CFG.COLUMNS - 1) / 2) * CFG.COL_W, r * CFG.ROW_H];
}
