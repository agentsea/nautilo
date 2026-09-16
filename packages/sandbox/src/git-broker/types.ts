/**
 * D440 Phase 2 — typed Git broker public types.
 *
 * The broker is the locked seam between the agent's `run_shell` /
 * `file` callers and raw Git. A command-string allowlist cannot
 * safely distinguish Git's direct filesystem effects from
 * config-driven hooks, filters, textconv/external diff programs,
 * object alternates, or recursive submodules. A generic
 * operation-aware sandbox also lacks Git's index/ref transaction
 * semantics and cannot decide whether a partially failed mutation
 * is retry-safe. The broker preflights and normalizes the
 * operation, then compiles a per-operation sandbox profile as
 * defense in depth.
 *
 * Load-bearing invariants enforced by this module (see
 * `packages/sandbox/tests/unit/d440-git-operation-contract.test.ts`
 * for the Phase 0 contract):
 *   - canonicalize repository / common-dir / worktree git-dir /
 *     exact target identity before any mutation;
 *   - ignore system/global config and aliases; the broker selects a
 *     fixed executable and a fixed subcommand;
 *   - disable hooks, editor, signing, external diff, textconv, and
 *     clean/smudge/process filters;
 *   - reject alternates, recursive submodules, escaping symlinks,
 *     pathspec magic, live `.env`, ungranted targets, and ambiguous
 *     dirty removal;
 *   - classify `sideEffectStarted` + `retrySafe` for every
 *     disposition;
 *   - clean ONLY broker-created artifacts on known failures and
 *     preserve unknown outcomes (never retry or force-clean).
 *
 * Broad `.git/**`, `.env*`, or raw command-string exemptions are
 * forbidden. The per-operation profile opens the NARROWEST `.git`
 * subtree each operation needs.
 */

/**
 * The bounded operation set the broker owns. Anything outside this
 * set is rejected before any subprocess is spawned.
 */
export type GitOperation =
  | "status"
  | "diff"
  | "add"
  | "commit"
  | "worktree-add"
  | "worktree-remove";

/**
 * Why a disposition was reached. Stable, machine-readable tokens
 * so callers (relay, approval UI) can branch without parsing
 * prose.
 */
export type GitDispositionReason =
  | "ok"
  // Preflight denials — no subprocess was spawned.
  | "deny-ungranted-target"
  | "deny-target-not-empty"
  | "deny-target-symlink"
  | "deny-target-outside-grant"
  | "deny-repo-identity-mismatch"
  | "deny-alternates"
  | "deny-submodules"
  | "deny-escaping-symlink"
  | "deny-pathspec-magic"
  | "deny-pathspec-outside-target"
  | "deny-live-env"
  | "deny-dirty-removal"
  | "deny-unregistered-worktree"
  | "deny-unknown-worktree"
  | "deny-config-unsafe"
  | "deny-alias"
  | "deny-path-not-regular"
  | "deny-add-bounds"
  | "deny-preexisting-staged"
  | "deny-detached-head"
  | "deny-ref-drift"
  | "deny-index-drift"
  | "deny-invalid-message"
  | "deny-no-staged-changes"
  | "deny-no-staging-transaction"
  | "deny-unknown-operation"
  | "deny-platform-unsupported"
  // Execution outcomes.
  | "exec-known-failure"
  | "exec-unknown-outcome"
  | "exec-timeout";

/**
 * The typed disposition every broker call returns. Never throws
 * for in-scope operational failures; only throws for programmer
 * error (bad arguments to the broker itself).
 *
 * `sideEffectStarted` is the security-critical field: true once the
 * broker has reason to believe Git mutated durable state (refs,
 * object DB, registered worktrees, the target working tree). Callers
 * MUST NOT retry when this is true unless `retrySafe` is also true.
 *
 * `retrySafe` is true only when the broker can prove no durable
 * side effect occurred (preflight denial, or a known failure that
 * happened before any mutation). It is NEVER true when the outcome
 * is unknown.
 */
export interface GitBrokerDisposition {
  readonly operation: GitOperation;
  readonly ok: boolean;
  readonly reason: GitDispositionReason;
  readonly sideEffectStarted: boolean;
  readonly retrySafe: boolean;
  /**
   * Human-readable explanation suitable for an operator or an LLM
   * tool result. Not a stable contract — callers branch on
   * `reason`.
   */
  readonly message: string;
  /** Git stdout when an exec ran; undefined otherwise. */
  readonly stdout?: string;
  /**
   * Raw stdout Buffer when an exec ran with binary capture (e.g.
   * `cat-file blob`); undefined otherwise. Used so binary blobs are
   * materialized byte-exact rather than round-tripped through utf8.
   */
  readonly stdoutBinary?: Buffer;
  /** True when binary capture exceeded its budget (memory bounded). */
  readonly stdoutOverflow?: boolean;
  /** Git stderr when an exec ran; undefined otherwise. */
  readonly stderr?: string;
  /** Git exit code when an exec ran; undefined otherwise. */
  readonly exitCode?: number | null;
  /**
   * Broker-created residual paths left on disk after a known
   * failure cleanup (e.g. a half-created worktree metadata dir the
   * broker could not remove). Empty when the broker cleaned up
   * everything it created. Undefined when no artifacts were
   * created.
   */
  readonly residualPaths?: readonly string[];
}

/**
 * Authority granted to the broker at construction. The broker never
 * reads the user's durable grant store directly — the caller (relay)
 * passes the exact canonical roots the current binding authorizes.
 * `/tmp` writability is NOT target authority; a worktree target
 * needs a distinct exact grant.
 */
export interface GitBrokerAuthority {
  /**
   * Canonical absolute path of the granted repository root (the
   * working tree the agent is operating in). Must be a real
   * directory.
   */
  readonly repository: string;
  /**
   * Canonical absolute roots the current binding authorizes for
   * Git mutation targets (worktree targets). The repository itself
   * is implicitly covered for in-repo pathspecs. Each entry must be
   * a real directory.
   */
  readonly grantedRoots: readonly string[];
  /** Canonical deny-override roots that repository metadata may not enter. */
  readonly protectedPaths?: readonly string[];
}

/**
 * Constructor options. The broker is created per binding (or per
 * turn) by the relay; it is not a long-lived singleton.
 */
export interface GitBrokerOptions {
  readonly authority: GitBrokerAuthority;
  /**
   * Absolute path to the Git executable the broker will invoke. The
   * caller resolves this once (e.g. `/usr/bin/git`); the broker
   * never consults PATH, aliases, or shell resolution. This is the
   * fixed executable the contract requires.
   */
  readonly gitExecutable: string;
  /**
   * Optional override for the macOS sandbox-exec binary path.
   * Defaults to `/usr/bin/sandbox-exec`. Tests supply a controlled
   * path.
   */
  readonly sandboxExecutable?: string;
  /**
   * Per-exec timeout in ms. Defaults to 30s — Git status/diff/
   * worktree ops on a bounded repo are sub-second; 30s is a generous
   * ceiling that still bounds a hung process.
   */
  readonly timeoutMs?: number;
  /**
   * When true, the broker executes Git under the compiled
   * per-operation sandbox profile. When false (tests), the broker
   * compiles the profile and runs Git WITHOUT sandbox-exec so the
   * preflight + profile + git logic can be exercised on hosts
   * without sandbox-exec. Production MUST leave this undefined /
   * false only for tests; the relay always runs sandboxed.
   */
  readonly disableSandboxForTests?: boolean;
  /**
   * Optional overrides for the worktree-materialization bounds.
   * Production leaves this undefined to use the exported defaults
   * (MAX_WORKTREE_FILE_COUNT / MAX_WORKTREE_BLOB_BYTES /
   * MAX_WORKTREE_TOTAL_BYTES). Tests may lower these to exercise the
   * per-blob / total / count denial paths without writing
   * tens-of-megabyte fixtures.
   */
  readonly worktreeLimits?: GitBrokerWorktreeLimits;
}

/**
 * Bounded limits for broker-controlled worktree materialization.
 * All operations enforce these BEFORE any durable mutation.
 */
export interface GitBrokerWorktreeLimits {
  readonly fileCount: number;
  readonly blobBytes: number;
  readonly totalBytes: number;
}

/**
 * Result of canonicalizing a repository's identity. The broker
 * uses this to verify the working tree, git-dir, and common-dir
 * form one coherent granted repository before any operation.
 */
export interface GitRepositoryIdentity {
  /** Canonical realpath of the working tree root. */
  readonly workTree: string;
  /** Canonical realpath of `$GIT_DIR` (`.git` for a regular repo). */
  readonly gitDir: string;
  /**
   * Canonical realpath of `$GIT_COMMON_DIR`. For a regular repo this
   * equals `gitDir`; for a linked worktree it is the main repo's
   * `.git`. A linked common-dir is implicit read-only repository
   * metadata authority only after its registry entry reciprocally
   * points back to the selected worktree's exact `.git` file.
   */
  readonly commonDir: string;
  /** True when `workTree` is a linked worktree (`.git` is a file). */
  readonly isLinkedWorktree: boolean;
}

/**
 * A worktree the broker has registered as broker-created. The
 * broker only removes worktrees it can prove it created; an
 * externally-created worktree is never force-removed.
 */
export interface BrokerRegisteredWorktree {
  readonly target: string;
  readonly name: string;
  readonly createdAt: number;
}
