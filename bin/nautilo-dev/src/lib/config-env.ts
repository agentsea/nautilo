/**
 * M053: tiny `~/.nautilo/config.env` loader for one-shot CLI commands.
 *
 * The migrate-to-logto / migrate-from-logto / verify-user-link commands
 * run outside the server's startup path, so neither `@nautilo/db` nor
 * `@nautilo/trust` (specifically `getLogtoAdminClient()`) auto-loads
 * `~/.nautilo/config.env`. Without this helper, the singletons capture
 * empty env vars on first construction and every subsequent call sees
 * a misconfigured client even if config.env is present on disk.
 *
 * Pure (no side effects beyond mutating `process.env`) and only writes
 * keys that aren't already set, so a caller-provided `--config-env`
 * override or pre-set env from CI still wins.
 *
 * Mirrors the parser used in `bin/nautilo-local/src/bootstrap-logto.ts`
 * — line-oriented `KEY=value`, `#` comments, blank lines tolerated.
 */
import { readFileSync } from "node:fs";
import { resolveDotenvPath } from "./paths";

export interface LoadConfigEnvOptions {
  /** Override path (honors `--config-env <path>` argv flag). */
  path?: string | undefined;
}

export interface LoadConfigEnvResult {
  /** Path actually read (after override + default). */
  path: string;
  /** Whether the file existed and was parsed. */
  loaded: boolean;
  /** Number of keys written into `process.env` (already-set keys skipped). */
  applied: number;
}

const KEY_LINE = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/;

/** Parse a dotenv file without mutating an environment. */
function parseConfigEnv(raw: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const m = line.match(KEY_LINE);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (!key || rawValue === undefined) continue;
    parsed[key] = stripQuotes(rawValue);
  }
  return parsed;
}

/** Read and parse a dotenv file without exposing values or mutating process.env. */
export function readConfigEnv(
  options: LoadConfigEnvOptions = {},
): { path: string; loaded: boolean; values: Record<string, string> } {
  const path = options.path?.trim() ? options.path.trim() : resolveDotenvPath();
  try {
    return {
      path,
      loaded: true,
      values: parseConfigEnv(readFileSync(path, "utf-8")),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, loaded: false, values: {} };
    }
    throw new Error(`Unable to read config environment at ${path}`);
  }
}

export function loadConfigEnvIntoProcess(
  options: LoadConfigEnvOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): LoadConfigEnvResult {
  const loaded = readConfigEnv(options);
  if (!loaded.loaded) return { path: loaded.path, loaded: false, applied: 0 };

  let applied = 0;
  for (const [key, value] of Object.entries(loaded.values)) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    applied++;
  }
  return { path: loaded.path, loaded: true, applied };
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}
