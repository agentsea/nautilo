/**
 * D440 Phase 2 — the typed Git broker.
 *
 * Ties preflight (identity + threat rejection) -> per-operation
 * SBPL profile compilation -> bounded sandboxed execution ->
 * disposition classification -> known-failure cleanup.
 *
 * Implemented operations: status, diff, bounded plumbing add/commit,
 * worktree-add, and worktree-remove.
 */

import {
  existsSync,
  lstatSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, delimiter, resolve } from "node:path";

import {
  auditLocalConfig,
  canonicalizeRepositoryIdentity,
  GitPreflightError,
  isUnderRoot,
  rejectAlternates,
  rejectEscapingSymlinks,
  rejectSubmodules,
  validateWorktreeTarget,
} from "./preflight";
import { compileGitBrokerProfile } from "./profile";
import {
  gitBrokerConfigOverrides,
  runGitSandboxed,
  type ExecResult,
} from "./execute";
import {
  allocateTransaction,
  cleanupTransaction,
  createCallQuarantine,
  createCandidateIndex,
  hashFile,
  installIndexAtomically,
  mergeQuarantineObjects,
  promoteObjects,
  readSelectedChanges,
  validateCommitMessage,
  type GitStagingTransaction,
} from "./transaction";
import {
  cleanupMaterialization,
  MAX_WORKTREE_BLOB_BYTES,
  MAX_WORKTREE_FILE_COUNT,
  MAX_WORKTREE_TOTAL_BYTES,
  parseLsTreeZ,
  safeMkdirsForFile,
  writeBlobAtomic,
  type Manifest,
  type ManifestEntry,
} from "./materialize";
import type {
  GitBrokerDisposition,
  GitBrokerOptions,
  GitBrokerWorktreeLimits,
  GitOperation,
  GitRepositoryIdentity,
  BrokerRegisteredWorktree,
} from "./types";

export { GitPreflightError } from "./preflight";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * The typed Git broker. Created per binding by the relay; not a
 * long-lived singleton. Owns a registry of worktrees it created so
 * `worktreeRemove` only ever removes broker-created worktrees.
 */
export class GitBroker {
  private readonly authority: GitBrokerOptions["authority"];
  private readonly gitExecutable: string;
  private readonly sandboxExecutable: string;
  private readonly timeoutMs: number;
  private readonly disableSandboxForTests: boolean;
  private readonly worktreeLimits: GitBrokerWorktreeLimits;
  private readonly registry = new Map<string, BrokerRegisteredWorktree>();
  private transaction: GitStagingTransaction | undefined;

  constructor(opts: GitBrokerOptions) {
    this.authority = opts.authority;
    this.gitExecutable = opts.gitExecutable;
    this.sandboxExecutable = opts.sandboxExecutable ?? DEFAULT_SANDBOX_EXEC;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.disableSandboxForTests = opts.disableSandboxForTests ?? false;
    this.worktreeLimits = opts.worktreeLimits ?? {
      fileCount: MAX_WORKTREE_FILE_COUNT,
      blobBytes: MAX_WORKTREE_BLOB_BYTES,
      totalBytes: MAX_WORKTREE_TOTAL_BYTES,
    };
  }

  /** Current registry snapshot (for tests + diagnostics). */
  registeredWorktrees(): readonly BrokerRegisteredWorktree[] {
    return [...this.registry.values()];
  }

  // -------------------------------------------------------------------
  // Disposition helpers.
  // -------------------------------------------------------------------

  private deny(
    operation: GitOperation,
    reason: GitBrokerDisposition["reason"],
    message: string,
  ): GitBrokerDisposition {
    // Preflight denials: no subprocess, no side effect, retry-safe
    // (the caller can fix the grant/pathspec and retry).
    return { operation, ok: false, reason, sideEffectStarted: false, retrySafe: true, message };
  }

  private ok(
    operation: GitOperation,
    message: string,
    extra: Partial<Pick<GitBrokerDisposition, "stdout" | "stdoutBinary" | "stdoutOverflow" | "stderr" | "exitCode" | "residualPaths">>,
  ): GitBrokerDisposition {
    return { operation, ok: true, reason: "ok", sideEffectStarted: false, retrySafe: true, message, ...extra };
  }

  // -------------------------------------------------------------------
  // Internal exec — runs git under the compiled per-op profile.
  // -------------------------------------------------------------------

  /**
   * Run `git <args>` under the per-operation sandbox profile.
   * `sideEffectBegun` is true for operations that, once git has
   * started mutating durable state, classify a non-zero exit as
   * unknown-outcome (not retry-safe). For read-only ops (status,
   * diff) a non-zero exit is a known failure with no side effect.
   */
  private async execInternal(
    operation: GitOperation,
    identity: GitRepositoryIdentity,
    gitArgs: readonly string[],
    cwd: string,
    options: {
      sideEffectBegun: boolean;
      knownNonzeroBeforeMutation?: boolean;
      worktreeName?: string;
      target?: string;
      transactionRoot?: string;
      refName?: string;
      env?: Readonly<Record<string, string>>;
      stdin?: Buffer;
      captureBudget?: number;
      captureBinary?: boolean;
    },
  ): Promise<GitBrokerDisposition> {
    // Platform gate: the compiled profile is SBPL (macOS Seatbelt).
    // On any non-Darwin host, refuse to execute rather than fake
    // safety with an unsandboxed run. Test mode (disableSandboxForTests)
    // bypasses this so the preflight + git logic can be exercised on
    // any host without sandbox-exec.
    if (
      process.platform !== "darwin" &&
      !this.disableSandboxForTests
    ) {
      return {
        operation,
        ok: false,
        reason: "deny-platform-unsupported",
        sideEffectStarted: false,
        retrySafe: true,
        message:
          "the Git broker's per-operation sandbox profile is macOS Seatbelt (SBPL); this host is not Darwin, so the broker refuses to execute rather than run unsandboxed. A bubblewrap profile compiler is a follow-up.",
      };
    }
    // HOME for the sandboxed git = the granted working tree (an
    // ALLOWED path in the profile). Never a denied scratch — a
    // denied HOME makes git block on HOME-relative reads and hangs
    // the whole invocation.
    const homeDir = identity.workTree;
    const profile = compileGitBrokerProfile({
      operation,
      identity,
      ...(options.target !== undefined ? { target: options.target } : {}),
      ...(options.worktreeName !== undefined ? { worktreeName: options.worktreeName } : {}),
      ...(options.transactionRoot !== undefined ? { transactionRoot: options.transactionRoot } : {}),
      ...(options.refName !== undefined ? { refName: options.refName } : {}),
      gitExecutable: this.gitExecutable,
      ...(this.authority.protectedPaths?.length
        ? { protectedPaths: this.authority.protectedPaths }
        : {}),
    });

    let result: ExecResult;
    try {
      result = await runGitSandboxed({
        sandboxExecutable: this.sandboxExecutable,
        profile,
        gitExecutable: this.gitExecutable,
        gitArgs: [...gitBrokerConfigOverrides(), ...gitArgs],
        cwd,
        timeoutMs: this.timeoutMs,
        ...(this.disableSandboxForTests ? { disableSandboxForTests: true } : {}),
        homeDir,
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(options.captureBudget !== undefined ? { captureBudget: options.captureBudget } : {}),
        ...(options.captureBinary ? { captureBinary: true } : {}),
      });
    } catch (err) {
      // Spawn itself failed (e.g. ENOENT for sandbox-exec). No side
      // effect began; safe to surface as a known failure.
      return {
        operation,
        ok: false,
        reason: "exec-known-failure",
        sideEffectStarted: false,
        retrySafe: true,
        message: `failed to spawn sandboxed git: ${String(err)}`,
      };
    }

    if (result.timedOut) {
      // A timeout MAY have begun a side effect (we don't know how
      // far git got). Classify as unknown-outcome, do not retry.
      return {
        operation,
        ok: false,
        reason: "exec-timeout",
        sideEffectStarted: options.sideEffectBegun,
        retrySafe: false,
        message: `git timed out after ${this.timeoutMs}ms; outcome unknown`,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        ...this.binaryExtra(result),
      };
    }

    if (result.exitCode === 0) {
      return this.ok(operation, `${operation} succeeded`, {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        ...this.binaryExtra(result),
      });
    }

    // Non-zero exit.
    if (!options.sideEffectBegun || options.knownNonzeroBeforeMutation === true) {
      // Read-only op or pre-mutation failure: known failure, no
      // side effect, retry-safe.
      return {
        operation,
        ok: false,
        reason: "exec-known-failure",
        sideEffectStarted: false,
        retrySafe: true,
        message: `git ${operation} failed (exit ${result.exitCode}) before any mutation: ${result.stderr.trim()}`,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        ...this.binaryExtra(result),
      };
    }

    // Side-effect-begun op failed mid-mutation: outcome unknown.
    // Do NOT retry, do NOT force-clean. The operation-specific
    // caller records broker-created residual paths (e.g. the
    // worktree metadata dir) for operator inspection.
    return {
      operation,
      ok: false,
      reason: "exec-unknown-outcome",
      sideEffectStarted: true,
      retrySafe: false,
      message: `git ${operation} failed (exit ${result.exitCode}) after starting a mutation; outcome unknown, not retrying`,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      ...this.binaryExtra(result),
    };
  }

  /**
   * Extract binary-capture fields from an exec result so they can be
   * spread into a disposition. Empty when binary capture was not used.
   */
  private binaryExtra(result: ExecResult): Partial<GitBrokerDisposition> {
    if (result.stdoutBinary === undefined) return {};
    return {
      stdoutBinary: result.stdoutBinary,
      ...(result.stdoutOverflow !== undefined ? { stdoutOverflow: result.stdoutOverflow } : {}),
    };
  }

  // -------------------------------------------------------------------
  // Preflight — shared by every operation. Pure filesystem.
  // -------------------------------------------------------------------

  /**
   * Canonicalize repository identity and run every threat rejection.
   * Pure filesystem — no Git subprocess. Returns the identity.
   * Throws `GitPreflightError` on any deny.
   */
  private preflight(): GitRepositoryIdentity {
    const identity = canonicalizeRepositoryIdentity(this.authority.repository);
    if (
      this.authority.protectedPaths?.some((root) => isUnderRoot(identity.commonDir, root))
    ) {
      throw new GitPreflightError(
        "deny-repo-identity-mismatch",
        `repository common-dir enters a protected path: ${identity.commonDir}`,
      );
    }
    rejectAlternates(identity, this.authority.grantedRoots);
    rejectSubmodules(identity);
    rejectEscapingSymlinks(identity.workTree, this.authority.grantedRoots);
    auditLocalConfig(identity);
    return identity;
  }

  // -------------------------------------------------------------------
  // Public operations.
  // -------------------------------------------------------------------

  /**
   * `git status --porcelain=v1 --short --no-optional-locks --null`.
   * Read-only. Optional locks disabled so the broker never writes
   * `.git/index.lock`. No hooks, no filters, no external diff.
   */
  async status(): Promise<GitBrokerDisposition> {
    let identity: GitRepositoryIdentity;
    try {
      identity = this.preflight();
    } catch (err) {
      return this.preflightDeny("status", err);
    }
    return this.execInternal(
      "status",
      identity,
      ["--no-optional-locks", "status", "--porcelain=v1", "--short", "-z"],
      identity.workTree,
      { sideEffectBegun: false },
    );
  }

  /**
   * `git diff --no-ext-diff --no-textconv --no-color --raw -z [<ref>]`.
   * Read-only. External diff and textconv explicitly disabled.
   * Optional `ref` compares working tree to the named ref/commit;
   * omit for the unstaged diff. Pathspecs are NOT accepted here —
   * the broker does not yet implement bounded add, so a diff
   * pathspec surface is deferred alongside add/commit.
   */
  async diff(ref?: string): Promise<GitBrokerDisposition> {
    let identity: GitRepositoryIdentity;
    try {
      identity = this.preflight();
    } catch (err) {
      return this.preflightDeny("diff", err);
    }
    const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--raw", "-z"];
    if (ref !== undefined && ref.length > 0) {
      // Reject pathspec magic in the ref argument defensively.
      if (ref.startsWith(":") || ref.includes("**")) {
        return this.deny("diff", "deny-pathspec-magic", `ref argument has pathspec magic: ${ref}`);
      }
      args.push(ref);
    }
    return this.execInternal("diff", identity, args, identity.workTree, {
      sideEffectBegun: false,
    });
  }

  /**
   * Broker-controlled worktree creation + target materialization.
   *
   * Pipeline (every threat rejected BEFORE durable mutation):
   *   1. Preflight (identity, alternates, submodules, escaping
   *      symlinks, local config audit) + target validation (real,
   *      empty, in-grant, non-symlink).
   *   2. Resolve the requested ref to an OID with `rev-parse --verify`
   *      under the broker profile (read-only; failure is retry-safe).
   *   3. Enumerate the full tree with `git ls-tree -r -z --full-tree`
   *      under the broker profile (read-only; retry-safe).
   *   4. Parse + validate the manifest: reject gitlink/submodule
   *      entries, unsafe modes, symlinks (mode 120000 — all symlink
   *      tree entries rejected for this slice), absolute/escaping
   *      paths, NUL, control bytes, duplicates, live `.env`
   *      variants, governance entries, and resource-limit overflow.
   *      Public terminal-suffix `.example/.sample/.template/.dist`
   *      blobs are allowed.
   *   5. Create worktree metadata with `git worktree add --no-checkout
   *      --detach <target> <ref>`. `--no-checkout` is the safety
   *      keystone: NO smudge filters run, NO post-checkout hook fires.
   *      This is the first durable mutation (sideEffectBegun).
   *   6. Materialize exact regular/executable blobs into the target
   *      with broker-owned filesystem code: safe mkdir (no symlink
   *      following), atomic exclusive write + rename, mode 0644/0755,
   *      fsync. Blob bytes are read with `git cat-file blob <oid>`
   *      under the broker profile, bounded per-blob and total.
   *      Never executes repo config, hooks, attributes, filters,
   *      submodules, or signing.
   *   7. Verify the resulting worktree is clean per
   *      `git status --porcelain -z` and contains tracked files.
   *
   * Known materialization failure: remove only broker-created files,
   * metadata, and target contents; report residual paths. Unknown
   * outcomes (timeout mid-materialization) remain non-retryable and
   * preserved.
   */
  async worktreeAdd(target: string, ref: string): Promise<GitBrokerDisposition> {
    let identity: GitRepositoryIdentity;
    try {
      identity = this.preflight();
    } catch (err) {
      return this.preflightDeny("worktree-add", err);
    }
    // Reject pathspec magic in the ref argument defensively.
    if (ref.startsWith(":") || ref.includes("**")) {
      return this.deny("worktree-add", "deny-pathspec-magic", `ref argument has pathspec magic: ${ref}`);
    }
    let validated: { target: string };
    try {
      validated = validateWorktreeTarget(target, this.authority.grantedRoots);
    } catch (err) {
      return this.preflightDeny("worktree-add", err);
    }
    // Reject escaping symlinks in the target (already empty, but
    // defend against a link planted between preflight and exec).
    try {
      rejectEscapingSymlinks(validated.target, this.authority.grantedRoots);
    } catch (err) {
      return this.preflightDeny("worktree-add", err);
    }
    const name = basename(validated.target);
    if (name.length === 0) {
      return this.deny("worktree-add", "deny-target-outside-grant", `target has empty basename: ${validated.target}`);
    }

    // --- Step 2: resolve the ref (read-only, retry-safe) ----------
    const refOid = await this.execInternal(
      "worktree-add",
      identity,
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      identity.workTree,
      { sideEffectBegun: false, worktreeName: name, target: validated.target },
    );
    if (!refOid.ok) {
      return this.deny(
        "worktree-add",
        "exec-known-failure",
        `could not resolve ref ${ref}: ${(refOid.stderr ?? "").trim()}`,
      );
    }
    const oid = (refOid.stdout ?? "").trim();
    if (!/^[0-9a-f]{40,64}$/.test(oid)) {
      return this.deny(
        "worktree-add",
        "exec-known-failure",
        `resolved ref ${ref} to a non-hex value: ${oid}`,
      );
    }

    // --- Step 3: enumerate the full tree (read-only, retry-safe) ---
    // `-l` includes the blob size so per-blob and total-byte limits can
    // be enforced BEFORE any durable mutation.
    const lsTree = await this.execInternal(
      "worktree-add",
      identity,
      ["ls-tree", "-r", "-l", "-z", "--full-tree", oid],
      identity.workTree,
      {
        sideEffectBegun: false,
        worktreeName: name,
        target: validated.target,
        // Bounded by manifest validation; ls-tree of a bounded tree
        // is well under 16 MiB.
        captureBudget: 16 * 1024 * 1024,
      },
    );
    if (!lsTree.ok) {
      return this.deny(
        "worktree-add",
        "exec-known-failure",
        `ls-tree of ${oid} failed: ${(lsTree.stderr ?? "").trim()}`,
      );
    }

    // --- Step 4: parse + validate the manifest (pure, retry-safe) --
    let manifest: Manifest;
    try {
      manifest = parseLsTreeZ(
        Buffer.from(lsTree.stdout ?? "", "utf8"),
        validated.target,
        this.worktreeLimits.fileCount,
        this.worktreeLimits.blobBytes,
        this.worktreeLimits.totalBytes,
      );
    } catch (err) {
      return this.preflightDeny("worktree-add", err);
    }
    if (manifest.entries.length === 0) {
      return this.deny(
        "worktree-add",
        "deny-pathspec-outside-target",
        `ref ${ref} (${oid}) has an empty tree; nothing to materialize`,
      );
    }

    // --- Step 5: create worktree metadata (--no-checkout) ----------
    const metaDisp = await this.execInternal(
      "worktree-add",
      identity,
      ["worktree", "add", "--no-checkout", "--detach", validated.target, ref],
      identity.workTree,
      { sideEffectBegun: true, worktreeName: name, target: validated.target },
    );
    if (!metaDisp.ok) {
      if (metaDisp.reason === "exec-unknown-outcome") {
        const metaDir = resolve(identity.commonDir, "worktrees", name);
        return { ...metaDisp, residualPaths: [metaDir] };
      }
      const metaDir = resolve(identity.commonDir, "worktrees", name);
      const residuals = this.cleanBrokerArtifacts([metaDir]);
      if (residuals.length > 0) {
        return { ...metaDisp, residualPaths: [...(metaDisp.residualPaths ?? []), ...residuals] };
      }
      return metaDisp;
    }

    // --- Step 5b: seed the worktree index from the resolved tree ---
    // `git worktree add --no-checkout` creates the worktree metadata
    // and HEAD but leaves the index EMPTY, so a materialized working
    // tree would read as untracked + staged-deleted. `git read-tree`
    // is pure plumbing: it loads the tree into the index without
    // running hooks, smudge/clean filters, textconv, or a checkout.
    // The index file lives under the narrow `<common>/worktrees/<name>/`
    // carve-out the profile already grants.
    const readTree = await this.execInternal(
      "worktree-add",
      identity,
      ["read-tree", oid],
      validated.target,
      { sideEffectBegun: true, worktreeName: name, target: validated.target },
    );
    if (!readTree.ok) {
      if (readTree.reason === "exec-timeout") {
        const metaDir = resolve(identity.commonDir, "worktrees", name);
        return {
          operation: "worktree-add",
          ok: false,
          reason: "exec-unknown-outcome",
          sideEffectStarted: true,
          retrySafe: false,
          message: `read-tree timed out after metadata creation; outcome unknown`,
          residualPaths: [metaDir],
        };
      }
      const residuals = this.abortMaterialization(identity, name, validated.target, []);
      return {
        operation: "worktree-add",
        ok: false,
        reason: "exec-known-failure",
        sideEffectStarted: true,
        retrySafe: false,
        message: `read-tree ${oid} failed: ${(readTree.stderr ?? "").trim()}`,
        ...(residuals.length > 0 ? { residualPaths: residuals } : {}),
      };
    }

    // --- Step 6: materialize blobs (broker-owned fs code) ----------
    const materialized = await this.materializeManifest(
      identity,
      validated.target,
      name,
      manifest.entries,
    );
    if (!materialized.ok) {
      // Known materialization failure: remove broker-created files,
      // metadata, and target contents; report residuals.
      const residuals = this.abortMaterialization(
        identity,
        name,
        validated.target,
        materialized.writtenPaths,
      );
      return {
        operation: "worktree-add",
        ok: false,
        reason: materialized.reason,
        sideEffectStarted: true,
        retrySafe: materialized.reason === "exec-known-failure",
        message: materialized.message,
        ...(residuals.length > 0 ? { residualPaths: residuals } : {}),
      };
    }

    // --- Step 7: verify the worktree is clean ----------------------
    const verify = await this.execInternal(
      "worktree-add",
      identity,
      ["--no-optional-locks", "status", "--porcelain=v1", "--short", "-z"],
      validated.target,
      { sideEffectBegun: true, worktreeName: name, target: validated.target },
    );
    if (!verify.ok) {
      // Read-only verify failed after mutation: unknown outcome —
      // metadata + files exist; we cannot prove cleanliness. Preserve.
      const metaDir = resolve(identity.commonDir, "worktrees", name);
      return {
        operation: "worktree-add",
        ok: false,
        reason: "exec-unknown-outcome",
        sideEffectStarted: true,
        retrySafe: false,
        message: `worktree metadata + blobs materialized but status verification failed; outcome unknown, not retrying: ${(verify.stderr ?? "").trim()}`,
        residualPaths: [metaDir, ...materialized.writtenPaths],
      };
    }
    if ((verify.stdout ?? "").length > 0) {
      // Dirty after materialization: known failure. Clean up.
      const residuals = this.abortMaterialization(
        identity,
        name,
        validated.target,
        materialized.writtenPaths,
      );
      return {
        operation: "worktree-add",
        ok: false,
        reason: "exec-known-failure",
        sideEffectStarted: true,
        retrySafe: false,
        message: `materialized worktree is not clean per git status --porcelain: ${JSON.stringify(verify.stdout)}`,
        ...(residuals.length > 0 ? { residualPaths: residuals } : {}),
      };
    }

    this.registry.set(validated.target, {
      target: validated.target,
      name,
      createdAt: Date.now(),
    });
    return this.ok("worktree-add", `materialized ${materialized.writtenPaths.length} blob(s) into ${validated.target}`, {});
  }

  /**
   * Materialize every manifest blob into the target with broker-owned
   * filesystem code. Blob bytes are read with `git cat-file blob <oid>`
   * under the broker profile, bounded per-blob and total. Returns the
   * list of written paths on success, or a known-failure disposition
   * (with partial written paths for cleanup) on failure.
   */
  private async materializeManifest(
    identity: GitRepositoryIdentity,
    targetRoot: string,
    name: string,
    entries: readonly ManifestEntry[],
  ): Promise<
    | { readonly ok: true; readonly writtenPaths: readonly string[] }
    | {
        readonly ok: false;
        readonly reason: GitBrokerDisposition["reason"];
        readonly message: string;
        readonly writtenPaths: readonly string[];
      }
  > {
    const writtenPaths: string[] = [];
    let totalBytes = 0;
    const execOptions = {
      sideEffectBegun: true,
      worktreeName: name,
      target: targetRoot,
    };

    for (const entry of entries) {
      const blob = await this.execInternal(
        "worktree-add",
        identity,
        ["cat-file", "blob", entry.oid],
        identity.workTree,
        {
          ...execOptions,
          captureBudget: this.worktreeLimits.blobBytes + 1024,
          captureBinary: true,
        },
      );
      if (!blob.ok) {
        // cat-file failed mid-materialization: we have already written
        // prior blobs. A timeout is unknown-outcome; a normal non-zero
        // exit is a known failure (the blob is missing/corrupt).
        if (blob.reason === "exec-timeout") {
          return {
            ok: false,
            reason: "exec-unknown-outcome",
            message: `cat-file blob ${entry.oid} timed out mid-materialization; outcome unknown`,
            writtenPaths,
          };
        }
        return {
          ok: false,
          reason: "exec-known-failure",
          message: `cat-file blob ${entry.oid} for ${entry.path} failed: ${(blob.stderr ?? "").trim()}`,
          writtenPaths,
        };
      }
      if (blob.stdoutOverflow === true) {
        return {
          ok: false,
          reason: "deny-add-bounds",
          message: `blob ${entry.path} (${entry.oid}) exceeded the capture budget`,
          writtenPaths,
        };
      }
      const contents = blob.stdoutBinary ?? Buffer.from(blob.stdout ?? "", "utf8");
      // Defensive: ls-tree -l already validated sizes pre-mutation, but
      // re-check the actual bytes in case of any drift.
      if (contents.length > this.worktreeLimits.blobBytes) {
        return {
          ok: false,
          reason: "deny-add-bounds",
          message: `blob ${entry.path} (${entry.oid}) exceeds ${this.worktreeLimits.blobBytes} bytes`,
          writtenPaths,
        };
      }
      totalBytes += contents.length;
      if (totalBytes > this.worktreeLimits.totalBytes) {
        return {
          ok: false,
          reason: "deny-add-bounds",
          message: `materialization exceeds ${this.worktreeLimits.totalBytes} total bytes at ${entry.path}`,
          writtenPaths,
        };
      }

      const absPath = resolve(targetRoot, ...entry.path.split("/"));
      try {
        safeMkdirsForFile(absPath, targetRoot);
        writeBlobAtomic(absPath, contents, entry.mode === "100755");
      } catch (error) {
        return {
          ok: false,
          reason: "exec-known-failure",
          message: `materializing ${entry.path} failed: ${String(error)}`,
          writtenPaths,
        };
      }
      writtenPaths.push(absPath);
    }

    return { ok: true, writtenPaths };
  }

  /**
   * Abort a known materialization failure: remove broker-created
   * files + empty dirs from the target, the `.git` pointer file the
   * broker authorized `git worktree add` to create, then the worktree
   * metadata. Returns residual paths that could not be removed.
   */
  private abortMaterialization(
    identity: GitRepositoryIdentity,
    name: string,
    targetRoot: string,
    writtenPaths: readonly string[],
  ): string[] {
    const residuals: string[] = [];
    try {
      const r = cleanupMaterialization(targetRoot, writtenPaths);
      residuals.push(...r);
    } catch (err) {
      residuals.push(`${targetRoot} (cleanup error: ${String(err)})`);
    }
    // Remove the `.git` pointer file `git worktree add --no-checkout`
    // created in the target. It is a broker-authorized artifact, not
    // operator data. Never follow a symlink.
    const dotGit = resolve(targetRoot, ".git");
    try {
      const lst = lstatSync(dotGit);
      if (!lst.isSymbolicLink()) rmSync(dotGit, { force: true });
    } catch {
      // already gone
    }
    const metaDir = resolve(identity.commonDir, "worktrees", name);
    const metaResiduals = this.cleanBrokerArtifacts([metaDir]);
    residuals.push(...metaResiduals);
    return residuals;
  }

  /**
   * `git worktree remove <target>`. Only removes worktrees the
   * broker created (registry hit). Rejects unregistered, dirty,
   * nested, or symlink targets. Does NOT pass `--force` — a dirty
   * worktree is rejected (ambiguous dirty removal) rather than
   * force-cleaned.
   */
  async worktreeRemove(target: string): Promise<GitBrokerDisposition> {
    let identity: GitRepositoryIdentity;
    try {
      identity = this.preflight();
    } catch (err) {
      return this.preflightDeny("worktree-remove", err);
    }
    let realTarget: string;
    try {
      realTarget = realpathSync(target);
    } catch (err) {
      return this.deny("worktree-remove", "deny-unknown-worktree", `target does not resolve: ${target} (${String(err)})`);
    }
    // Reject symlink entry.
    try {
      if (lstatSync(target).isSymbolicLink()) {
        return this.deny("worktree-remove", "deny-target-symlink", `target is a symlink: ${target}`);
      }
    } catch (err) {
      return this.deny("worktree-remove", "deny-unknown-worktree", `target lstat failed: ${target} (${String(err)})`);
    }
    // Must be broker-created.
    const registered = this.registry.get(realTarget);
    if (registered === undefined) {
      return this.deny("worktree-remove", "deny-unregistered-worktree", `target is not a broker-created worktree: ${realTarget}`);
    }
    // Must be inside a granted root.
    const granted = this.authority.grantedRoots.some((r) => isUnderRoot(realTarget, r));
    if (!granted) {
      return this.deny("worktree-remove", "deny-target-outside-grant", `target outside granted roots: ${realTarget}`);
    }

    // --- Verify the worktree is clean BEFORE any removal ------------
    // A registered worktree was materialized clean by `worktreeAdd`.
    // If the operator later modified it, removal would discard their
    // changes — so the broker first verifies `git status --porcelain`
    // is empty (read-only, under the worktree-remove profile). A dirty
    // tree is rejected as `deny-dirty-removal`; the broker NEVER passes
    // `--force`. This is the "without destructive force over user
    // changes" guarantee.
    const cleanCheck = await this.execInternal(
      "worktree-remove",
      identity,
      ["--no-optional-locks", "status", "--porcelain=v1", "--short", "-z"],
      realTarget,
      { sideEffectBegun: false, worktreeName: registered.name, target: realTarget },
    );
    if (!cleanCheck.ok) {
      // Read-only verify failed pre-mutation: known failure, retry-safe.
      // Do NOT touch the target.
      return {
        ...cleanCheck,
        reason: cleanCheck.reason === "exec-timeout" ? "exec-timeout" : "exec-known-failure",
        sideEffectStarted: false,
        retrySafe: cleanCheck.reason !== "exec-timeout",
        message: `cannot verify worktree cleanliness before removal: ${(cleanCheck.stderr ?? "").trim()}`,
      };
    }
    if ((cleanCheck.stdout ?? "").length > 0) {
      return this.deny(
        "worktree-remove",
        "deny-dirty-removal",
        `worktree is dirty per git status --porcelain; broker refuses destructive removal (no --force): ${realTarget}`,
      );
    }

    // --- Broker-owned working-tree removal (outside the sandbox) ----
    // The verified-clean working tree contains only broker-materialized
    // blobs + the `.git` pointer file the broker authorized. Removing
    // it discards nothing of the operator's. The broker does this with
    // its own filesystem code (outside sandbox-exec) because macOS
    // Seatbelt denies `rmdir` of a directory even with `file-write*` on
    // the parent — `git worktree remove` cannot rmdir the target under
    // the profile. The subsequent `git worktree remove` then only
    // prunes the worktree metadata (which sits under the narrow
    // `<common>/worktrees/` carve-out) and returns 0 on the now-missing
    // working tree.
    try {
      rmSync(realTarget, { recursive: true, force: true });
    } catch (err) {
      // Could not remove the working tree. Do NOT prune metadata —
      // the worktree is still partially live. Surface as known failure
      // with the target as a residual.
      return {
        operation: "worktree-remove",
        ok: false,
        reason: "exec-known-failure",
        sideEffectStarted: true,
        retrySafe: false,
        message: `broker failed to remove the clean working tree ${realTarget}: ${String(err)}`,
        residualPaths: [realTarget],
      };
    }

    // --- Prune worktree metadata under the sandbox profile ----------
    const disp = await this.execInternal(
      "worktree-remove",
      identity,
      ["worktree", "remove", realTarget],
      identity.workTree,
      { sideEffectBegun: true, worktreeName: registered.name, target: realTarget },
    );

    if (disp.ok) {
      this.registry.delete(realTarget);
      return disp;
    }

    // `git worktree remove` failed after the broker already removed the
    // working tree. A "contains modified or untracked files" refusal is
    // impossible here (working tree is gone). A timeout is unknown —
    // metadata may or may not be pruned. Any other non-zero is a known
    // failure: the metadata dir likely remains; surface it as a residual
    // and keep the registry entry so the operator can retry / inspect.
    const metaDir = resolve(identity.commonDir, "worktrees", registered.name);
    if (disp.reason === "exec-timeout") {
      return {
        ...disp,
        retrySafe: false,
        message: `${disp.message}; working tree already removed by broker; metadata prune outcome unknown at ${metaDir}`,
        residualPaths: [metaDir],
      };
    }
    const metaResiduals = this.cleanBrokerArtifacts([metaDir]);
    const residuals = [metaDir, ...metaResiduals].filter((p, i, arr) => arr.indexOf(p) === i);
    return {
      ...disp,
      reason: "exec-known-failure",
      sideEffectStarted: true,
      retrySafe: false,
      message: `git worktree remove failed after broker removed the working tree; metadata cleanup attempted: ${(disp.stderr ?? "").trim()}`,
      ...(residuals.length > 0 ? { residualPaths: residuals } : {}),
    };
  }

  /**
   * Stage an explicit bounded path list into the broker-owned temporary
   * index. Regular files are read with O_NOFOLLOW, hashed literally into
   * a per-call quarantine, and installed with explicit cacheinfo. Missing
   * paths remove an entry only when that exact path is already tracked in
   * the broker index. The real repository index is never touched.
   */
  async add(pathspecs: readonly string[]): Promise<GitBrokerDisposition> {
    let identity: GitRepositoryIdentity;
    let selected;
    try {
      identity = this.preflight();
      selected = readSelectedChanges(pathspecs, identity);
    } catch (error) {
      return this.preflightDeny("add", error);
    }

    const initialized = await this.ensureTransaction(identity);
    if (!initialized.ok) return initialized;
    const transaction = this.transaction;
    if (transaction === undefined) {
      return this.deny("add", "exec-known-failure", "staging transaction was not initialized");
    }

    const coherent = await this.verifyTransactionStillCurrent(transaction, "add");
    if (!coherent.ok) return coherent;

    // Every missing path must already be represented in the broker index.
    // This completes all path preflight before the candidate index or
    // quarantine is mutated.
    for (const change of selected) {
      if (change.kind !== "delete") continue;
      const tracked = await this.execInternal(
        "add",
        identity,
        ["ls-files", "--error-unmatch", "--", change.relativePath],
        identity.workTree,
        {
          sideEffectBegun: false,
          transactionRoot: transaction.root,
          env: this.transactionEnv(transaction),
        },
      );
      if (!tracked.ok) {
        return this.deny(
          "add",
          "deny-path-not-regular",
          `cannot stage deletion of untracked path: ${change.relativePath}`,
        );
      }
    }

    const candidateIndex = createCandidateIndex(transaction);
    const callObjects = createCallQuarantine(transaction);
    const candidateEnv = this.transactionEnv(transaction, candidateIndex, callObjects, [
      transaction.objectsPath,
      resolve(identity.commonDir, "objects"),
    ]);

    try {
      for (const change of selected) {
        if (change.kind === "delete") {
          const removed = await this.execInternal(
            "add",
            identity,
            ["update-index", "--force-remove", "--", change.relativePath],
            identity.workTree,
            {
              sideEffectBegun: false,
              transactionRoot: transaction.root,
              env: candidateEnv,
            },
          );
          if (!removed.ok) return this.reversibleAddFailure(removed, candidateIndex, callObjects);
          continue;
        }

        const hashed = await this.execInternal(
          "add",
          identity,
          ["hash-object", "-w", "--literally", "--stdin"],
          identity.workTree,
          {
            sideEffectBegun: false,
            transactionRoot: transaction.root,
            env: candidateEnv,
            stdin: change.contents,
          },
        );
        const oid = hashed.stdout?.trim() ?? "";
        if (!hashed.ok || !/^[0-9a-f]{40,64}$/.test(oid)) {
          return this.reversibleAddFailure(hashed, candidateIndex, callObjects);
        }

        const updated = await this.execInternal(
          "add",
          identity,
          ["update-index", "--add", "--cacheinfo", `${change.mode},${oid},${change.relativePath}`],
          identity.workTree,
          {
            sideEffectBegun: false,
            transactionRoot: transaction.root,
            env: candidateEnv,
          },
        );
        if (!updated.ok) return this.reversibleAddFailure(updated, candidateIndex, callObjects);
      }

      mergeQuarantineObjects(callObjects, transaction.objectsPath);
      renameSync(candidateIndex, transaction.indexPath);
      rmSync(callObjects, { recursive: true, force: true });
      return {
        operation: "add",
        ok: true,
        reason: "ok",
        sideEffectStarted: false,
        retrySafe: true,
        message: `staged ${selected.length} explicit path(s) in the broker-owned index`,
      };
    } catch (error) {
      rmSync(candidateIndex, { force: true });
      rmSync(callObjects, { recursive: true, force: true });
      return {
        operation: "add",
        ok: false,
        reason: "exec-known-failure",
        sideEffectStarted: false,
        retrySafe: true,
        message: `add transaction failed before repository mutation: ${String(error)}`,
      };
    }
  }

  /**
   * Write tree + commit objects from the broker index/quarantine, promote
   * immutable objects, CAS the captured attached ref, then atomically
   * install the broker index via `.git/index.lock` + rename.
   */
  async commit(message: string): Promise<GitBrokerDisposition> {
    let messageBytes: Buffer;
    try {
      messageBytes = validateCommitMessage(message);
    } catch (error) {
      return this.preflightDeny("commit", error);
    }

    const transaction = this.transaction;
    if (transaction === undefined) {
      return this.deny(
        "commit",
        "deny-no-staging-transaction",
        "commit requires at least one successful broker add() call",
      );
    }

    let identity: GitRepositoryIdentity;
    try {
      identity = this.preflight();
    } catch (error) {
      return this.preflightDeny("commit", error);
    }
    if (!this.sameIdentity(identity, transaction.identity)) {
      return this.deny("commit", "deny-repo-identity-mismatch", "repository identity changed during staging");
    }

    const coherent = await this.verifyTransactionStillCurrent(transaction, "commit");
    if (!coherent.ok) return coherent;
    const env = this.transactionEnv(transaction);
    const execOptions = {
      sideEffectBegun: false,
      transactionRoot: transaction.root,
      refName: transaction.refName,
      env,
    } as const;

    const treeResult = await this.execInternal(
      "commit",
      identity,
      ["write-tree"],
      identity.workTree,
      execOptions,
    );
    const treeOid = treeResult.stdout?.trim() ?? "";
    if (!treeResult.ok || !/^[0-9a-f]{40,64}$/.test(treeOid)) return treeResult;

    const oldTreeResult = await this.execInternal(
      "commit",
      identity,
      ["rev-parse", `${transaction.headOid}^{tree}`],
      identity.workTree,
      execOptions,
    );
    if (!oldTreeResult.ok) return oldTreeResult;
    if (oldTreeResult.stdout?.trim() === treeOid) {
      return this.deny("commit", "deny-no-staged-changes", "broker index tree equals captured HEAD");
    }

    const commitResult = await this.execInternal(
      "commit",
      identity,
      ["commit-tree", treeOid, "-p", transaction.headOid],
      identity.workTree,
      { ...execOptions, stdin: Buffer.concat([messageBytes, Buffer.from("\n")]) },
    );
    const commitOid = commitResult.stdout?.trim() ?? "";
    if (!commitResult.ok || !/^[0-9a-f]{40,64}$/.test(commitOid)) return commitResult;

    try {
      promoteObjects(transaction);
    } catch (error) {
      cleanupTransaction(transaction);
      this.transaction = undefined;
      return {
        operation: "commit",
        ok: false,
        reason: "exec-known-failure",
        // Promotion is content-addressed but may have installed a prefix
        // of immutable unreachable objects before the failure.
        sideEffectStarted: true,
        retrySafe: false,
        message: `failed to promote quarantined objects before ref movement: ${String(error)}`,
      };
    }

    // Recheck the real index at the last possible moment before moving
    // the ref, so the post-CAS index install cannot overwrite staged
    // state introduced by another actor.
    const realIndexPath = resolve(identity.gitDir, "index");
    if (hashFile(realIndexPath) !== transaction.initialRealIndexHash) {
      cleanupTransaction(transaction);
      this.transaction = undefined;
      return this.deny(
        "commit",
        "deny-index-drift",
        "real repository index changed after broker staging began; broker transaction discarded",
      );
    }

    const refResult = await this.execInternal(
      "commit",
      identity,
      ["update-ref", transaction.refName, commitOid, transaction.headOid],
      identity.workTree,
      {
        sideEffectBegun: true,
        knownNonzeroBeforeMutation: true,
        transactionRoot: transaction.root,
        refName: transaction.refName,
        env,
      },
    );
    if (!refResult.ok) {
      if (refResult.reason === "exec-timeout") {
        return {
          ...refResult,
          residualPaths: [transaction.root],
          message:
            `${refResult.message}; inspect ${transaction.refName}: expected old ${transaction.headOid}, proposed new ${commitOid}; broker transaction preserved at ${transaction.root}`,
        };
      }
      cleanupTransaction(transaction);
      this.transaction = undefined;
      const casDrift = /expected|is at|reference already exists|cannot lock ref.*but expected/i.test(
        refResult.stderr ?? "",
      );
      return {
        ...refResult,
        reason: casDrift ? "deny-ref-drift" : "exec-known-failure",
        // Immutable objects were promoted before the ref CAS.
        sideEffectStarted: true,
        retrySafe: false,
        message: `ref CAS did not move ${transaction.refName}; expected ${transaction.headOid}, proposed ${commitOid}; promoted immutable objects may remain unreachable; broker transaction discarded. ${refResult.stderr?.trim() ?? ""}`,
      };
    }

    try {
      installIndexAtomically(transaction);
    } catch (error) {
      const lockPath = `${realIndexPath}.lock`;
      return {
        operation: "commit",
        ok: false,
        reason: "exec-unknown-outcome",
        sideEffectStarted: true,
        retrySafe: false,
        message:
          `ref moved successfully to ${commitOid}, but broker index installation failed. Do not retry commit. Repair by verifying ${transaction.refName}=${commitOid}, then replace ${realIndexPath} from ${transaction.indexPath} once ${lockPath} is safe to remove. Error: ${String(error)}`,
        residualPaths: [transaction.root, lockPath],
      };
    }

    cleanupTransaction(transaction);
    this.transaction = undefined;
    return {
      operation: "commit",
      ok: true,
      reason: "ok",
      sideEffectStarted: true,
      retrySafe: false,
      message: `committed ${commitOid} to ${transaction.refName} and atomically installed the broker index`,
      stdout: `${commitOid}\n`,
      exitCode: 0,
    };
  }

  // -------------------------------------------------------------------
  // Helpers.
  // -------------------------------------------------------------------

  private transactionEnv(
    transaction: GitStagingTransaction,
    indexPath = transaction.indexPath,
    objectDirectory = transaction.objectsPath,
    alternates: readonly string[] = [resolve(transaction.identity.commonDir, "objects")],
  ): Readonly<Record<string, string>> {
    return {
      GIT_INDEX_FILE: indexPath,
      GIT_OBJECT_DIRECTORY: objectDirectory,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates.join(delimiter),
    };
  }

  private sameIdentity(a: GitRepositoryIdentity, b: GitRepositoryIdentity): boolean {
    return (
      a.workTree === b.workTree &&
      a.gitDir === b.gitDir &&
      a.commonDir === b.commonDir &&
      a.isLinkedWorktree === b.isLinkedWorktree
    );
  }

  private async readAttachedHead(
    operation: "add" | "commit",
    identity: GitRepositoryIdentity,
    transaction?: GitStagingTransaction,
  ): Promise<
    | { readonly ok: true; readonly refName: string; readonly oid: string }
    | { readonly ok: false; readonly disposition: GitBrokerDisposition }
  > {
    const options = {
      sideEffectBegun: false,
      ...(transaction === undefined
        ? {}
        : {
            transactionRoot: transaction.root,
            refName: transaction.refName,
            env: this.transactionEnv(transaction),
          }),
    };
    const symbolic = await this.execInternal(
      operation,
      identity,
      ["symbolic-ref", "--quiet", "HEAD"],
      identity.workTree,
      options,
    );
    const refName = symbolic.stdout?.trim() ?? "";
    if (!symbolic.ok || !refName.startsWith("refs/heads/")) {
      return {
        ok: false,
        disposition: this.deny(
          operation,
          "deny-detached-head",
          "broker add/commit requires an attached symbolic HEAD under refs/heads/",
        ),
      };
    }
    const resolved = await this.execInternal(
      operation,
      identity,
      ["rev-parse", "--verify", "HEAD"],
      identity.workTree,
      options,
    );
    const oid = resolved.stdout?.trim() ?? "";
    if (!resolved.ok || !/^[0-9a-f]{40,64}$/.test(oid)) {
      return { ok: false, disposition: resolved };
    }
    return { ok: true, refName, oid };
  }

  private async ensureTransaction(
    identity: GitRepositoryIdentity,
  ): Promise<GitBrokerDisposition> {
    if (this.transaction !== undefined) {
      if (!this.sameIdentity(identity, this.transaction.identity)) {
        return this.deny("add", "deny-repo-identity-mismatch", "repository identity changed");
      }
      return this.ok("add", "existing broker staging transaction is ready", {});
    }

    const attached = await this.readAttachedHead("add", identity);
    if (!attached.ok) return attached.disposition;
    const realIndexPath = resolve(identity.gitDir, "index");
    if (!existsSync(realIndexPath)) {
      return this.deny(
        "add",
        "deny-preexisting-staged",
        "repository real index is missing; broker requires an index clean/equal to HEAD",
      );
    }

    const clean = await this.execInternal(
      "add",
      identity,
      ["diff-index", "--cached", "--quiet", attached.oid, "--"],
      identity.workTree,
      { sideEffectBegun: false },
    );
    if (!clean.ok) {
      if (clean.exitCode === 1) {
        return this.deny(
          "add",
          "deny-preexisting-staged",
          "repository index contains pre-existing staged state; broker will not consume it",
        );
      }
      return clean;
    }

    const transaction = allocateTransaction(
      identity,
      attached.oid,
      attached.refName,
      hashFile(realIndexPath),
    );
    const seeded = await this.execInternal(
      "add",
      identity,
      ["read-tree", attached.oid],
      identity.workTree,
      {
        sideEffectBegun: false,
        transactionRoot: transaction.root,
        env: this.transactionEnv(transaction),
      },
    );
    if (!seeded.ok) {
      cleanupTransaction(transaction);
      return seeded;
    }
    this.transaction = transaction;
    return this.ok("add", "created broker-owned index seeded from captured HEAD", {});
  }

  private async verifyTransactionStillCurrent(
    transaction: GitStagingTransaction,
    operation: "add" | "commit",
  ): Promise<GitBrokerDisposition> {
    const attached = await this.readAttachedHead(operation, transaction.identity, transaction);
    if (!attached.ok) {
      cleanupTransaction(transaction);
      this.transaction = undefined;
      return attached.disposition;
    }
    if (attached.refName !== transaction.refName || attached.oid !== transaction.headOid) {
      cleanupTransaction(transaction);
      this.transaction = undefined;
      return this.deny(
        operation,
        "deny-ref-drift",
        `HEAD/ref drifted after staging began: captured ${transaction.refName}=${transaction.headOid}, current ${attached.refName}=${attached.oid}`,
      );
    }
    const realIndexPath = resolve(transaction.identity.gitDir, "index");
    if (hashFile(realIndexPath) !== transaction.initialRealIndexHash) {
      cleanupTransaction(transaction);
      this.transaction = undefined;
      return this.deny(
        operation,
        "deny-index-drift",
        "real repository index changed after staging began; broker transaction discarded",
      );
    }
    return this.ok(operation, "captured HEAD/ref/index remain coherent", {});
  }

  private reversibleAddFailure(
    disposition: GitBrokerDisposition,
    candidateIndex: string,
    callObjects: string,
  ): GitBrokerDisposition {
    rmSync(candidateIndex, { force: true });
    rmSync(callObjects, { recursive: true, force: true });
    return {
      ...disposition,
      sideEffectStarted: false,
      retrySafe: true,
      reason: "exec-known-failure",
      message: `add call rolled back its candidate index and quarantine: ${disposition.message}`,
    };
  }

  /**
   * Convert a `GitPreflightError` into a typed deny disposition.
   * The preflight reason maps 1:1 to a disposition reason.
   */
  private preflightDeny(operation: GitOperation, err: unknown): GitBrokerDisposition {
    if (err instanceof GitPreflightError) {
      return this.deny(operation, err.reason, err.message);
    }
    return this.deny(operation, "deny-repo-identity-mismatch", `unexpected preflight error: ${String(err)}`);
  }

  /**
   * Remove broker-created artifact paths, returning any that could
   * not be removed. Best-effort; never throws.
   */
  private cleanBrokerArtifacts(paths: readonly string[]): string[] {
    const residuals: string[] = [];
    for (const p of paths) {
      try {
        rmSync(p, { force: true, recursive: true });
      } catch {
        residuals.push(p);
      }
    }
    return residuals;
  }
}
