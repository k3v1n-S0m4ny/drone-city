import * as THREE from "three";
import { CFG } from "./config";
import { additive } from "./glow";
import { towerPos } from "./iso";

interface Pulse {
  pts: THREE.Vector3[];
  cum: number[];
  total: number;
  d: number;
  tower: number;
  color: THREE.Color;
  armed: boolean;
}

const CAP = 28;
const GHOSTS = 4;
const geo = new THREE.OctahedronGeometry(0.1, 0);
const tmp = new THREE.Vector3();
const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const sc = new THREE.Vector3();

/**
 * Activity pulses: a bright bead leaves the drone, drops to the plate, runs along
 * the circuit trace (Manhattan route) to the matching tower and climbs it.
 */
export class Pulses {
  mesh: THREE.InstancedMesh;
  private list: Pulse[] = [];
  private color = new THREE.Color();
  onArrive: (tower: number, color: THREE.Color) => void = () => {};

  constructor() {
    const mat = new THREE.MeshBasicMaterial({ color: "#ffffff", ...additive });
    this.mesh = new THREE.InstancedMesh(geo, mat, CAP * GHOSTS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.raycast = () => {};
    this.mesh.count = 0;
    for (let i = 0; i < CAP * GHOSTS; i++) this.mesh.setColorAt(i, this.color.set("#000000"));
  }

  /** route for a tower index 0..5 (satellite) or 6 (core) */
  static route(start: THREE.Vector3, tower: number, topY: number): THREE.Vector3[] {
    const pts = [start.clone(), new THREE.Vector3(start.x, 0.06, start.z), new THREE.Vector3(0, 0.06, 0)];
    if (tower < 6) {
      const [tx, tz] = towerPos(tower);
      pts.push(new THREE.Vector3(0, 0.06, tz), new THREE.Vector3(tx, 0.06, tz), new THREE.Vector3(tx, topY, tz));
    } else {
      pts.push(new THREE.Vector3(0, topY, 0));
    }
    return pts;
  }

  spawn(start: THREE.Vector3, tower: number, topY: number, color: THREE.ColorRepresentation) {
    if (this.list.length >= CAP) this.list.shift();
    const pts = Pulses.route(start, tower, topY);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    this.list.push({ pts, cum, total: cum[cum.length - 1], d: 0, tower, color: new THREE.Color(color), armed: true });
  }

  private at(p: Pulse, d: number, out: THREE.Vector3) {
    d = Math.max(0, Math.min(p.total, d));
    let i = 1;
    while (i < p.cum.length - 1 && p.cum[i] < d) i++;
    const seg = p.cum[i] - p.cum[i - 1] || 1;
    return out.lerpVectors(p.pts[i - 1], p.pts[i], (d - p.cum[i - 1]) / seg);
  }

  update(dt: number, fade: number) {
    let n = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.d += dt * CFG.PULSE_SPEED;
      if (p.armed && p.d >= p.total) {
        p.armed = false;
        this.onArrive(p.tower, p.color);
      }
      if (p.d > p.total + 1.4) this.list.splice(i, 1);
    }
    for (const p of this.list) {
      for (let g = 0; g < GHOSTS; g++) {
        const d = p.d - g * 0.32;
        if (d < 0 || d > p.total + 0.1) continue;
        this.at(p, d, tmp);
        const s = (1 - g / GHOSTS) * (g === 0 ? 1.5 : 1);
        sc.setScalar(Math.max(0.05, s));
        m4.compose(tmp, q, sc);
        this.mesh.setMatrixAt(n, m4);
        const k = (1 - g / GHOSTS) * 2.4 * fade;
        this.mesh.setColorAt(n, this.color.copy(p.color).multiplyScalar(k));
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
