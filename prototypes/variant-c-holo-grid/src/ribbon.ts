import * as THREE from "three";
import { VIEW_LOCAL } from "./iso";
import { additive } from "./glow";

/** Fading light trail drawn as a screen-facing triangle strip (fixed camera => constant view dir). */
export class Ribbon {
  mesh: THREE.Mesh;
  private n: number;
  private pts: THREE.Vector3[];
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private base = new THREE.Color();
  private tmpD = new THREE.Vector3();
  private tmpW = new THREE.Vector3();
  intensity = 1;

  constructor(n: number, color: THREE.ColorRepresentation) {
    this.n = n;
    this.pts = Array.from({ length: n }, () => new THREE.Vector3());
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3);
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("color", this.colAttr);
    const idx: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, ...additive }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.raycast = () => {};
    this.base.set(color);
  }
  setColor(c: THREE.ColorRepresentation) {
    this.base.set(c);
  }
  reset(p: THREE.Vector3) {
    for (const q of this.pts) q.copy(p);
  }
  push(p: THREE.Vector3) {
    const last = this.pts.pop()!;
    last.copy(p);
    this.pts.unshift(last);
  }
  update(width: number) {
    const { n, pts, posAttr, colAttr } = this;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      this.tmpD.subVectors(a, b);
      this.tmpW.crossVectors(this.tmpD, VIEW_LOCAL);
      const len = this.tmpW.length();
      if (len < 1e-5) this.tmpW.set(0, 0, 0);
      else this.tmpW.multiplyScalar(1 / len);
      const t = 1 - i / (n - 1);
      const w = width * t;
      const p = pts[i];
      posAttr.setXYZ(i * 2, p.x + this.tmpW.x * w, p.y + this.tmpW.y * w, p.z + this.tmpW.z * w);
      posAttr.setXYZ(i * 2 + 1, p.x - this.tmpW.x * w, p.y - this.tmpW.y * w, p.z - this.tmpW.z * w);
      const k = Math.pow(t, 1.6) * this.intensity;
      colAttr.setXYZ(i * 2, this.base.r * k, this.base.g * k, this.base.b * k);
      colAttr.setXYZ(i * 2 + 1, this.base.r * k, this.base.g * k, this.base.b * k);
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  }
}
