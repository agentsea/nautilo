import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { readMigrationFiles } from "drizzle-orm/migrator";

import { finalizeModerationMigration } from "../../scripts/finalize-moderation";
import { readMigrationFilesWithPrivilegeCompat, repairModerationMigration } from "../../src/utils/migration-privilege-compat";

const triggerPrivilegeRevoke =
  'REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "moderation_actions" FROM "nautilo";';
const triggerPrivilegeGrant = 'GRANT TRIGGER ON TABLE "moderation_actions" TO "nautilo";';
const rowTrigger = "CREATE TRIGGER moderation_action_immutable_row";
const tableTrigger = "CREATE TRIGGER moderation_action_immutable_table";

function expectTriggerPrivilegeOrder(sql: string): void {
  const grant = sql.indexOf(triggerPrivilegeGrant);
  const row = sql.indexOf(rowTrigger);
  const table = sql.indexOf(tableTrigger);
  const revoke = sql.indexOf(triggerPrivilegeRevoke);
  expect(grant).toBeGreaterThan(-1);
  expect(row).toBeGreaterThan(grant);
  expect(table).toBeGreaterThan(row);
  expect(revoke).toBeGreaterThan(table);
  expect(sql.lastIndexOf(triggerPrivilegeRevoke)).toBe(revoke);
}

describe("moderation migration trigger privileges", () => {
  test("the finalizer installs both guards before withdrawing trigger privilege", () => {
    const source = 'CREATE TABLE "moderation_actions" ("operation_id" uuid);';
    const finalized = finalizeModerationMigration(source);
    expectTriggerPrivilegeOrder(finalized);
    expect(finalizeModerationMigration(finalized)).toBe(finalized);
  });

  test("the committed migration stays immutable and the runtime correction is narrowly scoped", () => {
    const migrationsFolder = new URL("../../src/migrations/", import.meta.url);
    const migration = readFileSync(
      new URL("0300_flimsy_kingpin.sql", migrationsFolder),
      "utf8",
    );
    expect(createHash("sha256").update(migration).digest("hex"))
      .toBe("62c2b2c8218262c8caa7b5164d745b64d1fbda96850a3442ec416785f1190669");
    expect(migration.indexOf(triggerPrivilegeRevoke)).toBeLessThan(migration.indexOf(rowTrigger));
    expectTriggerPrivilegeOrder(repairModerationMigration(migration));
    expect(() => repairModerationMigration(`${migration}\n-- changed`)).toThrow("Refusing unknown");
    const config = { migrationsFolder: fileURLToPath(migrationsFolder) };
    const canonical = readMigrationFiles(config);
    const corrected = readMigrationFilesWithPrivilegeCompat(config);
    const index = canonical.findIndex(({ hash }) => hash === createHash("sha256").update(migration).digest("hex"));
    expectTriggerPrivilegeOrder(corrected[index]!.sql.join("--> statement-breakpoint"));
    expect(corrected[index]!.hash).toBe(canonical[index]!.hash);
    expect(corrected[index]!.folderMillis).toBe(canonical[index]!.folderMillis);
    expect(readFileSync(new URL("0300_flimsy_kingpin.sql", migrationsFolder), "utf8"))
      .toBe(migration);
  });
});
