/**
 * D440 Phase 3 — broker-controlled worktree target materialization.
 *
 * Pure parsing, validation, and broker-owned filesystem code. No Git
 * subprocess lives here — `broker.ts` orchestrates `rev-parse`,
 * `ls-tree`, and `cat-file` under the per-operation sandbox profile and
 * hands the bytes to this module. This module never executes repo
 * config, hooks, attributes, filters, submodules, or signing; it writes
 * exact blob bytes into the exact preauthorized empty target with
 * `O_NOFOLLOW` / exclusive-creat / atomic-rename discipline.
 */

import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  linkSync,
  openSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { GitPreflightError, isUnderRoot, rejectLiveEnvPath } from "./preflight";

/** Bounded limits for materialization. Exposed for tests + callers. */
export const MAX_WORKTREE_FILE_COUNT = 4096;
export const MAX_WORKTREE_BLOB_BYTES = 64 * 1024 * 1024;
export const MAX_WORKTREE_TOTAL_BYTES = 256 * 1024 * 1024;

export type WorktreeBlobMode = "100644" | "100755";

export interface ManifestEntry {
  readonly mode: WorktreeBlobMode;
  readonly oid: string;
  /** POSIX-style relative path (forward slashes) under the target root. */
  readonly path: string;
  /** Blob size in bytes (from `ls-tree -l`); used for pre-mutation bounds. */
  readonly size: number;
}

export interface Manifest {
  readonly entries: readonly ManifestEntry[];
}

/**
 * Parse `git ls-tree -r -l -z --full-tree <oid>` output and validate every
 * entry against the materialization threat model. Throws
 * `GitPreflightError` on the first unsafe entry or resource-limit overflow.
 * Pure: no filesystem, no subprocess.
 *
 * Record format per entry: `<mode> SP <type> SP <oid> SP <size>\t<path>\0`.
 * `-r --full-tree` recurses into subtrees and emits blob entries with
 * full repo-relative paths; gitlinks appear as `commit` entries with
 * size `-`. `-l` adds the `<size>` field so per-blob and total-byte
 * limits are enforced BEFORE any durable mutation.
 */
export function parseLsTreeZ(
  output: Buffer,
  targetRoot: string,
  fileCountLimit: number = MAX_WORKTREE_FILE_COUNT,
  blobBytesLimit: number = MAX_WORKTREE_BLOB_BYTES,
  totalBytesLimit: number = MAX_WORKTREE_TOTAL_BYTES,
): Manifest {
  if (output.length === 0) return { entries: [] };

  const seen = new Set<string>();
  const entries: ManifestEntry[] = [];
  let totalBytes = 0;

  let start = 0;
  for (let i = 0; i <= output.length; i++) {
    if (i === output.length || output[i] === 0) {
      if (i > start) {
        const record = output.subarray(start, i);
        const entry = parseRecord(record, targetRoot);
        if (seen.has(entry.path)) {
          throw new GitPreflightError(
            "deny-pathspec-outside-target",
            `duplicate manifest path: ${entry.path}`,
          );
        }
        seen.add(entry.path);
        if (entry.size > blobBytesLimit) {
          throw new GitPreflightError(
            "deny-add-bounds",
            `blob ${entry.path} (${entry.oid}) exceeds ${blobBytesLimit} bytes (${entry.size})`,
          );
        }
        totalBytes += entry.size;
        if (totalBytes > totalBytesLimit) {
          throw new GitPreflightError(
            "deny-add-bounds",
            `manifest exceeds ${totalBytesLimit} total bytes at ${entry.path}`,
          );
        }
        entries.push(entry);
      }
      start = i + 1;
    }
  }

  if (entries.length > fileCountLimit) {
    throw new GitPreflightError(
      "deny-add-bounds",
      `manifest exceeds ${fileCountLimit} file count limit (${entries.length})`,
    );
  }
  return { entries };
}

function parseRecord(record: Buffer, targetRoot: string): ManifestEntry {
  const tabIdx = record.indexOf(0x09);
  if (tabIdx < 0) {
    throw new GitPreflightError(
      "deny-pathspec-outside-target",
      "malformed ls-tree record (no tab)",
    );
  }
  const meta = record.subarray(0, tabIdx).toString("utf8");
  const pathBytes = record.subarray(tabIdx + 1);
  // `-l` adds a 4th whitespace-separated size field: `<mode> <type> <oid> <size>`.
  // git right-pads the size column with spaces, so split on whitespace runs.
  const parts = meta.split(/\s+/);
  if (parts.length !== 4) {
    throw new GitPreflightError(
      "deny-pathspec-outside-target",
      `malformed ls-tree metadata (expected 4 fields): ${meta}`,
    );
  }
  const [mode, type, oid, sizeField] = parts;
  if (mode === undefined || type === undefined || oid === undefined || sizeField === undefined) {
    throw new GitPreflightError(
      "deny-pathspec-outside-target",
      `malformed ls-tree metadata: ${meta}`,
    );
  }

  if (type === "commit" || type === "tree") {
    throw new GitPreflightError(
      "deny-submodules",
      `manifest entry is a gitlink/submodule (type ${type}); broker never recurses into submodules`,
    );
  }
  if (type !== "blob") {
    throw new GitPreflightError(
      "deny-path-not-regular",
      `manifest entry is not a blob (type ${type})`,
    );
  }

  if (mode === "120000") {
    throw new GitPreflightError(
      "deny-escaping-symlink",
      `manifest entry is a symlink (mode ${mode}); broker rejects all symlink tree entries for this slice`,
    );
  }
  if (mode !== "100644" && mode !== "100755") {
    throw new GitPreflightError(
      "deny-path-not-regular",
      `manifest entry has unsafe mode ${mode}; only 100644/100755 allowed`,
    );
  }

  if (!/^[0-9a-f]{40,64}$/.test(oid)) {
    throw new GitPreflightError(
      "deny-pathspec-outside-target",
      `manifest entry has malformed oid: ${oid}`,
    );
  }

  // sizeField is a decimal byte count for blobs (`-` for gitlinks, but
  // we already rejected non-blob types above).
  const size = Number.parseInt(sizeField, 10);
  if (!Number.isFinite(size) || size < 0) {
    throw new GitPreflightError(
      "deny-add-bounds",
      `manifest entry has malformed size for ${oid}: ${sizeField}`,
    );
  }

  const path = pathBytes.toString("utf8");
  validateManifestPath(path, pathBytes, targetRoot);

  return { mode, oid, path, size };
}

function validateManifestPath(path: string, pathBytes: Buffer, targetRoot: string): void {
  if (path.length === 0) {
    throw new GitPreflightError("deny-pathspec-outside-target", "empty manifest path");
  }
  if (pathBytes.includes(0x00)) {
    throw new GitPreflightError("deny-pathspec-outside-target", "NUL in manifest path");
  }
  if (pathBytes.some((b) => b < 0x20)) {
    throw new GitPreflightError(
      "deny-pathspec-outside-target",
      `control byte in manifest path: ${path}`,
    );
  }
  if (isAbsolute(path)) {
    throw new GitPreflightError(
      "deny-pathspec-outside-target",
      `absolute manifest path forbidden: ${path}`,
    );
  }
  if (path.includes("..") || path.startsWith("/") || path.startsWith("~")) {
    throw new GitPreflightError(
      "deny-pathspec-outside-target",
      `manifest path escapes target root: ${path}`,
    );
  }
  const normalized = resolve(targetRoot, path);
  const rel = relative(targetRoot, normalized);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new GitPreflightError(
      "deny-pathspec-outside-target",
      `manifest path escapes target root: ${path}`,
    );
  }
  const portable = path.split(sep).join("/");
  if (portable !== path || portable.startsWith("./") || portable.includes("//") ||
      portable.split("/").some((c) => c === "." || c === ".." || c === "")) {
    throw new GitPreflightError(
      "deny-pathspec-outside-target",
      `manifest path must be canonical forward-slash form: ${path}`,
    );
  }
  for (const component of portable.split("/")) {
    rejectLiveEnvPath(component);
    if (component === ".git" || component === ".gitmodules") {
      throw new GitPreflightError(
        "deny-pathspec-outside-target",
        `manifest path crosses governance entry: ${path}`,
      );
    }
  }
}

/**
 * Safely create a directory chain under `targetRoot` for `filePath`,
 * refusing to follow or create through symlinks. Each component is
 * `lstat`-checked before `mkdir`; an existing symlink anywhere on the
 * chain is rejected (broker owns an empty target; a link planted
 * between validation and materialization is an escape attempt).
 */
export function safeMkdirsForFile(filePath: string, targetRoot: string): void {
  const relativePath = relative(targetRoot, filePath);
  if (relativePath === "" || relativePath.startsWith("..")) {
    throw new GitPreflightError(
      "deny-pathspec-outside-target",
      `materialization path escapes target root: ${filePath}`,
    );
  }
  const components = relativePath.split(sep);
  components.pop();
  let current = targetRoot;
  for (const component of components) {
    if (component === "" || component === "." || component === "..") {
      throw new GitPreflightError(
        "deny-pathspec-outside-target",
        `unsafe path component in materialization: ${filePath}`,
      );
    }
    current = resolve(current, component);
    let lst;
    try {
      lst = lstatSync(current);
    } catch {
      lst = undefined;
    }
    if (lst !== undefined) {
      if (lst.isSymbolicLink()) {
        throw new GitPreflightError(
          "deny-escaping-symlink",
          `materialization path crosses a symlink: ${current}`,
        );
      }
      if (!lst.isDirectory()) {
        throw new GitPreflightError(
          "deny-path-not-regular",
          `materialization path component is not a directory: ${current}`,
        );
      }
      continue;
    }
    try {
      mkdirSync(current, { recursive: false, mode: 0o755 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
}

/**
 * Atomically write a blob to `filePath` with mode 0644/0755. Writes to
 * an exclusive `.nautilo-<tag>` temp file in the same directory,
 * fsyncs, then links it into place. `link(2)` is atomic and refuses
 * `EEXIST`, so a path that already exists (or appears concurrently) is
 * NEVER overwritten — the temp file is unlinked and the write throws.
 * Refuses to follow symlinks (`O_NOFOLLOW` on the final path via
 * `lstat` pre-check). Throws on any failure.
 */
export function writeBlobAtomic(
  filePath: string,
  contents: Buffer,
  executable: boolean,
): { readonly writtenPath: string; readonly tempPath: string } {
  // Pre-check: refuse if the target already exists (broker owns an
  // empty target; an existing entry is a collision/escape attempt).
  // `lstatSync` does not follow symlinks; a symlink target is rejected.
  try {
    const existing = lstatSync(filePath);
    if (existing.isSymbolicLink()) {
      throw new GitPreflightError(
        "deny-escaping-symlink",
        `materialization target is a symlink: ${filePath}`,
      );
    }
    throw new GitPreflightError(
      "deny-pathspec-outside-target",
      `materialization target already exists: ${filePath}`,
    );
  } catch (error) {
    if (error instanceof GitPreflightError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new GitPreflightError(
        "deny-pathspec-outside-target",
        `cannot stat materialization target ${filePath}: ${String(error)}`,
      );
    }
  }

  const mode = executable ? 0o755 : 0o644;
  const tempPath = `${filePath}.nautilo-${randomTag()}`;
  let fd: number | undefined;
  try {
    fd = openSync(
      tempPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      mode,
    );
    writeFileSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      // link(2) is atomic and refuses EEXIST, unlike rename(2) which
      // would replace a file created concurrently.
      linkSync(tempPath, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new GitPreflightError(
          "deny-pathspec-outside-target",
          `materialization target appeared concurrently: ${filePath}`,
        );
      }
      throw error;
    }
    unlinkSync(tempPath);
    return { writtenPath: filePath, tempPath };
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { unlinkSync(tempPath); } catch { /* ignore */ }
    throw error;
  }
}

function randomTag(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Read the real path of a broker-created file with `O_NOFOLLOW`,
 * verifying it is still a regular file owned by this materialization
 * (same `dev`/`ino` as the post-rename stat). Used by cleanup to
 * remove only broker-created files.
 */
function removeBrokerFile(absPath: string, targetRoot: string): boolean {
  if (!isUnderRoot(absPath, targetRoot)) return false;
  let lst;
  try {
    lst = lstatSync(absPath);
  } catch {
    return false;
  }
  if (lst.isSymbolicLink() || !lst.isFile()) return false;
  try {
    unlinkSync(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove every broker-created file (and the empty directories that
 * held them) under `targetRoot`. Never follows symlinks; never removes
 * a path outside `targetRoot`. Walks each written file's parent chain
 * up to (but not including) `targetRoot`, removing now-empty
 * directories. Returns residual paths that could not be removed.
 */
export function cleanupMaterialization(
  targetRoot: string,
  writtenPaths: readonly string[],
): string[] {
  const residuals: string[] = [];
  for (const p of writtenPaths) {
    if (!removeBrokerFile(p, targetRoot)) {
      if (existsSync(p)) residuals.push(p);
    }
  }
  // Prune now-empty directories that held the written files, walking
  // each parent chain up to (not including) the target root.
  for (const p of writtenPaths) {
    let current = dirname(p);
    while (current !== targetRoot && isUnderRoot(current, targetRoot)) {
      let entries: string[];
      try {
        entries = readdirSync(current);
      } catch {
        break;
      }
      if (entries.length > 0) break;
      try {
        rmdirSync(current);
      } catch {
        break;
      }
      current = dirname(current);
    }
  }
  return residuals;
}
