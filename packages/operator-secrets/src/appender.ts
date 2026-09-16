import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  assertFileMode600,
  assertPathOutsideGitWorkTree,
  prepareOperatorSecretsPath,
} from "./shared.ts";
import { parseOperatorSecretsBody } from "./loader.ts";

const HEADER = [
  "# =============================================================================",
  "# Nautilo operator secrets (mode 0600)",
  "# =============================================================================",
  "# Shared provider keys + per-instance bootstrap values used by",
  "# `gen-setup-template` and `nautilo setup --secrets-file`.",
  "# Do not commit this file; keep it outside any git work tree.",
  "# =============================================================================",
  "",
].join("\n");

function escapeValue(v: string): string {
  if (/[\s#"'\\]/.test(v) || v.length === 0) {
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
  }
  return v;
}

function formatKv(key: string, value: string, exportPrefix: string): string {
  return `${exportPrefix}${key}=${escapeValue(value)}`;
}

function mergeSecretsContent(
  existing: string,
  entries: Array<{ key: string; value: string; comment?: string }>,
): string {
  const keysToSet = new Map(entries.map((e) => [e.key, e] as const));
  const outLines: string[] = [];
  const replaced = new Set<string>();

  if (existing.trim().length > 0) {
    const lines = existing.split(/\r?\n/);
    // Buffer consecutive `#`-comment lines as "bound to" the next non-comment
    // line. When we replace the next KV, we DROP the buffer (and write a
    // fresh comment from the entry); otherwise we flush the buffer unchanged.
    // Pre-fix this function pushed comments straight to outLines and then
    // also prepended a new comment at the replacement, so re-runs piled up
    // a duplicate `# comment` line per call (see operator-secrets-append
    // bloat regression).
    let pendingComments: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) {
        pendingComments.push(line);
        continue;
      }
      if (trimmed === "") {
        // Blank line breaks comment-binding; emit comments as standalone.
        outLines.push(...pendingComments);
        pendingComments = [];
        outLines.push(line);
        continue;
      }
      let rest = trimmed;
      const exportP = /^export\s+/i.test(rest) ? "export " : "";
      if (exportP) rest = rest.replace(/^export\s+/i, "").trimStart();
      const eq = rest.indexOf("=");
      if (eq === -1) {
        outLines.push(...pendingComments);
        pendingComments = [];
        outLines.push(line);
        continue;
      }
      const key = rest.slice(0, eq).trim();
      const ent = keysToSet.get(key);
      if (ent) {
        // Replace: drop bound comments, write fresh from the entry.
        if (ent.comment) outLines.push(`# ${ent.comment}`);
        outLines.push(formatKv(ent.key, ent.value, ""));
        replaced.add(key);
        pendingComments = [];
      } else {
        // Keep existing KV unchanged; flush its bound comments verbatim.
        outLines.push(...pendingComments);
        pendingComments = [];
        outLines.push(line);
      }
    }
    // Trailing comments not bound to any KV — preserve them.
    outLines.push(...pendingComments);
  }

  for (const e of entries) {
    if (replaced.has(e.key)) continue;
    if (e.comment) outLines.push(`# ${e.comment}`);
    outLines.push(formatKv(e.key, e.value, ""));
    replaced.add(e.key);
  }

  const body =
    (existing.trim().length === 0 ? HEADER : "") + outLines.join("\n") + "\n";
  return body;
}

/**
 * One-shot cleanup pass: when a file accumulated duplicate consecutive
 * `# comment` lines from the pre-fix bloat, collapse runs of identical
 * adjacent comment lines down to one. Whitespace-different copies are
 * left alone (intent: only undo the regression, not sand off operator
 * formatting). Idempotent.
 */
function dedupeAdjacentComments(content: string): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let prevComment: string | null = null;
  for (const line of lines) {
    if (line.startsWith("#") && line === prevComment) continue;
    out.push(line);
    prevComment = line.startsWith("#") ? line : null;
  }
  return out.join("\n");
}

/**
 * Atomic append/replace keys in an operator secrets file (§13.3).
 */
export async function appendOperatorSecrets(args: {
  path: string;
  entries: Array<{ key: string; value: string; comment?: string }>;
  createIfMissing?: boolean | undefined;
}): Promise<void> {
  // No async I/O yet (sync writes only); the async signature is forward-compat
  // with the atomic-rotation contract D115 plans. Yielding here satisfies
  // require-await without changing the Promise<void> return shape.
  await Promise.resolve();
  const resolved = args.path;
  const createIfMissing = args.createIfMissing ?? true;
  const parent = dirname(resolved);

  let existing = "";
  if (existsSync(resolved)) {
    const { statPath, realPath } = prepareOperatorSecretsPath(resolved);
    assertPathOutsideGitWorkTree(realPath);
    assertFileMode600(realPath, "secrets file");
    existing = readFileSync(statPath, "utf8");
    // Self-heal pre-fix accumulated duplicate-comment runs on read so the
    // first re-write under the fixed merger collapses any existing bloat.
    existing = dedupeAdjacentComments(existing);
    parseOperatorSecretsBody(existing);
  } else {
    if (!createIfMissing) {
      throw new Error(`operator secrets file does not exist: ${resolved}`);
    }
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    assertPathOutsideGitWorkTree(resolved);
  }

  const merged = mergeSecretsContent(existing, args.entries);
  const tmp = join(
    parent,
    `.secrets.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  writeFileSync(tmp, merged, { mode: 0o600 });
  try {
    renameSync(tmp, resolved);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
  if (process.platform !== "win32") {
    try {
      chmodSync(resolved, 0o600);
    } catch {
      /* best effort */
    }
  }
}
