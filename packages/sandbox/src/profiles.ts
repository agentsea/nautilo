/**
 * Deployment-profile helpers for `@nautilo/sandbox`.
 * D060 Sprint 1 G5.2 (security ship plan v3 §5.3).
 *
 * The server's Policy Resolver invokes one of these when building
 * a per-turn policy envelope (G5.4). Each helper returns a
 * `SandboxProfileSpec` — the shape the relay consumes to construct
 * a `Sandbox` via `Sandbox.create()` (backend detected at creation
 * time; every other field provided by the profile + caller inputs).
 *
 * Three canonical shapes match the three values of the Server's
 * `deployment_mode` property (see `entity-model/GLOSSARY.md::SRV`
 * and the ship plan §3.1):
 *
 *   `server`             → workspace-only, nothing else exposed.
 *                          Cloud / CI / OSS-headless deployments.
 *
 *   `desktop-permissive` → broad RO user-home + narrow RW project +
 *                          Downloads. Default single-user Electron
 *                          experience.
 *
 *   `desktop-locked`     → workspace-only on desktop. Power users,
 *                          regulated orgs, dev-in-prod boxes.
 *
 * Each helper also returns the canonical default `SecurityLevel` for
 * that mode (server → paranoid, desktop-permissive → cautious,
 * desktop-locked → paranoid). The Policy Resolver combines that
 * with the user's configured `security_level` override (if any;
 * only a Human holding `manage_server_security` can set one via
 * the Settings UI) to produce the final level in the envelope.
 *
 * **Never invoked by clients.** Client code does not construct
 * `Sandbox` instances directly — it consumes them via the relay
 * dispatch envelope (G5.4). These helpers live in the leaf
 * `@nautilo/sandbox` package so the server can reuse the same
 * sandbox code the relay eventually runs.
 *
 * The `networkAccess` + advanced gating Phase 3 will add is NOT
 * here yet — profiles today produce sandbox-scope specs only; the
 * network allowlist lands with D060 Phase 3.
 */

import type { SandboxConfig, SandboxMode } from "./types";
import type { SandboxCreateOptions } from "./sandbox";
import type { SecurityLevel } from "./security-level";

/**
 * Inputs the caller (server Policy Resolver) supplies. Only the
 * profile-specific fields need to be non-undefined for that profile;
 * helpers throw with a clear message if a required field is missing.
 */
export interface DeploymentProfileInputs {
  /**
   * The human's home directory (`os.homedir()`-equivalent). Required
   * for `desktopPermissive` (readOnly allow). Unused by `server` and
   * `desktopLocked`.
   */
  readonly userHome?: string;
  /**
   * The agent's active project / workspace root. Required for
   * `desktopPermissive` + `desktopLocked`. Unused by `server`.
   */
  readonly currentProject?: string;
  /**
   * The server's artifacts directory (the Agent's output staging).
   * Required for `server`. Unused by the desktop profiles.
   */
  readonly artifactsDir?: string;
  /**
   * The user's Downloads directory. Optional for `desktopPermissive`
   * (if omitted, Downloads is not writable beyond the project).
   * Typically `${userHome}/Downloads` on Mac/Linux; the caller
   * passes the actual path.
   */
  readonly downloads?: string;
  /**
   * Agent data directory (secret store, DB cache, etc.). Required
   * for ALL profiles — masked via `--tmpfs` / `(deny subpath)` by
   * the builder regardless of readOnly/writable overlap.
   */
  readonly dataDir: string;
  /**
   * Per-install tools binary directory (bun, etc.). Required for
   * ALL profiles — prepended to PATH inside the sandbox.
   */
  readonly toolsBin: string;
  /**
   * User-configured extra writable paths. Appended to the profile's
   * baseline writablePaths. Optional. Server deployments typically
   * leave this empty; desktop deployments might include a shared
   * workspace dir outside the project.
   */
  readonly extraWritablePaths?: readonly string[];
  /**
   * User-configured extra read-only paths. Appended to the profile's
   * baseline readOnlyPaths. Optional. ONLY honored by
   * `desktopPermissive` — the server + locked profiles throw if
   * this field is non-empty, because those profiles are workspace-
   * only by contract and silent ignore would be a foot-gun.
   */
  readonly extraReadOnlyPaths?: readonly string[];
  /**
   * User-configured env-var names to forward. Appended to profile's
   * baseline passthroughEnv. Optional.
   */
  readonly extraPassthroughEnv?: readonly string[];
}

/**
 * The profile helper's return value. `spec` is ready to pass to
 * `Sandbox.create()` (the builder detects backend at creation time;
 * profile doesn't need to name one). `defaultSecurityLevel` is the
 * policy-resolver default for this mode, overridable by the server's
 * `config.toml [security].security_level`.
 */
export interface SandboxProfileSpec {
  readonly spec: Omit<SandboxCreateOptions, "backend">;
  readonly defaultSecurityLevel: SecurityLevel;
  /**
   * The name of the deployment mode this spec was built for, for
   * logs + audit entries. Server Policy Resolver typically echoes
   * this into the per-turn envelope so the relay log can show
   * which mode shaped the dispatch.
   */
  readonly mode: "server" | "desktop-permissive" | "desktop-locked";
}

// ---------------------------------------------------------------------------
// Server mode — workspace-only containment, paranoid default
// ---------------------------------------------------------------------------

/**
 * Server mode — nothing outside the artifacts dir is exposed. No
 * user-home paths, no Downloads, no read-only surface beyond the
 * hardcoded base system paths bubblewrap/Seatbelt always mount.
 *
 * Use case: OSS headless deployments, cloud tenants, CI agents,
 * multi-user servers where the "user home" concept doesn't make
 * sense or would leak between users. The agent writes everything
 * it produces into `artifactsDir` and reads only from there + the
 * base system paths needed to run tools.
 *
 * Default level: `paranoid` — fail-loud if the kernel backend isn't
 * available. If a server-mode install lacks bubblewrap, it refuses
 * to start with an instructive error rather than silently running
 * unsandboxed.
 */
export function serverRestrictive(
  inputs: DeploymentProfileInputs,
): SandboxProfileSpec {
  if (inputs.artifactsDir === undefined || inputs.artifactsDir.length === 0) {
    throw new Error(
      "[sandbox/profiles] serverRestrictive requires inputs.artifactsDir. " +
        "Set it to the server's configured artifacts directory (e.g. " +
        "/var/nautilo/artifacts) before invoking this helper.",
    );
  }
  // Loud throw — server mode is workspace-only by contract. Silently
  // honoring extraReadOnlyPaths here would surprise operators who
  // assume "unsupported field = rejected", which is the principle
  // the ship plan enforces elsewhere (G5.6). If they really want
  // extra RO surface on a headless deployment they should build a
  // custom SandboxConfig, not reach for this helper.
  if (
    inputs.extraReadOnlyPaths !== undefined &&
    inputs.extraReadOnlyPaths.length > 0
  ) {
    throw new Error(
      "[sandbox/profiles] serverRestrictive does not honor extraReadOnlyPaths. " +
        "Server mode is workspace-only by contract. If you need extra " +
        "read-only surface on a desktop install, use desktopPermissive " +
        "instead; for custom server shapes, build a SandboxConfig directly.",
    );
  }

  const config: SandboxConfig = {
    mode: ENABLED,
    writablePaths: [...(inputs.extraWritablePaths ?? [])],
    projectPaths: [],
    passthroughEnv: [...(inputs.extraPassthroughEnv ?? [])],
  };

  return {
    spec: {
      config,
      workspace: inputs.artifactsDir,
      dataDir: inputs.dataDir,
      toolsBin: inputs.toolsBin,
      failIfNoBackend: true, // paranoid default.
    },
    defaultSecurityLevel: "paranoid",
    mode: "server",
  };
}

// ---------------------------------------------------------------------------
// Desktop-permissive mode — broad RO home + narrow RW project/Downloads
// ---------------------------------------------------------------------------

/**
 * Desktop-permissive mode — the Agent can READ any file the user
 * points her at (from her own home directory), but can only WRITE
 * to the active project + Downloads. The default single-user
 * Electron experience.
 *
 * The read/write asymmetry is the whole point: a curious user
 * says "read ~/Documents/notes.md and summarize" and the Agent does
 * it. A confused (or prompt-injected) Agent tries
 * "rm -rf ~/Documents" and the kernel sandbox blocks the write
 * at L5. L4 approval dialogs still fire for destructive operations
 * inside writable paths.
 *
 * Default level: `cautious` — approvals prompt for destructive
 * operations; containment is active in workspace-containment mode;
 * paranoid fail-loud NOT set (missing bwrap = WARN + passthrough,
 * not refuse-to-start).
 */
export function desktopPermissive(
  inputs: DeploymentProfileInputs,
): SandboxProfileSpec {
  if (inputs.userHome === undefined || inputs.userHome.length === 0) {
    throw new Error(
      "[sandbox/profiles] desktopPermissive requires inputs.userHome. " +
        "Typically os.homedir(); without it the readOnly-home shape " +
        "has nothing to allow.",
    );
  }
  if (
    inputs.currentProject === undefined ||
    inputs.currentProject.length === 0
  ) {
    throw new Error(
      "[sandbox/profiles] desktopPermissive requires inputs.currentProject. " +
        "The project directory is the agent's writable workspace.",
    );
  }

  const writable: string[] = [];
  if (inputs.downloads !== undefined && inputs.downloads.length > 0) {
    writable.push(inputs.downloads);
  }
  writable.push(...(inputs.extraWritablePaths ?? []));

  const readOnly: string[] = [inputs.userHome];
  readOnly.push(...(inputs.extraReadOnlyPaths ?? []));

  const config: SandboxConfig = {
    mode: ENABLED,
    writablePaths: writable,
    projectPaths: [],
    readOnlyPaths: readOnly,
    passthroughEnv: [...(inputs.extraPassthroughEnv ?? [])],
  };

  return {
    spec: {
      config,
      workspace: inputs.currentProject,
      dataDir: inputs.dataDir,
      toolsBin: inputs.toolsBin,
      failIfNoBackend: false, // cautious default — WARN + passthrough on missing backend.
    },
    defaultSecurityLevel: "cautious",
    mode: "desktop-permissive",
  };
}

// ---------------------------------------------------------------------------
// Desktop-locked mode — workspace-only on desktop, paranoid default
// ---------------------------------------------------------------------------

/**
 * Desktop-locked mode — like server mode but on a user's desktop.
 * Workspace-only; no user-home exposure, no Downloads. Use case:
 * power users who want strict containment, regulated orgs, dev-in-
 * prod boxes where the user accepts "the Agent can't touch anything
 * outside my current project" as the tradeoff for paranoid-grade
 * defense.
 *
 * Default level: `paranoid` — fail-loud if backend unavailable,
 * same as server mode.
 */
export function desktopLocked(
  inputs: DeploymentProfileInputs,
): SandboxProfileSpec {
  if (
    inputs.currentProject === undefined ||
    inputs.currentProject.length === 0
  ) {
    throw new Error(
      "[sandbox/profiles] desktopLocked requires inputs.currentProject. " +
        "Without it there's no workspace to contain the agent within.",
    );
  }
  // Loud throw on fields that only make sense in desktop-permissive.
  // A user who picks "locked" and passes downloads / extraReadOnlyPaths
  // probably meant desktop-permissive — silently eating those inputs
  // would leave them with containment they didn't want.
  if (
    inputs.extraReadOnlyPaths !== undefined &&
    inputs.extraReadOnlyPaths.length > 0
  ) {
    throw new Error(
      "[sandbox/profiles] desktopLocked does not honor extraReadOnlyPaths. " +
        "Desktop-locked is workspace-only. If you want a broad read-only " +
        "home surface, use desktopPermissive instead.",
    );
  }
  if (inputs.downloads !== undefined && inputs.downloads.length > 0) {
    throw new Error(
      "[sandbox/profiles] desktopLocked does not honor inputs.downloads. " +
        "Desktop-locked contains the agent to the workspace; Downloads " +
        "access is a desktop-permissive behavior. Use desktopPermissive " +
        "if you want the Agent to write to ~/Downloads.",
    );
  }

  const config: SandboxConfig = {
    mode: ENABLED,
    writablePaths: [...(inputs.extraWritablePaths ?? [])],
    projectPaths: [],
    passthroughEnv: [...(inputs.extraPassthroughEnv ?? [])],
  };

  return {
    spec: {
      config,
      workspace: inputs.currentProject,
      dataDir: inputs.dataDir,
      toolsBin: inputs.toolsBin,
      failIfNoBackend: true, // paranoid default.
    },
    defaultSecurityLevel: "paranoid",
    mode: "desktop-locked",
  };
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

// `"enabled"` is the `SandboxMode` value for active containment. We
// spell it as a const here so a compile-time check catches any drift
// if the SandboxMode union is ever widened with a new variant — the
// compiler forces every profile to acknowledge the new option.
const ENABLED: SandboxMode = "enabled";
