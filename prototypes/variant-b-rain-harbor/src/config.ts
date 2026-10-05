// Tweakable constants for the RAIN HARBOR prototype. Everything is plain numbers.
export const CFG = {
  // ---- burst bubbles --------------------------------------------------------
  /** An event is shown as an animation only if the drone's current animation has at most this many ms left.
   *  Otherwise it becomes a symbol chip. 0 = strict "never interrupt"; higher = more animations, fewer chips. */
  BUBBLE_THRESHOLD_MS: 140,
  /** Max chips stacked above one drone; older ones collapse into the "+N" counter. */
  BUBBLE_MAX_VISIBLE: 6,
  /** Chip lifetime (ms) after its last tick. */
  BUBBLE_TTL_MS: 3200,
  /** Same glyph+code arriving within this window ticks the newest chip (x2, x3 ...) instead of adding one. */
  BUBBLE_MERGE_MS: 380,
  /** Minimum gap between two new chips of one drone; faster events fall into the "+N" counter. */
  BUBBLE_MIN_GAP_MS: 85,

  // ---- layout ---------------------------------------------------------------
  COLUMNS: 3,
  COL_W: 13,
  ROW_H: 13,
  /** Re-sort districts at most this often (ms) unless membership/state changes. */
  REORDER_EVERY_MS: 3000,
  /** lastEventAt is bucketed so busy sessions don't swap places constantly. */
  ORDER_BUCKET_MS: 15000,

  // ---- camera ---------------------------------------------------------------
  ELEVATION_DEG: 36,
  /** visible size in world units (3 columns + margin); zoom is derived from the viewport once. */
  VIEW_W_UNITS: 44,
  VIEW_H_UNITS: 25,
  SCROLL_WHEEL_SPEED: 0.035,

  // ---- atmosphere -----------------------------------------------------------
  RAIN_COUNT: 6500,
  RIPPLE_COUNT: 700,
  FOG_LAYERS: 5,

  // ---- demo feed ------------------------------------------------------------
  DEMO_LANE_SESSIONS: 13,
  DEMO_IDLE_AFTER_MS: 22000,
  DEMO_END_AFTER_MS: 75000,
  HUB_URL: "ws://127.0.0.1:8787/ws",
};

export const MACHINE_COLORS: Record<string, { hex: string; label: string; tag: string }> = {
  laptop: { hex: "#19e3d0", label: "LAPTOP", tag: "LAP" },
  vps: { hex: "#ff9d2e", label: "VPS", tag: "VPS" },
};
export function machineInfo(m: string) {
  return MACHINE_COLORS[m] ?? { hex: "#9aa8b4", label: m.toUpperCase().slice(0, 8), tag: m.toUpperCase().slice(0, 3) };
}
