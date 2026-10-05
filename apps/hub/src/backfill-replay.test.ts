import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDLE_AFTER_MS, normalizeOtlpPayload } from "@drone-city/model";
import type { SessionEvent } from "@drone-city/model";
import { runBackfill } from "./backfill.ts";
import { listProjectDirs, listSessions, loadSession } from "./jsonl-files.ts";
import {
  BURST_MAX_GAP_MS,
  buildItems,
  eventToRecord,
  parseSpeed,
  runReplay,
  scheduleOffsets,
  withIteration,
} from "./replay-lib.ts";
import { resolveInput } from "./replay.ts";
import { createHub, silentLogger } from "./server.ts";
import {
  SID1,
  SID2,
  TEST_REPO,
  makeTempDir,
  syntheticSessionLines,
  testConfig,
  writeJsonl,
} from "./test-helpers.ts";

const NOW = Date.parse("2026-03-01T12:00:00.000Z");
const PREFIX = "demo-proj-worktrees";

describe("JSONL backfill", () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const t = await makeTempDir();
    dir = t.dir;
    cleanup = t.cleanup;
  });
  afterEach(async () => cleanup());

  const recent = new Date(NOW - 5 * 60_000);

  it("finds sessions in matching project dirs within the time window, with subagents", async () => {
    const p1 = join(dir, `${PREFIX}-t16`);
    await writeJsonl(
      join(p1, `${SID1}.jsonl`),
      syntheticSessionLines(SID1, NOW - 10 * 60_000),
      recent,
    );
    const subDir = join(p1, SID1, "subagents");
    await writeJsonl(
      join(subDir, "agent-abc.jsonl"),
      syntheticSessionLines(SID1, NOW - 9 * 60_000, "sub-").map((l) => ({
        ...l,
        isSidechain: true,
        agentId: "abc",
      })),
      recent,
    );
    await writeJsonl(join(subDir, "agent-abc.meta.json"), [
      { agentType: "reviewer", toolUseId: "toolu_spawn" },
    ]);

    // stale session in a matching dir, and a session in a non-matching dir
    await writeJsonl(
      join(p1, `${SID2}.jsonl`),
      syntheticSessionLines(SID2, NOW - 5 * 3600_000),
      new Date(NOW - 5 * 3600_000),
    );
    await writeJsonl(
      join(dir, "unrelated-project", `${SID2}.jsonl`),
      syntheticSessionLines(SID2, NOW - 60_000),
      recent,
    );

    expect(await listProjectDirs(dir, PREFIX)).toEqual([p1]);
    const sessions = await listSessions(p1);
    expect(sessions.map((s) => s.sessionId)).toContain(SID1);
    expect(sessions.find((s) => s.sessionId === SID1)?.subagents).toMatchObject([
      { agentId: "abc", agentType: "reviewer", spawnId: "toolu_spawn" },
    ]);
  });

  it("feeds the hub store: label from the project dir, subagents under the parent, machine from config", async () => {
    const p1 = join(dir, `${PREFIX}-t16`);
    await writeJsonl(
      join(p1, `${SID1}.jsonl`),
      [
        ...syntheticSessionLines(SID1, NOW - 10 * 60_000),
        "{broken json",
        JSON.stringify({ type: "ai-title", aiTitle: "t", sessionId: SID1 }),
      ],
      recent,
    );
    const subDir = join(p1, SID1, "subagents");
    await writeJsonl(
      join(subDir, "agent-abc.jsonl"),
      syntheticSessionLines(SID1, NOW - 9 * 60_000, "sub-").map((l) => ({
        ...l,
        isSidechain: true,
        agentId: "abc",
      })),
      new Date(NOW - 8 * 60_000),
    );
    await writeJsonl(join(subDir, "agent-abc.meta.json"), [{ agentType: "reviewer" }]);
    await writeJsonl(
      join(dir, "other-dir", `${SID2}.jsonl`),
      syntheticSessionLines(SID2, NOW - 60_000),
      recent,
    );

    const config = testConfig({
      claudeProjectsDir: dir,
      backfillDirPrefix: PREFIX,
      backfill: true,
    });
    const clock = { now: () => NOW };
    const hub = createHub(config, { clock, logger: silentLogger });
    const stats = await runBackfill(config, hub, clock);

    expect(stats).toMatchObject({
      ran: true,
      dirs: 1,
      sessions: 1,
      files: 2,
      malformed: 1,
      unreadable: 0,
    });
    expect(stats.events).toBeGreaterThan(8);
    const s = hub.store.sessions.get(SID1);
    expect(s).toBeDefined();
    expect(s).toMatchObject({ label: "t16", machine: "vps", model: "model-x", state: "idle" });
    expect(s?.subagents["abc"]).toMatchObject({ type: "reviewer", state: "docked" }); // finished long ago
    expect(s?.tokens.input).toBeGreaterThan(0);
    expect(hub.store.sessions.has(SID2)).toBe(false);
    await hub.close();
  });

  it("keeps a recently active subagent running", async () => {
    const p1 = join(dir, `${PREFIX}-t1`);
    await writeJsonl(
      join(p1, `${SID1}.jsonl`),
      syntheticSessionLines(SID1, NOW - 30_000),
      new Date(NOW - 1000),
    );
    await writeJsonl(
      join(p1, SID1, "subagents", "agent-live.jsonl"),
      syntheticSessionLines(SID1, NOW - 20_000, "live-").map((l) => ({
        ...l,
        isSidechain: true,
        agentId: "live",
      })),
      new Date(NOW - IDLE_AFTER_MS / 2),
    );
    const config = testConfig({
      claudeProjectsDir: dir,
      backfillDirPrefix: PREFIX,
      backfill: true,
    });
    const clock = { now: () => NOW };
    const hub = createHub(config, { clock, logger: silentLogger });
    await runBackfill(config, hub, clock);
    expect(hub.store.sessions.get(SID1)?.subagents["live"]?.state).toBe("running");
    expect(hub.store.sessions.get(SID1)?.state).toBe("active");
    await hub.close();
  });

  it("never throws on a missing projects dir or unreadable content", async () => {
    const config = testConfig({
      claudeProjectsDir: join(dir, "does-not-exist"),
      backfillDirPrefix: PREFIX,
      backfill: true,
    });
    const clock = { now: () => NOW };
    const hub = createHub(config, { clock, logger: silentLogger });
    const stats = await runBackfill(config, hub, clock);
    expect(stats).toMatchObject({ ran: true, dirs: 0, sessions: 0, events: 0 });
    await hub.close();
  });
});

describe("replay timing", () => {
  const ts = [0, 500, 1000, 10_000, 10_100, 70_000];

  it("scales every gap by the speed divisor", () => {
    expect(scheduleOffsets(ts, 1)).toEqual(ts);
    expect(scheduleOffsets(ts, 10)).toEqual([0, 50, 100, 1000, 1010, 7000]);
  });

  it("burst keeps tight bursts real-time and compresses gaps over 2 s to 2 s", () => {
    const o = scheduleOffsets(ts, "burst");
    expect(o).toEqual([
      0,
      500,
      1000,
      1000 + BURST_MAX_GAP_MS,
      1000 + BURST_MAX_GAP_MS + 100,
      1000 + 2 * BURST_MAX_GAP_MS + 100,
    ]);
  });

  it("parses speeds", () => {
    expect(parseSpeed("10")).toBe(10);
    expect(parseSpeed("burst")).toBe("burst");
    expect(() => parseSpeed("0")).toThrow();
    expect(() => parseSpeed("fast")).toThrow();
  });

  it("starts every session at offset 0 so they run concurrently", () => {
    const mk = (sid: string, base: number): SessionEvent[] =>
      [0, 1000].map((d, i) => ({
        id: `${sid}${i}`,
        sessionId: sid,
        agentId: null,
        kind: "prompt",
        ts: base + d,
        machine: "m",
        source: "jsonl",
      }));
    const items = buildItems([mk("a", 1_000_000), mk("b", 9_000_000)], 1);
    expect(items.map((i) => [i.event.sessionId, i.at])).toEqual([
      ["a", 0],
      ["b", 0],
      ["a", 1000],
      ["b", 1000],
    ]);
  });

  it("runReplay honors offsets against an injected clock and batches items that are due together", async () => {
    let clock = 10_000;
    const sleeps: number[] = [];
    const payloads: unknown[] = [];
    const events = [0, 10, 20, 1000, 1005].map((d, i): SessionEvent => ({
      id: `e${i}`,
      sessionId: SID1,
      agentId: null,
      kind: "prompt",
      ts: d,
      machine: "m",
      source: "jsonl",
    }));
    const r = await runReplay({
      items: buildItems([events], 1),
      repo: TEST_REPO,
      machine: "m",
      post: async (p) => {
        payloads.push(p);
        return true;
      },
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      batchMs: 50,
    });
    expect(r).toEqual({ sent: 5, batches: 2, failedBatches: 0 });
    expect(sleeps).toEqual([1000]); // first batch is due at once; second after the gap
    const second = normalizeOtlpPayload(payloads[1], { now: () => 0 }).events;
    expect(second.map((e) => e.ts)).toEqual([11_000, 11_005]); // stamped start + offset
  });
});

describe("replay conversion", () => {
  const events: SessionEvent[] = [
    {
      id: "r1",
      sessionId: SID1,
      agentId: null,
      kind: "api_request",
      ts: 1,
      machine: "vps",
      source: "jsonl",
      model: "model-x",
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      label: "t16",
    },
    {
      id: "toolu_b",
      sessionId: SID1,
      agentId: null,
      kind: "tool_decision",
      ts: 2,
      machine: "vps",
      source: "jsonl",
      tool: "Bash",
      detail: "List files",
      ok: true,
    },
    {
      id: "toolu_b",
      sessionId: SID1,
      agentId: null,
      kind: "tool_result",
      ts: 3,
      machine: "vps",
      source: "jsonl",
      tool: "Bash",
      detail: "List files",
      ok: false,
    },
    {
      id: "toolu_e",
      sessionId: SID1,
      agentId: null,
      kind: "tool_decision",
      ts: 4,
      machine: "vps",
      source: "jsonl",
      tool: "Edit",
      detail: "main.rs",
      ok: true,
    },
    {
      id: "toolu_a",
      sessionId: SID1,
      agentId: null,
      kind: "subagent_spawn",
      ts: 5,
      machine: "vps",
      source: "jsonl",
      tool: "Agent",
      detail: "reviewer",
      spawnId: "toolu_a",
    },
    {
      id: "r2",
      sessionId: SID1,
      agentId: "agent-1",
      kind: "api_request",
      ts: 6,
      machine: "vps",
      source: "jsonl",
      model: "m2",
      agentType: "reviewer",
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    {
      id: "d1",
      sessionId: SID1,
      agentId: "agent-1",
      kind: "subagent_done",
      ts: 7,
      machine: "vps",
      source: "jsonl",
      agentType: "reviewer",
      detail: "reviewer",
    },
    {
      id: "u1",
      sessionId: SID1,
      agentId: null,
      kind: "prompt",
      ts: 8,
      machine: "vps",
      source: "jsonl",
    },
  ];

  it("round-trips through the OTLP normalizer with the attributes Claude Code would send", () => {
    const records = events.map((e, i) =>
      eventToRecord(e, { repo: TEST_REPO, wallTs: 1_000 + i, sequence: i }),
    );
    const payload = {
      resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ logRecords: records }] }],
    };
    const out = normalizeOtlpPayload(payload, { targetRepo: TEST_REPO, now: () => 0 });
    expect(out.counters).toMatchObject({ records: 8, accepted: 8, filtered: 0, malformed: 0 });
    const byKind = out.events.map((e) => e.kind);
    expect(byKind).toEqual([
      "api_request",
      "tool_decision",
      "tool_result",
      "tool_decision",
      "subagent_spawn",
      "api_request",
      "subagent_done",
      "prompt",
    ]);
    expect(out.events[0]).toMatchObject({
      id: "r1",
      model: "model-x",
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      machine: "vps",
      label: "t16",
      agentId: null,
    });
    expect(out.events[1]).toMatchObject({
      tool: "Bash",
      detail: "List files",
      ok: true,
      id: "toolu_b",
    });
    expect(out.events[2]).toMatchObject({ tool: "Bash", detail: "List files", ok: false });
    expect(out.events[3]).toMatchObject({ tool: "Edit", detail: "main.rs" });
    expect(out.events[4]).toMatchObject({
      kind: "subagent_spawn",
      detail: "reviewer",
      spawnId: "toolu_a",
    });
    expect(out.events[5]).toMatchObject({ agentId: "agent-1", agentType: "reviewer" });
    expect(out.events[6]).toMatchObject({ agentId: "agent-1", agentType: "reviewer" });
    expect(out.events[0]?.ts).toBe(1000); // stamped with the replay wall time
  });

  it("emits the standard attribute names", () => {
    const rec = eventToRecord(events[1] as SessionEvent, {
      repo: TEST_REPO,
      wallTs: 5,
      sequence: 3,
    });
    const keys = rec.attributes.map((a) => a.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "event.name",
        "event.timestamp",
        "event.sequence",
        "session.id",
        "vcs.repository.name",
        "machine.name",
        "query_source",
        "tool_name",
        "tool_use_id",
        "decision",
        "tool_parameters",
      ]),
    );
    expect(rec.attributes.find((a) => a.key === "event.sequence")?.value).toEqual({
      intValue: "3",
    });
    expect(rec.attributes.find((a) => a.key === "query_source")?.value).toEqual({
      stringValue: "repl_main_thread",
    });
  });

  it("faithful attribution only tags api_request/response with the subagent", () => {
    const toolEvent: SessionEvent = {
      id: "x",
      sessionId: SID1,
      agentId: "agent-1",
      kind: "tool_result",
      ts: 1,
      machine: "m",
      source: "jsonl",
      tool: "Bash",
      ok: true,
    };
    const loose = eventToRecord(toolEvent, { repo: TEST_REPO, wallTs: 1, sequence: 0 });
    const faithful = eventToRecord(toolEvent, {
      repo: TEST_REPO,
      wallTs: 1,
      sequence: 0,
      faithfulAttribution: true,
    });
    expect(loose.attributes.some((a) => a.key === "query_source")).toBe(true);
    expect(faithful.attributes.some((a) => a.key === "query_source")).toBe(false);
  });

  it("makes ids unique per loop iteration", () => {
    const e = withIteration(events[4] as SessionEvent, 2);
    expect(e).toMatchObject({ id: "toolu_a~2", sessionId: `${SID1}~2`, spawnId: "toolu_a~2" });
    expect(withIteration(events[4] as SessionEvent, 0)).toBe(events[4]);
  });
});

describe("replay input resolution", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    const t = await makeTempDir();
    dir = t.dir;
    cleanup = t.cleanup;
  });
  afterEach(async () => cleanup());

  it("a project dir yields the N most recently modified sessions; a file yields itself with its subagents", async () => {
    const ids = [
      "00000000-0000-4000-8000-0000000000c1",
      "00000000-0000-4000-8000-0000000000c2",
      "00000000-0000-4000-8000-0000000000c3",
    ];
    for (const [i, id] of ids.entries()) {
      await writeJsonl(
        join(dir, `${id}.jsonl`),
        syntheticSessionLines(id, NOW),
        new Date(NOW - (3 - i) * 60_000),
      );
    }
    await writeJsonl(
      join(dir, ids[0] as string, "subagents", "agent-z.jsonl"),
      syntheticSessionLines(ids[0] as string, NOW, "z-").map((l) => ({
        ...l,
        isSidechain: true,
        agentId: "z",
      })),
    );

    const two = await resolveInput(dir, 2);
    expect(two.map((s) => s.sessionId)).toEqual([ids[2], ids[1]]);

    const one = await resolveInput(join(dir, `${ids[0]}.jsonl`), 1);
    expect(one).toHaveLength(1);
    expect(one[0]?.subagents.map((s) => s.agentId)).toEqual(["z"]);

    const loaded = await loadSession(one[0] as (typeof one)[number], {
      machine: "m",
      subagentFinished: () => true,
    });
    const subEvents = loaded.events.filter((e) => e.agentId === "z");
    expect(subEvents.length).toBeGreaterThan(0);
    expect(subEvents.at(-1)?.kind).toBe("subagent_done");
    expect(loaded.filesRead).toBe(2);
  });

  it("rejects missing paths and empty dirs with a clear error", async () => {
    await expect(resolveInput(join(dir, "nope.jsonl"), 1)).rejects.toThrow(/not found/);
    await expect(resolveInput(dir, 1)).rejects.toThrow(/no \*\.jsonl/);
    await expect(resolveInput(join(dir, "x.txt"), 1)).rejects.toThrow(/not a \.jsonl/);
  });
});
