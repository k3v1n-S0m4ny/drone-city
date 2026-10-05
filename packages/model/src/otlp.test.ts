import { describe, expect, it } from "vitest";
import {
  normalizeOtlpPayload,
  normalizeOtlpRecord,
  parseAnyValue,
  parseAttributes,
} from "./otlp.ts";
import type { Attrs } from "./otlp.ts";

const NOW = 1_700_000_000_000;
const opts = { targetRepo: "demo-repo", now: () => NOW };
const SID = "00000000-0000-4000-8000-000000000001";

type Val = Record<string, unknown>;
const s = (stringValue: string): Val => ({ stringValue });
const kv = (obj: Record<string, string | number | boolean>): Val[] =>
  Object.entries(obj).map(([key, v]) => ({
    key,
    value:
      typeof v === "string"
        ? { stringValue: v }
        : typeof v === "boolean"
          ? { boolValue: v }
          : Number.isInteger(v)
            ? { intValue: String(v) }
            : { doubleValue: v },
  }));

function record(attrs: Record<string, string | number | boolean>, extra: Val = {}): Val {
  return {
    timeUnixNano: "1700000000000000000",
    attributes: kv({ "session.id": SID, "vcs.repository.name": "demo-repo", ...attrs }),
    ...extra,
  };
}

function payload(records: Val[], resource: Record<string, string> = {}): Val {
  return {
    resourceLogs: [
      {
        resource: { attributes: kv({ "machine.name": "laptop", ...resource }) },
        scopeLogs: [{ scope: { name: "com.anthropic.claude_code.events" }, logRecords: records }],
      },
    ],
  };
}

describe("parseAnyValue / parseAttributes", () => {
  it("parses each AnyValue variant, with intValue as a string", () => {
    expect(parseAnyValue({ stringValue: "x" })).toBe("x");
    expect(parseAnyValue({ intValue: "9007199254740" })).toBe(9007199254740);
    expect(parseAnyValue({ intValue: 12 })).toBe(12);
    expect(parseAnyValue({ doubleValue: 1.5 })).toBe(1.5);
    expect(parseAnyValue({ boolValue: true })).toBe(true);
    expect(parseAnyValue({ arrayValue: { values: [s("a"), { intValue: "2" }] } })).toEqual([
      "a",
      2,
    ]);
    expect(parseAnyValue({ kvlistValue: { values: kv({ a: "b" }) } })).toEqual({ a: "b" });
  });

  it("returns null for garbage instead of throwing", () => {
    expect(parseAnyValue(undefined)).toBeNull();
    expect(parseAnyValue("str")).toBeNull();
    expect(parseAnyValue({ intValue: "nope" })).toBeNull();
    expect(parseAnyValue({})).toBeNull();
  });

  it("ignores malformed attribute entries", () => {
    expect(parseAttributes([{ key: "a", value: s("1") }, null, { value: s("x") }, 3])).toEqual({
      a: "1",
    });
    expect(parseAttributes("nope")).toEqual({});
  });
});

describe("normalizeOtlpRecord", () => {
  const res: Attrs = { "machine.name": "laptop" };

  it("merges resource and record attributes, record wins", () => {
    const r = normalizeOtlpRecord(
      { ...res, "session.id": "resource-sid", "vcs.repository.name": "demo-repo" },
      record({ "event.name": "user_prompt", "machine.name": "vps" }),
      opts,
    );
    expect(r.status).toBe("event");
    if (r.status !== "event") return;
    expect(r.event.sessionId).toBe(SID); // record beats resource
    expect(r.event.machine).toBe("vps");
    expect(r.event.ts).toBe(1_700_000_000_000);
  });

  it("falls back to the resource for machine, then to unknown", () => {
    const fromResource = normalizeOtlpRecord(res, record({ "event.name": "user_prompt" }), opts);
    const unknown = normalizeOtlpRecord({}, record({ "event.name": "user_prompt" }), opts);
    expect(fromResource.status === "event" && fromResource.event.machine).toBe("laptop");
    expect(unknown.status === "event" && unknown.event.machine).toBe("unknown");
  });

  it("prefers event.timestamp, then timeUnixNano, then the injected clock", () => {
    const iso = normalizeOtlpRecord(
      res,
      record({ "event.name": "user_prompt", "event.timestamp": "2026-01-02T03:04:05.678Z" }),
      opts,
    );
    expect(iso.status === "event" && iso.event.ts).toBe(Date.parse("2026-01-02T03:04:05.678Z"));
    const none = normalizeOtlpRecord(
      res,
      { ...record({ "event.name": "user_prompt" }), timeUnixNano: undefined },
      opts,
    );
    expect(none.status === "event" && none.event.ts).toBe(NOW);
  });

  it("strips the claude_code. prefix and falls back to the body for the event name", () => {
    const a = normalizeOtlpRecord(res, record({ "event.name": "claude_code.user_prompt" }), opts);
    const b = normalizeOtlpRecord(
      res,
      record({}, { body: { stringValue: "claude_code.user_prompt" } }),
      opts,
    );
    expect(a.status === "event" && a.event.kind).toBe("prompt");
    expect(b.status === "event" && b.event.kind).toBe("prompt");
  });

  it("maps api_request with tokens and cost (numbers may be strings)", () => {
    const r = normalizeOtlpRecord(
      res,
      record({
        "event.name": "api_request",
        request_id: "req_0001",
        model: "model-x",
        input_tokens: "120",
        output_tokens: 30,
        cache_read_tokens: "4000",
        cache_creation_tokens: 0,
        cost_usd: 0.0123,
        duration_ms: "1500",
        query_source: "repl_main_thread",
      }),
      opts,
    );
    expect(r).toMatchObject({
      status: "event",
      event: {
        id: "req_0001",
        kind: "api_request",
        agentId: null,
        model: "model-x",
        tokens: { input: 120, output: 30, cacheRead: 4000, cacheWrite: 0 },
        costUsd: 0.0123,
        durationMs: 1500,
        source: "otel",
      },
    });
  });

  it("treats query_source other than repl_main_thread as a subagent, preferring agent.name", () => {
    const sub = normalizeOtlpRecord(
      res,
      record({ "event.name": "api_request", query_source: "subagent", "agent.name": "reviewer" }),
      opts,
    );
    const onlySource = normalizeOtlpRecord(
      res,
      record({ "event.name": "api_request", query_source: "Explore" }),
      opts,
    );
    const compact = normalizeOtlpRecord(
      res,
      record({ "event.name": "api_request", query_source: "compact" }),
      opts,
    );
    expect(sub.status === "event" && sub.event.agentId).toBe("reviewer");
    expect(onlySource.status === "event" && onlySource.event.agentId).toBe("Explore");
    expect(compact.status === "event" && compact.event.agentId).toBeNull();
  });

  it("maps tool_result: ok from success string, detail from tool_parameters", () => {
    const r = normalizeOtlpRecord(
      res,
      record({
        "event.name": "tool_result",
        tool_name: "Bash",
        tool_use_id: "toolu_01",
        success: "false",
        duration_ms: 42,
        tool_parameters: JSON.stringify({ bash_command: "ls", description: "List files" }),
      }),
      opts,
    );
    expect(r).toMatchObject({
      event: {
        kind: "tool_result",
        id: "toolu_01",
        tool: "Bash",
        ok: false,
        detail: "List files",
        durationMs: 42,
      },
    });
  });

  it("derives a file basename detail from tool_input", () => {
    const r = normalizeOtlpRecord(
      res,
      record({
        "event.name": "tool_result",
        tool_name: "Edit",
        tool_use_id: "toolu_02",
        success: "true",
        tool_input: JSON.stringify({ file_path: "/some/dir/file.rs", old_string: "secret body" }),
      }),
      opts,
    );
    expect(r.status === "event" && r.event.detail).toBe("file.rs");
  });

  it("maps tool_decision accept/reject, and Agent/Task decisions to subagent_spawn", () => {
    const reject = normalizeOtlpRecord(
      res,
      record({
        "event.name": "tool_decision",
        tool_name: "Bash",
        tool_use_id: "t1",
        decision: "reject",
      }),
      opts,
    );
    const spawn = normalizeOtlpRecord(
      res,
      record({
        "event.name": "tool_decision",
        tool_name: "Agent",
        tool_use_id: "toolu_agent",
        decision: "accept",
        tool_parameters: JSON.stringify({ subagent_type: "reviewer" }),
      }),
      opts,
    );
    const rejectedSpawn = normalizeOtlpRecord(
      res,
      record({
        "event.name": "tool_decision",
        tool_name: "Task",
        tool_use_id: "t3",
        decision: "reject",
      }),
      opts,
    );
    expect(reject).toMatchObject({ event: { kind: "tool_decision", ok: false } });
    expect(spawn).toMatchObject({
      event: { kind: "subagent_spawn", agentId: null, detail: "reviewer", spawnId: "toolu_agent" },
    });
    expect(rejectedSpawn).toMatchObject({ event: { kind: "tool_decision", ok: false } });
  });

  it("rebuilds an mcp tool name from the literal mcp_tool + parameters", () => {
    const r = normalizeOtlpRecord(
      res,
      record({
        "event.name": "tool_result",
        tool_name: "mcp_tool",
        tool_use_id: "t9",
        success: "true",
        tool_parameters: JSON.stringify({ mcp_server_name: "srv", mcp_tool_name: "do_it" }),
      }),
      opts,
    );
    expect(r).toMatchObject({ event: { tool: "mcp__srv__do_it", detail: "srv/do_it" } });
  });

  it("maps subagent_completed to subagent_done with the agent type", () => {
    const r = normalizeOtlpRecord(
      res,
      record({
        "event.name": "subagent_completed",
        agent_type: "reviewer",
        duration_ms: 9000,
        total_tool_uses: 4,
      }),
      opts,
    );
    expect(r).toMatchObject({
      event: {
        kind: "subagent_done",
        agentId: null,
        agentType: "reviewer",
        detail: "reviewer",
        durationMs: 9000,
      },
    });
  });

  it("maps compaction and api_error", () => {
    const c = normalizeOtlpRecord(
      res,
      record({ "event.name": "compaction", trigger: "auto", success: "true" }),
      opts,
    );
    const e = normalizeOtlpRecord(
      res,
      record({ "event.name": "api_error", status_code: 529, error: "overloaded" }),
      opts,
    );
    expect(c).toMatchObject({ event: { kind: "compaction", ok: true, detail: "auto" } });
    expect(e).toMatchObject({ event: { kind: "error", ok: false, detail: "HTTP 529" } });
  });

  it("never copies prompt text, even when the exporter sends it", () => {
    const r = normalizeOtlpRecord(
      res,
      record({
        "event.name": "user_prompt",
        prompt: "please do the secret thing",
        prompt_text: "please do the secret thing",
        prompt_length: 26,
        "prompt.id": "p-1",
      }),
      opts,
    );
    expect(r.status).toBe("event");
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(r.status === "event" && r.event.detail).toBeUndefined();
  });

  it("response events carry no response text", () => {
    const r = normalizeOtlpRecord(
      res,
      record({
        "event.name": "assistant_response",
        response: "SECRET BODY",
        model: "m",
        request_id: "req_1",
      }),
      opts,
    );
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("keeps detail single-line and at most 120 chars", () => {
    const r = normalizeOtlpRecord(
      res,
      record({
        "event.name": "tool_result",
        tool_name: "Bash",
        tool_use_id: "t",
        success: "true",
        tool_parameters: JSON.stringify({ description: `line one\nline two ${"x".repeat(300)}` }),
      }),
      opts,
    );
    const d = r.status === "event" ? (r.event.detail ?? "") : "";
    expect(d.length).toBeLessThanOrEqual(120);
    expect(d).not.toMatch(/[\r\n]/);
    expect(d.startsWith("line one line two")).toBe(true);
  });

  it("filters other repositories, case-insensitively, and records without a repo", () => {
    expect(
      normalizeOtlpRecord(
        res,
        record({ "event.name": "user_prompt", "vcs.repository.name": "other" }),
        opts,
      ).status,
    ).toBe("filtered");
    expect(
      normalizeOtlpRecord(
        res,
        record({ "event.name": "user_prompt", "vcs.repository.name": "DEMO-Repo" }),
        opts,
      ).status,
    ).toBe("event");
    const noRepo = { attributes: kv({ "session.id": SID, "event.name": "user_prompt" }) };
    expect(normalizeOtlpRecord(res, noRepo, opts).status).toBe("filtered");
    expect(normalizeOtlpRecord(res, noRepo, { now: () => NOW }).status).toBe("event");
  });

  it("flags unknown names and malformed records", () => {
    expect(normalizeOtlpRecord(res, record({ "event.name": "hook_registered" }), opts)).toEqual({
      status: "unknown",
      name: "hook_registered",
    });
    expect(
      normalizeOtlpRecord(res, { attributes: kv({ "event.name": "user_prompt" }) }, opts).status,
    ).toBe("malformed");
    expect(normalizeOtlpRecord(res, 7, opts).status).toBe("malformed");
    expect(normalizeOtlpRecord(res, { attributes: kv({ "session.id": SID }) }, opts).status).toBe(
      "malformed",
    );
  });

  it("generates deterministic ids when the exporter gives none", () => {
    const a = normalizeOtlpRecord(
      res,
      record({ "event.name": "compaction", "event.sequence": 7 }),
      opts,
    );
    const b = normalizeOtlpRecord(
      res,
      record({ "event.name": "compaction", "event.sequence": 7 }),
      opts,
    );
    expect(a.status === "event" && a.event.id).toBe(b.status === "event" && b.event.id);
  });

  it("reads an optional drone.label attribute (replay extension)", () => {
    const r = normalizeOtlpRecord(
      res,
      record({ "event.name": "user_prompt", "drone.label": "t16" }),
      opts,
    );
    expect(r.status === "event" && r.event.label).toBe("t16");
  });
});

describe("normalizeOtlpPayload", () => {
  it("counts accepted, filtered, unknown and malformed records and never throws", () => {
    const body = payload([
      record({ "event.name": "user_prompt" }),
      record({ "event.name": "user_prompt", "vcs.repository.name": "other" }),
      record({ "event.name": "skill_activated" }),
      record({ "event.name": "skill_activated" }),
      { attributes: kv({ "event.name": "user_prompt" }) },
    ]);
    const r = normalizeOtlpPayload(body, opts);
    expect(r.valid).toBe(true);
    expect(r.events).toHaveLength(1);
    expect(r.counters).toEqual({
      records: 5,
      accepted: 1,
      filtered: 1,
      unknown: { skill_activated: 2 },
      malformed: 1,
    });
  });

  it("applies resource attributes (machine, repo) to every record", () => {
    const body = payload(
      [
        {
          timeUnixNano: "1700000000000000000",
          attributes: kv({ "session.id": SID, "event.name": "user_prompt" }),
        },
      ],
      { "vcs.repository.name": "demo-repo", "machine.name": "vps" },
    );
    const r = normalizeOtlpPayload(body, opts);
    expect(r.events[0]).toMatchObject({ machine: "vps", sessionId: SID });
  });

  it("reports invalid payload shapes", () => {
    expect(normalizeOtlpPayload(null, opts).valid).toBe(false);
    expect(normalizeOtlpPayload({ resourceLogs: "x" }, opts).valid).toBe(false);
    expect(normalizeOtlpPayload({ resourceLogs: [] }, opts)).toMatchObject({
      valid: true,
      events: [],
    });
    const weird = normalizeOtlpPayload({ resourceLogs: [1, { scopeLogs: [{}] }] }, opts);
    expect(weird.counters.malformed).toBe(2);
  });

  it("bounds the number of distinct unknown names", () => {
    const records = Array.from({ length: 200 }, (_, i) => record({ "event.name": `weird_${i}` }));
    const r = normalizeOtlpPayload(payload(records), opts);
    expect(Object.keys(r.counters.unknown).length).toBeLessThanOrEqual(65);
    expect(Object.values(r.counters.unknown).reduce((a, b) => a + b, 0)).toBe(200);
  });
});
