// The static port: wet quay, aisle lamps, container stacks, back warehouses, quay cranes.
// Everything is in screen-aligned LOCAL layout coordinates (rendered inside the rotated root group).
import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import {
  AdditiveBlending, BufferGeometry, CanvasTexture, Color, Float32BufferAttribute, InstancedMesh, MeshBasicMaterial,
  MeshStandardMaterial, Object3D, PointsMaterial, RepeatWrapping, SRGBColorSpace,
} from "three";
import { CFG } from "../config";
import { containerTexture, glowTexture, groundTextures } from "./textures";

const Z0 = -34;
const Z1 = 190;

function mulberry(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function Ground() {
  const mat = useMemo(() => {
    const [col, emi] = groundTextures();
    const reps = 32;
    for (const t of [col, emi]) {
      t.wrapS = t.wrapT = RepeatWrapping;
      t.repeat.set(reps, reps);
      t.offset.set(0.5, 0.5);
    }
    return new MeshStandardMaterial({
      map: col,
      emissiveMap: emi,
      emissive: new Color("#ffffff"),
      emissiveIntensity: 0.3,
      color: "#cfe4ee",
      metalness: 0.75,
      roughness: 0.26,
      envMapIntensity: 1.1,
    });
  }, []);
  return (
    <mesh rotation-x={-Math.PI / 2} position={[0, 0, 104]} material={mat}>
      <planeGeometry args={[13 * 32, 13 * 32]} />
    </mesh>
  );
}

function Lamps() {
  const pole = useRef<InstancedMesh>(null);
  const head = useRef<InstancedMesh>(null);
  const decal = useRef<InstancedMesh>(null);
  const pts = useMemo(() => {
    const out: [number, number][] = [];
    for (const x of [-19.5, -6.5, 6.5, 19.5]) for (let r = -2; r < 14; r++) out.push([x, r * CFG.ROW_H + 6.5]);
    return out;
  }, []);
  const glow = useMemo(() => glowTexture(), []);
  const halo = useMemo(() => {
    const g = new BufferGeometry();
    const a: number[] = [];
    for (const [x, z] of pts) a.push(x, 4.5, z);
    g.setAttribute("position", new Float32BufferAttribute(a, 3));
    return g;
  }, [pts]);
  const haloMat = useMemo(
    () =>
      new PointsMaterial({
        map: glow, color: new Color("#ffa845").multiplyScalar(1.6), size: 150, sizeAttenuation: false,
        transparent: true, depthWrite: false, blending: AdditiveBlending, opacity: 0.3, toneMapped: false, fog: false,
      }),
    [glow],
  );
  useLayoutEffect(() => {
    const o = new Object3D();
    pts.forEach(([x, z], i) => {
      o.rotation.set(0, 0, 0);
      o.scale.set(1, 1, 1);
      o.position.set(x, 2.2, z);
      o.updateMatrix();
      pole.current!.setMatrixAt(i, o.matrix);
      o.position.set(x, 4.45, z);
      o.updateMatrix();
      head.current!.setMatrixAt(i, o.matrix);
      o.position.set(x, 0.05, z);
      o.rotation.set(-Math.PI / 2, 0, 0);
      o.scale.set(10, 10, 1);
      o.updateMatrix();
      decal.current!.setMatrixAt(i, o.matrix);
    });
    for (const m of [pole, head, decal]) m.current!.instanceMatrix.needsUpdate = true;
  }, [pts]);
  return (
    <group>
      <instancedMesh ref={pole} args={[undefined, undefined, pts.length]}>
        <cylinderGeometry args={[0.07, 0.11, 4.4, 6]} />
        <meshStandardMaterial color="#1b242b" metalness={0.8} roughness={0.4} />
      </instancedMesh>
      <instancedMesh ref={head} args={[undefined, undefined, pts.length]}>
        <boxGeometry args={[0.95, 0.12, 0.38]} />
        <meshBasicMaterial color={new Color("#ffb458").multiplyScalar(3)} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={decal} args={[undefined, undefined, pts.length]} frustumCulled={false}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial
          map={glow} color={new Color("#ff9d2e").multiplyScalar(0.22)} transparent depthWrite={false}
          blending={AdditiveBlending} toneMapped={false} fog={false}
        />
      </instancedMesh>
      <points geometry={halo} material={haloMat} frustumCulled={false} />
    </group>
  );
}

const STACK_COLORS = ["#7c3b22", "#2b5a63", "#5d6770", "#26405e", "#8a6a1e", "#4b2c3f", "#3e5c3a", "#6e2a2a"];

function Stacks() {
  const ref = useRef<InstancedMesh>(null);
  const items = useMemo(() => {
    const r = mulberry(5);
    const out: { x: number; y: number; z: number; c: string; long: boolean }[] = [];
    for (const side of [-1, 1]) {
      for (const x0 of [22.4, 25.4, 28.4]) {
        for (let z = Z0; z < Z1; z += 6.3) {
          if (r() < 0.22) continue;
          const h = 1 + Math.floor(r() * (x0 > 25 ? 4 : 3));
          const c = STACK_COLORS[Math.floor(r() * STACK_COLORS.length)];
          for (let k = 0; k < h; k++) out.push({ x: side * x0, y: 1.35 + k * 2.7, z: z + (r() - 0.5) * 0.5, c, long: true });
        }
      }
    }
    // back stacks above row 0
    for (let x = -30; x < 30; x += 3) {
      if (r() < 0.2) continue;
      const h = 1 + Math.floor(r() * 3);
      const c = STACK_COLORS[Math.floor(r() * STACK_COLORS.length)];
      for (let k = 0; k < h; k++) out.push({ x: x + (r() - 0.5), y: 1.35 + k * 2.7, z: -9.4 - (r() < 0.3 ? 6.5 : 0), c, long: false });
    }
    return out;
  }, []);
  const map = useMemo(() => containerTexture("#ffffff"), []);
  useLayoutEffect(() => {
    const o = new Object3D();
    const col = new Color();
    items.forEach((it, i) => {
      o.position.set(it.x, it.y, it.z);
      o.rotation.set(0, it.long ? 0 : Math.PI / 2, 0);
      o.updateMatrix();
      ref.current!.setMatrixAt(i, o.matrix);
      ref.current!.setColorAt(i, col.set(it.c).multiplyScalar(0.55));
    });
    ref.current!.instanceMatrix.needsUpdate = true;
    ref.current!.instanceColor!.needsUpdate = true;
  }, [items]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, items.length]} frustumCulled={false}>
      <boxGeometry args={[2.4, 2.6, 6]} />
      <meshStandardMaterial map={map} metalness={0.45} roughness={0.55} />
    </instancedMesh>
  );
}

function windowsTexture() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#0a1016";
  g.fillRect(0, 0, 256, 128);
  const r = mulberry(21);
  for (let y = 10; y < 118; y += 22)
    for (let x = 8; x < 250; x += 20) {
      const on = r();
      g.fillStyle = on < 0.5 ? "#101a22" : on < 0.8 ? "#ffb457" : "#35e6d6";
      g.fillRect(x, y, 12, 9);
    }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}

function Warehouses() {
  const tex = useMemo(() => windowsTexture(), []);
  const mat = useMemo(
    () => new MeshStandardMaterial({ color: "#222c34", emissive: "#ffffff", emissiveMap: tex, emissiveIntensity: 0.9, metalness: 0.3, roughness: 0.7 }),
    [tex],
  );
  const blocks = useMemo(() => {
    const r = mulberry(33);
    const out: { x: number; z: number; w: number; h: number; d: number }[] = [];
    let x = -44;
    while (x < 44) {
      const w = 9 + r() * 8;
      out.push({ x: x + w / 2, z: -26 - r() * 5, w, h: 5 + r() * 6, d: 8 });
      x += w + 1.2;
    }
    return out;
  }, []);
  return (
    <group>
      {blocks.map((b, i) => (
        <mesh key={i} position={[b.x, b.h / 2, b.z]} material={mat}>
          <boxGeometry args={[b.w, b.h, b.d]} />
        </mesh>
      ))}
      {[-24, -9, 11, 28].map((x, i) => (
        <group key={i} position={[x, 0, -19]}>
          <mesh position={[0, 3.5, 0]}>
            <cylinderGeometry args={[2.2, 2.2, 7, 14]} />
            <meshStandardMaterial color="#27333b" metalness={0.6} roughness={0.45} />
          </mesh>
          <mesh position={[0, 5, 0]}>
            <cylinderGeometry args={[2.24, 2.24, 0.16, 14]} />
            <meshBasicMaterial color={new Color(i % 2 ? "#19e3d0" : "#ff9d2e").multiplyScalar(2.2)} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

const beaconMat = new MeshBasicMaterial({ color: new Color("#ff2d3d").multiplyScalar(3), toneMapped: false });

function Crane({ x, z, dir }: { x: number; z: number; dir: 1 | -1 }) {
  const steel = "#2b3640";
  const paint = "#8e4d12";
  return (
    <group position={[x, 0, z]} scale={[dir, 1, 1]}>
      {[-3.2, 3.2].flatMap((zz) => [0, 3.4].map((xx) => (
        <mesh key={`${zz}${xx}`} position={[xx, 6, zz]}>
          <boxGeometry args={[0.45, 12, 0.45]} />
          <meshStandardMaterial color={steel} metalness={0.7} roughness={0.5} />
        </mesh>
      )))}
      <mesh position={[1.7, 12.2, 0]}>
        <boxGeometry args={[4.6, 0.7, 7.4]} />
        <meshStandardMaterial color={paint} metalness={0.5} roughness={0.6} />
      </mesh>
      <mesh position={[-4, 12.6, 0]}>
        <boxGeometry args={[9, 0.55, 1.1]} />
        <meshStandardMaterial color={paint} metalness={0.5} roughness={0.6} />
      </mesh>
      <mesh position={[-7.5, 10.4, 0]}>
        <boxGeometry args={[0.12, 4.4, 0.12]} />
        <meshBasicMaterial color={new Color("#ffb458").multiplyScalar(1.8)} toneMapped={false} />
      </mesh>
      <mesh position={[-7.5, 8.0, 0]}>
        <boxGeometry args={[1.5, 0.6, 1.0]} />
        <meshStandardMaterial color="#1a2229" metalness={0.8} roughness={0.4} />
      </mesh>
      <mesh position={[1.7, 13.0, 0]} material={beaconMat}>
        <sphereGeometry args={[0.28, 8, 8]} />
      </mesh>
    </group>
  );
}

export function Harbor() {
  useFrame((s) => {
    beaconMat.color.setRGB(3, 0.18, 0.24).multiplyScalar(Math.sin(s.clock.elapsedTime * 3.2) > 0.4 ? 1 : 0.12);
  });
  return (
    <group>
      <Ground />
      <Lamps />
      <Stacks />
      <Warehouses />
    </group>
  );
}
