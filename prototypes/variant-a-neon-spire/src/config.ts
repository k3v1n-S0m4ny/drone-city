// ---------------------------------------------------------------------------
// Tweakable constants. Everything visual/behavioural you might want to tune.
// ---------------------------------------------------------------------------

/** How long each event animation occupies a drone (ms). While a drone is busy,
 *  further events become glyph-chip BURST BUBBLES instead of queuing animations.
 *  Longer durations => bubbles kick in at lower event rates. */
export const ANIM_MS = {
  prompt: 900,
  api_request: 650,
  response: 700,
  tool_result: 1150,
  tool_decision: 180,
  subagent_spawn: 700,
  subagent_done: 700,
  compaction: 1100,
  error: 900,
} as const;

/** Global multiplier on ANIM_MS. 0 => every event is a bubble. */
export const ANIM_TIME_SCALE = 1;
/** Child (subagent) drones animate faster. */
export const CHILD_ANIM_MS = 520;

/** Min gap between two chips from the same drone (ms). Events inside the gap
 *  are coalesced (counted, not drawn) so a 100 ev/s storm stays legible. */
export const BUBBLE_MIN_INTERVAL_MS = 55;
/** Chip lifetime in seconds. */
export const BUBBLE_LIFE_S = 1.5;
/** Chip size in world units (pill width x height). */
export const BUBBLE_W = 1.15;
export const BUBBLE_H = 0.72;
/** Fan half-angle in degrees and launch speed. */
export const BUBBLE_FAN_DEG = 62;
export const BUBBLE_SPEED = 7.5;
/** Instanced chip pool size (ring buffer). */
export const BUBBLE_POOL = 900;

// Layout. Blocks sit on a world-axis lattice (pitch PITCH); seen through the
// iso camera that lattice becomes a staggered brick pattern of diamonds:
// even rows hold 3 districts, odd rows hold 2 in between.
export const BLOCK = 5.2; // district block edge
export const PITCH = 10.4; // block-to-block distance along a world axis
export const PITCH_X = PITCH * Math.SQRT2; // screen-horizontal spacing inside a row
export const PITCH_Z = PITCH / Math.SQRT2; // screen-vertical spacing between rows
export const ROW_COUNTS = [3, 2];
export function slotOf(index: number): { x: number; z: number; row: number } {
  let row = 0;
  let i = index;
  for (;;) {
    const n = ROW_COUNTS[row % ROW_COUNTS.length];
    if (i < n) {
      return { x: (i - (n - 1) / 2) * PITCH_X, z: row * PITCH_Z, row };
    }
    i -= n;
    row++;
  }
}
export const GLIDE = 3.2; // district position smoothing (1/s)
export const REORDER_EVERY_MS = 1500;

// Camera (fixed iso ortho)
export const CAM_ZOOM = 33;
export const CAM_DIST = 70;
export const FOG_NEAR = 85;
export const FOG_FAR = 175;

// Demo feed pacing
export const DEMO = {
  lanes: 12,
  maxSessions: 16,
  firstStormInMs: 5000,
  stormEveryMs: [11000, 18000] as [number, number],
  idleAfterMs: 22_000,
  endAfterMs: 80_000,
  removeAfterMs: 45_000,
};

export const HUB_URL = "ws://127.0.0.1:8787/ws";

export const MACHINE_COLOR: Record<string, string> = {
  laptop: "#19e6ff",
  vps: "#ffab1a",
};
export const machineColor = (m: string) => MACHINE_COLOR[m] ?? "#b9a8ff";
