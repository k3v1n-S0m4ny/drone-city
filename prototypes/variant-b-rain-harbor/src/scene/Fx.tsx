// Per-drone event animations (rings, scan cones, crates, sparks, uplink beams ...). Driven by rt.anim.
// Lives in district-local coordinates so crates stay put when the drone moves.
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide, EdgesGeometry,
  Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, MeshStandardMaterial, OctahedronGeometry, Points,
  PointsMaterial, Quaternion, RingGeometry, SphereGeometry, Vector3, CircleGeometry,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { FAMILIES } from "../symbols";
import type { Anim, DroneRT } from "../sim";

const ringGeo = new RingGeometry(0.93, 1, 56).rotateX(-Math.PI / 2);
const coneGeo = new ConeGeometry(1, 1, 28, 1, true).translate(0, -0.5, 0);
const beamGeo = new CylinderGeometry(0.07, 0.07, 1, 8, 1, true).translate(0, 0.5, 0);
const packetGeo = new OctahedronGeometry(0.2);
const orbGeo = new SphereGeometry(0.1, 10, 8);
const discGeo = new CircleGeometry(1, 36).rotateX(-Math.PI / 2);
const crateGeo = new RoundedBoxGeometry(0.46, 0.4, 0.46, 2, 0.05);
const crateEdges = new EdgesGeometry(crateGeo);

const add = () =>
  new MeshBasicMaterial({
    color: "#fff", transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false, fog: false,
    side: DoubleSide, opacity: 0,
  });
const eo = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
const eio = (x: number) => { x = Math.min(1, Math.max(0, x)); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

interface CrateE {
  mesh: Group;
  mat: MeshStandardMaterial;
  line: LineBasicMaterial;
  t0: number;
  life: number;
  dur: number;
  mode: "off" | "scan" | "place";
  to: Vector3;
  off: Vector3;
}

const SLOTS_DRONE: [number, number][] = [[-2.3, 1.9], [0, 2.6], [2.3, 1.9], [-2.9, -0.3], [2.9, -0.3]];
const SLOTS_CARRIER: [number, number][] = [[-3.4, 3.1], [0, 3.8], [3.4, 3.1], [-4.8, 0.6], [4.8, 0.6]];

const N_SPARK = 40;

export function DroneFx({ rt, k, carrier, under }: { rt: DroneRT; k: number; carrier?: boolean; under?: boolean }) {
  const kk = Math.max(k, 0.8);
  const m = useMemo(() => ({ ring1: add(), ring2: add(), cone: add(), beam: add(), packet: add(), orb: add(), disc: add() }), []);
  const sparkMat = useMemo(
    () => new PointsMaterial({ size: 3.6, sizeAttenuation: false, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false, fog: false, color: "#ffb060" }),
    [],
  );
  const sparkGeo = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(N_SPARK * 3).fill(-999), 3));
    return g;
  }, []);
  const spark = useMemo(() => {
    const v = [];
    for (let i = 0; i < N_SPARK; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 0.8 + Math.random() * 2.2;
      v.push({ vx: Math.cos(a) * s * 0.7, vz: Math.sin(a) * s * 0.7, vy: 1.6 + Math.random() * 3.2, d: Math.random() * 0.55 });
    }
    return v;
  }, []);

  const refs = {
    ring1: useRef<Mesh>(null), ring2: useRef<Mesh>(null), cone: useRef<Mesh>(null), beam: useRef<Mesh>(null),
    packet: useRef<Mesh>(null), disc: useRef<Mesh>(null), sparks: useRef<Points>(null),
  };
  const orbs = useRef<(Mesh | null)[]>([]);
  const crates = useRef<CrateE[]>([]);
  const crateHost = useRef<Group>(null);
  const last = useRef<Anim | null>(null);
  const target = useMemo(() => new Vector3(), []);
  const apex = useMemo(() => new Vector3(), []);
  const q = useMemo(() => new Quaternion(), []);
  const dir = useMemo(() => new Vector3(), []);
  const down = useMemo(() => new Vector3(0, -1, 0), []);
  const carryV = useMemo(() => new Vector3(), []);
  const POOL = 4;

  const slotFor = (seed: number, O: Vector3, out: Vector3) => {
    if (under) return out.set(O.x, 0.16, O.z);
    const list = carrier ? SLOTS_CARRIER : SLOTS_DRONE;
    const [x, z] = list[Math.floor(seed * list.length) % list.length];
    return out.set(O.x * 0 + x, 0.28, z);
  };

  useFrame(() => {
    const now = performance.now();
    const a = rt.anim;
    const O = rt.pos;
    const R = refs;
    if (!crates.current.length && crateHost.current) {
      for (let i = 0; i < POOL; i++) {
        const mat = new MeshStandardMaterial({ color: "#0f1a21", metalness: 0.5, roughness: 0.45, emissive: "#ffd23f", emissiveIntensity: 1.2 });
        const line = new LineBasicMaterial({ color: "#ffe9a0", toneMapped: false, transparent: true });
        const g = new Group();
        g.add(new Mesh(crateGeo, mat));
        g.add(new LineSegments(crateEdges, line));
        g.visible = false;
        crateHost.current.add(g);
        crates.current.push({ mesh: g, mat, line, t0: 0, life: 0, dur: 0, mode: "off", to: new Vector3(), off: new Vector3() });
      }
    }

    // ---- animation start hook -------------------------------------------------------------
    if (a !== last.current) {
      last.current = a;
      if (a) {
        const col = new Color(FAMILIES[a.fam].color);
        for (const mat of [m.ring1, m.ring2, m.cone, m.packet, m.orb, m.disc]) mat.color.copy(col).multiplyScalar(2.3);
        m.beam.color.copy(col).multiplyScalar(1.2);
        sparkMat.color.copy(col).multiplyScalar(2.2);
        if (a.fam === "read" || a.fam === "edit") {
          const c = crates.current.find((e) => e.mode === "off") ?? crates.current.reduce((b, e) => (e.t0 < b.t0 ? e : b), crates.current[0]);
          if (c) {
            slotFor(a.seed, O, c.to);
            c.t0 = now;
            c.dur = a.dur;
            c.mode = a.fam === "read" ? "scan" : "place";
            c.life = a.fam === "read" ? a.dur + 250 : a.dur + 5200;
            c.off.set(0, carrier ? -0.95 : -0.55 * k - 0.1, carrier ? 0.9 : 0);
            c.mat.emissive.copy(col);
            c.line.color.copy(col).multiplyScalar(2.2);
            c.mesh.visible = true;
          }
        }
      }
    }

    // ---- active animation -----------------------------------------------------------------
    const p = a ? (now - a.t0) / a.dur : 2;
    const on = !!a && p < 1;
    for (const key of ["ring1", "ring2", "cone", "beam", "packet", "disc"] as const) {
      const o = R[key].current;
      if (o) o.visible = false;
    }
    if (R.sparks.current) R.sparks.current.visible = false;
    orbs.current.forEach((o) => o && (o.visible = false));

    if (on && a) {
      const r1 = R.ring1.current!, r2 = R.ring2.current!, cone = R.cone.current!, beam = R.beam.current!;
      const pk = R.packet.current!, disc = R.disc.current!;
      const show = (o: Mesh, mat: MeshBasicMaterial, op: number) => { o.visible = op > 0.01; mat.opacity = op; };
      switch (a.fam) {
        case "prompt": {
          if (p < 0.6) {
            const u = eo(p / 0.55);
            pk.position.set(O.x, O.y + 0.3 * k + (1 - u) * 6 * k, O.z);
            pk.rotation.y = p * 12;
            pk.scale.setScalar(k * (1.1 - 0.5 * u));
            show(pk, m.packet, 1);
            beam.position.set(O.x, O.y + 0.35 * k, O.z);
            beam.scale.set(k, 6 * k * (1 - u * 0.2), k);
            show(beam, m.beam, (1 - p / 0.6) * 0.55);
          }
          if (p > 0.45) {
            const u = (p - 0.45) / 0.55;
            r1.position.set(O.x, O.y - 0.3 * k, O.z);
            r1.scale.setScalar(k * (0.4 + 2 * u));
            show(r1, m.ring1, (1 - u) * 0.9);
          }
          break;
        }
        case "api": {
          r1.position.set(O.x, O.y - 0.25 * k, O.z);
          r1.scale.setScalar(k * (0.5 + 2.2 * p));
          show(r1, m.ring1, (1 - p) * 0.9);
          const u2 = clamp01((p - 0.25) / 0.75);
          if (p > 0.25) {
            r2.position.copy(r1.position);
            r2.scale.setScalar(k * (0.5 + 2.2 * u2));
            show(r2, m.ring2, (1 - u2) * 0.7);
          }
          break;
        }
        case "response": {
          r1.position.set(O.x, O.y + (0.1 + p * 2.6) * k, O.z);
          r1.scale.setScalar(k * (1.3 - 0.7 * p));
          show(r1, m.ring1, (1 - p) * 0.95);
          if (p > 0.3) {
            const u = (p - 0.3) / 0.7;
            r2.position.set(O.x, O.y + (0.1 + u * 2.6) * k, O.z);
            r2.scale.setScalar(k * (1.3 - 0.7 * u));
            show(r2, m.ring2, (1 - u) * 0.7);
          }
          break;
        }
        case "read": {
          const T = slotFor(a.seed, O, target);
          apex.set(O.x, O.y - (carrier ? 0.75 : 0.4 * k), O.z + (carrier ? 0.9 : 0));
          dir.subVectors(T, apex);
          const L = dir.length();
          dir.normalize();
          q.setFromUnitVectors(down, dir);
          cone.position.copy(apex);
          cone.quaternion.copy(q);
          cone.scale.set(0.62 * kk, L, 0.62 * kk);
          show(cone, m.cone, 0.2 + 0.1 * Math.sin(p * 46) + 0.1 * Math.sin(p * Math.PI));
          r1.position.set(T.x, 0.2, T.z);
          r1.scale.set(0.35 * kk + 0.45 * kk * Math.abs(Math.sin(p * Math.PI * 2.2)), 1, 0.35 * kk + 0.45 * kk * Math.abs(Math.sin(p * Math.PI * 2.2)));
          show(r1, m.ring1, 0.9 * Math.sin(p * Math.PI));
          break;
        }
        case "edit": {
          if (p > 0.78) {
            const u = (p - 0.78) / 0.22;
            const T = slotFor(a.seed, O, target);
            r1.position.set(T.x, 0.2, T.z);
            r1.scale.setScalar(kk * (0.4 + 1.7 * u));
            show(r1, m.ring1, (1 - u) * 0.95);
          }
          break;
        }
        case "bash": {
          const T = slotFor(a.seed, O, target);
          disc.position.set(T.x, 0.15, T.z);
          disc.scale.setScalar(0.9 * kk);
          show(disc, m.disc, 0.38 * Math.abs(Math.sin(p * 55)) * (1 - p));
          const sp = R.sparks.current!;
          sp.visible = true;
          const arr = sparkGeo.getAttribute("position") as BufferAttribute;
          const t = p * a.dur / 1000;
          for (let i = 0; i < N_SPARK; i++) {
            const s = spark[i];
            const tt = t - s.d * 0.4;
            const y = T.y + s.vy * tt - 5.5 * tt * tt;
            if (tt < 0 || y < T.y - 0.02) arr.setXYZ(i, 0, -999, 0);
            else arr.setXYZ(i, T.x + s.vx * tt * kk, y, T.z + s.vz * tt * kk);
          }
          arr.needsUpdate = true;
          break;
        }
        case "web": {
          const H = 12;
          const u = eo(p / 0.4);
          beam.position.set(O.x, O.y + 0.25 * k, O.z);
          beam.scale.set(0.8 * k, H * u, 0.8 * k);
          show(beam, m.beam, 0.2 * (1 - clamp01((p - 0.55) / 0.45)));
          pk.position.set(O.x, O.y + 0.4 * k + eo(p) * H, O.z);
          pk.scale.setScalar(k * 1.2);
          pk.rotation.y = p * 14;
          show(pk, m.packet, 1 - clamp01((p - 0.8) / 0.2));
          if (p > 0.3) {
            const v = (p - 0.3) / 0.7;
            r1.position.set(O.x, O.y + H, O.z);
            r1.scale.setScalar(k * (0.4 + 2.2 * v));
            show(r1, m.ring1, (1 - v) * 0.85);
          }
          break;
        }
        case "agent": {
          r1.position.set(O.x, O.y - 0.1 * k, O.z);
          r1.scale.setScalar(k * (0.5 + 1.8 * p));
          show(r1, m.ring1, (1 - p) * 0.95);
          const u2 = clamp01((p - 0.25) / 0.75);
          if (p > 0.25) {
            r2.position.set(O.x, O.y + 0.2 * k, O.z);
            r2.scale.setScalar(k * (0.4 + 2.6 * u2));
            show(r2, m.ring2, (1 - u2) * 0.8);
          }
          break;
        }
        case "mcp": {
          const Rr = 1.15 * kk * (carrier ? 1.6 : 1);
          for (let i = 0; i < 3; i++) {
            const o = orbs.current[i];
            if (!o) continue;
            const ang = p * Math.PI * 3.2 + i * 2.094;
            o.visible = true;
            o.position.set(O.x + Math.cos(ang) * Rr, O.y + Math.sin(ang * 0.5 + i) * 0.25 * k, O.z + Math.sin(ang) * Rr);
            o.scale.setScalar(kk * 1.3 * (1 - clamp01((p - 0.8) / 0.2)));
          }
          r1.position.set(O.x, O.y, O.z);
          r1.scale.setScalar(Rr);
          show(r1, m.ring1, 0.4 * Math.sin(p * Math.PI));
          break;
        }
        case "other": {
          r1.position.set(O.x, O.y - 0.1 * k, O.z);
          r1.scale.setScalar(k * (0.3 + 0.9 * p));
          show(r1, m.ring1, (1 - p) * 0.6);
          break;
        }
        case "error": {
          disc.position.set(O.x, 0.15, O.z);
          disc.scale.setScalar(3 * kk);
          show(disc, m.disc, (Math.sin(p * 78) > 0 ? 0.42 : 0.1) * (1 - p));
          r1.position.set(O.x, O.y - 0.2 * k, O.z);
          r1.scale.setScalar(k * (0.4 + 3 * p));
          show(r1, m.ring1, (1 - p) * 0.95);
          const sp = R.sparks.current!;
          sp.visible = true;
          const arr = sparkGeo.getAttribute("position") as BufferAttribute;
          const t = p * a.dur / 1000;
          for (let i = 0; i < N_SPARK; i++) {
            const s = spark[i];
            const tt = t - s.d * 0.25;
            const y = O.y - 0.3 * k + s.vy * 0.5 * tt - 5.5 * tt * tt;
            if (tt < 0 || y < 0.1) arr.setXYZ(i, 0, -999, 0);
            else arr.setXYZ(i, O.x + s.vx * tt * kk, y, O.z + s.vz * tt * kk);
          }
          arr.needsUpdate = true;
          break;
        }
        case "compact": {
          const fade = 1 - clamp01((p - 0.85) / 0.15);
          r1.position.set(O.x, O.y, O.z);
          r1.scale.setScalar(k * (3.4 - 3 * eo(p)));
          show(r1, m.ring1, (0.3 + 0.7 * p) * fade);
          if (p > 0.2) {
            const u = (p - 0.2) / 0.8;
            r2.position.set(O.x, O.y + 0.3 * k, O.z);
            r2.scale.setScalar(k * (3.4 - 3 * eo(u)));
            show(r2, m.ring2, (0.3 + 0.7 * u) * fade);
          }
          break;
        }
        case "spawn": {
          const sin = Math.sin(p * Math.PI);
          if (carrier) {
            cone.position.set(O.x, O.y - 0.62, O.z);
            cone.quaternion.identity();
            cone.scale.set(1.7, O.y - 0.62 - 0.1, 1.7);
            show(cone, m.cone, sin * 0.3);
          }
          r1.position.set(O.x, O.y - (carrier ? 0.62 : 0.3 * k), O.z);
          r1.scale.setScalar(k * (0.5 + 1.1 * p) * (carrier ? 0.9 : 1));
          show(r1, m.ring1, (1 - p) * 0.9);
          break;
        }
        case "done": {
          r1.position.set(O.x, O.y - (carrier ? 0.62 : 0.3 * k), O.z);
          r1.scale.setScalar(k * (2.0 - 1.6 * eo(p)) * (carrier ? 0.9 : 1));
          show(r1, m.ring1, 0.2 + 0.8 * p * (1 - clamp01((p - 0.85) / 0.15)));
          break;
        }
      }
    }

    // ---- crates (outlive the animation that created them) ---------------------------------
    for (const c of crates.current) {
      if (c.mode === "off") continue;
      const age = now - c.t0;
      if (age > c.life) { c.mode = "off"; c.mesh.visible = false; continue; }
      const left = c.life - age;
      const fade = clamp01(left / 700);
      if (c.mode === "scan") {
        c.mesh.position.copy(c.to);
        c.mesh.position.y += 0.2;
        c.mesh.scale.setScalar(clamp01(age / 160) * fade * kk * 0.95);
        c.mat.emissiveIntensity = 1.2 + 1.8 * Math.abs(Math.sin(age / 90));
        c.line.opacity = 1;
      } else {
        const u = age / c.dur;
        const carry = carryV.set(O.x + c.off.x, O.y + c.off.y, O.z + c.off.z);
        if (u < 0.42) c.mesh.position.copy(carry);
        else if (u < 0.8) {
          const s = eio((u - 0.42) / 0.38);
          c.mesh.position.lerpVectors(carry, target.copy(c.to).setY(c.to.y + 0.2), s);
        } else c.mesh.position.copy(c.to).setY(c.to.y + 0.2 + Math.max(0, 0.12 * Math.sin((u - 0.8) * 30) * (1 - (u - 0.8) * 5)));
        c.mesh.scale.setScalar(clamp01(age / 120) * fade * kk * 0.95);
        c.mat.emissiveIntensity = u < 0.8 ? 1.5 : 3.2 * Math.exp(-(u - 0.8) * 5) + 0.6;
        c.line.opacity = 0.35 + 0.65 * fade;
      }
    }
  });

  return (
    <group>
      <mesh ref={refs.ring1} geometry={ringGeo} material={m.ring1} visible={false} frustumCulled={false} />
      <mesh ref={refs.ring2} geometry={ringGeo} material={m.ring2} visible={false} frustumCulled={false} />
      <mesh ref={refs.cone} geometry={coneGeo} material={m.cone} visible={false} frustumCulled={false} />
      <mesh ref={refs.beam} geometry={beamGeo} material={m.beam} visible={false} frustumCulled={false} />
      <mesh ref={refs.packet} geometry={packetGeo} material={m.packet} visible={false} frustumCulled={false} />
      <mesh ref={refs.disc} geometry={discGeo} material={m.disc} visible={false} frustumCulled={false} />
      {[0, 1, 2].map((i) => (
        <mesh key={i} ref={(o) => { orbs.current[i] = o; }} geometry={orbGeo} material={m.orb} visible={false} frustumCulled={false} />
      ))}
      <points ref={refs.sparks} geometry={sparkGeo} material={sparkMat} visible={false} frustumCulled={false} />
      <group ref={crateHost} />
    </group>
  );
}
