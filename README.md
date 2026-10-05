# drone-city

A live view of Claude Code sessions as drones in an isometric cyberpunk city.

Each Claude Code session working on a chosen target repository becomes a drone in its own district. Subagents launch and dock as child drones, and conductor sessions fly as larger carriers. When events arrive faster than a drone can animate, they show as compact symbol bubbles. Data comes from Claude Code's native OpenTelemetry log export. Nothing in the watched repository is modified.

**Status:** B0 (foundations and design prototypes). See the [issues](https://github.com/k3v1n-S0m4ny/drone-city/issues) and milestones.

Data model and wire contract: [`docs/data-model.md`](docs/data-model.md)

## Quick start

```
pnpm install
cp .env.example .env      # set TARGET_REPO (bare repo name, lowercase)
pnpm dev:hub              # hub on 127.0.0.1:8787: POST /v1/logs, GET /ws, GET /health
pnpm dev:web              # debug table view, proxies /ws to the hub
pnpm replay <session.jsonl | project-dir> --speed burst   # drive the hub from local logs
pnpm lint && pnpm typecheck && pnpm test
```

Turning on the live telemetry on your machines: [`docs/telemetry.md`](docs/telemetry.md).

## Layout

```
apps/hub        OTLP/HTTP receiver, session model, WebSocket fan-out, JSONL backfill/replay
apps/web        React + React Three Fiber renderer
packages/model  shared event types, normalizer, session lifecycle
prototypes/     throwaway design variants (B0 gate)
```

## Privacy

Session logs, prompts, tool output, hostnames and network addresses are never committed. Replay reads logs from `~/.claude/projects` at runtime. Test fixtures are synthetic.

Guardrails:
- `.gitignore` excludes planning state, logs, captures and env files.
- `scripts/public-guard.sh` runs as a pre-commit hook (`git config core.hooksPath .githooks`) and in CI. It blocks home paths, tailnet IPs/hostnames, tokens and raw transcript lines. Extra private patterns go in a gitignored `.public-guard.local`.

## License

MIT
