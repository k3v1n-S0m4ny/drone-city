# Variant C: HOLO GRID

Design prototype for drone-city (issue #8). Throwaway code, standalone npm project.

## Design idea

A holographic, data-centric city: an infinite dark grid with sweeping scanlines, and each session is a hexagonal plate of glowing wireframe on dark glass. Buildings are low *data towers* drawn as `EdgesGeometry` edges plus translucent additive volumes. Six satellite towers (one per tool family) rise with how often that family was used, and the taller core tower rises with tokens used. Activity is shown as bead-shaped pulses that leave the drone, run along the circuit traces on the plate and climb the matching tower. Drones are minimal diamonds (octahedron core, two orbiting rings, light trail); a conductor is a **carrier**, a big slow-rotating ring-station with 12 docking ports from which tetrahedron subagents eject and to which they return. Machine = ring/plate/tag colour (laptop = cyan, vps = violet). Errors are the only hot orange. Post: bloom, chromatic aberration, film noise, scanlines, vignette.

**Burst bubbles = symbol ticker.** When a drone is already mid-animation, or its event rate is at/above the threshold, events stop queuing animations and instead scroll into a short terminal ribbon above the drone: glyphs enter from the right like a stock ticker, older ones fade, and a segmented ev/s meter sits on the left. The ribbon only opens once 3 glyphs landed within 1.5 s, so a single overlapping event does not pop a bubble.

## Symbol legend

| glyph | meaning | colour |
| --- | --- | --- |
| ◇ | read / search (Read, Grep, Glob) | cyan |
| ◆ | edit / write | white |
| ▸ | bash | mint |
| ◎ | web (WebFetch, WebSearch) | azure |
| ⬢ | agent (subagent spawn / done) | gold |
| ⬡ | MCP tool | magenta |
| ● | other tool, success | mint-green |
| ✕ | error (failed tool_result, api error) | hot orange |
| △ | api_request | teal |
| ▽ | response | pale teal |
| ○ | prompt | pale blue |

(`▣` = compaction, `tool_decision` events are not drawn except Agent/Task.) Each family also has its own full animation when the drone is free: prompt = light descends, api = uplink beam, response = downlink beam, read = laser + scan ping, edit = fat strobing beam, bash = stuttering beam, web = unfolding globe, agent = hexagon shock rings, mcp = dashed link + octagon plug, error = jittering orange beam + shake.

## Run

```
npm install
npm run dev        # http://127.0.0.1:5183  (strictPort)
```

- `?feed=hub` (default): WebSocket `ws://127.0.0.1:8787/ws` per `docs/data-model.md` (override with `?hub=ws://host:port/ws`). Reconnects automatically.
- `?feed=demo`: built-in synthetic generator (1 conductor + 12 lane sessions, subagent churn, bursts of 20-100 ev/s, idle and ended sessions). In the console, `__demo.burst(0, 90, 5000)` forces a burst on the conductor (index 0) / lane N.
- `?fx=none` (or `nobloom`, `nonoise`, `nomsaa`, comma separated) disables post effects for debugging.
- Scroll with the wheel or drag vertically. Click a drone or plate to open the inspect panel.

`npm run build` type-checks and builds.

## Tweakable constants

All in `src/config.ts` (`CFG`), also live-editable from the console as `__CFG`:

| constant | default | meaning |
| --- | --- | --- |
| `BUBBLE_RATE_THRESHOLD` | 5 | ev/s at/above which a drone uses the ticker instead of animations |
| `ANIM_SLOT_MS` | 520 | how long one animation occupies the drone; events arriving while busy become glyphs |
| `BUBBLE_WINDOW_MS` | 1000 | sliding window for the ev/s meter |
| `BUBBLE_LINGER_MS` | 2600 | ticker stays open this long after the last glyph |
| `TICKER_MAX_GLYPHS` | 12 | glyph capacity of the ribbon |
| `COLS`, `HEX_R`, `GAP` | 3, 4, 1.1 | district grid |
| `REORDER_EVERY_MS` | 2500 | district reorder cadence (rows glide when reordered) |
| `PULSE_MIN_GAP_MS`, `PULSE_SPEED` | 70, 15 | travelling pulses |
| `SUBAGENT_LAUNCH_MS`, `SUBAGENT_DOCK_MS` | 1300, 1100 | subagent eject / dock durations |

Demo lifecycle timers (idle 22 s, ended 80 s, removed +45 s) are shortened in `src/feed.ts`; the hub uses the contract defaults.

## Layout of the code

`feed.ts` (hub + demo) -> `store.ts` (zustand, 4 Hz React-visible state) + `runtime.ts` (per-session event queues read by the render loop) -> `Scene.tsx` (camera rig, ground, post) -> `District.ts` (plate, towers, drone/carrier, subagents, pulses, fx, ticker, label; plain three.js).
