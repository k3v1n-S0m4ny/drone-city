import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, Lightformer } from "@react-three/drei";
import { Bloom, EffectComposer, Noise, ToneMapping, Vignette } from "@react-three/postprocessing";
import { BlendFunction, ToneMappingMode } from "postprocessing";
import { useEffect } from "react";
import { MathUtils, NoToneMapping, OrthographicCamera } from "three";
import { CFG } from "../config";
import { select, useStore } from "../store";
import { FogLayers, Rain, Ripples } from "./Atmosphere";
import { Districts } from "./District";
import { Harbor } from "./Harbor";
import { BASE_Z, SQ, view } from "./view";

const LOW = new URLSearchParams(location.search).get("q") === "low"; // ?q=low: for software GL / screenshots
const EL = (CFG.ELEVATION_DEG * Math.PI) / 180;
const DIST = 90;
const OFF = { x: DIST * Math.cos(EL) * SQ, y: DIST * Math.sin(EL), z: DIST * Math.cos(EL) * SQ };
const SIN_EL = Math.sin(EL);

function CameraRig() {
  const { camera, size } = useThree();
  useEffect(() => {
    const maxFor = () => {
      const n = useStore.getState().order.length;
      const rows = Math.max(1, Math.ceil(n / CFG.COLUMNS));
      return Math.max(0, (rows - 2.6) * CFG.ROW_H);
    };
    const clampS = (v: number) => MathUtils.clamp(v, 0, maxFor());
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const mult = e.deltaMode === 1 ? 33 : 1;
      view.scrollTarget = clampS(view.scrollTarget + e.deltaY * mult * CFG.SCROLL_WHEEL_SPEED);
    };
    let drag: { y: number; s: number; moved: boolean } | null = null;
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement)?.closest(".panel, .legend")) return;
      drag = { y: e.clientY, s: view.scrollTarget, moved: false };
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const dy = e.clientY - drag.y;
      if (Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) {
        view.scrollTarget = clampS(drag.s - dy / (view.zoom * SIN_EL));
        view.scroll = view.scrollTarget; // follow the finger 1:1
      }
    };
    const up = () => { drag = null; };
    const key = (e: KeyboardEvent) => {
      const page = CFG.ROW_H;
      if (e.key === "ArrowDown" || e.key === "PageDown") view.scrollTarget = clampS(view.scrollTarget + page);
      if (e.key === "ArrowUp" || e.key === "PageUp") view.scrollTarget = clampS(view.scrollTarget - page);
      if (e.key === "Home") view.scrollTarget = 0;
      if (e.key === "End") view.scrollTarget = maxFor();
    };
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key);
    };
  }, []);

  useFrame((_, dt) => {
    const cam = camera as OrthographicCamera;
    const n = useStore.getState().order.length;
    const rows = Math.max(1, Math.ceil(n / CFG.COLUMNS));
    view.maxScroll = Math.max(0, (rows - 2.6) * CFG.ROW_H);
    view.scrollTarget = MathUtils.clamp(view.scrollTarget, 0, view.maxScroll);
    view.scroll += (view.scrollTarget - view.scroll) * (1 - Math.exp(-dt * 7));
    const zoom = Math.min(size.width / CFG.VIEW_W_UNITS, size.height / CFG.VIEW_H_UNITS);
    if (Math.abs(cam.zoom - zoom) > 0.01) {
      cam.zoom = zoom;
      cam.updateProjectionMatrix();
    }
    view.zoom = zoom;
    const tz = BASE_Z + view.scroll;
    view.target.set(tz * SQ, 0, tz * SQ);
    cam.position.set(view.target.x + OFF.x, OFF.y, view.target.z + OFF.z);
    cam.lookAt(view.target);
    cam.updateMatrixWorld();
  });
  return null;
}

export function Scene() {
  return (
    <Canvas
      orthographic
      dpr={LOW ? 1 : [1, 1.5]}
      camera={{ position: [OFF.x, OFF.y, OFF.z], zoom: 36, near: 0.1, far: 400 }}
      gl={{ antialias: false, powerPreference: "high-performance", toneMapping: NoToneMapping }}
      onPointerMissed={() => select(null)}
      onCreated={(st) => { (window as any).__three = st; }}
    >
      <color attach="background" args={["#03070b"]} />
      <fog attach="fog" args={["#04090e", 78, 150]} />
      <CameraRig />

      <ambientLight intensity={0.32} color="#6fa7b8" />
      <directionalLight position={[-30, 40, -20]} intensity={1.1} color="#7fe9ff" />
      <directionalLight position={[40, 22, 30]} intensity={0.7} color="#ff9d4a" />
      <hemisphereLight args={["#2a5666", "#120c08", 0.3]} />

      <Environment resolution={256} frames={1}>
        <Lightformer form="rect" intensity={5} color="#19e3d0" position={[-12, 8, -10]} scale={[26, 4, 1]} rotation-y={Math.PI / 4} />
        <Lightformer form="rect" intensity={5} color="#ff9d2e" position={[14, 7, 12]} scale={[24, 3, 1]} rotation-y={-Math.PI * 0.75} />
        <Lightformer form="rect" intensity={2.2} color="#7aa9ff" position={[0, 14, 0]} scale={[30, 30, 1]} rotation-x={Math.PI / 2} />
        <Lightformer form="ring" intensity={4} color="#ffffff" position={[0, 6, -14]} scale={4} />
      </Environment>

      <group rotation-y={Math.PI / 4}>
        <Harbor />
        <Districts />
      </group>

      <Ripples />
      <FogLayers />
      <Rain />

      <EffectComposer multisampling={LOW ? 0 : 4}>
        <Bloom intensity={1.15} luminanceThreshold={0.62} luminanceSmoothing={0.3} mipmapBlur radius={0.72} />
        <Vignette eskil={false} offset={0.22} darkness={0.8} />
        <Noise opacity={0.05} blendFunction={BlendFunction.SOFT_LIGHT} />
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      </EffectComposer>
    </Canvas>
  );
}
