import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { END_AFTER_MS, FADE_AFTER_MS } from "@drone-city/model";
import type { SessionEvent } from "@drone-city/model";
import { ConfigError, readConfig } from "./config.ts";
import { findEnvFile, loadDotEnv, parseDotEnv } from "./env.ts";
import { SessionStore } from "./store.ts";
import { makeTempDir } from "./test-helpers.ts";

const T0 = 1_760_000_000_000;
const ev = (over: Partial<SessionEvent>): SessionEvent => ({
  id: "e1",
  sessionId: "00000000-0000-4000-8000-000000000009",
  agentId: null,
  kind: "prompt",
  ts: T0,
  machine: "laptop",
  source: "otel",
  ...over,
});

describe("SessionStore", () => {
  it("dedupes by (kind, id) and reports upserts for touched sessions", () => {
    const store = new SessionStore();
    const a = store.ingest(
      [ev({ id: "x" }), ev({ id: "x" }), ev({ id: "x", kind: "tool_result" })],
      T0,
    );
    expect(a.events).toHaveLength(2);
    expect(a.duplicates).toBe(1);
    expect(a.upserts).toHaveLength(1);
    expect(store.ingest([ev({ id: "x" })], T0).duplicates).toBe(1);
  });

  it("settles backfilled history: idle sessions show, expired ones never appear", () => {
    const store = new SessionStore();
    const idleId = "00000000-0000-4000-8000-0000000000a1";
    const oldId = "00000000-0000-4000-8000-0000000000a2";
    const now = T0 + 5 * 60_000;
    const r = store.ingest(
      [
        ev({ id: "i", sessionId: idleId, ts: T0 }),
        ev({ id: "o", sessionId: oldId, ts: now - END_AFTER_MS - FADE_AFTER_MS - 1000 }),
      ],
      now,
    );
    expect(r.upserts.map((s) => [s.id, s.state])).toEqual([[idleId, "idle"]]);
    expect(r.events.map((e) => e.sessionId)).toEqual([idleId]);
    expect(r.removes).toEqual([]); // never visible, so nothing to remove
    expect(store.size).toBe(1);
  });

  it("tick returns changed sessions and removals, and forgets removed ids", () => {
    const store = new SessionStore();
    store.ingest([ev({})], T0);
    const idle = store.tick(T0 + 61_000);
    expect(idle.upserts[0]?.state).toBe("idle");
    expect(store.tick(T0 + 62_000).upserts).toEqual([]);
    const gone = store.tick(T0 + END_AFTER_MS + FADE_AFTER_MS);
    expect(gone.removes).toEqual([ev({}).sessionId]);
    expect(store.size).toBe(0);
    // the same event id is accepted again after the session was dropped
    expect(
      store.ingest(
        [ev({ ts: T0 + END_AFTER_MS + FADE_AFTER_MS })],
        T0 + END_AFTER_MS + FADE_AFTER_MS,
      ).events,
    ).toHaveLength(1);
  });

  it("snapshot lists every session", () => {
    const store = new SessionStore();
    store.ingest([ev({}), ev({ sessionId: "00000000-0000-4000-8000-0000000000b2" })], T0);
    const snap = store.snapshot(T0);
    expect(snap.type === "snapshot" && snap.sessions).toHaveLength(2);
  });
});

describe("readConfig", () => {
  it("requires TARGET_REPO and lowercases it", () => {
    expect(() => readConfig({})).toThrow(ConfigError);
    expect(() => readConfig({ TARGET_REPO: "<bare-repo-name-lowercase>" })).toThrow(ConfigError);
    expect(readConfig({ TARGET_REPO: "Some-Repo" }).targetRepo).toBe("some-repo");
  });

  it("applies documented defaults", () => {
    const c = readConfig({ TARGET_REPO: "r" });
    expect(c).toMatchObject({
      host: "127.0.0.1",
      port: 8787,
      machineName: "unknown",
      backfill: false,
      backfillMinutes: 120,
      tickMs: 5000,
      coalesceMs: 50,
    });
    expect(c.claudeProjectsDir.replace(/\\/g, "/")).toMatch(/\.claude\/projects$/);
    expect("-worktrees-t5").toMatch(c.ticketLabelRe);
  });

  it("reads overrides and validates numbers", () => {
    const c = readConfig({
      TARGET_REPO: "r",
      HUB_HOST: "0.0.0.0",
      HUB_PORT: "9000",
      MACHINE_NAME: "vps",
      BACKFILL: "1",
      BACKFILL_DIR_PREFIX: "some-prefix",
      BACKFILL_MINUTES: "30",
      TICKET_LABEL_RE: "-x-(\\d+)$",
    });
    expect(c).toMatchObject({
      host: "0.0.0.0",
      port: 9000,
      machineName: "vps",
      backfill: true,
      backfillMinutes: 30,
    });
    expect(() => readConfig({ TARGET_REPO: "r", HUB_PORT: "abc" })).toThrow(ConfigError);
    expect(() => readConfig({ TARGET_REPO: "r", BACKFILL: "1" })).toThrow(/BACKFILL_DIR_PREFIX/);
  });
});

describe("env loading", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it("parses KEY=VALUE, comments, quotes and export prefixes", () => {
    expect(
      parseDotEnv(`# c\nA=1\nB="two words"\nexport C='x'\nD=val # trailing\n\nbad line\n`),
    ).toEqual({ A: "1", B: "two words", C: "x", D: "val" });
  });

  it("finds the nearest .env walking up, and loads without overriding existing vars", async () => {
    const t = await makeTempDir();
    cleanups.push(t.cleanup);
    await writeFile(join(t.dir, ".env"), "FOO=from-file\nBAR=from-file\n");
    const nested = join(t.dir, "a", "b");
    await mkdir(nested, { recursive: true });
    expect(findEnvFile(nested)).toBe(join(t.dir, ".env"));
    const env: NodeJS.ProcessEnv = { BAR: "already" };
    expect(loadDotEnv(nested, env)).toBe(join(t.dir, ".env"));
    expect(env).toEqual({ FOO: "from-file", BAR: "already" });
  });
});
