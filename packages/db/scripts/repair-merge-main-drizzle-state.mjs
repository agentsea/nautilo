/**
 * One-shot repair after merging origin/main into md/m066-invitations.
 *
 * Background
 * ----------
 * Before the merge, the local DB had these rows in
 * `drizzle.__drizzle_migrations` (created by the previous m066 + tweak
 * migrations):
 *
 *   hash(0026_m066_invites.sql)             created_at = 1777700000000
 *   hash(0027_m066_invites_constraints.sql) created_at = 1777700000001
 *   hash(0028_ambitious_betty_brant.sql)    created_at = 1777644682575
 *
 * After the merge, the journal layout is:
 *
 *   idx 26  0026_d104_logto_account_security  when = 1777700000000
 *   idx 27  0027_d104_recovery_codes_purpose  when = 1777700001000
 *   idx 28  0028_m066_invites                 when = 1777700002000  (renamed; SQL unchanged)
 *   idx 29  0029_m066_invites_constraints     when = 1777700002001  (renamed; SQL unchanged)
 *   idx 30  0030_ambitious_betty_brant        when = 1777700003000  (renamed; SQL unchanged)
 *
 * Drizzle's migrator only compares `created_at` to the journal `when`,
 * so the next `db:migrate` would (a) silently SKIP main's
 * 0026_d104_logto_account_security because its `when` (1777700000000)
 * is <= the locally-applied max created_at (1777700000001), and
 * (b) try to APPLY 0028_m066_invites again — which fails with
 * `relation "invites" already exists`.
 *
 * What this script does (idempotent, single transaction)
 * ------------------------------------------------------
 *   1. Apply 0026_d104_logto_account_security.sql to the DB.
 *      The SQL is fully idempotent (`CREATE TABLE IF NOT EXISTS`,
 *      `DO $$ ... EXCEPTION WHEN duplicate_object`, `ON CONFLICT
 *      DO NOTHING`).
 *   2. Apply 0027_d104_recovery_codes_purpose.sql to the DB.
 *      Also idempotent (`ADD COLUMN IF NOT EXISTS`, `DROP INDEX IF
 *      EXISTS`, `CREATE INDEX IF NOT EXISTS`).
 *   3. Insert the two D104 hash rows into __drizzle_migrations with
 *      the journal `when` as `created_at` (using
 *      `ON CONFLICT (hash) DO NOTHING`-style guard via SELECT-then-
 *      INSERT, since the table has no UNIQUE on hash).
 *   4. Update the three already-applied rows so their `created_at`
 *      matches the new journal `when` values (so future migrations
 *      stay monotonic and `db:migrate` is a no-op).
 *
 * Safe to run multiple times. Detects the prior repair and short-
 * circuits.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(__dirname, "../src/migrations");

const DEFAULT_DIRECT_CONNECTION =
  "postgresql://postgres:postgres@localhost:5434/nautilo";
const conn = process.env["DB_DIRECT_CONNECTION"] ?? DEFAULT_DIRECT_CONNECTION;

/** Read a migration file and compute the hash exactly the way drizzle-orm does. */
function loadMigration(tag) {
  const path = join(migrationsDir, `${tag}.sql`);
  const sql = readFileSync(path, "utf8");
  const hash = createHash("sha256").update(sql).digest("hex");
  return { tag, sql, hash };
}

const D104_TABLE = loadMigration("0026_d104_logto_account_security");
const D104_PURPOSE = loadMigration("0027_d104_recovery_codes_purpose");
const M066_INVITES = loadMigration("0028_m066_invites");
const M066_CONSTRAINTS = loadMigration("0029_m066_invites_constraints");
const AMBITIOUS = loadMigration("0030_ambitious_betty_brant");

const sql = postgres(conn, { max: 1 });

async function main() {
  console.log(`[repair] connecting to ${conn.replace(/:[^:@]+@/, ":***@")}`);

  // Snapshot current __drizzle_migrations state so we can report what we
  // changed and short-circuit on second runs.
  const before = await sql`
    select id, hash, created_at
    from drizzle.__drizzle_migrations
    order by created_at asc, id asc
  `;
  console.log(`[repair] current __drizzle_migrations rows: ${before.length}`);
  for (const row of before) {
    const known =
      row.hash === D104_TABLE.hash ? "0026_d104_logto_account_security" :
      row.hash === D104_PURPOSE.hash ? "0027_d104_recovery_codes_purpose" :
      row.hash === M066_INVITES.hash ? "m066 invites (table)" :
      row.hash === M066_CONSTRAINTS.hash ? "m066 invites (constraints)" :
      row.hash === AMBITIOUS.hash ? "ambitious_betty_brant" :
      "(unknown — pre-m066 chain)";
    console.log(`  - id=${row.id} created_at=${row.created_at} ${known}`);
  }

  const haveD104Table = before.some((r) => r.hash === D104_TABLE.hash);
  const haveD104Purpose = before.some((r) => r.hash === D104_PURPOSE.hash);
  const haveM066Invites = before.some((r) => r.hash === M066_INVITES.hash);
  const haveM066Constraints = before.some((r) => r.hash === M066_CONSTRAINTS.hash);
  const haveAmbitious = before.some((r) => r.hash === AMBITIOUS.hash);

  if (!haveM066Invites || !haveM066Constraints) {
    throw new Error(
      "[repair] ABORT: expected to find existing m066 rows in " +
        "__drizzle_migrations (matched by SQL hash). This script is only " +
        "valid on a DB that previously applied the pre-merge m066 chain.",
    );
  }

  // Ambitious_betty_brant may or may not have been applied locally
  // (the merge command's flow doesn't guarantee it). Detect by index
  // presence rather than __drizzle_migrations row, since the original
  // migration was created via drizzle-kit generate and may have been
  // applied via push without recording. We always end up with both
  // the index AND the row in place.
  const indexCheck = await sql`
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'groups'
      and indexname = 'uq_groups_agent_id_type'
    limit 1
  `;
  const ambitiousIndexExists = indexCheck.length > 0;
  console.log(
    `[repair] ambitious_betty_brant: row=${haveAmbitious} index=${ambitiousIndexExists}`,
  );

  await sql.begin(async (tx) => {
    if (!haveD104Table) {
      console.log(`[repair] applying 0026_d104_logto_account_security.sql`);
      await tx.unsafe(D104_TABLE.sql);
      await tx`
        insert into drizzle.__drizzle_migrations ("hash", "created_at")
        values (${D104_TABLE.hash}, ${1777700000000})
      `;
    } else {
      console.log(`[repair] 0026_d104_logto_account_security already recorded — skip`);
    }

    if (!haveD104Purpose) {
      console.log(`[repair] applying 0027_d104_recovery_codes_purpose.sql`);
      await tx.unsafe(D104_PURPOSE.sql);
      await tx`
        insert into drizzle.__drizzle_migrations ("hash", "created_at")
        values (${D104_PURPOSE.hash}, ${1777700001000})
      `;
    } else {
      console.log(`[repair] 0027_d104_recovery_codes_purpose already recorded — skip`);
    }

    console.log(`[repair] re-stamping created_at for renamed migrations`);
    await tx`
      update drizzle.__drizzle_migrations
      set created_at = ${1777700002000}
      where hash = ${M066_INVITES.hash}
    `;
    await tx`
      update drizzle.__drizzle_migrations
      set created_at = ${1777700002001}
      where hash = ${M066_CONSTRAINTS.hash}
    `;

    // ambitious_betty_brant: create the index if missing, then ensure
    // a __drizzle_migrations row exists with the new monotonic
    // created_at. CREATE UNIQUE INDEX IF NOT EXISTS keeps this safe
    // whether the index was previously applied or not.
    if (!ambitiousIndexExists) {
      console.log(`[repair] creating uq_groups_agent_id_type (was missing)`);
      await tx.unsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "uq_groups_agent_id_type" ` +
          `ON "groups" USING btree ("agent_id","type") ` +
          `WHERE "groups"."agent_id" IS NOT NULL`,
      );
    } else {
      console.log(`[repair] uq_groups_agent_id_type already present — skip DDL`);
    }
    if (haveAmbitious) {
      await tx`
        update drizzle.__drizzle_migrations
        set created_at = ${1777700003000}
        where hash = ${AMBITIOUS.hash}
      `;
    } else {
      console.log(`[repair] inserting __drizzle_migrations row for ambitious_betty_brant`);
      await tx`
        insert into drizzle.__drizzle_migrations ("hash", "created_at")
        values (${AMBITIOUS.hash}, ${1777700003000})
      `;
    }
  });

  const after = await sql`
    select hash, created_at
    from drizzle.__drizzle_migrations
    order by created_at asc
  `;
  console.log(`[repair] DONE. __drizzle_migrations is now:`);
  for (const row of after) {
    const known =
      row.hash === D104_TABLE.hash ? "0026_d104_logto_account_security" :
      row.hash === D104_PURPOSE.hash ? "0027_d104_recovery_codes_purpose" :
      row.hash === M066_INVITES.hash ? "0028_m066_invites" :
      row.hash === M066_CONSTRAINTS.hash ? "0029_m066_invites_constraints" :
      row.hash === AMBITIOUS.hash ? "0030_ambitious_betty_brant" :
      "(other / pre-m066)";
    console.log(`  created_at=${row.created_at} ${known}`);
  }
  console.log(
    `[repair] Next \`bun run db:migrate\` should be a no-op. ` +
      `If it tries to apply anything, stop and report the output.`,
  );
}

try {
  await main();
} finally {
  await sql.end();
}
