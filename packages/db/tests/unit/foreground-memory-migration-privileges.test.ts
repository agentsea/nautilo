import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { readMigrationFilesWithPrivilegeCompat, repairForegroundMemoryMigration } from "../../src/utils/migration-privilege-compat";

const directory = new URL("../../src/migrations/", import.meta.url);
const file = "0375_strange_red_shift.sql";
const table = '"foreground_memory_crypto_publication_receipts"';
const trigger = `CREATE TRIGGER "foreground_memory_publication_immutable" BEFORE UPDATE ON ${table} FOR EACH ROW
EXECUTE FUNCTION "public"."reject_foreground_memory_publication_update"();`;
const grant = `GRANT TRIGGER ON TABLE ${table} TO "nautilo";`;
const revoke = `REVOKE TRIGGER ON TABLE ${table} FROM "nautilo";`;
const signature = '"public"."reject_foreground_memory_publication_update"()';
const executeGrant = `GRANT EXECUTE ON FUNCTION ${signature} TO "nautilo";`;
const executeRevoke = `REVOKE EXECUTE ON FUNCTION ${signature} FROM "nautilo";`;
const breakpoint = "\n--> statement-breakpoint\n";

describe("foreground Memory migration trigger privileges", () => {
  test("grants TRIGGER only around the exact guard creation and restores the source", () => {
    const source = readFileSync(new URL(file, directory), "utf8");
    expect(createHash("sha256").update(source).digest("hex"))
      .toBe("950d05509ccf6affa335753842e8f2f07a47ee5c1877577fadb8df48626b3f2b");

    const corrected = repairForegroundMemoryMigration(source);
    expect(corrected.split(grant)).toHaveLength(2);
    expect(corrected.split(revoke)).toHaveLength(2);
    expect(corrected.split(executeGrant)).toHaveLength(2);
    expect(corrected.split(executeRevoke)).toHaveLength(2);
    expect(corrected.indexOf(grant)).toBeLessThan(corrected.indexOf(trigger));
    expect(corrected.indexOf(executeGrant)).toBeLessThan(corrected.indexOf(trigger));
    expect(corrected.indexOf(executeRevoke)).toBeGreaterThan(corrected.indexOf(trigger));
    expect(corrected.indexOf(revoke)).toBeGreaterThan(corrected.indexOf(trigger));
    expect(corrected
      .replace(`${grant}${breakpoint}${executeGrant}${breakpoint}`, "")
      .replace(`${breakpoint}${executeRevoke}${breakpoint}${revoke}`, ""))
      .toBe(source);
    expect(() => repairForegroundMemoryMigration(`${source}\n-- changed`)).toThrow("Refusing unknown");
    expect(() => repairForegroundMemoryMigration(source.replace(trigger, `${trigger}\n${trigger}`)))
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
