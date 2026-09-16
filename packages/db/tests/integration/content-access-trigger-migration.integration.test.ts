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
        const firstTags = index === 0
          ? ["0281_melodic_sister_grimm", "0282_content_access_receipt_immutability"]
          : ["0281_melodic_sister_grimm"];
        const firstFixture = migrationFixture(firstTags);
        try {
          await migrate(drizzle(sql), { migrationsFolder: firstFixture });
        } finally {
          rmSync(firstFixture, { recursive: true, force: true });
        }
        if (index === 1) {
          await sql.unsafe(`
            INSERT INTO artifacts (id) VALUES ('00000000-0000-4000-8000-000000000001');
            INSERT INTO content_access_operations
              (operation_id, request_digest, artifact_id, outcome, changed,
               attached_count, detached_count, skipped_count)
            VALUES
              ('00000000-0000-4000-8000-000000000002', repeat('a', 64),
               '00000000-0000-4000-8000-000000000001', 'applied', true, 1, 0, 0);
          `);
          const upgradeFixture = migrationFixture([
            "0281_melodic_sister_grimm",
            "0282_content_access_receipt_immutability",
          ]);
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

        const privileges = await sql<{ allowed: boolean }[]>`
          SELECT has_table_privilege('nautilo', 'public.content_access_operations', 'TRIGGER') AS allowed
        `;
        expect(privileges[0]?.allowed).toBe(false);
        const triggers = await sql<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM pg_trigger
          WHERE tgrelid = 'public.content_access_operations'::regclass
            AND NOT tgisinternal
        `;
        expect(triggers[0]?.count).toBe(2);
        if (index === 1) {
          const privileged = postgres(databaseUrl(database), { max: 1 });
          let mutationError: unknown;
          try {
            await privileged.unsafe(`
              UPDATE content_access_operations SET skipped_count = 1
              WHERE operation_id = '00000000-0000-4000-8000-000000000002'
            `);
          } catch (error) {
            mutationError = error;
          } finally {
            await privileged.end({ timeout: 5 });
          }
          expect(mutationError).toBeInstanceOf(Error);
          expect((mutationError as Error).message).toContain("Content access receipts are immutable");
        }
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  }
});
