import { constants as fsConstants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

interface DirectoryHandle {
  stat(options: { bigint: true }): Promise<BigIntStats>;
  close(): Promise<void>;
}

export interface TaskProjectDirectoryAnchorFilesystem {
  realpath(candidate: string): Promise<string>;
  lstat(candidate: string): Promise<BigIntStats>;
  open(candidate: string, flags: number): Promise<DirectoryHandle>;
}

export interface TaskProjectDirectoryAnchor {
  validate(): Promise<boolean>;
  close(): Promise<void>;
}

const nodeFilesystem: TaskProjectDirectoryAnchorFilesystem = {
  realpath: fs.realpath,
  lstat: (candidate) => fs.lstat(candidate, { bigint: true }),
  open: fs.open,
};

type DirectoryIdentity = Readonly<{ device: bigint; inode: bigint }>;

function directoryIdentity(stat: BigIntStats): DirectoryIdentity | null {
  return stat.isDirectory() && stat.dev >= 0n && stat.ino > 0n
    ? Object.freeze({ device: stat.dev, inode: stat.ino })
    : null;
}

function sameIdentity(expected: DirectoryIdentity, stat: BigIntStats): boolean {
  const current = directoryIdentity(stat);
  return current !== null &&
    current.device === expected.device && current.inode === expected.inode;
}

function directoryOpenFlags(platform: NodeJS.Platform): number {
  // libuv adds FILE_FLAG_BACKUP_SEMANTICS for fs.open on Windows, where the
  // POSIX-only O_DIRECTORY and O_NOFOLLOW constants are unavailable.
  return platform === "win32"
    ? fsConstants.O_RDONLY
    : fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
}

async function closeQuietly(handle: DirectoryHandle | null): Promise<void> {
  if (handle === null) return;
  try {
    await handle.close();
  } catch {
    // Best-effort resource cleanup must not replace the dispatch's real error.
  }
}

/**
 * Pins one Task project directory incarnation for a single relay dispatch.
 *
 * Keeping the original handle open prevents an unlinked POSIX inode (or a
 * Windows file ID) from being recycled while path-based operations reprove the
 * directory. This remains a narrow pre-use fence; concrete file operations
 * retain their existing path guards and TOCTOU limits.
 */
export async function openTaskProjectDirectoryAnchor(
  projectRoot: string,
  options: Readonly<{
    filesystem?: TaskProjectDirectoryAnchorFilesystem;
    platform?: NodeJS.Platform;
  }> = {},
): Promise<TaskProjectDirectoryAnchor | null> {
  if (!path.isAbsolute(projectRoot)) return null;
  const filesystem = options.filesystem ?? nodeFilesystem;
  const flags = directoryOpenFlags(options.platform ?? process.platform);
  let anchor: DirectoryHandle | null = null;
  try {
    const before = await filesystem.lstat(projectRoot);
    if (!before.isDirectory() || before.isSymbolicLink() ||
      await filesystem.realpath(projectRoot) !== projectRoot) return null;
    anchor = await filesystem.open(projectRoot, flags);
    const captured = directoryIdentity(await anchor.stat({ bigint: true }));
    if (captured === null) {
      await closeQuietly(anchor);
      return null;
    }

    let closed = false;
    const validate = async (): Promise<boolean> => {
      if (closed || anchor === null) return false;
      let reopened: DirectoryHandle | null = null;
      try {
        const currentAnchor = await anchor.stat({ bigint: true });
        const beforeOpen = await filesystem.lstat(projectRoot);
        if (!sameIdentity(captured, currentAnchor) ||
          !beforeOpen.isDirectory() || beforeOpen.isSymbolicLink() ||
          !sameIdentity(captured, beforeOpen) ||
          await filesystem.realpath(projectRoot) !== projectRoot) return false;

        reopened = await filesystem.open(projectRoot, flags);
        const reopenedStat = await reopened.stat({ bigint: true });
        const finalPath = await filesystem.lstat(projectRoot);
        const finalCanonical = await filesystem.realpath(projectRoot);
        return !closed && anchor !== null &&
          sameIdentity(captured, reopenedStat) &&
          finalPath.isDirectory() && !finalPath.isSymbolicLink() &&
          sameIdentity(captured, finalPath) && finalCanonical === projectRoot;
      } catch {
        return false;
      } finally {
        await closeQuietly(reopened);
      }
    };
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      const owned = anchor;
      anchor = null;
      await closeQuietly(owned);
    };
    if (!(await validate())) {
      await close();
      return null;
    }
    return Object.freeze({ validate, close });
  } catch {
    await closeQuietly(anchor);
    return null;
  }
}
