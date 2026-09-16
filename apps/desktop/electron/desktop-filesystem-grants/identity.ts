/**
 * Filesystem identity capture and pre-use revalidation for Desktop Filesystem Grants.
 *
 * This deliberately has no Electron dependency. Revalidation narrows the
 * replacement/symlink window before every privileged use, but cannot eliminate
 * TOCTOU between these checks and the later filesystem operation.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { DesktopFilesystemGrantFilesystemIdentity } from "@nautilo/desktop-filesystem-grants";

export interface DesktopFilesystemGrantRootStat {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  dev?: number;
  ino?: number;
}

export interface DesktopFilesystemGrantFilesystem {
  lstat(root: string): Promise<DesktopFilesystemGrantRootStat>;
  stat(root: string): Promise<DesktopFilesystemGrantRootStat>;
  realpath(root: string): Promise<string>;
}

export type DesktopFilesystemGrantRootIdentityErrorCode =
  | "invalid_root"
  | "root_missing"
  | "root_symlink"
  | "root_not_directory"
  | "root_identity_changed";

export type DesktopFilesystemGrantRootIdentityResult =
  | {
      ok: true;
      canonicalRoot: string;
      filesystemIdentity: DesktopFilesystemGrantFilesystemIdentity;
    }
  | { ok: false; error: { code: DesktopFilesystemGrantRootIdentityErrorCode; message: string } };

type DesktopFilesystemGrantRootIdentityFailure = Extract<
  DesktopFilesystemGrantRootIdentityResult,
  { ok: false }
>;

type DesktopFilesystemGrantRootInspectionResult =
  | {
      ok: true;
      canonicalRoot: string;
      lstat: DesktopFilesystemGrantRootStat;
      stat: DesktopFilesystemGrantRootStat;
    }
  | DesktopFilesystemGrantRootIdentityFailure;

const nodeFilesystem: DesktopFilesystemGrantFilesystem = fs;

function failure(
  code: DesktopFilesystemGrantRootIdentityErrorCode,
  message: string,
): DesktopFilesystemGrantRootIdentityFailure {
  return { ok: false, error: { code, message } };
}

function identityPair(stat: DesktopFilesystemGrantRootStat): { device: number; inode: number } | undefined {
  if (
    typeof stat.dev === "number" &&
    Number.isSafeInteger(stat.dev) &&
    stat.dev >= 0 &&
    typeof stat.ino === "number" &&
    Number.isSafeInteger(stat.ino) &&
    stat.ino >= 0
  ) {
    return { device: stat.dev, inode: stat.ino };
  }
  return undefined;
}

function sameIdentity(a: DesktopFilesystemGrantRootStat, b: DesktopFilesystemGrantRootStat): boolean {
  const aPair = identityPair(a);
  const bPair = identityPair(b);
  return aPair === undefined || bPair === undefined || (aPair.device === bPair.device && aPair.inode === bPair.inode);
}

async function inspectRoot(
  selectedRoot: string,
  filesystem: DesktopFilesystemGrantFilesystem,
): Promise<DesktopFilesystemGrantRootInspectionResult> {
  if (!path.isAbsolute(selectedRoot)) {
    return failure("invalid_root", "selected root must be absolute");
  }

  let lstat: DesktopFilesystemGrantRootStat;
  try {
    lstat = await filesystem.lstat(selectedRoot);
  } catch {
    return failure("root_missing", "selected root does not exist or cannot be inspected");
  }
  if (lstat.isSymbolicLink()) {
    return failure("root_symlink", "selected root must not be a symbolic link");
  }
  if (!lstat.isDirectory()) {
    return failure("root_not_directory", "selected root must be a directory");
  }

  let stat: DesktopFilesystemGrantRootStat;
  let canonicalRoot: string;
  try {
    [stat, canonicalRoot] = await Promise.all([filesystem.stat(selectedRoot), filesystem.realpath(selectedRoot)]);
  } catch {
    return failure("root_missing", "selected root disappeared or cannot be resolved");
  }
  if (!stat.isDirectory()) {
    return failure("root_not_directory", "selected root must resolve to a directory");
  }
  if (!path.isAbsolute(canonicalRoot) || !sameIdentity(lstat, stat)) {
    return failure("root_identity_changed", "selected root changed while its identity was inspected");
  }

  let canonicalStat: DesktopFilesystemGrantRootStat;
  try {
    canonicalStat = await filesystem.stat(canonicalRoot);
  } catch {
    return failure("root_missing", "canonical root disappeared while its identity was inspected");
  }
  if (!canonicalStat.isDirectory() || !sameIdentity(stat, canonicalStat)) {
    return failure("root_identity_changed", "canonical root no longer matches the selected root");
  }

  return { ok: true, canonicalRoot: path.normalize(canonicalRoot), lstat, stat };
}

/**
 * Captures a direct, existing directory selection. The returned canonical root
 * is the `realpath` result (including macOS `/var` -> `/private/var`).
 */
export async function captureDesktopFilesystemGrantRootIdentity(
  selectedRoot: string,
  filesystem: DesktopFilesystemGrantFilesystem = nodeFilesystem,
): Promise<DesktopFilesystemGrantRootIdentityResult> {
  const inspected = await inspectRoot(selectedRoot, filesystem);
  if (!inspected.ok) return inspected;

  const pair = identityPair(inspected.stat);
  return {
    ok: true,
    canonicalRoot: inspected.canonicalRoot,
    filesystemIdentity: {
      realRoot: inspected.canonicalRoot,
      ...(pair ? pair : {}),
    },
  };
}

/**
 * Explicit pre-use primitive for the later relay guard. It validates the
 * persisted real root and detects root replacement when POSIX dev/inode are
 * available. Call it immediately before the guarded filesystem operation.
 */
export async function revalidateDesktopFilesystemGrantRootIdentity(
  saved: DesktopFilesystemGrantFilesystemIdentity,
  filesystem: DesktopFilesystemGrantFilesystem = nodeFilesystem,
): Promise<DesktopFilesystemGrantRootIdentityResult> {
  const inspected = await inspectRoot(saved.realRoot, filesystem);
  if (!inspected.ok) return inspected;

  const pair = identityPair(inspected.stat);
  if (
    inspected.canonicalRoot !== path.normalize(saved.realRoot) ||
    (saved.device !== undefined &&
      (!pair || pair.device !== saved.device || pair.inode !== saved.inode))
  ) {
    return failure("root_identity_changed", "root no longer matches its saved filesystem identity");
  }

  return {
    ok: true,
    canonicalRoot: inspected.canonicalRoot,
    filesystemIdentity: {
      realRoot: inspected.canonicalRoot,
      ...(pair ? pair : {}),
    },
  };
}
