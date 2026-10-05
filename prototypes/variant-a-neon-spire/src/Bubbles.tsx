import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  CanvasTexture,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  PlaneGeometry,
  SRGBColorSpace,
  Vector2,
  Color,
  type Vector3,
} from "three";
import {
  BUBBLE_FAN_DEG,
  BUBBLE_H,
  BUBBLE_LIFE_S,
  BUBBLE_POOL,
  BUBBLE_SPEED,
  BUBBLE_W,
} from "./config";
import { hooks } from "./runtime";
import { makeChipMaterial } from "./shaders";
import { ATLAS_COLS, ATLAS_ROWS, SYMBOLS, atlasIndex, getGlyphAtlas, type Family } from "./symbols";

/** All burst chips live in ONE instanced draw call. Spawning writes into a ring
 *  buffer; the vertex shader does the fan trajectory + fade from the birth time. */
export function Bubbles() {
  const meshRef = useRef<Mesh>(null);
  const state = useMemo(() => {
    const base = new PlaneGeometry(1, 1);
    const g = new InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute("position", base.getAttribute("position"));
    g.setAttribute("uv", base.getAttribute("uv"));
    const N = BUBBLE_POOL;
    const origin = new Float32Array(N * 3);
    const vel = new Float32Array(N * 2);
    const birth = new Float32Array(N).fill(-1e4);
    const glyph = new Float32Array(N);
    const color = new Float32Array(N * 3);
    const size = new Float32Array(N).fill(1);
    const mk = (a: Float32Array, n: number) => {
      const at = new InstancedBufferAttribute(a, n);
      at.setUsage(35048); // DynamicDrawUsage
      return at;
    };
    g.setAttribute("aOrigin", mk(origin, 3));
    g.setAttribute("aVel", mk(vel, 2));
    g.setAttribute("aBirth", mk(birth, 1));
    g.setAttribute("aGlyph", mk(glyph, 1));
    g.setAttribute("aColor", mk(color, 3));
    g.setAttribute("aSize", mk(size, 1));
    g.instanceCount = N;
    const tex = new CanvasTexture(getGlyphAtlas());
    tex.colorSpace = SRGBColorSpace;
    tex.minFilter = LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    const mat = makeChipMaterial(tex, new Vector2(BUBBLE_W, BUBBLE_H), BUBBLE_LIFE_S, new Vector2(ATLAS_COLS, ATLAS_ROWS));
    return { g, mat, origin, vel, birth, glyph, color, size, head: 0, counter: 0, dirty: false };
  }, []);

  useEffect(() => {
    const tmpC = new Color();
    hooks.bubble = (p: Vector3, fam: Family, sz: number) => {
      const s = state;
      const i = s.head++ % BUBBLE_POOL;
      // golden-ratio fan: successive chips spread across the arc, never clump
      const c = s.counter++;
      const f = ((c * 0.6180339887) % 1) * 2 - 1;
      const a = (f * BUBBLE_FAN_DEG * Math.PI) / 180;
      const sp = BUBBLE_SPEED * (0.7 + Math.random() * 0.45) * (0.85 + 0.15 * sz);
      s.origin[i * 3] = p.x;
      s.origin[i * 3 + 1] = p.y + 0.55 * sz;
      s.origin[i * 3 + 2] = p.z;
      s.vel[i * 2] = Math.sin(a) * sp;
      s.vel[i * 2 + 1] = Math.cos(a) * sp * 0.92 + 0.6;
      s.birth[i] = performance.now() / 1000;
      s.glyph[i] = atlasIndex(fam);
      tmpC.set(SYMBOLS[fam].color);
      s.color[i * 3] = tmpC.r;
      s.color[i * 3 + 1] = tmpC.g;
      s.color[i * 3 + 2] = tmpC.b;
      s.size[i] = sz;
      s.dirty = true;
    };
    return () => {
      hooks.bubble = null;
    };
  }, [state]);

  useFrame(() => {
    const s = state;
    s.mat.uniforms.uTime.value = performance.now() / 1000;
    if (s.dirty) {
      s.dirty = false;
      for (const k of ["aOrigin", "aVel", "aBirth", "aGlyph", "aColor", "aSize"]) {
        s.g.getAttribute(k).needsUpdate = true;
      }
    }
  });

  return (
    <mesh ref={meshRef} geometry={state.g} material={state.mat} frustumCulled={false} renderOrder={20} />
  );
}
