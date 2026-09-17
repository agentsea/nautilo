import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";

const adminUrl = process.env["NAUTILO_CONTENT_ACCESS_MIGRATION_TEST_ADMIN_URL"];
const suite = adminUrl ? describe : describe.skip;
const runSuffix = randomUUID().replaceAll("-", "").slice(0, 12);
const databaseNames = [
  `nautilo_content_access_fresh_${runSuffix}`,
  `nautilo_content_access_populated_${runSuffix}`,
];
const receiptMigrationTags = [
  "0281_melodic_sister_grimm",
  "0282_content_access_receipt_immutability",
  "0294_content_access_receipt_fk_permissions",
];
const createdDatabases = new Set<string>();
const createdRoles: string[] = [];
let admin: Sql | undefined;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function databaseUrl(database: string, role?: { name: string; password: string }): string {
  const url = new URL(adminUrl!);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role.name;
    url.password = role.password;
  }
  return url.toString();
}

function migrationFixture(tags: string[], withoutTriggerRepair = false): string {
  const sourceRoot = resolve(import.meta.dir, "../../src/migrations");
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), "nautilo-content-access-migrations-"));
  mkdirSync(resolve(fixtureRoot, "meta"));
  const journal = JSON.parse(readFileSync(resolve(sourceRoot, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  writeFileSync(
    resolve(fixtureRoot, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.filter(({ tag }) => tags.includes(tag)) }),
  );
  for (const tag of tags) {
    const destination = resolve(fixtureRoot, `${tag}.sql`);
    cpSync(resolve(sourceRoot, `${tag}.sql`), destination);
    if (withoutTriggerRepair && tag === "0282_content_access_receipt_immutability") {
      const source = readFileSync(destination, "utf8");
      writeFileSync(
        destination,
        source
          .replace('GRANT TRIGGER ON TABLE "content_access_operations" TO "nautilo";--> statement-breakpoint\n', "")
          .replace('REVOKE TRIGGER ON TABLE "content_access_operations" FROM "nautilo";--> statement-breakpoint\n', ""),
      );
    }
  }
  return fixtureRoot;
}

async function expectDatabaseError(
  operation: () => Promise<unknown>,
  code: string,
  message?: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const databaseError = error as { code?: string; message?: string };
    expect(databaseError.code).toBe(code);
    if (message) expect(databaseError.message).toContain(message);
    return;
  }
  throw new Error(`expected database error ${code}`);
}

suite("content access trigger migration role ordering", () => {
  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1 });
    const existing = await admin<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles
      WHERE rolname IN ('nautilo', 'nautilo_agent', 'nautilo_crypto')
    `;
    if (existing.length > 0) {
      throw new Error(`Dedicated migration test cluster required; refusing pre-existing roles: ${existing.map(({ rolname }) => rolname).join(", ")}`);
    }
    const existingDatabases = await admin<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datname IN ${admin(databaseNames)}
    `;
    if (existingDatabases.length > 0) {
      throw new Error(`Refusing pre-existing migration test databases: ${existingDatabases.map(({ datname }) => datname).join(", ")}`);
    }
    await admin.unsafe(`CREATE ROLE nautilo LOGIN PASSWORD 'synthetic-nautilo'`);
    createdRoles.push("nautilo");
    await admin.unsafe(`CREATE ROLE nautilo_agent`);
    createdRoles.push("nautilo_agent");
    await admin.unsafe(`CREATE ROLE nautilo_crypto`);
    createdRoles.push("nautilo_crypto");
    for (const database of databaseNames) {
      await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(database)} OWNER nautilo`);
      createdDatabases.add(database);
    }
  });

  afterAll(async () => {
    if (!admin) return;
    for (const database of createdDatabases) {
      await admin.unsafe(`DROP DATABASE ${quoteIdentifier(database)} WITH (FORCE)`);
    }
    for (const role of createdRoles.reverse()) await admin.unsafe(`DROP ROLE ${quoteIdentifier(role)}`);
    await admin.end({ timeout: 5 });
  });

  for (const [index, database] of databaseNames.entries()) {
    test(index === 0 ? "fresh role migration" : "populated role migration", async () => {
      const sql = postgres(databaseUrl(database, { name: "nautilo", password: "synthetic-nautilo" }), { max: 1 });
      try {
        await sql.unsafe(`
          CREATE TABLE users (id uuid PRIMARY KEY);
          CREATE TABLE actors (id uuid PRIMARY KEY);
          CREATE TABLE memories (id uuid PRIMARY KEY);
          CREATE TABLE artifacts (id uuid PRIMARY KEY);
        `);
        if (index === 0) {
          const brokenFixture = migrationFixture(
            ["0281_melodic_sister_grimm", "0282_content_access_receipt_immutability"],
            true,
          );
          let brokenError: unknown;
          try {
            await migrate(drizzle(sql), { migrationsFolder: brokenFixture });
          } catch (error) {
            brokenError = error;
          } finally {
            rmSync(brokenFixture, { recursive: true, force: true });
          }
          expect(brokenError).toBeInstanceOf(Error);
          expect((brokenError as Error & { cause?: Error }).cause?.message).toContain(
            "permission denied for table content_access_operations",
          );
          const rollback = await sql<{ table_exists: boolean; journal_rows: number }[]>`
            SELECT
              to_regclass('public.content_access_operations') IS NOT NULL AS table_exists,
              (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS journal_rows
          `;
          expect(rollback[0]).toEqual({ table_exists: false, journal_rows: 0 });
        }
        const firstTags = index === 0 ? receiptMigrationTags : ["0281_melodic_sister_grimm"];
        const firstFixture = migrationFixture(firstTags);
        try {
          await migrate(drizzle(sql), { migrationsFolder: firstFixture });
        } finally {
          rmSync(firstFixture, { recursive: true, force: true });
        }
        const fixture = {
          userId: `00000000-0000-4000-8000-00000000001${index}`,
          actorId: `00000000-0000-4000-8000-00000000002${index}`,
          memoryId: `00000000-0000-4000-8000-00000000003${index}`,
          artifactId: `00000000-0000-4000-8000-00000000004${index}`,
          artifactOperationId: `00000000-0000-4000-8000-00000000005${index}`,
          memoryOperationId: `00000000-0000-4000-8000-00000000006${index}`,
        };
        await sql.unsafe(`
          INSERT INTO users (id) VALUES ('${fixture.userId}');
          INSERT INTO actors (id) VALUES ('${fixture.actorId}');
          INSERT INTO memories (id) VALUES ('${fixture.memoryId}');
          INSERT INTO artifacts (id) VALUES ('${fixture.artifactId}');
          INSERT INTO content_access_operations
            (operation_id, request_digest, requester_user_id, requester_actor_id,
             artifact_id, outcome, changed, attached_count, detached_count, skipped_count)
          VALUES
            ('${fixture.artifactOperationId}', repeat('a', 64), '${fixture.userId}', '${fixture.actorId}',
             '${fixture.artifactId}', 'applied', true, 1, 0, 0);
          INSERT INTO content_access_operations
            (operation_id, request_digest, requester_user_id, requester_actor_id,
             memory_id, outcome, changed, attached_count, detached_count, skipped_count)
          VALUES
            ('${fixture.memoryOperationId}', repeat('b', 64), '${fixture.userId}', '${fixture.actorId}',
             '${fixture.memoryId}', 'denied', false, 0, 0, 0);
        `);

        if (index === 1) {
          const preFixPrivileges = await sql<{ can_delete: boolean; can_update: boolean }[]>`
            SELECT
              has_table_privilege('nautilo', 'public.content_access_operations', 'UPDATE') AS can_update,
              has_table_privilege('nautilo', 'public.content_access_operations', 'DELETE') AS can_delete
          `;
          expect(preFixPrivileges[0]).toEqual({ can_update: false, can_delete: false });
          await expectDatabaseError(
            () => sql`DELETE FROM users WHERE id = ${fixture.userId}`,
            "42501",
            "permission denied for table content_access_operations",
          );
          await expectDatabaseError(
            () => sql`DELETE FROM artifacts WHERE id = ${fixture.artifactId}`,
            "42501",
            "permission denied for table content_access_operations",
          );

          const upgradeFixture = migrationFixture(receiptMigrationTags);
          try {
            await migrate(drizzle(sql), { migrationsFolder: upgradeFixture });
            const journalBefore = await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`;
            const completedSql = resolve(upgradeFixture, "0282_content_access_receipt_immutability.sql");
            writeFileSync(completedSql, `${readFileSync(completedSql, "utf8")}\n-- Changed file hash must not replay a completed timestamp.\n`);
            await migrate(drizzle(sql), { migrationsFolder: upgradeFixture });
            const journalAfter = await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`;
            expect([...journalAfter]).toEqual([...journalBefore]);
          } finally {
            rmSync(upgradeFixture, { recursive: true, force: true });
          }
        }

        const privileges = await sql<{
          can_delete: boolean;
          can_insert: boolean;
          can_references: boolean;
          can_select: boolean;
          can_trigger: boolean;
          can_truncate: boolean;
          can_update: boolean;
        }[]>`
          SELECT
            has_table_privilege('nautilo', 'public.content_access_operations', 'SELECT') AS can_select,
            has_table_privilege('nautilo', 'public.content_access_operations', 'INSERT') AS can_insert,
            has_table_privilege('nautilo', 'public.content_access_operations', 'UPDATE') AS can_update,
            has_table_privilege('nautilo', 'public.content_access_operations', 'DELETE') AS can_delete,
            has_table_privilege('nautilo', 'public.content_access_operations', 'TRUNCATE') AS can_truncate,
            has_table_privilege('nautilo', 'public.content_access_operations', 'REFERENCES') AS can_references,
            has_table_privilege('nautilo', 'public.content_access_operations', 'TRIGGER') AS can_trigger
        `;
        expect(privileges[0]).toEqual({
          can_select: true,
          can_insert: true,
          can_update: true,
          can_delete: true,
          can_truncate: false,
          can_references: false,
          can_trigger: false,
        });
        for (const role of ["nautilo_agent", "nautilo_crypto"] as const) {
          const denied = await sql<{ allowed: boolean }[]>`
            SELECT has_table_privilege(
              ${role}, 'public.content_access_operations',
              'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
            ) AS allowed
          `;
          expect(denied[0]?.allowed).toBe(false);
        }
        const triggers = await sql<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM pg_trigger
          WHERE tgrelid = 'public.content_access_operations'::regclass
            AND NOT tgisinternal
        `;
        expect(triggers[0]?.count).toBe(2);

        const original = await sql`
          SELECT operation_id, request_digest, requester_user_id, requester_actor_id,
                 memory_id, artifact_id, outcome, changed,
                 attached_count, detached_count, skipped_count
          FROM content_access_operations
          ORDER BY operation_id
        `;
        const hiddenUpdate = await sql<{ operation_id: string }[]>`
          UPDATE content_access_operations SET skipped_count = skipped_count + 1
          WHERE operation_id = ${fixture.artifactOperationId}
          RETURNING operation_id
        `;
        const hiddenDelete = await sql<{ operation_id: string }[]>`
          DELETE FROM content_access_operations
          WHERE operation_id = ${fixture.artifactOperationId}
          RETURNING operation_id
        `;
        expect([...hiddenUpdate]).toEqual([]);
        expect([...hiddenDelete]).toEqual([]);
        expect([...await sql`SELECT operation_id, request_digest, requester_user_id, requester_actor_id,
          memory_id, artifact_id, outcome, changed, attached_count, detached_count, skipped_count
          FROM content_access_operations ORDER BY operation_id`]).toEqual([...original]);

        if (index === 1) {
          const privileged = postgres(databaseUrl(database), { max: 1 });
          let mutationError: unknown;
          try {
            await privileged`
              UPDATE content_access_operations SET skipped_count = 1
              WHERE operation_id = ${fixture.artifactOperationId}
            `;
          } catch (error) {
            mutationError = error;
          } finally {
            await privileged.end({ timeout: 5 });
          }
          expect(mutationError).toBeInstanceOf(Error);
          expect((mutationError as Error).message).toContain("Content access receipts are immutable");
        }

        await admin!.unsafe("ALTER ROLE nautilo BYPASSRLS");
        await expectDatabaseError(
          () => sql`UPDATE content_access_operations SET skipped_count = skipped_count + 1
            WHERE operation_id = ${fixture.artifactOperationId}`,
          "23514",
          "Content access receipts are immutable",
        );
        await expectDatabaseError(
          () => sql`DELETE FROM content_access_operations
            WHERE operation_id = ${fixture.artifactOperationId}`,
          "23514",
          "Content access receipts are immutable",
        );
        await expectDatabaseError(() => sql`TRUNCATE TABLE content_access_operations`, "42501");
        expect([...await sql`SELECT operation_id, request_digest, requester_user_id, requester_actor_id,
          memory_id, artifact_id, outcome, changed, attached_count, detached_count, skipped_count
          FROM content_access_operations ORDER BY operation_id`]).toEqual([...original]);

        if (index === 0) await admin!.unsafe("ALTER ROLE nautilo NOBYPASSRLS");
        await sql`DELETE FROM users WHERE id = ${fixture.userId}`;
        await sql`DELETE FROM actors WHERE id = ${fixture.actorId}`;
        const anonymized = await sql`
          SELECT operation_id, request_digest, requester_user_id, requester_actor_id,
                 memory_id, artifact_id, outcome, changed,
                 attached_count, detached_count, skipped_count
          FROM content_access_operations
          ORDER BY operation_id
        `;
        expect([...anonymized]).toEqual([...original].map((row) => ({
          ...row,
          requester_actor_id: null,
          requester_user_id: null,
        })));
        await sql`DELETE FROM artifacts WHERE id = ${fixture.artifactId}`;
        const afterArtifact = await sql<{ operation_id: string }[]>`
          SELECT operation_id FROM content_access_operations ORDER BY operation_id
        `;
        expect([...afterArtifact]).toEqual([{ operation_id: fixture.memoryOperationId }]);
        await sql`DELETE FROM memories WHERE id = ${fixture.memoryId}`;
        const afterMemory = await sql<{ operation_id: string }[]>`
          SELECT operation_id FROM content_access_operations
        `;
        expect([...afterMemory]).toEqual([]);
      } finally {
        await admin!.unsafe("ALTER ROLE nautilo NOBYPASSRLS");
        await sql.end({ timeout: 5 });
      }
    });
  }
});
