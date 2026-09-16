import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import {
  ensureDatabase,
  resolveDirectDatabaseConnectionString,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

function stripStatementBreakpoints(sqlText: string): string {
  return sqlText.replace(/-->\s*statement-breakpoint/g, "");
}

const migration = stripStatementBreakpoints(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../../src/migrations/0157_m246_community_capability_substrate.sql",
    ),
    "utf8",
  ),
);

const canonicalRoles = [
  "owner",
  "admin",
  "superuser",
  "member",
  "contributor",
  "guest",
] as const;

const newCapabilities = ["invoke_agents", "write_artifacts"] as const;

let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  sql = postgres(resolveDirectDatabaseConnectionString(), { max: 1 });
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

async function createIsolatedRbacTables(
  tx: postgres.TransactionSql,
): Promise<void> {
  await tx`CREATE TEMP TABLE capabilities (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    slug text NOT NULL UNIQUE,
    description text NOT NULL,
    category text NOT NULL
  ) ON COMMIT DROP`;
  await tx`CREATE TEMP TABLE roles (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    slug text NOT NULL UNIQUE,
    label text NOT NULL,
    is_system boolean NOT NULL
  ) ON COMMIT DROP`;
  await tx`CREATE TEMP TABLE role_capabilities (
    role_id text NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    capability_id text NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, capability_id)
  ) ON COMMIT DROP`;
}

async function insertCanonicalRoles(
  tx: postgres.TransactionSql,
): Promise<void> {
  for (const slug of canonicalRoles) {
    await tx`
      INSERT INTO roles (slug, label, is_system)
      VALUES (${slug}, ${slug}, true)
    `;
  }
}

describe("M246 migration 0157 populated compatibility", () => {
  test("fresh migration-boundary Roles receive the exact canonical matrix", async () => {
    await sql.begin(async (tx) => {
      await createIsolatedRbacTables(tx);
      await insertCanonicalRoles(tx);

      await tx.unsafe(migration);

      const catalogue = await tx<
        { slug: string; category: string }[]
      >`SELECT slug, category FROM capabilities ORDER BY slug`;
      expect(
        catalogue.map((row) => ({
          slug: row.slug,
          category: row.category,
        })),
      ).toEqual([
        { slug: "invoke_agents", category: "agents" },
        { slug: "write_artifacts", category: "artifacts" },
      ]);

      const rows = await tx<{ role_slug: string; cap_slug: string }[]>`
        SELECT roles.slug AS role_slug, capabilities.slug AS cap_slug
        FROM role_capabilities
        JOIN roles ON roles.id = role_capabilities.role_id
        JOIN capabilities ON capabilities.id = role_capabilities.capability_id
        ORDER BY roles.slug, capabilities.slug
      `;

      for (const role of canonicalRoles) {
        const granted = rows
          .filter((row) => row.role_slug === role)
          .map((row) => row.cap_slug);
        expect(granted).toEqual(
          role === "guest" ? [] : [...newCapabilities].sort(),
        );
      }
    });
  });

  test("existing custom Roles gain both without losing grants or duplicating on replay", async () => {
    await sql.begin(async (tx) => {
      await createIsolatedRbacTables(tx);
      await insertCanonicalRoles(tx);
      await tx`
        INSERT INTO capabilities (slug, description, category)
        VALUES ('manage_rooms', 'existing unrelated grant', 'rooms')
      `;
      await tx`
        INSERT INTO roles (slug, label, is_system)
        VALUES
          ('custom-empty', 'Custom Empty', false),
          ('custom-existing', 'Custom Existing', false),
          ('future-system-role', 'Future System Role', true)
      `;
      await tx`
        INSERT INTO role_capabilities (role_id, capability_id)
        SELECT roles.id, capabilities.id
        FROM roles
        CROSS JOIN capabilities
        WHERE roles.slug = 'custom-existing'
          AND capabilities.slug = 'manage_rooms'
      `;

      await tx.unsafe(migration);
      await tx.unsafe(migration);

      const grants = await tx<{ role_slug: string; cap_slug: string }[]>`
        SELECT roles.slug AS role_slug, capabilities.slug AS cap_slug
        FROM role_capabilities
        JOIN roles ON roles.id = role_capabilities.role_id
        JOIN capabilities ON capabilities.id = role_capabilities.capability_id
        WHERE roles.slug IN (
          'custom-empty',
          'custom-existing',
          'future-system-role',
          'guest'
        )
        ORDER BY roles.slug, capabilities.slug
      `;

      expect(
        grants
          .filter((row) => row.role_slug === "custom-empty")
          .map((row) => row.cap_slug),
      ).toEqual([...newCapabilities].sort());
      expect(
        grants
          .filter((row) => row.role_slug === "custom-existing")
          .map((row) => row.cap_slug),
      ).toEqual(["invoke_agents", "manage_rooms", "write_artifacts"]);
      expect(
        grants.filter((row) => row.role_slug === "future-system-role"),
      ).toEqual([]);
      expect(grants.filter((row) => row.role_slug === "guest")).toEqual([]);

      const duplicateCounts = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM role_capabilities
        JOIN roles ON roles.id = role_capabilities.role_id
        WHERE roles.slug IN ('custom-empty', 'custom-existing')
      `;
      expect(duplicateCounts[0]?.count).toBe(5);
    });
  });

  test("a custom Role created after the one-time migration inherits nothing", async () => {
    await sql.begin(async (tx) => {
      await createIsolatedRbacTables(tx);
      await insertCanonicalRoles(tx);
      await tx.unsafe(migration);
      await tx`
        INSERT INTO roles (slug, label, is_system)
        VALUES ('custom-after-upgrade', 'Custom After Upgrade', false)
      `;

      const grants = await tx<{ cap_slug: string }[]>`
        SELECT capabilities.slug AS cap_slug
        FROM role_capabilities
        JOIN roles ON roles.id = role_capabilities.role_id
        JOIN capabilities ON capabilities.id = role_capabilities.capability_id
        WHERE roles.slug = 'custom-after-upgrade'
      `;
      expect(grants).toHaveLength(0);
    });
  });
});
