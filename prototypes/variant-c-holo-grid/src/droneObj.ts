import * as THREE from "three";
import { lineMat, meshGlowMat } from "./glow";
import { machineColor } from "./config";

const octGeo = new THREE.OctahedronGeometry(0.36, 0);
const octEdges = new THREE.EdgesGeometry(octGeo);
const beadGeo = new THREE.OctahedronGeometry(0.075, 0);
const ringTorus = (r: number, tube = 0.022) => new THREE.TorusGeometry(r, tube, 6, 72);

export interface FadeMat {
  m: THREE.Material;
  base: number;
}

/**
 * Drone: diamond (octahedron) core + two orbiting rings. Ring colour = machine.
 * Carrier (conductor): the same core inside a large slow-rotating ring-station
 * with 12 docking ports.
 */
export class DroneObj {
  root = new THREE.Group();
  core = new THREE.Group();
  ringA: THREE.Group;
  ringB: THREE.Group;
  station: THREE.Group | null = null;
  stationArcs: THREE.Group | null = null;
  fades: FadeMat[] = [];
  glow: THREE.MeshBasicMaterial;
  coreEdge: THREE.LineBasicMaterial;
  ringMats: THREE.MeshBasicMaterial[] = [];
  stationMats: THREE.MeshBasicMaterial[] = [];
  hit: THREE.Mesh;
  readonly carrier: boolean;
  readonly color: THREE.Color;
  readonly ringR = 2.35;
  readonly ports = 12;
  portMats: THREE.LineBasicMaterial[] = [];

  constructor(machine: string, carrier: boolean) {
    this.carrier = carrier;
    this.color = new THREE.Color(machineColor(machine));
    const scale = carrier ? 1.35 : 1;

    // core: translucent octahedron + bright edges + hot centre
    this.glow = meshGlowMat(this.color, 0.2);
    const solid = new THREE.Mesh(octGeo, this.glow);
    this.coreEdge = lineMat("#eafcff", 1);
    const edges = new THREE.LineSegments(octEdges, this.coreEdge);
    const hot = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8), meshGlowMat("#ffffff", 1));
    (hot.material as THREE.MeshBasicMaterial).color.setScalar(1.8);
    this.core.add(solid, edges, hot);
    this.core.scale.setScalar(scale);
    this.fades.push({ m: this.glow, base: 0.2 }, { m: this.coreEdge, base: 1 }, { m: hot.material, base: 1 });

    // orbiting rings
    const mkRing = (r: number, tiltX: number, tiltZ: number) => {
      const g = new THREE.Group();
      const mat = meshGlowMat(this.color, 0.95);
      mat.color.multiplyScalar(1.7);
      this.ringMats.push(mat);
      this.fades.push({ m: mat, base: 0.95 });
      const torus = new THREE.Mesh(ringTorus(r), mat);
      const bead = new THREE.Mesh(beadGeo, meshGlowMat("#ffffff", 1));
      (bead.material as THREE.MeshBasicMaterial).color.setScalar(2.5);
      this.fades.push({ m: bead.material, base: 1 });
      bead.position.set(r, 0, 0);
      torus.rotation.x = Math.PI / 2;
      g.add(torus, bead);
      const outer = new THREE.Group();
      outer.rotation.set(tiltX, 0, tiltZ);
      outer.add(g);
      outer.userData.spin = g;
      this.root.add(outer);
      return outer;
    };
    this.ringA = mkRing(0.72 * scale, 0.5, 0.2);
    this.ringB = mkRing(0.56 * scale, -0.9, -0.4);
    this.root.add(this.core);

    if (carrier) this.buildStation();

    this.hit = new THREE.Mesh(
      new THREE.SphereGeometry(carrier ? 2.6 : 1.3, 10, 8),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    this.root.add(this.hit);
    this.root.traverse((o) => {
      if (o !== this.hit) o.raycast = () => {};
    });
  }

  private buildStation() {
    const R = this.ringR;
    const st = new THREE.Group();
    // main ring
    const mat = meshGlowMat(this.color, 0.95);
    mat.color.multiplyScalar(1.5);
    const main = new THREE.Mesh(new THREE.TorusGeometry(R, 0.07, 8, 128), mat);
    main.rotation.x = Math.PI / 2;
    // outer fine ring
    const mat2 = meshGlowMat(this.color, 0.55);
    const outer = new THREE.Mesh(new THREE.TorusGeometry(R + 0.42, 0.016, 6, 128), mat2);
    outer.rotation.x = Math.PI / 2;
    // deck: translucent annulus
    const deckMat = meshGlowMat(this.color, 0.07);
    const deck = new THREE.Mesh(new THREE.RingGeometry(R - 0.5, R, 128, 1).rotateX(-Math.PI / 2), deckMat);
    this.stationMats.push(mat, mat2, deckMat);
    this.fades.push({ m: mat, base: 0.95 }, { m: mat2, base: 0.55 }, { m: deckMat, base: 0.07 });
    st.add(main, outer, deck);
    // spokes + ticks
    const sp: number[] = [];
    for (let i = 0; i < this.ports; i++) {
      const a = (i / this.ports) * Math.PI * 2;
      sp.push(Math.cos(a) * 1.15, 0, Math.sin(a) * 1.15, Math.cos(a) * (R - 0.05), 0, Math.sin(a) * (R - 0.05));
    }
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const l = i % 6 === 0 ? 0.28 : 0.12;
      sp.push(Math.cos(a) * (R + 0.42), 0, Math.sin(a) * (R + 0.42), Math.cos(a) * (R + 0.42 + l), 0, Math.sin(a) * (R + 0.42 + l));
    }
    const spGeo = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(sp, 3));
    const spMat = lineMat(this.color, 0.55);
    this.fades.push({ m: spMat, base: 0.55 });
    st.add(new THREE.LineSegments(spGeo, spMat));
    // docking ports: little glowing brackets
    const boxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(0.34, 0.16, 0.2));
    for (let i = 0; i < this.ports; i++) {
      const a = (i / this.ports) * Math.PI * 2;
      const pm = lineMat("#eafcff", 0.9);
      this.portMats.push(pm);
      this.fades.push({ m: pm, base: 0.9 });
      const port = new THREE.LineSegments(boxEdges, pm);
      port.position.set(Math.cos(a) * R, 0, Math.sin(a) * R);
      port.rotation.y = -a;
      st.add(port);
    }
    this.station = st;
    this.root.add(st);
    // counter-rotating partial arcs inside
    const arcs = new THREE.Group();
    const amat = meshGlowMat(this.color, 0.6);
    amat.color.multiplyScalar(1.3);
    this.fades.push({ m: amat, base: 0.6 });
    for (let i = 0; i < 3; i++) {
      const arc = new THREE.Mesh(new THREE.TorusGeometry(1.55, 0.025, 6, 48, Math.PI * 0.45), amat);
      arc.rotation.x = Math.PI / 2;
      arc.rotation.z = (i / 3) * Math.PI * 2;
      arcs.add(arc);
    }
    this.stationArcs = arcs;
    this.root.add(arcs);
  }

  setFade(f: number) {
    for (const x of this.fades) x.m.opacity = x.base * f;
  }

  /** port world... local position for index i at the current station rotation */
  portPos(i: number, out: THREE.Vector3): THREE.Vector3 {
    if (!this.station) return out.set(0, 0, 0);
    const a = (i / this.ports) * Math.PI * 2 + this.station.rotation.y * -1;
    return out.set(Math.cos(a) * this.ringR, 0, Math.sin(a) * this.ringR);
  }
}
