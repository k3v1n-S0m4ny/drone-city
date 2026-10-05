import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Points,
  PointsMaterial,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from "three";
import type { MutableRefObject } from "react";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { machineColor } from "./config";
import { DOCK_MS, LAUNCH_MS, PADS, type ChildRT, type DroneRT } from "./runtime";
import { useStore } from "./store";
import { SYMBOLS } from "./symbols";
import type { Session } from "./types";

// ---------------------------------------------------------------- shared assets
const sphere = new SphereGeometry(1, 28, 18);
const torus = new TorusGeometry(1, 0.045, 8, 48);
const torusFine = new TorusGeometry(1, 0.025, 6, 40);
const hexTorus = new TorusGeometry(1, 0.05, 4, 6);
const cyl = new CylinderGeometry(1, 1, 1, 8, 1, true);
const disc = new CircleGeometry(1, 28);
const hullMat = new MeshStandardMaterial({ color: "#1b1c33", metalness: 0.75, roughness: 0.32 });
const hullMat2 = new MeshStandardMaterial({ color: "#0d0e1d", metalness: 0.6, roughness: 0.5 });
const bladeMat = new MeshBasicMaterial({ color: "#8e95c8", transparent: true, opacity: 0.55, side: DoubleSide, depthWrite: false });
const discMat = new MeshBasicMaterial({ color: "#aab4ff", transparent: true, opacity: 0.1, side: DoubleSide, depthWrite: false, blending: AdditiveBlending });
const selMat = new MeshBasicMaterial({ color: new Color("#ffffff").multiplyScalar(2.5), toneMapped: false });
const hitMat = new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });

const trimCache = new Map<string, MeshBasicMaterial>();
function trimMat(hex: string) {
  let m = trimCache.get(hex);
  if (!m) {
    m = new MeshBasicMaterial({ color: new Color(hex).multiplyScalar(2.4), toneMapped: false });
    trimCache.set(hex, m);
  }
  return m;
}

const V = new Vector3();
const V2 = new Vector3();
const Q = new Quaternion();
const UP = new Vector3(0, 1, 0);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const easeOut = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t);

// ---------------------------------------------------------------- visual models
// Static hull parts are merged into two geometries (dark body + machine-coloured
// trim) built once, so a drone costs ~10 draw calls instead of ~35.
const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
function xf(g: BufferGeometry, p: [number, number, number], r: [number, number, number] = [0, 0, 0], s: [number, number, number] | number = 1) {
  const sc = typeof s === "number" ? ([s, s, s] as const) : s;
  _m.compose(new Vector3(...p), _q.setFromEuler(_e.set(...r)), new Vector3(...sc));
  return g.clone().applyMatrix4(_m);
}
const box = (w: number, h: number, d: number) => new BoxGeometry(w, h, d);
const merge = (list: BufferGeometry[]) => mergeGeometries(list, false)!;

const SMALL_ARMS: [number, number][] = [
  [0.62, 0.5],
  [-0.62, 0.5],
  [0.62, -0.5],
  [-0.62, -0.5],
];
const smallDark = merge([
  xf(sphere, [0, 0, 0], [0, 0, 0], [0.62, 0.17, 0.44]),
  xf(sphere, [0.18, 0.1, 0], [0, 0, 0], [0.26, 0.12, 0.2]),
  ...SMALL_ARMS.map(([x, z]) => xf(sphere, [x / 2, 0.02, z / 2], [0, -Math.atan2(z, x), 0], [Math.hypot(x, z) / 2, 0.03, 0.04])),
  xf(cyl, [-0.3, 0.3, 0], [0, 0, 0], [0.012, 0.22, 0.012]),
]);
const smallTrim = merge([
  xf(torusFine, [0, 0, 0], [Math.PI / 2, 0, 0], [0.64, 0.46, 1]),
  xf(sphere, [0.52, 0.03, 0], [0, 0, 0], [0.07, 0.05, 0.12]),
  ...SMALL_ARMS.map(([x, z]) => xf(sphere, [x, 0.03, z], [0, 0, 0], [0.06, 0.07, 0.06])),
  xf(sphere, [-0.3, 0.46, 0.09], [0, 0, 0], [0.01, 0.07, 0.1]),
]);

export function padLocal(i: number): [number, number, number] {
  const col = i % 4;
  const row = Math.floor(i / 4);
  return [(col - 1.5) * 0.78 + 0.25, 0.3, (row - 0.5) * 0.62];
}
const CARRIER_ROT: [number, number][] = [
  [-1.45, 1.0],
  [0, 1.1],
  [1.45, 1.0],
  [-1.45, -1.0],
  [0, -1.1],
  [1.45, -1.0],
];
const carrierDark = merge([
  xf(sphere, [0, 0, 0], [0, 0, 0], [1.95, 0.2, 0.88]),
  xf(box(3.5, 0.14, 1.52), [0, 0.2, 0]),
  xf(box(3.7, 0.2, 1.0), [0, 0, 0]),
  xf(sphere, [-1.35, 0.42, 0], [0, 0, 0], [0.34, 0.2, 0.34]),
  xf(cyl, [-1.35, 0.56, 0], [0, 0, 0], [0.012, 0.3, 0.012]),
  ...Array.from({ length: PADS }, (_, i) => {
    const p = padLocal(i);
    return xf(disc, [p[0], p[1], p[2]], [-Math.PI / 2, 0, 0], 0.27);
  }),
  ...CARRIER_ROT.map(([x, z]) => xf(sphere, [x, 0.12, z * 0.55], [0, 0, 0], [0.04, 0.04, Math.abs(z) * 0.5])),
]);
const carrierTrim = merge([
  xf(box(3.52, 0.05, 0.05), [0, 0.2, 0.77]),
  xf(box(3.52, 0.05, 0.05), [0, 0.2, -0.77]),
  xf(box(0.05, 0.05, 1.5), [1.76, 0.2, 0]),
  xf(box(0.05, 0.05, 1.5), [-1.76, 0.2, 0]),
  xf(box(0.012, 0.1, 0.22), [-1.35, 0.78, 0.13]),
  ...Array.from({ length: PADS }, (_, i) => {
    const p = padLocal(i);
    return xf(torusFine, [p[0], p[1] + 0.005, p[2]], [Math.PI / 2, 0, 0], 0.27);
  }),
  ...CARRIER_ROT.map(([x, z]) => xf(sphere, [x, 0.12, z], [0, 0, 0], [0.1, 0.09, 0.1])),
]);
const padDarkMat = new MeshBasicMaterial({ color: "#05050f" });

// One textured, additive disc per rotor (blade streaks baked into the texture).
let rotorTex: CanvasTexture | null = null;
function getRotorTex() {
  if (rotorTex) return rotorTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const gr = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  gr.addColorStop(0, "rgba(190,200,255,0.05)");
  gr.addColorStop(0.85, "rgba(190,200,255,0.16)");
  gr.addColorStop(1, "rgba(190,200,255,0.5)");
  g.fillStyle = gr;
  g.beginPath();
  g.arc(64, 64, 62, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "rgba(230,235,255,0.85)";
  g.fillRect(4, 61, 120, 6);
  g.fillStyle = "rgba(230,235,255,0.35)";
  g.fillRect(61, 4, 6, 120);
  rotorTex = new CanvasTexture(c);
  return rotorTex;
}
const rotorMat = new MeshBasicMaterial({
  map: null,
  transparent: true,
  depthWrite: false,
  blending: AdditiveBlending,
  side: DoubleSide,
  toneMapped: false,
});
function Rotor({ r, refs, i }: { r: number; refs: MutableRefObject<Object3D[]>; i: number }) {
  rotorMat.map ??= getRotorTex();
  return (
    <mesh ref={(o) => void (o && (refs.current[i] = o))} rotation={[-Math.PI / 2, 0, 0]} scale={r} geometry={disc} material={rotorMat} />
  );
}

function SmallHull({ trim, rotors }: { trim: string; rotors: MutableRefObject<Object3D[]> }) {
  const t = trimMat(trim);
  return (
    <group>
      <mesh geometry={smallDark} material={hullMat} />
      <mesh geometry={smallTrim} material={t} />
      {SMALL_ARMS.map(([x, z], i) => (
        <group key={i} position={[x, 0.1, z]}>
          <Rotor r={0.34} refs={rotors} i={i} />
        </group>
      ))}
    </group>
  );
}

function Carrier({ trim, rotors }: { trim: string; rotors: MutableRefObject<Object3D[]> }) {
  const t = trimMat(trim);
  return (
    <group>
      <mesh geometry={carrierDark} material={hullMat} />
      <mesh geometry={carrierTrim} material={t} />
      {CARRIER_ROT.map(([x, z], i) => (
        <group key={i} position={[x, 0.22, z]}>
          <Rotor r={0.62} refs={rotors} i={i} />
        </group>
      ))}
    </group>
  );
}
void padDarkMat;
void hullMat2;

// ---------------------------------------------------------------- effects
interface Fx {
  beam: Mesh;
  ring1: Mesh;
  ring2: Mesh;
  hex: Mesh;
  sparks: Points;
  mats: MeshBasicMaterial[];
  sparkMat: PointsMaterial;
}
function makeFx(): Fx {
  const mk = () =>
    new MeshBasicMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false, side: DoubleSide });
  const mats = [mk(), mk(), mk(), mk()];
  const beam = new Mesh(cyl, mats[0]);
  const ring1 = new Mesh(torus, mats[1]);
  const ring2 = new Mesh(torus, mats[2]);
  const hex = new Mesh(hexTorus, mats[3]);
  for (const m of [ring1, ring2, hex]) m.rotation.x = Math.PI / 2;
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(14 * 3), 3));
  const sparkMat = new PointsMaterial({ size: 5, sizeAttenuation: false, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false });
  const sparks = new Points(g, sparkMat);
  sparks.frustumCulled = false;
  for (const o of [beam, ring1, ring2, hex, sparks]) {
    o.visible = false;
    o.frustumCulled = false;
  }
  return { beam, ring1, ring2, hex, sparks, mats, sparkMat };
}

function setBeam(fx: Fx, a: Vector3, b: Vector3, radius: number, color: Color, opacity: number) {
  const m = fx.beam;
  m.visible = opacity > 0.01;
  V.copy(b).sub(a);
  const len = V.length();
  if (len < 0.001) return (m.visible = false);
  m.position.copy(a).addScaledVector(V, 0.5);
  Q.setFromUnitVectors(UP, V.multiplyScalar(1 / len));
  m.quaternion.copy(Q);
  m.scale.set(radius, len, radius);
  fx.mats[0].color.copy(color);
  fx.mats[0].opacity = opacity;
}
function setRing(m: Mesh, mat: MeshBasicMaterial, pos: Vector3, scale: number, color: Color, opacity: number, y?: number) {
  m.visible = opacity > 0.01 && scale > 0.01;
  m.position.set(pos.x, y ?? pos.y, pos.z);
  m.scale.setScalar(scale);
  mat.color.copy(color);
  mat.opacity = opacity;
}

const tcol = new Color();
const hdr = (hex: string, k = 2.2) => tcol.set(hex).multiplyScalar(k);

function runFx(fx: Fx, rt: DroneRT, a: Anim | null, u: number, pos: Vector3, scale: number, now: number, W: number) {
  fx.beam.visible = fx.ring1.visible = fx.ring2.visible = fx.hex.visible = fx.sparks.visible = false;
  if (!a) return;
  const col = hdr(a.color);
  const tw = rt.layout.towers[a.tower];
  const roof = V2.set(tw.x, 0.35 + tw.h, tw.z);
  const fade = 1 - smooth(0.7, 1, u);
  const k = scale;
  switch (a.kind) {
    case "tool_result": {
      const working = smooth(0.2, 0.3, u) * (1 - smooth(0.72, 0.8, u));
      switch (a.family) {
        case "read": {
          setBeam(fx, pos, roof, 0.03 * k, col, 0.55 * working);
          const t = clamp01((u - 0.25) / 0.5);
          const y = 0.35 + tw.h * (1 - t);
          setRing(fx.ring1, fx.mats[1], roof, (Math.max(tw.w, tw.d) * 0.78 + 0.1), col, working * 0.95, y);
          break;
        }
        case "edit": {
          setBeam(fx, pos, roof, (0.025 + 0.02 * Math.sin(now * 0.09)) * k, col, working * (0.5 + 0.5 * Math.sin(now * 0.07) ** 2));
          fx.sparks.visible = working > 0.05;
          fx.sparkMat.color.copy(col);
          fx.sparkMat.opacity = working;
          const p = fx.sparks.geometry.getAttribute("position") as BufferAttribute;
          for (let i = 0; i < 14; i++) {
            const ph = (now * 0.0023 + i * 0.173) % 1;
            const ang = i * 2.399 + now * 0.002;
            const r = ph * 0.9;
            p.setXYZ(i, roof.x + Math.cos(ang) * r, roof.y + 0.2 + ph * 0.9 - ph * ph * 1.3, roof.z + Math.sin(ang) * r);
          }
          p.needsUpdate = true;
          break;
        }
        case "bash": {
          setBeam(fx, pos, roof, 0.085 * k, col, working * (0.35 + 0.65 * (Math.sin(now * 0.05) > 0 ? 1 : 0.25)));
          const t = clamp01((u - 0.25) / 0.4);
          setRing(fx.ring1, fx.mats[1], roof, 0.4 + t * 2.1, col, (1 - t) * working * 1.2, roof.y + 0.05);
          break;
        }
        case "web": {
          for (let i = 0; i < 3; i++) {
            const ph = (u * 1.6 + i * 0.3) % 1;
            const m = i === 0 ? fx.ring1 : i === 1 ? fx.ring2 : fx.hex;
            const mat = i === 0 ? fx.mats[1] : i === 1 ? fx.mats[2] : fx.mats[3];
            if (i === 2) m.rotation.x = Math.PI / 2;
            setRing(m, mat, pos, (0.9 - ph * 0.3) * k * 0.75, col, (1 - ph) * 0.95 * (1 - smooth(0.85, 1, u)), pos.y + 0.4 + ph * 3.8);
          }
          break;
        }
        case "mcp": {
          const t = Math.sin(clamp01(u) * Math.PI);
          fx.hex.visible = true;
          fx.hex.position.set(pos.x, pos.y + 0.05, pos.z);
          fx.hex.rotation.set(Math.PI / 2 + Math.sin(now * 0.004) * 0.35, 0, now * 0.006);
          fx.hex.scale.setScalar((0.9 + 0.35 * t) * k);
          fx.mats[3].color.copy(col);
          fx.mats[3].opacity = t * 1.0;
          setRing(fx.ring1, fx.mats[1], pos, (1.35 - 0.4 * t) * k, col, t * 0.5, pos.y + 0.05);
          break;
        }
        default: {
          setBeam(fx, pos, roof, 0.03 * k, col, 0.5 * working);
          const t = clamp01((u - 0.25) / 0.4);
          setRing(fx.ring1, fx.mats[1], roof, 0.3 + t * 1.2, col, (1 - t) * working, roof.y + 0.05);
        }
      }
      break;
    }
    case "error": {
      setRing(fx.ring1, fx.mats[1], pos, 0.5 + u * 3.2 * k, hdr("#ff3b4e", 3), (1 - u) * 1.1);
      setRing(fx.ring2, fx.mats[2], pos, 0.3 + clamp01(u - 0.15) * 2.4 * k, hdr("#ff3b4e", 2.2), (1 - clamp01(u - 0.15) * 1.1) * 0.9);
      break;
    }
    case "prompt": {
      const top = V2.set(pos.x, pos.y + 13, pos.z);
      setBeam(fx, top, pos, 0.1 * k, col, (1 - smooth(0.35, 1, u)) * 0.85);
      setRing(fx.ring1, fx.mats[1], pos, 0.4 + u * 2.4 * k, col, (1 - u) * 0.9, pos.y - 0.15);
      break;
    }
    case "api_request": {
      setRing(fx.ring1, fx.mats[1], pos, 0.35 + u * 2.6 * k, col, (1 - u) * 1.1, pos.y - 0.1);
      const u2 = clamp01(u * 1.5 - 0.3);
      setRing(fx.ring2, fx.mats[2], pos, 0.35 + u2 * 2.0 * k, col, (1 - u2) * 0.9, pos.y - 0.1);
      break;
    }
    case "response": {
      const top = V2.set(pos.x, pos.y + 1.5 + u * 6, pos.z);
      setBeam(fx, pos, top, 0.07 * k, col, fade * 0.8 * smooth(0, 0.2, u));
      setRing(fx.ring1, fx.mats[1], pos, 0.3 + u * 1.5 * k, col, (1 - u) * 0.9, pos.y + 0.3 + u * 2.5);
      break;
    }
    case "compaction": {
      const t = 1 - u;
      setRing(fx.ring1, fx.mats[1], pos, (0.3 + t * 2.4) * k, col, 0.9 * Math.min(1, u * 5) * fade);
      setRing(fx.ring2, fx.mats[2], pos, (0.3 + clamp01(t - 0.2) * 2.4) * k, col, 0.7 * fade);
      break;
    }
    case "tool_decision": {
      setRing(fx.ring1, fx.mats[1], pos, 0.3 + u * 1.1 * k, col, (1 - u) * 0.6);
      break;
    }
    case "subagent_spawn":
    case "subagent_done": {
      setRing(fx.ring1, fx.mats[1], pos, 0.4 + u * 2.2 * k, col, (1 - u) * 1.0, pos.y - 0.1);
      break;
    }
  }
  void W;
}

import type { Anim } from "./runtime";

/** dart weight: 0 at home, 1 at the tower. Only tool_result families that "work" on a tower. */
function dartWeight(a: Anim | null, u: number): number {
  if (!a || a.kind !== "tool_result") return 0;
  if (a.family === "web" || a.family === "mcp" || a.family === "agent") return 0;
  return smooth(0, 0.27, u) * (1 - smooth(0.73, 1, u));
}

// ---------------------------------------------------------------- the unit
interface UnitProps {
  session: Session;
  rt: DroneRT;
  selected: boolean;
}

export function DroneUnit({ session, rt, selected }: UnitProps) {
  const conductor = session.role === "conductor";
  const trim = machineColor(session.machine);
  const rootRef = useRef<Group>(null);
  const tiltRef = useRef<Group>(null);
  const rotors = useRef<Object3D[]>([]);
  const fx = useMemo(() => makeFx(), []);
  const ringMat = useMemo(() => new MeshBasicMaterial({ color: "#ff2fd0", toneMapped: false, transparent: true }), []);
  const stripMat = useMemo(() => new MeshBasicMaterial({ color: "#ff2fd0", toneMapped: false, transparent: true }), []);
  const decalMat = useMemo(
    () => new MeshBasicMaterial({ color: "#ff2fd0", transparent: true, opacity: 0.3, depthWrite: false, blending: AdditiveBlending, toneMapped: false }),
    [],
  );
  const decalRef = useRef<Mesh>(null);
  const selRef = useRef<Mesh>(null);
  const st = useRef({ x: 0, y: 6, z: 0, prevX: 0, prevZ: 0, tiltX: 0, tiltZ: 0, mount: 0, spin: 0, yaw: 0 });
  const select = useStore((s) => s.select);
  const colRing = useMemo(() => new Color(), []);
  const pos = useMemo(() => new Vector3(), []);
  const scaleBase = conductor ? 1.3 : 1.35;

  useFrame((_, dt0) => {
    const dt = Math.min(dt0, 0.05);
    const now = performance.now();
    const root = rootRef.current!;
    const s = st.current;
    rt.root = root;
    s.mount = Math.min(1, s.mount + dt * 1.6);

    // activity rate (events/s, smoothed) + burst flag decay
    rt.rate += (rt.count / Math.max(dt, 1e-3) - rt.rate) * (1 - Math.exp(-dt * 3));
    rt.count = 0;
    rt.bursting = Math.max(0, rt.bursting - dt * 1.8);
    rt.errFlash = Math.max(0, rt.errFlash - dt * 1.5);

    const state = session.state;
    const lay = rt.layout;
    let a = rt.anim;
    if (a && now > a.t0 + a.dur) a = rt.anim = null;
    const u = a ? (now - a.t0) / a.dur : 0;

    // home position by lifecycle state
    const hover = lay.maxH + 0.35 + (conductor ? 3.4 : 2.4);
    let hx = 0;
    let hz = 0;
    let hy = hover + Math.sin(now * 0.0017 + lay.hue * 9) * 0.14;
    if (state === "idle") hy = hover - 0.75 + Math.sin(now * 0.0011 + lay.hue * 9) * 0.07;
    if (state === "ended") {
      hy = 0.35 + (conductor ? 0.35 : 0.2);
      hz = BLOCK_EDGE;
    }
    const w = dartWeight(a, u) * (conductor ? 0.55 : 1);
    const tw = a ? lay.towers[a.tower] : null;
    let tx = hx;
    let ty = hy;
    let tz = hz;
    if (tw && w > 0) {
      tx = tw.x;
      ty = 0.35 + tw.h + (conductor ? 1.9 : 1.15);
      tz = tw.z;
    }
    // ease towards target
    let px = hx + (tx - hx) * w;
    let py = hy + (ty - hy) * w;
    let pz = hz + (tz - hz) * w;
    // quick jitter when bursting / on error
    const jit = (rt.bursting * 0.05 + (a?.kind === "error" || a?.family === "error" ? 0.09 : 0)) * (state === "ended" ? 0 : 1);
    px += (Math.random() - 0.5) * jit;
    pz += (Math.random() - 0.5) * jit;
    // smooth follow so state transitions glide
    const f = 1 - Math.exp(-dt * (w > 0 ? 20 : 5));
    s.x += (px - s.x) * f;
    s.y += (py - s.y) * f;
    s.z += (pz - s.z) * f;
    root.position.set(s.x, s.y, s.z);
    pos.set(s.x, s.y, s.z);

    // bank into movement
    const vx = (s.x - s.prevX) / Math.max(dt, 1e-3);
    const vz = (s.z - s.prevZ) / Math.max(dt, 1e-3);
    s.prevX = s.x;
    s.prevZ = s.z;
    s.tiltX += (-vz * 0.03 - s.tiltX) * (1 - Math.exp(-dt * 8));
    s.tiltZ += (vx * 0.03 - s.tiltZ) * (1 - Math.exp(-dt * 8));
    const tilt = tiltRef.current!;
    tilt.rotation.x = s.tiltX;
    tilt.rotation.z = -s.tiltZ;
    if (a?.kind === "compaction") {
      s.yaw += dt * 14 * Math.sin(clamp01(u) * Math.PI);
      tilt.scale.set(1 + 0.15 * Math.sin(u * Math.PI), 1 - 0.4 * Math.sin(u * Math.PI), 1 + 0.15 * Math.sin(u * Math.PI));
    } else {
      tilt.scale.set(1, 1, 1);
    }
    s.yaw += dt * (a?.kind === "prompt" ? 3 : 0);
    tilt.rotation.y = s.yaw * 0 + (a?.kind === "compaction" ? s.yaw : 0) + Math.sin(now * 0.0006 + lay.hue * 7) * 0.08;
    const mk = s.mount * s.mount * (3 - 2 * s.mount);
    root.scale.setScalar(scaleBase * (0.25 + 0.75 * mk));

    // rotors
    const spinBase = state === "active" ? 46 : state === "idle" ? 10 : 0;
    s.spin += dt * spinBase * (1 + Math.min(rt.rate, 60) * 0.025 + rt.bursting * 0.8);
    const rs = rotors.current;
    for (let i = 0; i < rs.length; i++) if (rs[i]) rs[i].rotation.z = s.spin * (i % 2 ? -1 : 1);

    // underside ring colour: base magenta; animation colour; error red; burst flicker white
    const dimK = state === "active" ? 1 : state === "idle" ? 0.35 : 0.08;
    colRing.set("#ff2fd0").multiplyScalar(1.7 * dimK);
    if (a) {
      const env = Math.sin(clamp01(u) * Math.PI);
      colRing.lerp(tcol.set(a.color).multiplyScalar(3.4), Math.min(1, env * 1.6));
    }
    if (rt.bursting > 0.05) colRing.lerp(tcol.set("#ffffff").multiplyScalar(3), rt.bursting * (0.5 + 0.5 * Math.sin(now * 0.04)) * 0.7);
    if (rt.errFlash > 0) colRing.lerp(tcol.set("#ff3b4e").multiplyScalar(3.5), rt.errFlash);
    ringMat.color.copy(colRing);
    stripMat.color.copy(colRing);
    decalMat.color.copy(colRing).multiplyScalar(0.22);
    decalMat.opacity = 0.28 * dimK;
    if (decalRef.current) {
      const d = decalRef.current;
      d.position.set(s.x, 0.39, s.z);
      const sc = (conductor ? 3.2 : 1.7) * (1 + (s.y - 0.4) * 0.05);
      d.scale.set(sc, sc * 0.8, 1);
    }
    if (selRef.current) {
      selRef.current.position.set(0, -0.35, 0);
      selRef.current.rotation.z = now * 0.002;
    }

    runFx(fx, rt, a, u, pos, conductor ? 1.6 : 1, now, 0);
    // pad flash (carrier deck lights) decay
    for (let i = 0; i < PADS; i++) rt.padFlash[i] = Math.max(0, rt.padFlash[i] - dt * 1.6);
  });

  const kids = useStore((s) => s.struct); // re-render when subagents launch/dock
  void kids;
  const now = performance.now();
  const childList = [...rt.children.values()].filter(
    (c) => c.state === "running" || now - c.endedAt < DOCK_MS + 300,
  );

  return (
    <>
      <group ref={rootRef}>
        <group ref={tiltRef}>
          {conductor ? <Carrier trim={trim} rotors={rotors} /> : <SmallHull trim={trim} rotors={rotors} />}
          {/* glowing underside ring (carrier: long strip + ring) */}
          {conductor ? (
            <>
              <mesh position={[0, -0.2, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[1.55, 0.6, 1]} geometry={torus} material={ringMat} />
              <mesh position={[0, -0.22, 0]} scale={[1.2, 0.025, 0.1]} geometry={sphere} material={stripMat} />
            </>
          ) : (
            <mesh position={[0, -0.18, 0]} rotation={[Math.PI / 2, 0, 0]} scale={0.34} geometry={torus} material={ringMat} />
          )}
        </group>
        <mesh scale={conductor ? 2.1 : 1.0} geometry={sphere} material={hitMat}
          onClick={(e) => {
            if (e.delta < 6) {
              e.stopPropagation();
              select(session.id);
            }
          }}
          onPointerOver={() => (document.body.style.cursor = "pointer")}
          onPointerOut={() => (document.body.style.cursor = "")}
        />
        {selected && (
          <mesh ref={selRef} rotation={[Math.PI / 2, 0, 0]} scale={conductor ? 2.3 : 1.15} geometry={torusFine} material={selMat} />
        )}
      </group>
      <mesh ref={decalRef} rotation={[-Math.PI / 2, 0, 0]} geometry={disc} material={decalMat} />
      <primitive object={fx.beam} />
      <primitive object={fx.ring1} />
      <primitive object={fx.ring2} />
      <primitive object={fx.hex} />
      <primitive object={fx.sparks} />
      {childList.map((c) => (
        <ChildDrone key={c.id} child={c} rt={rt} session={session} homeRef={rootRef} />
      ))}
    </>
  );
}

const BLOCK_EDGE = 2.0;

// ---------------------------------------------------------------- subagent
function ChildDrone({
  child,
  rt,
  session,
  homeRef,
}: {
  child: ChildRT;
  rt: DroneRT;
  session: Session;
  homeRef: MutableRefObject<Group | null>;
}) {
  const ref = useRef<Group>(null);
  const rotors = useRef<Object3D[]>([]);
  const fx = useMemo(() => makeFx(), []);
  const ringMat = useMemo(() => new MeshBasicMaterial({ color: "#ffe14d", toneMapped: false }), []);
  const pos = useMemo(() => new Vector3(), []);
  const conductor = session.role === "conductor";
  const trim = machineColor(session.machine);
  const st = useRef({ spin: Math.random() * 6, x: 0, y: 0, z: 0, init: false, ox: 0, oy: 0, oz: 0 });

  useFrame((_, dt0) => {
    const dt = Math.min(dt0, 0.05);
    const now = performance.now();
    const g = ref.current;
    const home = homeRef.current;
    if (!g || !home) return;
    child.root = g;
    const s = st.current;
    const seed = child.seed;
    const ang0 = ((seed % 628) / 100) + now * 0.00042 * (0.8 + (seed % 5) * 0.1);
    const R = 2.9 + (seed % 5) * 0.28;
    const oy0 = rt.layout.maxH + 0.35 + 1.4 + ((seed >> 3) % 3) * 0.55 + Math.sin(now * 0.002 + seed) * 0.25;
    let ox = Math.cos(ang0) * R;
    let oz = Math.sin(ang0) * R * 0.78;
    let oy = oy0;
    if (session.state === "idle") oy -= 0.6;

    // pad position (carrier deck or hull belly)
    const hp = home.position;
    let padX = hp.x;
    let padY = hp.y - 0.1;
    let padZ = hp.z;
    if (conductor) {
      const p = padLocal(child.pad);
      padX = hp.x + p[0] * 1.3;
      padY = hp.y + p[1] * 1.3 + 0.15;
      padZ = hp.z + p[2] * 1.3;
    }

    let sc = 0.55;
    const age = now - child.t0;
    let px = ox;
    let py = oy;
    let pz = oz;
    let spinK = 1;
    if (child.state === "docked") {
      const dk = clamp01((now - child.endedAt) / DOCK_MS);
      const e = dk * dk * (3 - 2 * dk);
      px = ox + (padX - ox) * e;
      pz = oz + (padZ - oz) * e;
      py = oy + (padY - oy) * e + Math.sin(dk * Math.PI) * 0.9;
      sc = 0.55 - 0.25 * e;
      spinK = 1 - dk * 0.7;
      g.visible = dk < 1 && session.state !== "ended";
    } else if (age < LAUNCH_MS) {
      const k = clamp01(age / LAUNCH_MS);
      const e = easeOut(k);
      px = padX + (ox - padX) * e;
      pz = padZ + (oz - padZ) * e;
      py = padY + (oy - padY) * e + Math.sin(k * Math.PI) * 1.4;
      sc = 0.3 + 0.25 * e;
      g.visible = true;
    } else {
      g.visible = session.state !== "ended";
    }

    // child animation: dart to a tower + beam
    let a = child.anim;
    if (a && now > a.t0 + a.dur) a = child.anim = null;
    const u = a ? (now - a.t0) / a.dur : 0;
    const w = dartWeight(a, u);
    if (a && w > 0) {
      const tw = rt.layout.towers[a.tower];
      px += (tw.x - px) * w;
      pz += (tw.z - pz) * w;
      py += (0.35 + tw.h + 0.8 - py) * w;
    }
    const f = 1 - Math.exp(-dt * (w > 0 ? 18 : 10));
    if (!s.init) {
      s.x = px;
      s.y = py;
      s.z = pz;
      s.init = true;
    } else {
      s.x += (px - s.x) * f;
      s.y += (py - s.y) * f;
      s.z += (pz - s.z) * f;
    }
    g.position.set(s.x, s.y, s.z);
    g.scale.setScalar(sc);
    g.rotation.z = (s.x - px) * -0.15;
    pos.set(s.x, s.y, s.z);
    s.spin += dt * 60 * spinK;
    for (let i = 0; i < rotors.current.length; i++) if (rotors.current[i]) rotors.current[i].rotation.z = s.spin * (i % 2 ? -1 : 1);

    const c = tcol.set(a ? a.color : "#ffe14d").multiplyScalar(a ? 3 : 1.6);
    ringMat.color.copy(c);
    runFx(fx, rt, a && a.kind === "tool_result" && dartWeight(a, u) > 0 ? a : a, u, pos, 0.45, now, 0);
  });

  return (
    <>
      <group ref={ref}>
        <SmallHull trim={trim} rotors={rotors} />
        <mesh position={[0, -0.18, 0]} rotation={[Math.PI / 2, 0, 0]} scale={0.34} geometry={torus} material={ringMat} />
      </group>
      <primitive object={fx.beam} />
      <primitive object={fx.ring1} />
      <primitive object={fx.ring2} />
      <primitive object={fx.hex} />
      <primitive object={fx.sparks} />
    </>
  );
}

void SYMBOLS;
