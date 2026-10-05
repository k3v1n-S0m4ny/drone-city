// One district = one landing platform / dock: octagonal pad with edge lights, cargo containers,
// a control mast with a holographic label sign, plus the session's craft and subagent drones.
import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import {
  AdditiveBlending, Color, Group, InstancedMesh, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D,
} from "three";
import { CFG, machineInfo } from "../config";
import { useStore, world } from "../store";
import { SessionCraft, SubDrone } from "./Craft";
import { sim } from "../sim";
import { containerTexture, glowTexture, labelTexture, padTexture } from "./textures";
import { slotPos } from "./view";

const damp = (cur: number, tgt: number, lambda: number, dt: number) => cur + (tgt - cur) * (1 - Math.exp(-lambda * dt));

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rngFrom(seed: number) {
  let s = seed || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

const CONTAINER_COLORS = ["#8a4426", "#2d6670", "#6b7680", "#2b4a73", "#9a7721", "#5a3249", "#476a43", "#7d3030"];

interface Fadable {
  mat: MeshStandardMaterial | MeshBasicMaterial;
  base: Color;
  ei?: number;
}

export function Districts() {
  const order = useStore((s) => s.order);
  return (
    <>
      {order.map((id, i) => (
        <District key={id} id={id} index={i} />
      ))}
    </>
  );
}

function District({ id, index }: { id: string; index: number }) {
  useStore((s) => s.version);
  const selected = useStore((s) => s.selected === id);
  const s = world.sessions[id];
  const group = useRef<Group>(null);
  const bars = useRef<InstancedMesh>(null);
  const cont = useRef<InstancedMesh>(null);
  const selRing = useRef<Mesh>(null);
  const blob = useRef<Mesh>(null);
  const pool = useRef<Mesh>(null);
  const beacon = useRef<Mesh>(null);
  const placed = useRef(false);
  const fade = useRef(0);
  const lastFade = useRef(-1);
  const rt = useMemo(() => sim.rt(id, null), [id]);

  const machine = s?.machine ?? "unknown";
  const conductor = s?.role === "conductor";
  const label = s?.label ?? id.slice(0, 8);
  const info = machineInfo(machine);
  const R = conductor ? 5.0 : 4.3;

  const res = useMemo(() => {
    const fadables: Fadable[] = [];
    const std = (o: ConstructorParameters<typeof MeshStandardMaterial>[0]) => {
      const m = new MeshStandardMaterial(o);
      fadables.push({ mat: m, base: m.color.clone(), ei: m.emissiveIntensity });
      return m;
    };
    const basic = (o: ConstructorParameters<typeof MeshBasicMaterial>[0]) => {
      const m = new MeshBasicMaterial(o);
      fadables.push({ mat: m, base: m.color.clone() });
      return m;
    };
    const glow = glowTexture();
    return {
      fadables,
      slab: std({ color: "#1a232b", metalness: 0.85, roughness: 0.42, envMapIntensity: 1.2 }),
      top: std({ map: padTexture(info.hex), color: "#d8e8f0", metalness: 0.7, roughness: 0.3, envMapIntensity: 1.0 }),
      bar: basic({ color: "#ffffff", toneMapped: false }),
      cont: std({ map: containerTexture("#ffffff"), color: "#ffffff", metalness: 0.4, roughness: 0.55 }),
      mast: std({ color: "#1c262d", metalness: 0.8, roughness: 0.4 }),
      sign: basic({ map: labelTexture(label, info.label + (conductor ? "  CARRIER" : ""), info.hex), transparent: true, color: new Color(1.5, 1.5, 1.5), toneMapped: false, depthWrite: false }),
      glowMat: new MeshBasicMaterial({ map: glow, color: new Color(info.hex).multiplyScalar(0.9), transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false, fog: false }),
      blobMat: new MeshBasicMaterial({ map: glow, color: "#000", transparent: true, opacity: 0.55, depthWrite: false, fog: false }),
      selMat: new MeshBasicMaterial({ color: new Color("#ffffff").multiplyScalar(2.4), transparent: true, opacity: 0.8, depthWrite: false, blending: AdditiveBlending, toneMapped: false }),
      beaconMat: new MeshBasicMaterial({ color: new Color(info.hex).multiplyScalar(3), toneMapped: false }),
    };
  }, [info.hex, info.label, label, conductor]);

  const layout = useMemo(() => {
    const r = rngFrom(hash(id));
    const items: { x: number; y: number; z: number; ry: number; c: string }[] = [];
    // containers hug the back and side flats of the octagon, aligned to the flat they sit against
    const flats = conductor ? [3, 5, 2] : [3, 4, 5, 2, 6];
    for (const f of flats) {
      const th = (f * Math.PI) / 4;
      for (const off of [-1.15, 1.15]) {
        if (r() < 0.38) continue;
        const d = R * 0.924 + 1.0;
        const c = CONTAINER_COLORS[Math.floor(r() * CONTAINER_COLORS.length)];
        const h = r() < 0.35 ? 2 : 1;
        for (let k = 0; k < h; k++)
          items.push({ x: Math.sin(th) * d + Math.cos(th) * off, y: 0.58 + k * 1.12, z: Math.cos(th) * d - Math.sin(th) * off, ry: th, c });
      }
    }
    return items;
  }, [id, R, conductor]);

  useLayoutEffect(() => {
    const o = new Object3D();
    const col = new Color();
    layout.forEach((it, i) => {
      o.position.set(it.x, it.y, it.z);
      o.rotation.set(0, it.ry, 0);
      o.updateMatrix();
      cont.current!.setMatrixAt(i, o.matrix);
      cont.current!.setColorAt(i, col.set(it.c).multiplyScalar(0.55));
    });
    cont.current!.count = layout.length;
    cont.current!.instanceMatrix.needsUpdate = true;
    if (cont.current!.instanceColor) cont.current!.instanceColor.needsUpdate = true;
    // static bar transforms
    for (let i = 0; i < 8; i++) {
      const th = (i * Math.PI) / 4;
      o.position.set(Math.sin(th) * R * 0.924, 0.46, Math.cos(th) * R * 0.924);
      o.rotation.set(0, th, 0);
      o.scale.set(1, 1, 1);
      o.updateMatrix();
      bars.current!.setMatrixAt(i, o.matrix);
    }
    bars.current!.instanceMatrix.needsUpdate = true;
  }, [layout, R]);

  const c1 = useMemo(() => new Color(), []);
  const hexColor = useMemo(() => new Color(info.hex), [info.hex]);
  const amber = useMemo(() => new Color("#ff9d2e"), []);

  useFrame((st, dt) => {
    const g = group.current;
    if (!g) return;
    const sess = world.sessions[id];
    const [tx, tz] = slotPos(index);
    if (!placed.current) { g.position.set(tx, 0, tz); placed.current = true; }
    else {
      g.position.x = damp(g.position.x, tx, 3.2, dt);
      g.position.z = damp(g.position.z, tz, 3.2, dt);
    }
    const t = st.clock.elapsedTime;
    const state = sess?.state ?? "ended";
    const target = state === "ended" ? 0.3 : 1;
    fade.current = damp(fade.current, target, state === "ended" ? 0.5 : 2.5, dt);
    const f = fade.current;
    if (Math.abs(f - lastFade.current) > 0.004) {
      lastFade.current = f;
      for (const fd of res.fadables) {
        fd.mat.color.copy(fd.base).multiplyScalar(f);
        if (fd.ei !== undefined) (fd.mat as MeshStandardMaterial).emissiveIntensity = fd.ei * f;
      }
    }
    // edge lights: chase when active, slow breathing amber when idle, dim when ended
    const b = bars.current;
    if (b) {
      for (let i = 0; i < 8; i++) {
        let v: number;
        if (state === "active") {
          const ph = (t * 1.6 - i / 8) % 1;
          v = 0.7 + 2.6 * Math.pow(Math.max(0, 1 - ph * 2.2), 2) + Math.min(1.2, rt.rate * 0.15);
          c1.copy(hexColor);
        } else if (state === "idle") {
          v = 0.35 + 0.25 * Math.sin(t * 1.1 + i * 0.4);
          c1.copy(amber);
        } else {
          v = 0.12;
          c1.copy(hexColor);
        }
        c1.multiplyScalar(v * f);
        b.setColorAt(i, c1);
      }
      b.instanceColor!.needsUpdate = true;
    }
    // light pool + blob shadow follow the craft
    const pw = state === "active" ? 1 : state === "idle" ? 0.35 : 0.08;
    if (pool.current) {
      pool.current.position.set(rt.pos.x, 0.5, rt.pos.z);
      (pool.current.material as MeshBasicMaterial).opacity = (conductor ? 0.5 : 0.7) * pw * f;
    }
    if (blob.current) {
      blob.current.position.set(rt.pos.x, 0.47, rt.pos.z);
      const hgt = Math.max(0, rt.pos.y - 0.4);
      const sc = (conductor ? 8 : 2.6) * (1 + hgt * 0.08);
      blob.current.scale.set(sc, sc * (conductor ? 0.55 : 1), 1);
      (blob.current.material as MeshBasicMaterial).opacity = Math.max(0.15, 0.6 - hgt * 0.1) * f;
    }
    if (selRing.current) {
      selRing.current.visible = selected;
      if (selected) selRing.current.scale.setScalar(1 + 0.03 * Math.sin(t * 5));
    }
    if (beacon.current) {
      const blink = state === "active" ? (Math.sin(t * 6 + index) > 0 ? 1 : 0.25) : state === "idle" ? 0.5 : 0.1;
      res.beaconMat.color.copy(state === "idle" ? amber : hexColor).multiplyScalar(3 * blink * f);
    }
  });

  if (!s) return null;
  const subs = Object.values(s.subagents);

  return (
    <group ref={group}>
      {/* pad */}
      <mesh position-y={0.175} material={res.slab}>
        <cylinderGeometry args={[R + 0.32, R + 0.4, 0.35, 8, 1, false, Math.PI / 8]} />
      </mesh>
      <mesh position-y={0.37} material={res.top}>
        <cylinderGeometry args={[R, R, 0.04, 8, 1, false, Math.PI / 8]} />
      </mesh>
      <instancedMesh ref={bars} args={[undefined, undefined, 8]} material={res.bar} frustumCulled={false}>
        <boxGeometry args={[R * 0.62, 0.1, 0.16]} />
      </instancedMesh>
      <instancedMesh ref={cont} args={[undefined, undefined, 24]} material={res.cont} frustumCulled={false}>
        <boxGeometry args={[2.1, 1.1, 1.05]} />
      </instancedMesh>

      {/* decals */}
      <mesh ref={blob} rotation-x={-Math.PI / 2} material={res.blobMat} renderOrder={1}>
        <planeGeometry args={[1, 1]} />
      </mesh>
      <mesh ref={pool} rotation-x={-Math.PI / 2} material={res.glowMat} renderOrder={1} scale={conductor ? [11, 7, 1] : [7, 7, 1]}>
        <planeGeometry args={[1, 1]} />
      </mesh>
      <mesh ref={selRing} rotation-x={-Math.PI / 2} position-y={0.5} material={res.selMat} visible={false}>
        <ringGeometry args={[R + 0.55, R + 0.75, 8, 1, Math.PI / 8]} />
      </mesh>

      {/* control mast + holographic label */}
      <group position={[-R * 0.84, 0, R * 1.12]}>
        <mesh position-y={0.2} material={res.mast}><boxGeometry args={[0.7, 0.4, 0.7]} /></mesh>
        <mesh position-y={1.9} material={res.mast}><cylinderGeometry args={[0.07, 0.1, 3.4, 8]} /></mesh>
        <mesh position={[0, 3.25, 0]} rotation={[0.5, 0.6, 0]} material={res.mast}><coneGeometry args={[0.38, 0.22, 14, 1, true]} /></mesh>
        <mesh ref={beacon} position={[0, 3.62, 0]} material={res.beaconMat}><sphereGeometry args={[0.13, 10, 8]} /></mesh>
        <mesh position={[1.55, 2.3, 0.05]} material={res.sign} renderOrder={4}>
          <planeGeometry args={[2.9, 1.09]} />
        </mesh>
        <mesh position={[0.62, 1.25, 0]} material={res.mast}><boxGeometry args={[0.05, 2.1, 0.05]} /></mesh>
      </group>

      {/* craft */}
      <SessionCraft id={id} machine={machine} conductor={!!conductor} />
      {subs.map((sa, i) => (
        <SubDrone key={sa.id} sessionId={id} subId={sa.id} index={i} machine={machine} parentConductor={!!conductor} />
      ))}
    </group>
  );
}

export const _cfg = CFG;
