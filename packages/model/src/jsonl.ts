import { isAgentTool, toolDetail } from "./detail.ts";
import { compileTicketLabelRe, deriveTicketLabel, deriveTicketLabelFromCwd } from "./label.ts";
import type { EventKind, Machine, SessionEvent } from "./types.ts";

/** Per-file parsing context. */
export interface JsonlContext {
  machine: Machine;
  /** Subagent key when parsing a `subagents/agent-<id>.jsonl` file. */
  agentId?: string;
  /** From the subagent's `.meta.json`. */
  agentType?: string;
  /** From the subagent's `.meta.json` (`toolUseId`): the parent's Agent/Task call. */
  spawnId?: string;
  /** Project dir name (cwd with separators replaced by `-`), used for the ticket label. */
  projectDir?: string;
  /** Ticket label regex; default `-worktrees-(t\d+)$`. */
  ticketRe?: RegExp;
}

export interface JsonlStats {
  /** Non-empty lines read. */
  lines: number;
  /** Events emitted. */
  events: number;
  /** Well-formed lines of a type we deliberately do not map. */
  ignored: number;
  /** Lines that were not JSON, not an object, or lacked required fields. */
  malformed: number;
}

export interface JsonlParser {
  /** Parse one line. Never throws. */
  parseLine(line: string): SessionEvent[];
  readonly stats: JsonlStats;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Cap on remembered tool calls awaiting their result (bounds memory on pathological files). */
const MAX_PENDING_TOOLS = 5000;

/**
 * Stateful per-file parser: remembers tool_use ids so a later tool_result can carry the tool
 * name. Prompt text and message bodies are never copied into events.
 */
export function createJsonlParser(ctx: JsonlContext): JsonlParser {
  const stats: JsonlStats = { lines: 0, events: 0, ignored: 0, malformed: 0 };
  const re = ctx.ticketRe ?? compileTicketLabelRe();
  const projectLabel = deriveTicketLabel(ctx.projectDir, re);
  const pending = new Map<string, { name: string; detail: string | undefined }>();
  /** One API response is written as several lines (one per content block): emit one api_request. */
  const seenRequests = new Set<string>();

  function remember(id: string, name: string, detail: string | undefined): void {
    if (pending.size >= MAX_PENDING_TOOLS) {
      const first = pending.keys().next();
      if (!first.done) pending.delete(first.value);
    }
    pending.set(id, { name, detail });
  }

  function parseObject(o: Record<string, unknown>): SessionEvent[] | "ignored" | "malformed" {
    const type = str(o.type);
    if (!type) return "malformed";
    if (type !== "user" && type !== "assistant" && type !== "system") return "ignored";

    const sessionId = str(o.sessionId);
    const ts = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    if (!sessionId || !Number.isFinite(ts)) return "malformed";

    const agentId = ctx.agentId ?? (o.isSidechain === true ? (str(o.agentId) ?? null) : null);
    const label = projectLabel ?? deriveTicketLabelFromCwd(str(o.cwd), re);
    const uuid = str(o.uuid);

    const make = (kind: EventKind, id: string, extra: Partial<SessionEvent> = {}): SessionEvent => {
      const e: SessionEvent = {
        id,
        sessionId,
        agentId: agentId ?? null,
        kind,
        ts,
        machine: ctx.machine,
        source: "jsonl",
        ...extra,
      };
      if (label) e.label = label;
      // Tie subagent-file events to their spawn (spawn/done events carry their own spawnId).
      if (e.agentId && e.spawnId === undefined && kind !== "subagent_spawn") {
        if (ctx.agentType) e.agentType = ctx.agentType;
        if (ctx.spawnId) e.spawnId = ctx.spawnId;
      }
      return e;
    };
    const synth = (suffix: string): string => `jsonl:${sessionId}:${ts}:${suffix}`;

    const message = isObject(o.message) ? o.message : undefined;
    const out: SessionEvent[] = [];

    if (type === "assistant") {
      if (!message) return "malformed";
      const model = str(message.model);
      const requestId = str(o.requestId) ?? str(message.id) ?? uuid ?? synth("req");
      if (model !== "<synthetic>" && !seenRequests.has(requestId)) {
        seenRequests.add(requestId);
        const usage = isObject(message.usage) ? message.usage : undefined;
        out.push(
          make("api_request", requestId, {
            model,
            ok: true,
            tokens: {
              input: num(usage?.input_tokens),
              output: num(usage?.output_tokens),
              cacheRead: num(usage?.cache_read_input_tokens),
              cacheWrite: num(usage?.cache_creation_input_tokens),
            },
          }),
        );
      }
      const blocks = Array.isArray(message.content) ? (message.content as unknown[]) : [];
      let hasText = false;
      for (const b of blocks) {
        if (!isObject(b)) continue;
        if (b.type === "text") hasText = true;
        if (b.type === "tool_use") {
          const name = str(b.name);
          const id = str(b.id);
          if (!name || !id) continue;
          const input = isObject(b.input) ? b.input : undefined;
          const detail = toolDetail(name, input);
          remember(id, name, detail);
          if (isAgentTool(name)) {
            out.push(make("subagent_spawn", id, { tool: name, detail, spawnId: id }));
          } else {
            out.push(make("tool_decision", id, { tool: name, detail, ok: true }));
          }
        }
      }
      if (hasText) out.push(make("response", uuid ?? synth("resp"), { model }));
      return out;
    }

    if (type === "user") {
      if (!message || o.isMeta === true) return "ignored";
      const content = message.content;
      if (typeof content === "string") {
        // A prompt (or, in a subagent file, the parent's brief). Only the fact of it is kept.
        return agentId ? "ignored" : [make("prompt", uuid ?? synth("prompt"), { agentId: null })];
      }
      if (!Array.isArray(content)) return "malformed";
      let sawResult = false;
      const tur = isObject(o.toolUseResult) ? o.toolUseResult : undefined;
      for (const b of content as unknown[]) {
        if (!isObject(b) || b.type !== "tool_result") continue;
        const useId = str(b.tool_use_id);
        if (!useId) continue;
        sawResult = true;
        const known = pending.get(useId);
        pending.delete(useId);
        const tool = known?.name;
        const ok = b.is_error !== true;
        const resultAgent = str(tur?.agentId);
        const looksLikeAgentResult =
          isAgentTool(tool) || (resultAgent !== undefined && str(tur?.status) !== undefined);
        if (looksLikeAgentResult && str(tur?.status) !== "async_launched") {
          out.push(
            make("subagent_done", useId, {
              tool,
              ok,
              spawnId: useId,
              agentId: resultAgent ?? null,
            }),
          );
        } else {
          out.push(make("tool_result", useId, { tool, detail: known?.detail, ok }));
        }
      }
      if (!sawResult) {
        const hasText = (content as unknown[]).some((b) => isObject(b) && b.type === "text");
        return hasText && !agentId
          ? [make("prompt", uuid ?? synth("prompt"), { agentId: null })]
          : "ignored";
      }
      return out;
    }

    // type === "system"
    const subtype = str(o.subtype) ?? "";
    if (subtype === "api_error") return [make("error", uuid ?? synth("err"), { ok: false })];
    if (subtype.includes("compact")) {
      return [make("compaction", uuid ?? synth("compact"), { ok: true })];
    }
    return "ignored";
  }

  return {
    stats,
    parseLine(line: string): SessionEvent[] {
      if (line.trim() === "") return [];
      stats.lines++;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        stats.malformed++;
        return [];
      }
      if (!isObject(parsed)) {
        stats.malformed++;
        return [];
      }
      try {
        const r = parseObject(parsed);
        if (r === "malformed") {
          stats.malformed++;
          return [];
        }
        if (r === "ignored") {
          stats.ignored++;
          return [];
        }
        stats.events += r.length;
        return r;
      } catch {
        stats.malformed++;
        return [];
      }
    },
  };
}

/** Convenience: parse an in-memory list of lines. */
export function parseJsonlLines(
  lines: Iterable<string>,
  ctx: JsonlContext,
): { events: SessionEvent[]; stats: JsonlStats } {
  const p = createJsonlParser(ctx);
  const events: SessionEvent[] = [];
  for (const line of lines) events.push(...p.parseLine(line));
  return { events, stats: p.stats };
}
