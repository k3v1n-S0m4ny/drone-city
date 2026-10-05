import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { createInterface } from "node:readline";
import { createJsonlParser } from "@drone-city/model";
import type { JsonlContext, JsonlStats, SessionEvent } from "@drone-city/model";

export interface SubagentFile {
  file: string;
  agentId: string;
  agentType?: string;
  spawnId?: string;
  mtimeMs: number;
}

export interface SessionFiles {
  /** Project dir name (not a path). */
  projectDir: string;
  sessionId: string;
  file: string;
  mtimeMs: number;
  subagents: SubagentFile[];
}

export interface ReadStats extends JsonlStats {
  unreadable: number;
}

export const emptyReadStats = (): ReadStats => ({
  lines: 0,
  events: 0,
  ignored: 0,
  malformed: 0,
  unreadable: 0,
});

export function addReadStats(into: ReadStats, from: Partial<ReadStats>): void {
  into.lines += from.lines ?? 0;
  into.events += from.events ?? 0;
  into.ignored += from.ignored ?? 0;
  into.malformed += from.malformed ?? 0;
  into.unreadable += from.unreadable ?? 0;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function safeMtime(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function readMeta(file: string): Promise<{ agentType?: string; spawnId?: string }> {
  try {
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof raw !== "object" || raw === null) return {};
    const o = raw as Record<string, unknown>;
    return {
      ...(typeof o.agentType === "string" ? { agentType: o.agentType } : {}),
      ...(typeof o.toolUseId === "string" ? { spawnId: o.toolUseId } : {}),
    };
  } catch {
    return {};
  }
}

/** The subagent files that belong to a session file: `<dir>/<sessionId>/subagents/agent-*.jsonl`. */
export async function findSubagents(sessionFile: string): Promise<SubagentFile[]> {
  const sessionId = basename(sessionFile, extname(sessionFile));
  const dir = join(dirname(sessionFile), sessionId, "subagents");
  const out: SubagentFile[] = [];
  for (const name of await safeReaddir(dir)) {
    const m = /^agent-(.+)\.jsonl$/.exec(name);
    if (!m?.[1]) continue;
    const file = join(dir, name);
    const mtimeMs = await safeMtime(file);
    if (mtimeMs === undefined) continue;
    const meta = await readMeta(join(dir, `agent-${m[1]}.meta.json`));
    out.push({ file, agentId: m[1], mtimeMs, ...meta });
  }
  return out;
}

/** Session files (`*.jsonl`) directly inside one project dir, newest first. */
export async function listSessions(projectDirPath: string): Promise<SessionFiles[]> {
  const projectDir = basename(projectDirPath);
  const out: SessionFiles[] = [];
  for (const name of await safeReaddir(projectDirPath)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(projectDirPath, name);
    const mtimeMs = await safeMtime(file);
    if (mtimeMs === undefined) continue;
    out.push({
      projectDir,
      sessionId: basename(name, ".jsonl"),
      file,
      mtimeMs,
      subagents: await findSubagents(file),
    });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Project dirs under `projectsDir` whose name starts with `prefix`. */
export async function listProjectDirs(projectsDir: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await safeReaddir(projectsDir)) {
    if (!name.startsWith(prefix)) continue;
    const full = join(projectsDir, name);
    try {
      if ((await stat(full)).isDirectory()) out.push(full);
    } catch {
      // vanished between readdir and stat
    }
  }
  return out;
}

/** Stream a JSONL file line by line through the parser. Never throws; unreadable files are counted. */
export async function readJsonlFile(
  file: string,
  ctx: JsonlContext,
): Promise<{ events: SessionEvent[]; stats: ReadStats }> {
  const parser = createJsonlParser(ctx);
  const events: SessionEvent[] = [];
  const stats = emptyReadStats();
  try {
    const rl = createInterface({
      input: createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) events.push(...parser.parseLine(line));
  } catch {
    stats.unreadable++;
  }
  addReadStats(stats, parser.stats);
  return { events, stats };
}

export interface LoadOptions {
  machine: string;
  ticketRe?: RegExp;
  /**
   * Whether a subagent file is considered finished. Finished subagents get a synthetic
   * `subagent_done` at their last event (unless the parent already recorded one), so history
   * does not show them running forever. Default: never.
   */
  subagentFinished?: (sub: SubagentFile) => boolean;
}

/** Load a whole session (main file + subagent files) as time-ordered events. */
export async function loadSession(
  s: SessionFiles,
  opts: LoadOptions,
): Promise<{ events: SessionEvent[]; stats: ReadStats; filesRead: number }> {
  const stats = emptyReadStats();
  const base: JsonlContext = {
    machine: opts.machine,
    projectDir: s.projectDir,
    ...(opts.ticketRe ? { ticketRe: opts.ticketRe } : {}),
  };
  const main = await readJsonlFile(s.file, base);
  addReadStats(stats, main.stats);
  const events = [...main.events];
  for (const sub of s.subagents) {
    const r = await readJsonlFile(sub.file, {
      ...base,
      agentId: sub.agentId,
      ...(sub.agentType ? { agentType: sub.agentType } : {}),
      ...(sub.spawnId ? { spawnId: sub.spawnId } : {}),
    });
    addReadStats(stats, r.stats);
    events.push(...r.events);
    const last = r.events.at(-1);
    const alreadyDone = main.events.some(
      (e) =>
        e.kind === "subagent_done" &&
        (e.agentId === sub.agentId || (sub.spawnId !== undefined && e.spawnId === sub.spawnId)),
    );
    if (last && !alreadyDone && opts.subagentFinished?.(sub)) {
      events.push({
        id: `jsonl:${sub.agentId}:done`,
        sessionId: last.sessionId,
        agentId: sub.agentId,
        kind: "subagent_done",
        ts: last.ts,
        machine: opts.machine,
        source: "jsonl",
        ok: true,
        ...(sub.agentType ? { agentType: sub.agentType, detail: sub.agentType } : {}),
        ...(sub.spawnId ? { spawnId: sub.spawnId } : {}),
      });
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  return { events, stats, filesRead: 1 + s.subagents.length };
}
