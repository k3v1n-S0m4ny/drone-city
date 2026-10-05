// Rain streaks, ground ripples and drifting fog sheets. All animation is in shaders (zero CPU per drop).
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import {
  AdditiveBlending, Color, DoubleSide, Group, InstancedBufferAttribute, InstancedBufferGeometry,
  PlaneGeometry, ShaderMaterial, Vector2, Vector3,
} from "three";
import { CFG } from "../config";
import { view } from "./view";

const BOX = new Vector3(78, 20, 78);

function seeds(n: number) {
  const a = new Float32Array(n * 4);
  for (let i = 0; i < a.length; i++) a[i] = Math.random();
  return new InstancedBufferAttribute(a, 4);
}

export function Rain() {
  const { geo, mat } = useMemo(() => {
    const base = new PlaneGeometry(1, 1);
    const geo = new InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute("position", base.getAttribute("position"));
    geo.setAttribute("uv", base.getAttribute("uv"));
    geo.setAttribute("aSeed", seeds(CFG.RAIN_COUNT));
    geo.instanceCount = CFG.RAIN_COUNT;
    const mat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
      side: DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uCenter: { value: new Vector3() },
        uBox: { value: BOX },
        uColor: { value: new Color("#9fe9ff") },
      },
      vertexShader: /* glsl */ `
        uniform float uTime; uniform vec3 uCenter; uniform vec3 uBox;
        attribute vec4 aSeed;
        varying vec2 vUv; varying float vK;
        void main() {
          vUv = uv;
          float speed = 18.0 + aSeed.w * 10.0;
          float H = uBox.y;
          float f = mod(aSeed.y * H - uTime * speed, H);
          vec2 slant = vec2(0.10, 0.05);
          vec2 xz = aSeed.xz * uBox.xz - slant * f;
          xz = uCenter.xz + mod(xz - uCenter.xz + 0.5 * uBox.xz, uBox.xz) - 0.5 * uBox.xz;
          vec3 d = normalize(vec3(slant.x, -1.0, slant.y));
          vec3 viewDir = normalize(vec3(-1.0, -0.72, -1.0));
          vec3 w = normalize(cross(d, viewDir));
          float len = 0.55 + aSeed.w * 0.75;
          vec3 p = vec3(xz.x, f, xz.y) + (-d) * (position.y + 0.5) * len + w * position.x * 0.045;
          vK = 0.35 + aSeed.x * 0.65;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; varying vec2 vUv; varying float vK;
        void main() {
          float a = (1.0 - vUv.y) * vK * 0.55;
          gl_FragColor = vec4(uColor * 1.2, a);
        }`,
    });
    return { geo, mat };
  }, []);

  useFrame((s) => {
    mat.uniforms.uTime.value = s.clock.elapsedTime;
    mat.uniforms.uCenter.value.copy(view.target);
  });
  return <mesh geometry={geo} material={mat} frustumCulled={false} renderOrder={5} />;
}

export function Ripples() {
  const { geo, mat } = useMemo(() => {
    const base = new PlaneGeometry(1, 1);
    base.rotateX(-Math.PI / 2);
    const geo = new InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute("position", base.getAttribute("position"));
    geo.setAttribute("uv", base.getAttribute("uv"));
    geo.setAttribute("aSeed", seeds(CFG.RIPPLE_COUNT));
    geo.instanceCount = CFG.RIPPLE_COUNT;
    const mat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        uCenter: { value: new Vector3() },
        uBox: { value: new Vector2(BOX.x, BOX.z) },
        uColor: { value: new Color("#6fe0ff") },
      },
      vertexShader: /* glsl */ `
        uniform float uTime; uniform vec3 uCenter; uniform vec2 uBox;
        attribute vec4 aSeed; varying vec2 vUv; varying float vP;
        void main() {
          vUv = uv;
          float t = aSeed.z + uTime * (0.55 + aSeed.w * 0.6);
          float cyc = floor(t); float ph = fract(t);
          vP = ph;
          vec2 s = fract(aSeed.xy + cyc * vec2(0.618, 0.414));
          vec2 xz = uCenter.xz + mod(s * uBox - uCenter.xz + 0.5 * uBox, uBox) - 0.5 * uBox;
          float r = 0.06 + ph * 0.62;
          vec3 p = vec3(xz.x + position.x * 2.0 * r, 0.045, xz.y + position.z * 2.0 * r);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; varying vec2 vUv; varying float vP;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          float ring = smoothstep(0.62, 0.86, d) * (1.0 - smoothstep(0.86, 1.0, d));
          float a = ring * (1.0 - vP) * 0.7;
          gl_FragColor = vec4(uColor * 1.4, a);
        }`,
    });
    return { geo, mat };
  }, []);
  useFrame((s) => {
    mat.uniforms.uTime.value = s.clock.elapsedTime;
    mat.uniforms.uCenter.value.copy(view.target);
  });
  return <mesh geometry={geo} material={mat} frustumCulled={false} renderOrder={2} />;
}

const FOG_V = /* glsl */ `
  varying vec3 vW; varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;
const FOG_F = /* glsl */ `
  uniform float uTime; uniform vec3 uColor; uniform float uOpacity; uniform float uSeed; uniform vec2 uDrift;
  varying vec3 vW; varying vec2 vUv;
  float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
  float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * n(p); p *= 2.03; a *= 0.5; } return s; }
  void main() {
    vec2 p = vW.xz * 0.055 + uDrift * uTime + uSeed;
    float f = fbm(p + fbm(p * 1.7 + uTime * 0.012) * 1.3);
    float a = smoothstep(0.38, 0.88, f) * uOpacity;
    vec2 q = abs(vUv - 0.5) * 2.0;
    a *= 1.0 - smoothstep(0.72, 1.0, max(q.x, q.y));
    gl_FragColor = vec4(uColor, a);
  }`;

export function FogLayers() {
  const layers = useMemo(() => {
    const out: { y: number; mat: ShaderMaterial }[] = [];
    for (let i = 0; i < CFG.FOG_LAYERS; i++) {
      const k = i / Math.max(1, CFG.FOG_LAYERS - 1);
      const warm = i % 2 === 1;
      out.push({
        y: 0.35 + k * k * 5.5 + i * 0.25,
        mat: new ShaderMaterial({
          transparent: true,
          depthWrite: false,
          fog: false,
          side: DoubleSide,
          toneMapped: false,
          uniforms: {
            uTime: { value: 0 },
            uColor: { value: new Color(warm ? "#2a2318" : "#0c2b33") },
            uOpacity: { value: 0.42 - k * 0.12 },
            uSeed: { value: i * 17.3 },
            uDrift: { value: new Vector2(0.012 + i * 0.004, -0.006 - i * 0.002) },
          },
          vertexShader: FOG_V,
          fragmentShader: FOG_F,
        }),
      });
    }
    return out;
  }, []);
  const grp = useRef<Group>(null);
  useFrame((s) => {
    for (const l of layers) l.mat.uniforms.uTime.value = s.clock.elapsedTime;
    grp.current?.position.set(view.target.x, 0, view.target.z);
  });
  return (
    <group ref={grp}>
      {layers.map((l, i) => (
        <mesh key={i} rotation-x={-Math.PI / 2} position-y={l.y} material={l.mat} frustumCulled={false} renderOrder={3}>
          <planeGeometry args={[120, 120]} />
        </mesh>
      ))}
    </group>
  );
}
