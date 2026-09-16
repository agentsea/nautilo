/**
 * Core types for `@nautilo/sandbox`. D060 Phase 1.
 *
 * Ported (with TS adaptations) from Spacebot's Rust implementation —
 * see `EXTERNAL/spacebot/src/sandbox.rs` for upstream provenance and
 * `packages/sandbox/README.md` for the supported execution boundaries.
 *
 * Load-bearing constraints:
 *   - JavaScript is single-threaded, so Spacebot's `Arc<ArcSwap<Config>>`
 *     collapses to a plain class field. Re-read on each `wrap()` call
 *     is safe without locks.
 *   - Runtime `SandboxBackend.kind` is detected ONCE at `Sandbox.create()`
 *     and cached; the enum is a discriminated union, not a runtime
 *     value that can change across invocations.
 */

import type { NetworkPolicy } from "./network/policy";

/**
 * Whether OS-level containment is active. `"disabled"` means
 * subprocesses run unwrapped (but with env taxonomy still enforced).
 * `"enabled"` means the detected backend wraps the spawn.
 *
 * Port: Spacebot `src/sandbox.rs:57-65` (`SandboxMode`).
 */
export type SandboxMode = "enabled" | "disabled";

/**
 * Runtime-detected backend. `procSupported` on bubblewrap matters in
 * nested-Docker environments where `/proc` isn't mountable — callers
 * must skip the `--proc /proc` arg when false.
 *
 * Port: Spacebot `src/sandbox.rs:68-76` (`SandboxBackend`).
 */
export type SandboxBackend =
  | {
      readonly kind: "bubblewrap";
      readonly procSupported: boolean;
      /**
       * True only after the detector proves bwrap can late-overmount a
       * regular file with --ro-bind. Guarded profiles with protected files
       * refuse when false; a directory-only --tmpfs mask is not enough.
       */
      readonly fileMaskSupported?: boolean;
    }
  | { readonly kind: "sandbox-exec" }
  | { readonly kind: "none" };

/**
 * Sandbox configuration. Captures both user-provided settings
 * (`mode`, `writablePaths`, `passthroughEnv`) and runtime-injected
 * data (`projectPaths` via `refreshProjectPaths`).
 *
 * Port: Spacebot `src/sandbox.rs:17-33` (`SandboxConfig`).
 *
 * `writablePaths` are user-configured writable directories beyond the
 * workspace root. `projectPaths` are auto-injected by the agent when
 * the user switches workspace (D057's workspace-change flow). They
 * combine via `allWritablePaths()` — callers never reach into either
 * field directly.
 */
export interface SandboxConfig {
  readonly mode: SandboxMode;
  /**
   * User-configured writable paths BEYOND the workspace root. The
   * workspace root itself is always writable when mode is "enabled".
   */
  readonly writablePaths: readonly string[];
  /**
   * Auto-injected project-scoped writable paths. Refreshed at runtime
   * by `Sandbox.refreshProjectPaths(paths)`. Kept separate from
   * `writablePaths` so user + auto-injection can be audited
   * independently in logs.
   */
  readonly projectPaths: readonly string[];
  /**
   * Read-only bind mounts beyond the base system paths. Enables the
   * broad-read / narrow-write deployment shape — e.g.
   * `desktop-permissive` maps `readOnlyPaths: ["/Users/example"]` +
   * `writablePaths: ["/Users/example/Downloads"]` so the agent can *read*
   * any user file it's pointed at but can only *write* to the
   * project + Downloads. Optional — absence means workspace +
   * writablePaths + projectPaths are the only extra surface beyond
   * the hardcoded base system paths.
   *
   * dataDir deny still masks the agent's secret store even if it
   * happens to sit under a readOnlyPaths entry — the deny rule is
   * emitted last so it wins (bubblewrap: last bind wins; Seatbelt:
   * later-wins).
   *
   * Ship plan v3 §5.1 (security-ship-plan-2026-04.md).
   * Introduced in D060 Sprint 1 G5.1.
   */
  readonly readOnlyPaths?: readonly string[];
  /**
   * D418 task 3.2.1 — canonical protected-path subtrees the sandbox
   * must DENY (read + write) AFTER every allow rule. Compiled from the
   * live `@nautilo/security::ProtectedPathPolicy` by the relay (the
   * unit that owns the canonical descriptor set) and threaded through
   * the per-turn envelope; the sandbox builders emit these as
   * deny-overrides so a protected subtree stays unreadable + unwritable
   * even when a granted root overlaps or contains it.
   *
   * Optional + additive: absence preserves byte-for-byte prior behavior.
   * The list is host-canonical absolute paths; the builders canonicalize
   * again at emit time and emit both raw + realpath forms on macOS (the
   * `/var` → `/private/var` quirk). Unlike `readOnlyPaths` / `writablePaths`,
   * denies are emitted even when the path does not yet exist on disk — a
   * protected subtree must remain protected the moment it is created.
   */
  readonly protectedPaths?: readonly string[];
  /**
   * Trusted, local, zero-byte regular file used only by bubblewrap to
   * overmount a protected FILE with `--ro-bind`. The relay creates this
   * inside its per-dispatch guarded scratch directory; it is never server
   * authority and must not be sourced from the wire envelope.
   */
  readonly protectedFileMaskPath?: string;
  /**
   * Names of env vars to forward from the parent process to the
   * sandboxed child. Escape hatch for users whose dev setup relies on
   * env-var-based config. RESERVED and DANGEROUS names are silently
   * skipped even if listed here — the taxonomy has the final say.
   *
   * Port: Spacebot `src/sandbox.rs:23-28`.
   */
  readonly passthroughEnv: readonly string[];
  /**
   * D103 network egress policy. Optional during the transition so all
   * existing filesystem/process sandbox profiles stay wire-compatible.
   *
   * IMPORTANT: this field is policy data only until platform-specific
   * enforcement phases land. A `proxy-allowlist` policy is not a
   * security boundary unless the OS sandbox forces traffic through the
   * local proxy (macOS Seatbelt / Linux network namespace work).
   */
  readonly networkPolicy?: NetworkPolicy;
}

/**
 * Default config with the mode explicitly set. Matches Spacebot's
 * `SandboxConfig::default()` behavior (mode=enabled, empty arrays).
 * Consumers should build their own config; this exists for tests +
 * the `paranoid` fail-loudly path where we want a predictable
 * starting point to override.
 */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  mode: "enabled",
  writablePaths: [],
  projectPaths: [],
  passthroughEnv: [],
} as const;

/**
 * The shape `Sandbox.wrap()` returns: a ready-to-spawn command.
 * Callers pass this to `child_process.spawn()` / `Bun.spawn()` / etc.
 *
 * `env: null` means "inherit the parent's env" and should be rare.
 * `env: Record<string, string>` means "use exactly this env map, no
 * inheritance" — used by bwrap, sandbox-exec, and passthrough paths.
 */
export interface SpawnArgs {
  readonly program: string;
  readonly args: readonly string[];
  /**
   * When `null`, inherit parent's env. When a record, spawn with
   * EXACTLY this env and no inheritance.
   */
  readonly env: Record<string, string> | null;
  readonly cwd: string;
}
