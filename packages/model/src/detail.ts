import { DETAIL_MAX } from "./types.ts";

/** Collapse to one line, trim, cap at DETAIL_MAX. Returns undefined for empty input. */
export function sanitizeDetail(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const oneLine = input.replace(/\s+/g, " ").trim();
  if (oneLine === "") return undefined;
  if (oneLine.length <= DETAIL_MAX) return oneLine;
  return oneLine.slice(0, DETAIL_MAX - 1).trimEnd() + "\u2026";
}

/** Last path segment, for either separator style. */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

export function isAgentTool(tool: string | undefined): boolean {
  return tool === "Agent" || tool === "Task";
}

/** Which parameter key holds the human-friendly detail for a tool. Shared by both normalizers and replay. */
export function detailKeyForTool(tool: string): { bag: "params" | "input"; key: string } {
  switch (tool) {
    case "Agent":
    case "Task":
      return { bag: "params", key: "subagent_type" };
    case "Skill":
      return { bag: "params", key: "skill_name" };
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
      return { bag: "input", key: "file_path" };
    case "NotebookEdit":
      return { bag: "input", key: "notebook_path" };
    case "Grep":
    case "Glob":
      return { bag: "input", key: "pattern" };
    default:
      return { bag: "params", key: "description" };
  }
}

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Derive a short detail for a tool call from its parameters (OTel tool_parameters / tool_input,
 * or the JSONL tool_use input). Only ever tool metadata, never prompt text.
 */
export function toolDetail(
  tool: string | undefined,
  ...bags: Array<Record<string, unknown> | undefined>
): string | undefined {
  const get = (key: string): unknown => {
    for (const b of bags) if (b && b[key] !== undefined) return b[key];
    return undefined;
  };
  const str = (key: string): string | undefined => {
    const v = get(key);
    return typeof v === "string" && v.trim() !== "" ? v : undefined;
  };
  if (tool && FILE_TOOLS.has(tool)) {
    const p = str("file_path") ?? str("notebook_path") ?? str("path");
    return p ? sanitizeDetail(basename(p)) : undefined;
  }
  if (isAgentTool(tool)) return sanitizeDetail(str("subagent_type"));
  if (tool === "Skill") return sanitizeDetail(str("skill_name") ?? str("skill"));
  if (tool === "Grep" || tool === "Glob") return sanitizeDetail(str("pattern"));
  if (tool === "Bash" || tool === "PowerShell") {
    return sanitizeDetail(str("description") ?? str("bash_command") ?? str("command"));
  }
  const server = str("mcp_server_name");
  const mcpTool = str("mcp_tool_name");
  if (server && mcpTool) return sanitizeDetail(`${server}/${mcpTool}`);
  return sanitizeDetail(str("description"));
}
