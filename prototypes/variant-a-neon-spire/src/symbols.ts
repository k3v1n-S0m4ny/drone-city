import type { SessionEvent } from "./types";

export type Family =
  | "prompt"
  | "api"
  | "response"
  | "read"
  | "edit"
  | "bash"
  | "web"
  | "agent"
  | "mcp"
  | "other"
  | "decision"
  | "compaction"
  | "done"
  | "error";

export interface SymbolDef {
  family: Family;
  glyph: string;
  color: string;
  name: string;
  hint: string;
}

// The proposed symbol set: one glyph + colour per event / tool family.
export const SYMBOLS: Record<Family, SymbolDef> = {
  prompt: { family: "prompt", glyph: "◉", color: "#ffffff", name: "prompt", hint: "user prompt" },
  api: { family: "api", glyph: "▲", color: "#a58bff", name: "api", hint: "model request" },
  response: { family: "response", glyph: "✦", color: "#ffb6ee", name: "reply", hint: "assistant response" },
  read: { family: "read", glyph: "⌕", color: "#3dffd0", name: "read", hint: "Read / Grep / Glob / LS" },
  edit: { family: "edit", glyph: "✎", color: "#b8ff3d", name: "edit", hint: "Edit / Write" },
  bash: { family: "bash", glyph: "▶", color: "#ff2fd0", name: "bash", hint: "shell command" },
  web: { family: "web", glyph: "⇄", color: "#4d94ff", name: "web", hint: "WebFetch / WebSearch" },
  agent: { family: "agent", glyph: "◆", color: "#ffe14d", name: "agent", hint: "subagent spawn" },
  mcp: { family: "mcp", glyph: "⬡", color: "#ff8a5c", name: "mcp", hint: "MCP tool" },
  other: { family: "other", glyph: "◇", color: "#9aa4c8", name: "other", hint: "other tool" },
  decision: { family: "decision", glyph: "◌", color: "#7f8bb8", name: "decide", hint: "permission decision" },
  compaction: { family: "compaction", glyph: "≡", color: "#c7a4ff", name: "compact", hint: "context compaction" },
  done: { family: "done", glyph: "✓", color: "#46ff8a", name: "done", hint: "subagent docked" },
  error: { family: "error", glyph: "✕", color: "#ff3b4e", name: "error", hint: "error / failed tool" },
};

export const FAMILY_ORDER: Family[] = [
  "prompt",
  "api",
  "response",
  "read",
  "edit",
  "bash",
  "web",
  "agent",
  "mcp",
  "other",
  "decision",
  "compaction",
  "done",
  "error",
];

/** Which tower of a district handles which tool family (modulo tower count). */
export const TOWER_FAMILY: Family[] = ["read", "edit", "bash", "web", "mcp", "other"];

export function toolFamily(tool?: string): Family {
  if (!tool) return "other";
  const t = tool.toLowerCase();
  if (t.startsWith("mcp__")) return "mcp";
  if (["read", "grep", "glob", "ls", "notebookread", "search"].includes(t)) return "read";
  if (["edit", "write", "multiedit", "notebookedit"].includes(t)) return "edit";
  if (["bash", "bashoutput", "killshell"].includes(t)) return "bash";
  if (["webfetch", "websearch"].includes(t)) return "web";
  if (t === "agent" || t === "task") return "agent";
  return "other";
}

export function eventFamily(e: SessionEvent): Family {
  switch (e.kind) {
    case "prompt":
      return "prompt";
    case "api_request":
      return "api";
    case "response":
      return "response";
    case "tool_decision":
      return "decision";
    case "compaction":
      return "compaction";
    case "subagent_spawn":
      return "agent";
    case "subagent_done":
      return "done";
    case "error":
      return "error";
    case "tool_result":
      return e.ok === false ? "error" : toolFamily(e.tool);
  }
}

// Glyph atlas (canvas) shared by the chip shader. 8 columns x 2 rows.
export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 2;
export const atlasIndex = (f: Family) => FAMILY_ORDER.indexOf(f);

const FONT_STACK =
  '"Segoe UI Symbol","Noto Sans Symbols 2","Noto Sans Symbols","DejaVu Sans","Apple Symbols","Arial Unicode MS",sans-serif';

let atlasCanvas: HTMLCanvasElement | null = null;
export function getGlyphAtlas(): HTMLCanvasElement {
  if (atlasCanvas) return atlasCanvas;
  const cell = 128;
  const c = document.createElement("canvas");
  c.width = cell * ATLAS_COLS;
  c.height = cell * ATLAS_ROWS;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `600 ${cell * 0.62}px ${FONT_STACK}`;
  FAMILY_ORDER.forEach((f, i) => {
    const cx = (i % ATLAS_COLS) * cell + cell / 2;
    const cy = Math.floor(i / ATLAS_COLS) * cell + cell / 2;
    g.fillText(SYMBOLS[f].glyph + "︎", cx, cy + cell * 0.04);
  });
  atlasCanvas = c;
  return c;
}
