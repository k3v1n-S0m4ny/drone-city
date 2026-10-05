import { IDLE_AFTER_MS } from "@drone-city/model";
import type { HubConfig } from "./config.ts";
import { listProjectDirs, listSessions, loadSession } from "./jsonl-files.ts";
import type { BackfillStats, Hub } from "./server.ts";
import type { Clock } from "./store.ts";

/**
 * Scan `CLAUDE_PROJECTS_DIR` for project dirs starting with `BACKFILL_DIR_PREFIX`, load the
 * sessions modified within `BACKFILL_MINUTES` (main + subagent files), and feed them to the hub.
 * Never throws: unreadable files and malformed lines are counted in `hub.backfill`.
 */
export async function runBackfill(
  config: HubConfig,
  hub: Pick<Hub, "ingest" | "backfill">,
  clock: Clock,
): Promise<BackfillStats> {
  const stats = hub.backfill;
  stats.ran = true;
  if (!config.backfillDirPrefix) return stats;
  const cutoff = clock.now() - config.backfillMinutes * 60_000;

  const all = [];
  for (const dir of await listProjectDirs(config.claudeProjectsDir, config.backfillDirPrefix)) {
    stats.dirs++;
    for (const s of await listSessions(dir)) {
      const newest = Math.max(s.mtimeMs, ...s.subagents.map((a) => a.mtimeMs));
      if (newest >= cutoff) all.push(s);
    }
  }

  const events = [];
  for (const s of all) {
    const r = await loadSession(s, {
      machine: config.machineName,
      ticketRe: config.ticketLabelRe,
      subagentFinished: (sub) => clock.now() - sub.mtimeMs >= IDLE_AFTER_MS,
    });
    stats.sessions++;
    stats.files += r.filesRead;
    stats.lines += r.stats.lines;
    stats.events += r.stats.events;
    stats.ignored += r.stats.ignored;
    stats.malformed += r.stats.malformed;
    stats.unreadable += r.stats.unreadable;
    events.push(...r.events);
  }
  events.sort((a, b) => a.ts - b.ts);
  hub.ingest(events);
  return stats;
}
