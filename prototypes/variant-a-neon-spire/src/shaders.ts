import {
  AdditiveBlending,
  Color,
  DoubleSide,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector2,
  Vector3,
} from "three";
import { BLOCK, PITCH } from "./config";

const MAG = new Color("#ff2fd0");
const CYA = new Color("#19e6ff");

// ---------------------------------------------------------------------------
// Towers: dark slab + procedural emissive window strips. One material per
// district (so activity / dim / pulse are per district), shared by its towers.
// ---------------------------------------------------------------------------
const towerVert = /* glsl */ `
attribute float aSeed;
attribute float aTower;
attribute vec3 aSize;
attribute vec3 aOff;
varying vec3 vPos;
varying vec3 vN;
varying float vSeed;
varying float vTower;
varying vec3 vSize;
#include <fog_pars_vertex>
void main(){
  vPos = position - aOff;
  vN = normal;
  vSeed = aSeed;
  vTower = aTower;
  vSize = aSize;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const towerFrag = /* glsl */ `
uniform float uTime;
uniform float uAct;
uniform float uDim;
uniform float uHue;
uniform float uReflect;
uniform float uSelect;
uniform vec3 uA;
uniform vec3 uB;
uniform float uPulse[6];
uniform vec3 uPulseCol[6];
varying vec3 vPos;
varying vec3 vN;
varying float vSeed;
varying float vTower;
varying vec3 vSize;
#include <fog_pars_fragment>

float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }

void main(){
  vec3 n = normalize(vN);
  int ti = int(vTower + 0.5);
  float pulse = 0.0;
  vec3 pcol = vec3(1.0);
  for (int i = 0; i < 6; i++) { if (i == ti) { pulse = uPulse[i]; pcol = uPulseCol[i]; } }

  // body: near-black with faint face tint so volumes read
  vec3 col = vec3(0.012, 0.012, 0.034);
  col += uA * 0.018 * max(n.x, 0.0) + uB * 0.03 * max(n.z, 0.0) + vec3(0.01, 0.012, 0.03) * max(n.y, 0.0);

  float sideX = step(0.5, abs(n.x));
  float sideZ = step(0.5, abs(n.z));
  float side = max(sideX, sideZ);
  float u = sideX > 0.5 ? vPos.z : vPos.x;
  float halfU = sideX > 0.5 ? vSize.z * 0.5 : vSize.x * 0.5;
  float v = vPos.y;

  vec3 emi = vec3(0.0);
  if (side > 0.5) {
    vec2 cell = vec2(u * 3.4 + vSeed * 13.0, v * 4.6);
    vec2 id = floor(cell);
    vec2 f = fract(cell);
    float h = hash(id + vSeed * 7.0 + sideX * 3.7);
    float strip = step(0.1, f.x) * step(f.x, 0.9) * step(0.4, f.y) * step(f.y, 0.62);
    float lit = step(0.32, h);
    float wave = sin(v * 2.2 - uTime * (0.8 + uAct * 6.0) + h * 6.2831) * 0.5 + 0.5;
    float tw = 0.35 + 0.65 * wave;
    vec3 wc = mix(uA, uB, step(0.5, fract(h * 7.13 + uHue)));
    wc = mix(wc, pcol, clamp(pulse, 0.0, 1.0) * 0.85);
    float k = 0.55 * tw + 0.9 * uAct * wave + pulse * 2.4;
    emi += wc * strip * lit * k * 1.7;
    // vertical edge neon
    float e = smoothstep(0.075, 0.0, halfU - abs(u));
    emi += mix(uA, uB, 0.5 + 0.5 * sin(vSeed * 40.0)) * e * (0.55 + pulse * 1.6);
  } else if (n.y > 0.5) {
    // roof: neon outline
    float de = min(vSize.x * 0.5 - abs(vPos.x), vSize.z * 0.5 - abs(vPos.z));
    float e = smoothstep(0.1, 0.02, de);
    emi += mix(uB, uA, step(0.5, fract(vSeed * 3.1))) * e * (1.1 + pulse * 2.4 + uAct);
    emi += pcol * pulse * 0.06;
  }
  // soft base fade
  float baseGlow = smoothstep(0.7, 0.0, v) * 0.5;
  emi += uA * baseGlow * side * 0.35;

  col = col * uDim + emi * uDim * (1.0 + uSelect * 0.6);
  if (uReflect > 0.5) {
    col *= 0.55 * exp(-v * 0.22);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}
`;

export function makeTowerMaterial(reflect: boolean) {
  const m = new ShaderMaterial({
    vertexShader: towerVert,
    fragmentShader: towerFrag,
    fog: true,
    side: reflect ? DoubleSide : 0,
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      {
        uTime: { value: 0 },
        uAct: { value: 0 },
        uDim: { value: 1 },
        uHue: { value: 0 },
        uReflect: { value: reflect ? 1 : 0 },
        uSelect: { value: 0 },
        uA: { value: MAG.clone() },
        uB: { value: CYA.clone() },
        uPulse: { value: new Array(6).fill(0) },
        uPulseCol: { value: Array.from({ length: 6 }, () => new Color("#ffffff")) },
      },
    ]),
  });
  return m;
}

// ---------------------------------------------------------------------------
// Wet street: dark glossy plane, neon lane markings, puddle sheen. Alpha lets
// mirrored (below-ground) towers show through = cheap planar reflection.
// ---------------------------------------------------------------------------
const groundVert = /* glsl */ `
varying vec3 vL;
#include <fog_pars_vertex>
void main(){
  vL = position;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;
const groundFrag = /* glsl */ `
uniform float uTime;
uniform vec2 uPitch;
uniform float uBlock;
varying vec3 vL;
#include <fog_pars_fragment>
float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
}
void main(){
  vec2 p = vec2(vL.x, -vL.y);
  vec3 col = vec3(0.012, 0.01, 0.03);
  // street centre lines
  float gx = abs(mod(p.x + uPitch.x * 0.5, uPitch.x) - uPitch.x * 0.5); // distance to block centre column
  float sx = uPitch.x * 0.5 - gx; // distance to vertical street centre (x)
  float rowD = abs(mod(p.y + uPitch.y * 0.5, uPitch.y) - uPitch.y * 0.5); // distance to block centre row
  float sz = uPitch.y * 0.5 - rowD;
  // dashed centre lines
  float dashX = step(0.5, fract(p.y * 0.35)) * smoothstep(0.07, 0.0, sx);
  float dashZ = step(0.5, fract(p.x * 0.35)) * smoothstep(0.07, 0.0, sz);
  col += vec3(1.0, 0.18, 0.8) * (dashX + dashZ) * 0.9;
  // curb neon around blocks
  float hb = uBlock * 0.5;
  float ex = abs(gx - hb);
  float ez = abs(rowD - hb);
  bool inRangeX = rowD < hb + 0.35;
  bool inRangeZ = gx < hb + 0.35;
  float curb = 0.0;
  if (inRangeX) curb = max(curb, smoothstep(0.1, 0.0, ex));
  if (inRangeZ) curb = max(curb, smoothstep(0.1, 0.0, ez));
  col += vec3(0.1, 0.55, 0.9) * curb * 0.55;
  // wet sheen: stretched puddle noise lit by neon
  float n = noise(p * vec2(0.9, 0.35));
  float puddle = smoothstep(0.55, 0.85, n);
  col += mix(vec3(0.5, 0.08, 0.4), vec3(0.05, 0.4, 0.6), noise(p * 0.35)) * puddle * 0.09;
  // faint glow pools in streets
  float pool = smoothstep(1.9, 0.0, sx) * 0.05 + smoothstep(1.9, 0.0, sz) * 0.05;
  col += vec3(0.4, 0.1, 0.55) * pool;
  gl_FragColor = vec4(col, 0.80);
  #include <fog_fragment>
}
`;

export function makeGroundMaterial() {
  return new ShaderMaterial({
    vertexShader: groundVert,
    fragmentShader: groundFrag,
    fog: true,
    transparent: true,
    depthWrite: false,
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      {
        uTime: { value: 0 },
        uPitch: { value: new Vector2(PITCH, PITCH) },
        uBlock: { value: BLOCK },
      },
    ]),
  });
}

// ---------------------------------------------------------------------------
// Burst chips: instanced billboard pills with a glyph from the atlas.
// ---------------------------------------------------------------------------
const chipVert = /* glsl */ `
attribute vec3 aOrigin;
attribute vec2 aVel;
attribute float aBirth;
attribute float aGlyph;
attribute vec3 aColor;
attribute float aSize;
uniform float uTime;
uniform float uLife;
uniform vec2 uSize;
varying vec2 vUv;
varying vec3 vCol;
varying float vAlpha;
varying float vGlyph;
void main(){
  float age = uTime - aBirth;
  vUv = uv;
  vCol = aColor;
  vGlyph = aGlyph;
  float alive = step(0.0, age) * step(age, uLife);
  float k = 2.3;
  vec2 disp = aVel * (1.0 - exp(-k * age)) / k;
  float pop = smoothstep(0.0, 0.1, age) * (1.0 + 0.3 * (1.0 - smoothstep(0.0, 0.22, age)));
  vec4 mv = viewMatrix * vec4(aOrigin, 1.0);
  mv.xy += disp + position.xy * uSize * 1.32 * aSize * pop;
  vAlpha = (1.0 - smoothstep(0.5, 1.0, age / uLife)) * alive;
  gl_Position = alive > 0.5 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
}
`;
const chipFrag = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec2 uSize;
uniform vec2 uGrid;
varying vec2 vUv;
varying vec3 vCol;
varying float vAlpha;
varying float vGlyph;
void main(){
  vec2 p = (vUv - 0.5) * uSize * 1.32;
  float r = uSize.y * 0.5;
  vec2 q = vec2(max(abs(p.x) - (uSize.x * 0.5 - r), 0.0), p.y);
  float d = length(q) - r;
  float fill = smoothstep(0.012, -0.012, d);
  float border = smoothstep(0.075, 0.03, abs(d + 0.035));
  float glow = exp(-max(d, 0.0) * 9.0) * 0.55;
  // glyph
  vec2 g = p / (r * 1.75) + 0.5;
  float col = mod(vGlyph, uGrid.x);
  float row = floor(vGlyph / uGrid.x);
  vec2 auv = vec2((col + g.x) / uGrid.x, 1.0 - (row + (1.0 - g.y)) / uGrid.y);
  float inG = step(0.0, g.x) * step(g.x, 1.0) * step(0.0, g.y) * step(g.y, 1.0);
  float gl = texture2D(uAtlas, auv).a * inG;
  vec3 c = vec3(0.012, 0.008, 0.04) * fill;
  c += vCol * 2.4 * border;
  c += vCol * 3.2 * gl * fill;
  c += vCol * glow * 0.9;
  float a = clamp(fill * 0.92 + border + glow * 0.5, 0.0, 1.0) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(c, a);
}
`;

export function makeChipMaterial(atlas: import("three").Texture, size: Vector2, life: number, grid: Vector2) {
  return new ShaderMaterial({
    vertexShader: chipVert,
    fragmentShader: chipFrag,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uLife: { value: life },
      uSize: { value: size },
      uGrid: { value: grid },
      uAtlas: { value: atlas },
    },
  });
}

// Additive glow helper material (beams / rings).
export const glowColor = (hex: string, mult = 2.6) => new Color(hex).multiplyScalar(mult);
export { AdditiveBlending, Vector3 };
