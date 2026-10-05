import { useEffect } from "react";
import { Scene } from "./Scene";
import { Hud, Inspect, Legend } from "./ui";
import { startFeed } from "./feed";

export default function App() {
  useEffect(() => startFeed(), []);
  return (
    <>
      <Scene />
      <div className="side">
        <Hud />
        <Inspect />
        <Legend />
      </div>
    </>
  );
}
