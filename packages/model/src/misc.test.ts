import { describe, expect, it } from "vitest";
import { basename, sanitizeDetail, toolDetail } from "./detail.ts";
import {
  compileTicketLabelRe,
  cwdToProjectDir,
  deriveTicketLabel,
  deriveTicketLabelFromCwd,
} from "./label.ts";
import { applyServerMsg, parseClientMsg, parseServerMsg } from "./protocol.ts";
import { applyEvent } from "./session.ts";
import type { Session, SessionEvent } from "./types.ts";

describe("ticket label", () => {
  it("derives tN from a worktree project dir with the default regex", () => {
    expect(deriveTicketLabel("C--work-demo-proj-worktrees-t245")).toBe("t245");
    expect(deriveTicketLabel("-home-u-demo-proj-worktrees-t9")).toBe("t9");
  });

  it("returns undefined when not derivable", () => {
    expect(deriveTicketLabel("C--work-demo-proj")).toBeUndefined();
    expect(deriveTicketLabel("demo-worktrees-t12-extra")).toBeUndefined();
    expect(deriveTicketLabel(undefined)).toBeUndefined();
  });

  it("supports a configurable regex (group 1, or whole match)", () => {
    const re = compileTicketLabelRe("-feature-(\\d+)$");
    expect(deriveTicketLabel("x-feature-77", re)).toBe("77");
    expect(deriveTicketLabel("x-feature-77", compileTicketLabelRe("feature-\\d+$"))).toBe(
      "feature-77",
    );
  });

  it("falls back to the default for empty or invalid regex source", () => {
    expect(deriveTicketLabel("a-worktrees-t1", compileTicketLabelRe("("))).toBe("t1");
    expect(deriveTicketLabel("a-worktrees-t1", compileTicketLabelRe(""))).toBe("t1");
  });

  it("converts cwd paths to project dir names", () => {
    expect(cwdToProjectDir("C:\\work\\demo-proj\\worktrees\\t5")).toBe(
      "C--work-demo-proj-worktrees-t5",
    );
    expect(deriveTicketLabelFromCwd("/w/demo-proj/worktrees/t5")).toBe("t5");
    expect(deriveTicketLabelFromCwd(undefined)).toBeUndefined();
  });
});

describe("detail helpers", () => {
  it("sanitizeDetail: single line, trimmed, capped at 120", () => {
    expect(sanitizeDetail("  a \n\n b\tc  ")).toBe("a b c");
    expect(sanitizeDetail("")).toBeUndefined();
    expect(sanitizeDetail(42)).toBeUndefined();
    const long = sanitizeDetail("y".repeat(500)) as string;
    expect(long).toHaveLength(120);
    expect(long.endsWith("\u2026")).toBe(true);
    expect(sanitizeDetail("z".repeat(120))).toHaveLength(120);
  });

  it("basename handles both separators and trailing slashes", () => {
    expect(basename("C:\\a\\b\\c.txt")).toBe("c.txt");
    expect(basename("/a/b/")).toBe("b");
    expect(basename("plain")).toBe("plain");
  });

  it("toolDetail picks the right parameter per tool", () => {
    expect(toolDetail("Bash", { bash_command: "echo hi" })).toBe("echo hi");
    expect(toolDetail("Bash", { bash_command: "echo hi", description: "Say hi" })).toBe("Say hi");
    expect(toolDetail("Skill", { skill_name: "review" })).toBe("review");
    expect(toolDetail("Skill", { skill: "review" })).toBe("review");
    expect(toolDetail("Agent", { subagent_type: "plan", prompt: "do things" })).toBe("plan");
    expect(toolDetail("Write", undefined, { file_path: "/x/y/z.ts" })).toBe("z.ts");
    expect(toolDetail("Glob", undefined, { pattern: "**/*.rs" })).toBe("**/*.rs");
    expect(toolDetail("Other", { description: "d" })).toBe("d");
    expect(toolDetail("Other")).toBeUndefined();
  });
});

describe("protocol", () => {
  const ev: SessionEvent = {
    id: "e1",
    sessionId: "00000000-0000-4000-8000-000000000003",
    agentId: null,
    kind: "prompt",
    ts: 1,
    machine: "laptop",
    source: "otel",
  };

  it("parseServerMsg accepts the four frame types and rejects the rest", () => {
    const sess = applyEvent(undefined, ev);
    expect(
      parseServerMsg(JSON.stringify({ v: 1, type: "snapshot", now: 1, sessions: [sess] }))?.type,
    ).toBe("snapshot");
    expect(parseServerMsg(JSON.stringify({ v: 1, type: "events", events: [ev] }))?.type).toBe(
      "events",
    );
    expect(parseServerMsg(JSON.stringify({ v: 1, type: "session", session: sess }))?.type).toBe(
      "session",
    );
    expect(parseServerMsg(JSON.stringify({ v: 1, type: "remove", sessionId: "x" }))?.type).toBe(
      "remove",
    );
    expect(
      parseServerMsg(JSON.stringify({ v: 2, type: "remove", sessionId: "x" })),
    ).toBeUndefined();
    expect(parseServerMsg(JSON.stringify({ v: 1, type: "nope" }))).toBeUndefined();
    expect(parseServerMsg("not json")).toBeUndefined();
    expect(parseClientMsg(JSON.stringify({ v: 1, type: "hello" }))).toEqual({
      v: 1,
      type: "hello",
    });
    expect(parseClientMsg("{}")).toBeUndefined();
  });

  it("applyServerMsg: snapshot replaces, events create, session is authoritative, remove drops", () => {
    let state = applyServerMsg({}, { v: 1, type: "events", events: [ev] });
    expect(Object.keys(state)).toEqual([ev.sessionId]);
    const auth: Session = { ...(state[ev.sessionId] as Session), label: "t1" };
    state = applyServerMsg(state, { v: 1, type: "session", session: auth });
    expect(state[ev.sessionId]?.label).toBe("t1");
    state = applyServerMsg(state, { v: 1, type: "snapshot", now: 2, sessions: [] });
    expect(state).toEqual({});
    state = applyServerMsg({ a: auth }, { v: 1, type: "remove", sessionId: "a" });
    expect(state).toEqual({});
  });
});
