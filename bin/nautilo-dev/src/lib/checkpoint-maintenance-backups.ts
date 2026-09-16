/**
 * Bounded, recovery-only snapshot rotation for checkpoint maintenance.
 *
 * This deliberately owns just two names below an existing snapshot root. It
 * does not discover, modify, or prune ordinary developer snapshots.
 */
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  verifyCanonicalDefaultFullBackupDirectory,
  type VerifiedFullBackup,
} from "./full-dev-backup";
import { writeOwnerOnlyJsonAtomically } from "./d489-operation-records";

export const CHECKPOINT_MAINTENANCE_CURRENT_BACKUP = "checkpoint-maintenance-current";
export const CHECKPOINT_MAINTENANCE_PREVIOUS_BACKUP = "checkpoint-maintenance-previous";

const STAGING_PREFIX = `.${CHECKPOINT_MAINTENANCE_CURRENT_BACKUP}.staging-`;

export interface CheckpointMaintenanceBackupPaths {
  readonly root: string;
  readonly current: string;
  readonly previous: string;
  readonly lock: string;
}

export interface CheckpointMaintenanceRecoveryBackup {
  /** The newly captured and verified recovery backup. */
  readonly current: VerifiedFullBackup;
  /** The formerly current verified backup, if one existed. */
  readonly previous: VerifiedFullBackup | null;
}

export interface RefreshCheckpointMaintenanceRecoveryBackupInput {
  /** Usually the canonical default instance's private `dev-snapshots` root. */
  readonly root: string;
  /**
   * Capture one full backup using exactly `checkpoint-maintenance-current` as
   * its name. The callback must return only after its final directory exists.
   */
  readonly capture: (name: typeof CHECKPOINT_MAINTENANCE_CURRENT_BACKUP) => Promise<void>;
  /** Canonical-default policy is the production default; injectable for tests. */
  readonly verify?: (directory: string) => Promise<VerifiedFullBackup>;
}

/** Capture arguments available only while an owning recovery session is live. */
export type CheckpointMaintenanceBackupCaptureInput = Omit<RefreshCheckpointMaintenanceRecoveryBackupInput, "root">;

export interface CheckpointMaintenanceBackupSession {
  /**
   * Publish exactly one fresh bounded recovery backup under this session's
   * lock. Hold the session around the complete gate and operation-record
   * write, not just this call, so its manifest evidence stays authoritative.
   */
  readonly captureRecoveryBackup: (
    input: CheckpointMaintenanceBackupCaptureInput,
  ) => Promise<CheckpointMaintenanceRecoveryBackup>;
}

export class CheckpointMaintenanceBackupBusyError extends Error {
  constructor() {
    super("A checkpoint-maintenance recovery capture is already in progress; retry shortly");
    this.name = "CheckpointMaintenanceBackupBusyError";
  }
}

export function checkpointMaintenanceBackupPaths(root: string): CheckpointMaintenanceBackupPaths {
  const absoluteRoot = resolve(root);
  return {
    root: absoluteRoot,
    current: join(absoluteRoot, CHECKPOINT_MAINTENANCE_CURRENT_BACKUP),
    previous: join(absoluteRoot, CHECKPOINT_MAINTENANCE_PREVIOUS_BACKUP),
    lock: join(absoluteRoot, "checkpoint-maintenance.lock"),
  };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function ensureOwnerOnlyDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const details = await stat(path);
  if (!details.isDirectory() || (details.mode & 0o077) !== 0) {
    throw new Error("Checkpoint-maintenance recovery root is not owner-only");
  }
  await chmod(path, 0o700);
}

async function assertOwnedBackupDirectory(path: string, name: string): Promise<void> {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0) {
    throw new Error(`Checkpoint-maintenance ${name} backup is not an owner-only directory`);
  }
}

async function verifyNamedBackup(
  path: string,
  expectedName: string,
  verify: (directory: string) => Promise<VerifiedFullBackup>,
): Promise<VerifiedFullBackup> {
  await assertOwnedBackupDirectory(path, expectedName);
  const verified = await verify(path);
  if (resolve(verified.dir) !== path || verified.manifest.name !== expectedName) {
    throw new Error(`Checkpoint-maintenance ${expectedName} backup identity is invalid`);
  }
  return verified;
}

async function removeOwnedDirectory(path: string): Promise<void> {
  const details = await lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (details === null) return;
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error("Checkpoint-maintenance recovery path is not an owned directory");
  }
  await rm(path, { recursive: true, force: true });
}

/** Remove only save's known abandoned staging directories while holding the lock. */
async function removeAbandonedStaging(paths: CheckpointMaintenanceBackupPaths): Promise<void> {
  for (const entry of await readdir(paths.root)) {
    if (!entry.startsWith(STAGING_PREFIX)) continue;
    const path = join(paths.root, entry);
    const details = await lstat(path);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error("Checkpoint-maintenance staging path is not an owned directory");
    }
    await rm(path, { recursive: true, force: true });
  }
}

/**
 * Immediate owner-only lock. A stale lock is recovered only when a parsed
 * owner PID is demonstrably absent; an unreadable or live lock is never
 * removed. Renaming stale locks prevents deleting a replacement lock during
 * a concurrent recovery race.
 */
async function withCheckpointMaintenanceBackupLock<T>(
  root: string,
  action: () => Promise<T>,
): Promise<T> {
  const paths = checkpointMaintenanceBackupPaths(root);
  await ensureOwnerOnlyDirectory(paths.root);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  for (let attempt = 0; attempt < 3 && handle === null; attempt += 1) {
    try {
      const candidate = await open(paths.lock, "wx", 0o600);
      try {
        await candidate.chmod(0o600);
        await candidate.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
        handle = candidate;
      } catch (error) {
        await candidate.close().catch(() => undefined);
        await rm(paths.lock, { force: true }).catch(() => undefined);
        throw error;
      }
      continue;
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST")) throw error;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(paths.lock, "utf8")) as unknown;
      } catch {
        throw new Error("Checkpoint-maintenance lock cannot be proved stale; inspect it after confirming no capture is active");
      }
      const pid = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)["pid"]
        : undefined;
      if (!Number.isSafeInteger(pid) || (pid as number) < 1) {
        throw new Error("Checkpoint-maintenance lock cannot be proved stale; inspect it after confirming no capture is active");
      }
      try {
        process.kill(pid as number, 0);
        throw new CheckpointMaintenanceBackupBusyError();
      } catch (livenessError) {
        if (!(typeof livenessError === "object" && livenessError !== null && "code" in livenessError && (livenessError as { code?: unknown }).code === "ESRCH")) throw livenessError;
        const retired = `${paths.lock}.stale-${process.pid}-${Date.now()}`;
        try {
          await rename(paths.lock, retired);
        } catch (renameError) {
          if (isMissing(renameError)) continue;
          throw renameError;
        }
        await rm(retired, { force: true });
      }
    }
  }
  if (handle === null) throw new CheckpointMaintenanceBackupBusyError();
  try {
    return await action();
  } finally {
    await handle.close();
    await rm(paths.lock, { force: true });
  }
}

/**
 * Hold the recovery-artifact lock across an entire maintenance gate and its
 * durable evidence write. The scoped capability prevents a second rotation
 * from invalidating the backup returned to the caller before it is recorded.
 */
export async function withCheckpointMaintenanceBackupSession<T>(input: {
  readonly root: string;
  readonly action: (session: CheckpointMaintenanceBackupSession) => Promise<T>;
}): Promise<T> {
  const paths = checkpointMaintenanceBackupPaths(input.root);
  return withCheckpointMaintenanceBackupLock(paths.root, async () => {
    let active = true;
    let captured = false;
    const session: CheckpointMaintenanceBackupSession = {
      captureRecoveryBackup: async (captureInput) => {
        if (!active) throw new Error("Checkpoint-maintenance recovery session is no longer active");
        if (captured) throw new Error("Checkpoint-maintenance recovery session already captured a backup");
        captured = true;
        return refreshCheckpointMaintenanceRecoveryBackupUnderLock({
          root: paths.root,
          ...captureInput,
        });
      },
    };
    try {
      return await input.action(session);
    } finally {
      active = false;
    }
  });
}

/**
 * Publish a fresh recovery backup under a fixed current name, retaining at
 * most one previously verified backup. Rotation happens before capture so a
 * failed capture or verification cannot erase the last known-good artifact.
 */
export async function refreshCheckpointMaintenanceRecoveryBackup(
  input: RefreshCheckpointMaintenanceRecoveryBackupInput,
): Promise<CheckpointMaintenanceRecoveryBackup> {
  const paths = checkpointMaintenanceBackupPaths(input.root);
  return withCheckpointMaintenanceBackupLock(paths.root, async () => {
    return refreshCheckpointMaintenanceRecoveryBackupUnderLock({
      root: paths.root,
      capture: input.capture,
      ...(input.verify === undefined ? {} : { verify: input.verify }),
    });
  });
}

/** Caller must own `withCheckpointMaintenanceBackupLock`; never export this primitive. */
async function refreshCheckpointMaintenanceRecoveryBackupUnderLock(
  input: RefreshCheckpointMaintenanceRecoveryBackupInput,
): Promise<CheckpointMaintenanceRecoveryBackup> {
  const paths = checkpointMaintenanceBackupPaths(input.root);
  const verify = input.verify ?? verifyCanonicalDefaultFullBackupDirectory;
  await removeAbandonedStaging(paths);
  const hasCurrent = await exists(paths.current);
  const hasPrevious = await exists(paths.previous);
  let previous: VerifiedFullBackup | null = null;
  let previousInvalid: unknown = null;
  if (hasPrevious) {
    try {
      previous = await verifyNamedBackup(paths.previous, CHECKPOINT_MAINTENANCE_PREVIOUS_BACKUP, verify);
    } catch (error) {
      previousInvalid = error;
    }
  }

  if (hasCurrent) {
    let current: VerifiedFullBackup | null = null;
    try {
      current = await verifyNamedBackup(paths.current, CHECKPOINT_MAINTENANCE_CURRENT_BACKUP, verify);
    } catch (currentError) {
      // A known-good previous artifact makes an interrupted/corrupt current
      // disposable. Without that proof, leave both paths for an operator.
      if (previous === null) {
        throw previousInvalid ?? currentError;
      }
      await removeOwnedDirectory(paths.current);
    }
    if (current !== null) {
      // Current has been verified, so an obsolete or corrupt previous copy
      // may be removed only now. Directory identity is part of the full
      // backup verifier, so rewrite its manifest atomically after rename and
      // restore the old current name on any ordinary rotation failure.
      if (hasPrevious) await removeOwnedDirectory(paths.previous);
      let renamed = false;
      let rewritten = false;
      try {
        await rename(paths.current, paths.previous);
        renamed = true;
        await chmod(paths.previous, 0o700);
        await writeOwnerOnlyJsonAtomically(join(paths.previous, "manifest.json"), {
          ...current.manifest,
          name: CHECKPOINT_MAINTENANCE_PREVIOUS_BACKUP,
        });
        rewritten = true;
        previous = await verifyNamedBackup(paths.previous, CHECKPOINT_MAINTENANCE_PREVIOUS_BACKUP, verify);
      } catch (error) {
        if (renamed) {
          try {
            if (rewritten) {
              await writeOwnerOnlyJsonAtomically(join(paths.previous, "manifest.json"), {
                ...current.manifest,
                name: CHECKPOINT_MAINTENANCE_CURRENT_BACKUP,
              });
            }
            await rename(paths.previous, paths.current);
          } catch {
            // The primary error remains useful; the retained artifact is
            // intentionally left for explicit operator recovery if this
            // unusual filesystem rollback itself fails.
          }
        }
        throw error;
      }
    }
  } else if (previousInvalid !== null) {
    throw previousInvalid instanceof Error
      ? previousInvalid
      : new Error("Checkpoint-maintenance previous backup verification failed");
  }

  try {
    await input.capture(CHECKPOINT_MAINTENANCE_CURRENT_BACKUP);
    const current = await verifyNamedBackup(paths.current, CHECKPOINT_MAINTENANCE_CURRENT_BACKUP, verify);
    return { current, previous };
  } catch (error) {
    // `save` normally removes its own staging directory, but this also
    // handles an interruption or custom capture seam without touching other
    // developer snapshots.
    await removeOwnedDirectory(paths.current).catch(() => undefined);
    await removeAbandonedStaging(paths).catch(() => undefined);
    throw error;
  }
}
