import * as THREE from "three";
import { CFG } from "./config";
import { lineMat, meshGlowMat } from "./glow";
import { Ribbon } from "./ribbon";
import type { DroneObj } from "./droneObj";

const tetGeo = new THREE.TetrahedronGeometry(0.36, 0);
const tetEdges = new THREE.EdgesGeometry(tetGeo);
const easeInOut = (p: number) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);

type St = "free" | "launch" | "out" | "dock";
interface Slot {
  group: THREE.Group;
  body: THREE.Group;
  glow: THREE.MeshBasicMaterial;
  edge: THREE.LineBasicMaterial;
  trail: Ribbon;
  id: string | null;
  st: St;
  t0: number;
  idx: number;
  port: number;
  ping: number;
  from: THREE.Vector3;
  pos: THREE.Vector3;
}

/** Small tetrahedron child drones: eject from the carrier ring (or the drone), orbit, dock back. */
export class Subagents {
  root = new THREE.Group();
  private slots: Slot[] = [];
  /** 0..1 flash of the carrier ring on launch / dock */
  ringFlash = 0;
  flashPort = 0;
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();

  constructor(cap: number, color: THREE.ColorRepresentation) {
    for (let i = 0; i < cap; i++) {
      const group = new THREE.Group();
      const body = new THREE.Group();
      const glow = meshGlowMat(color, 0.4);
      const edge = lineMat("#eafcff", 1);
      body.add(new THREE.Mesh(tetGeo, glow), new THREE.LineSegments(tetEdges, edge));
      const hot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), meshGlowMat("#ffffff", 1));
      (hot.material as THREE.MeshBasicMaterial).color.setScalar(3);
      body.add(hot);
      group.add(body);
      const trail = new Ribbon(22, color);
      group.visible = false;
      trail.mesh.visible = false;
      group.traverse((o) => (o.raycast = () => {}));
      this.root.add(group, trail.mesh);
      this.slots.push({
        group, body, glow, edge, trail, id: null, st: "free", t0: 0, idx: i, port: 0, ping: 0,
        from: new THREE.Vector3(), pos: new THREE.Vector3(),
      });
    }
  }

  has(id: string) {
    return this.slots.some((s) => s.id === id && s.st !== "free");
  }
  runningIds() {
    return this.slots.filter((s) => s.st === "launch" || s.st === "out").map((s) => s.id!);
  }
  get runningCount() {
    return this.slots.filter((s) => s.st === "launch" || s.st === "out").length;
  }

  spawn(id: string, now: number, instant = false) {
    if (this.has(id)) return;
    let s = this.slots.find((x) => x.st === "free");
    if (!s) s = this.slots.find((x) => x.st === "out"); // recycle the oldest orbiting one
    if (!s) return;
    s.id = id;
    s.st = instant ? "out" : "launch";
    s.t0 = now - (instant ? 1e6 : 0);
    s.port = (s.idx * 5 + Math.floor(Math.random() * 12)) % 12;
    s.group.visible = true;
    s.trail.mesh.visible = true;
    s.ping = 0;
    this.ringFlash = 1;
    this.flashPort = s.port;
    s.pos.set(0, 0, 0);
    s.trail.reset(s.pos);
  }

  dock(id: string | null, now: number) {
    let s = this.slots.find((x) => x.id === id && (x.st === "out" || x.st === "launch"));
    if (!s && id === null) s = this.slots.find((x) => x.st === "out");
    if (!s) return;
    s.st = "dock";
    s.t0 = now;
    s.from.copy(s.pos);
  }

  /** world-ish position of a child (for pulses starting at it) */
  posOf(id: string | null, out: THREE.Vector3): boolean {
    const s = this.slots.find((x) => x.id === id && x.st !== "free");
    if (!s) return false;
    out.copy(s.pos);
    return true;
  }
  poke(id: string | null) {
    const s = this.slots.find((x) => x.id === id && x.st !== "free");
    if (s) s.ping = 1;
  }

  private orbit(s: Slot, t: number, hover: number, carrier: boolean, out: THREE.Vector3, home: THREE.Vector3) {
    const dir = s.idx % 2 ? -1 : 1;
    const ro = carrier ? 3.15 + (s.idx % 3) * 0.42 : 1.7 + (s.idx % 2) * 0.35;
    const a = s.idx * 2.399 + t * 0.22 * dir;
    return out.set(home.x + Math.cos(a) * ro, hover + Math.sin(t * 0.9 + s.idx * 1.7) * 0.35 + ((s.idx % 3) - 1) * 0.4, home.z + Math.sin(a) * ro);
  }

  update(dt: number, t: number, now: number, hover: number, drone: DroneObj, fade: number, home: THREE.Vector3) {
    const carrier = drone.carrier;
    this.ringFlash *= Math.exp(-dt * 2.4);
    for (const s of this.slots) {
      if (s.st === "free") continue;
      let scale = 1;
      if (s.st === "launch" || s.st === "dock") {
        const dur = s.st === "launch" ? CFG.SUBAGENT_LAUNCH_MS : CFG.SUBAGENT_DOCK_MS;
        const p = Math.min(1, (now - s.t0) / dur);
        const portP = carrier ? drone.portPos(s.port, this.tmpA) : this.tmpA.set(0, 0, 0);
        portP.y = 0;
        portP.add(home);
        if (s.st === "launch") {
          const e = easeOut(p);
          this.orbit(s, t, hover, carrier, this.tmpB, home);
          s.pos.lerpVectors(portP, this.tmpB, e);
          s.pos.y += Math.sin(p * Math.PI) * 1.1;
          scale = 0.25 + 0.75 * easeOut(Math.min(1, p * 1.6));
          if (p >= 1) s.st = "out";
        } else {
          const e = easeInOut(p);
          s.pos.lerpVectors(s.from, portP, e);
          s.pos.y += Math.sin(p * Math.PI) * 0.9;
          scale = 1 - 0.75 * e;
          if (p >= 1) {
            s.st = "free";
            s.id = null;
            s.group.visible = false;
            s.trail.mesh.visible = false;
            this.ringFlash = 1;
            this.flashPort = s.port;
            continue;
          }
        }
      } else {
        this.orbit(s, t, hover, carrier, this.tmpB, home);
        s.pos.lerp(this.tmpB, 1 - Math.exp(-dt * 4));
      }
      s.ping *= Math.exp(-dt * 4);
      s.group.position.copy(s.pos);
      s.body.rotation.y += dt * 1.8;
      s.body.rotation.x = Math.sin(t * 1.3 + s.idx) * 0.4;
      s.body.scale.setScalar(scale * (1 + s.ping * 0.7));
      s.glow.opacity = (0.35 + s.ping * 0.5) * fade;
      s.edge.opacity = fade;
      s.edge.color.set("#eafcff").multiplyScalar(1 + s.ping * 2);
      s.trail.push(s.pos);
      s.trail.intensity = fade * (s.st === "out" ? 0.55 : 1);
      s.trail.update(0.07 * scale);
    }
  }
}
