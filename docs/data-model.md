# Data model and wire contract

This is the source of truth for `packages/model`, the hub, and every renderer or prototype. If code and this document disagree, fix one of them in the same change.

## Inputs

### 1. OpenTelemetry logs (live)

Claude Code exports events as OTLP log records (`OTEL_LOGS_EXPORTER=otlp`). The hub accepts them at `POST /v1/logs` (OTLP/HTTP, JSON encoding). Each log record carries its attributes in `attributes[]`, and the resource carries more in `resource.attributes[]`. **Merge both** (record wins), then read:

| Attribute | Use |
| --- | --- |
| `event.name` | event kind (see below) |
| `event.timestamp` | ISO 8601; ordering (then `event.sequence`) |
| `session.id` | **district / drone key** |
| `prompt.id` | groups events of one user turn |
| `vcs.repository.name` | filter: keep only the configured target repo (lowercased) |
| `machine.name` | custom, set per machine via `OTEL_RESOURCE_ATTRIBUTES=machine.name=laptop` (or `vps`). Missing → `"unknown"` |
| `query_source` / `agent.name` | on `api_request` / `assistant_response`: `repl_main_thread` = main drone; anything else = a subagent (child drone keyed by that name) |
| `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`, `duration_ms` | on `api_request` |
| `tool_name`, `tool_use_id`, `success`, `duration_ms`, `tool_parameters` (JSON string; `subagent_type`, `skill_name`, `bash_command`, `mcp_server_name`…) | on `tool_result` / `tool_decision` |
| `decision` (`accept`/`reject`) | on `tool_decision` |
| `agent_type`, `total_tool_uses`, `duration_ms` | on `subagent_completed` |
| `drone.label`, `drone.agent_id` | **replay-only extensions** (Claude Code never sends them): ticket label of the replayed session, and the exact subagent a `subagent_completed` refers to. See `docs/telemetry.md` |

OTel has no working-folder attribute. Subagents do **not** get their own `session.id`. They appear inside the parent session through `query_source`/`agent.name`, and through `tool_result` with `tool_name` = `Agent`/`Task` (spawn) and `subagent_completed` (dock).

Normalizer rules (see `packages/model/src/otlp.ts`): `event.name` may carry a `claude_code.` prefix (stripped) and falls back to the record body. `query_source` absent, `repl_main_thread` or `compact` means the main drone (`agentId = null`); anything else is a subagent keyed by `agent.name` when present, else by `query_source`. `tool_decision` for `Agent`/`Task` becomes `subagent_spawn`; `tool_result` for them stays `tool_result` (an async launch returns immediately, so it is not a completion). Records without `session.id` or event name are malformed; records whose `vcs.repository.name` differs from the target (or is missing) are filtered; unmapped event names are counted per name. Prompt and response text is never read.

OTLP JSON attribute values are `{ stringValue | intValue | doubleValue | boolValue | arrayValue }`. Note that `intValue` arrives as a string.

### 2. Session JSONL (backfill and replay)

Path: `~/.claude/projects/<project-dir>/<sessionId>.jsonl`, with subagents in `<sessionId>/subagents/agent-<agentId>.jsonl` plus `agent-<agentId>.meta.json` (`agentType`, `description`, `toolUseId`, `spawnDepth`). The project dir is the cwd with separators replaced by `-`. Git worktree sessions look like `...-<repo>-worktrees-t<N>`, which gives the **ticket label `t<N>`** (the regex is configurable via `TICKET_LABEL_RE`).

Relevant line types:
- `user`: `message.content` is a string (a prompt) or an array containing `tool_result` blocks.
- `assistant`: `message.model`, `message.usage`, and `message.content[]` blocks `text` / `thinking` / `tool_use{id,name,input}`.
- `system`: e.g. hook / stop info.
- `ai-title`: `aiTitle`.

One API response is written as several `assistant` lines (one per content block) sharing a `requestId` and the same `usage`; the parser emits a single `api_request` per `requestId`. `tool_use` becomes `tool_decision` (or `subagent_spawn` for `Agent`/`Task`); a `tool_result` block becomes `tool_result`, or `subagent_done` for `Agent`/`Task` results whose `toolUseResult.status` is not `async_launched`. Subagent files carry `isSidechain: true` and the parent's `sessionId`; their events get `agentId` from the file name. The ticket label comes from the project dir, or from `cwd` with every non-alphanumeric character replaced by `-`.

Every line has `timestamp`, `sessionId`, `cwd`, `gitBranch`. Ignore the other line types. The format is internal to Claude Code and can change, so skip and count lines you don't recognise; never throw. **Real JSONL is never committed. Test fixtures are synthetic.**

## Normalized model (`packages/model`)

```ts
type Machine = string;                    // "laptop" | "vps" | "unknown" | …
type EventKind =
  | "prompt"            // user_prompt
  | "api_request"       // api_request (model call finished)
  | "response"          // assistant_response
  | "tool_decision"     // tool_decision
  | "tool_result"       // tool_result
  | "subagent_spawn"    // Agent/Task tool_use (JSONL) or tool_decision for Agent/Task (OTel)
  | "subagent_done"     // subagent_completed (OTel) or Agent/Task tool_result
  | "compaction"
  | "error";            // api_error, failed tool_result also sets ok=false

interface SessionEvent {
  id: string;                  // stable: tool_use_id / request_id / message uuid / synthesized hash
  sessionId: string;
  agentId: string | null;      // null = main drone; else subagent key (query_source/agent.name or JSONL agentId)
  kind: EventKind;
  ts: number;                  // epoch ms
  machine: Machine;
  source: "otel" | "jsonl";
  tool?: string;               // tool name ("Bash", "Edit", "mcp__x__y", "Agent"…)
  detail?: string;             // short, single line, ≤ 120 chars (e.g. bash description, file basename, skill name). Never prompt text.
  ok?: boolean;
  durationMs?: number;
  model?: string;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd?: number;
  label?: string;              // ticket label hint (e.g. "t245") when derivable from the working dir
  spawnId?: string;            // tool_use_id of the Agent/Task call that launched this event's subagent, when known
  agentType?: string;          // subagent type when known (JSONL meta, OTel agent_type)
}

type SessionRole = "session" | "conductor";     // conductor = spawns ≥ 3 subagents or ≥ 2 concurrent; rule lives in model
type SessionState = "active" | "idle" | "ended";

interface SubagentInfo {
  id: string; type: string | null; state: "running" | "docked"; startedAt: number; endedAt?: number;
  spawnId?: string;            // the spawning tool_use_id; while id === spawnId the spawn is not yet bound to the subagent's own key
}

interface Session {
  id: string;
  shortId: string;             // first 8 chars
  label: string;               // "t245" when derivable, else shortId
  machine: Machine;
  role: SessionRole;
  state: SessionState;
  model: string | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  startedAt: number;
  lastEventAt: number;
  endedAt: number | null;
  subagents: Record<string, SubagentInfo>;
  recent: SessionEvent[];      // ring buffer, last 50, for the inspect panel
}
```

Lifecycle (pure, with an injected `now`):
- **active**: an event arrived within `IDLE_AFTER_MS` (default 60 s).
- **idle**: no events for `IDLE_AFTER_MS`.
- **ended**: no events for `END_AFTER_MS` (default 30 min). OTel has no explicit end event.
- **removed**: `FADE_AFTER_MS` (15 min) after `endedAt`.

Subagent bookkeeping (`applyEvent`): a `subagent_spawn` creates a running entry keyed by its `spawnId`. OTel gives no subagent id at spawn, so the first event from an unknown subagent key binds to the oldest pending spawn (same type first, or the exact `spawnId` for JSONL), re-keying the entry. `subagent_done` docks the entry named by `agentId`/`spawnId`, else the oldest running one of the same `agentType`, else the oldest running one. A docked subagent that does work again is revived. When a session ends, its running subagents are docked. Role is sticky: conductor = at least 3 subagents ever spawned, or at least 2 running at once.

`tick(sessions, now)` returns `{ updated, removed }`: only sessions whose state changed, and the ids past `FADE_AFTER_MS`. `endedAt` is `lastEventAt + END_AFTER_MS`, so it does not depend on when the tick ran. Removal is `lastEventAt + END_AFTER_MS + FADE_AFTER_MS`, which means backfilled sessions older than 45 minutes never appear.

Ordering for layout: state (active, idle, ended), then `lastEventAt` descending.

## Wire protocol (hub → browser, `GET /ws`)

JSON text frames, each `{ v: 1, type, … }`:

```ts
type ServerMsg =
  | { v: 1; type: "snapshot"; now: number; sessions: Session[] }
  | { v: 1; type: "events"; events: SessionEvent[] }          // batched, ≤ 50ms coalescing
  | { v: 1; type: "session"; session: Session }               // upsert after state/role/tokens change
  | { v: 1; type: "remove"; sessionId: string };
```

`events` frames hold at most 500 events; the hub coalesces per client for 50 ms (`COALESCE_MS`), sends `events` first, then `session` upserts (latest per session), then `remove`. Each client has a bounded queue (`WS_MAX_QUEUED`, default 5000) and a socket-buffer high-water mark (`WS_HIGH_WATER_BYTES`, default 1 MiB): beyond either, the hub drops that client's queue and sends a fresh `snapshot` once the socket drains. `packages/model` exports `parseServerMsg` and `applyServerMsg` for clients.

The client applies `events` to its local copy for animation and treats `session` as authoritative state. On reconnect it waits for a fresh `snapshot`. The browser never sends anything except an optional `{ v: 1, type: "hello" }`.

Hub HTTP surface: `POST /v1/logs` (OTLP/HTTP, `Content-Type: application/json` only; protobuf gets 415, so clients set `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`; optional gzip), `GET /health` (uptime, session count, ws clients, counters for requests/records/accepted/filtered/unknown/malformed/duplicates, backfill stats), `GET /ws`. Events are de-duplicated per session by `(kind, id)`. Lifecycle tick every 5 s (`TICK_MS`).

Default hub port: **8787** (`HUB_PORT`); bind `HUB_HOST` (default `127.0.0.1`). Backfill (`BACKFILL=1`): scans `CLAUDE_PROJECTS_DIR` (default `~/.claude/projects`) for project dirs starting with `BACKFILL_DIR_PREFIX` and loads sessions modified within `BACKFILL_MINUTES` (default 120) with `machine = MACHINE_NAME`. Subagent files untouched for `IDLE_AFTER_MS` get a synthetic `subagent_done`. Target repo: `TARGET_REPO` (required, lowercased bare repo name; no default is committed).
