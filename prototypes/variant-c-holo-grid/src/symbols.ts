import type { SessionEvent } from "./types";

export type Family = "read" | "edit" | "bash" | "web" | "agent" | "mcp" | "other";
export const FAMILIES: Family[] = ["read", "edit", "bash", "web", "agent", "mcp"];

export interface Sym {
  key: string;
  glyph: string;
  color: string;
  label: string;
  hint: string;
}

// One glyph per event / tool family. Chosen to be distinct in silhouette
// (diamond, solid diamond, chevron, target, hexagons, dot, cross, triangles, ring).
export const SYM: Record<string, Sym> = {
  read: { key: "read", glyph: "\u25C7", color: "#4de1ff", label: "READ", hint: "Read / Grep / Glob" },
  edit: { key: "edit", glyph: "\u25C6", color: "#f4fcff", label: "EDIT", hint: "Edit / Write" },
  bash: { key: "bash", glyph: "\u25B8", color: "#6dffb0", label: "BASH", hint: "shell command" },
  web: { key: "web", glyph: "\u25CE", color: "#5f9bff", label: "WEB", hint: "WebFetch / WebSearch" },
  agent: { key: "agent", glyph: "\u2B22", color: "#ffd45c", label: "AGENT", hint: "subagent spawn / done" },
  mcp: { key: "mcp", glyph: "\u2B21", color: "#ff6ad5", label: "MCP", hint: "MCP tool" },
  other: { key: "other", glyph: "\u25CF", color: "#8dffd0", label: "OK", hint: "other tool, success" },
  error: { key: "error", glyph: "\u2715", color: "#ff6a1a", label: "ERROR", hint: "failed tool / api error" },
  api: { key: "api", glyph: "\u25B3", color: "#19ffd9", label: "API", hint: "model request" },
  response: { key: "response", glyph: "\u25BD", color: "#a8fff0", label: "REPLY", hint: "model response" },
  prompt: { key: "prompt", glyph: "\u25CB", color: "#cfe3ff", label: "PROMPT", hint: "user prompt" },
  compaction: { key: "compaction", glyph: "\u25A3", color: "#b0b8ff", label: "COMPACT", hint: "context compaction" },
};

export const LEGEND_ORDER = ["read", "edit", "bash", "web", "agent", "mcp", "other", "error", "api", "response", "prompt"];

export function toolFamily(tool?: string): Family {
  if (!tool) return "other";
  if (tool.startsWith("mcp__")) return "mcp";
  switch (tool) {
    case "Read": case "Grep": case "Glob": case "LS": case "NotebookRead": case "ToolSearch":
      return "read";
    case "Edit": case "Write": case "MultiEdit": case "NotebookEdit":
      return "edit";
    case "Bash": case "BashOutput": case "KillShell": case "PowerShell":
      return "bash";
    case "WebFetch": case "WebSearch":
      return "web";
    case "Agent": case "Task":
      return "agent";
    default:
      return "other";
  }
}

/** Animation / glyph key for an event. */
export function symKey(ev: SessionEvent): string {
  if (ev.kind === "error" || (ev.kind === "tool_result" && ev.ok === false)) return "error";
  switch (ev.kind) {
    case "prompt": return "prompt";
    case "api_request": return "api";
    case "response": return "response";
    case "subagent_spawn":
    case "subagent_done": return "agent";
    case "compaction": return "compaction";
    case "tool_decision":
    case "tool_result": return toolFamily(ev.tool);
  }
  return "other";
}
export const symbolFor = (ev: SessionEvent): Sym => SYM[symKey(ev)] ?? SYM.other;
