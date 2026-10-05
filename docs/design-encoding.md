# Visual encoding spec (design gate #9)

**Direction:** variant C (Holo Grid), stripped down to a calm, information-only city that's easy on the eyes for hours.

**Rules**
1. **Every element and every colour encodes data.** If it carries no information, it isn't drawn.
2. **Grey for normal, colour for abnormal.** Normal running is neutral; hue is reserved for identity (thin edges) and exceptions.
3. **Never colour alone.** Every colour meaning is paired with a shape or pattern, so it stays readable for colour-blind viewers.
4. **Calm by default.** No camera motion, no endless blinking, and at most 3 luminance changes per second on screen.

## 1. Traffic profile (what we design for)

Measured from local session logs on the laptop and the VPS over 30 days (239 sessions on the watched repo; 1,065 sessions across all projects on the laptop). The figures below are for the watched repo.

| Signal | Typical | Peak |
| --- | --- | --- |
| Sessions active at once | 1 | 7 |
| Events/s within a session (1 s buckets) | 2 | 25 |
| Events/s (5 s windows) | 0.4 | 6 |
| Burst length (gaps < 1 s) | 4 | 36 |
| Distinct moments < 0.5 s apart | 6–9% | |
| Silences > 2 min within a session | 10–12 per session | |
| Tool failures | 2–5% of bash; ≤ 2% of other tools | |
| Rejected tool calls | about 1 per session | |
| Tokens per session | 5–9 M | 370 M |
| Model share | Opus about 90% | |

Tool mix (laptop / VPS):
- Bash makes up 62% / 84% of tool calls.
- Within bash: inspect files 32%, git/gh 22%, shell glue 25%, run scripts and programs 6–12%, wait/poll 3–5%, build/test directly about 1.5%.

What this means for the design:
- **Paired events** (decision + result, request + response) share a timestamp. Each pair is **one visual moment**.
- **Bubbles are the exception.** They're used only when distinct moments overlap.
- **Tools are grouped by intent.** A "bash" tower would dwarf everything else.
- **"Silent for a while" is normal.** Long builds and CI waits cause it, so it's never an alert.
- **Token totals use a log scale.** They span 3+ orders of magnitude.
- **Idle and ended districts dominate the screen,** so their look matters more than storms.
- **Performance target:** 100 ev/s is about 4× the worst observed peak.

## 2. Palette (OKLCH, on a dark slate background)

| Role | OKLCH | Hex | Meaning; where it may appear |
| --- | --- | --- | --- |
| Background | 0.17 0.012 250 | `#0b1015` | dark slate, never pure black |
| Plate fill | 0.24 0.012 250 | `#1b2025` | the district's surface |
| Neutral dim | 0.42 0.010 250 | `#494e52` | idle edges, ended content |
| Neutral mid | 0.62 0.008 250 | `#83878b` | quantities (towers, column), labels |
| Neutral bright | 0.86 0.006 250 | `#ced1d5` | "happening now" and active labels; never pure white |
| Cyan | 0.78 0.10 210 | `#5fc9db` | **machine = laptop.** Plate edge + drone ring + tag only |
| Violet | 0.68 0.13 295 | `#9e87e0` | **machine = vps.** Plate edge + drone ring + tag only |
| Amber | 0.82 0.14 78 | `#f6b84d` | **needs a human: a tool call was rejected** |
| Red | 0.64 0.19 25 | `#e9504d` | **something failed** (failed tool, api error) |

**Redundant shape cues** (for colour-blind viewers):
- Laptop plates have a **solid** edge; VPS plates have a **dashed** edge.
- Amber always appears with a **chevron ring**.
- Red always appears with a **notched / broken glyph**.

**Lightness gaps are part of the meaning; don't change them.**
- Violet's lightness (L) stays at least 0.10 below cyan's.
- Amber stays at L ≥ 0.80 and red at L ≤ 0.65.
- Fallback: if cyan and violet get confused, move violet toward h≈330.

**Budget**
- At rest, at least 85% of lit pixels are neutral.
- Machine hues appear only on thin edges.
- Amber plus red cover less than 2% of the screen.

## 3. Encoding table

| Element | Encodes | Source |
| --- | --- | --- |
| Hex plate | one session | `session.id` |
| Plate edge: hue + solid/dashed | machine | `machine` |
| Plate brightness | state: active 100%, idle 45%, ended 20% and fading out over 15 min | lifecycle |
| Rim arc (a clock hand on the plate edge, neutral) | time since last event, filling toward idle and then toward end | `now - lastEventAt` |
| 6 intent towers in fixed positions (neutral) | activity mix: height is the call count, log scale | grouped `tool_result` |
| Red notched cap on a tower | that intent's failure share | `ok = false` |
| Centre column (neutral) | **total tokens used** (log scale, a tick ring per ×10) | cumulative `tokens` |
| Notch rings on the column | compactions | `compaction` events |
| Drone core shape | model family: Opus octahedron, Sonnet cube, Haiku tetrahedron, other sphere | `model` |
| Drone glow | an event within the last 2 s | `lastEventAt` |
| Drone "breathing" (slow 0.25 Hz brightness, no hue) | waiting or polling: the last tool was sleep, until, timeout, or a `gh … --watch` / `gh run watch` | bash intent = wait |
| Pulse, drone to tower (neutral; red + notch if failed) | one tool moment landing in that intent | `tool_result` |
| Amber chevron ring around the drone | a rejected tool call. It pulses at ≤ 1 Hz for 5 s, then stays steady until the next successful action or a click | `tool_decision` reject |
| Carrier ring (conductors only) | one port per *running* subagent, plus a numeric count of docked ones | `role`, `subagents` |
| Child tetrahedra | running subagents (core shape is their model); they dock on completion | `subagents` |
| Ticker ribbon (appears only during overlap) | moments too fast to animate, one glyph each, max 8 visible | events |
| Ticker meter | events/s over 5 s | rate |
| Label line 1 | `t<N>` or short id | `label` |
| Label line 2 | `12m · 8.6M tok · $1.84` | `startedAt`, `tokens`, `costUsd` |

### Intent towers (fixed order around the plate)

| # | Intent | Tools |
| --- | --- | --- |
| 1 | **Look** | Read, Grep, Glob, LS; bash `cat grep rg sed -n tail head ls wc find jq awk diff` |
| 2 | **Change** | Edit, Write, MultiEdit, NotebookEdit; bash `mkdir rm cp mv touch` and redirects |
| 3 | **Git/GitHub** | bash `git`, `gh` (ticket and PR progress) |
| 4 | **Run** | bash scripts, `python node bash docker tmux cargo pnpm npm make`, tests and builds, shell glue |
| 5 | **Delegate** | Agent, Task, Skill, SendMessage, Workflow |
| 6 | **External** | MCP tools, WebFetch, WebSearch; bash `curl ssh scp` |

Bash wait/poll (`sleep`, `until`, `timeout`, `while`, `watch`) gets no tower. It drives the drone's "breathing" state.

### Glyphs (shape only, neutral; red and notched for errors)
- **Intents:** ◇ look · ◆ change · ⑂ git · ▸ run · ⬢ delegate · ⬡ external
- **Other events:** △ api · ▽ reply · ○ prompt · ▣ compaction · ✕ error · ⌛ wait

## 4. Glow, motion and comfort
- **Bloom** only on "now" elements (emissive L ≥ 0.80). Use a small radius, about 0.5× the engine default intensity, and halos never merge across districts. Red is never bloomed.
- **Event glow** rises in 150 ms and decays to the recency brightness over 2 s.
- **One moment, one animation.** Paired events merge. Events closer than 300 ms merge into one swell. Limits: ≤ 2 luminance changes per second per district, < 3 per second on the whole screen.
- **Alerts** (amber/red) pulse at ≤ 1 Hz for ≤ 5 s, then hold steady. No endless blinking.
- **Drones** move slowly at constant speed with eased turns. Child drones orbit at ≤ 0.1 rev/s. The camera never moves; vertical scroll is the only motion the user drives.
- **The hex pattern** stays low-contrast (plate fill vs background ratio about 1.16) so it never reads as a strong repeating pattern.
- **`prefers-reduced-motion`** replaces pulses and glides with steady state changes.

## 5. Removed from prototype C
- Chromatic aberration, noise, scanlines, vignette.
- The infinite grid floor and its sweep.
- Random cubes, circuit traces, light trails.
- The carrier's idle rotation.
- The "ACTIVE" chips (brightness encodes state).
- Per-family tool colours.
- Orange for errors (now red + notch).
