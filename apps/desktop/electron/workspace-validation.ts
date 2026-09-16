/**
 * Pure validator for the `workspace:setPath` IPC (D057 2a.7).
 *
 * ## What this validates
 *
 * Shape-only sanity checks before committing a renderer-supplied path
 * to `workspace.json`:
 *
 *   1. Non-empty string
 *   2. Absolute path
 *   3. No embedded NUL byte
 *   4. Target exists on disk and is a directory (stat + isDirectory)
 *
 * The returned `resolved` is `path.resolve(input)` — `..` and `.`
 * segments are normalized away before commit so every downstream
 * consumer reads a canonical form.
 *
 * ## What this does NOT do (intentional, documented)
 *
 * This validator is **defense-in-depth against shape bugs and
 * obviously-malformed input**. It is NOT the privilege boundary that
 * restricts which real directories a compromised renderer could pick.
 *
 * The privilege boundary for filesystem access lives in
 * `packages/relay/src/workspace-guard.ts` — the guard wrapping every
 * `fs:*` IPC handler (`assertPathInWorkspace` in `main.ts:75-79`).
 * That guard confines reads/writes to whatever `workspacePath` currently
 * is. This validator's job is to ensure `workspacePath` is a
 * syntactically sane directory reference, not to enforce an allow-list
 * of safe roots.
 *
 * In practice this means: a compromised renderer that hijacks
 * `workspace:setPath` CAN persist (say) `/Users/me/.ssh` as the
 * workspace — that's a legitimately absolute, existing directory. The
 * defense against that attack is the Electron preload bridge + the
 * `pickFolder` native dialog (which requires real user interaction for
 * a folder-pick), not this validator. Callers that need a strict allow
 * list should layer that on top; this module deliberately stays
 * non-opinionated about *which* directories are OK.
 *
 * ## Symlinks
 *
 * `fs.statSync` follows symlinks. A symlinked directory pointing at any
 * reachable target passes validation — which is correct for the
 * native-dialog flow (users legitimately pick symlinked paths).
 * Upgrading to `fs.realpathSync` + policy comparison is a deliberate
 * future change; callers wanting stricter symlink handling should do
 * their own `realpathSync` on the returned `resolved` value.
 */

import type { Stats } from "node:fs";

export interface WorkspacePathInput {
  path?: unknown;
}

export type WorkspacePathValidationResult =
  | { ok: true; resolved: string }
  | { ok: false; error: string };

/**
 * Minimal shape of the filesystem dependency so tests can inject a
 * fake without touching disk. In production, the handler passes
 * `{ statSync: fs.statSync, isAbsolute: path.isAbsolute, resolve: path.resolve }`.
 */
export interface ValidatorDeps {
  statSync(p: string): Pick<Stats, "isDirectory">;
  isAbsolute(p: string): boolean;
  resolve(p: string): string;
}

export function validateWorkspacePath(
  args: WorkspacePathInput | undefined | null,
  deps: ValidatorDeps,
): WorkspacePathValidationResult {
  if (!args || typeof args !== "object") {
    return { ok: false, error: "workspace:setPath requires { path: string }" };
  }
  const raw = args.path;
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: "workspace:setPath requires a non-empty path string" };
  }
  if (raw.includes("\0")) {
    return { ok: false, error: "workspace:setPath rejects paths containing NUL bytes" };
  }
  if (!deps.isAbsolute(raw)) {
    return { ok: false, error: "workspace:setPath requires an absolute path" };
  }

  // Normalize before stat + commit so downstream consumers read a
  // canonical form. `/a/../b` becomes `/b`; trailing slashes are
  // stripped (except for the root `/` itself on POSIX).
  const resolved = deps.resolve(raw);

  let stat: Pick<Stats, "isDirectory">;
  try {
    stat = deps.statSync(resolved);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `workspace path not accessible: ${msg}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: "workspace path is not a directory" };
  }
  return { ok: true, resolved };
}
