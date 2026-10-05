import * as THREE from "three";
import { FAMILIES, SYM } from "./symbols";
import { towerPos } from "./iso";
import { lineMat, makeVolMat, meshGlowMat } from "./glow";
import { PALETTE } from "./config";

const satGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
const satEdges = new THREE.EdgesGeometry(satGeo);
const coreGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1).translate(0, 0.5, 0);
const coreEdges = new THREE.EdgesGeometry(coreGeo);
const capGeo = new THREE.PlaneGeometry(1, 1);
const capLineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 0, -0.5), new THREE.Vector3(0.5, 0, 0.5), new THREE.Vector3(-0.5, 0, 0.5)]);

export interface TowerItem {
  group: THREE.Group;
  vol: THREE.ShaderMaterial;
  edge: THREE.LineBasicMaterial;
  cap: THREE.Mesh;
  capMat: THREE.MeshBasicMaterial;
  h: number;
  target: number;
  flash: number;
  flashColor: THREE.Color;
  base: THREE.Color;
  accent: THREE.Color;
  pos: THREE.Vector3;
}

/** 6 satellite data-towers (one per tool family) around a taller core tower (tokens). */
export class Towers {
  root = new THREE.Group();
  items: TowerItem[] = [];
  crown: THREE.LineLoop;
  crownMat: THREE.LineBasicMaterial;
  mats: { m: THREE.Material; base: number }[] = [];

  constructor() {
    const fams = [...FAMILIES, "core"] as string[];
    for (let k = 0; k < 7; k++) {
      const core = k === 6;
      const [x, z] = core ? [0, 0] : towerPos(k);
      const group = new THREE.Group();
      group.position.set(x, 0, z);
      const inner = new THREE.Group();
      inner.rotation.y = core ? Math.PI / 6 : Math.PI / 4;
      const w = core ? 0.8 : 0.5;
      const vol = makeVolMat();
      const base = new THREE.Color(core ? "#bff6ff" : PALETTE.cyan);
      const accent = new THREE.Color(core ? "#ffffff" : SYM[fams[k]].color);
      vol.uniforms.uColor.value = base.clone();
      const body = new THREE.Mesh(core ? coreGeo : satGeo, vol);
      const edge = lineMat(base, core ? 0.95 : 0.85);
      const edges = new THREE.LineSegments(core ? coreEdges : satEdges, edge);
      body.raycast = () => {};
      edges.raycast = () => {};
      inner.add(body, edges);
      inner.scale.set(w, 1, w);
      group.add(inner);
      const capMat = meshGlowMat(accent, core ? 0.12 : 0.4);
      const capW = core ? 1.4 : w * 1.25;
      const cap = new THREE.Mesh(capGeo, capMat);
      cap.scale.set(capW, capW, 1);
      cap.rotation.order = "YXZ";
      cap.rotation.set(-Math.PI / 2, inner.rotation.y, 0);
      cap.raycast = () => {}; // filled cap plane is not drawn (draw-call budget); the volume shader already lights the top face
      const capLineMat = lineMat(accent, 1);
      const capLine = new THREE.LineLoop(capLineGeo, capLineMat);
      capLine.scale.set(capW, 1, capW);
      capLine.rotation.y = inner.rotation.y;
      capLine.raycast = () => {};
      group.add(capLine);
      group.userData.capLine = capLine;
      this.root.add(group);
      this.mats.push({ m: edge, base: core ? 0.95 : 0.85 }, { m: capMat, base: core ? 0.12 : 0.4 }, { m: capLineMat, base: 1 });
      this.items.push({
        group, vol, edge, cap, capMat, h: 0.3, target: 0.3, flash: 0,
        flashColor: new THREE.Color("#ffffff"), base, accent, pos: new THREE.Vector3(x, 0, z),
      });
      // store inner for scale updates
      (group.userData as { inner: THREE.Group; w: number }).inner = inner;
      (group.userData as { inner: THREE.Group; w: number }).w = w;
    }
    // floating data crown over the core
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      pts.push(new THREE.Vector3(Math.cos(a) * 1.5, 0, Math.sin(a) * 1.5));
    }
    this.crownMat = lineMat("#bff6ff", 0.7);
    this.crown = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), this.crownMat);
    this.crown.raycast = () => {};
    this.root.add(this.crown);
    this.mats.push({ m: this.crownMat, base: 0.7 });
  }

  setHeights(sat: number[], core: number) {
    for (let k = 0; k < 6; k++) this.items[k].target = sat[k];
    this.items[6].target = core;
  }

  hit(k: number, color: THREE.Color, amount = 1) {
    const it = this.items[k];
    it.flash = Math.min(1, it.flash + amount);
    it.flashColor.copy(color);
  }

  topOf(k: number, out: THREE.Vector3) {
    const it = this.items[k];
    return out.set(it.pos.x, it.h + 0.08, it.pos.z);
  }

  update(dt: number, t: number, fade: number, active: number) {
    const k1 = 1 - Math.exp(-dt * 3.2);
    for (const it of this.items) {
      it.h += (it.target - it.h) * k1;
      it.flash *= Math.exp(-dt * 3.4);
      const f = Math.min(1, it.flash);
      const ud = it.group.userData as { inner: THREE.Group; w: number };
      ud.inner.scale.y = it.h;
      it.cap.position.y = it.h;
      (it.group.userData.capLine as THREE.LineLoop).position.y = it.h;
      ((it.group.userData.capLine as THREE.LineLoop).material as THREE.LineBasicMaterial).color.copy(it.accent).lerp(it.flashColor, f * 0.6).multiplyScalar(1.4 + it.flash * 2);
      const col = it.vol.uniforms.uColor.value as THREE.Color;
      col.copy(it.base).lerp(it.flashColor, f);
      it.edge.color.copy(col).multiplyScalar(0.85 + it.flash * 0.7);
      it.vol.uniforms.uH.value = it.h;
      it.vol.uniforms.uFlash.value = it.flash;
      it.vol.uniforms.uTime.value = t;
      it.vol.uniforms.uAlpha.value = fade;
      it.capMat.color.copy(it.accent).lerp(it.flashColor, f * 0.6).multiplyScalar(1 + it.flash * 1.5);
    }
    const core = this.items[6];
    this.crown.position.set(0, core.h + 0.7 + Math.sin(t * 1.3) * 0.12, 0);
    this.crown.rotation.y = t * (0.4 + active * 1.4);
    this.crown.scale.setScalar(1 + core.flash * 0.25);
    for (const m of this.mats) (m.m as THREE.Material).opacity = m.base * fade;
  }
}
