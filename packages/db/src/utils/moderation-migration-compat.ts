import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const migrationName = "0300_flimsy_kingpin.sql";
const committedHash = "62c2b2c8218262c8caa7b5164d745b64d1fbda96850a3442ec416785f1190669";
const revoke = 'REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "moderation_actions" FROM "nautilo";';
const grant = 'GRANT TRIGGER ON TABLE "moderation_actions" TO "nautilo";';
const breakpoint = "\n--> statement-breakpoint\n";
const rowTrigger = "CREATE TRIGGER moderation_action_immutable_row BEFORE UPDATE OR DELETE ON moderation_actions";
const tableTrigger = `CREATE TRIGGER moderation_action_immutable_table BEFORE TRUNCATE ON moderation_actions
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_moderation_action();`;

/**
 * The committed migration revokes TRIGGER before creating its own guards.
 * Its SQL file is immutable; apply this exact-hash compatibility correction
 * only to Drizzle's temporary input, never to the checked-in migration.
 */
export function repairModerationMigration(source: string): string {
  const hash = createHash("sha256").update(source).digest("hex");
  if (hash !== committedHash) {
    throw new Error(`Refusing unknown ${migrationName} content (sha256=${hash})`);
  }
  const before = `${revoke}${breakpoint}`;
  if (source.indexOf(before) !== source.lastIndexOf(before)
    || !source.includes(rowTrigger)
    || !source.includes(tableTrigger)) {
    throw new Error(`Refusing unexpected ${migrationName} statement layout`);
  }
  return source.replace(before, "")
    .replace(rowTrigger, `${grant}${breakpoint}${rowTrigger}`)
    .replace(tableTrigger, `${tableTrigger}${breakpoint}${revoke}`);
}

/** Symlink the large immutable migration tree; replace only the known bad SQL. */
export async function withModerationMigrationCompat<T>(
  migrationsFolder: string,
  run: (folder: string) => Promise<T>,
): Promise<T> {
  const original = resolve(migrationsFolder);
  const sourcePath = join(original, migrationName);
  if (!existsSync(sourcePath)) return run(original);

  const corrected = repairModerationMigration(readFileSync(sourcePath, "utf8"));
  const temporary = mkdtempSync(join(tmpdir(), "nautilo-migrations-"));
  try {
    for (const entry of readdirSync(original)) {
      const destination = join(temporary, entry);
      if (entry === migrationName) writeFileSync(destination, corrected);
      else symlinkSync(join(original, entry), destination);
    }
    return await run(temporary);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
