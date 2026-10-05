import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Walk up from `start` looking for a `.env` file. */
export function findEnvFile(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Minimal dotenv parser (KEY=VALUE, `#` comments, optional quotes). Used when loadEnvFile is missing. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2] ?? "";
    else value = value.replace(/\s+#.*$/, "");
    out[key] = value;
  }
  return out;
}

/**
 * Load the nearest `.env` into `env` without overriding variables that are already set.
 * Uses `process.loadEnvFile` (Node >= 20.12 / 21.7) when available, else a tiny loader.
 * Returns the file that was loaded, if any.
 */
export function loadDotEnv(
  start: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const file = findEnvFile(start);
  if (!file) return undefined;
  if (env === process.env && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(file);
    return file;
  }
  for (const [k, v] of Object.entries(parseDotEnv(readFileSync(file, "utf8")))) {
    if (env[k] === undefined) env[k] = v;
  }
  return file;
}
