/**
 * Path deny list — blocks file operations on sensitive paths.
 *
 * Runs before any file read/write/list operation. Rejects paths that
 * match the deny set regardless of security level (except yolo).
 */

import { basename, dirname, isAbsolute, relative, resolve, normalize, sep } from "node:path";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolveSecurityLayers, type SecurityLevel } from "./security-config";
import { warn } from "@nautilo/logger";

const HOME = homedir();

const ABSOLUTE_DENY: readonly string[] = [
  "/etc/passwd",
  "/etc/shadow",
  "/etc/sudoers",
  "/etc/hosts",
  "/etc/ssh",
  "/etc/ssl",
  "/etc/pam.d",
  "/etc/security",
  "/boot",
  "/proc",
  "/sys",
  "/dev",
];

const HOME_RELATIVE_DENY: readonly string[] = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".config/gcloud",
  ".kube",
  ".docker",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".env",
  ".env.local",
  ".env.production",
];

/**
 * macOS-specific secret stores. Platform-gated in the loader below
 * instead of relying on "Linux realpath silently fails on macOS
 * paths" (D063 PR-001 follow-up M-2). The old behavior worked but
 * was fragile — if any of these paths happened to exist on a Linux
 * box (e.g. an unrelated app creating `~/Library/…`), the deny list
 * would match them with no way to opt out. Explicit gate is clearer
 * and makes the Linux-vs-macOS split auditable.
 */
const DARWIN_HOME_RELATIVE_DENY: readonly string[] = [
  "Library/Keychains",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Chromium",
  "Library/Application Support/Firefox",
  "Library/Application Support/Arc",
  "Library/Application Support/BraveSoftware",
  "Library/Cookies",
  "Library/Safari",
];

function resolveWithRealpath(p: string): string {
  let current = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(current), ...tail);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) return normalize(resolve(p));
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

function resolveDenyPath(p: string): string {
  try { return resolveWithRealpath(p); }
  catch { return normalize(resolve(p)); }
}

function buildResolvedDeny(platform: NodeJS.Platform): string[] {
  const homeEntries = platform === "darwin"
    ? [...HOME_RELATIVE_DENY, ...DARWIN_HOME_RELATIVE_DENY]
    : HOME_RELATIVE_DENY;
  return [
    ...ABSOLUTE_DENY.map(resolveDenyPath),
    ...homeEntries.map((rel) => resolveDenyPath(resolve(HOME, rel))),
  ];
}

const RESOLVED_DENY = buildResolvedDeny(process.platform);

function containsPath(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

// Exported for unit tests only — allows verifying the platform gate
// without having to mock `process.platform` globally.
export function _buildResolvedDenyForTests(platform: NodeJS.Platform): string[] {
  return buildResolvedDeny(platform);
}

export type PathCheckResult = {
  allowed: boolean;
  reason?: string;
};

/**
 * Three-layer check against the deny list:
 *
 *   1. Equality          — target IS a denied path.
 *   2. Descendant        — target is INSIDE a denied directory.
 *   3. Ancestor (G7)     — target is ABOVE a denied path.
 *
 * Layer 3 is more aggressive than the legacy behavior — `list_directory`
 * on `~` will now reject because it's an ancestor of `~/.ssh`,
 * `~/.aws`, etc. That's intentional: walking from a parent dir into a
 * recursive command (grep / find / tree) would scan the deny entries
 * before any per-entry filtering caught it (FILE-02 motivating exfil
 * vector). Agents are expected to use bounded zones (`workspace`,
 * `current`) for legitimate operations; absolute zone is reserved for
 * specific files outside the workspace.
 */
export function checkPathAccess(
  targetPath: string,
  level: SecurityLevel,
): PathCheckResult {
  const layers = resolveSecurityLayers(level);
  if (!layers.pathDeny) {
    return { allowed: true };
  }

  const expanded = (targetPath.startsWith("~/") || (process.platform === "win32" && targetPath.startsWith("~\\")))
    ? resolve(HOME, targetPath.slice(2))
    : targetPath === "~"
      ? HOME
      : resolve(targetPath);
  let normalized: string;
  // Resolve the nearest existing ancestor as well as existing targets: writes
  // to a new file must not bypass a protected directory through an alias.
  try {
    normalized = resolveWithRealpath(expanded);
  } catch {
    return { allowed: false, reason: "Access denied: path cannot be resolved safely" };
  }

  // Equality + descendant check — target IS or is INSIDE a denied
  // directory (legacy behavior; D079 PR-011 motivation).
  for (const denied of RESOLVED_DENY) {
    if (containsPath(denied, normalized)) {
      warn(`[security] Path DENIED: "${targetPath}" resolves to protected path ${denied}`);
      return {
        allowed: false,
        reason: `Access denied: ${denied} is a protected path`,
      };
    }
  }

  // Ancestor check — target is an ANCESTOR of a denied path. This
  // catches the FILE-02 / G7 exfil vector: `file({grep, absolute, /})`
  // walks recursively from `/` into `/etc/passwd`, `~/.ssh`, etc. The
  // legacy descendant-only check let this through because `/` is not
  // EQUAL to any deny entry and the deny entries don\u0027t START with `/`
  // followed by themselves. Any operation rooted at `/` (list, grep,
  // tree, recursive read) would scan the deny entries — block at the
  // gate rather than rely on the handler\u0027s in-walk filtering.
  //
  // Native relative-path semantics handle roots, trailing separators, and
  // Windows drive/case rules without confusing siblings with descendants.
  for (const denied of RESOLVED_DENY) {
    if (containsPath(normalized, denied)) {
      warn(`[security] Path DENIED: "${targetPath}" is an ancestor of protected path ${denied}`);
      return {
        allowed: false,
        reason: `Access denied: ${denied} is a protected path (target is an ancestor)`,
      };
    }
  }

  return { allowed: true };
}
