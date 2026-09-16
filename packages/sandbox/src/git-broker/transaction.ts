/**
 * D440 Phase 2 — broker-owned plumbing transaction filesystem helpers.
 *
 * Git subprocess orchestration stays in broker.ts. This module owns the
 * reversible filesystem artifacts: the temporary index, quarantined loose
 * objects, bounded selected-file reads, object promotion, and atomic real
 * index installation after the ref CAS succeeds.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { GitPreflightError, isUnderRoot, rejectLiveEnvPath } from "./preflight";
import type { GitRepositoryIdentity } from "./types";

const MAX_ADD_PATHS = 256;
const MAX_ADD_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ADD_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_COMMIT_MESSAGE_BYTES = 64 * 1024;

export interface GitStagingTransaction {
  readonly root: string;
  readonly indexPath: string;
  readonly objectsPath: string;
  readonly headOid: string;
  readonly refName: string;
  readonly initialRealIndexHash: string;
  readonly identity: GitRepositoryIdentity;
}

export type SelectedChange =
  | {
      readonly kind: "file";
      readonly absolutePath: string;
      readonly relativePath: string;
      readonly mode: "100644" | "100755";
      readonly contents: Buffer;
    }
  | {
      readonly kind: "delete";
      readonly absolutePath: string;
      readonly relativePath: string;
    };

export function allocateTransaction(
  identity: GitRepositoryIdentity,
  headOid: string,
  refName: string,
  initialRealIndexHash: string,
): GitStagingTransaction {
  // Keep broker artifacts beneath the already-authorized worktree. On macOS,
  // os.tmpdir() resolves through /private/var/...; Git canonicalizes that
  // ancestor and Seatbelt rejects it even when the leaf was listed writable.
  // A mode-0700 hidden directory inside the exact granted repository remains
  // bounded by the same authority and is removed on every known outcome.
  const root = mkdtempSync(join(identity.workTree, ".nautilo-git-transaction-"));
  chmodSync(root, 0o700);
  const objectsPath = join(root, "objects");
  mkdirSync(objectsPath, { recursive: true, mode: 0o700 });
  return {
    root,
    indexPath: join(root, "index"),
    objectsPath,
    headOid,
    refName,
    initialRealIndexHash,
    identity,
  };
}

export function cleanupTransaction(transaction: GitStagingTransaction): void {
  rmSync(transaction.root, { recursive: true, force: true });
}

export function hashFile(path: string): string {
  if (!existsSync(path)) return "<missing>";
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function validateCommitMessage(message: string): Buffer {
  if (message.length === 0 || message.trim().length === 0) {
    throw new GitPreflightError("deny-invalid-message", "commit message must not be empty");
  }
  if (message.includes("\0")) {
    throw new GitPreflightError("deny-invalid-message", "commit message must not contain NUL");
  }
  const bytes = Buffer.from(message, "utf8");
  if (bytes.toString("utf8") !== message) {
    throw new GitPreflightError("deny-invalid-message", "commit message must be valid UTF-8");
  }
  if (bytes.length > MAX_COMMIT_MESSAGE_BYTES) {
    throw new GitPreflightError(
      "deny-invalid-message",
      `commit message exceeds ${MAX_COMMIT_MESSAGE_BYTES} UTF-8 bytes`,
    );
  }
  return bytes;
}

function rejectSecretPath(path: string): void {
  for (const component of path.split(sep)) {
    rejectLiveEnvPath(component);
    if (
      component === ".secret" ||
      component === ".secrets" ||
      component === "credentials" ||
      component === "credentials.json"
    ) {
      throw new GitPreflightError(
        "deny-live-env",
        `live secret path is forbidden: ${path}`,
      );
    }
  }
}

/**
 * Validate and read every selected path before any Git mutation begins.
 * Missing paths are returned as deletion candidates; broker.ts verifies
 * they are present in the broker index before accepting the add call.
 */
export function readSelectedChanges(
  rawPaths: readonly string[],
  identity: GitRepositoryIdentity,
): readonly SelectedChange[] {
  if (rawPaths.length === 0 || rawPaths.length > MAX_ADD_PATHS) {
    throw new GitPreflightError(
      "deny-add-bounds",
      `add requires 1..${MAX_ADD_PATHS} explicit paths`,
    );
  }

  const seen = new Set<string>();
  const selected: SelectedChange[] = [];
  let totalBytes = 0;

  for (const raw of rawPaths) {
    if (raw.startsWith(":") || raw.includes("**")) {
      throw new GitPreflightError("deny-pathspec-magic", `pathspec magic is forbidden: ${raw}`);
    }
    const absolutePath = resolve(identity.workTree, raw);
    const rel = relative(identity.workTree, absolutePath);
    if (
      rel.length === 0 ||
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      !isUnderRoot(absolutePath, identity.workTree)
    ) {
      throw new GitPreflightError(
        "deny-pathspec-outside-target",
        `selected path escapes or names the worktree root: ${raw}`,
      );
    }
    const relativePath = rel.split(sep).join("/");
    const rawPortable = raw.split(sep).join("/");
    if (
      rawPortable !== relativePath ||
      rawPortable.startsWith("./") ||
      rawPortable.split("/").some((component) => component === "." || component === "..")
    ) {
      throw new GitPreflightError(
        "deny-pathspec-outside-target",
        `selected path must already be canonical worktree-relative form: ${raw}`,
      );
    }
    if (seen.has(relativePath)) {
      throw new GitPreflightError("deny-add-bounds", `duplicate selected path: ${relativePath}`);
    }
    seen.add(relativePath);
    rejectSecretPath(relativePath);

    let stat;
    try {
      stat = lstatSync(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        selected.push({ kind: "delete", absolutePath, relativePath });
        continue;
      }
      throw new GitPreflightError(
        "deny-pathspec-outside-target",
        `cannot inspect selected path ${relativePath}: ${String(error)}`,
      );
    }
    if (stat.isSymbolicLink()) {
      throw new GitPreflightError("deny-escaping-symlink", `selected path is a symlink: ${relativePath}`);
    }
    if (!stat.isFile()) {
      throw new GitPreflightError(
        "deny-path-not-regular",
        `selected path is not a regular file: ${relativePath}`,
      );
    }
    if (stat.size > MAX_ADD_FILE_BYTES || totalBytes + stat.size > MAX_ADD_TOTAL_BYTES) {
      throw new GitPreflightError(
        "deny-add-bounds",
        `selected files exceed add bounds (${MAX_ADD_FILE_BYTES} bytes/file, ${MAX_ADD_TOTAL_BYTES} bytes total)`,
      );
    }

    const fd = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
        throw new GitPreflightError(
          "deny-path-not-regular",
          `selected path changed during preflight: ${relativePath}`,
        );
      }
      const contents = readFileSync(fd);
      if (contents.length !== opened.size || contents.length > MAX_ADD_FILE_BYTES) {
        throw new GitPreflightError(
          "deny-add-bounds",
          `selected path changed size during read: ${relativePath}`,
        );
      }
      totalBytes += contents.length;
      selected.push({
        kind: "file",
        absolutePath,
        relativePath,
        mode: (opened.mode & 0o111) === 0 ? "100644" : "100755",
        contents,
      });
    } finally {
      closeSync(fd);
    }
  }
  return selected;
}

export function createCandidateIndex(transaction: GitStagingTransaction): string {
  const candidate = join(transaction.root, `index-candidate-${randomUUID()}`);
  copyFileSync(transaction.indexPath, candidate, constants.COPYFILE_EXCL);
  return candidate;
}

export function createCallQuarantine(transaction: GitStagingTransaction): string {
  const path = join(transaction.root, `objects-call-${randomUUID()}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function looseObjectFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  for (const prefix of readdirSync(root)) {
    if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
    const directory = join(root, prefix);
    if (!statSync(directory).isDirectory()) continue;
    for (const suffix of readdirSync(directory)) {
      // SHA-1 loose objects use 2+38 hex; SHA-256 uses 2+62.
      if (/^(?:[0-9a-f]{38}|[0-9a-f]{62})$/.test(suffix)) {
        result.push(join(prefix, suffix));
      }
    }
  }
  return result;
}

/**
 * Copy content-addressed loose objects from one broker-owned quarantine to
 * another. Existing objects are immutable and therefore safely reused.
 */
export function mergeQuarantineObjects(source: string, destination: string): void {
  const created: string[] = [];
  try {
    for (const relativeObject of looseObjectFiles(source)) {
      const sourcePath = join(source, relativeObject);
      const destinationPath = join(destination, relativeObject);
      mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
      if (existsSync(destinationPath)) continue;
      copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL);
      created.push(destinationPath);
    }
  } catch (error) {
    for (const path of created) rmSync(path, { force: true });
    throw error;
  }
}

/**
 * Promote quarantined loose objects into the repository object store.
 * Each object is installed with an exclusive temporary file + atomic rename.
 * Existing content-addressed objects are never replaced.
 */
export function promoteObjects(
  transaction: GitStagingTransaction,
): readonly string[] {
  const promoted: string[] = [];
  const objectStore = resolve(transaction.identity.commonDir, "objects");
  for (const relativeObject of looseObjectFiles(transaction.objectsPath)) {
    const sourcePath = join(transaction.objectsPath, relativeObject);
    const destinationPath = join(objectStore, relativeObject);
    mkdirSync(dirname(destinationPath), { recursive: true });
    if (existsSync(destinationPath)) continue;
    const temporaryPath = `${destinationPath}.nautilo-${randomUUID()}`;
    try {
      copyFileSync(sourcePath, temporaryPath, constants.COPYFILE_EXCL);
      const fd = openSync(temporaryPath, constants.O_RDONLY);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        // link(2) is atomic and refuses EEXIST, unlike rename(2) which
        // could replace an object created concurrently.
        linkSync(temporaryPath, destinationPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          unlinkSync(temporaryPath);
          continue;
        }
        throw error;
      }
      unlinkSync(temporaryPath);
      promoted.push(destinationPath);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }
  return promoted;
}

/**
 * Atomically replace the real index after the ref has moved. The exclusive
 * `.git/index.lock` is intentionally the final transaction boundary.
 */
export function installIndexAtomically(
  transaction: GitStagingTransaction,
): { readonly indexPath: string; readonly lockPath: string } {
  const indexPath = resolve(transaction.identity.gitDir, "index");
  const lockPath = `${indexPath}.lock`;
  const contents = readFileSync(transaction.indexPath);
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(lockPath, indexPath);
    return { indexPath, lockPath };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    throw Object.assign(new Error(`failed to install broker index: ${String(error)}`), {
      indexPath,
      lockPath,
    });
  }
}
