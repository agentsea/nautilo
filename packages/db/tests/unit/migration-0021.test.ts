/**
 * M051: validates that migration `0021_m051_add_users_external_id.sql`
 * exists with the expected shape and that the journal references it.
 *
 * This is a content-only test — it does NOT apply the migration to a
 * database. The intent is to catch accidental edits or renames that
 * would break the M051/M052/M053 cluster contract.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const MIGRATION_PATH = resolve(MIGRATIONS_DIR, "0021_m051_add_users_external_id.sql");
const JOURNAL_PATH = resolve(MIGRATIONS_DIR, "meta/_journal.json");

describe("0021_m051_add_users_external_id", () => {
  test("ALTER TABLE adds nullable external_id text column", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf-8");
    expect(sql).toContain('ALTER TABLE "users" ADD COLUMN "external_id" text');
    // Nullable: no NOT NULL clause on the column add.
    expect(sql).not.toMatch(/external_id"\s+text\s+NOT NULL/i);
  });

  test("creates a partial unique index keyed on external_id WHERE NOT NULL", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf-8");
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "users_external_id_unique" ON "users" ("external_id")',
    );
    // Partial predicate: legacy NULL rows must coexist freely.
    expect(sql).toMatch(/WHERE\s+"external_id"\s+IS\s+NOT\s+NULL/i);
  });

  test("journal entry references the M051-tagged migration at idx 21", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const m051Entry = journal.entries.find((e) => e.idx === 21);
    expect(m051Entry).toBeDefined();
    expect(m051Entry?.tag).toBe("0021_m051_add_users_external_id");
  });
});
