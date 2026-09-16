import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  CHECKPOINT_MAINTENANCE_CURRENT_BACKUP,
  CHECKPOINT_MAINTENANCE_PREVIOUS_BACKUP,
  CheckpointMaintenanceBackupBusyError,
  checkpointMaintenanceBackupPaths,
  refreshCheckpointMaintenanceRecoveryBackup,
  withCheckpointMaintenanceBackupSession,
} from "../../src/lib/checkpoint-maintenance-backups";
import { assertPublicSnapshotName } from "../../src/commands/save";
import {
  describeBackupArtifact,
  verifyCanonicalDefaultFullBackupDirectory,
  writeManifestFile,
  type DevFullBackupManifestV2,
} from "../../src/lib/full-dev-backup";

const roots: string[] = [];
const SHA = "a".repeat(64);

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "nautilo-checkpoint-maintenance-"));
  roots.push(value);
  return value;
}

async function writeRecoveryBackup(rootDir: string, name: string): Promise<void> {
  const dir = join(rootDir, name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const file of ["database.sql.gz", "logto.sql.gz", "dot-env", "home.tar.gz"]) {
    await writeFile(join(dir, file), `${name}:${file}`, { mode: 0o600 });
  }
  const manifest: DevFullBackupManifestV2 = {
    formatVersion: 2,
    name,
    createdAt: "2026-08-03T00:00:00.000Z",
    sourceInstanceId: "",
    sourceDeploymentMode: "local-self-host",
    capture: { consistency: "quiesced", nautiloWriterStopped: true, logtoWriterStopped: true },
    artifacts: {
      nautiloDatabase: await describeBackupArtifact(dir, "database.sql.gz"),
      logtoDatabase: await describeBackupArtifact(dir, "logto.sql.gz"),
      instanceEnv: await describeBackupArtifact(dir, "dot-env"),
      nautiloHome: await describeBackupArtifact(dir, "home.tar.gz"),
    },
    drizzle: { lastAppliedIndex: 0, entries: [{ index: 0, tag: "first", createdAt: 1, sha256: SHA }] },
    postgres: { nautiloMajor: 17, logtoMajor: 16 },
    rowAnchors: { users: 1 },
    complete: true,
    cloneEligible: false,
    backupMode: "dump",
  };
  await writeManifestFile(dir, manifest);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("checkpoint-maintenance bounded recovery backups", () => {
  test("reserves fixed recovery names from the public save command", () => {
    expect(() => assertPublicSnapshotName(CHECKPOINT_MAINTENANCE_CURRENT_BACKUP)).toThrow("reserved");
    expect(() => assertPublicSnapshotName(CHECKPOINT_MAINTENANCE_PREVIOUS_BACKUP)).toThrow("reserved");
    expect(() => assertPublicSnapshotName("ordinary-snapshot")).not.toThrow();
  });
  test("rotates only current plus one verified previous recovery backup", async () => {
    const snapshots = await root();
    const capture = async (name: typeof CHECKPOINT_MAINTENANCE_CURRENT_BACKUP) => writeRecoveryBackup(snapshots, name);
    const first = await refreshCheckpointMaintenanceRecoveryBackup({ root: snapshots, capture });
    expect(first.current.manifest.name).toBe(CHECKPOINT_MAINTENANCE_CURRENT_BACKUP);
    expect(first.previous).toBeNull();

    const second = await refreshCheckpointMaintenanceRecoveryBackup({ root: snapshots, capture });
    expect(second.current.manifest.name).toBe(CHECKPOINT_MAINTENANCE_CURRENT_BACKUP);
    expect(second.previous?.manifest.name).toBe(CHECKPOINT_MAINTENANCE_PREVIOUS_BACKUP);
    expect(await verifyCanonicalDefaultFullBackupDirectory(join(snapshots, CHECKPOINT_MAINTENANCE_CURRENT_BACKUP))).toBeDefined();
    expect(await verifyCanonicalDefaultFullBackupDirectory(join(snapshots, CHECKPOINT_MAINTENANCE_PREVIOUS_BACKUP))).toBeDefined();
  });

  test("keeps the last verified backup when fresh capture fails and removes only owned abandoned staging", async () => {
    const snapshots = await root();
    const capture = async (name: typeof CHECKPOINT_MAINTENANCE_CURRENT_BACKUP) => writeRecoveryBackup(snapshots, name);
    await refreshCheckpointMaintenanceRecoveryBackup({ root: snapshots, capture });
    const staging = join(snapshots, `.${CHECKPOINT_MAINTENANCE_CURRENT_BACKUP}.staging-interrupted`);
    expect(refreshCheckpointMaintenanceRecoveryBackup({
      root: snapshots,
      capture: async () => {
        await mkdir(staging, { mode: 0o700 });
        throw new Error("capture interrupted");
      },
    })).rejects.toThrow("capture interrupted");
    expect((await readFile(join(snapshots, CHECKPOINT_MAINTENANCE_PREVIOUS_BACKUP, "manifest.json"), "utf8"))).toContain(CHECKPOINT_MAINTENANCE_PREVIOUS_BACKUP);
    expect(lstat(staging)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("keeps the last verified backup when post-capture verification fails", async () => {
    const snapshots = await root();
    const capture = async (name: typeof CHECKPOINT_MAINTENANCE_CURRENT_BACKUP) => writeRecoveryBackup(snapshots, name);
    await refreshCheckpointMaintenanceRecoveryBackup({ root: snapshots, capture });
    let currentVerifications = 0;
    expect(refreshCheckpointMaintenanceRecoveryBackup({
      root: snapshots,
      capture,
      verify: async (directory) => {
        if (directory.endsWith(CHECKPOINT_MAINTENANCE_CURRENT_BACKUP) && ++currentVerifications === 2) throw new Error("verification failed");
        return verifyCanonicalDefaultFullBackupDirectory(directory);
      },
    })).rejects.toThrow("verification failed");
    expect((await verifyCanonicalDefaultFullBackupDirectory(join(snapshots, CHECKPOINT_MAINTENANCE_PREVIOUS_BACKUP))).manifest.name)
      .toBe(CHECKPOINT_MAINTENANCE_PREVIOUS_BACKUP);
    expect(lstat(join(snapshots, CHECKPOINT_MAINTENANCE_CURRENT_BACKUP))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("keeps a competing capture busy until the post-capture session action completes", async () => {
    const snapshots = await root();
    const capture = async (name: typeof CHECKPOINT_MAINTENANCE_CURRENT_BACKUP) => writeRecoveryBackup(snapshots, name);
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const reachedPostCapture = new Promise<void>((resolvePromise) => { entered = resolvePromise; });
    const held = withCheckpointMaintenanceBackupSession({
      root: snapshots,
      action: async (session) => {
        await session.captureRecoveryBackup({ capture });
        entered?.();
        await new Promise<void>((resolvePromise) => { release = resolvePromise; });
      },
    });
    await reachedPostCapture;
    try {
      await refreshCheckpointMaintenanceRecoveryBackup({ root: snapshots, capture });
      throw new Error("competing capture unexpectedly acquired the lock");
    } catch (error) {
      expect(error).toBeInstanceOf(CheckpointMaintenanceBackupBusyError);
    }
    release?.();
    await held;
  });

  test("recovers only a demonstrably dead owner lock", async () => {
    const snapshots = await root();
    const paths = checkpointMaintenanceBackupPaths(snapshots);
    await writeFile(paths.lock, `${JSON.stringify({ pid: 2_147_483_647, startedAt: "2026-08-03T00:00:00.000Z" })}\n`, { mode: 0o600 });
    expect(await withCheckpointMaintenanceBackupSession({ root: snapshots, action: async () => "recovered" })).toBe("recovered");
    await writeFile(paths.lock, "unparseable", { mode: 0o600 });
    expect(withCheckpointMaintenanceBackupSession({ root: snapshots, action: async () => undefined })).rejects.toThrow("cannot be proved stale");
  });
});
