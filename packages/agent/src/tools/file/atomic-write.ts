/**
 * D087 Phase 1 §1.2 — atomic file write wrapper.
 *
 * Thin shim around `write-file-atomic`. The reason we don't just call it
 * inline is:
 *
 *   1. Every call site funnels through one place, so if we ever need to
 *      swap implementations (e.g. add a crash-time audit log, route
 *      through a different backend for tests) there is exactly one seam.
 *
 *   2. The library's options are slightly over-configured for our needs;
 *      this wrapper pins a safe default set (mode 0o644, no chown, utf-8
 *      or Buffer passthrough).
 *
 *   3. Tests can mock this module in isolation without monkey-patching
 *      the library.
 *
 * Why `write-file-atomic` and not a hand-rolled tmp+rename: the library
 * does the `fsync` call between the write and the rename. Without fsync,
 * a power loss between the OS-accepted write and the rename can leave a
 * zero-byte target on disk. See `tasks/ISSUE-D087-.../library-choices.md`
 * §3 for the full reasoning.
 *
 * Chown behavior: when `mode` is passed explicitly and the target does
 * not yet exist, the library skips chown entirely (its default is to
 * copy uid/gid from the existing file, which is fine for our
 * overwrite-an-existing-doc case). The agent process always runs as the
 * user, so inherited ownership is the correct default either way.
 */

import writeFileAtomic from "write-file-atomic";
import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

export interface WriteAtomicOptions {
  /** File mode bits. Defaults to 0o644 (rw-r--r--). */
  mode?: number;
  /** Encoding when `data` is a string. Defaults to utf-8. */
  encoding?: BufferEncoding;
}

export class AtomicPublishCommittedError extends Error {
  readonly published = true;

  constructor(absPath: string, cause: unknown) {
    super(`Bytes were published at "${absPath}", but post-commit cleanup failed.`, {
      cause,
    });
    this.name = "AtomicPublishCommittedError";
  }
}

type PublishFileIfAbsentOptions = {
  /** Test seam for deterministic post-commit failure coverage. */
  syncDirectory?: ((directoryPath: string) => Promise<void>) | undefined;
};

async function syncParentDirectory(directoryPath: string): Promise<void> {
  // Windows does not support opening directories for fsync through Node.
  if (process.platform === "win32") return;
  const directory = await fsp.open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/**
 * Write `data` to `absPath` atomically:
 *
 *   1. Open `<absPath>.<random>.tmp` with `O_CREAT | O_WRONLY | O_EXCL`.
 *   2. Write the bytes.
 *   3. `fsync` the file descriptor (forces bytes to physical disk).
 *   4. `rename(tmp, absPath)` — POSIX-atomic on the same filesystem.
 *   5. On any failure, unlink the tmp file and propagate the error.
 *
 * The guarantee is end-to-end: at any moment an external observer will
 * see either the original file (or no file if creating) OR the full new
 * bytes. Never a torn-write, never an empty destination.
 *
 * `absPath` must be an absolute path on the same filesystem as its
 * parent directory. Cross-filesystem rename is NOT atomic — the library
 * would fall back to a copy + delete, breaking the guarantee. Our call
 * sites always target a file under a zone-resolved root that lives on
 * the user's home volume, so this is not a concern in practice; documented
 * here so a future refactor doesn't silently regress.
 */
export async function writeAtomic(
  absPath: string,
  data: Buffer | string,
  options: WriteAtomicOptions = {},
): Promise<void> {
  const mode = options.mode ?? 0o644;
  // `write-file-atomic` accepts Buffer | string directly; when given a
  // string it honors the encoding option. For Buffer inputs the
  // `encoding` field is ignored by the library.
  await writeFileAtomic(absPath, data, {
    mode,
    encoding: options.encoding ?? "utf8",
    // chown is deliberately NOT passed. With `mode` explicit, the
    // library skips the explicit-chown branch and either inherits uid/
    // gid from the existing file (overwrite case) or leaves the new
    // file owned by the agent process (create case). That's the safe
    // default for our workload — the agent always runs as the user.
  });
}

/**
 * Atomically publish a fully written sibling temporary file only when the
 * destination does not exist. POSIX `link` is the no-replace commit point:
 * concurrent publishers cannot replace the winner's bytes.
 */
export async function publishFileIfAbsent(
  temporaryPath: string,
  absPath: string,
  options: PublishFileIfAbsentOptions = {},
): Promise<void> {
  await fsp.link(temporaryPath, absPath);
  try {
    await (options.syncDirectory ?? syncParentDirectory)(path.dirname(absPath));
    await fsp.unlink(temporaryPath);
  } catch (error) {
    throw new AtomicPublishCommittedError(absPath, error);
  }
}

/** Write, fsync, and publish bytes without replacing an existing file. */
export async function writeAtomicIfAbsent(
  absPath: string,
  data: Buffer | string,
  options: WriteAtomicOptions = {},
): Promise<void> {
  const temporaryPath = `${absPath}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(temporaryPath, "wx", options.mode ?? 0o644);
    await handle.writeFile(
      data,
      typeof data === "string"
        ? { encoding: options.encoding ?? "utf8" }
        : undefined,
    );
    await handle.sync();
    await handle.close();
    handle = null;
    await publishFileIfAbsent(temporaryPath, absPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fsp.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
