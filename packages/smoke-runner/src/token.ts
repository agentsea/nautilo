/**
 * Bearer-token management for `nautilo-smoke serve` (D063 Phase 3.2).
 *
 * The token is persisted at `~/.nautilo/smoke-token` with mode 0600.
 * `getOrCreateToken()` reads the existing file or creates one on first
 * call. `rotateToken()` overwrites with a new value. The MCP server
 * (Phase 4) and any `curl` consumer use the same file.
 *
 * Override via the `NAUTILO_SMOKE_TOKEN` env var — useful for tests
 * and CI. When the env var is set, the file is not touched.
 *
 * Token shape: 32 bytes of cryptographic randomness, hex-encoded → 64
 * chars. The leading "nsk_" prefix is cosmetic + makes accidentally
 * pasted tokens easy to recognize in logs / error messages.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

const TOKEN_BYTES = 32;
const TOKEN_PREFIX = "nsk_"; // "nautilo smoke key"
const TOKEN_FILE_RELATIVE = [".nautilo", "smoke-token"] as const;
const ENV_VAR = "NAUTILO_SMOKE_TOKEN";

export interface TokenOptions {
  /** Override the home-directory root. Tests use this to avoid touching
   *  the real ~/.nautilo dir. */
  readonly home?: string;
  /** Explicit env-var override. Default: `process.env.NAUTILO_SMOKE_TOKEN`. */
  readonly envOverride?: string | null | undefined;
}

/**
 * Return the token to use for the serve process. Resolution order:
 *   1. `options.envOverride` or process.env.NAUTILO_SMOKE_TOKEN
 *   2. Existing file at ~/.nautilo/smoke-token
 *   3. Generate a fresh one, persist with 0600
 *
 * Never logs the token itself. Callers that log should use `maskToken`.
 */
export function getOrCreateToken(options: TokenOptions = {}): string {
  const envValue = options.envOverride !== undefined ? options.envOverride : process.env[ENV_VAR];
  if (envValue && envValue.trim().length > 0) {
    return envValue.trim();
  }

  const home = options.home ?? homedir();
  const tokenPath = join(home, ...TOKEN_FILE_RELATIVE);
  const dir = join(home, TOKEN_FILE_RELATIVE[0]);

  if (existsSync(tokenPath)) {
    const contents = readFileSync(tokenPath, "utf8").trim();
    if (contents.length > 0) {
      return contents;
    }
    // Empty file — fall through and regenerate.
  }

  const fresh = generateToken();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath, fresh, { encoding: "utf8", mode: 0o600 });
  try {
    // Belt-and-suspenders: ensure 0600 on platforms where writeFileSync's
    // mode arg is advisory or ignored (some Windows mounts).
    chmodSync(tokenPath, 0o600);
  } catch {
    // Non-fatal — caller will still have a usable token in memory.
  }
  return fresh;
}

/**
 * Generate a new token, persist it, return the new value. Always writes
 * the file (even if env-var was set previously). Caller is responsible
 * for restarting the server so the new token takes effect.
 */
export function rotateToken(options: TokenOptions = {}): string {
  const home = options.home ?? homedir();
  const tokenPath = join(home, ...TOKEN_FILE_RELATIVE);
  const dir = join(home, TOKEN_FILE_RELATIVE[0]);
  const fresh = generateToken();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath, fresh, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(tokenPath, 0o600); } catch { /* see getOrCreateToken */ }
  return fresh;
}

/** Read the persisted token without creating one. Returns null if absent. */
export function readPersistedToken(options: TokenOptions = {}): string | null {
  const home = options.home ?? homedir();
  const tokenPath = join(home, ...TOKEN_FILE_RELATIVE);
  if (!existsSync(tokenPath)) return null;
  const contents = readFileSync(tokenPath, "utf8").trim();
  return contents.length > 0 ? contents : null;
}

/**
 * Return a redacted form safe for log output:
 *   nsk_abcdef1234… (last 4 chars: abcd)
 * Distinguishable enough to correlate logs without exposing the token.
 */
export function maskToken(token: string): string {
  if (token.length < 10) return "[malformed]";
  const head = token.slice(0, Math.min(12, token.length - 4));
  const tail = token.slice(-4);
  return `${head}…${tail}`;
}

function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString("hex");
}
