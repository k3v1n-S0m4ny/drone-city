# drone-city / variant A: NEON SPIRE

**Design idea.** A dense vertical night city under a fixed isometric orthographic camera. Every session is a raised
city block carrying 3-6 extruded towers; the towers' emissive window strips shimmer faster with the session's event
rate and flash in the colour of the tool family that just worked on them. The ground is deep-indigo wet asphalt with
neon lane markings and a cheap planar fake of reflections (mirrored towers seen through semi-transparent asphalt).
Drones are sleek quad-rotors with spinning rotor discs, a glowing underside ring and a machine-coloured hull trim and
pennant (laptop = cyan, vps = amber). A conductor is a wide flat cargo-lifter ("carrier") with 8 landing pads from
which subagent mini-drones launch and dock. Bursts are shot upward from the drone as small glowing neon "glyph chips",
like a neon sign spitting characters.

## Run

```
npm install
npm run dev          # http://127.0.0.1:5181  (strictPort)
```

- `?feed=hub` (default): WebSocket `ws://127.0.0.1:8787/ws` per `docs/data-model.md` (snapshot / events / session /
  remove). Override the URL with `&hub=ws://host:port/ws`. If the hub is down the HUD says so and retries.
- `?feed=demo`: built-in synthetic generator (`src/demo.ts`): 1 conductor spawning 6-10 subagents, ~12 lane sessions on
  2 machines, quiet stretches, a first storm at 5 s then every 11-18 s (20-100 events/s), sessions going idle, ending,
  fading, plus new arrivals and the occasional wake-up. Everything in it is invented.

Interaction: wheel or drag to scroll through the rows of districts (the only camera control). Click a drone to open the
read-only inspect panel (recent events, model, tokens, cost, machine, subagents).

## Symbol legend (burst chips + inspect panel)

| glyph | family | colour | meaning |
| --- | --- | --- | --- |
| ◉ | prompt | white | user prompt |
| ▲ | api | violet | model request finished |
| ✦ | reply | pink | assistant response |
| ⌕ | read | mint | Read / Grep / Glob / LS |
| ✎ | edit | lime | Edit / Write |
| ▶ | bash | magenta | shell command |
| ⇄ | web | blue | WebFetch / WebSearch |
| ◆ | agent | yellow | subagent spawn |
| ⬡ | mcp | orange | MCP tool |
| ◇ | other | grey | other tools |
| ◌ | decide | slate | permission decision |
| ≡ | compact | lilac | context compaction |
| ✓ | done | green | subagent docked |
| ✕ | error | red | error / failed tool |

## Per-event animations (when the drone is free)

prompt: white beam drops from the sky onto the drone. api_request: violet shock rings. response: pink uplink beam rising.
tool_result by family: read = drone darts to its tower and a scan ring sweeps down it; edit = laser + lime sparks on the
roof; bash = thick strobing beam + expanding roof shockwave; web = rings climbing skyward; mcp = spinning hex ring; other =
small beam + pulse. error / failed tool = red double ring, shake and red underside. compaction = squash + contracting
rings. Each tool family always uses the same tower (read/edit/bash/web/mcp/other = towers 0-5, modulo tower count), so a
glance at which tower is lit tells you what the session is doing.

## Burst rule

A drone that is mid-animation is *busy* for `ANIM_MS[kind]`. An event arriving while busy is NOT queued: it is shot as a
glyph chip in a golden-ratio fan above the drone (all chips are one instanced draw call; trajectory and fade are computed
in the vertex shader). Chips from one drone are throttled to one per `BUBBLE_MIN_INTERVAL_MS`, so a 100 ev/s storm stays
legible. Subagent drones use the same rule with the shorter `CHILD_ANIM_MS`. The HUD (top right) shows live events/s and
burst %.

## Tweakable constants (`src/config.ts`)

| constant | effect |
| --- | --- |
| `ANIM_MS` | busy window per event kind; longer = bubbles kick in at lower rates |
| `ANIM_TIME_SCALE` | global multiplier; `0` = everything is a bubble |
| `CHILD_ANIM_MS` | busy window for subagent drones |
| `BUBBLE_MIN_INTERVAL_MS` | min gap between chips per drone |
| `BUBBLE_LIFE_S`, `BUBBLE_W/H`, `BUBBLE_FAN_DEG`, `BUBBLE_SPEED`, `BUBBLE_POOL` | chip lifetime, size, fan spread, launch speed, pool size |
| `BLOCK`, `PITCH`, `ROW_COUNTS` | district size, spacing, brick-pattern row widths (3,2,3,2...) |
| `GLIDE` | how fast districts glide when reordered |
| `CAM_ZOOM`, `CAM_DIST`, `FOG_NEAR`, `FOG_FAR` | fixed camera zoom and fog |
| `DEMO` | demo pacing (storm cadence, idle/end/remove timers, session counts) |
| `MACHINE_COLOR` | hull trim per machine |

## Layout of the code

`src/feed.ts` (hub WS + demo switch) -> `src/store.ts` (zustand; session objects mutated in place, throttled `struct`
counter for React) -> `src/runtime.ts` (non-React per-drone animation state and the burst rule) -> scene
(`City.tsx`, `District.tsx`, `Drone.tsx`, `Bubbles.tsx`, `shaders.ts`) + DOM HUD (`Hud.tsx`).

Layout order is state (active, idle, ended) then the time a session entered its current state (descending), not raw
`lastEventAt`: on a busy feed that value changes every few ms and districts would shuffle constantly.
