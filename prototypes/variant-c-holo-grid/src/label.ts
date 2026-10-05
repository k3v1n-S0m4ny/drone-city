import * as THREE from "three";
import { machineColor } from "./config";

export const GLYPH_FONT = '"Segoe UI Symbol","Cascadia Mono","DejaVu Sans Mono","Noto Sans Symbols 2",monospace';
export const MONO = '"Cascadia Mono","JetBrains Mono",Consolas,"DejaVu Sans Mono",monospace';

/** Billboard label: ticket / short id + machine tag chip + state. Redrawn only when inputs change. */
export class Label {
  sprite: THREE.Sprite;
  private canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private key = "";

  constructor() {
    this.canvas.width = 400;
    this.canvas.height = 116;
    this.ctx = this.canvas.getContext("2d")!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.generateMipmaps = false;
    this.tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    this.sprite = new THREE.Sprite(mat);
    this.sprite.scale.set(4.9, 4.9 * (116 / 400), 1);
    this.sprite.center.set(0.5, 0.5);
    this.sprite.renderOrder = 20;
    this.sprite.raycast = () => {};
  }

  set(label: string, machine: string, state: string, role: string) {
    const key = [label, machine, state, role].join("|");
    if (key === this.key) return;
    this.key = key;
    const c = this.ctx;
    const W = this.canvas.width,
      H = this.canvas.height;
    const mc = machineColor(machine);
    c.clearRect(0, 0, W, H);
    c.textBaseline = "middle";
    c.font = `700 54px ${MONO}`;
    c.shadowColor = mc;
    c.shadowBlur = 14;
    c.fillStyle = state === "ended" ? "#6d8794" : "#eafcff";
    c.fillText(label, 14, 38);
    c.shadowBlur = 0;
    const chip = (text: string, x: number, col: string, fill: boolean) => {
      c.font = `700 24px ${MONO}`;
      const w = c.measureText(text).width + 22;
      c.strokeStyle = col;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(x + 8, 76);
      c.lineTo(x + w, 76);
      c.lineTo(x + w, 104);
      c.lineTo(x, 104);
      c.lineTo(x, 84);
      c.closePath();
      if (fill) {
        c.fillStyle = col + "55";
        c.fill();
      }
      c.stroke();
      c.fillStyle = col;
      c.fillText(text, x + 11, 91);
      return x + w + 8;
    };
    let x = 14;
    x = chip(machine.toUpperCase(), x, mc, true);
    const sc = state === "active" ? "#7dffc4" : state === "idle" ? "#ffd45c" : "#7f8c96";
    x = chip(state === "active" ? "● ACTIVE" : state === "idle" ? "◐ IDLE" : "○ ENDED", x, sc, false);
    if (role === "conductor") chip("⬢ CARRIER", x, "#ffd45c", true);
    void W;
    void H;
    this.tex.needsUpdate = true;
  }
}
