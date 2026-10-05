import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, ChromaticAberration, EffectComposer, Noise, Scanline, Vignette } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import * as THREE from "three";
import { CFG, PALETTE } from "./config";
import { CAM_DIR, CAM_DIST, CITY_ROT, FOG_FAR, FOG_NEAR, SIN_ELEV, slotH, slotPos, slotW } from "./iso";
import { makeGroundMat } from "./glow";
import { useCity } from "./store";
import { District, type Slot } from "./District";

export const PANEL_W = 340;
/** debug: ?fx=none | nobloom,nonoise,nomsaa */
const FX = new Set((new URLSearchParams(location.search).get("fx") ?? "").split(","));

/** scroll state shared with the HUD */
export const scroll = { v: 0, target: 0, max: 0, rows: 0, zoom: 40, T: new THREE.Vector3() };
const slots = new Map<string, Slot>();

// ------------------------------------------------------------------ camera --
function Rig() {
  const { camera, size, gl } = useThree();
  const cam = camera as THREE.OrthographicCamera;
  const panel = size.width > 900 ? PANEL_W : 0;

  const zoom = useMemo(() => {
    const content = (CFG.COLS + 0.5) * slotW() * 1.16;
    return Math.max(18, Math.min(80, (size.width - panel) / content));
  }, [size.width, panel]);

  useEffect(() => {
    cam.zoom = zoom;
    cam.near = 1;
    cam.far = 400;
    cam.updateProjectionMatrix();
    scroll.zoom = zoom;
  }, [cam, zoom]);

  useEffect(() => {
    const el = gl.domElement;
    const vPerPx = () => 1 / (scroll.zoom * SIN_ELEV);
    const clamp = () => (scroll.target = Math.max(0, Math.min(scroll.max, scroll.target)));
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      scroll.target += e.deltaY * 0.03;
      clamp();
    };
    let down = false;
    let lastY = 0;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      down = true;
      lastY = e.clientY;
    };
    const onMove = (e: PointerEvent) => {
      if (!down) return;
      scroll.target -= (e.clientY - lastY) * vPerPx();
      lastY = e.clientY;
      clamp();
    };
    const onUp = () => (down = false);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [gl]);

  useFrame((state, dt) => {
    (window as unknown as { __r3f: unknown }).__r3f = state; // debug hook (renderer.info)
    const halfV = size.height / zoom / 2 / SIN_ELEV;
    const lastRowBottom = Math.max(0, scroll.rows - 1) * slotH() + CFG.HEX_R + 3;
    scroll.max = Math.max(0, lastRowBottom - 2 * halfV + 11);
    scroll.target = Math.max(0, Math.min(scroll.max, scroll.target));
    scroll.v += (scroll.target - scroll.v) * (1 - Math.exp(-Math.min(dt, 0.1) * 8));
    const u = panel / 2 / zoom;
    const v = scroll.v + halfV - 11;
    // city frame (u right, v down-screen) -> world: city group is rotated PI/4 about Y
    const c = Math.cos(CITY_ROT), s = Math.sin(CITY_ROT);
    scroll.T.set(u * c + v * s, 0, -u * s + v * c);
    cam.position.set(scroll.T.x + CAM_DIR.x * CAM_DIST, CAM_DIR.y * CAM_DIST, scroll.T.z + CAM_DIR.z * CAM_DIST);
    cam.lookAt(scroll.T);
  });
  return null;
}

// ------------------------------------------------------------------ ground --
function Ground() {
  const mat = useMemo(makeGroundMat, []);
  const ref = useRef<THREE.Mesh>(null);
  useFrame((s) => {
    mat.uniforms.uTime.value = s.clock.elapsedTime;
    mat.uniforms.uTarget.value.set(scroll.T.x, scroll.T.z);
    ref.current?.position.set(scroll.T.x, -0.03, scroll.T.z);
  });
  return (
    <mesh ref={ref} rotation-x={-Math.PI / 2} renderOrder={-10}>
      <planeGeometry args={[320, 320]} />
      <primitive object={mat} attach="material" />
    </mesh>
  );
}

// ---------------------------------------------------------------- districts --
function DistrictHost({ id }: { id: string }) {
  const d = useMemo(() => new District(useCity.getState().sessions[id]), [id]);
  useEffect(() => () => d.dispose(), [d]);
  useFrame((state, dt) => {
    const st = useCity.getState();
    const s = st.sessions[id];
    const slot = slots.get(id);
    if (!s || !slot) return;
    d.update(Math.min(dt, 0.05), state.clock.elapsedTime, performance.now(), s, slot, st.selectedId === id);
  });
  return (
    <primitive
      object={d.root}
      onClick={(e: { delta: number; stopPropagation: () => void }) => {
        if (e.delta > 6) return;
        e.stopPropagation();
        useCity.getState().select(id);
      }}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "")}
    />
  );
}

const RANK = { active: 0, idle: 1, ended: 2 } as const;

function City() {
  const [order, setOrder] = useState<string[]>([]);
  useEffect(() => {
    let prev: string[] = [];
    const compute = () => {
      const ss = Object.values(useCity.getState().sessions);
      const idx = new Map(prev.map((id, i) => [id, i]));
      ss.sort(
        (a, b) =>
          RANK[a.state] - RANK[b.state] ||
          Math.floor(b.lastEventAt / 6000) - Math.floor(a.lastEventAt / 6000) ||
          (idx.get(a.id) ?? 1e9) - (idx.get(b.id) ?? 1e9) ||
          a.id.localeCompare(b.id),
      );
      const ids = ss.map((s) => `${s.id}`);
      slots.clear();
      ss.forEach((s, i) => {
        const [x, z] = slotPos(i);
        slots.set(s.id, { x, z, state: s.state });
      });
      scroll.rows = Math.ceil(ids.length / CFG.COLS);
      prev = ids;
      setOrder((o) => (o.length === ids.length && o.every((v, i) => v === ids[i]) ? o : ids));
    };
    compute();
    const iv = setInterval(compute, CFG.REORDER_EVERY_MS);
    const unsub = useCity.subscribe((st) => {
      const ss = Object.values(st.sessions);
      if (ss.length !== slots.size || ss.some((s) => slots.get(s.id)?.state !== s.state)) compute();
    });
    return () => {
      clearInterval(iv);
      unsub();
    };
  }, []);
  const roles = useCity((s) => s.sessions);
  return (
    <group rotation-y={CITY_ROT}>
      {order.map((id) => (
        <DistrictHost key={id + ":" + (roles[id]?.role ?? "session")} id={id} />
      ))}
    </group>
  );
}

// ------------------------------------------------------------------- main ---
export function Scene() {
  return (
    <Canvas
      orthographic
      dpr={[1, 2]}
      camera={{ position: [70, 70, 70], zoom: 40, near: 1, far: 400 }}
      gl={{ antialias: false, powerPreference: "high-performance" }}
      onPointerMissed={() => useCity.getState().select(null)}
    >
      <color attach="background" args={[PALETTE.bg]} />
      <fog attach="fog" args={[PALETTE.bg, FOG_NEAR, FOG_FAR]} />
      <Rig />
      <Ground />
      <City />
      {FX.has("none") ? null : (
        <EffectComposer multisampling={FX.has("nomsaa") || window.devicePixelRatio >= 1.5 ? 0 : 4}>
          <Bloom mipmapBlur intensity={FX.has("nobloom") ? 0 : 0.9} luminanceThreshold={0.32} luminanceSmoothing={0.4} radius={0.7} />
          <ChromaticAberration offset={new THREE.Vector2(0.0013, 0.0009)} radialModulation modulationOffset={0.25} />
          <Noise premultiply blendFunction={BlendFunction.SOFT_LIGHT} opacity={FX.has("nonoise") ? 0 : 0.09} />
          <Scanline blendFunction={BlendFunction.OVERLAY} density={1.25} opacity={0.1} />
          <Vignette eskil={false} offset={0.28} darkness={0.8} />
        </EffectComposer>
      )}
    </Canvas>
  );
}
