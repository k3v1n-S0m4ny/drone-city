import type { SessionEvent } from "./types";

export type Family =
  | "prompt" | "api" | "response"
  | "read" | "edit" | "bash" | "web" | "agent" | "mcp" | "other"
  | "error" | "compact" | "spawn" | "done";

export interface FamilyDef {
  glyph: string;
  color: string;
  label: string;
  anim: string; // what the drone does (legend text)
  dur: number; // animation length in ms
}

/** The proposed symbol set. One glyph per event / tool family; monospace-safe. */
export const FAMILIES: Record<Family, FamilyDef> = {
  prompt: { glyph: "›", color: "#e6fbff", label: "prompt", anim: "data packet drops in", dur: 850 },
  api: { glyph: "↑", color: "#6fa8ff", label: "model call", anim: "eye pulse + ring", dur: 650 },
  response: { glyph: "↓", color: "#9bffd6", label: "response", anim: "signal rises", dur: 700 },
  read: { glyph: "R", color: "#38e8ff", label: "read / search", anim: "scan cone on a crate", dur: 950 },
  edit: { glyph: "E", color: "#ffd23f", label: "edit / write", anim: "place a crate", dur: 1150 },
  bash: { glyph: "$", color: "#ff8a3d", label: "bash", anim: "weld sparks", dur: 750 },
  web: { glyph: "W", color: "#b98bff", label: "web", anim: "uplink beam", dur: 1000 },
  agent: { glyph: "A", color: "#ff62c0", label: "skill / agent tool", anim: "double ring", dur: 800 },
  mcp: { glyph: "M", color: "#a6ff5c", label: "mcp", anim: "orbiting plug nodes", dur: 950 },
  other: { glyph: "•", color: "#8fa6b4", label: "other tool", anim: "blip", dur: 450 },
  error: { glyph: "!", color: "#ff3b4d", label: "error", anim: "red strobe + shake", dur: 1050 },
  compact: { glyph: "≡", color: "#c5c0ff", label: "compaction", anim: "ring collapses", dur: 1050 },
  spawn: { glyph: "▲", color: "#ff62c0", label: "subagent launch", anim: "belly hatch opens", dur: 1200 },
  done: { glyph: "▼", color: "#7dffb0", label: "subagent docked", anim: "docking ring", dur: 1200 },
};

export const FAMILY_ORDER: Family[] = [
  "prompt", "api", "response", "read", "edit", "bash", "web", "agent", "mcp", "other",
  "error", "compact", "spawn", "done",
];

const READ = new Set(["read", "grep", "glob", "ls", "notebookread", "lsp"]);
const EDIT = new Set(["edit", "write", "multiedit", "notebookedit"]);
const BASH = new Set(["bash", "bashoutput", "killshell", "powershell"]);
const WEB = new Set(["webfetch", "websearch"]);
const AGENT = new Set(["skill", "toolsearch", "agent", "task"]);

export function toolFamily(tool?: string): Family {
  const t = (tool ?? "").toLowerCase();
  if (t.startsWith("mcp__")) return "mcp";
  if (READ.has(t)) return "read";
  if (EDIT.has(t)) return "edit";
  if (BASH.has(t)) return "bash";
  if (WEB.has(t)) return "web";
  if (AGENT.has(t)) return "agent";
  return "other";
}

/** null = not visualised (tool_decision). */
export function familyOf(ev: SessionEvent): Family | null {
  switch (ev.kind) {
    case "prompt": return "prompt";
    case "api_request": return "api";
    case "response": return "response";
    case "tool_decision": return null;
    case "subagent_spawn": return "spawn";
    case "subagent_done": return "done";
    case "compaction": return "compact";
    case "error": return "error";
    case "tool_result": return ev.ok === false ? "error" : toolFamily(ev.tool);
  }
}

const CODES: Record<string, string> = {
  read: "rd", grep: "grep", glob: "glob", ls: "ls", edit: "edt", write: "wrt", multiedit: "mdt",
  notebookedit: "nb", bash: "sh", webfetch: "fch", websearch: "srch", skill: "skl",
  toolsearch: "tsr", todowrite: "todo", agent: "agt", task: "agt",
};

/** Optional 3-4 char code shown next to the glyph. */
export function codeOf(ev: SessionEvent, fam: Family): string {
  if (fam === "prompt" || fam === "api" || fam === "response") return "";
  if (fam === "compact") return "cmp";
  if (fam === "spawn") return "out";
  if (fam === "done") return "in";
  const t = (ev.tool ?? "").toLowerCase();
  if (fam === "mcp") return (t.split("__")[1] ?? "mcp").slice(0, 4);
  if (fam === "bash") {
    const w = (ev.detail ?? "").trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "");
    return w ? w.slice(0, 4) : "sh";
  }
  if (fam === "error") return (CODES[t] ?? t.slice(0, 3)) || "err";
  return CODES[t] ?? t.slice(0, 4);
}
