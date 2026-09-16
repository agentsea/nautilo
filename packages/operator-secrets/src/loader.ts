import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { debuglog } from "node:util";
import {
  assertFileMode600,
  assertPathOutsideGitWorkTree,
  isRecognizedOperatorSecretKey,
  OPERATOR_SECRET_KEY_REGEX,
  prepareOperatorSecretsPath,
} from "./shared.ts";

const dlog = debuglog("nautilo:operator-secrets");

export function defaultOperatorSecretsPath(): string {
  return join(homedir(), ".config", "nautilo", "secrets.env");
}

/**
 * Parse KEY=VALUE lines (dotenv subset): comments `#`, blank lines, optional
 * `export ` prefix, double-quoted values with `\\` and `\"` escapes.
 * No variable interpolation.
 */
export function parseOperatorSecretsBody(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = body.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    let rest = line;
    if (/^export\s+/i.test(rest)) {
      rest = rest.replace(/^export\s+/i, "").trimStart();
    }
    const eq = rest.indexOf("=");
    if (eq === -1) continue;
    const key = rest.slice(0, eq).trim();
    let valuePart = rest.slice(eq + 1).trim();
    if (!OPERATOR_SECRET_KEY_REGEX.test(key)) {
      throw new Error(`invalid operator secrets key (expected ${OPERATOR_SECRET_KEY_REGEX}): ${key}`);
    }
    if (valuePart.startsWith('"')) {
      valuePart = valuePart.slice(1);
      let decoded = "";
      let i = 0;
      for (; i < valuePart.length; i++) {
        const c = valuePart[i]!;
        if (c === "\\" && i + 1 < valuePart.length) {
          const n = valuePart[i + 1]!;
          if (n === "n") {
            decoded += "\n";
            i++;
            continue;
          }
          if (n === "r") {
            decoded += "\r";
            i++;
            continue;
          }
          if (n === "t") {
            decoded += "\t";
            i++;
            continue;
          }
          decoded += n;
          i++;
          continue;
        }
        if (c === '"') break;
        decoded += c;
      }
      if (i >= valuePart.length || valuePart[i] !== '"') {
        throw new Error(`unterminated quoted value for key ${key}`);
      }
      out[key] = decoded;
    } else if (valuePart.startsWith("'")) {
      const end = valuePart.indexOf("'", 1);
      if (end === -1) throw new Error(`unterminated single-quoted value for key ${key}`);
      out[key] = valuePart.slice(1, end);
    } else {
      const hash = valuePart.indexOf("#");
      const unquoted = (hash === -1 ? valuePart : valuePart.slice(0, hash)).trim();
      out[key] = unquoted;
    }
  }
  return out;
}

/**
 * Load operator secrets from `path`. Missing file → `{}`. Mode 0600, symlink
 * policy, repo-tree refusal (§13.2 / §13.6).
 */
export async function loadOperatorSecrets(path: string): Promise<Record<string, string>> {
  // No async I/O yet (sync reads only); the async signature is forward-compat
  // with the atomic-rotation contract D115 plans (same justification as
  // `appendOperatorSecrets`). Yielding here satisfies require-await without
  // changing the Promise<Record<string, string>> return shape. Callers
  // already `await` this — do NOT collapse to sync.
  await Promise.resolve();
  const { statPath, realPath } = prepareOperatorSecretsPath(path);
  if (!existsSync(statPath)) {
    assertPathOutsideGitWorkTree(realPath);
    return {};
  }
  assertPathOutsideGitWorkTree(realPath);
  assertFileMode600(realPath, "secrets file");
  const body = readFileSync(statPath, "utf8");
  const parsed = parseOperatorSecretsBody(body);
  for (const key of Object.keys(parsed)) {
    if (!isRecognizedOperatorSecretKey(key)) {
      dlog("unknown key loaded (forward-compat): %s", key);
    }
  }
  return parsed;
}
