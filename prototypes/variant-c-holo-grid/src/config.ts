// Tweakable constants. Mutable on purpose: open the console and poke `__CFG`
// (e.g. `__CFG.BUBBLE_RATE_THRESHOLD = 2`) to feel the difference live.
export const CFG = {
  // ---- burst bubbles -------------------------------------------------------
  /** events/s (sliding window) at or above which a drone switches to the symbol ticker */
  BUBBLE_RATE_THRESHOLD: 5,
  /** sliding window used for the ev/s meter + threshold, ms */
  BUBBLE_WINDOW_MS: 1000,
  /** how long one full drone animation occupies the drone; events arriving while busy become glyphs */
  ANIM_SLOT_MS: 520,
  /** the ticker stays visible this long after its last glyph, ms */
  BUBBLE_LINGER_MS: 2600,
  /** glyphs kept in the ribbon */
  TICKER_MAX_GLYPHS: 12,
  // ---- city layout ---------------------------------------------------------
  COLS: 3,
  HEX_R: 4,
  GAP: 1.1,
  /** how often (ms) district order is recomputed, so active rows do not jitter */
  REORDER_EVERY_MS: 2500,
  // ---- effects -------------------------------------------------------------
  /** min ms between travelling pulses per drone */
  PULSE_MIN_GAP_MS: 70,
  PULSE_SPEED: 15,
  SUBAGENT_LAUNCH_MS: 1300,
  SUBAGENT_DOCK_MS: 1100,
};

(window as unknown as { __CFG: typeof CFG }).__CFG = CFG;

export const MACHINE_COLOR: Record<string, string> = {
  laptop: "#19e6ff",
  vps: "#a46bff",
};
export const machineColor = (m: string) => MACHINE_COLOR[m] ?? "#8aa0b4";

export const PALETTE = {
  bg: "#02060b",
  cyan: "#3be8ff",
  white: "#e9fbff",
  orange: "#ff6a1a",
};
