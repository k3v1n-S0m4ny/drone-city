import { stat } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadDotEnv } from "./env.ts";
import { findSubagents, listSessions, loadSession } from "./jsonl-files.ts";
import type { SessionFiles } from "./jsonl-files.ts";
import { buildItems, parseSpeed, runReplay } from "./replay-lib.ts";
import type { Speed } from "./replay-lib.ts";
import { compileTicketLabelRe } from "@drone-city/model";
import type { SessionEvent } from "@drone-city/model";

const USAGE = `Usage: pnpm replay <session.jsonl | project-dir>... [options]

Replays local Claude Code session logs (main + subagents) to a running hub as OTLP/HTTP JSON,
honoring the original timing. Logs are read at runtime and never copied.

Options:
  --speed <1|10|N|burst>  timing divisor; "burst" keeps real-time bursts but compresses
                          gaps over 2 s to 2 s (default: 1)
  --target <url>          hub base URL (default: http://127.0.0.1:$HUB_PORT or :8787)
  --loop                  repeat forever (each pass gets fresh session ids)
  --sessions <N>          for a project dir: the N most recently modified sessions (default: 1)
  --machine <name>        machine.name to report (default: $MACHINE_NAME or "replay")
  --faithful-attribution  attribute only api_request/assistant_response to subagents, like
                          real Claude Code output (default: attribute every event)
  -h, --help

Needs TARGET_REPO (from .env or the environment): it is stamped as vcs.repository.name so the
hub's repo filter accepts the replayed events.`;

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve one CLI path to session file sets. */
export async function resolveInput(path: string, sessions: number): Promise<SessionFiles[]> {
  const abs = resolve(path);
  if (await isDir(abs)) {
    const all = await listSessions(abs);
    if (all.length === 0) throw new Error(`no *.jsonl session files in ${basename(abs)}`);
    return all.slice(0, sessions);
  }
  if (extname(abs) !== ".jsonl")
    throw new Error(`not a .jsonl file or directory: ${basename(abs)}`);
  const st = await stat(abs).catch(() => undefined);
  if (!st) throw new Error(`file not found: ${basename(abs)}`);
  return [
    {
      projectDir: basename(dirname(abs)),
      sessionId: basename(abs, ".jsonl"),
      file: abs,
      mtimeMs: st.mtimeMs,
      subagents: await findSubagents(abs),
    },
  ];
}

async function main(): Promise<number> {
  loadDotEnv();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      speed: { type: "string", default: "1" },
      target: { type: "string" },
      loop: { type: "boolean", default: false },
      sessions: { type: "string", default: "1" },
      machine: { type: "string" },
      "faithful-attribution": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const repo = process.env.TARGET_REPO?.trim().toLowerCase();
  if (!repo) {
    console.error("replay: TARGET_REPO is required (set it in .env or the environment).");
    return 2;
  }
  let speed: Speed;
  try {
    speed = parseSpeed(values.speed);
  } catch (err) {
    console.error(`replay: ${(err as Error).message}`);
    return 2;
  }
  const nSessions = Number(values.sessions);
  if (!Number.isInteger(nSessions) || nSessions < 1) {
    console.error("replay: --sessions must be a positive integer");
    return 2;
  }
  const target = (
    values.target ?? `http://127.0.0.1:${process.env.HUB_PORT?.trim() || "8787"}`
  ).replace(/\/+$/, "");
  const url = target.endsWith("/v1/logs") ? target : `${target}/v1/logs`;
  const machine = values.machine ?? process.env.MACHINE_NAME?.trim() ?? "replay";
  const ticketRe = compileTicketLabelRe(process.env.TICKET_LABEL_RE);

  const sets: SessionFiles[] = [];
  try {
    for (const p of positionals) sets.push(...(await resolveInput(p, nSessions)));
  } catch (err) {
    console.error(`replay: ${(err as Error).message}`);
    return 2;
  }

  const sessions: SessionEvent[][] = [];
  let events = 0;
  let subagentFiles = 0;
  for (const s of sets) {
    const r = await loadSession(s, { machine, ticketRe, subagentFinished: () => true });
    if (r.events.length === 0) continue;
    sessions.push(r.events);
    events += r.events.length;
    subagentFiles += s.subagents.length;
  }
  if (sessions.length === 0) {
    console.error("replay: no replayable events found");
    return 1;
  }
  console.log(
    `replay: ${sessions.length} session(s), ${subagentFiles} subagent file(s), ${events} events -> ${url} ` +
      `(speed ${String(speed)}${values.loop ? ", looping" : ""})`,
  );

  const items = buildItems(sessions, speed);
  const durationS = Math.round((items.at(-1)?.at ?? 0) / 1000);
  console.log(`replay: scheduled span ${durationS}s per pass`);

  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
  });

  let warned = false;
  const post = async (payload: unknown): Promise<boolean> => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        if (!warned) console.error(`replay: hub answered HTTP ${res.status}: ${await res.text()}`);
        warned = true;
      }
      return res.ok;
    } catch (err) {
      if (!warned) {
        console.error(
          `replay: cannot reach ${url} (${(err as Error).message}). Is the hub running?`,
        );
      }
      warned = true;
      return false;
    }
  };

  let seq = 0;
  let sent = 0;
  let batches = 0;
  let failed = 0;
  let iteration = 0;
  do {
    const r = await runReplay({
      items,
      repo,
      machine,
      post,
      now: () => Date.now(),
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      iteration,
      faithfulAttribution: values["faithful-attribution"],
      shouldStop: () => stop,
      nextSequence: () => seq++,
    });
    sent += r.sent;
    batches += r.batches;
    failed += r.failedBatches;
    iteration++;
    if (r.batches > 0 && r.failedBatches === r.batches) break; // hub unreachable: do not spin
  } while (values.loop && !stop);

  console.log(`replay: done. ${sent} records in ${batches} batches (${failed} failed)`);
  return failed > 0 ? 1 : 0;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`replay: fatal: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
