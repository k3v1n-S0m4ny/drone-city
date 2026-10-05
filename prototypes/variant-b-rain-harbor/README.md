# drone-city / variant B: RAIN HARBOR

A low, wide industrial port district in constant light rain, lit in teal and sodium amber. Every session is a **dock**: an octagonal landing pad with edge lights, cargo containers and a small control mast with a holographic label sign (`t<N>` or short id, plus machine). Its **drone** is a chunky utility quad with tilted ducted fans and a single eye lamp; laptop hulls are teal, vps hulls are amber. A **conductor** is a long barge-like airship moored above its pad, and its subagent drones detach from the belly bay and redock. Event animations are physical: `edit` carries a glowing crate down and places it on the pad, `read` scans a crate with a light cone, `bash` throws weld sparks, `web` fires an uplink beam.

When events arrive faster than the drone's current animation can finish, they stop queuing and become **burst bubbles**: a column of tiny monospaced HUD chips above the drone that tick upward like a departure board (new chip nearest the drone, glyph flips like a split-flap for ~150 ms, repeats become `x3`, overflow collapses into a `+N` counter).

## Run

```
npm install
npm run dev          # http://127.0.0.1:5182  (strictPort)
```

- `?feed=hub` (default): WebSocket `ws://127.0.0.1:8787/ws` per `docs/data-model.md` (`?hub=ws://host:port/ws` overrides). Reconnects with backoff.
- `?feed=demo`: built-in synthetic generator (1 conductor with 6-10 subagents per wave, 13 lane sessions on 2 machines, quiet stretches, 20-100 ev/s tool storms per session, idle and ended sessions). The "force tool storm" button forces a 7 s storm everywhere.
- `?q=low`: no MSAA, DPR 1. Use it for software GL or screenshots.
- `npm run build` type-checks and builds.

Interaction: wheel / drag / arrow keys / PageUp / PageDown scroll vertically through the rows; click a drone or carrier for the inspect panel; click empty space to close it. The camera angle and zoom are fixed.

## Symbol legend (burst bubbles)

| glyph | meaning | animation when not bursting |
| --- | --- | --- |
| `›` | prompt | data packet drops in |
| `↑` | model call (api_request) | eye pulse + ring |
| `↓` | response | signal rises |
| `R` | read / search (Read, Grep, Glob, LS) | scan cone on a crate |
| `E` | edit / write (Edit, Write, MultiEdit) | place a crate |
| `$` | bash | weld sparks |
| `W` | web (WebFetch, WebSearch) | uplink beam |
| `A` | skill / agent-type tool | double ring |
| `M` | mcp tool | orbiting plug nodes |
| `•` | other tool | blip |
| `!` | error / failed tool | red strobe + shake (always animated) |
| `≡` | compaction | ring collapses |
| `▲` | subagent launch | belly hatch opens (always animated) |
| `▼` | subagent docked | docking ring (always animated) |

Each chip may carry a 3-4 char code after the glyph (`rd`, `grep`, `edt`, `wrt`, first word of a bash command, mcp server name ...). `xN` = N repeats merged into one chip, `+N` = N more events collapsed.

## Tweakable constants

All in `src/config.ts` (`CFG`):

| constant | default | effect |
| --- | --- | --- |
| `BUBBLE_THRESHOLD_MS` | 140 | an event animates only if the drone's current animation has at most this many ms left; otherwise it becomes a chip. 0 = never interrupt |
| `BUBBLE_MAX_VISIBLE` | 6 | chips stacked per drone (subagent drones: 3) before collapsing into `+N` |
| `BUBBLE_TTL_MS` | 3200 | chip lifetime after its last tick |
| `BUBBLE_MERGE_MS` | 380 | same glyph+code within this window ticks the newest chip (`x2`, `x3`) |
| `BUBBLE_MIN_GAP_MS` | 85 | min gap between two new chips of one drone; faster events go to `+N` |
| `COLUMNS`, `COL_W`, `ROW_H` | 3, 13, 13 | grid layout |
| `REORDER_EVERY_MS`, `ORDER_BUCKET_MS` | 3000, 15000 | re-sort throttle and recency bucketing (keeps busy sessions from swapping places) |
| `ELEVATION_DEG`, `VIEW_W_UNITS`, `VIEW_H_UNITS` | 36, 44, 25 | fixed camera angle and zoom (zoom derived from the viewport once) |
| `RAIN_COUNT`, `RIPPLE_COUNT`, `FOG_LAYERS` | 6500, 700, 5 | atmosphere cost |
| `DEMO_*` | | demo session count and idle/end timers |

Animation lengths per family are in `src/symbols.ts` (`FAMILIES[...].dur`).

## Files

`src/feed.ts` (hub / demo switch), `src/demo.ts` (generator), `src/store.ts` (zustand + mutable session state), `src/sim.ts` (per-drone animation vs bubble decision), `src/bubbles.ts` (DOM chip columns), `src/scene/*` (three.js scene: `Harbor`, `Atmosphere`, `District`, `Models`, `Craft`, `Fx`).

The demo data is invented; nothing here contains real session data.
