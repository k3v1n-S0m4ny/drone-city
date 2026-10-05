import * as THREE from "three";
import { lineMat, meshGlowMat } from "./glow";
import { SYM } from "./symbols";

const ringGeo = (seg: number, rot = 0) => new THREE.RingGeometry(0.93, 1, seg, 1, rot).rotateX(-Math.PI / 2);
const UP = new THREE.Vector3(0, 1, 0);
const tmpDir = new THREE.Vector3();
const tmpMid = new THREE.Vector3();
const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);
const easeIn = (p: number) => p * p;

export const ANIM_MS: Record<string, number> = {
  prompt: 650, api: 560, response: 600, read: 520, edit: 560, bash: 520, web: 650, agent: 650, mcp: 560, error: 760, other: 380, compaction: 650,
};

/**
 * One distinct animation per event family. Only one plays at a time per drone;
 * that is exactly what the burst threshold gates (busy -> bubble instead).
 */
export class DroneFx {
  root = new THREE.Group();
  private circ: THREE.Mesh[] = [];
  private hexa: THREE.Mesh;
  private octa: THREE.Mesh;
  private beam: THREE.Mesh;
  private beam2: THREE.Mesh;
  private globe: THREE.LineSegments;
  private globeMat: THREE.LineBasicMaterial;
  cur: { key: string; t0: number; dur: number } | null = null;
  /** set while an animation wants the drone to lean toward a tower */
  lean = 0;
  shake = 0;

  constructor() {
    const mk = (g: THREE.BufferGeometry) => {
      const m = new THREE.Mesh(g, meshGlowMat("#ffffff", 0));
      m.visible = false;
      m.raycast = () => {};
      this.root.add(m);
      return m;
    };
    this.circ = [mk(ringGeo(64)), mk(ringGeo(64))];
    this.hexa = mk(ringGeo(6, Math.PI / 6));
    this.octa = mk(ringGeo(8));
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    this.beam = mk(cyl);
    this.beam2 = mk(cyl);
    this.globeMat = lineMat("#5f9bff", 0);
    this.globe = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1, 1)), this.globeMat);
    this.globe.visible = false;
    this.globe.raycast = () => {};
    this.root.add(this.globe);
  }

  play(key: string, now: number) {
    this.cur = { key, t0: now, dur: ANIM_MS[key] ?? 500 };
  }

  private ring(m: THREE.Mesh, pos: THREE.Vector3, r: number, op: number, col: THREE.Color) {
    m.visible = op > 0.01;
    m.position.copy(pos);
    m.scale.setScalar(Math.max(0.01, r));
    const mat = m.material as THREE.MeshBasicMaterial;
    mat.opacity = op;
    mat.color.copy(col).multiplyScalar(1.25);
  }
  private seg(m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, radius: number, op: number, col: THREE.Color) {
    const len = a.distanceTo(b);
    m.visible = op > 0.01 && len > 0.01;
    if (!m.visible) return;
    tmpMid.addVectors(a, b).multiplyScalar(0.5);
    m.position.copy(tmpMid);
    tmpDir.subVectors(b, a).normalize();
    m.quaternion.setFromUnitVectors(UP, tmpDir);
    m.scale.set(radius, len, radius);
    const mat = m.material as THREE.MeshBasicMaterial;
    mat.opacity = op;
    mat.color.copy(col).multiplyScalar(1.6);
  }

  private hideAll() {
    for (const m of [...this.circ, this.hexa, this.octa, this.beam, this.beam2]) m.visible = false;
    this.globe.visible = false;
  }

  private col = new THREE.Color();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private g = new THREE.Vector3();

  /** dp: drone pos, top/base: target tower top & ground base (all city-local) */
  update(now: number, dp: THREE.Vector3, top: THREE.Vector3, base: THREE.Vector3) {
    const c = this.cur;
    this.lean = 0;
    this.shake = 0;
    if (!c) return;
    const p = (now - c.t0) / c.dur;
    if (p >= 1) {
      this.cur = null;
      this.hideAll();
      return;
    }
    const sym = SYM[c.key] ?? SYM.other;
    this.col.set(sym.color);
    const col = this.col;
    const fade = 1 - p;
    const [r0, r1] = this.circ;
    this.g.set(base.x, 0.07, base.z);
    this.hideAll();
    switch (c.key) {
      case "prompt": { // light descends onto the drone, ring contracts: input arriving
        this.a.set(dp.x, dp.y + 5, dp.z);
        this.seg(this.beam, this.a, dp, 0.05, fade * 0.9, col);
        this.ring(r0, this.b.set(dp.x, dp.y + 0.2, dp.z), 2.4 - 2.1 * easeOut(p), fade, col);
        break;
      }
      case "api": { // uplink: beam shoots skyward + ring
        this.a.set(dp.x, dp.y + 5.5 * easeOut(p), dp.z);
        this.seg(this.beam, dp, this.a, 0.03, fade, col);
        this.ring(r0, this.b.set(dp.x, dp.y + 0.1, dp.z), 0.5 + 1.4 * p, fade, col);
        this.ring(r1, this.g.set(dp.x, 0.07, dp.z), 0.4 + 2.2 * easeOut(p), fade * 0.7, col);
        break;
      }
      case "response": { // downlink: beam falls from the sky, lands as a ring
        const top9 = this.a.set(dp.x, dp.y + 5.5, dp.z);
        const head = this.b.set(dp.x, dp.y + 5.5 * (1 - easeOut(p)), dp.z);
        this.seg(this.beam, top9, head, 0.03, Math.min(1, fade * 1.4), col);
        this.ring(r0, this.g.set(dp.x, 0.07, dp.z), 0.3 + 2.3 * easeOut(p), fade, col);
        break;
      }
      case "read": { // thin laser to the read tower + expanding scan ping
        this.lean = 1;
        this.seg(this.beam, dp, top, 0.025, 0.95 * Math.min(1, fade * 2), col);
        if (p > 0.25) this.ring(r0, this.g, 0.3 + 2.0 * easeOut((p - 0.25) / 0.75), fade, col);
        break;
      }
      case "edit": { // fat strobing beam + caps flash: writing
        this.lean = 1;
        const strobe = 0.55 + 0.45 * Math.sin(p * 60);
        this.seg(this.beam, dp, top, 0.1, fade * strobe + 0.15, col);
        this.seg(this.beam2, this.a.set(top.x, top.y, top.z), this.b.set(top.x, top.y + 1.3 * p, top.z), 0.12, fade, col);
        this.ring(r0, this.a.set(top.x, top.y, top.z), 0.4 + 0.9 * p, fade, col);
        break;
      }
      case "bash": { // stuttering dotted beam (terminal blinking) + small ring
        this.lean = 1;
        const on = (p * 9) % 1 < 0.55;
        this.seg(this.beam, dp, top, 0.035, on ? 0.95 : 0, col);
        this.ring(r0, this.g, 0.2 + 0.9 * easeOut(p), fade, col);
        break;
      }
      case "web": { // wireframe globe unfolds above the drone, uplink beam
        this.globe.visible = true;
        this.globe.position.set(dp.x, dp.y + 1.4, dp.z);
        this.globe.scale.setScalar(0.3 + 2.1 * easeOut(p));
        this.globe.rotation.y = p * 6;
        this.globeMat.opacity = fade;
        this.globeMat.color.copy(col).multiplyScalar(1.6);
        this.a.set(dp.x, dp.y + 5 * easeOut(p), dp.z);
        this.seg(this.beam, dp, this.a, 0.03, fade * 0.8, col);
        break;
      }
      case "agent": { // two hexagon shock rings: dispatch
        this.ring(this.hexa, this.b.set(dp.x, dp.y, dp.z), 0.5 + 2.8 * easeOut(p), fade, col);
        if (p > 0.22) this.ring(this.octa, this.a.set(dp.x, dp.y, dp.z), 0.4 + 2.2 * easeOut((p - 0.22) / 0.78), fade * 0.8, col);
        break;
      }
      case "mcp": { // dashed link beam + octagon plug at the tower
        this.lean = 1;
        const on = (p * 5) % 1 < 0.6;
        this.seg(this.beam, dp, top, 0.05, on ? 0.9 : 0.15, col);
        this.ring(this.octa, this.a.set(top.x, top.y, top.z), 0.3 + 1.0 * p, fade, col);
        this.ring(r0, this.g, 0.3 + 1.6 * easeOut(p), fade * 0.6, col);
        break;
      }
      case "error": { // orange glitch: jittering beam, big shock ring, shake
        this.shake = fade;
        const j = 0.35 * fade;
        this.a.set(top.x + (Math.random() - 0.5) * j, top.y + (Math.random() - 0.5) * j, top.z + (Math.random() - 0.5) * j);
        this.seg(this.beam, dp, this.a, 0.07, Math.random() < 0.8 ? fade : 0.1, col);
        this.ring(r0, this.b.set(dp.x, dp.y, dp.z), 0.5 + 3.4 * easeOut(p), fade, col);
        this.ring(this.hexa, this.a.set(dp.x, dp.y, dp.z), 0.4 + 2.2 * easeIn(p), fade * 0.8, col);
        this.ring(r1, this.g, 0.4 + 3.0 * easeOut(p), fade * 0.7, col);
        break;
      }
      case "compaction": {
        this.ring(this.hexa, this.b.set(dp.x, dp.y, dp.z), 2.4 - 2.0 * easeOut(p), fade, col);
        break;
      }
      default: { // other tool ok: small mint ripple
        this.ring(r0, this.b.set(dp.x, dp.y, dp.z), 0.3 + 0.9 * p, fade * 0.8, col);
      }
    }
  }
}
