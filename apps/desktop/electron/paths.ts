/**
 * Centralized filesystem path resolution for the Electron main process.
 *
 * Before this module:
 *   Path constants were scattered across main.ts, config.ts,
 *   default-genie-workspace.ts, and recent-current-folders.ts. Same
 *   `~/.nautilo/` prefix computed in 3 different files; same
 *   `app.getPath("userData")` joined with different basenames in 4
 *   different files. Adding / renaming / moving a file required
 *   hunting through the tree.
 *
 * After:
 *   One module owns every path the Electron shell reads or writes.
 *   Callers import named shorthand getters (currentFolderFilePath,
 *   configFilePath, genieWorkspaceStateFilePath, ...) — one per
 *   known file. Adding a new stored file = add a basename const +
 *   a shorthand getter. Moving a file = update one line.
 *
 * Three path families (Stack 19 Phase 4 added family C):
 *
 *   A. Electron-managed (`app.getPath("userData")`) — per-app,
 *      reset-on-uninstall. Holds installation-specific state
 *      (window geometry, first-run choice, per-app config).
 *      As of Stack 19, the userData tree is segregated per
 *      `(instance, profile)` tuple via the formula in
 *      `./user-data-dir-name.ts`, applied by main.ts at boot.
 *      LAZY getters: app.getPath() can't be called before
 *      `app.whenReady`, so these wrap in functions. Callers
 *      inside `boot()` or IPC handlers are safe.
 *
 *   B. Instance-scoped user-home (`~/.nautilo${suffix}/`) — cross-process
 *      per-instance state shared between desktop, CLI, and server.
 *      `${suffix}` is empty for the default instance and `-${id}` for
 *      named instances. Resolved via `resolveNautiloRootDir()` from
 *      `@nautilo/config`, which reads `NAUTILO_INSTANCE_ID` from env.
 *      Holds: instance.env, instance.json, server.pid, logs/, etc.
 *
 *   C. Operator-shared user-home (`~/.nautilo/`) — DELIBERATE
 *      per-file carve-out for operator-identity state that belongs to
 *      the human, not to any specific instance/server. As of Stack 19
 *      Phase 4 (D156 Architecture amendment 2026-05-16), operator-
 *      identity files live here regardless of `NAUTILO_INSTANCE_ID`:
 *        - recent-current-folders.json — filesystem-navigation memory.
 *          The folders an operator opened are still the same folders
 *          when they switch which server they target.
 *        - recent-servers.json — server-pairing memory for the switch-
 *          server picker (M123 / Stack 39 Phase 3C).
 *        - state/genie-workspace.json — pointer to the operator's local
 *          AI-output dir (default `~/Documents/Nautilo`). Per-instance
 *          scoping would mean Genie writes generated files to different
 *          directories depending on which server is being pointed at —
 *          that's a real bug, not a feature.
 *        - relay-id — historical read-only migration source for the default
 *          tuple. New relay identity is always written under Family A.
 *      Adding any NEW persistence file defaults to family B (instance-
 *      scoped). Family-C inclusion requires an explicit per-getter
 *      decision documented at the getter itself.
 *
 * Design choice — basename constants + directory paths are kept
 * module-internal (not exported) to satisfy knip's unused-export
 * check. Only the concrete getter functions + the default-workspace
 * root (which IS consumed by default-genie-workspace) are exported.
 * If a second consumer of a basename or dir path arrives later,
 * promote to export at that point.
 *
 * Callers: every existing reader/writer in the Electron main
 * process. NOT consumed from the renderer — those go through
 * `nautiloDesktop.*` APIs in preload.ts.
 */

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { app } from "electron";

// ===========================================================================
// File basenames (module-internal — promote to export when consumed elsewhere)
// ===========================================================================

/** Renamed by D079 Phase 1 from workspace.json. */
const CURRENT_FOLDER_FILE_NAME = "current-folder.json";
/** Pre-D079-Phase-1 name; kept for one-shot migration. */
const LEGACY_WORKSPACE_FILE_NAME = "workspace.json";
/** Window geometry persistence. */
const WINDOW_STATE_FILE_NAME = "window-state.json";
/** First-run deployment-mode choice + connect-mode server URL. */
const CONFIG_FILE_NAME = "config.json";
/** D514 — resumable, non-secret candidate connection journal. */
const PENDING_CONNECTION_FILE_NAME = "pending-connection.json";
/** D079 Phase 3 persisted workspace root pointer. */
const GENIE_WORKSPACE_STATE_FILE_NAME = "genie-workspace.json";
/** D079 Phase 1 renamed from recent-workspaces.json. */
const RECENT_FOLDERS_FILE_NAME = "recent-current-folders.json";
/** Pre-D079-Phase-1 recent folders name; kept for one-shot migration. */
const LEGACY_RECENT_FOLDERS_FILE_NAME = "recent-workspaces.json";
/** M123 / Stack 39 — recently paired Nautilo server URLs. */
const RECENT_SERVERS_FILE_NAME = "recent-servers.json";
/** D336 — active SaaS browser view CDP state for the agent-browser provider plugin. */
const BROWSER_CONTROL_STATE_FILE_NAME = "browser-control-state.json";
/** D336 — generated agent-browser plugin config pointing at the Nautilo provider. */
const BROWSER_CONTROL_AGENT_BROWSER_CONFIG_FILE_NAME = "agent-browser-provider.json";
/** D345 — configured local tool runtime paths + last health. */
const TOOL_RUNTIME_CONFIG_FILE_NAME = "tool-runtimes.json";
/** M206 — bounded local relay revision journal root directory basename. */
const LOCAL_FILE_HISTORY_DIR_NAME = "local-file-history";
const MINI_APP_DRAFT_RECOVERY_DIR_NAME = "mini-app-draft-recovery";
/** D418 — instance/profile-scoped Desktop Filesystem Grant authority. */
const DESKTOP_FILESYSTEM_GRANTS_FILE_NAME = "desktop-filesystem-grants.json";
/** Historical D418 persisted filename; read only by the one-time migration. */
const LEGACY_DESKTOP_FILESYSTEM_GRANTS_FILE_NAME = "workstation-grants.json";
/** D486 — exact-folder durable consent for the unsandboxed host-command lane. */
const WORKSTATION_SHELL_CONSENT_FILE_NAME = "workstation-shell-consent.json";
/** D418 — instance/profile-scoped workstation profile admin configuration. */
const WORKSTATION_PROFILES_FILE_NAME = "workstation-profiles.json";
/** D516 — one local Computer use receipt/policy namespace per selected server. */
const COMPUTER_USE_STATE_DIR_NAME = "computer-use";
/** D418 — stable opaque installation UUID; per (instance, profile), NOT a credential. */
const INSTALLATION_ID_FILE_NAME = "installation-id.json";
/** Stable relay UUID; scoped to the same (instance, profile) authority tuple. */
const DESKTOP_RELAY_ID_FILE_NAME = "relay-id";
/** D480 — random operator-owned seed; never exposed outside the main process. */
const PHYSICAL_DEVICE_SEED_FILE_NAME = "physical-device-seed.json";
/** D453 — Electron-owned runtime, profile homes, and non-secret host state. */
const CODEX_HOST_DIR_NAME = "codex";

// ===========================================================================
// Nautilo home directory roots (module-internal)
// ===========================================================================

// Family B (instance-scoped `~/.nautilo${suffix}/`) currently has no
// getters consumed from paths.ts — `token-store-electron.ts` calls
// `resolveNautiloRootDir()` from `@nautilo/config` directly. When the
// first paths.ts consumer of a family-B file arrives (e.g. a future
// desktop-auth.json getter consolidating away from token-store-electron),
// declare `const NAUTILO_HOME_DIR = resolveNautiloRootDir();` here and
// the getter alongside. Until then, importing the helper just for an
// unused-const triggers knip's unused-export check.

/**
 * Family C — operator-shared Nautilo home (`~/.nautilo/`, always).
 *
 * DELIBERATE per-file carve-out: only operator-identity state
 * (filesystem-navigation memory + local AI-output dir pointer) lives
 * here regardless of `NAUTILO_INSTANCE_ID`. See the top-of-file family-C
 * doc for the design rationale (per-instance scoping for these two
 * files would be a real bug, not a feature).
 *
 * DO NOT add new getters that use `NAUTILO_OPERATOR_HOME` without an
 * explicit "why this is operator-scoped, not instance-scoped" comment
 * at the getter AND a corresponding amendment to the family-C list in
 * the top-of-file doc.
 */
const NAUTILO_OPERATOR_HOME = path.join(os.homedir(), ".nautilo");

/**
 * D514 acceptance-only override for Family-C state touched during boot.
 *
 * A desktop smoke run must never read or mutate a real operator's pairing
 * history or workspace. The override is deliberately narrow: it changes only
 * the Family-C files and default Genie workspace reached during a smoke boot,
 * requires the pre-existing hidden-smoke mode, and accepts only a
 * harness-created private directory. It is not a general operator-home
 * relocation mechanism and has no effect in normal launches.
 */
function d514SmokeOperatorRoot(): string | null {
  if (process.env["NAUTILO_SMOKE_HIDDEN"] !== "1") return null;
  const candidate = process.env["NAUTILO_DESKTOP_SMOKE_OPERATOR_ROOT"];
  if (!candidate || !path.isAbsolute(candidate) || candidate.includes("\0")) {
    return null;
  }
  // The D514 harness creates this exact mkdtemp prefix and locks it to 0700.
  // Requiring both properties makes an incidental environment setting inert.
  if (!path.basename(candidate).startsWith("nautilo-d514-smoke-")) return null;
  try {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700) {
      return null;
    }
  } catch {
    return null;
  }
  return candidate;
}

function operatorHomeForCurrentRun(): string {
  return d514SmokeOperatorRoot() ?? NAUTILO_OPERATOR_HOME;
}

function operatorStateDirForCurrentRun(): string {
  return path.join(operatorHomeForCurrentRun(), "state");
}

// ===========================================================================
// Exported getters — one per known file
// ===========================================================================

/** Absolute path to `<userData>/current-folder.json`. */
export function currentFolderFilePath(): string {
  return path.join(app.getPath("userData"), CURRENT_FOLDER_FILE_NAME);
}

/**
 * Absolute path to legacy `<userData>/workspace.json`. Used only
 * by the D079 Phase 1 one-shot migration; can be deleted once the
 * deprecation window closes.
 */
export function legacyWorkspaceFilePath(): string {
  return path.join(app.getPath("userData"), LEGACY_WORKSPACE_FILE_NAME);
}

/** Absolute path to `<userData>/window-state.json`. */
export function windowStateFilePath(): string {
  return path.join(app.getPath("userData"), WINDOW_STATE_FILE_NAME);
}

/** Absolute path to `<userData>/config.json`. */
export function configFilePath(): string {
  return path.join(app.getPath("userData"), CONFIG_FILE_NAME);
}

/**
 * Family A — per `(instance, profile)` Electron userData tree. A D514
 * connection candidate is intentionally private to the exact tuple that
 * started it: it is never an operator-shared pairing preference.
 */
export function pendingConnectionFilePath(): string {
  return path.join(app.getPath("userData"), PENDING_CONNECTION_FILE_NAME);
}

/** Absolute path to `<userData>/browser-control-state.json`. */
export function browserControlStateFilePath(): string {
  return path.join(app.getPath("userData"), BROWSER_CONTROL_STATE_FILE_NAME);
}

/** Absolute path to `<userData>/agent-browser-provider.json`. */
export function browserControlAgentBrowserConfigPath(): string {
  return path.join(app.getPath("userData"), BROWSER_CONTROL_AGENT_BROWSER_CONFIG_FILE_NAME);
}

/** Absolute path to `<userData>/tool-runtimes.json`. */
export function toolRuntimeConfigFilePath(): string {
  return path.join(app.getPath("userData"), TOOL_RUNTIME_CONFIG_FILE_NAME);
}

/**
 * Family A — per `(instance, profile)` Electron userData tree.
 * Bounded plaintext local revision journal for relay-local file mutations.
 * History does not cross desktop instances or profiles.
 */
export function localFileHistoryDirPath(): string {
  return path.join(app.getPath("userData"), LOCAL_FILE_HISTORY_DIR_NAME);
}

/** Family A — protected, per-profile recovery for bound mini-app documents. */
export function miniAppDraftRecoveryDirPath(): string {
  return path.join(app.getPath("userData"), MINI_APP_DRAFT_RECOVERY_DIR_NAME);
}

/**
 * Family A — per `(instance, profile)` Electron userData tree.
 * Desktop Filesystem Grants are device-local authority and must never cross an
 * instance or profile boundary.
 */
export function desktopFilesystemGrantsFilePath(): string {
  return path.join(app.getPath("userData"), DESKTOP_FILESYSTEM_GRANTS_FILE_NAME);
}

/**
 * Historical persistence path used only to import existing grants into the
 * Desktop Filesystem Grant store. No production write path targets this name.
 */
export function legacyDesktopFilesystemGrantsFilePath(): string {
  return path.join(app.getPath("userData"), LEGACY_DESKTOP_FILESYSTEM_GRANTS_FILE_NAME);
}

/**
 * Family A — per `(instance, profile)` Electron userData tree.
 * Durable host-command consent is machine-local authority for one exact
 * instance/profile and must never follow the operator to another target.
 */
export function workstationShellConsentFilePath(): string {
  return path.join(app.getPath("userData"), WORKSTATION_SHELL_CONSENT_FILE_NAME);
}

/**
 * Family A — per `(instance, profile)` Electron userData tree.
 * Workstation profiles are admin configuration bound to the same instance
 * identity as the grants store; they must never cross an instance or
 * profile boundary. Family A (not the operator-shared family C) because a
 * profile's compiled authority is device-local and per-instance.
 */
export function workstationProfilesFilePath(): string {
  return path.join(app.getPath("userData"), WORKSTATION_PROFILES_FILE_NAME);
}

/**
 * Family A — a Computer use receipt is local to this Desktop profile and one
 * canonical server binding.  The binding is Electron-derived, never supplied
 * by a renderer or written by a remote server.
 */
export function computerUseStateFilePath(serverBindingId: string): string {
  if (!/^computer-use-server-binding-[A-Za-z0-9_-]{16,128}$/.test(serverBindingId)) {
    throw new Error("invalid Computer use server binding path");
  }
  return path.join(app.getPath("userData"), COMPUTER_USE_STATE_DIR_NAME, `${serverBindingId}.json`);
}

/**
 * Family A — per `(instance, profile)` Electron userData tree. D418 stable
 * desktop pairing identity: one opaque UUID per install that survives
 * sign-out / token clearing / re-pair. NOT a credential — never used for
 * auth, only to correlate pair requests from the same physical install
 * across token rotations. Read/written by `auth/relay-pair.ts`
 * (`getOrCreateInstallationId`), which consumes this getter via
 * `relay-pair-electron.ts` so the basename has ONE source of truth here.
 * Preserved by `dev:nuke-client-cache` (only `relay-token-*.json` are
 * wiped; the relay-token discovery regex does not match this filename).
 */
export function installationIdFilePath(): string {
  return path.join(app.getPath("userData"), INSTALLATION_ID_FILE_NAME);
}

/**
 * Family A — stable relay identity for this exact `(instance, profile)`
 * Desktop tuple. Sharing it between profiles lets one connected relay
 * supersede another and invalidates plan-bound workstation admission.
 */
export function desktopRelayIdentityFilePath(): string {
  return path.join(app.getPath("userData"), DESKTOP_RELAY_ID_FILE_NAME);
}

/**
 * Historical machine-wide relay identity. This is a read-only migration
 * source for the default Desktop tuple; named tuples must mint their own id.
 */
export function legacySharedRelayIdentityFilePath(): string {
  return path.join(operatorHomeForCurrentRun(), DESKTOP_RELAY_ID_FILE_NAME);
}

/**
 * Family C — operator-shared physical-device grouping seed. This is deliberately
 * outside tuple-scoped Electron `userData`: one OS operator's isolated desktop
 * tuples need the same random seed, while the derived value remains scoped to a
 * trusted server fingerprint. It is not a credential or authority input.
 */
export function physicalDeviceSeedFilePath(): string {
  return path.join(operatorStateDirForCurrentRun(), PHYSICAL_DEVICE_SEED_FILE_NAME);
}

/**
 * Family A — the Codex host root belongs to this Electron installation and
 * profile. Runtime files, profile-private CODEX_HOME directories, and host
 * state are siblings below this root; no cleanup path may traverse between
 * those subtrees.
 */
export function codexHostDirPath(): string {
  return path.join(app.getPath("userData"), CODEX_HOST_DIR_NAME);
}

/** D453 — verified managed runtime root, disjoint from profile homes. */
export function codexRuntimeDirPath(): string {
  return path.join(codexHostDirPath(), "runtime");
}

/** D453 — private per-account CODEX_HOME registry root. */
export function codexProfileHomesDirPath(): string {
  return path.join(codexHostDirPath(), "profile-homes");
}

/** D453 — non-secret host metadata root. */
export function codexHostStateDirPath(): string {
  return path.join(codexHostDirPath(), "state");
}

/**
 * Family C — operator-shared. Filesystem-navigation memory belongs to
 * the human operating the machine, not to any particular server they're
 * pointed at. Recent folders persist across instance switches (matches
 * macOS Finder "Recent" sidebar semantics).
 */
export function recentFoldersFilePath(): string {
  return path.join(operatorHomeForCurrentRun(), RECENT_FOLDERS_FILE_NAME);
}

/**
 * Family C — operator-shared. Legacy migration target paired with
 * `recentFoldersFilePath` above; both live in family C for the same
 * reason.
 */
export function legacyRecentFoldersFilePath(): string {
  return path.join(operatorHomeForCurrentRun(), LEGACY_RECENT_FOLDERS_FILE_NAME);
}

/**
 * Family C — operator-shared. Server-pairing memory belongs to the
 * human operating the machine, not to any particular instance/server
 * they are pointed at. Recent servers persist across instance switches.
 */
export function recentServersFilePath(): string {
  // D514 smoke isolation covers Family-C boot state only.
  return path.join(
    operatorHomeForCurrentRun(),
    RECENT_SERVERS_FILE_NAME,
  );
}

/**
 * Family C — operator-shared. Pointer to the operator's local AI-output
 * directory (default `~/Documents/Nautilo`). Same human, same machine,
 * same Documents folder regardless of which Nautilo server they're
 * targeting; per-instance scoping would mean Genie writes generated
 * files to different directories depending on server URL — wrong behavior.
 */
export function genieWorkspaceStateFilePath(): string {
  return path.join(operatorStateDirForCurrentRun(), GENIE_WORKSPACE_STATE_FILE_NAME);
}

// ===========================================================================
// Workspace defaults
// ===========================================================================

/**
 * Default Genie's Workspace root — Finder-visible location. Surface
 * A per D079. Created on first boot with starter subdirs (see
 * STARTER_WORKSPACE_SUBDIRS in constants.ts).
 */
export const DEFAULT_GENIE_WORKSPACE_ROOT = path.join(
  d514SmokeOperatorRoot() ?? path.join(os.homedir(), "Documents", "Nautilo"),
  ...(d514SmokeOperatorRoot() ? ["genie-workspace"] : []),
);
