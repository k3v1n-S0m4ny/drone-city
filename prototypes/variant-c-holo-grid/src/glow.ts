import * as THREE from "three";
import { FOG_FAR, FOG_NEAR } from "./iso";
import { PALETTE } from "./config";

const fogUniforms = () => ({
  uFogNear: { value: FOG_NEAR },
  uFogFar: { value: FOG_FAR },
});
const FOG_VERT = /* glsl */ `varying float vDepth;`;
const FOG_FN = /* glsl */ `
uniform float uFogNear; uniform float uFogFar; varying float vDepth;
float fogK(){ return smoothstep(uFogNear, uFogFar, vDepth); }`;

export const additive = {
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  toneMapped: false,
} as const;

export const lineMat = (color: THREE.ColorRepresentation, opacity = 1) =>
  new THREE.LineBasicMaterial({ color, opacity, ...additive });
export const meshGlowMat = (color: THREE.ColorRepresentation, opacity = 1) =>
  new THREE.MeshBasicMaterial({ color, opacity, side: THREE.DoubleSide, ...additive });

// ------------------------------------------------------------------ ground --
export function makeGroundMat() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uTarget: { value: new THREE.Vector2() },
      uBg: { value: new THREE.Color(PALETTE.bg) },
      uLine: { value: new THREE.Color("#12b7d6") },
      ...fogUniforms(),
    },
    vertexShader: /* glsl */ `
      varying vec3 vW; ${FOG_VERT}
      void main(){
        vec4 w = modelMatrix * vec4(position,1.0);
        vW = w.xyz;
        vec4 mv = viewMatrix * w;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vW; ${FOG_FN}
      uniform float uTime; uniform vec2 uTarget; uniform vec3 uBg; uniform vec3 uLine;
      float gridLine(vec2 p, float scale){
        vec2 g = p/scale; vec2 w = fwidth(g)*1.0;
        vec2 a = abs(fract(g-0.5)-0.5)/max(w,1e-4);
        return 1.0 - min(min(a.x,a.y),1.0);
      }
      void main(){
        vec2 g = vec2(vW.x - vW.z, vW.x + vW.z) * 0.70710678; // city frame
        float minor = gridLine(g, 1.0);
        float major = gridLine(g, 5.0);
        float d = length(vW.xz - uTarget);
        float radial = 1.0 - smoothstep(18.0, 46.0, d);
        // scanlines sweeping toward the horizon + fine static raster
        float sweep = pow(0.5+0.5*sin(g.y*0.9 - uTime*1.4), 14.0);
        float raster = 0.5+0.5*sin(g.y*38.0);
        vec3 col = uBg;
        col += uLine * (minor*0.07 + major*0.26) * (0.35+0.65*radial);
        col += uLine * sweep * 0.05 * radial;
        col *= 0.93 + 0.07*raster;
        col = mix(col, uBg, fogK()*0.85);
        gl_FragColor = vec4(col, 1.0);
      }`,
    depthWrite: false,
  });
}

// ---------------------------------------------------------------- hex plate --
export function makeHexMat(radius: number) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color("#19e6ff") },
      uAlpha: { value: 1 },
      uFlash: { value: 0 },
      uRing: { value: 0 }, // 0..1 expanding ring from the centre (activity)
      uR: { value: radius },
      uSel: { value: 0 },
      ...fogUniforms(),
    },
    vertexShader: /* glsl */ `
      varying vec2 vP; ${FOG_VERT}
      void main(){
        vP = position.xz;
        vec4 mv = modelViewMatrix * vec4(position,1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vP; ${FOG_FN}
      uniform float uTime, uAlpha, uFlash, uRing, uR, uSel; uniform vec3 uColor;
      float hexM(vec2 p){ p = vec2(p.x, p.y); p = abs(p); return max(p.x, dot(p, vec2(0.5, 0.8660254))); } // pointy-top, apothem units
      void main(){
        float m = hexM(vP) / (0.8660254*uR);       // 0 centre .. 1 rim
        if (m > 1.0) discard;
        vec2 g = vP*2.0; vec2 w = fwidth(g);
        vec2 a = abs(fract(g-0.5)-0.5)/max(w,1e-4);
        float grid = 1.0 - min(min(a.x,a.y),1.0);
        float r = length(vP)/uR;
        float rim = smoothstep(0.72, 1.0, m);
        float scan = pow(0.5+0.5*sin(vP.y*2.2 - uTime*1.1), 18.0);
        float ring = exp(-pow((r - uRing*1.1)*9.0, 2.0)) * step(0.001, uRing) * (1.0-uRing);
        float a0 = 0.12 + 0.2*(1.0-r) ;
        vec3 col = uColor*(0.10 + grid*0.45 + rim*0.6 + scan*0.5 + ring*1.4 + uFlash*0.5 + uSel*0.25);
        float alpha = (a0*0.4 + grid*0.15 + rim*0.28 + ring*0.4 + scan*0.08 + uFlash*0.2 + uSel*0.12) * uAlpha;
        alpha *= 1.0 - fogK()*0.8;
        gl_FragColor = vec4(col, alpha);
      }`,
    ...additive,
    side: THREE.DoubleSide,
  });
}

// ------------------------------------------------------------ tower volume --
export function makeVolMat() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color("#3be8ff") },
      uH: { value: 1 },
      uFlash: { value: 0 },
      uAlpha: { value: 1 },
      ...fogUniforms(),
    },
    vertexShader: /* glsl */ `
      varying vec3 vL; varying vec3 vN; ${FOG_VERT}
      void main(){
        vL = position; vN = normal;
        vec4 mv = modelViewMatrix * vec4(position,1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vL; varying vec3 vN; ${FOG_FN}
      uniform float uTime, uH, uFlash, uAlpha; uniform vec3 uColor;
      void main(){
        float y = vL.y;                       // 0..1 along the tower
        float wy = y*uH;
        float bands = step(0.82, fract(wy*1.6 - uTime*0.6));
        float lvl = step(0.94, fract(wy*3.2));
        float top = smoothstep(0.82, 1.0, y);
        float cap = step(0.5, vN.y);
        float a = 0.03 + 0.045*bands + 0.03*lvl + top*0.09 + cap*0.10 + uFlash*0.22;
        vec3 col = uColor * (0.45 + top*0.5 + uFlash*0.7 + cap*0.4);
        a *= uAlpha * (1.0 - fogK()*0.8);
        gl_FragColor = vec4(col, a);
      }`,
    ...additive,
    side: THREE.DoubleSide,
  });
}
