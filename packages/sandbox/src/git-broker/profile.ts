/**
 * D440 Phase 2 — operation-aware SBPL profile compiler for the Git
 * broker.
 *
 * This is the defense-in-depth layer. Even though the broker preflights
 * every operation and overrides every execution-bearing config key at
 * exec time, it ALSO compiles a per-operation macOS Seatbelt profile
 * that opens the NARROWEST `.git` subtree the operation needs. A broad
 * `.git/**` write exemption is forbidden; each operation gets exactly
 * the `.git` paths it must touch.
 *
 * Design choice: the broker reuses the PROVEN `buildSbplProfile` from
 * `seatbelt-profile.ts` as its base. That profile is already exercised
 * end-to-end by the Phase 0 baseline denial test (`git status` under
 * it completes in <200ms), and it already enforces the contract's
 * two load-bearing denies:
 *   - governance `.git` / `.gitignore` / `.claudeignore` WRITE deny
 *     (so no broad `.git/**` write exemption);
 *   - secret `.env*` READ+WRITE deny with the public-template
 *     (`.example`/`.sample`/`.template`/`.dist`) public-file carve-out.
 * The broker layers ONE broker-specific rule on top: for worktree
 * operations only, a NARROW `<commonDir>/worktrees/<name>/` write
 * carve-out emitted AFTER `buildSbplProfile`'s governance `.git`
 * deny so Seatbelt's later-wins re-opens only that subdir. Everything
 * else under `.git` stays denied by the governance deny.
 *
 * The broad READ surface (system paths, /tmp write, xcrun cache,
 * mach-lookups, network) is NOT the security boundary — the `.git`
 * WRITE narrowing and `.env` deny ARE. Reusing the proven base means
 * any real git (homebrew, Apple shim) runs without the hangs a
 * hand-rolled tighter base produced (denied mach-lookups / xcrun
 * cache / ancestor metadata made git block). Network egress is
 * allowed by the base exactly as it is for a generic shell command;
 * the broker's threat model is `.git`/`.env`, not network egress,
 * and git status/diff/worktree do not contact remotes.
 *
 * The profile is platform-specific (macOS Seatbelt). On Linux the
 * broker refuses to execute (returns `deny-platform-unsupported`)
 * until a bubblewrap profile compiler is added; preflight + profile
 * compilation themselves are platform-independent and unit-tested.
 */

import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

import type { GitOperation, GitRepositoryIdentity } from "./types";
import {
  buildSbplProfile,
  escapeSchemeString,
} from "../seatbelt-profile";
import type { SandboxConfig } from "../types";

export interface GitProfileInputs {
  readonly operation: GitOperation;
  readonly identity: GitRepositoryIdentity;
  /** Canonical worktree target (worktree-add / worktree-remove). */
  readonly target?: string;
  /** Registered worktree name (basename of target). */
  readonly worktreeName?: string;
  /** Broker-owned temporary index/quarantine root for add/commit. */
  readonly transactionRoot?: string;
  /** Captured attached symbolic ref for commit CAS. */
  readonly refName?: string;
  /** Git executable (read-only bind for execution). */
  readonly gitExecutable: string;
  /** Canonical deny-override roots inherited from the local binding. */
  readonly protectedPaths?: readonly string[];
}

function appendAncestorMetadataAllows(profile: string, raw: string): string {
  const paths: string[] = [];
  let current = resolve(raw);
  while (current !== dirname(current)) {
    paths.push(current);
    current = dirname(current);
  }
  let next = profile;
  for (const path of paths.reverse()) {
    next += `(allow file-read-metadata (literal "${escapeSchemeString(path)}"))\n`;
  }
  return next;
}

/**
 * Compile the per-operation SBPL profile. Deterministic for a given
 * input.
 *
 * - status / diff: `buildSbplProfile` with the repo as workspace and
 *   NO extra writable paths. Governance denies `.git` write; secret
 *   denies `.env*` in the repo. No `.git` write carve-out.
 * - worktree-add / worktree-remove: `buildSbplProfile` with the repo
 *   as workspace AND the target as a writable path (so the target is
 *   writable and `.env*` is denied in the target too), then a NARROW
 *   `<commonDir>/worktrees/<name>/` write carve-out appended AFTER
 *   the governance `.git` deny so only that subdir is re-opened.
 */
export function compileGitBrokerProfile(inputs: GitProfileInputs): string {
  const { operation, identity, gitExecutable } = inputs;
  const writesGit =
    operation === "worktree-add" || operation === "worktree-remove";
  const writesTransaction = operation === "add" || operation === "commit";

  // buildSbplProfile anchors secret denies to workspace + writablePaths.
  // For worktree ops, add the target as a writable path so (a) the
  // target is writable and (b) `.env*` is denied in the target.
  const writablePaths = [
    ...(writesGit && inputs.target !== undefined ? [inputs.target] : []),
    ...(writesTransaction && inputs.transactionRoot !== undefined
      ? [inputs.transactionRoot]
      : []),
  ];

  // Defensive dataDir deny — a unique non-existent path under tmpdir.
  // buildSbplProfile emits a deny for it regardless of existence; it
  // masks nothing real (the broker has no data store) but keeps the
  // deny-present invariant. NEVER the working tree or HOME.
  const dataDir = `${tmpdir()}/nautilo-git-broker-deny`;

  const config: SandboxConfig = {
    mode: "enabled",
    writablePaths,
    projectPaths: [],
    passthroughEnv: [],
    ...(inputs.protectedPaths?.length
      ? { protectedPaths: inputs.protectedPaths }
      : {}),
  };

  let profile = buildSbplProfile({
    workspace: identity.workTree,
    dataDir,
    toolsBin: dirname(gitExecutable),
    config,
  });

  // Selecting a genuine linked worktree implicitly selects the Git metadata
  // that Git registered for that worktree. Preflight proves the reciprocal
  // `<commonDir>/worktrees/<name>/gitdir -> <workTree>/.git` identity before
  // this profile is compiled, so grant read-only access to the common Git
  // metadata without granting any access to the primary checkout's files.
  // Writes remain denied except for the operation-specific narrow carve-outs
  // below.
  if (identity.isLinkedWorktree) {
    profile = appendAncestorMetadataAllows(profile, identity.commonDir);
    profile += `(allow file-read* (subpath "${escapeSchemeString(identity.commonDir)}"))\n`;
    // buildSbplProfile's generic worktree support allows common-dir writes.
    // The typed broker is stricter: close that broad write surface, then let
    // only the exact operation-specific carve-outs below reopen writes.
    profile += `(deny file-write* (subpath "${escapeSchemeString(identity.commonDir)}"))\n`;
    // The metadata traversal/read rules above are appended after the base
    // profile, so repeat local protected-path deny-overrides last.
    for (const protectedPath of inputs.protectedPaths ?? []) {
      profile += `(deny file-read* file-write* (subpath "${escapeSchemeString(protectedPath)}"))\n`;
    }
  }

  // --- Operation-specific NARROW `.git` WRITE carve-out (worktree
  // ops only). Emitted AFTER buildSbplProfile's governance `.git`
  // write deny so Seatbelt's later-wins re-opens ONLY the worktree
  // registry `<commonDir>/worktrees/`. We carve out the REGISTRY dir
  // (not just `<name>/`) because `git worktree add` must mkdir the
  // `<name>` entry under it, which requires write on the parent
  // `worktrees/` dir. This is still narrow — one specific `.git`
  // subdir (the worktree registry), NOT a broad `.git/**` write
  // exemption; everything else under `.git` stays denied by the
  // governance deny.
  if (writesGit) {
    const name = inputs.worktreeName;
    if (name !== undefined && name.length > 0) {
      const wtRegistry = `${identity.commonDir}/worktrees`;
      profile += `(allow file-read* file-write* (subpath "${escapeSchemeString(wtRegistry)}"))\n`;
    }
  }

  // `git update-ref` gets only the captured attached ref, its lock,
  // and the corresponding reflog paths. Object writes and the index
  // installation are performed by broker-owned filesystem code, so
  // commit never gets a broad `.git/**` write carve-out.
  if (operation === "commit" && inputs.refName !== undefined) {
    const refPath = `${identity.commonDir}/${inputs.refName}`;
    const refLogPath = `${identity.commonDir}/logs/${inputs.refName}`;
    const headLogPath = `${identity.gitDir}/logs/HEAD`;
    for (const path of [
      refPath,
      `${refPath}.lock`,
      refLogPath,
      `${refLogPath}.lock`,
      `${identity.gitDir}/HEAD`,
      `${identity.gitDir}/HEAD.lock`,
      headLogPath,
      `${headLogPath}.lock`,
    ]) {
      profile += `(allow file-read* file-write* (literal "${escapeSchemeString(path)}"))\n`;
    }
  }

  return profile;
}
