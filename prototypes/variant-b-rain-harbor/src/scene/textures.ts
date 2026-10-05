// Procedural canvas textures (no asset downloads).
import { CanvasTexture, LinearFilter, RepeatWrapping, SRGBColorSpace } from "three";

export const MONO = '"Cascadia Mono", "JetBrains Mono", Consolas, "Courier New", monospace';

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { c, g: c.getContext("2d")! };
}
function tex(c: HTMLCanvasElement, srgb = true) {
  const t = new CanvasTexture(c);
  if (srgb) t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  return t;
}
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export function glowTexture() {
  const { c, g } = canvas(128, 128);
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, "rgba(255,255,255,1)");
  gr.addColorStop(0.25, "rgba(255,255,255,0.45)");
  gr.addColorStop(0.6, "rgba(255,255,255,0.1)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  return tex(c);
}

/** Landing pad top: scuffed steel plate, hazard rim, centre marking in the machine colour. */
export function padTexture(hex: string) {
  const S = 512;
  const { c, g } = canvas(S, S);
  const r = rng(7);
  g.fillStyle = "#11191f";
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 700; i++) {
    g.fillStyle = `rgba(${120 + r() * 80},${160 + r() * 60},${170 + r() * 60},${0.02 + r() * 0.05})`;
    g.fillRect(r() * S, r() * S, 2 + r() * 26, 1 + r() * 2);
  }
  // plate seams
  g.strokeStyle = "rgba(90,140,150,0.25)";
  g.lineWidth = 2;
  for (let i = 1; i < 6; i++) {
    g.beginPath(); g.moveTo(i * S / 6, 0); g.lineTo(i * S / 6, S); g.stroke();
    g.beginPath(); g.moveTo(0, i * S / 6); g.lineTo(S, i * S / 6); g.stroke();
  }
  // hazard rim
  g.save();
  g.translate(S / 2, S / 2);
  g.beginPath();
  g.arc(0, 0, S * 0.455, 0, Math.PI * 2);
  g.arc(0, 0, S * 0.395, 0, Math.PI * 2, true);
  g.clip();
  g.fillStyle = "#c98b1a";
  g.fillRect(-S, -S, 2 * S, 2 * S);
  g.fillStyle = "#151a1f";
  for (let i = -30; i < 30; i++) {
    g.save();
    g.rotate(Math.PI / 4);
    g.fillRect(i * 38, -S, 19, 2 * S);
    g.restore();
  }
  g.restore();
  // marking
  g.strokeStyle = hex;
  g.shadowColor = hex;
  g.shadowBlur = 14;
  g.lineWidth = 7;
  g.beginPath(); g.arc(S / 2, S / 2, S * 0.32, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 3;
  g.beginPath(); g.arc(S / 2, S / 2, S * 0.22, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 6;
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    g.beginPath();
    g.moveTo(S / 2 + Math.cos(a) * S * 0.26, S / 2 + Math.sin(a) * S * 0.26);
    g.lineTo(S / 2 + Math.cos(a) * S * 0.38, S / 2 + Math.sin(a) * S * 0.38);
    g.stroke();
  }
  g.shadowBlur = 0;
  g.fillStyle = hex;
  g.globalAlpha = 0.9;
  g.font = `bold 120px ${MONO}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("H", S / 2, S / 2 + 6);
  g.globalAlpha = 1;
  return tex(c);
}

export function containerTexture(hex: string) {
  const { c, g } = canvas(128, 64);
  g.fillStyle = hex;
  g.fillRect(0, 0, 128, 64);
  for (let x = 0; x < 128; x += 5) {
    g.fillStyle = "rgba(0,0,0,0.28)";
    g.fillRect(x, 0, 2, 64);
    g.fillStyle = "rgba(255,255,255,0.10)";
    g.fillRect(x + 2, 0, 1, 64);
  }
  g.fillStyle = "rgba(0,0,0,0.5)";
  g.fillRect(0, 0, 128, 3);
  g.fillRect(0, 61, 128, 3);
  g.fillStyle = "rgba(255,255,255,0.55)";
  g.font = `bold 9px ${MONO}`;
  g.fillText("DRC 204118", 8, 14);
  return tex(c);
}

/** Wet quay tile (one 13x13 yard cell). Returns [colour, emissive lines]. */
export function groundTextures() {
  const S = 1024;
  const a = canvas(S, S);
  const b = canvas(S, S);
  const r = rng(99);
  a.g.fillStyle = "#0b1218";
  a.g.fillRect(0, 0, S, S);
  for (let i = 0; i < 2600; i++) {
    const v = 14 + r() * 26;
    a.g.fillStyle = `rgba(${v},${v + 8},${v + 14},${0.1 + r() * 0.3})`;
    a.g.fillRect(r() * S, r() * S, 1 + r() * 14, 1 + r() * 14);
  }
  // puddle patches (lighter, glossier look comes from the lightformers)
  for (let i = 0; i < 40; i++) {
    const gr = a.g.createRadialGradient(0, 0, 0, 0, 0, 60 + r() * 120);
    gr.addColorStop(0, "rgba(40,70,85,0.35)");
    gr.addColorStop(1, "rgba(40,70,85,0)");
    a.g.save();
    a.g.translate(r() * S, r() * S);
    a.g.scale(1.6, 0.8);
    a.g.fillStyle = gr;
    a.g.fillRect(-200, -200, 400, 400);
    a.g.restore();
  }
  // seams of the yard cell
  a.g.strokeStyle = "rgba(10,14,18,1)";
  a.g.lineWidth = 6;
  a.g.strokeRect(0, 0, S, S);
  // emissive: cell border dashes in amber, inner teal grid ticks
  b.g.fillStyle = "#000";
  b.g.fillRect(0, 0, S, S);
  b.g.strokeStyle = "#ff9d2e";
  b.g.lineWidth = 5;
  b.g.setLineDash([46, 30]);
  b.g.strokeRect(14, 14, S - 28, S - 28);
  b.g.setLineDash([]);
  b.g.strokeStyle = "rgba(25,227,208,0.55)";
  b.g.lineWidth = 2;
  for (let i = 1; i < 8; i++) {
    const p = (i * S) / 8;
    for (let k = 0; k < 8; k++) {
      const q = (k * S) / 8;
      b.g.beginPath(); b.g.moveTo(p - 8, q); b.g.lineTo(p + 8, q); b.g.stroke();
      b.g.beginPath(); b.g.moveTo(p, q - 8); b.g.lineTo(p, q + 8); b.g.stroke();
    }
  }
  const ta = tex(a.c);
  const tb = tex(b.c);
  for (const t of [ta, tb]) {
    t.wrapS = t.wrapT = RepeatWrapping;
    t.minFilter = LinearFilter;
  }
  return [ta, tb] as const;
}

/** Holographic label sign. */
export function labelTexture(label: string, sub: string, hex: string) {
  const W = 512;
  const H = 192;
  const { c, g } = canvas(W, H);
  g.clearRect(0, 0, W, H);
  g.fillStyle = "rgba(4,16,22,0.72)";
  g.strokeStyle = hex;
  g.lineWidth = 5;
  g.shadowColor = hex;
  g.shadowBlur = 18;
  const rr = 22;
  g.beginPath();
  g.roundRect(10, 10, W - 20, H - 20, rr);
  g.fill();
  g.stroke();
  g.shadowBlur = 0;
  // scanlines
  g.fillStyle = "rgba(255,255,255,0.05)";
  for (let y = 14; y < H - 14; y += 6) g.fillRect(16, y, W - 32, 2);
  g.fillStyle = "#f4ffff";
  g.shadowColor = hex;
  g.shadowBlur = 16;
  let fs = 96;
  g.font = `bold ${fs}px ${MONO}`;
  while (g.measureText(label).width > W - 70 && fs > 30) {
    fs -= 4;
    g.font = `bold ${fs}px ${MONO}`;
  }
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  g.fillText(label, W / 2, 112);
  g.shadowBlur = 0;
  g.fillStyle = hex;
  g.font = `bold 34px ${MONO}`;
  g.fillText(sub, W / 2, 158);
  return tex(c);
}

export function tagTexture(text: string, hex: string) {
  const { c, g } = canvas(128, 64);
  g.fillStyle = "#06141a";
  g.fillRect(0, 0, 128, 64);
  g.strokeStyle = hex;
  g.lineWidth = 6;
  g.strokeRect(3, 3, 122, 58);
  g.fillStyle = hex;
  g.font = `bold 40px ${MONO}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 64, 35);
  return tex(c);
}

export function hologramBarsTexture() {
  const { c, g } = canvas(64, 64);
  g.fillStyle = "#fff";
  g.fillRect(0, 0, 64, 64);
  return tex(c);
}
