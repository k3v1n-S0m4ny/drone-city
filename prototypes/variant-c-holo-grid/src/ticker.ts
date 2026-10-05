import * as THREE from "three";
import { CFG, machineColor } from "./config";
import type { Sym } from "./symbols";
import { BILLBOARD_Q } from "./iso";
import { GLYPH_FONT, MONO } from "./label";

interface G {
  sym: Sym;
  pos: number;
  born: number;
}

/**
 * Burst bubble = "symbol ticker": a short terminal ribbon above the drone.
 * Glyphs enter from the right and scroll left like a stock ticker; older ones
 * fade. A small meter on the left shows the live event rate (ev/s).
 */
export class Ticker {
  group = new THREE.Group();
  private canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private mesh: THREE.Mesh;
  private glyphs: G[] = [];
  private lastPush = -1e9;
  private pushes: number[] = [];
  private shown = false;
  private vis = 0;
  private rate = 0;
  private color = "#19e6ff";
  baseScale = 1;
  readonly W = 448;
  readonly H = 70;

  constructor() {
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.ctx = this.canvas.getContext("2d")!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.generateMipmaps = false;
    this.tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    // the pointer tip (canvas y = 66 of 70) sits at the group origin
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 6.4 * (this.H / this.W)), mat);
    this.mesh.position.y = 0.5 * 6.4 * (this.H / this.W) - 0.06;
    this.mesh.renderOrder = 30;
    this.mesh.raycast = () => {};
    this.group.add(this.mesh);
    this.group.quaternion.copy(BILLBOARD_Q);
    this.group.visible = false;
  }

  setMachine(m: string) {
    this.color = machineColor(m);
  }

  push(sym: Sym, now: number) {
    this.glyphs.unshift({ sym, pos: -1.4, born: now });
    if (this.glyphs.length > CFG.TICKER_MAX_GLYPHS + 2) this.glyphs.length = CFG.TICKER_MAX_GLYPHS + 2;
    this.lastPush = now;
    this.pushes.push(now);
    while (this.pushes.length && now - this.pushes[0] > 1500) this.pushes.shift();
    // a lone overflow glyph is not a burst: latch the bubble open from the 3rd glyph in 1.5 s
    if (this.pushes.length >= 3) this.shown = true;
  }

  update(dt: number, now: number, rate: number, enabled: boolean) {
    const want = enabled && this.shown && now - this.lastPush < CFG.BUBBLE_LINGER_MS ? 1 : 0;
    if (!want && this.vis < 0.03) this.shown = false;
    this.vis += (want - this.vis) * (1 - Math.exp(-dt * (want ? 14 : 5)));
    this.rate += (rate - this.rate) * (1 - Math.exp(-dt * 10));
    if (this.vis < 0.02) {
      this.group.visible = false;
      if (!want) this.glyphs.length = 0;
      return;
    }
    this.group.visible = true;
    (this.mesh.material as THREE.MeshBasicMaterial).opacity = this.vis;
    this.group.scale.setScalar((0.85 + 0.15 * this.vis) * this.baseScale);
    this.draw(dt, now);
  }

  private draw(dt: number, now: number) {
    const c = this.ctx,
      W = this.W,
      H = this.H;
    const col = this.color;
    c.clearRect(0, 0, W, H);
    const top = 2,
      bot = 54,
      ch = 9;
    c.beginPath();
    c.moveTo(ch, top);
    c.lineTo(W - 2, top);
    c.lineTo(W - 2, bot - ch);
    c.lineTo(W - ch - 2, bot);
    c.lineTo(W / 2 + 9, bot);
    c.lineTo(W / 2, bot + 12);
    c.lineTo(W / 2 - 9, bot);
    c.lineTo(2, bot);
    c.lineTo(2, top + ch);
    c.closePath();
    c.fillStyle = "rgba(2,14,22,0.84)";
    c.fill();
    c.shadowColor = col;
    c.shadowBlur = 10;
    c.strokeStyle = col;
    c.lineWidth = 2;
    c.stroke();
    c.shadowBlur = 0;
    c.fillStyle = "rgba(120,240,255,0.05)";
    for (let y = top + 2; y < bot; y += 4) c.fillRect(4, y, W - 8, 1);

    // ---- rate meter (left) ----
    const mx = 12,
      mw = 84;
    c.textBaseline = "alphabetic";
    c.textAlign = "left";
    c.fillStyle = "#eafcff";
    c.font = `700 27px ${MONO}`;
    const r = Math.round(this.rate);
    c.fillText(String(r), mx, 33);
    const nw = c.measureText(String(r)).width;
    c.font = `600 13px ${MONO}`;
    c.fillStyle = col;
    c.fillText("ev/s", mx + nw + 4, 33);
    const segs = 12,
      frac = Math.min(1, this.rate / 100);
    for (let i = 0; i < segs; i++) {
      const on = (i + 0.5) / segs <= frac;
      c.fillStyle = on ? (i > 9 ? "#ff6a1a" : col) : "rgba(130,200,220,0.18)";
      c.fillRect(mx + i * (mw / segs), 41, mw / segs - 2, 8);
    }
    c.fillStyle = col + "88";
    c.fillRect(mx + mw + 6, top + 8, 1, bot - top - 16);

    // ---- glyph tape (right) ----
    const x0 = mx + mw + 14,
      x1 = W - 12;
    const cell = (x1 - x0) / CFG.TICKER_MAX_GLYPHS;
    c.font = `700 ${Math.min(24, Math.floor(cell * 0.95))}px ${GLYPH_FONT}`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    const k = 1 - Math.exp(-dt * 20);
    for (let i = 0; i < this.glyphs.length; i++) {
      const g = this.glyphs[i];
      g.pos += (i - g.pos) * k;
      const x = x1 - (g.pos + 0.5) * cell;
      if (x < x0 - cell * 0.5) continue;
      const age = Math.max(0, g.pos) / CFG.TICKER_MAX_GLYPHS;
      let a = Math.pow(1 - age, 1.35);
      if (g.pos < 0) a *= Math.max(0, 1 + g.pos * 0.6);
      const fresh = Math.max(0, 1 - (now - g.born) / 260);
      c.globalAlpha = Math.min(1, a);
      c.fillStyle = g.sym.color;
      if (fresh > 0.05) {
        c.shadowColor = g.sym.color;
        c.shadowBlur = 14 * fresh;
      }
      const s = 1 + 0.35 * fresh;
      c.save();
      c.translate(x, 29);
      c.scale(s, s);
      c.fillText(g.sym.glyph, 0, 0);
      c.restore();
      c.shadowBlur = 0;
    }
    c.globalAlpha = 1;
    c.textAlign = "left";
    const grad = c.createLinearGradient(x0, 0, x0 + 46, 0);
    grad.addColorStop(0, "rgba(2,14,22,1)");
    grad.addColorStop(1, "rgba(2,14,22,0)");
    c.fillStyle = grad;
    c.fillRect(x0, top + 3, 46, bot - top - 6);
    c.fillStyle = col + "66";
    c.fillRect(x0, 47, x1 - x0, 1);
    this.tex.needsUpdate = true;
  }
}
