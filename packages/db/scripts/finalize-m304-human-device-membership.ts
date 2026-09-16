import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DEVICE_IDENTITY_CONSTRAINT =
  'ALTER TABLE "human_crypto_devices" ADD CONSTRAINT "uq_human_crypto_devices_identity_generation" UNIQUE("device_id","device_generation");--> statement-breakpoint\n';
const SERVER_IDENTITY_CONSTRAINT =
  'ALTER TABLE "nautilo_instance_identity" ADD CONSTRAINT "uq_nautilo_instance_identity_server_instance" UNIQUE("server_instance_id");--> statement-breakpoint\n';
const FIRST_DEPENDENT_FOREIGN_KEY =
  'ALTER TABLE "human_crypto_device_group_acknowledgements" ADD CONSTRAINT "human_crypto_device_group_acknowledgements_custody_fk"';
export const M304_HUMAN_DEVICE_IDENTITY_READ_MARKER =
  "-- M304_HUMAN_DEVICE_IDENTITY_READ";
const IDENTITY_READ_AUTHORITY = `${M304_HUMAN_DEVICE_IDENTITY_READ_MARKER}
GRANT SELECT ("id", "server_instance_id") ON TABLE "nautilo_instance_identity"
TO "nautilo_crypto";`;

export function finalizeM304HumanDeviceMembershipMigration(
  migration: string,
): string {
  if (!migration.includes('CREATE TABLE "human_crypto_device_group_heads"')) {
    return migration;
  }

  const insertionIndex = migration.indexOf(FIRST_DEPENDENT_FOREIGN_KEY);
  if (insertionIndex < 0) {
    throw new Error("M304 Human-device membership foreign keys are missing");
  }

  for (const constraint of [
    DEVICE_IDENTITY_CONSTRAINT,
    SERVER_IDENTITY_CONSTRAINT,
  ]) {
    const first = migration.indexOf(constraint);
    const last = migration.lastIndexOf(constraint);
    if (first < 0 || first !== last) {
      throw new Error(
        "M304 Human-device membership requires one generated prerequisite constraint",
      );
    }
  }

  const withoutPrerequisites = migration
    .replace(DEVICE_IDENTITY_CONSTRAINT, "")
    .replace(SERVER_IDENTITY_CONSTRAINT, "");
  const adjustedInsertionIndex = withoutPrerequisites.indexOf(
    FIRST_DEPENDENT_FOREIGN_KEY,
  );

  const reordered = `${withoutPrerequisites.slice(0, adjustedInsertionIndex)}${
    SERVER_IDENTITY_CONSTRAINT
  }${DEVICE_IDENTITY_CONSTRAINT}${withoutPrerequisites.slice(
    adjustedInsertionIndex,
  )}`;
  if (reordered.includes(M304_HUMAN_DEVICE_IDENTITY_READ_MARKER)) {
    return reordered;
  }
  return `${reordered}${reordered.endsWith("\n") ? "" : "\n"}--> statement-breakpoint
${IDENTITY_READ_AUTHORITY}
`;
}

function run(): void {
  const migrationsDirectory = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(
    readFileSync(resolve(migrationsDirectory, "meta/_journal.json"), "utf8"),
  ) as { entries: readonly { tag: string }[] };
  if (journal.entries.length === 0) throw new Error("Migration journal is empty");

  for (const entry of journal.entries) {
    const migrationPath = resolve(migrationsDirectory, `${entry.tag}.sql`);
    const migration = readFileSync(migrationPath, "utf8");
    const finalized = finalizeM304HumanDeviceMembershipMigration(migration);
    if (finalized !== migration) writeFileSync(migrationPath, finalized, "utf8");
  }
}

if (import.meta.main) run();
