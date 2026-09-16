import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveInstance } from "@nautilo/config";
import { FULL_DEV_BACKUP_MANIFEST, verifyFullBackupDirectory, type VerifiedFullBackup } from "./full-dev-backup";
import { assertExactMigrationPrefix, readCheckoutMigrationLineage, type MigrationLineageEntry, type DatabaseMigrationEntry } from "./migration-lineage";
import { postgresMajorVersion } from "./postgres-archive";

export function assertImportedRestoreLineage(actual: readonly DatabaseMigrationEntry[], expected: readonly MigrationLineageEntry[]): void {
  if (actual.length !== expected.length || actual.some((entry, index) => entry.createdAt !== expected[index]?.createdAt || entry.sha256 !== expected[index]?.sha256)) {
    throw new Error("Imported migration ledger does not match the verified backup manifest.");
  }
}

export function assertFullRestoreTarget(
  backup: VerifiedFullBackup,
  target: { instanceId: string; nautiloMajor: number; logtoMajor: number },
  checkout: readonly MigrationLineageEntry[],
): void {
  const { manifest } = backup;
  if (manifest.sourceInstanceId !== target.instanceId) {
    throw new Error("Full restore requires the same instance identity; use the clone command for another target.");
  }
  if (manifest.backupMode !== "dump") throw new Error("Full restore requires a logical database dump.");
  if (manifest.postgres.nautiloMajor !== target.nautiloMajor || manifest.postgres.logtoMajor !== target.logtoMajor) {
    throw new Error("Full restore PostgreSQL major versions do not match the backup.");
  }
  const expected = { nautiloDatabase: "database.sql.gz", logtoDatabase: "logto_nautilo.sql.gz", instanceEnv: "dot-env", nautiloHome: "nautilo-home.tar.gz" } as const;
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (manifest.artifacts[key].file !== expected[key]) throw new Error(`Unexpected full restore artifact: ${key}`);
  }
  assertExactMigrationPrefix(manifest.drizzle.entries, checkout);
}

/** Validate complete backups before autosave or database destruction. A present
 * but invalid manifest must never fall back to the older selective COPY path. */
export async function prepareFullDevRestore(dir: string): Promise<VerifiedFullBackup | undefined> {
  if (!existsSync(join(dir, FULL_DEV_BACKUP_MANIFEST))) return undefined;
  const inst = resolveInstance();
  const backup = await verifyFullBackupDirectory(dir, inst.instanceId === "" ? "canonical-default-seed" : "named-clone");
  const checkout = await readCheckoutMigrationLineage(join(process.cwd(), "packages/db/src/migrations"));
  assertFullRestoreTarget(backup, {
    instanceId: inst.instanceId,
    nautiloMajor: postgresMajorVersion(inst.compose.containers.legacyPostgres),
    logtoMajor: postgresMajorVersion(inst.compose.containers.logtoPostgres),
  }, checkout);
  return backup;
}
