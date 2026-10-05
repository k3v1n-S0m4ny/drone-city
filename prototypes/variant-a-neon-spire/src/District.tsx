import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  MeshBasicMaterial,
  Vector3,
  type ShaderMaterial,
} from "three";
import { labelEls, rateEls } from "./labels";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { BLOCK, GLIDE, machineColor, slotOf } from "./config";
import { DroneUnit } from "./Drone";
import { getRT, hash32, type Layout } from "./runtime";
import { makeTowerMaterial } from "./shaders";
import { useStore } from "./store";

export const SLAB_H = 0.35;
const LABEL_POS = new Vector3(0, 0.1, BLOCK * 0.7071 + 1.0);
const tmpV = new Vector3();

export interface TowerSpec {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  baseY: number;
  seed: number;
  tower: number;
}

/** Merge a list of towers into ONE geometry (one draw call). The shader reads
 *  local coordinates via aOff so windows/edges stay glued to each tower. */
export function buildTowers(list: TowerSpec[]): BufferGeometry {
  const parts = list.map((t) => {
    const g = new BoxGeometry(t.w, t.h, t.d);
    g.translate(t.x, t.baseY + t.h / 2, t.z);
    const n = g.getAttribute("position").count;
    const fill = (vals: number[]) => {
      const a = new Float32Array(n * vals.length);
      for (let i = 0; i < n; i++) vals.forEach((v, k) => (a[i * vals.length + k] = v));
      return a;
    };
    g.setAttribute("aSeed", new BufferAttribute(fill([t.seed]), 1));
    g.setAttribute("aTower", new BufferAttribute(fill([t.tower]), 1));
    g.setAttribute("aSize", new BufferAttribute(fill([t.w, t.h, t.d]), 3));
    g.setAttribute("aOff", new BufferAttribute(fill([t.x, t.baseY, t.z]), 3));
    return g;
  });
  return mergeGeometries(parts, false)!;
}

let glowTex: CanvasTexture | null = null;
function radialTex() {
  if (glowTex) return glowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, "rgba(255,255,255,1)");
  gr.addColorStop(0.45, "rgba(255,255,255,0.35)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  glowTex = new CanvasTexture(c);
  return glowTex;
}

const SLAB_GEO = (() => {
  const h = SLAB_H;
  const e = 0.07;
  const half = BLOCK / 2;
  return new BoxGeometry(BLOCK, h, BLOCK).translate(0, h / 2, 0);
})();
const STRIP_GEO = (() => {
  const h = SLAB_H;
  const e = 0.07;
  const half = BLOCK / 2;
  const mk = (w: number, d: number, x: number, z: number) => new BoxGeometry(w, 0.025, d).translate(x, h + 0.005, z);
  return mergeGeometries([
    mk(BLOCK, e, 0, half - e / 2),
    mk(BLOCK, e, 0, -half + e / 2),
    mk(e, BLOCK, half - e / 2, 0),
    mk(e, BLOCK, -half + e / 2, 0),
  ])!;
})();
const slabMat = new MeshBasicMaterial({ color: "#0a0a1d" });

function Body({ geo, mat, edge, reflect }: { geo: BufferGeometry; mat: ShaderMaterial; edge: MeshBasicMaterial; reflect?: boolean }) {
  if (reflect) {
    return (
      <group scale={[1, -1, 1]}>
        <mesh geometry={geo} material={mat} />
      </group>
    );
  }
  return (
    <group>
      <mesh geometry={SLAB_GEO} material={slabMat} />
      <mesh geometry={STRIP_GEO} material={edge} />
      <mesh geometry={geo} material={mat} />
    </group>
  );
}

export function District({ id, index }: { id: string; index: number }) {
  useStore((s) => s.struct);
  const session = useStore.getState().sessions[id];
  const selected = useStore((s) => s.selectedId === id);
  const rt = getRT(id);
  const groupRef = useRef<Group>(null);
  const glowRef = useRef<MeshBasicMaterial>(null);
  const init = useRef(false);
  const lastRate = useRef(0);

  const geo = useMemo(() => {
    const seedBase = (hash32(id) % 1000) / 1000;
    return buildTowers(
      rt.layout.towers.map((t, i) => ({ ...t, baseY: SLAB_H, seed: seedBase + i * 0.137, tower: i })),
    );
  }, [id, rt.layout]);
  const mats = useMemo(() => {
    const a = makeTowerMaterial(false);
    const b = makeTowerMaterial(true);
    for (const m of [a, b]) {
      m.uniforms.uHue.value = rt.layout.hue;
      // per-district palette bias: lean magenta or cyan
      const k = rt.layout.hue;
      m.uniforms.uA.value.set(k < 0.5 ? "#ff2fd0" : "#a74dff");
      m.uniforms.uB.value.set(k < 0.5 ? "#19e6ff" : "#2fd3ff");
    }
    return [a, b];
  }, [rt.layout]);
  const edge = useMemo(
    () => new MeshBasicMaterial({ color: new Color(session ? machineColor(session.machine) : "#fff").multiplyScalar(2.2), toneMapped: false }),
    [session?.machine],
  );

  const slot = slotOf(index);
  const tx = slot.x;
  const tz = slot.z;
  const sel = useRef(0);
  const act = useRef(0);
  const dim = useRef(0);

  useFrame((state, dt0) => {
    const dt = Math.min(dt0, 0.05);
    const g = groupRef.current;
    if (!g || !session) return;
    const t = state.clock.elapsedTime;
    if (!init.current) {
      init.current = true;
      g.position.set(tx, -4, tz + 3);
    }
    const f = 1 - Math.exp(-dt * GLIDE);
    const ty = session.state === "active" ? 0 : session.state === "idle" ? -0.9 : -2.3;
    g.position.x += (tx - g.position.x) * f;
    g.position.z += (tz - g.position.z) * f;
    g.position.y += (ty - g.position.y) * (1 - Math.exp(-dt * 2.2));

    // activity: smoothed rate -> 0..1
    const target = session.state === "active" ? Math.min(1, rt.rate / 30) : 0;
    act.current += (target - act.current) * (1 - Math.exp(-dt * 3));
    const dTarget = session.state === "active" ? 1 : session.state === "idle" ? 0.5 : 0.1;
    dim.current += (dTarget - dim.current) * (1 - Math.exp(-dt * 1.5));
    sel.current += ((selected ? 1 : 0) - sel.current) * (1 - Math.exp(-dt * 6));
    for (let i = 0; i < 6; i++) rt.towerPulse[i] = Math.max(0, rt.towerPulse[i] - dt * 2.2);
    for (const m of mats) {
      const u = m.uniforms;
      u.uTime.value = t;
      u.uAct.value = act.current;
      u.uDim.value = dim.current;
      u.uSelect.value = sel.current;
      for (let i = 0; i < 6; i++) {
        u.uPulse.value[i] = rt.towerPulse[i];
        u.uPulseCol.value[i].set(rt.towerColor[i]);
      }
    }
    if (glowRef.current) glowRef.current.opacity = 0.04 + 0.14 * act.current * dim.current + sel.current * 0.15;
    // rate readout + projected DOM label
    const re = rateEls.get(id);
    if (re && Math.abs(rt.rate - lastRate.current) > 0.5) {
      lastRate.current = rt.rate;
      re.textContent = rt.rate >= 4 ? `${Math.round(rt.rate)}/s` : "";
    }
    const le = labelEls.get(id);
    if (le) {
      g.updateWorldMatrix(true, false);
      tmpV.copy(LABEL_POS);
      g.localToWorld(tmpV);
      tmpV.project(state.camera);
      const x = (tmpV.x * 0.5 + 0.5) * state.size.width;
      const y = (-tmpV.y * 0.5 + 0.5) * state.size.height;
      le.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
      le.style.visibility = "visible";
    }
  });

  if (!session) return null;
  const mcol = machineColor(session.machine);
  return (
    <group ref={groupRef}>
      <group rotation-y={-Math.PI / 4}>
      <Body geo={geo} mat={mats[0]} edge={edge} />
      <Body geo={geo} mat={mats[1]} edge={edge} reflect />
      {/* soft light pool on the street around the block */}
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[BLOCK * 2.1, BLOCK * 2.1]} />
        <meshBasicMaterial
          ref={glowRef}
          map={radialTex()}
          color={rt.layout.hue < 0.5 ? "#ff2fd0" : "#7a4dff"}
          transparent
          opacity={0.2}
          depthWrite={false}
          blending={AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
      <DroneUnit session={session} rt={rt} selected={selected} />
      </group>
    </group>
  );
}

export type { Layout };
