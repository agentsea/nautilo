import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { readMigrationFilesWithPrivilegeCompat, repairTaskWakeMigration } from "../../src/utils/migration-privilege-compat";

const directory = new URL("../../src/migrations/", import.meta.url);
const file = "0374_abandoned_thundra.sql";
const table = '"protected_task_wake_continuation_receipts"';
const trigger = `CREATE TRIGGER "task_wake_continuation_immutable" BEFORE UPDATE ON ${table} FOR EACH ROW
EXECUTE FUNCTION "public"."reject_task_wake_continuation_update"();`;
const grant = `GRANT TRIGGER ON TABLE ${table} TO "nautilo";`;
const revoke = `REVOKE TRIGGER ON TABLE ${table} FROM "nautilo";`;
const breakpoint = "\n--> statement-breakpoint\n";

describe("Task wake migration trigger privileges", () => {
  test("grants TRIGGER only around the exact guard creation and restores the source", () => {
    const source = readFileSync(new URL(file, directory), "utf8");
    expect(createHash("sha256").update(source).digest("hex"))
      .toBe("e70023c5dcf4012c74d271e56b22b6f8b8dc25099df36215953aad4a775e3767");

    const corrected = repairTaskWakeMigration(source);
    expect(corrected.split(grant)).toHaveLength(2);
    expect(corrected.split(revoke)).toHaveLength(2);
    expect(corrected.indexOf(grant)).toBeLessThan(corrected.indexOf(trigger));
    expect(corrected.indexOf(revoke)).toBeGreaterThan(corrected.indexOf(trigger));
    expect(corrected.replace(`${grant}${breakpoint}`, "").replace(`${breakpoint}${revoke}`, ""))
      .toBe(source);
    expect(() => repairTaskWakeMigration(`${source}\n-- changed`)).toThrow("Refusing unknown");
    expect(() => repairTaskWakeMigration(source.replace(trigger, `${trigger}\n${trigger}`)))
      .toThrow("Refusing unknown");

    const config = { migrationsFolder: fileURLToPath(directory) };
    const canonical = readMigrationFiles(config);
    const metadata = readMigrationFilesWithPrivilegeCompat(config);
    const index = canonical.findIndex(({ hash }) => hash === createHash("sha256").update(source).digest("hex"));
    expect(metadata[index]!.sql.join("--> statement-breakpoint")).toBe(corrected);
    expect(metadata[index]!.hash).toBe(canonical[index]!.hash);
    expect(metadata[index]!.folderMillis).toBe(canonical[index]!.folderMillis);
    expect(metadata[index]!.bps).toBe(canonical[index]!.bps);
    expect(readFileSync(new URL(file, directory), "utf8")).toBe(source);
  });
});
