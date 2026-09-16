import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import {
  resolveInstance,
  resolveInstanceUncached,
  resolveNautiloStorageRoot,
} from "@nautilo/config";
import {
  resolveSnapshotDir,
  resolveSnapshotsDir,
  resolveNautiloHome,
  resolveDotenvPath,
} from "../lib/paths";
import { pgBaseBackupTarGzip } from "../lib/docker-db";
import { logtoDatabaseExists } from "../lib/logto-db";
import { formatBytes } from "../lib/format-bytes";
import {
  describeBackupArtifact,
  writeManifestFile,
  type DevFullBackupManifestV2,
} from "../lib/full-dev-backup";
import {
  captureDatabaseMigrationLineage,
  parseDatabaseMigrationLedger,
  readCheckoutMigrationLineage,
  type DatabaseMigrationEntry,
} from "../lib/migration-lineage";
import {
  countTableRows,
  dumpPostgresDatabaseGzip,
  assertDockerBindSourcesAvailable,
  postgresMajorVersion,
  queryPostgresContainer,
} from "../lib/postgres-archive";
import {
  defaultBackupQuiescenceDeps,
  withQuiescedBackupSource,
} from "../lib/backup-quiescence";
import { NAUTILO_REPO_ROOT } from "../lib/compose-infra";
import {
  CHECKPOINT_MAINTENANCE_CURRENT_BACKUP,
  CHECKPOINT_MAINTENANCE_PREVIOUS_BACKUP,
} from "../lib/checkpoint-maintenance-backups";

export type SaveBackupMode = "dump" | "basebackup";

export interface SaveOptions {
  /** Compatibility no-op: Logto is mandatory for every full backup. */
  requireLogto?: boolean;
  mode?: SaveBackupMode;
  /**
   * Internal-only capture root.  D489 uses this for a bounded seed staging
   * area; ordinary `save` continues to publish under dev-snapshots.
   */
  snapshotRoot?: string;
  /** Internal source selection seam for canonical-default seed capture. */
  instanceEnv?: NodeJS.ProcessEnv;
  /** Composing commands can silence progress while owning a JSON document. */
  log?: (message: string) => void;
}

/** Private-env-only root resolution for canonical seed capture. */
function resolveSaveSourceRoot(
  instanceEnv: NodeJS.ProcessEnv,
  instanceId: string,
): string {
  const userHome = instanceEnv["HOME"]?.trim();
  if (!userHome) throw new Error("A full development backup requires HOME to resolve its source root");
  return resolveNautiloStorageRoot(userHome, instanceId);
}

export function resolvePrivateSaveSource(instanceEnv: NodeJS.ProcessEnv): {
  readonly instance: ReturnType<typeof resolveInstanceUncached>;
  readonly root: string;
  readonly envPath: string;
} {
  const instance = resolveInstanceUncached(instanceEnv, { skipUserConfigOverlay: true });
  const root = resolveSaveSourceRoot(instanceEnv, instance.instanceId);
  return { instance, root, envPath: join(root, "instance.env") };
}

const NAUTILO_ROW_ANCHORS = [
  "users",
  "agents",
  "rooms",
  "sessions",
  "session_messages",
  "artifacts",
] as const;
const LOGTO_ROW_ANCHORS = ["users", "applications"] as const;

function readDatabaseMigrationLedger(container: string): DatabaseMigrationEntry[] {
  const out = queryPostgresContainer({
    container,
    database: "nautilo",
    sql: `
      SELECT created_at::text || '|' || hash
      FROM drizzle.__drizzle_migrations
      ORDER BY id ASC;
    `,
  });
  return parseDatabaseMigrationLedger(out);
}

function collectRowAnchors(
  nautiloContainer: string,
  logtoContainer: string,
): Record<string, number> {
  const anchors: Record<string, number> = {};
  for (const table of NAUTILO_ROW_ANCHORS) {
    anchors[`nautilo.${table}`] = countTableRows(
      nautiloContainer,
      "nautilo",
      table,
    );
  }
  for (const table of LOGTO_ROW_ANCHORS) {
    anchors[`logto.${table}`] = countTableRows(
      logtoContainer,
      "logto_nautilo",
      table,
    );
  }
  return anchors;
}

function archiveNautiloHome(root: string, outputPath: string): void {
  const result = spawnSync(
    "tar",
    [
      "czf",
      outputPath,
      "--exclude=dev-snapshots",
      "--exclude=emergency-backups",
      "--exclude=instance.env",
      "--exclude=instance.json",
      "--exclude=server.pid",
      "--exclude=logs",
      "--exclude=session.json",
      "--exclude=cli-session.json",
      "--exclude=sessions",
      "--exclude=desktop-auth*.json",
      "--exclude=claim-invite.txt",
      "--exclude=.bootstrap/claim-invite",
      "--exclude=logto-admin.txt",
      "--exclude=clone-operation.json",
      "--exclude=.protected-instance",
      "-C",
      root,
      ".",
    ],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "tar failed").trim());
  }
}

export function assertPublicSnapshotName(name: string): void {
  if (name === CHECKPOINT_MAINTENANCE_CURRENT_BACKUP || name === CHECKPOINT_MAINTENANCE_PREVIOUS_BACKUP) {
    throw new Error("Snapshot name is reserved for checkpoint-maintenance recovery");
  }
}

async function saveInternal(name: string, options: SaveOptions, allowMaintenanceName: boolean): Promise<void> {
  const log = options.log ?? console.log;
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(
      "Snapshot name must be alphanumeric with hyphens/underscores (e.g. my-working-setup).",
    );
  }
  if (!allowMaintenanceName) assertPublicSnapshotName(name);

  const snapshotsDir = options.snapshotRoot === undefined
    ? resolveSnapshotsDir()
    : resolve(options.snapshotRoot);
  const finalDir = options.snapshotRoot === undefined
    ? resolveSnapshotDir(name)
    : join(snapshotsDir, name);
  if (existsSync(finalDir)) {
    throw new Error(`Snapshot "${name}" already exists. Remove it first or pick a different name.`);
  }

  const privateSource = options.instanceEnv === undefined
    ? undefined
    : resolvePrivateSaveSource(options.instanceEnv);
  const inst = privateSource?.instance ?? resolveInstance();
  const sourceRoot = privateSource?.root ?? resolveNautiloHome();
  const c = inst.compose.containers;
  if (!logtoDatabaseExists(c.logtoPostgres)) {
    throw new Error(
      "A full development backup requires the Logto database `logto_nautilo`; run `bun run infra:start` first.",
    );
  }
  if (options.requireLogto) {
    log("  --require-logto is retained as a compatibility no-op; Logto is mandatory.");
  }

  const envPath = privateSource?.envPath ?? resolveDotenvPath();
  if (!existsSync(envPath)) {
    throw new Error(`A full development backup requires instance.env at ${envPath}`);
  }

  await mkdir(snapshotsDir, { recursive: true, mode: 0o700 });
  await chmod(snapshotsDir, 0o700);
  const stagingDir = join(snapshotsDir, `.${name}.staging-${process.pid}-${Date.now()}`);
  await mkdir(stagingDir, { mode: 0o700 });

  const mode = options.mode ?? "dump";
  const databaseFile = mode === "dump" ? "database.sql.gz" : "basebackup.tar.gz";
  const databasePath = join(stagingDir, databaseFile);
  const logtoPath = join(stagingDir, "logto_nautilo.sql.gz");
  const envDest = join(stagingDir, "dot-env");
  const homePath = join(stagingDir, "nautilo-home.tar.gz");

  log(`Saving full snapshot "${name}" for ${inst.instanceId || "(default)"}...`);
  try {
    assertDockerBindSourcesAvailable(c.legacyPostgres);
    assertDockerBindSourcesAvailable(c.logtoPostgres);
    await withQuiescedBackupSource(
      defaultBackupQuiescenceDeps(inst, log),
      async (capture) => {
        const checkoutLineage = await readCheckoutMigrationLineage(
          join(NAUTILO_REPO_ROOT, "packages", "db", "src", "migrations"),
        );
        const initialDatabaseLedger = readDatabaseMigrationLedger(
          c.legacyPostgres,
        );
        const lineage = captureDatabaseMigrationLineage(
          initialDatabaseLedger,
          checkoutLineage,
        );
        const rowAnchors = collectRowAnchors(
          c.legacyPostgres,
          c.logtoPostgres,
        );

        log(
          mode === "dump"
            ? "  Dumping complete Nautilo database..."
            : "  Taking complete Nautilo physical base backup...",
        );
        if (mode === "dump") {
          await dumpPostgresDatabaseGzip({
            container: c.legacyPostgres,
            database: "nautilo",
            outputPath: databasePath,
          });
        } else {
          pgBaseBackupTarGzip(databasePath);
          await chmod(databasePath, 0o600);
        }

        log("  Dumping complete Logto database...");
        await dumpPostgresDatabaseGzip({
          container: c.logtoPostgres,
          database: "logto_nautilo",
          outputPath: logtoPath,
        });

        await copyFile(envPath, envDest);
        await chmod(envDest, 0o600);
        archiveNautiloHome(sourceRoot, homePath);
        await chmod(homePath, 0o600);

        const finalDatabaseLedger = readDatabaseMigrationLedger(
          c.legacyPostgres,
        );
        const finalRowAnchors = collectRowAnchors(
          c.legacyPostgres,
          c.logtoPostgres,
        );
        if (
          JSON.stringify(finalDatabaseLedger) !==
            JSON.stringify(initialDatabaseLedger) ||
          JSON.stringify(finalRowAnchors) !== JSON.stringify(rowAnchors)
        ) {
          throw new Error(
            "Source migration ledger or representative row anchors changed during backup",
          );
        }
        const artifacts = {
          nautiloDatabase: await describeBackupArtifact(stagingDir, databaseFile),
          logtoDatabase: await describeBackupArtifact(
            stagingDir,
            "logto_nautilo.sql.gz",
          ),
          instanceEnv: await describeBackupArtifact(stagingDir, "dot-env"),
          nautiloHome: await describeBackupArtifact(
            stagingDir,
            "nautilo-home.tar.gz",
          ),
        };
        const createdAt = new Date().toISOString();
        const cloneEligible =
          mode === "dump" &&
          inst.instanceId !== "" &&
          inst.deploymentMode === "dev-multi-instance";
        const manifest: DevFullBackupManifestV2 = {
          formatVersion: 2,
          name,
          createdAt,
          sourceInstanceId: inst.instanceId,
          sourceDeploymentMode:
            inst.deploymentMode === "dev-multi-instance"
              ? "dev-multi-instance"
              : "local-self-host",
          capture: {
            consistency: "quiesced",
            ...capture,
          },
          artifacts,
          drizzle: {
            lastAppliedIndex: lineage.at(-1)?.index ?? -1,
            entries: lineage,
          },
          postgres: {
            nautiloMajor: postgresMajorVersion(c.legacyPostgres),
            logtoMajor: postgresMajorVersion(c.logtoPostgres),
          },
          rowAnchors,
          complete: true,
          cloneEligible,
          backupMode: mode,
        };

        const envContent = await readFile(envDest, "utf8");
        const envKeyCount = envContent
          .split(/\r?\n/)
          .filter((line) => line.trim() && !line.trim().startsWith("#") && line.includes("="))
          .length;
        await writeFile(
          join(stagingDir, "meta.json"),
          `${JSON.stringify(
            {
              name,
              createdAt,
              backupMode: mode,
              dbSizeBytes: artifacts.nautiloDatabase.bytes,
              logtoDbSizeBytes: artifacts.logtoDatabase.bytes,
              envKeyCount,
              complete: true,
              cloneEligible,
              sourceInstanceId: inst.instanceId,
              lastAppliedMigrationIndex: manifest.drizzle.lastAppliedIndex,
            },
            null,
            2,
          )}\n`,
          { encoding: "utf8", mode: 0o600 },
        );

        // The manifest is the backup commit record and is written last.
        await writeManifestFile(stagingDir, manifest);
      },
    );

    await rename(stagingDir, finalDir);
    await chmod(finalDir, 0o700);
    const manifest = JSON.parse(
      await readFile(join(finalDir, "manifest.json"), "utf8"),
    ) as DevFullBackupManifestV2;
    log(
      `Full snapshot "${name}" saved to ${finalDir} ` +
        `(${formatBytes(manifest.artifacts.nautiloDatabase.bytes)} Nautilo, ` +
        `${formatBytes(manifest.artifacts.logtoDatabase.bytes)} Logto, ` +
        `migration ${manifest.drizzle.lastAppliedIndex}, ` +
        `cloneEligible=${manifest.cloneEligible})`,
    );
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

export async function save(name: string, options: SaveOptions = {}): Promise<void> {
  return saveInternal(name, options, false);
}

/** Dedicated internal publication boundary; public `save` rejects both names. */
export async function saveCheckpointMaintenanceRecovery(
  name: typeof CHECKPOINT_MAINTENANCE_CURRENT_BACKUP,
  options: SaveOptions,
): Promise<void> {
  return saveInternal(name, options, true);
}
