import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres, { type Sql } from "postgres";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

const adminUrl =
  process.env["NAUTILO_PERSONAL_PROVIDER_MIGRATION_TEST_ADMIN_URL"];
const selectedInstanceId = process.env["NAUTILO_INSTANCE_ID"]?.trim();
const suite = adminUrl ? describe : describe.skip;
const suffix = randomUUID().replaceAll("-", "_");
const databaseNames = [
  `nautilo_pp_${suffix}_fresh`,
  `nautilo_pp_${suffix}_populated`,
];
let admin: Sql | undefined;
const createdDatabases = new Set<string>();

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function databaseUrl(database: string): string {
  const url = new URL(adminUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

suite("personal provider credential migration baselines", () => {
  beforeAll(async () => {
    const effectiveInstanceId = bootstrapTestDbInstance();
    if (
      !selectedInstanceId
      || effectiveInstanceId === "(default)"
      || effectiveInstanceId !== selectedInstanceId
    ) {
      throw new Error(
        "Migration baseline requires an explicit named NAUTILO_INSTANCE_ID",
      );
    }
    admin = postgres(adminUrl!, { max: 1 });
    const identity = await admin<{ instance_id: string }[]>`
      SELECT instance_id
      FROM public.nautilo_instance_identity
      WHERE id = 'self'
    `;
    if (identity.length !== 1 || identity[0]?.instance_id !== selectedInstanceId) {
      throw new Error(
        "Migration admin connection does not match the selected instance",
      );
    }
    const existingDatabases = await admin<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datname IN ${admin(databaseNames)}
    `;
    if (existingDatabases.length > 0) {
      throw new Error("Refusing pre-existing migration test databases");
    }
    for (const database of databaseNames) {
      await admin.unsafe(
        `CREATE DATABASE ${quoteIdentifier(database)} OWNER nautilo`,
      );
      createdDatabases.add(database);
    }
  });

  afterAll(async () => {
    if (!admin) return;
    for (const database of createdDatabases) {
      await admin.unsafe(`DROP DATABASE ${quoteIdentifier(database)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  });

  for (const [index, database] of databaseNames.entries()) {
    test(index === 0 ? "fresh baseline" : "populated upgrade baseline", async () => {
      const db = postgres(databaseUrl(database), { max: 1 });
      try {
        await db.unsafe('SET ROLE "nautilo"');
        await db.unsafe("CREATE TABLE users (id uuid PRIMARY KEY)");
        const existingUserId = randomUUID();
        if (index === 1) {
          await db`INSERT INTO users (id) VALUES (${existingUserId})`;
        }
        const migration = await readFile(
          join(import.meta.dir, "../../src/migrations/0305_personal_provider_credentials.sql"),
          "utf8",
        );
        await db.unsafe(migration.replaceAll("--> statement-breakpoint", ""));

        const state = await db<{
          credential_count: number;
          user_count: number;
        }[]>`
          SELECT
            (SELECT count(*)::int FROM personal_provider_credentials) AS credential_count,
            (SELECT count(*)::int FROM users) AS user_count
        `;
        expect(state[0]).toEqual({
          credential_count: 0,
          user_count: index,
        });
        const privileges = await db<{
          agent_access: boolean;
          crypto_access: boolean;
          product_access: boolean;
        }[]>`
          SELECT
            has_table_privilege('nautilo', 'personal_provider_credentials', 'SELECT, INSERT, UPDATE, DELETE') AS product_access,
            has_table_privilege('nautilo_agent', 'personal_provider_credentials', 'SELECT, INSERT, UPDATE, DELETE') AS agent_access,
            has_table_privilege('nautilo_crypto', 'personal_provider_credentials', 'SELECT, INSERT, UPDATE, DELETE') AS crypto_access
        `;
        expect(privileges[0]).toEqual({
          product_access: true,
          agent_access: false,
          crypto_access: false,
        });
      } finally {
        await db.end({ timeout: 5 });
      }
    });
  }
});
