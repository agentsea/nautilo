/**
 * M061: validates migration `0025_m061_users_server_role.sql` shape and
 * journal entry. Content-only — does not apply SQL to a database.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const MIGRATION_PATH = resolve(MIGRATIONS_DIR, "0025_m061_users_server_role.sql");
const JOURNAL_PATH = resolve(MIGRATIONS_DIR, "meta/_journal.json");

describe("0025_m061_users_server_role", () => {
  test("ALTER TABLE adds server_role text NOT NULL with default user", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf-8");
    expect(sql).toMatch(
      /ALTER TABLE "users" ADD COLUMN "server_role" text DEFAULT 'user' NOT NULL/i,
    );
  });

  test("CHECK constraint restricts server_role to admin and user", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf-8");
    expect(sql).toContain("users_server_role_check");
    expect(sql).toMatch(/CHECK\s*\(\s*"server_role"\s+IN\s*\(\s*'admin'\s*,\s*'user'\s*\)\s*\)/i);
  });

  test("backfill sets admin for local users (server IS NULL)", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf-8");
    expect(sql).toMatch(
      /UPDATE\s+"users"\s+SET\s+"server_role"\s*=\s*'admin'\s+WHERE\s+"server"\s+IS\s+NULL/i,
    );
  });

  test("journal entry references the M061-tagged migration at idx 25", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const entry = journal.entries.find((e) => e.idx === 25);
    expect(entry).toBeDefined();
    expect(entry?.tag).toBe("0025_m061_users_server_role");
  });

  test("journal tags match migration SQL files without duplicate slots", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const journalTags = journal.entries.map((entry) => entry.tag);
    const migrationTags = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.replace(/\.sql$/, ""));
    const slots = migrationTags.map((tag) => tag.split("_", 1)[0]);

    expect(new Set(journalTags).size).toBe(journalTags.length);
    expect(new Set(slots).size).toBe(slots.length);
    expect(new Set(journalTags)).toEqual(new Set(migrationTags));
  });
});
