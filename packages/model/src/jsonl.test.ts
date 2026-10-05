import { describe, expect, it } from "vitest";
import { createJsonlParser, parseJsonlLines } from "./jsonl.ts";

const SID = "00000000-0000-4000-8000-000000000002";
const CTX = { machine: "vps", projectDir: "demo-proj-worktrees-t16" };

const line = (o: Record<string, unknown>): string => JSON.stringify(o);
let counter = 0;
function base(
  type: string,
  ts: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  counter++;
  return {
    type,
    sessionId: SID,
    timestamp: ts,
    uuid: `uuid-${counter}`,
    cwd: "/synthetic/cwd",
    gitBranch: "main",
    ...extra,
  };
}

const usage = {
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 300,
  cache_creation_input_tokens: 4,
};

const assistant = (ts: string, content: unknown[], extra: Record<string, unknown> = {}): string =>
  line(
    base("assistant", ts, {
      requestId: "req_a",
      message: { model: "model-x", id: "msg_1", role: "assistant", content, usage },
      ...extra,
    }),
  );

describe("createJsonlParser", () => {
  it("turns an assistant tool_use line into api_request + tool_decision, then the result", () => {
    const p = createJsonlParser(CTX);
    const a = p.parseLine(
      assistant("2026-01-01T00:00:01.000Z", [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Bash",
          input: { command: "ls -la", description: "List files" },
        },
      ]),
    );
    expect(a.map((e) => e.kind)).toEqual(["api_request", "tool_decision"]);
    expect(a[0]).toMatchObject({
      id: "req_a",
      sessionId: SID,
      agentId: null,
      machine: "vps",
      source: "jsonl",
      model: "model-x",
      tokens: { input: 10, output: 20, cacheRead: 300, cacheWrite: 4 },
      label: "t16",
      ts: Date.parse("2026-01-01T00:00:01.000Z"),
    });
    expect(a[1]).toMatchObject({ id: "toolu_1", tool: "Bash", detail: "List files", ok: true });

    const r = p.parseLine(
      line(
        base("user", "2026-01-01T00:00:02.000Z", {
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: "OUTPUT TEXT",
                is_error: false,
              },
            ],
          },
          toolUseResult: { stdout: "OUTPUT TEXT" },
        }),
      ),
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      kind: "tool_result",
      id: "toolu_1",
      tool: "Bash",
      detail: "List files",
      ok: true,
    });
    expect(JSON.stringify(r)).not.toContain("OUTPUT TEXT");
    expect(p.stats).toMatchObject({ lines: 2, events: 3, malformed: 0 });
  });

  it("marks failed tool results ok=false", () => {
    const p = createJsonlParser(CTX);
    p.parseLine(
      assistant("2026-01-01T00:00:01.000Z", [
        { type: "tool_use", id: "t", name: "Read", input: { file_path: "C:\\dir\\sub\\main.rs" } },
      ]),
    );
    const r = p.parseLine(
      line(
        base("user", "2026-01-01T00:00:02.000Z", {
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t", content: "x", is_error: true }],
          },
        }),
      ),
    );
    expect(r[0]).toMatchObject({ kind: "tool_result", ok: false, detail: "main.rs" });
  });

  it("emits one api_request per requestId even when the response spans several lines", () => {
    const p = createJsonlParser(CTX);
    const a = p.parseLine(
      assistant("2026-01-01T00:00:01.000Z", [{ type: "thinking", thinking: "x" }]),
    );
    const b = p.parseLine(
      assistant("2026-01-01T00:00:01.100Z", [
        { type: "tool_use", id: "toolu_9", name: "Read", input: { file_path: "/a/b.rs" } },
      ]),
    );
    expect(a.map((e) => e.kind)).toEqual(["api_request"]);
    expect(b.map((e) => e.kind)).toEqual(["tool_decision"]);
  });

  it("emits one response event for text and never copies the text", () => {
    const events = createJsonlParser(CTX).parseLine(
      assistant("2026-01-01T00:00:01.000Z", [
        { type: "text", text: "TOP SECRET ANSWER" },
        { type: "thinking", thinking: "hmm" },
      ]),
    );
    expect(events.map((e) => e.kind)).toEqual(["api_request", "response"]);
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it("emits a prompt for user string content without copying it", () => {
    const events = createJsonlParser(CTX).parseLine(
      line(
        base("user", "2026-01-01T00:00:00.000Z", {
          message: { role: "user", content: "my private prompt text" },
        }),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("prompt");
    expect(events[0]?.detail).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain("private");
  });

  it("ignores meta user lines and skips synthetic assistant usage", () => {
    const p = createJsonlParser(CTX);
    expect(
      p.parseLine(
        line(
          base("user", "2026-01-01T00:00:00.000Z", {
            isMeta: true,
            message: { role: "user", content: "x" },
          }),
        ),
      ),
    ).toEqual([]);
    const synth = p.parseLine(
      line(
        base("assistant", "2026-01-01T00:00:00.000Z", {
          message: { model: "<synthetic>", content: [{ type: "text", text: "x" }], usage },
        }),
      ),
    );
    expect(synth.map((e) => e.kind)).toEqual(["response"]);
    expect(p.stats.ignored).toBe(1);
  });

  it("maps Agent tool_use to subagent_spawn with the subagent type", () => {
    const p = createJsonlParser(CTX);
    const e = p.parseLine(
      assistant("2026-01-01T00:00:01.000Z", [
        {
          type: "tool_use",
          id: "toolu_ag",
          name: "Agent",
          input: { subagent_type: "reviewer", description: "d", prompt: "DO SECRET WORK" },
        },
      ]),
    );
    expect(e.map((x) => x.kind)).toEqual(["api_request", "subagent_spawn"]);
    expect(e[1]).toMatchObject({
      id: "toolu_ag",
      spawnId: "toolu_ag",
      tool: "Agent",
      detail: "reviewer",
      agentId: null,
    });
    expect(JSON.stringify(e)).not.toContain("SECRET");
  });

  it("async Agent results stay tool_result; completed ones become subagent_done", () => {
    const p = createJsonlParser(CTX);
    p.parseLine(
      assistant("2026-01-01T00:00:01.000Z", [
        { type: "tool_use", id: "t_async", name: "Agent", input: { subagent_type: "x" } },
        { type: "tool_use", id: "t_sync", name: "Task", input: { subagent_type: "y" } },
      ]),
    );
    const asyncR = p.parseLine(
      line(
        base("user", "2026-01-01T00:00:02.000Z", {
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t_async", content: "launched" }],
          },
          toolUseResult: { status: "async_launched", agentId: "ag1" },
        }),
      ),
    );
    const syncR = p.parseLine(
      line(
        base("user", "2026-01-01T00:00:03.000Z", {
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t_sync", content: "done" }],
          },
          toolUseResult: { status: "completed", agentId: "ag2" },
        }),
      ),
    );
    expect(asyncR[0]?.kind).toBe("tool_result");
    expect(syncR[0]).toMatchObject({
      kind: "subagent_done",
      agentId: "ag2",
      spawnId: "t_sync",
      ok: true,
    });
  });

  it("subagent files: agentId, agentType and spawnId from context; no prompt events", () => {
    const p = createJsonlParser({
      ...CTX,
      agentId: "agent-abc",
      agentType: "reviewer",
      spawnId: "toolu_ag",
    });
    const brief = p.parseLine(
      line(
        base("user", "2026-01-01T00:00:01.000Z", {
          isSidechain: true,
          agentId: "agent-abc",
          message: { role: "user", content: "the brief" },
        }),
      ),
    );
    expect(brief).toEqual([]);
    const e = p.parseLine(
      assistant("2026-01-01T00:00:02.000Z", [
        { type: "tool_use", id: "t1", name: "Grep", input: { pattern: "foo" } },
      ]),
    );
    for (const x of e) {
      expect(x).toMatchObject({
        agentId: "agent-abc",
        agentType: "reviewer",
        spawnId: "toolu_ag",
        sessionId: SID,
      });
    }
    expect(e[1]).toMatchObject({ tool: "Grep", detail: "foo" });
  });

  it("picks up the sidechain agentId from the line when no context agent is set", () => {
    const e = createJsonlParser(CTX).parseLine(
      assistant("2026-01-01T00:00:02.000Z", [{ type: "text", text: "x" }], {
        isSidechain: true,
        agentId: "side1",
      }),
    );
    expect(e[0]?.agentId).toBe("side1");
  });

  it("maps compaction and api_error system lines; ignores the rest", () => {
    const p = createJsonlParser(CTX);
    expect(
      p.parseLine(
        line(base("system", "2026-01-01T00:00:00.000Z", { subtype: "compact_boundary" })),
      )[0]?.kind,
    ).toBe("compaction");
    expect(
      p.parseLine(line(base("system", "2026-01-01T00:00:00.000Z", { subtype: "api_error" })))[0],
    ).toMatchObject({ kind: "error", ok: false });
    expect(
      p.parseLine(line(base("system", "2026-01-01T00:00:00.000Z", { subtype: "turn_duration" }))),
    ).toEqual([]);
    expect(p.parseLine(line({ type: "ai-title", aiTitle: "x", sessionId: SID }))).toEqual([]);
    expect(p.parseLine(line({ type: "file-history-snapshot" }))).toEqual([]);
    expect(p.stats.ignored).toBe(3);
  });

  it("falls back to the cwd for the ticket label, and to none", () => {
    const viaCwd = createJsonlParser({ machine: "vps" }).parseLine(
      line(
        base("user", "2026-01-01T00:00:00.000Z", {
          cwd: "/some/place/demo-proj/.claude/worktrees/x",
          message: { role: "user", content: "p" },
        }),
      ),
    );
    expect(viaCwd[0]?.label).toBeUndefined();
    const t = createJsonlParser({ machine: "vps" }).parseLine(
      line(
        base("user", "2026-01-01T00:00:00.000Z", {
          cwd: "/w/demo-proj/worktrees/t42",
          message: { role: "user", content: "p" },
        }),
      ),
    );
    expect(t[0]?.label).toBe("t42");
  });

  it("skips and counts malformed lines without throwing", () => {
    const p = createJsonlParser(CTX);
    const out = [
      p.parseLine("{not json"),
      p.parseLine("[1,2]"),
      p.parseLine('"str"'),
      p.parseLine(line({ type: "user", message: { role: "user", content: "x" } })), // no sessionId/timestamp
      p.parseLine(line({ type: "assistant", sessionId: SID, timestamp: "garbage", message: {} })),
      p.parseLine(line({ type: "assistant", sessionId: SID, timestamp: "2026-01-01T00:00:00Z" })), // no message
      p.parseLine(
        line({
          type: "user",
          sessionId: SID,
          timestamp: "2026-01-01T00:00:00Z",
          message: { content: 5 },
        }),
      ),
      p.parseLine(line({ sessionId: SID })),
      p.parseLine(""),
      p.parseLine("   "),
    ];
    expect(out.flat()).toEqual([]);
    expect(p.stats).toMatchObject({ lines: 8, malformed: 8, events: 0 });
  });

  it("parseJsonlLines aggregates events and stats", () => {
    const r = parseJsonlLines(
      [
        line(base("user", "2026-01-01T00:00:00.000Z", { message: { role: "user", content: "p" } })),
        "oops",
        assistant("2026-01-01T00:00:01.000Z", [{ type: "text", text: "a" }]),
      ],
      CTX,
    );
    expect(r.events.map((e) => e.kind)).toEqual(["prompt", "api_request", "response"]);
    expect(r.stats).toEqual({ lines: 3, events: 3, ignored: 0, malformed: 1 });
  });
});
