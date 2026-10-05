import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileTicketLabelRe } from "@drone-city/model";
import type { HubConfig } from "./config.ts";

/** Synthetic data only. Nothing here is derived from a real session. */
export const TEST_REPO = "demo-repo";
export const SID1 = "00000000-0000-4000-8000-000000000001";
export const SID2 = "00000000-0000-4000-8000-000000000002";

export function testConfig(over: Partial<HubConfig> = {}): HubConfig {
  return {
    targetRepo: TEST_REPO,
    host: "127.0.0.1",
    port: 0,
    machineName: "vps",
    backfill: false,
    claudeProjectsDir: "",
    backfillDirPrefix: undefined,
    backfillMinutes: 120,
    ticketLabelRe: compileTicketLabelRe(),
    tickMs: 60_000,
    coalesceMs: 10,
    maxQueued: 5000,
    highWaterBytes: 1024 * 1024,
    maxBodyBytes: 1024 * 1024,
    ...over,
  };
}

type AttrIn = string | number | boolean;

export function kv(obj: Record<string, AttrIn>): unknown[] {
  return Object.entries(obj).map(([key, v]) => ({
    key,
    value:
      typeof v === "string"
        ? { stringValue: v }
        : typeof v === "boolean"
          ? { boolValue: v }
          : { intValue: String(v) },
  }));
}

export function otlpRecord(attrs: Record<string, AttrIn>, ts: number): unknown {
  return {
    timeUnixNano: String(BigInt(ts) * 1_000_000n),
    attributes: kv({
      "session.id": SID1,
      "vcs.repository.name": TEST_REPO,
      "event.timestamp": new Date(ts).toISOString(),
      ...attrs,
    }),
  };
}

export function otlpPayload(records: unknown[], machine = "laptop"): unknown {
  return {
    resourceLogs: [
      {
        resource: { attributes: kv({ "machine.name": machine }) },
        scopeLogs: [{ scope: { name: "synthetic" }, logRecords: records }],
      },
    ],
  };
}

export async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "drone-city-test-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function writeJsonl(
  file: string,
  lines: Array<Record<string, unknown> | string>,
  mtime?: Date,
): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  const body = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";
  await writeFile(file, body, "utf8");
  if (mtime) await utimes(file, mtime, mtime);
}

/** A small synthetic transcript: prompt, a Bash tool round trip, and a text answer. */
export function syntheticSessionLines(
  sessionId: string,
  startMs: number,
  idPrefix = "",
): Array<Record<string, unknown>> {
  const at = (n: number): string => new Date(startMs + n * 1000).toISOString();
  const common = { sessionId, cwd: "/synthetic", gitBranch: "main" };
  return [
    {
      ...common,
      type: "user",
      uuid: `${idPrefix}${sessionId}-u1`,
      timestamp: at(0),
      message: { role: "user", content: "synthetic prompt" },
    },
    {
      ...common,
      type: "assistant",
      uuid: `${idPrefix}${sessionId}-a1`,
      requestId: `${idPrefix}${sessionId}-req1`,
      timestamp: at(1),
      message: {
        model: "model-x",
        content: [
          {
            type: "tool_use",
            id: `${idPrefix}${sessionId}-t1`,
            name: "Bash",
            input: { description: "List files" },
          },
        ],
        usage: {
          input_tokens: 5,
          output_tokens: 7,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 2,
        },
      },
    },
    {
      ...common,
      type: "user",
      uuid: `${idPrefix}${sessionId}-u2`,
      timestamp: at(2),
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `${idPrefix}${sessionId}-t1`,
            content: "ok",
            is_error: false,
          },
        ],
      },
    },
    {
      ...common,
      type: "assistant",
      uuid: `${idPrefix}${sessionId}-a2`,
      requestId: `${idPrefix}${sessionId}-req2`,
      timestamp: at(3),
      message: {
        model: "model-x",
        content: [{ type: "text", text: "done" }],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    },
  ];
}
