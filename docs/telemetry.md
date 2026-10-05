# Turning on the telemetry stream

drone-city reads Claude Code's native OpenTelemetry **log** export. Nothing in the watched repository is touched: the settings live in the **user-level** `~/.claude/settings.json`, on each machine that runs Claude Code.

Placeholders used below: `<hub-host>` is the address the hub is reachable at from that machine (for example a private-network name or address). Never commit the real value.

## 1. Run the hub

```
cp .env.example .env        # then set TARGET_REPO (bare repo name, lowercase)
pnpm dev:hub
```

The hub listens on `HUB_HOST:HUB_PORT` (default `127.0.0.1:8787`). To receive events from another machine, set `HUB_HOST` in `.env` to an interface that machine can reach, and keep it on a private network: the hub has no authentication.

Only `Content-Type: application/json` is accepted on `POST /v1/logs`. Clients **must** use `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`; a protobuf client gets HTTP 415 with a message saying so.

## 2. Settings block

Add this `env` block to the user-level settings file of each machine, merging it with whatever is already in the file.

- Windows: `%USERPROFILE%\.claude\settings.json`
- Linux / macOS: `~/.claude/settings.json`

Laptop (Windows):

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://<hub-host>:8787/v1/logs",
    "OTEL_LOGS_EXPORT_INTERVAL": "1000",
    "OTEL_METRICS_INCLUDE_REPOSITORY": "true",
    "OTEL_LOG_TOOL_DETAILS": "1",
    "OTEL_RESOURCE_ATTRIBUTES": "machine.name=laptop"
  }
}
```

VPS (Linux): the same block with `"OTEL_RESOURCE_ATTRIBUTES": "machine.name=vps"`. If Claude Code runs on the same machine as the hub, the endpoint can be `http://127.0.0.1:8787/v1/logs`.

What each setting does:

| Setting                                                | Why                                                                                                                                                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_CODE_ENABLE_TELEMETRY=1`                       | Master switch.                                                                                                                                                                            |
| `OTEL_LOGS_EXPORTER=otlp`                              | Export events as OTLP log records. We want logs only.                                                                                                                                     |
| `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`                | The hub speaks OTLP/HTTP with JSON encoding only. Claude Code has no default protocol, so this must be set.                                                                               |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`                     | Logs-specific endpoint (takes precedence over the generic `OTEL_EXPORTER_OTLP_ENDPOINT`). With this form the full path `/v1/logs` is part of the value, nothing is appended.              |
| `OTEL_LOGS_EXPORT_INTERVAL=1000`                       | Flush every second instead of the 5 s default, so the city feels live.                                                                                                                    |
| `OTEL_METRICS_INCLUDE_REPOSITORY=true`                 | Adds `vcs.repository.name` (derived from the `origin` remote, lowercased) to every event. The hub filters on it. Needs Claude Code v2.1.269 or later.                                     |
| `OTEL_LOG_TOOL_DETAILS=1`                              | Adds `tool_parameters` / `tool_input` so the hub can show a short detail (Bash description, file name, skill, subagent type) and name MCP tools and custom subagent types.               |
| `OTEL_RESOURCE_ATTRIBUTES=machine.name=laptop` (`vps`) | Custom resource attribute the hub reads as the machine label. No spaces allowed in the value. Without it the machine shows as `unknown`.                                                  |

**Prompts stay private.** Do not set `OTEL_LOG_USER_PROMPTS` (or `OTEL_LOG_ASSISTANT_RESPONSES`): prompt and response text then arrive redacted. The hub never reads prompt or response text anyway; `detail` is built only from tool metadata, capped at 120 characters, single line.

**Metrics are not exported.** `OTEL_METRICS_EXPORTER` is left unset and no generic `OTEL_EXPORTER_OTLP_ENDPOINT` is configured, so nothing is sent to the hub except logs. If your Claude Code version exports metrics by default, add `"OTEL_METRICS_EXPORTER": "none"`.

**Clocks.** Sessions go idle (60 s) and end (30 min) based on the event timestamps, so keep the clocks of the machines roughly in sync (NTP).

**Settings are read at launch.** Restart Claude Code sessions after editing the file; sessions that were already running keep their old settings.

## 3. Verify

1. Start the hub and check it is up: `curl http://<hub-host>:8787/health`. The JSON has `uptimeSec`, `sessions`, `wsClients`, and `counters`.
2. Start a Claude Code session in the target repository and submit a prompt.
3. Check `/health` again: `counters.requests` and `counters.accepted` increase, `sessions` becomes 1 (`sessions` is the number of live sessions held by the hub). `counters.filtered` counts events from other repositories, `counters.unknown` maps unmapped event names to counts, and `counters.malformed` counts unusable records.
4. Open the debug view (`pnpm dev:web`, then the printed URL) to see the session row.

If nothing arrives:

- `counters.unsupportedMediaType` increasing means the client is sending protobuf; fix `OTEL_EXPORTER_OTLP_PROTOCOL`.
- `counters.filtered` increasing but `accepted` not: the repository name differs from `TARGET_REPO`, or the events carry no `vcs.repository.name` (Claude Code older than v2.1.269, no `origin` remote, or `OTEL_METRICS_INCLUDE_REPOSITORY` unset).
- Nothing at all: start Claude Code with `claude --debug-file <path>` and look for `[3P telemetry]` lines, which report exporter failures (wrong host, firewall, wrong port).

## 4. Turn it off

Remove the keys above from the `env` block (or at least set `CLAUDE_CODE_ENABLE_TELEMETRY` to `0`) and restart Claude Code. Removing only `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is not enough to be sure nothing is exported; remove the master switch.

## Testing without Claude Code: replay

`pnpm replay <session.jsonl | project-dir>... [--speed 1|10|burst] [--target http://127.0.0.1:8787] [--loop] [--sessions N]` reads local session logs from `~/.claude/projects` and posts them to the hub as OTLP/HTTP JSON, with the attributes Claude Code would send, timestamped at replay time. `TARGET_REPO` must be set (it is stamped as `vcs.repository.name`). `burst` keeps real-time bursts but compresses gaps over 2 s to 2 s. Nothing is copied into the repository.

Replay adds three attributes that Claude Code does not send, so that the debug view and prototypes are informative: `drone.label` (ticket label from the project dir), `drone.agent_id` (which subagent finished), and `agent.name`/`agent_type` on tool events (pass `--faithful-attribution` to send them only on `api_request` / `assistant_response`, like Claude Code).

## Unverified assumptions about the OTel stream

These come from the documentation, not from a live capture; check them against the first real events.

- `query_source` for subagents: the docs say "a subagent name" on `api_request` / `assistant_response`, while `subagent_completed` mentions the category `"subagent"`. If real events all carry the literal `subagent`, all subagents of a session collapse into one key (the hub then tracks one running subagent entry per spawn but binds activity to the first one).
- Tool events (`tool_decision`, `tool_result`) carry no `query_source`, so tool activity of a subagent cannot be attributed to it live; it shows on the main drone.
- `subagent_completed` carries `agent_type` but no subagent key, so the hub docks the oldest running subagent of that type.
- `compact` is treated as the main drone's own request, not as a subagent.
