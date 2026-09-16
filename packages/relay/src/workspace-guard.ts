import { realpathSync, existsSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

/**
 * Shared path-safety for relay dispatch handlers.
 *
 * The Electron relay and the headless `bin/nautilo-relay` used to
 * carry independent copies of the "is this path inside my workspace?"
 * logic with subtle drift: different handling of absolute vs. relative
 * inputs, no canonical root check, no null-byte rejection. Consolidated
 * here so both relays share one implementation with one set of tests.
 *
 * Two responsibilities:
 *
 * 1. `createWorkspaceGuard({ workspaceRoot, allowedRoots })` returns a
 *    `{ check(path) -> ok | error }` object. Dispatch handlers call
 *    `check()` before touching the filesystem.
 * The Electron relay supplies its app-owned Genie Workspace explicitly. This
 * shared package intentionally does not invent a hidden product-data fallback:
 * a caller with no declared root must fail closed rather than dispatch work in
 * `~/.nautilo/...` state that the desktop sandbox may not be able to access.
 */

export interface WorkspaceGuardOptions {
  /**
   * Primary workspace root the relay is bound to. May be undefined;
   * the guard then uses `allowedRoots` alone.
   */
  workspaceRoot?: string | undefined;
  /**
   * Additional roots the relay is allowed to touch (request-supplied
   * via `RelayDispatchRequest.allowedRoots`).
   */
  allowedRoots?: readonly string[] | undefined;
}

export interface WorkspaceGuard {
  /** Every canonical root this guard will permit. Diagnostic output. */
  readonly roots: readonly string[];
  /**
   * Decide whether a caller-supplied path is permitted. Returns either
   * `{ ok: true, resolved }` with the canonical absolute path that
   * downstream I/O should use, or `{ ok: false, error }` describing
   * why.
   */
  check(candidate: string): WorkspaceGuardResult;
}

export type WorkspaceGuardResult =
  | { ok: true; resolved: string }
  | { ok: false; error: string };

/**
 * Resolve `path` to its canonical form. If the full path doesn't
 * exist, walk up toward an existing ancestor, canonicalise THAT, then
 * re-attach the trailing pieces. Ensures a check against
 * `/var/folders/...`-style temp roots compares correctly against a
 * guard constructed with the same path (macOS canonicalises
 * `/var/folders` → `/private/var/folders`).
 */
function canonicalise(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    // Walk up to the nearest existing ancestor.
    let current = abs;
    const tail: string[] = [];
    while (!existsSync(current)) {
      const parent = dirname(current);
      if (parent === current) return abs; // nothing exists on this branch
      tail.unshift(current.slice(parent.length + 1));
      current = parent;
    }
    try {
      const real = realpathSync(current);
      return tail.length > 0 ? resolve(real, ...tail) : real;
    } catch {
      return abs;
    }
  }
}

export function createWorkspaceGuard(
  opts: WorkspaceGuardOptions,
): WorkspaceGuard {
  const roots: string[] = [];
  if (opts.workspaceRoot) roots.push(canonicalise(opts.workspaceRoot));
  for (const r of opts.allowedRoots ?? []) roots.push(canonicalise(r));
  const unique = [...new Set(roots)];

  function check(candidate: string): WorkspaceGuardResult {
    if (typeof candidate !== "string" || candidate.length === 0) {
      return { ok: false, error: "path missing" };
    }
    if (candidate.includes("\0")) {
      return { ok: false, error: "null byte in path" };
    }
    if (unique.length === 0) {
      return {
        ok: false,
        error:
          "no workspace configured — start the relay with an explicit Workspace root",
      };
    }
    const abs = isAbsolute(candidate) ? candidate : resolve(candidate);
    const resolved = canonicalise(abs);
    for (const root of unique) {
      if (resolved === root) return { ok: true, resolved };
      if (resolved.startsWith(root + sep)) return { ok: true, resolved };
    }
    return {
      ok: false,
      error: `path ${candidate} is outside allowed workspace root(s): ${unique.join(
        ", ",
      )}`,
    };
  }

  return { roots: Object.freeze([...unique]), check };
}
