// Motion + placement for a session's craft (drone or carrier) and its subagent child drones.
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { Group, Vector3 } from "three";
import { select, world } from "../store";
import { DOCK_MS, LAUNCH_MS, sim } from "../sim";
import { DroneFx } from "./Fx";
import { CarrierModel, DroneModel } from "./Models";

const tmpV = new Vector3();
const damp = (cur: number, tgt: number, lambda: number, dt: number) => cur + (tgt - cur) * (1 - Math.exp(-lambda * dt));

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

function project(grp: Group, lift: number, rt: ReturnType<typeof sim.rt>, st: { camera: any; size: { width: number; height: number } }) {
  grp.getWorldPosition(tmpV);
  tmpV.y += lift;
  tmpV.project(st.camera);
  rt.screen.x = (tmpV.x * 0.5 + 0.5) * st.size.width;
  rt.screen.y = (-tmpV.y * 0.5 + 0.5) * st.size.height;
  rt.screen.on = tmpV.z < 1 && Math.abs(tmpV.x) < 1.3 && Math.abs(tmpV.y) < 1.3;
}

export function SessionCraft({ id, machine, conductor }: { id: string; machine: string; conductor: boolean }) {
  const rt = useMemo(() => sim.rt(id, null), [id]);
  const grp = useRef<Group>(null);
  const model = useRef<Group>(null);
  const power = useRef(0);
  const doors = useRef(0);
  const seed = useMemo(() => hash(id) * 10, [id]);
  const scaleRef = useRef(1);
  const k = conductor ? 1 : 1.5;

  useFrame((st, dt) => {
    const s = world.sessions[id];
    if (!s || !grp.current) return;
    const t = st.clock.elapsedTime;
    const now = performance.now();
    const active = s.state === "active";
    const ended = s.state === "ended";
    power.current = damp(power.current, active ? 1 : 0, 2.2, dt);
    const pw = power.current;
    const running = Object.values(s.subagents).filter((x) => x.state === "running").length;
    doors.current = damp(doors.current, Math.min(1, running / 4), 3, dt);
    scaleRef.current = damp(scaleRef.current, ended ? 0.001 : 1, 1.4, dt);

    const hoverY = conductor ? 3.7 : 2.85;
    const landY = conductor ? 1.55 : 0.85;
    const y = landY + (hoverY - landY) * pw + Math.sin(t * 1.6 + seed) * (conductor ? 0.07 : 0.1) * pw;
    const dx = Math.sin(t * 0.45 + seed) * (conductor ? 0.18 : 0.4) * pw;
    const dz = Math.cos(t * 0.37 + seed * 2) * (conductor ? 0.1 : 0.35) * pw;
    grp.current.position.set(dx, y, dz);
    rt.pos.set(dx, y, dz);
    grp.current.scale.setScalar(scaleRef.current * k);
    project(grp.current, conductor ? 2.2 : 1.5, rt, st);
    rt.screen.lift = conductor ? 12 : 4;
    void now;
  });

  return (
    <group>
      <group ref={grp}>
        <group ref={model}>
          {conductor ? (
            <CarrierModel rt={rt} machine={machine} power={power} doors={doors} seed={seed} />
          ) : (
            <DroneModel rt={rt} machine={machine} power={power} seed={seed} />
          )}
        </group>
        <mesh
          onClick={(e) => { e.stopPropagation(); if (e.delta < 6) select(id); }}
          onPointerOver={() => (document.body.style.cursor = "pointer")}
          onPointerOut={() => (document.body.style.cursor = "")}
        >
          {conductor ? <boxGeometry args={[8, 3, 3]} /> : <sphereGeometry args={[1.3, 10, 8]} />}
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </group>
      <DroneFx rt={rt} k={conductor ? 2 : 1.5} carrier={conductor} />
    </group>
  );
}

export function SubDrone({ sessionId, subId, index, machine, parentConductor }: {
  sessionId: string; subId: string; index: number; machine: string; parentConductor: boolean;
}) {
  const rt = useMemo(() => sim.rt(sessionId, subId), [sessionId, subId]);
  const parent = useMemo(() => sim.rt(sessionId, null), [sessionId]);
  const grp = useRef<Group>(null);
  const power = useRef(1);
  const seed = useMemo(() => hash(subId) * 10, [subId]);
  const K = 0.78;
  const slot = useMemo(() => {
    const ang = index * 2.399963 + seed * 0.1;
    const r = parentConductor ? 3.2 + (index % 3) * 1.15 : 2.9 + (index % 2) * 0.9;
    const y = parentConductor ? 1.35 + (index % 3) * 0.55 : 1.5 + (index % 2) * 0.55;
    return new Vector3(Math.cos(ang) * r, y, Math.sin(ang) * r * 0.82 + 0.3);
  }, [index, seed, parentConductor]);
  const from = useMemo(() => new Vector3(), []);
  const hold = useMemo(() => new Vector3(), []);

  useFrame((st, dt) => {
    const g = grp.current;
    if (!g) return;
    const now = performance.now();
    const ph = rt.phase(now);
    const t = st.clock.elapsedTime;
    if (ph === "docked") { g.visible = false; rt.screen.on = false; return; }
    g.visible = true;
    from.set(parent.pos.x, parent.pos.y - (parentConductor ? 0.85 : 0.45), parent.pos.z + (parentConductor ? 0.2 : 0));
    hold.set(
      slot.x + Math.cos(t * 0.9 + seed) * 0.35,
      slot.y + Math.sin(t * 1.7 + seed * 2) * 0.12,
      slot.z + Math.sin(t * 0.9 + seed) * 0.3,
    );
    let sc = K;
    if (ph === "launching") {
      const u = Math.min(1, (now - rt.launchAt) / LAUNCH_MS);
      const e = u * u * (3 - 2 * u);
      g.position.lerpVectors(from, hold, e);
      g.position.y += Math.sin(u * Math.PI) * -0.5; // dips out of the bay first
      sc = K * (0.25 + 0.75 * Math.min(1, u * 2));
    } else if (ph === "working") {
      g.position.copy(hold);
    } else {
      const u = Math.min(1, (now - rt.dockAt) / DOCK_MS);
      const e = u * u * (3 - 2 * u);
      g.position.lerpVectors(hold, from, e);
      sc = K * (1 - 0.75 * Math.max(0, (u - 0.4) / 0.6));
    }
    rt.pos.copy(g.position);
    g.scale.setScalar(sc);
    g.rotation.y = Math.sin(t * 0.6 + seed) * 0.6;
    power.current = ph === "working" ? 1 : 0.8;
    project(g, 0.55, rt, st);
    void dt;
  });

  return (
    <group>
      <group ref={grp}>
        <DroneModel rt={rt} machine={machine} power={power} seed={seed} />
        <mesh
          onClick={(e) => { e.stopPropagation(); if (e.delta < 6) select(sessionId); }}
          onPointerOver={() => (document.body.style.cursor = "pointer")}
          onPointerOut={() => (document.body.style.cursor = "")}
        >
          <sphereGeometry args={[1.5, 8, 6]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </group>
      <DroneFx rt={rt} k={K} under />
    </group>
  );
}

export function useViewSize() {
  return useThree((s) => s.size);
}
