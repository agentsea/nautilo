import {
  readFile,
  writeFile,
  appendFile,
  readdir,
  stat,
  unlink,
  rm,
  mkdir,
  access,
  realpath,
} from "node:fs/promises";
import { constants as fsConstants, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import {
  StorageError,
  StorageNotFoundError,
  StoragePathTraversalError,
  StoragePermissionError,
  type StorageFileStat,
  type StorageProvider,
  type StorageZoneName,
} from "./storage-provider";

/**
 * Plain-filesystem `StorageProvider`.
 *
 * Security model:
 *   - All callers pass paths RELATIVE to the zone root.
 *   - `resolveSafePath` rejects anything that would escape the root
 *     (traversal, absolute paths, null bytes, symlinks escaping after
 *     resolution). Failure = `StoragePathTraversalError`, not silent
 *     correction.
 *   - Zone root itself is resolved with `realpath` once at construction
 *     so we compare canonical absolute paths (defeats a root that's
 *     itself a symlink into somewhere unexpected, e.g. macOS
 *     /var/folders → /private/var/folders).
 *
 * Performance:
 *   - Zero-copy passthrough: `read` returns the buffer Node gives us,
 *     `write` accepts `Uint8Array | string` and passes straight
 *     through. No serialization, no encoding transforms.
 *
 * Not in this class (deliberately):
 *   - Encryption — `EncryptedStorageProvider` wraps this one (future).
 *   - Namespacing — `NamespacedStorageProvider` wraps this one
 *     (the planned multi-user lane).
 *   - Cloud backends — `S3StorageProvider` / `GCSStorageProvider`
 *     will be separate classes implementing the same interface.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly zone: StorageZoneName;
  readonly rootPath: string;
  // exactOptionalPropertyTypes: allow explicit undefined rather than
  // assigning undefined to a truly-optional property.
  readonly namespace: string | undefined;

  /**
   * @param zone      Canonical zone name (used in error messages).
   * @param rootPath  Absolute path to the zone root. MUST exist and
   *                  be a directory; construction does not verify
   *                  because `ensureDirectoryTree` runs before any
   *                  provider is created. Canonicalised via
   *                  `realpathSync` so downstream symlink comparisons
   *                  use the same form.
   * @param namespace Optional; recorded but unused in this
   *                  implementation. Multi-user wrappers layer it on.
   */
  constructor(zone: StorageZoneName, rootPath: string, namespace?: string) {
    if (!isAbsolute(rootPath)) {
      throw new StorageError(
        zone,
        "",
        `rootPath must be absolute (got: ${rootPath})`,
      );
    }
    const absolute = normalize(resolve(rootPath));
    let canonical: string;
    try {
      canonical = realpathSync(absolute);
    } catch {
      // Root doesn't exist yet. `ensureDirectoryTree` runs BEFORE any
      // provider is constructed so this shouldn't happen in practice,
      // but falling back to the normalised path keeps tests that mock
      // roots working and defers the real check to the first I/O call.
      canonical = absolute;
    }
    this.zone = zone;
    this.rootPath = canonical;
    this.namespace = namespace;
  }

  // ─────────────────────────────────────────────────────────────────
  // Safety
  // ─────────────────────────────────────────────────────────────────

  /**
   * POSIX `PATH_MAX` is 4096. Paths longer than this always fail at
   * the filesystem anyway (`ENAMETOOLONG`); rejecting early turns a
   * resource-exhaustion vector (huge strings through `normalize` and
   * `join`) into a cheap security-flavoured error.
   */
  private static readonly MAX_PATH_LENGTH = 4096;

  /**
   * Resolve a caller-supplied relative path to an absolute path
   * GUARANTEED to live under `rootPath`. Rejects every form of escape.
   *
   * Traversal rules:
   *   1. Null bytes (`\x00`) banned — POSIX filesystems treat them as
   *      path terminators; we reject earlier with a security-flavoured
   *      error rather than a generic I/O one.
   *   2. Path length capped at 4096 bytes (POSIX PATH_MAX) — prevents
   *      huge-string DoS before normalize/join allocates.
   *   3. Absolute paths (`/etc/passwd`, `C:\\...`) banned.
   *   4. The resolved absolute path must be `rootPath` itself OR start
   *      with `rootPath + sep`. `startsWith(rootPath)` alone is not
   *      sufficient — `/a/b` is a prefix of `/a/bar`.
   *
   * Symlink resolution is NOT performed here — that would require an
   * `fs.realpath` call per operation and changes behaviour for
   * non-existent files. The realpath check happens in
   * `assertRealpathInZone` (reads) and `assertParentRealpathInZone`
   * (writes/appends) — the latter catches write-through-symlink
   * escape attempts where a planted symlink inside the zone points
   * outside it.
   */
  private resolveSafePath(relativePath: string): string {
    if (typeof relativePath !== "string") {
      throw new StoragePathTraversalError(
        this.zone,
        String(relativePath),
        "path must be a string",
      );
    }
    if (relativePath.length > LocalStorageProvider.MAX_PATH_LENGTH) {
      throw new StoragePathTraversalError(
        this.zone,
        relativePath.slice(0, 64) + "…",
        `path length ${relativePath.length} exceeds POSIX PATH_MAX (${LocalStorageProvider.MAX_PATH_LENGTH})`,
      );
    }
    if (relativePath.includes("\0")) {
      throw new StoragePathTraversalError(
        this.zone,
        relativePath,
        "null byte in path",
      );
    }
    if (isAbsolute(relativePath)) {
      throw new StoragePathTraversalError(
        this.zone,
        relativePath,
        "absolute paths not allowed in zone-scoped providers",
      );
    }

    const candidate = normalize(join(this.rootPath, relativePath));

    if (candidate === this.rootPath) return candidate;
    if (candidate.startsWith(this.rootPath + sep)) return candidate;

    throw new StoragePathTraversalError(
      this.zone,
      relativePath,
      `resolved path ${candidate} escapes zone root ${this.rootPath}`,
    );
  }

  /**
   * For WRITES: the target file may not exist yet, so `realpath(abs)`
   * is meaningless. Instead, realpath the deepest existing ancestor
   * and verify THAT is still inside the zone. Closes the write-through
   * -symlink escape vector: a symlink planted somewhere on the path
   * (e.g., `home/drafts → /etc/`) has its target resolved and
   * rejected before we open the file for write.
   */
  private async assertParentRealpathInZone(
    absolutePath: string,
    relativePath: string,
  ): Promise<void> {
    // Walk up from abs looking for the first existing ancestor. We
    // never walk past rootPath — if we do, the candidate escaped the
    // zone in a way resolveSafePath should have caught.
    let current = absolutePath;
    while (current !== this.rootPath) {
      try {
        const real = await realpath(current);
        if (real !== this.rootPath && !real.startsWith(this.rootPath + sep)) {
          throw new StoragePathTraversalError(
            this.zone,
            relativePath,
            `symlink on path escapes zone: ${current} → ${real}`,
          );
        }
        return; // ancestor exists and resolves inside — we're safe
      } catch (err) {
        if (err instanceof StoragePathTraversalError) throw err;
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "ENOENT") {
          throw this.translateFsError(err, relativePath);
        }
        // ENOENT: walk up another level.
        const parent = dirname(current);
        if (parent === current) return; // reached filesystem root without finding anything
        current = parent;
      }
    }
    // Walked up to the zone root itself — realpath the root to be sure
    // it still resolves to itself (constructor already canonicalised
    // it, so this is a sanity check against post-construction symlink
    // swaps).
    try {
      const real = await realpath(this.rootPath);
      if (real !== this.rootPath) {
        throw new StoragePathTraversalError(
          this.zone,
          relativePath,
          `zone root moved post-construction: ${this.rootPath} → ${real}`,
        );
      }
    } catch {
      // Root missing at write time — `write`'s own mkdir(dirname) will
      // recreate it. Not a security concern.
    }
  }

  /**
   * After a filesystem operation, verify the REAL canonical path
   * hasn't somehow escaped. Covers the symlink-escape case: a symlink
   * INSIDE the zone pointing OUTSIDE it. We walk `realpath` on the
   * resolved path and re-check the zone-root prefix.
   *
   * Called only on read operations where the target must already
   * exist; writes create new inodes that can't be symlinks pointing
   * elsewhere unless the caller planted a symlink first — which is
   * caught on the next read.
   */
  private async assertRealpathInZone(
    absolutePath: string,
    relativePath: string,
  ): Promise<void> {
    let real: string;
    try {
      real = await realpath(absolutePath);
    } catch (err) {
      // ENOENT etc. — bubble up; caller translates.
      throw this.translateFsError(err, relativePath);
    }
    if (real !== this.rootPath && !real.startsWith(this.rootPath + sep)) {
      throw new StoragePathTraversalError(
        this.zone,
        relativePath,
        `symlink escapes zone: ${absolutePath} → ${real}`,
      );
    }
  }

  /**
   * Map a raw Node fs error to a typed `StorageError`. Preserves the
   * original as `cause`. Returns a new error — does not throw.
   */
  private translateFsError(err: unknown, relativePath: string): Error {
    if (err instanceof StorageError) return err;
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return new StorageNotFoundError(this.zone, relativePath);
    }
    if (code === "EACCES" || code === "EPERM") {
      return new StoragePermissionError(this.zone, relativePath, err);
    }
    return new StorageError(
      this.zone,
      relativePath,
      `fs error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // ─────────────────────────────────────────────────────────────────
  // CRUD
  // ─────────────────────────────────────────────────────────────────

  async read(relativePath: string): Promise<Uint8Array> {
    const abs = this.resolveSafePath(relativePath);
    try {
      await this.assertRealpathInZone(abs, relativePath);
      const buf = await readFile(abs);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      throw this.translateFsError(err, relativePath);
    }
  }

  async readText(relativePath: string): Promise<string> {
    const abs = this.resolveSafePath(relativePath);
    try {
      await this.assertRealpathInZone(abs, relativePath);
      return await readFile(abs, "utf-8");
    } catch (err) {
      throw this.translateFsError(err, relativePath);
    }
  }

  async write(relativePath: string, data: Uint8Array | string): Promise<void> {
    const abs = this.resolveSafePath(relativePath);
    try {
      await mkdir(dirname(abs), { recursive: true });
      // After mkdir the parent exists and realpath is defined. If any
      // ancestor is a symlink escaping the zone, assertParentRealpath
      // InZone throws StoragePathTraversalError before we writeFile.
      await this.assertParentRealpathInZone(abs, relativePath);
      await writeFile(abs, data);
    } catch (err) {
      throw this.translateFsError(err, relativePath);
    }
  }

  async append(relativePath: string, data: Uint8Array | string): Promise<void> {
    const abs = this.resolveSafePath(relativePath);
    try {
      await mkdir(dirname(abs), { recursive: true });
      await this.assertParentRealpathInZone(abs, relativePath);
      await appendFile(abs, data);
    } catch (err) {
      throw this.translateFsError(err, relativePath);
    }
  }

  /**
   * SECURITY NOTE (PR-003 M-1): `list` does NOT realpath-check the
   * directory before `readdir`. If a symlink is planted INSIDE the zone
   * pointing outside it, `list` returns the target's entry names (not
   * contents — those are caught by `assertRealpathInZone` in `read`).
   *
   * Agent has no tool to create symlinks inside the zone (writes use
   * `writeFile` / `mkdir -p` which don't produce symlinks), so the
   * attack requires out-of-band symlink planting by an actor with
   * shell access — not a meaningful escalation over the shell access
   * itself. If a future provider layers on a stricter threat model
   * (e.g., the relay-dispatch surface exposes list to an untrusted
   * caller), add an `assertRealpathInZone(abs, relativeDir)` call
   * above the readdir, OR filter returned entries via
   * `readdir({ withFileTypes: true })` and skip symbolic links.
   */
  async list(relativeDir: string): Promise<string[]> {
    const abs = this.resolveSafePath(relativeDir);
    try {
      return await readdir(abs);
    } catch (err) {
      throw this.translateFsError(err, relativeDir);
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    // Traversal rejection still applies — a caller asking "does
    // ../etc/passwd exist?" is a security signal, not a benign lookup.
    const abs = this.resolveSafePath(relativePath);
    try {
      await access(abs, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async stat(relativePath: string): Promise<StorageFileStat | null> {
    const abs = this.resolveSafePath(relativePath);
    try {
      const s = await stat(abs);
      return {
        size: s.size,
        mtime: s.mtime,
        isDirectory: s.isDirectory(),
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return null;
      throw this.translateFsError(err, relativePath);
    }
  }

  async delete(relativePath: string): Promise<void> {
    const abs = this.resolveSafePath(relativePath);
    // SECURITY: refuse to delete the zone root itself. `resolveSafePath`
    // accepts "" / "." because they normalize to rootPath, which is
    // legitimate for `list` / `stat` / `exists`. For `delete` it's a
    // "rm -rf the entire zone" request, which no caller should ever
    // make. The \`file\` tool's path validation catches the
    // common case; this guard is defence-in-depth against future
    // direct callers and against paths that normalize to rootPath
    // through unusual means (e.g., `"./"`).
    if (abs === this.rootPath) {
      throw new StoragePathTraversalError(
        this.zone,
        relativePath,
        "refusing to delete the zone root",
      );
    }
    try {
      try {
        await unlink(abs);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "EISDIR" || code === "EPERM") {
          await rm(abs, { recursive: true, force: false });
        } else {
          throw err;
        }
      }
    } catch (err) {
      throw this.translateFsError(err, relativePath);
    }
  }

  async mkdir(relativeDir: string): Promise<void> {
    const abs = this.resolveSafePath(relativeDir);
    try {
      await mkdir(abs, { recursive: true });
    } catch (err) {
      throw this.translateFsError(err, relativeDir);
    }
  }
}
