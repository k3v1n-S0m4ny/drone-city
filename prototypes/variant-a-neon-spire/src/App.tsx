import { Canvas } from "@react-three/fiber";
import { useEffect } from "react";
import { CityScene } from "./City";
import { CAM_ZOOM } from "./config";
import { startFeed } from "./feed";
import { Hud } from "./Hud";

export default function App() {
  useEffect(() => startFeed(), []);
  return (
    <>
      <Canvas
        orthographic
        camera={{ zoom: CAM_ZOOM, near: 0.1, far: 500, position: [40, 40, 40] }}
        dpr={[1, 1.75]}
        gl={{ antialias: false, powerPreference: "high-performance" }}
        onPointerMissed={() => {
          /* keep selection on background drag; closed via panel button */
        }}
      >
        <CityScene />
      </Canvas>
      <Hud />
    </>
  );
}
