/**
 * The `Sandbox` class. D060 Phase 1 task 1.4.
 *
 * Single instance per agent process, shared via DI. `wrap()` dispatches
 * on the detected backend without re-probing. Config can be swapped at
 * runtime via `setConfig()` — JS is single-threaded so the field
 * reassignment is atomic.
 *
 * Port: Spacebot `src/sandbox.rs:156-394` (`Sandbox` struct + impl).
 *
 * Phase 1 scope for this file:
 *   - class shape + constructor
 *   - static async `create()` factory
 *   - config getters/setters + project-path refresh
 *   - `containmentActive()`
 *   - `isPathAllowed()` (canonical-path containment check)
 *   - `promptReadAllowlist()` / `promptWriteAllowlist()` for UI
 *   - `wrap()` STUB that throws "not implemented yet"
 *
 * 1.5 fills in bubblewrap `wrap()`; 1.6 wires macOS stub + passthrough.
 */

import { log, warn } from "@nautilo/logger";

import { buildBubblewrap } from "./bubblewrap";
import { canonicalize, pushUniquePath } from "./paths";
import { buildPassthrough } from "./passthrough";
import { buildSandboxExec } from "./seatbelt";
import {
  startNetworkProxy,
  type NetworkProxyDecisionEvent,
  type NetworkProxy,
} from "./network/proxy";
import type { DeniedNetworkDestination } from "./network/policy";
import {
  LINUX_READ_ONLY_SYSTEM_PATHS,
  MACOS_READ_ONLY_SYSTEM_PATHS,
} from "./system-paths";
import type {
  SandboxBackend,
  SandboxConfig,
  SandboxMode,
  SpawnArgs,
} from "./types";
import { detectBackend } from "./detect";

/**
 * Constructor options. Separated from `SandboxConfig` so the ambient
 * identity of the sandbox (workspace root, data dir, tools dir) is
 * distinct from the config that changes over time (mode + paths).
 */
export interface SandboxCreateOptions {
  readonly config: SandboxConfig;
  /**
   * Trusted local authority for the selected Developer Workstation repository.
   * This is runtime provenance, not policy-envelope data: a server/model
   * supplied sandbox config cannot enable it.
   */
  readonly allowWorkspaceGovernanceWrites?: boolean;
  /**
   * The active workspace root — the directory the user considers
   * "their drawer". Always writable when mode=enabled.
   */
  readonly workspace: string;
  /**
   * Agent data directory (typically `~/.nautilo/` or similar). Masked
   * with `--tmpfs` on Linux to prevent secret store leaks even when
   * it overlaps with workspace-related paths.
   */
  readonly dataDir: string;
  /**
   * Path to the per-install tools binary directory (bun, etc.). Used
   * as the PATH prepend so sandboxed subprocesses see layer-provided
   * tools without relying on host PATH.
   */
  readonly toolsBin: string;
  /**
   * Pre-detected backend. Test harnesses pass a canned value here;
   * `Sandbox.create()` factory below runs `detectBackend()` for the
   * ambient-production path.
   */
  readonly backend: SandboxBackend;
  /**
   * When true, `Sandbox.create()` throws if the detected backend is
   * `none` (rather than returning a Sandbox that would passthrough
   * everything). Set this to the `failIfNoBackend` field of the
   * sandbox policy returned by `sandboxPolicyForLevel(level)` —
   * today only `paranoid` level sets this true.
   *
   * The factory (`create()`) respects the flag; the direct
   * constructor (`new Sandbox(...)`) does NOT — tests wanting to
   * exercise the fail-loud path go through `create()`.
   */
  readonly failIfNoBackend?: boolean;
  readonly networkProxy?: NetworkProxy | undefined;
  readonly networkDeniedDestinations?: DeniedNetworkDestination[] | undefined;
}

export class Sandbox {
  private readonly workspace: string;
  private readonly dataDir: string;
  private readonly toolsBin: string;
  private readonly backend: SandboxBackend;
  private readonly networkProxy: NetworkProxy | undefined;
  private readonly networkDeniedDestinations: DeniedNetworkDestination[];
  private readonly allowWorkspaceGovernanceWrites: boolean;
  private config: SandboxConfig;

  constructor(opts: SandboxCreateOptions) {
    this.workspace = canonicalize(opts.workspace);
    this.dataDir = canonicalize(opts.dataDir);
    this.toolsBin = canonicalize(opts.toolsBin);
    this.backend = opts.backend;
    this.networkProxy = opts.networkProxy;
    this.networkDeniedDestinations = opts.networkDeniedDestinations ?? [];
    this.allowWorkspaceGovernanceWrites =
      opts.allowWorkspaceGovernanceWrites === true;
    this.config = opts.config;
  }

  /**
   * Factory that detects the backend by probing the host. Most
   * consumers use this — direct `new Sandbox()` is for tests that
   * want to inject a specific backend.
   *
   * Behaviors:
   *   - Logs INFO with the detected backend + mode.
   *   - WARN if mode=enabled but backend=none (operator expected
   *     containment, isn't getting any).
   *   - THROWS with an instructive message if `failIfNoBackend` is
   *     true AND backend=none. Today only `paranoid` level sets the
   *     flag true via `sandboxPolicyForLevel('paranoid')`. The
   *     exception message includes install instructions +
   *     level-lowering guidance so the operator has a clear fix
   *     path.
   */
  static async create(
    opts: Omit<SandboxCreateOptions, "backend"> & {
      /**
       * Override the detected backend. Tests use this to exercise
       * each branch without relying on the host's actual binaries.
       * Production callers omit this and let `detectBackend()` probe.
       */
      readonly detectBackendOverride?: () => Promise<SandboxBackend>;
    },
  ): Promise<Sandbox> {
    const detector = opts.detectBackendOverride ?? detectBackend;
    const backend = await detector();
    if (backend.kind === "none") {
      const networkPolicyRequiresBackend =
        opts.config.networkPolicy !== undefined &&
        opts.config.networkPolicy.mode !== "host";
      if (opts.failIfNoBackend === true || networkPolicyRequiresBackend) {
        throw new Error(
          "[sandbox] security policy requires a sandbox backend " +
            "(paranoid level or non-host network policy), " +
            "but neither bwrap (Linux) nor sandbox-exec (macOS) was detected. " +
            "Install bubblewrap (`apt install bubblewrap` / `nix-env -iA nixpkgs.bubblewrap`), " +
            "or have the server owner lower security_level to `cautious` via the " +
            "Settings UI (requires `manage_server_security` Capability).",
        );
      }
      if (opts.config.mode === "enabled") {
        warn(
          "[sandbox] mode=enabled but no backend available — subprocesses will run unsandboxed. " +
            "Install bubblewrap (Linux) or expect sandbox-exec on macOS. " +
            "If this is a `paranoid` deployment, set failIfNoBackend=true to fail-loud instead.",
        );
      }
    }
    const networkDeniedDestinations: DeniedNetworkDestination[] = [];
    const networkProxy =
      backend.kind === "sandbox-exec" &&
      opts.config.networkPolicy?.mode === "proxy-allowlist"
        ? await startNetworkProxy({
            policy: opts.config.networkPolicy,
            onDecision: (event: NetworkProxyDecisionEvent) => {
              if (event.deniedDestination !== undefined) {
                networkDeniedDestinations.push(event.deniedDestination);
              }
            },
          })
        : undefined;
    log(`[sandbox] backend=${describeBackend(backend)} mode=${opts.config.mode}`);
    return new Sandbox({ ...opts, backend, networkProxy, networkDeniedDestinations });
  }

  // ---------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------

  getConfig(): SandboxConfig {
    return this.config;
  }

  /**
   * Replace the config atomically. JS is single-threaded; a field
   * reassignment is as atomic as `ArcSwap` gets. Next `wrap()` call
   * reads the new value.
   *
   * PR-014 MAJOR #4 — resets `dispatchLogged` so the next `wrap()`
   * emits a fresh `[sandbox] dispatch=…` log line reflecting the new
   * config. Without the reset, a boot-time `mode=disabled` log
   * persists forever after an operator rotates to `mode=enabled`,
   * making "why is my shell still unsandboxed?" diagnosis harder
   * than it needs to be.
   */
  setConfig(next: SandboxConfig): void {
    this.config = next;
    this.dispatchLogged = false;
  }

  async close(): Promise<void> {
    await this.networkProxy?.close();
  }

  consumeNetworkDeniedDestinations(): readonly DeniedNetworkDestination[] {
    return this.networkDeniedDestinations.splice(0);
  }

  /**
   * Merge project-scoped writable paths (D057 workspace-switch flow).
   * Does NOT touch `writablePaths` — that's user-configured state
   * which we never synthesize. `projectPaths` is ephemeral; it's
   * re-populated by the agent every time the active workspace
   * changes.
   *
   * Does NOT reset `dispatchLogged` — this path only changes which
   * directories are bind-mounted, not which backend dispatches. A
   * spammy log every workspace switch would drown real diagnostics.
   *
   * Port: Spacebot `src/sandbox.rs:270-276` (`refresh_project_paths`).
   */
  refreshProjectPaths(paths: readonly string[]): void {
    this.config = { ...this.config, projectPaths: paths };
  }

  mode(): SandboxMode {
    return this.config.mode;
  }

  // ---------------------------------------------------------------------
  // Backend inspection
  // ---------------------------------------------------------------------

  /**
   * True when mode is "enabled" AND a real backend is available. If
   * mode is "enabled" but backend is "none", containment is NOT
   * active — subprocesses run unwrapped. Callers should use this to
   * decide whether to emit a security-level WARN in their UI.
   *
   * Port: Spacebot `src/sandbox.rs:305-307`.
   */
  containmentActive(): boolean {
    return this.config.mode === "enabled" && this.backend.kind !== "none";
  }

  /**
   * Whether this backend can safely deny protected regular files. Seatbelt
   * expresses file denies directly; bubblewrap requires the detector-proven
   * late `--ro-bind` file-overmount capability. Guarded planned shells must
   * refuse before spawning when this is false.
   */
  protectedFileMaskSupported(): boolean {
    return (
      this.backend.kind === "sandbox-exec" ||
      (this.backend.kind === "bubblewrap" && this.backend.fileMaskSupported === true)
    );
  }

  /**
   * Opaque backend description for logs + UI. Not the raw kind string
   * because `bubblewrap` wants the `procSupported` bit too.
   */
  describeBackend(): string {
    return describeBackend(this.backend);
  }

  // ---------------------------------------------------------------------
  // Path accessors — read-only so consumers can't mutate the canonical
  // paths after construction. Consumed by `Sandbox.wrap()` in 1.6 (to
  // pass dataDir into the bwrap `--tmpfs` mask + workspace/toolsBin
  // into the builder) and by diagnostics surfaces (logs, "what paths
  // can the sandbox see?" UIs).
  // ---------------------------------------------------------------------

  workspacePath(): string {
    return this.workspace;
  }

  dataDirPath(): string {
    return this.dataDir;
  }

  toolsBinPath(): string {
    return this.toolsBin;
  }

  // ---------------------------------------------------------------------
  // Path predicates
  // ---------------------------------------------------------------------

  /**
   * All writable paths, user-configured + auto-injected. Consumers
   * iterate this for both the bwrap bind list and the Seatbelt
   * file-write* allow list.
   */
  private allWritablePaths(): readonly string[] {
    return [...this.config.writablePaths, ...this.config.projectPaths];
  }

  /**
   * True if `canonical` is under the workspace root OR under any of
   * the configured writable paths. The caller is responsible for
   * passing a canonicalized path — this method does NOT realpath
   * (the file tool's `assertRealpathContained` already did that).
   *
   * Port: Spacebot `src/sandbox.rs:283-299` (`is_path_allowed`).
   */
  isPathAllowed(canonical: string): boolean {
    if (isUnderRoot(canonical, this.workspace)) return true;
    for (const path of this.allWritablePaths()) {
      if (isUnderRoot(canonical, canonicalize(path))) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // Prompt-time allowlist accessors
  // ---------------------------------------------------------------------

  /**
   * Read-allowed paths to display in the UI when explaining what the
   * sandbox can see. Combines system read-only mounts with the
   * workspace + writable paths. Empty when containment inactive.
   *
   * Port: Spacebot `src/sandbox.rs:311-362`.
   */
  promptReadAllowlist(): readonly string[] {
    if (!this.containmentActive()) return [];
    const out: string[] = [];
    const systemPaths =
      this.backend.kind === "bubblewrap"
        ? LINUX_READ_ONLY_SYSTEM_PATHS
        : this.backend.kind === "sandbox-exec"
          ? MACOS_READ_ONLY_SYSTEM_PATHS
          : [];
    for (const sys of systemPaths) {
      pushUniquePath(out, canonicalize(sys));
    }
    pushUniquePath(out, this.toolsBin);
    pushUniquePath(out, this.workspace);
    for (const w of this.allWritablePaths()) {
      pushUniquePath(out, canonicalize(w));
    }
    return out;
  }

  /**
   * Write-allowed paths to display in the UI. Workspace + /tmp +
   * configured writable paths.
   *
   * Port: Spacebot `src/sandbox.rs:366-394`.
   */
  promptWriteAllowlist(): readonly string[] {
    if (!this.containmentActive()) return [];
    const out: string[] = [];
    pushUniquePath(out, this.workspace);
    pushUniquePath(out, canonicalize("/tmp"));
    for (const w of this.allWritablePaths()) {
      pushUniquePath(out, canonicalize(w));
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // wrap() — dispatcher (1.6)
  // ---------------------------------------------------------------------

  /**
   * Return a `SpawnArgs` ready to feed to `child_process.spawn()` /
   * `Bun.spawn()`. Dispatches on config.mode + backend.kind:
   *
   *   mode=disabled            → passthrough (no containment)
   *   backend=none             → passthrough (no backend available)
   *   backend=bubblewrap       → buildBubblewrap()
   *   backend=sandbox-exec     → buildSandboxExec() (throws in Phase 1)
   *
   * First call emits an INFO log with the dispatch target so the
   * operator can confirm what path the sandbox took without reading
   * source. Subsequent calls are silent (no log spam per invocation).
   *
   * Parameters:
   *   program    — executable name or path
   *   args       — argv beyond the program
   *   cwd        — working directory for the subprocess
   *   commandEnv — per-invocation env overrides from the tool caller
   *                (RESERVED skipped, DANGEROUS dropped with WARN)
   */
  wrap(
    program: string,
    args: readonly string[],
    cwd: string,
    commandEnv: Readonly<Record<string, string>>,
  ): SpawnArgs {
    const config = this.config;

    if (config.mode === "disabled") {
      this.logDispatchOnce("passthrough (mode=disabled)");
      return buildPassthrough({
        workspace: this.workspace,
        toolsBin: this.toolsBin,
        config,
        cwd,
        commandEnv,
        program,
        args,
      });
    }

    switch (this.backend.kind) {
      case "bubblewrap": {
        this.logDispatchOnce(
          `bubblewrap (procSupported=${this.backend.procSupported})`,
        );
        return buildBubblewrap({
          workspace: this.workspace,
          dataDir: this.dataDir,
          toolsBin: this.toolsBin,
          procSupported: this.backend.procSupported,
          ...(this.backend.fileMaskSupported !== undefined
            ? { fileMaskSupported: this.backend.fileMaskSupported }
            : {}),
          config,
          cwd,
          commandEnv,
          program,
          args,
        });
      }
      case "sandbox-exec": {
        this.logDispatchOnce("sandbox-exec");
        return buildSandboxExec({
          workspace: this.workspace,
          dataDir: this.dataDir,
          toolsBin: this.toolsBin,
          config,
          cwd,
          commandEnv,
          program,
          args,
          allowWorkspaceGovernanceWrites:
            this.allowWorkspaceGovernanceWrites,
          ...(config.networkPolicy?.mode === "isolated"
            ? { networkAccess: false }
            : {}),
          ...(this.networkProxy !== undefined
            ? {
                networkAccess: false,
                networkProxyUrl: this.networkProxy.url,
                networkProxyPort: this.networkProxy.port,
              }
            : {}),
        });
      }
      case "none": {
        this.logDispatchOnce(
          "passthrough (no backend available; operator should install bubblewrap)",
        );
        return buildPassthrough({
          workspace: this.workspace,
          toolsBin: this.toolsBin,
          config,
          cwd,
          commandEnv,
          program,
          args,
        });
      }
    }
  }

  /**
   * Log the dispatch target on first `wrap()` call per Sandbox
   * instance. Logged at INFO with a stable prefix so grepping logs
   * for `[sandbox] dispatch=` tells you which sandbox path is live
   * without re-reading the boot logs.
   */
  private dispatchLogged = false;
  private logDispatchOnce(target: string): void {
    if (this.dispatchLogged) return;
    this.dispatchLogged = true;
    log(`[sandbox] dispatch=${target} mode=${this.config.mode}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers — module-scope because they don't need `this`
// ---------------------------------------------------------------------------

function describeBackend(backend: SandboxBackend): string {
  switch (backend.kind) {
    case "bubblewrap":
      return `bubblewrap(procSupported=${backend.procSupported})`;
    case "sandbox-exec":
      return "sandbox-exec";
    case "none":
      return "none";
  }
}

/**
 * True if `candidate` is equal to `root` OR starts with `root` + a
 * path separator. Token-boundary check (H-012) — prevents the
 * "/foo" matches "/foobar" class of bug. Callers canonicalize both
 * sides before reaching this helper.
 */
function isUnderRoot(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const sep = root.endsWith("/") ? "" : "/";
  return candidate.startsWith(root + sep);
}
