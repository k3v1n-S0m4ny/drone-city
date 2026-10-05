import * as THREE from "three";
import { CFG } from "./config";

// Fixed isometric ORTHO camera. World is rotated PI/4 so the "city" frame
// (x = screen-right, z = screen-down) is axis aligned with the screen.
export const CAM_DIST = 120;
export const CAM_DIR = new THREE.Vector3(1, 1, 1).normalize();
export const SIN_ELEV = Math.sin(Math.atan(1 / Math.SQRT2)); // 0.577
export const CITY_ROT = Math.PI / 4;
export const FOG_NEAR = CAM_DIST;
export const FOG_FAR = CAM_DIST + 42;

const tmpCam = new THREE.OrthographicCamera();
tmpCam.position.copy(CAM_DIR);
tmpCam.lookAt(0, 0, 0);
tmpCam.updateMatrixWorld();
/** camera orientation expressed inside the rotated city group: use for billboards */
export const BILLBOARD_Q = new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(0, 1, 0), -CITY_ROT)
  .multiply(tmpCam.quaternion);
/** view direction in city-local coordinates (for screen-facing ribbons) */
export const VIEW_LOCAL = new THREE.Vector3(0, 0, -1).applyQuaternion(BILLBOARD_Q).normalize();

const SQ3 = Math.sqrt(3);
export const slotW = () => SQ3 * CFG.HEX_R * CFG.GAP;
export const slotH = () => 1.5 * CFG.HEX_R * CFG.GAP;
export function slotPos(i: number): [number, number] {
  const row = Math.floor(i / CFG.COLS);
  const col = i % CFG.COLS;
  const W = slotW();
  return [(col - (CFG.COLS - 1) / 2) * W + (row % 2) * (W / 2) - W / 4, row * slotH()];
}

export const TOWER_R = 2.35;
/** satellite towers sit at hex edge-midpoints */
export function towerPos(k: number): [number, number] {
  const a = (k * Math.PI) / 3;
  return [Math.cos(a) * TOWER_R, Math.sin(a) * TOWER_R];
}
