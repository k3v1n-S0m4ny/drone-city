import { Environment, Lightformer } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { useEffect, useMemo, useRef } from "react";
import { Vector3 } from "three";
import { CAM_DIST, FOG_FAR, FOG_NEAR, PITCH, PITCH_X, slotOf } from "./config";
import { District, SLAB_H, buildTowers, type TowerSpec } from "./District";
import { Bubbles } from "./Bubbles";
import { rng } from "./runtime";
import { makeGroundMaterial, makeTowerMaterial } from "./shaders";
import { useStore } from "./store";

const ROT = Math.PI / 4; // grid axes align with screen axes under the iso camera
const FOG = "#07031a";

const camTarget = new Vector3();
const scroll = { target: 10, value: 10, min: 10, max: 10 };
export const scrollApi = scroll;

function CameraRig() {
  const { camera, gl } = useThree();
  Object.assign(window, { __cam: camera, __gl: gl }); // debug handles
  const count = useStore((s) => s.order.length);

  useEffect(() => {
    scroll.min = 10;
    scroll.max = Math.max(scroll.min, slotOf(Math.max(0, count - 1)).z + 3);
    scroll.target = Math.min(scroll.max, Math.max(scroll.min, scroll.target));
  }, [count]);

  useEffect(() => {
    const el = gl.domElement;
    const PX_PER_Z = 23; // approx screen px per local-z unit (ortho zoom * sin(35.26deg))
    const clampT = () => (scroll.target = Math.min(scroll.max, Math.max(scroll.min, scroll.target)));
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
      scroll.target += dy / PX_PER_Z;
      clampT();
    };
    let drag: { y: number } | null = null;
    const down = (e: PointerEvent) => {
      drag = { y: e.clientY };
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const dy = e.clientY - drag.y;
      drag.y = e.clientY;
      scroll.target -= dy / PX_PER_Z;
      clampT();
    };
    const up = () => (drag = null);
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [gl]);

  useFrame((_, dt) => {
    scroll.value += (scroll.target - scroll.value) * (1 - Math.exp(-Math.min(dt, 0.05) * 9));
    // local (0,0,z) rotated by ROT about Y
    camTarget.set(Math.sin(ROT) * scroll.value, 2.2, Math.cos(ROT) * scroll.value);
    const k = CAM_DIST / Math.sqrt(3);
    camera.position.set(camTarget.x + k, camTarget.y + k, camTarget.z + k);
    camera.lookAt(camTarget);
  });
  return null;
}

/** Static background skyline + the reflective street. Everything is built once. */
function Backdrop() {
  const groundMat = useMemo(() => makeGroundMaterial(), []);
  const fill = useMemo(() => {
    const r = rng(7771);
    const list: TowerSpec[] = [];
    const S2 = Math.SQRT2;
    // world-axis lattice cells (same lattice the districts sit on)
    for (let i = -26; i <= 26; i++) {
      for (let j = -26; j <= 26; j++) {
        const wx = i * PITCH;
        const wz = j * PITCH;
        const lx = (wx - wz) / S2;
        const lz = (wx + wz) / S2;
        const inDistrictBand = Math.abs(lx) < PITCH_X + 6.5;
        if (lz > 46 || lz < -64 || Math.abs(lx) > 62) continue;
        if (inDistrictBand && lz > -6.5) continue; // keep the city floor free for districts
        if (r() < 0.08) continue;
        const dist = Math.hypot(lx * 0.6, lz + 6) * 0.5;
        const n = r() < 0.5 ? 2 : 1;
        for (let k = 0; k < n; k++) {
          const w = n === 2 ? 2.0 + r() * 1.2 : 2.8 + r() * 2.0;
          const d = n === 2 ? 2.0 + r() * 1.2 : 2.8 + r() * 2.0;
          const ox = n === 2 ? (k ? 1.3 : -1.3) : 0;
          const oz = n === 2 ? (k ? -1.3 : 1.3) : 0;
          list.push({
            x: wx + ox + (r() - 0.5) * 0.3,
            z: wz + oz + (r() - 0.5) * 0.3,
            w,
            d,
            h: 3 + r() * 4 + dist * (0.18 + r() * 0.3),
            baseY: 0,
            seed: r() * 50,
            tower: 0,
          });
        }
      }
    }
    return list;
  }, []);
  const fillGeo = useMemo(() => buildTowers(fill), [fill]);
  const [fMat, fMatR] = useMemo(() => {
    const a = makeTowerMaterial(false);
    const b = makeTowerMaterial(true);
    for (const m of [a, b]) {
      m.uniforms.uAct.value = 0.12;
      m.uniforms.uDim.value = 0.72;
      m.uniforms.uHue.value = 0.3;
    }
    return [a, b];
  }, []);
  const planeLen = 360;
  useFrame((s) => {
    groundMat.uniforms.uTime.value = s.clock.elapsedTime;
    fMat.uniforms.uTime.value = s.clock.elapsedTime;
    fMatR.uniforms.uTime.value = s.clock.elapsedTime;
  });
  return (
    <group>
      <mesh geometry={fillGeo} material={fMat} />
      <group scale={[1, -1, 1]}>
        <mesh geometry={fillGeo} material={fMatR} />
      </group>
      <mesh position={[0, 0, 0]} rotation={[-Math.PI / 2, 0, 0]} material={groundMat} renderOrder={-1}>
        <planeGeometry args={[planeLen, planeLen]} />
      </mesh>
    </group>
  );
}

function Districts() {
  const order = useStore((s) => s.order);
  return (
    <>
      {order.map((id, i) => (
        <District key={id} id={id} index={i} />
      ))}
    </>
  );
}

export function CityScene() {
  return (
    <>
      <color attach="background" args={[FOG]} />
      <fog attach="fog" args={[FOG, FOG_NEAR, FOG_FAR]} />
      <ambientLight intensity={0.8} color="#5b4aa8" />
      <directionalLight position={[-6, 9, 4]} intensity={1.8} color="#35e6ff" />
      <directionalLight position={[7, 6, -5]} intensity={1.6} color="#ff3fd8" />
      <Environment resolution={64} frames={1}>
        <Lightformer form="rect" intensity={3} color="#ff2fd0" position={[-6, 4, 2]} scale={[8, 3, 1]} />
        <Lightformer form="rect" intensity={3} color="#19e6ff" position={[6, 3, -3]} scale={[8, 3, 1]} />
        <Lightformer form="ring" intensity={1.5} color="#8a6bff" position={[0, 8, 0]} rotation-x={Math.PI / 2} scale={6} />
      </Environment>
      <Backdrop />
      <group rotation-y={ROT}>
        <Districts />
      </group>
      <Bubbles />
      <CameraRig />
      <EffectComposer multisampling={0} enableNormalPass={false}>
        <Bloom intensity={1.25} luminanceThreshold={0.55} luminanceSmoothing={0.3} mipmapBlur radius={0.72} />
        <Noise opacity={0.045} />
        <Vignette eskil={false} offset={0.2} darkness={0.8} />
      </EffectComposer>
    </>
  );
}

void SLAB_H;
