// Chunky utility drone + barge-like carrier airship. Pure visuals; motion/position live in Craft.tsx.
import { useFrame } from "@react-three/fiber";
import { MutableRefObject, useMemo, useRef } from "react";
import {
  AdditiveBlending, CanvasTexture, Color, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, SpriteMaterial,
  SphereGeometry, TorusGeometry, BoxGeometry, SRGBColorSpace, CylinderGeometry,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { machineInfo } from "../config";
import { FAMILIES } from "../symbols";
import type { DroneRT } from "../sim";
import { glowTexture, tagTexture } from "./textures";

// ---- shared geometry / materials ------------------------------------------------------------------
const G = {
  body: new RoundedBoxGeometry(1.0, 0.5, 0.82, 4, 0.15),
  belly: new RoundedBoxGeometry(0.66, 0.16, 0.5, 2, 0.05),
  arm: new BoxGeometry(0.8, 0.09, 0.12),
  duct: new TorusGeometry(0.36, 0.075, 10, 28),
  ductSkirt: new CylinderGeometry(0.36, 0.33, 0.12, 24, 1, true),
  blade: new BoxGeometry(0.62, 0.014, 0.075),
  hub: new CylinderGeometry(0.05, 0.05, 0.07, 8),
  dome: new SphereGeometry(0.3, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2),
  lens: new TorusGeometry(0.13, 0.045, 8, 18),
  eye: new SphereGeometry(0.095, 14, 10),
  clamp: new BoxGeometry(0.06, 0.22, 0.34),
  // carrier
  hull: new RoundedBoxGeometry(7.4, 0.95, 2.1, 3, 0.28),
  envelope: new SphereGeometry(1, 28, 16),
  rib: new TorusGeometry(1, 0.025, 6, 40),
  pylon: new BoxGeometry(0.2, 0.2, 1.1),
  bigDuct: new TorusGeometry(0.62, 0.11, 10, 30),
  bigBlade: new BoxGeometry(1.1, 0.02, 0.12),
  keel: new BoxGeometry(3.6, 0.1, 1.3),
};

// merged parts: fewer draw calls per drone
const mkArms = () => {
  const parts: BoxGeometry[] = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const g = G.arm.clone();
    g.scale(1.1, 1, 1);
    g.applyMatrix4(new Matrix4().compose(
      new Vector3(sx * 0.64, 0.15, sz * 0.47),
      new Quaternion().setFromEuler(new Euler(0, -Math.atan2(sz * 0.54, sx * 0.68), 0)),
      new Vector3(1, 1, 1),
    ));
    parts.push(g);
  }
  return mergeGeometries(parts)!;
};
const GM = {
  arms: mkArms(),
  fanDuct: mergeGeometries([G.duct.clone().rotateX(Math.PI / 2), G.ductSkirt.clone().translate(0, -0.02, 0)])!,
  rotor: mergeGeometries([G.blade.clone(), G.blade.clone().rotateY(Math.PI / 2), G.hub.clone()])!,
};

const hullCache = new Map<string, { hull: MeshStandardMaterial; trim: MeshStandardMaterial; glow: MeshBasicMaterial; ribGlow: MeshBasicMaterial; env: MeshStandardMaterial }>();
export function machineMats(machine: string) {
  let m = hullCache.get(machine);
  if (!m) {
    const hex = machineInfo(machine).hex;
    const hullHex = machine === "laptop" ? "#118b83" : machine === "vps" ? "#c4600f" : "#56646e";
    m = {
      hull: new MeshStandardMaterial({ color: hullHex, metalness: 0.55, roughness: 0.36, emissive: hex, emissiveIntensity: 0.07, envMapIntensity: 1.2 }),
      trim: new MeshStandardMaterial({ color: "#0b1419", metalness: 0.8, roughness: 0.42 }),
      glow: new MeshBasicMaterial({ color: new Color(hex).multiplyScalar(2.6), toneMapped: false }),
      ribGlow: new MeshBasicMaterial({ color: new Color(hex).multiplyScalar(0.9), toneMapped: false }),
      env: new MeshStandardMaterial({ color: new Color(hullHex).multiplyScalar(0.45), metalness: 0.5, roughness: 0.4, emissive: hex, emissiveIntensity: 0.05 }),
    };
    hullCache.set(machine, m);
  }
  return m;
}

const spriteMat = new Map<string, SpriteMaterial>();
function glowSprite(key: string, color: Color) {
  let m = spriteMat.get(key);
  if (!m) {
    m = new SpriteMaterial({ map: glowTexture(), color, blending: AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false, fog: false });
    spriteMat.set(key, m);
  }
  return m;
}

function Fan({ i, reg, x, y, z, tiltX, tiltZ, big = false, hullMat }: {
  i: number; reg: (i: number, o: Object3D | null) => void; x: number; y: number; z: number; tiltX: number; tiltZ: number; big?: boolean;
  hullMat: MeshStandardMaterial;
}) {
  return (
    <group position={[x, y, z]} rotation={[tiltX, 0, tiltZ]}>
      <mesh geometry={GM.fanDuct} scale={big ? 1.72 : 1} material={hullMat} />
      <group ref={(o) => reg(i, o)}>
        <mesh geometry={GM.rotor} scale={big ? 1.75 : 1} material={machineMatsDark} />
      </group>
    </group>
  );
}
const machineMatsDark = new MeshStandardMaterial({ color: "#05090c", metalness: 0.9, roughness: 0.3 });

function useAnimState(rt: DroneRT) {
  return (now: number) => {
    const a = rt.anim;
    const p = a ? (now - a.t0) / a.dur : 2;
    return { a, p };
  };
}

// ---- drone ----------------------------------------------------------------------------------------
export function DroneModel({ rt, machine, power, seed }: { rt: DroneRT; machine: string; power: MutableRefObject<number>; seed: number }) {
  const mats = machineMats(machine);
  const info = machineInfo(machine);
  const tag = useMemo(() => tagTexture(info.tag, info.hex), [info.tag, info.hex]);
  const eyeMat = useMemo(() => new MeshBasicMaterial({ color: new Color("#bffcff").multiplyScalar(3), toneMapped: false }), []);
  const halo = useMemo(() => new SpriteMaterial({ map: glowTexture(), color: new Color("#7fffee"), blending: AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false, fog: false }), []);
  const inner = useRef<Group>(null);
  const eyeG = useRef<Group>(null);
  const blades = useRef<(Object3D | null)[]>([]);
  const reg = (i: number, o: Object3D | null) => { blades.current[i] = o; };
  const get = useAnimState(rt);
  const tmp = useMemo(() => new Color(), []);
  const base = useMemo(() => new Color("#bffcff"), []);

  useFrame((st, dt) => {
    const now = performance.now();
    const t = st.clock.elapsedTime;
    const { a, p } = get(now);
    const pw = power.current;
    const spin = (0.5 + pw * 34 + Math.min(rt.rate, 14) * 1.6) * dt;
    blades.current.forEach((o, i) => { if (o) o.rotation.y += spin * (i % 2 ? 1 : -1); });
    const g = inner.current!;
    let rx = 0, rz = 0, sx = 0;
    if (a && p < 1) {
      const e = Math.sin(Math.min(1, p) * Math.PI);
      if (a.fam === "edit" || a.fam === "bash") rx = 0.22 * e;
      if (a.fam === "response") rx = -0.16 * e;
      if (a.fam === "error") sx = (Math.random() - 0.5) * 0.12 * (1 - p);
      if (a.fam === "read") rz = Math.sin(p * Math.PI * 3) * 0.12;
    }
    g.rotation.x += (rx + Math.sin(t * 1.3 + seed) * 0.03 * pw - g.rotation.x) * 0.2;
    g.rotation.z += (rz + Math.cos(t * 1.1 + seed) * 0.03 * pw - g.rotation.z) * 0.2;
    g.rotation.y = Math.sin(t * 0.35 + seed * 3) * 0.4 * (0.3 + pw * 0.7);
    g.position.x = sx;
    // eye
    if (a && p < 1) tmp.set(FAMILIES[a.fam].color).multiplyScalar(3.4);
    else tmp.copy(base).multiplyScalar(0.4 + pw * 2.6 + (rt.rate > 4 ? 0.8 * Math.abs(Math.sin(t * 18)) : 0));
    eyeMat.color.lerp(tmp, 0.35);
    halo.color.copy(eyeMat.color).multiplyScalar(0.35);
    const es = 1 + (a && p < 1 ? 0.5 * Math.sin(p * Math.PI) : 0);
    eyeG.current!.scale.setScalar(es);
  });

  const fan = (i: number, sx: number, sz: number) => (
    <group key={i}>
      <Fan i={i} reg={reg} x={sx * 0.98} y={0.22} z={sz * 0.74} tiltX={sz * 0.22} tiltZ={-sx * 0.22} hullMat={mats.hull} />
    </group>
  );

  return (
    <group ref={inner}>
      <mesh geometry={G.body} material={mats.hull} />
      <mesh geometry={G.dome} position={[0, 0.2, -0.04]} scale={[1, 0.55, 1]} material={mats.trim} />
      <mesh geometry={G.belly} position={[0, -0.3, 0]} material={mats.trim} />
      <mesh geometry={G.clamp} position={[-0.2, -0.43, 0]} material={mats.glow} scale={[1, 0.5, 1]} />
      <mesh geometry={G.clamp} position={[0.2, -0.43, 0]} material={mats.glow} scale={[1, 0.5, 1]} />
      {/* machine tag plate on the back-top */}
      <mesh position={[0, 0.262, -0.16]} rotation-x={-Math.PI / 2} scale={[1, 1, 1]}>
        <planeGeometry args={[0.46, 0.23]} />
        <meshBasicMaterial map={tag} toneMapped={false} />
      </mesh>
      {/* side accent bars */}
      <mesh position={[0.51, 0.02, 0]}><boxGeometry args={[0.02, 0.06, 0.5]} /><primitive object={mats.glow} attach="material" /></mesh>
      <mesh position={[-0.51, 0.02, 0]}><boxGeometry args={[0.02, 0.06, 0.5]} /><primitive object={mats.glow} attach="material" /></mesh>
      <mesh geometry={GM.arms} material={mats.trim} />
      {[[1, 1], [-1, 1], [1, -1], [-1, -1]].map(([sx, sz], i) => fan(i, sx, sz))}
      <group ref={eyeG} position={[0, 0.02, 0.42]}>
        <mesh geometry={G.lens} material={mats.trim} />
        <mesh geometry={G.eye} material={eyeMat} position-z={0.01} />
        <sprite material={halo} scale={[1.1, 1.1, 1]} position-z={0.12} />
      </group>
    </group>
  );
}

// ---- carrier --------------------------------------------------------------------------------------
function stripTexture(hex: string) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 32;
  const g = c.getContext("2d")!;
  g.fillStyle = "#050c10";
  g.fillRect(0, 0, 512, 32);
  for (let x = 10; x < 500; x += 28) {
    g.fillStyle = (x / 28) % 5 === 0 ? "#ffffff" : hex;
    g.globalAlpha = 0.55 + ((x * 7) % 5) * 0.1;
    g.fillRect(x, 8, 18, 16);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export function CarrierModel({ rt, machine, power, doors, seed }: {
  rt: DroneRT; machine: string; power: MutableRefObject<number>; doors: MutableRefObject<number>; seed: number;
}) {
  const mats = machineMats(machine);
  const info = machineInfo(machine);
  const tag = useMemo(() => tagTexture(info.tag, info.hex), [info.tag, info.hex]);
  const strip = useMemo(() => stripTexture(info.hex), [info.hex]);
  const eyeMat = useMemo(() => new MeshBasicMaterial({ color: new Color("#d8ffff").multiplyScalar(3), toneMapped: false }), []);
  const doorMat = useMemo(() => new MeshBasicMaterial({ color: new Color(info.hex).multiplyScalar(0.4), toneMapped: false }), [info.hex]);
  const halo = useMemo(() => new SpriteMaterial({ map: glowTexture(), color: new Color("#7fffee"), blending: AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false, fog: false }), []);
  const inner = useRef<Group>(null);
  const blades = useRef<(Object3D | null)[]>([]);
  const reg = (i: number, o: Object3D | null) => { blades.current[i] = o; };
  const strobe = useRef<Mesh>(null);
  const tmp = useMemo(() => new Color(), []);
  const ribs = useMemo(() => Array.from({ length: 11 }, (_, i) => -3.2 + i * 0.64), []);
  const get = useAnimState(rt);

  useFrame((st, dt) => {
    const now = performance.now();
    const t = st.clock.elapsedTime;
    const { a, p } = get(now);
    const pw = power.current;
    const spin = (0.4 + pw * 24 + Math.min(rt.rate, 14)) * dt;
    blades.current.forEach((o, i) => { if (o) o.rotation.y += spin * (i % 2 ? 1 : -1); });
    const g = inner.current!;
    let rx = 0;
    if (a && p < 1 && (a.fam === "edit" || a.fam === "bash")) rx = 0.03 * Math.sin(p * Math.PI);
    g.rotation.x += (rx - g.rotation.x) * 0.15;
    g.rotation.z = Math.sin(t * 0.5 + seed) * 0.012;
    g.position.x = a && p < 1 && a.fam === "error" ? (Math.random() - 0.5) * 0.1 : 0;
    if (a && p < 1) tmp.set(FAMILIES[a.fam].color).multiplyScalar(3.4);
    else tmp.set("#d8ffff").multiplyScalar(0.4 + pw * 2.4);
    eyeMat.color.lerp(tmp, 0.35);
    halo.color.copy(eyeMat.color).multiplyScalar(0.3);
    // belly doors glow with the number of airborne subagents
    const d = doors.current;
    doorMat.color.set(info.hex).multiplyScalar(0.35 + d * 3.2 + (a && p < 1 && a.fam === "spawn" ? 2.5 : 0));
    strobe.current!.visible = Math.sin(t * 4.4 + seed) > 0.78;
  });

  const ductAt = (i: number, x: number, z: number) => (
    <group key={i}>
      <mesh geometry={G.pylon} position={[x * 0.97, 0.05, z * 1.3]} material={mats.trim} />
      <Fan i={i} reg={reg} x={x} y={0.32} z={z * 1.58} tiltX={z * 0.16} tiltZ={0} big hullMat={mats.hull} />
    </group>
  );

  return (
    <group ref={inner}>
      <mesh geometry={G.hull} material={mats.hull} />
      {/* envelope on top, with glowing ribs */}
      <mesh geometry={G.envelope} position={[0, 0.78, 0]} scale={[3.55, 0.82, 1.0]} material={mats.env} />
      {ribs.map((x, i) => {
        const k = Math.sqrt(Math.max(0.02, 1 - (x / 3.55) ** 2));
        return <mesh key={i} geometry={G.rib} position={[x, 0.78, 0]} rotation-y={Math.PI / 2} scale={[k * 1.0, k * 0.82, 1]} material={mats.ribGlow} />;
      })}
      <mesh geometry={G.keel} position={[0, -0.52, 0]} material={mats.trim} />
      <mesh position={[0, -0.22, 0]} material={mats.trim}><boxGeometry args={[7.46, 0.1, 2.16]} /></mesh>
      <mesh position={[0, 0.3, 0]} material={mats.trim}><boxGeometry args={[7.4, 0.06, 2.14]} /></mesh>
      {/* belly bay doors */}
      <mesh position={[0, -0.585, 0]} rotation-x={Math.PI / 2} material={doorMat}>
        <planeGeometry args={[2.6, 0.95]} />
      </mesh>
      {/* window strip on the camera-facing flank */}
      <mesh position={[0, 0.05, 1.062]}>
        <planeGeometry args={[5.6, 0.34]} />
        <meshBasicMaterial map={strip} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.2, 0]} rotation-x={-Math.PI / 2} />
      {/* machine plate on the back */}
      <mesh position={[0, 1.62, -0.05]} rotation-x={-1.1}>
        <planeGeometry args={[1.5, 0.75]} />
        <meshBasicMaterial map={tag} toneMapped={false} />
      </mesh>
      {ductAt(0, 2.5, 1)}
      {ductAt(1, -2.5, 1)}
      {ductAt(2, 2.5, -1)}
      {ductAt(3, -2.5, -1)}
      {/* bow searchlight (the carrier's "eye") */}
      <group position={[3.78, 0.0, 0]}>
        <mesh geometry={G.lens} scale={[1.9, 1.9, 1.9]} rotation-y={Math.PI / 2} material={mats.trim} />
        <mesh geometry={G.eye} scale={[2.2, 2.2, 2.2]} material={eyeMat} position-x={0.05} />
        <sprite material={halo} scale={[2.6, 2.6, 1]} position-x={0.25} />
      </group>
      {/* nav lights + strobe */}
      <mesh position={[3.4, 0.2, 1.06]}><sphereGeometry args={[0.07, 8, 8]} /><meshBasicMaterial color={new Color("#2dff7a").multiplyScalar(3)} toneMapped={false} /></mesh>
      <mesh position={[3.4, 0.2, -1.06]}><sphereGeometry args={[0.07, 8, 8]} /><meshBasicMaterial color={new Color("#ff2d4a").multiplyScalar(3)} toneMapped={false} /></mesh>
      <mesh ref={strobe} position={[-0.2, 1.68, 0]}><sphereGeometry args={[0.12, 8, 8]} /><meshBasicMaterial color={new Color("#ffffff").multiplyScalar(5)} toneMapped={false} /></mesh>
    </group>
  );
}

export { useAnimState as _useAnimState };
