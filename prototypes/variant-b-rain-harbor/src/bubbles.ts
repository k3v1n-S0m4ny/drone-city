// Burst bubbles: a DOM "departure board" column of tiny mono chips above each drone.
// New chips appear nearest the drone and tick upward; overflow collapses into a "+N" counter.
// Imperative DOM on purpose: this is the hot path during 100 ev/s storms.
import { CFG } from "./config";
import { FAMILIES } from "./symbols";
import { sim, type Chip, type DroneRT } from "./sim";

const ROW = 17;
const FLIP = "0123456789ABCDEFGHJKLMNPRSTUVWXYZ$#%&*";

interface ChipEl {
  el: HTMLDivElement;
  g: HTMLElement;
  c: HTMLElement;
  n: HTMLElement;
  count: number;
  born: number;
}
interface Col {
  el: HTMLDivElement;
  chips: Map<number, ChipEl>;
  more: HTMLDivElement;
  moreN: number;
}

export class BubbleLayer {
  private cols = new Map<string, Col>();
  private flipTick = 0;
  constructor(private root: HTMLElement) {}

  private mkCol(): Col {
    const el = document.createElement("div");
    el.className = "bcol";
    const more = document.createElement("div");
    more.className = "chip more";
    more.style.opacity = "0";
    el.appendChild(more);
    this.root.appendChild(el);
    return { el, chips: new Map(), more, moreN: -1 };
  }

  private mkChip(ch: Chip): ChipEl {
    const el = document.createElement("div");
    el.className = "chip enter";
    el.style.setProperty("--c", FAMILIES[ch.fam].color);
    const g = document.createElement("b");
    g.className = "g";
    const c = document.createElement("i");
    c.className = "c";
    c.textContent = ch.code;
    const n = document.createElement("u");
    n.className = "n";
    el.append(g, c, n);
    return { el, g, c, n, count: 0, born: ch.born };
  }

  update(now: number) {
    const seen = new Set<string>();
    const flipIdx = Math.floor(now / 38);
    for (const rt of sim.all() as Iterable<DroneRT>) {
      // expire
      if (rt.chips.length) rt.chips = rt.chips.filter((c) => now - c.touched < CFG.BUBBLE_TTL_MS);
      if (rt.overflow && now - rt.overflowAt > CFG.BUBBLE_TTL_MS) rt.overflow = 0;
      if (!rt.chips.length && !rt.overflow) continue;
      seen.add(rt.key);
      let col = this.cols.get(rt.key);
      if (!col) {
        col = this.mkCol();
        this.cols.set(rt.key, col);
      }
      col.el.style.display = rt.screen.on ? "block" : "none";
      col.el.style.transform = `translate(${rt.screen.x.toFixed(1)}px, ${(rt.screen.y - rt.screen.lift).toFixed(1)}px)`;

      // sync chips: newest nearest the drone (row 0)
      const live = new Set<number>();
      const n = rt.chips.length;
      for (let k = 0; k < n; k++) {
        const ch = rt.chips[n - 1 - k]; // k = 0 -> newest
        live.add(ch.id);
        let ce = col.chips.get(ch.id);
        if (!ce) {
          ce = this.mkChip(ch);
          col.el.appendChild(ce.el);
          col.chips.set(ch.id, ce);
          requestAnimationFrame(() => ce!.el.classList.remove("enter"));
        }
        const age = now - ch.born;
        const real = FAMILIES[ch.fam].glyph;
        ce.g.textContent = age < 150 ? FLIP[(flipIdx * 7 + ch.id * 3) % FLIP.length] : real;
        if (ce.count !== ch.count) {
          ce.count = ch.count;
          ce.n.textContent = ch.count > 1 ? `×${ch.count}` : "";
          if (ch.count > 1) {
            ce.el.classList.remove("tick");
            void ce.el.offsetWidth;
            ce.el.classList.add("tick");
          }
        }
        const life = CFG.BUBBLE_TTL_MS - (now - ch.touched);
        const fadeOut = Math.min(1, life / 600);
        ce.el.style.transform = `translate(-50%, ${-(k * ROW + 6)}px)`;
        ce.el.style.opacity = ce.el.classList.contains("enter") ? "0" : String(Math.max(0.18, (1 - k * 0.09) * fadeOut));
      }
      for (const [id, ce] of col.chips) {
        if (!live.has(id)) {
          ce.el.remove();
          col.chips.delete(id);
        }
      }
      // overflow counter sits on top of the stack
      if (rt.overflow > 0) {
        if (col.moreN !== rt.overflow) {
          col.more.textContent = rt.overflow >= 1000 ? `+${(rt.overflow / 1000).toFixed(1)}k` : `+${rt.overflow}`;
          col.moreN = rt.overflow;
          col.more.classList.remove("tick");
          void col.more.offsetWidth;
          col.more.classList.add("tick");
        }
        const life = (rt.chips.length ? CFG.BUBBLE_TTL_MS : 1500) - (now - rt.overflowAt);
        col.more.style.transform = `translate(-50%, ${-(n * ROW + 6)}px)`;
        col.more.style.opacity = String(Math.min(1, life / 600));
      } else {
        col.more.style.opacity = "0";
        col.moreN = -1;
      }
    }
    for (const [key, col] of this.cols) {
      if (!seen.has(key)) {
        col.el.remove();
        this.cols.delete(key);
      }
    }
    this.flipTick++;
  }
}
