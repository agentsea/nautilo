import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

const bolterMigrations = {
  "0341_bent_dust.sql": {
    hash: "a8ec1bf41169f027549ad0381bb61387b7a4e5c413499b2ecb53922cfd671989",
    tables: ["bolter_connections", "bolter_room_bindings", "bolter_inbox_receipts", "bolter_outbox"],
  },
  "0344_mysterious_runaways.sql": {
    hash: "e80e583c0ab40db13668a6e98fea9bd838d227ac2286ac3d8dd8371cdb15936a",
    tables: ["bolter_outbox"],
  },
  "0350_gigantic_whistler.sql": {
    hash: "70cdb08e7b09df2d4f6789c51e779c00da5a8df2a5e5adc3b6e56b53c36c7ec7",
    tables: ["bolter_explicit_shares"],
  },
} as const;

/** Retain immutable SQL and final ACLs; grant only while installing each guard. */
export function repairBolterMigration(name: string, source: string): string {
  if (!Object.hasOwn(bolterMigrations, name)) throw new Error("Unknown migration");
  const expected = bolterMigrations[name as keyof typeof bolterMigrations];
  const hash = createHash("sha256").update(source).digest("hex");
  if (hash !== expected.hash) throw new Error(`Refusing unknown ${name} content (sha256=${hash})`);
  const remaining = new Set<string>(expected.tables);
  let corrected = source.replace(/^CREATE TRIGGER [a-z_]+ BEFORE [^\n]+\nFOR EACH ROW EXECUTE FUNCTION public\.[a-z_]+\(\);/gm, (statement) => {
    const table = statement.match(/ ON public\.([a-z_]+)\n/);
    if (!table || !remaining.has(table[1]!)) return statement;
    remaining.delete(table[1]!);
    return `GRANT TRIGGER ON TABLE public.${table[1]} TO nautilo;${breakpoint}${statement}${breakpoint}REVOKE TRIGGER ON TABLE public.${table[1]} FROM nautilo;`;
  });
  if (remaining.size) throw new Error(`Refusing unexpected ${name} trigger layout`);
  if (name === "0344_mysterious_runaways.sql") {
    // PostgreSQL's language validator also checks EXECUTE while replacing an
    // existing function whose owner previously withdrew its own permission.
    const signature = "public.bolter_assert_current_binding(uuid,uuid,integer,integer)";
    corrected = corrected.replace(/^CREATE OR REPLACE FUNCTION public\.bolter_assert_current_binding\([\s\S]+?^END; \$\$;/m,
      (statement) => `GRANT EXECUTE ON FUNCTION ${signature} TO nautilo;${breakpoint}${statement}${breakpoint}REVOKE EXECUTE ON FUNCTION ${signature} FROM nautilo;`);
  }
  if (name === "0350_gigantic_whistler.sql") {
    // The earlier boundary also withdrew REFERENCES from the table owner.
    const target = 'REFERENCES (user_id,id) ON TABLE public.bolter_room_bindings';
    corrected = corrected.replace(/^ALTER TABLE "bolter_explicit_shares" ADD CONSTRAINT "bolter_shares_binding_owner"[^\n;]+;/m,
      (statement) => `GRANT ${target} TO nautilo;${breakpoint}${statement}${breakpoint}REVOKE ${target} FROM nautilo;`);
  }
  return corrected;
}

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

/** Preserve the immutable migration tree; correct only exact known privilege defects. */
export async function withMigrationPrivilegeCompat<T>(
  migrationsFolder: string,
  run: (folder: string) => Promise<T>,
): Promise<T> {
  const original = resolve(migrationsFolder);
  const corrections = new Map<string, string>();
  for (const name of [migrationName, ...Object.keys(bolterMigrations)]) {
    const sourcePath = join(original, name);
    if (!existsSync(sourcePath)) continue;
    const source = readFileSync(sourcePath, "utf8");
    corrections.set(name, name === migrationName
      ? repairModerationMigration(source) : repairBolterMigration(name, source));
  }
  if (!corrections.size) return run(original);
  const windows = process.platform === "win32";
  const temporary = mkdtempSync(join(tmpdir(), "nautilo-migrations-"));
  try {
    for (const entry of readdirSync(original)) {
      const destination = join(temporary, entry);
      if (corrections.has(entry)) writeFileSync(destination, corrections.get(entry)!);
      else if (windows) cpSync(join(original, entry), destination, { recursive: true, dereference: true });
      else symlinkSync(join(original, entry), destination);
    }
    return await run(temporary);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
