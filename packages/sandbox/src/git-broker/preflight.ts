/**
 * D440 Phase 2 — Git broker preflight: canonicalize identity and
 * reject every Git-controlled execution / path-escape surface before
 * any mutation.
 *
 * The preflight is PURE FILESYSTEM — it spawns NO Git subprocess.
 * This is deliberate: canonicalizing identity via `git rev-parse`
 * would require a sandbox profile scoped to the (still-unknown)
 * git-dir, a chicken-and-egg that either leaks read access outside
 * granted roots or fails for linked worktrees. Instead the broker
 * reads `.git` (file or dir), `.gitmodules`, `objects/info/alternates`,
 * and the local `config` directly. The first Git subprocess the
 * broker ever spawns is the operation itself, by which point the
 * identity is canonical and the per-operation profile is correctly
 * scoped.
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { GitRepositoryIdentity } from "./types";

/**
 * Raised when preflight cannot establish a safe, canonical
 * repository identity. The broker converts these into typed
 * `deny-*` dispositions at the call boundary.
 */
export class GitPreflightError extends Error {
  readonly reason:
    | "deny-repo-identity-mismatch"
    | "deny-alternates"
    | "deny-submodules"
    | "deny-escaping-symlink"
    | "deny-config-unsafe"
    | "deny-alias"
    | "deny-live-env"
    | "deny-pathspec-magic"
    | "deny-pathspec-outside-target"
    | "deny-target-not-empty"
    | "deny-target-symlink"
    | "deny-target-outside-grant"
    | "deny-path-not-regular"
    | "deny-add-bounds"
    | "deny-invalid-message";
  constructor(reason: GitPreflightError["reason"], message: string) {
    super(message);
    this.name = "GitPreflightError";
    this.reason = reason;
  }
}

/** Realpath-or-throw. Preflight must FAIL when identity paths do not
 *  exist on disk — a grant to a non-existent repo is not authority. */
function realpathOrThrow(p: string, label: string): string {
  try {
    return realpathSync(p);
  } catch (err) {
    throw new GitPreflightError(
      "deny-repo-identity-mismatch",
      `${label} does not resolve to a real path: ${p} (${String(err)})`,
    );
  }
}

/**
 * Resolve the canonical repository identity for a working tree by
 * reading `.git` directly (no subprocess). For a regular repo,
 * `.git` is a directory and is both git-dir and common-dir. For a
 * linked worktree, `.git` is a file containing `gitdir: <path>`
 * pointing at `<commonDir>/worktrees/<name>`; the common-dir is two
 * levels up from that.
 *
 * Returns the worktree, git-dir, common-dir, and whether the
 * working tree is a linked worktree.
 */
export function canonicalizeRepositoryIdentity(
  workTree: string,
): GitRepositoryIdentity {
  const realWorkTree = realpathOrThrow(workTree, "repository");
  const st = statSync(realWorkTree);
  if (!st.isDirectory()) {
    throw new GitPreflightError(
      "deny-repo-identity-mismatch",
      `repository is not a directory: ${realWorkTree}`,
    );
  }

  const dotGit = resolve(realWorkTree, ".git");
  let dotGitStat;
  try {
    dotGitStat = lstatSync(dotGit);
  } catch (err) {
    throw new GitPreflightError(
      "deny-repo-identity-mismatch",
      `repository has no .git entry: ${dotGit} (${String(err)})`,
    );
  }

  if (dotGitStat.isDirectory()) {
    // Regular repo: .git is both git-dir and common-dir.
    const gitDir = realpathOrThrow(dotGit, "git-dir");
    return {
      workTree: realWorkTree,
      gitDir,
      commonDir: gitDir,
      isLinkedWorktree: false,
    };
  }

  if (!dotGitStat.isFile()) {
    throw new GitPreflightError(
      "deny-repo-identity-mismatch",
      `.git is neither a directory nor a file: ${dotGit}`,
    );
  }

  // Linked worktree: read `gitdir: <path>`.
  let content: string;
  try {
    content = readFileSync(dotGit, "utf8");
  } catch (err) {
    throw new GitPreflightError(
      "deny-repo-identity-mismatch",
      `failed to read .git file: ${dotGit} (${String(err)})`,
    );
  }
  const match = content.match(/^gitdir:\s*(.+?)\s*$/m);
  if (match === null || match[1] === undefined) {
    throw new GitPreflightError(
      "deny-repo-identity-mismatch",
      `.git file is not a valid gitdir pointer: ${dotGit}`,
    );
  }
  const rawGitDir = match[1];
  const absGitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(realWorkTree, rawGitDir);
  const gitDir = realpathOrThrow(absGitDir, "git-dir");
  // common-dir is two levels up from <commonDir>/worktrees/<name>.
  const worktreesRoot = resolve(gitDir, ".."); // <commonDir>/worktrees
  const commonDir = realpathOrThrow(resolve(worktreesRoot, ".."), "common-dir");

  // Sanity: gitDir must sit under <commonDir>/worktrees/<name>.
  const expectedPrefix = resolve(commonDir, "worktrees") + sep;
  if (!(gitDir + sep).startsWith(expectedPrefix)) {
    throw new GitPreflightError(
      "deny-repo-identity-mismatch",
      `linked worktree git-dir is not under <commonDir>/worktrees: ${gitDir} (common=${commonDir})`,
    );
  }

  // A linked worktree's metadata contains a reciprocal `gitdir` backlink
  // to the worktree's `.git` file. Require that exact round trip before the
  // broker treats an out-of-tree common-dir as repository metadata. Without
  // this proof, a writable folder could forge a `.git` pointer into an
  // unrelated repository and gain read authority over its object database.
  const backlinkPath = resolve(gitDir, "gitdir");
  let backlink: string;
  try {
    backlink = readFileSync(backlinkPath, "utf8").trim();
  } catch (err) {
    throw new GitPreflightError(
      "deny-repo-identity-mismatch",
      `linked worktree metadata has no readable gitdir backlink: ${backlinkPath} (${String(err)})`,
    );
  }
  const absoluteBacklink = isAbsolute(backlink)
    ? backlink
    : resolve(gitDir, backlink);
  const expectedBacklink = dotGit;
  if (resolve(absoluteBacklink) !== expectedBacklink) {
    throw new GitPreflightError(
      "deny-repo-identity-mismatch",
      `linked worktree gitdir backlink does not match the selected worktree: ${absoluteBacklink} (expected=${expectedBacklink})`,
    );
  }

  return {
    workTree: realWorkTree,
    gitDir,
    commonDir,
    isLinkedWorktree: true,
  };
}

/**
 * True iff `target` is equal to `root` or sits under `root` + sep.
 * Token-boundary check — prevents `/foo` matching `/foobar`.
 */
export function isUnderRoot(target: string, root: string): boolean {
  if (target === root) return true;
  const sep = root.endsWith("/") ? "" : "/";
  return target.startsWith(root + sep);
}

/**
 * Verify `target` is a real, empty directory inside one of the
 * granted roots and is not a symlink. Used by worktree-add
 * preflight.
 */
export function validateWorktreeTarget(
  target: string,
  grantedRoots: readonly string[],
): { target: string } {
  let realTarget: string;
  try {
    realTarget = realpathSync(target);
  } catch (err) {
    throw new GitPreflightError(
      "deny-target-not-empty",
      `worktree target does not resolve: ${target} (${String(err)})`,
    );
  }
  // Reject symlink targets: realpath resolves the link, but the
  // *entry* must not be a symlink (an escaping link could point in
  // and then be repointed). lstat the original path.
  try {
    const lst = lstatSync(target);
    if (lst.isSymbolicLink()) {
      throw new GitPreflightError(
        "deny-target-symlink",
        `worktree target is a symlink: ${target}`,
      );
    }
  } catch (err) {
    throw new GitPreflightError(
      "deny-target-not-empty",
      `worktree target lstat failed: ${target} (${String(err)})`,
    );
  }

  const granted = grantedRoots.some((r) => isUnderRoot(realTarget, r));
  if (!granted) {
    throw new GitPreflightError(
      "deny-target-outside-grant",
      `worktree target outside granted roots: ${realTarget}`,
    );
  }

  const st = statSync(realTarget);
  if (!st.isDirectory()) {
    throw new GitPreflightError(
      "deny-target-not-empty",
      `worktree target is not a directory: ${realTarget}`,
    );
  }
  // Empty = no entries (allow `.`/`..` only). A non-empty target is
  // an overwrite/escape risk.
  let entries: string[];
  try {
    entries = readdirSync(realTarget);
  } catch (err) {
    throw new GitPreflightError(
      "deny-target-not-empty",
      `worktree target readdir failed: ${realTarget} (${String(err)})`,
    );
  }
  if (entries.length > 0) {
    throw new GitPreflightError(
      "deny-target-not-empty",
      `worktree target is not empty: ${realTarget} (${entries.length} entries)`,
    );
  }
  return { target: realTarget };
}

/**
 * Reject `objects/info/alternates` (or the `GIT_ALTERNATE_OBJECT_DIRECTORIES`
 * equivalent) when any alternate target is not separately granted.
 * The broker reads the alternates file directly (no subprocess) so
 * the check cannot be bypassed by config.
 */
export function rejectAlternates(
  identity: GitRepositoryIdentity,
  grantedRoots: readonly string[],
): void {
  const alternatesPath = resolve(identity.commonDir, "objects", "info", "alternates");
  if (!existsSync(alternatesPath)) return;
  let content: string;
  try {
    content = readFileSync(alternatesPath, "utf8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const alt = line.trim();
    if (alt.length === 0) continue;
    const abs = isAbsolute(alt) ? alt : resolve(identity.commonDir, alt);
    let realAlt: string;
    try {
      realAlt = realpathSync(abs);
    } catch {
      // An alternate that does not resolve is itself suspicious —
      // reject rather than ignore.
      throw new GitPreflightError(
        "deny-alternates",
        `objects/info/alternates references an unresolvable path: ${alt}`,
      );
    }
    const granted = grantedRoots.some((r) => isUnderRoot(realAlt, r)) ||
      isUnderRoot(realAlt, identity.workTree);
    if (!granted) {
      throw new GitPreflightError(
        "deny-alternates",
        `objects/info/alternates references an ungranted path: ${realAlt}`,
      );
    }
  }
}

/**
 * Reject recursive submodules. The broker treats gitlinks as inert
 * index entries but never clones, fetches, updates, or recurses
 * into submodules. A `.gitmodules` file with one or more
 * `[submodule "..."]` sections is denied because `git worktree add`
 * would materialize their gitlinks and the broker does not authorize
 * submodule object stores.
 *
 * Reads `.gitmodules` directly from the working tree (no
 * subprocess). For a linked worktree, `.gitmodules` lives in the
 * worktree itself; for a regular repo it lives at the repo root.
 */
export function rejectSubmodules(identity: GitRepositoryIdentity): void {
  const gitmodules = resolve(identity.workTree, ".gitmodules");
  if (!existsSync(gitmodules)) return;
  let content: string;
  try {
    content = readFileSync(gitmodules, "utf8");
  } catch {
    return;
  }
  // A `[submodule "name"]` section header indicates an active
  // submodule. The broker does not parse path/url — presence is a
  // deny.
  if (/^\s*\[submodule\s+/.test(content) || /\n\s*\[submodule\s+/.test(content)) {
    const count = (content.match(/\[submodule\s+/g) ?? []).length;
    throw new GitPreflightError(
      "deny-submodules",
      `repository has active submodules (.gitmodules defines ${count} submodule section(s)); broker never recurses into submodules`,
    );
  }
}

/**
 * Reject pathspec magic (`:(magic)`, `:!`, `:^`, `:/`, `:`, glob
 * `**`) and any pathspec that escapes the target root after
 * normalization. The broker only accepts plain, normalized,
 * in-target relative paths.
 */
export function normalizePathspec(
  raw: string,
  targetRoot: string,
): string {
  // Reject any pathspec magic sigil. Git magic begins with `:(...)`
  // or uses the short forms `!`, `^`, `:` at the start of a token.
  if (raw.startsWith(":")) {
    throw new GitPreflightError(
      "deny-pathspec-magic",
      `pathspec magic is forbidden: ${raw}`,
    );
  }
  if (raw === "" ) {
    throw new GitPreflightError(
      "deny-pathspec-magic",
      "empty pathspec is forbidden",
    );
  }
  // Reject absolute paths and parent-traversal segments. We do not
  // resolve symlinks here — the per-operation sandbox profile
  // denies escaping symlinks at the filesystem layer; this check
  // rejects the lexical escape before we even build the profile.
  if (isAbsolute(raw)) {
    throw new GitPreflightError(
      "deny-pathspec-outside-target",
      `absolute pathspec is forbidden: ${raw}`,
    );
  }
  const normalized = resolve(targetRoot, raw);
  const rel = relative(targetRoot, normalized);
  if (rel.startsWith("..") || rel === ".." || isAbsolute(rel)) {
    throw new GitPreflightError(
      "deny-pathspec-outside-target",
      `pathspec escapes target root: ${raw} -> ${normalized}`,
    );
  }
  // Reject glob `**` (pathspec glob magic) — the broker accepts only
  // explicit, bounded paths.
  if (raw.includes("**")) {
    throw new GitPreflightError(
      "deny-pathspec-magic",
      `glob pathspec is forbidden: ${raw}`,
    );
  }
  return normalized;
}

/**
 * Reject a live `.env` pathspec or target. The broker never reads,
 * stages, checks out, or materializes live secret variants even
 * when tracked. Public templates (`.example`/`.sample`/`.template`/
 * `.dist` terminal suffix) are allowed as public data.
 */
export function rejectLiveEnvPath(absPath: string): void {
  const base = absPath.split(sep).pop() ?? absPath;
  // Live secret variants: `.env`, `.env.local`, `.env.production`, ...
  // Match `.env` exactly or `.env` followed by a non-empty suffix
  // that is NOT one of the public template terminals.
  if (base === ".env" || /^\.env\.[^/]+$/.test(base)) {
    const suffix = base.slice(".env".length); // "" or ".local" etc.
    if (
      suffix === "" ||
      !/\.(example|sample|template|dist)$/.test(suffix)
    ) {
      throw new GitPreflightError(
        "deny-live-env",
        `live secret variant is forbidden: ${absPath}`,
      );
    }
  }
}

/**
 * Reject escaping symlinks under a directory. Walks the directory
 * one level (the broker does not follow into subdirectories — the
 * sandbox profile denies symlink escapes at the fs layer; this is
 * the lexical preflight that rejects a top-level link pointing
 * outside the granted root). Used for the repository working tree
 * and worktree targets.
 */
export function rejectEscapingSymlinks(
  root: string,
  grantedRoots: readonly string[],
): void {
  if (!existsSync(root)) return;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = resolve(root, entry);
    let lst;
    try {
      lst = lstatSync(p);
    } catch {
      continue;
    }
    if (!lst.isSymbolicLink()) continue;
    let linkTarget: string;
    try {
      linkTarget = readlinkSync(p);
    } catch {
      continue;
    }
    let real: string;
    try {
      real = realpathSync(p);
    } catch {
      // A broken symlink is itself suspicious in a granted repo —
      // reject to avoid a future repoint creating an escape.
      throw new GitPreflightError(
        "deny-escaping-symlink",
        `symlink does not resolve: ${p} -> ${linkTarget}`,
      );
    }
    const granted = grantedRoots.some((r) => isUnderRoot(real, r)) ||
      isUnderRoot(real, root);
    if (!granted) {
      throw new GitPreflightError(
        "deny-escaping-symlink",
        `symlink escapes granted roots: ${p} -> ${real}`,
      );
    }
  }
}

/**
 * Audit the repository's local config for execution-bearing keys
 * WITHOUT executing anything. The broker IGNORES system/global
 * config (it sets `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`,
 * `GIT_CONFIG_SYSTEM=/dev/null`, and `HOME=<broker scratch>` at exec
 * time). Local config that would re-introduce process execution is
 * rejected:
 *   - any `core.hooksPath` (the broker overrides it to empty at exec
 *     time, but a repo that configured one is signaling it expects
 *     hooks to run — surface as a deny);
 *   - any defined `filter.*`, `diff.*` (textconv/external), or
 *     `merge.*` driver (the broker disables these at exec time via
 *     `-c` overrides, but a defined driver means the repo EXPECTS a
 *     process to run — reject);
 *   - any `alias.*` (the broker never dispatches aliases; flag so
 *     the operator knows the broker will ignore them).
 *
 * Reads `<commonDir>/config` directly (no subprocess). A simple
 * line-based scan is sufficient for detection — the broker does not
 * need to fully parse git config, only to detect these specific
 * execution-bearing keys.
 */
export function auditLocalConfig(identity: GitRepositoryIdentity): void {
  const configPath = resolve(identity.commonDir, "config");
  if (!existsSync(configPath)) return;
  let content: string;
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
    return;
  }
  const lines = content.split("\n");

  // Section header tracking: `[core]`, `[filter "lfs"]`, `[alias]`, etc.
  let section = "";
  const hooksPathValues: string[] = [];
  const driverKeys: string[] = [];
  const aliasKeys: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    const secMatch = line.match(/^\[(\w+)(?:\s+"([^"]*)")?\]$/);
    if (secMatch !== null) {
      section = secMatch[1] ?? "";
      continue;
    }
    // key = value
    const kvMatch = line.match(/^([a-zA-Z0-9-]+)\s*=\s*(.*)$/);
    if (kvMatch === null) continue;
    const key = kvMatch[1] ?? "";
    const value = kvMatch[2] ?? "";
    if (section === "core" && key === "hooksPath") {
      hooksPathValues.push(value.trim());
    } else if (section === "filter" || section === "diff" || section === "merge") {
      if (["clean", "smudge", "textconv", "driver", "name", "command", "external"].includes(key)) {
        driverKeys.push(`${section}.${key}`);
      }
    } else if (section === "alias") {
      aliasKeys.push(key);
    }
  }

  if (hooksPathValues.length > 0) {
    throw new GitPreflightError(
      "deny-config-unsafe",
      `local config sets core.hooksPath; broker disables hooks but will not run a repo that expects them: ${hooksPathValues.join(", ")}`,
    );
  }
  if (driverKeys.length > 0) {
    throw new GitPreflightError(
      "deny-config-unsafe",
      `local config defines a filter/diff/merge driver; broker never executes config-selected processes: ${driverKeys.join(", ")}`,
    );
  }
  if (aliasKeys.length > 0) {
    throw new GitPreflightError(
      "deny-alias",
      `local config defines aliases; broker never dispatches aliases: ${aliasKeys.length} alias(es)`,
    );
  }
}
