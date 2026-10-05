import { homedir } from "node:os";
import { join } from "node:path";
import { compileTicketLabelRe } from "@drone-city/model";

export class ConfigError extends Error {}

export interface HubConfig {
  /** Bare repo name (lowercased). Required: only events with this vcs.repository.name are kept. */
  targetRepo: string;
  host: string;
  port: number;
  /** Machine label for JSONL backfill events (OTel events carry machine.name themselves). */
  machineName: string;
  backfill: boolean;
  claudeProjectsDir: string;
  /** Only project dirs starting with this are scanned. Required when backfill is on. */
  backfillDirPrefix: string | undefined;
  backfillMinutes: number;
  ticketLabelRe: RegExp;
  /** Lifecycle tick interval. */
  tickMs: number;
  /** Per-client coalescing window for WebSocket batches. */
  coalesceMs: number;
  /** Per-client queue bound (events + upserts) before a drop + resnapshot. */
  maxQueued: number;
  /** ws.bufferedAmount above which a client counts as slow. */
  highWaterBytes: number;
  /** Max accepted request body (bytes). */
  maxBodyBytes: number;
}

type Env = Record<string, string | undefined>;

function int(env: Env, key: string, fallback: number, min = 0): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`${key} must be an integer >= ${min}`);
  return n;
}

export function readConfig(env: Env = process.env): HubConfig {
  const targetRepo = env.TARGET_REPO?.trim().toLowerCase();
  if (!targetRepo || targetRepo.startsWith("<")) {
    throw new ConfigError(
      "TARGET_REPO is required (bare repo name). Copy .env.example to .env and set it.",
    );
  }
  const backfill = env.BACKFILL === "1" || env.BACKFILL === "true";
  const backfillDirPrefix = env.BACKFILL_DIR_PREFIX?.trim() || undefined;
  if (backfill && (!backfillDirPrefix || backfillDirPrefix.startsWith("<"))) {
    throw new ConfigError("BACKFILL=1 requires BACKFILL_DIR_PREFIX (project-dir name prefix).");
  }
  return {
    targetRepo,
    host: env.HUB_HOST?.trim() || "127.0.0.1",
    port: int(env, "HUB_PORT", 8787),
    machineName: env.MACHINE_NAME?.trim() || "unknown",
    backfill,
    claudeProjectsDir: env.CLAUDE_PROJECTS_DIR?.trim() || join(homedir(), ".claude", "projects"),
    backfillDirPrefix,
    backfillMinutes: int(env, "BACKFILL_MINUTES", 120, 1),
    ticketLabelRe: compileTicketLabelRe(env.TICKET_LABEL_RE),
    tickMs: int(env, "TICK_MS", 5000, 10),
    coalesceMs: int(env, "COALESCE_MS", 50),
    maxQueued: int(env, "WS_MAX_QUEUED", 5000, 1),
    highWaterBytes: int(env, "WS_HIGH_WATER_BYTES", 1024 * 1024, 1),
    maxBodyBytes: int(env, "MAX_BODY_BYTES", 8 * 1024 * 1024, 1),
  };
}
