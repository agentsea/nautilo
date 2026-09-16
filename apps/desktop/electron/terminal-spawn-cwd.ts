import { createWorkspaceGuard } from "@nautilo/relay";

export type TerminalSpawnCwdResolution =
  | { readonly ok: true; readonly cwd: string }
  | { readonly ok: false; readonly error: string };

/**
 * Bind terminal process identity to the exact sandbox root before node-pty is
 * started. The relay's broader allowedRoots list cannot rescue a mismatched
 * envelope: spawning in one tree while sandboxing another only creates a PTY
 * that immediately dies with getcwd(EPERM).
 */
export function resolveTerminalSpawnCwd(input: {
  readonly requestedCwd: unknown;
  readonly sandboxWorkspace: string | undefined;
  readonly fallbackWorkspace: string | undefined;
}): TerminalSpawnCwdResolution {
  const authorityRoot = input.sandboxWorkspace ?? input.fallbackWorkspace;
  if (authorityRoot === undefined || authorityRoot.length === 0) {
    return { ok: false, error: "terminal spawn refused: no authorized Current Folder is available" };
  }
  const requested =
    typeof input.requestedCwd === "string" && input.requestedCwd.length > 0
      ? input.requestedCwd
      : authorityRoot;
  const checked = createWorkspaceGuard({ workspaceRoot: authorityRoot }).check(requested);
  if (!checked.ok) {
    return {
      ok: false,
      error:
        "terminal spawn refused: requested cwd is outside the sandbox Current Folder; " +
        "the process was not started",
    };
  }
  return { ok: true, cwd: checked.resolved };
}
