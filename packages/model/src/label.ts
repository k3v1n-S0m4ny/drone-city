import { DEFAULT_TICKET_LABEL_RE } from "./types.ts";

/**
 * Compile the ticket-label regex (group 1 = label). Falls back to the default when the
 * source is empty or not a valid regex.
 */
export function compileTicketLabelRe(source?: string): RegExp {
  for (const candidate of [source, DEFAULT_TICKET_LABEL_RE]) {
    if (!candidate) continue;
    try {
      return new RegExp(candidate);
    } catch {
      // invalid user regex: fall through to the default
    }
  }
  return new RegExp(DEFAULT_TICKET_LABEL_RE);
}

/** Claude Code names a project dir after the cwd with every non-alphanumeric char replaced by `-`. */
export function cwdToProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Derive the ticket label (e.g. "t245") from a project-dir name, using group 1 of the regex
 * (or the whole match when the regex has no group). Returns undefined when not derivable.
 */
export function deriveTicketLabel(
  projectDir: string | undefined,
  re: RegExp = compileTicketLabelRe(),
): string | undefined {
  if (!projectDir) return undefined;
  const m = re.exec(projectDir);
  if (!m) return undefined;
  const label = m[1] ?? m[0];
  return label === "" ? undefined : label;
}

/** Same, starting from a working directory path. */
export function deriveTicketLabelFromCwd(cwd: string | undefined, re?: RegExp): string | undefined {
  return cwd ? deriveTicketLabel(cwdToProjectDir(cwd), re) : undefined;
}
