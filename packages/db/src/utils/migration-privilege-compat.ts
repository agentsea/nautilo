import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readMigrationFiles, type MigrationConfig, type MigrationMeta } from "drizzle-orm/migrator";
import { PgDialect } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

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

const taskWakeMigrationName = "0374_abandoned_thundra.sql";
const taskWakeMigrationHash = "e70023c5dcf4012c74d271e56b22b6f8b8dc25099df36215953aad4a775e3767";
const taskWakeTable = '"protected_task_wake_continuation_receipts"';
const taskWakeTrigger = `CREATE TRIGGER "task_wake_continuation_immutable" BEFORE UPDATE ON ${taskWakeTable} FOR EACH ROW
EXECUTE FUNCTION "public"."reject_task_wake_continuation_update"();`;
const taskWakeTriggerGrant = `GRANT TRIGGER ON TABLE ${taskWakeTable} TO "nautilo";`;
const taskWakeTriggerRevoke = `REVOKE TRIGGER ON TABLE ${taskWakeTable} FROM "nautilo";`;
const foregroundMemoryMigrationName = "0375_strange_red_shift.sql";
const foregroundMemoryMigrationHash = "950d05509ccf6affa335753842e8f2f07a47ee5c1877577fadb8df48626b3f2b";
const foregroundMemoryTable = '"foreground_memory_crypto_publication_receipts"';
const foregroundMemoryTrigger = `CREATE TRIGGER "foreground_memory_publication_immutable" BEFORE UPDATE ON ${foregroundMemoryTable} FOR EACH ROW
EXECUTE FUNCTION "public"."reject_foreground_memory_publication_update"();`;
const foregroundMemoryTriggerGrant = `GRANT TRIGGER ON TABLE ${foregroundMemoryTable} TO "nautilo";`;
const foregroundMemoryTriggerRevoke = `REVOKE TRIGGER ON TABLE ${foregroundMemoryTable} FROM "nautilo";`;
const foregroundMemoryFunction = '"public"."reject_foreground_memory_publication_update"()';
const foregroundMemoryExecuteGrant = `GRANT EXECUTE ON FUNCTION ${foregroundMemoryFunction} TO "nautilo";`;
const foregroundMemoryExecuteRevoke = `REVOKE EXECUTE ON FUNCTION ${foregroundMemoryFunction} FROM "nautilo";`;

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
 * only to Drizzle's in-memory statements, never to the checked-in migration.
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

/** Retain the Task migration and its final ACLs while installing its immutable-row guard. */
export function repairTaskWakeMigration(source: string): string {
  const hash = createHash("sha256").update(source).digest("hex");
  if (hash !== taskWakeMigrationHash) {
    throw new Error(`Refusing unknown ${taskWakeMigrationName} content (sha256=${hash})`);
  }
  if (!source.includes(taskWakeTrigger)
    || source.indexOf(taskWakeTrigger) !== source.lastIndexOf(taskWakeTrigger)
    || !source.includes(`REVOKE ALL PRIVILEGES ON TABLE ${taskWakeTable} FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint`)
    || !source.includes(`GRANT SELECT, INSERT ON TABLE ${taskWakeTable} TO "nautilo";--> statement-breakpoint`)) {
    throw new Error(`Refusing unexpected ${taskWakeMigrationName} statement layout`);
  }
  return source.replace(
    taskWakeTrigger,
    `${taskWakeTriggerGrant}${breakpoint}${taskWakeTrigger}${breakpoint}${taskWakeTriggerRevoke}`,
  );
}

/** Retain the foreground Memory migration and its final ACLs while installing its guard. */
export function repairForegroundMemoryMigration(source: string): string {
  const hash = createHash("sha256").update(source).digest("hex");
  if (hash !== foregroundMemoryMigrationHash) {
    throw new Error(`Refusing unknown ${foregroundMemoryMigrationName} content (sha256=${hash})`);
  }
  if (!source.includes(foregroundMemoryTrigger)
    || source.indexOf(foregroundMemoryTrigger) !== source.lastIndexOf(foregroundMemoryTrigger)
    || !source.includes(`REVOKE ALL PRIVILEGES ON TABLE ${foregroundMemoryTable} FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint`)
    || !source.includes(`GRANT SELECT, INSERT ON TABLE ${foregroundMemoryTable} TO "nautilo_crypto";${breakpoint}`)) {
    throw new Error(`Refusing unexpected ${foregroundMemoryMigrationName} statement layout`);
  }
  return source.replace(
    foregroundMemoryTrigger,
    `${foregroundMemoryTriggerGrant}${breakpoint}${foregroundMemoryExecuteGrant}${breakpoint}${foregroundMemoryTrigger}${breakpoint}${foregroundMemoryExecuteRevoke}${breakpoint}${foregroundMemoryTriggerRevoke}`,
  );
}

function repairKnownMigration(name: string, source: string): string {
  if (name === migrationName) return repairModerationMigration(source);
  if (name === taskWakeMigrationName) return repairTaskWakeMigration(source);
  if (name === foregroundMemoryMigrationName) return repairForegroundMemoryMigration(source);
  return repairBolterMigration(name, source);
}

/** Correct exact known SQL statements while retaining Drizzle's canonical ledger metadata. */
export function readMigrationFilesWithPrivilegeCompat(config: MigrationConfig): MigrationMeta[] {
  const migrations = readMigrationFiles(config);
  const journal = JSON.parse(
    readFileSync(join(config.migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  if (journal.entries.length !== migrations.length) {
    throw new Error("Migration journal and canonical metadata length mismatch");
  }
  return migrations.map((migration, index) => {
    const name = `${journal.entries[index]!.tag}.sql`;
    if (name !== migrationName
      && name !== taskWakeMigrationName
      && name !== foregroundMemoryMigrationName
      && !Object.hasOwn(bolterMigrations, name)) return migration;
    const source = migration.sql.join("--> statement-breakpoint");
    const corrected = repairKnownMigration(name, source);
    return { ...migration, sql: corrected.split("--> statement-breakpoint") };
  });
}

/** Apply exact compatibility SQL with the canonical file hashes in Drizzle's ledger. */
export async function migrateWithMigrationPrivilegeCompat<TSchema extends Record<string, unknown>>(
  db: PostgresJsDatabase<TSchema>,
  config: MigrationConfig,
): Promise<void> {
  const migrations = readMigrationFilesWithPrivilegeCompat(config);
  const session = db._.session as unknown as Parameters<PgDialect["migrate"]>[1];
  await new PgDialect().migrate(migrations, session, config);
}
