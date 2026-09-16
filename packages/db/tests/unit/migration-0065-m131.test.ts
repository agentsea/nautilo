/**
 * M131 — validates migration `0065_yellow_black_queen.sql` (Group→Role
 * M:N) and its journal entry at idx 65.
 *
 * Checks the Group-to-Role junction and migration backfill contract.
 *
 * Text-only assertions on the SQL — populated-DB apply coverage is the
 * operator's manual-QA / integration step (requires applying the
 * migration). Per coordinator rules, unit tests must be independent of
 * any DB/server, so we inspect the SQL shape. This still catches the
 * load-bearing mistake: the migration MUST backfill every existing
 * `groups.role_id` into the new `group_roles` junction BEFORE dropping
 * the `role_id` column — otherwise every Human silently loses their Role
 * on migrate (the one data-loss risk called out in the issue).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const M0065 = resolve(MIGRATIONS_DIR, "0065_yellow_black_queen.sql");
const JOURNAL_PATH = resolve(MIGRATIONS_DIR, "meta/_journal.json");

const SQL = readFileSync(M0065, "utf-8");

function find(needle: string): number {
  return SQL.toLowerCase().indexOf(needle.toLowerCase());
}

describe("M131 migration 0065 — journal", () => {
  test("journal references 0065 at idx 65 with the right tag", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const e65 = journal.entries.find((e) => e.idx === 65);
    expect(e65?.tag).toBe("0065_yellow_black_queen");
  });
});

describe("M131 migration 0065 — group_roles junction shape", () => {
  test("creates the group_roles table (IF NOT EXISTS — tolerates stray push drift)", () => {
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS "group_roles"/i);
  });

  test("group_roles has a composite (group_id, role_id) primary key", () => {
    expect(SQL).toMatch(
      /CONSTRAINT "group_roles_group_id_role_id_pk" PRIMARY KEY\("group_id","role_id"\)/i,
    );
  });

  test("group_roles FKs cascade on delete to groups and roles", () => {
    expect(SQL).toMatch(
      /"group_roles_group_id_groups_id_fk"[\s\S]*?REFERENCES "public"\."groups"\("id"\) ON DELETE cascade/i,
    );
    expect(SQL).toMatch(
      /"group_roles_role_id_roles_id_fk"[\s\S]*?REFERENCES "public"\."roles"\("id"\) ON DELETE cascade/i,
    );
  });
});

describe("M131 migration 0065 — data-preserving backfill (load-bearing)", () => {
  test("backfills every existing groups.role_id into group_roles", () => {
    expect(SQL).toMatch(
      /INSERT INTO "group_roles" \("group_id",\s*"role_id"\)[\s\S]*?SELECT "id",\s*"role_id" FROM "groups"/i,
    );
  });

  test("backfill is idempotent (ON CONFLICT DO NOTHING)", () => {
    const insertIdx = find('INSERT INTO "group_roles"');
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    const body = SQL.slice(insertIdx);
    expect(body).toMatch(/ON CONFLICT DO NOTHING/i);
  });

  test("the backfill runs BEFORE the role_id column is dropped", () => {
    const backfillIdx = find('INSERT INTO "group_roles"');
    const dropIdx = find('ALTER TABLE "groups" DROP COLUMN "role_id"');
    expect(backfillIdx).toBeGreaterThanOrEqual(0);
    expect(dropIdx).toBeGreaterThan(backfillIdx);
  });

  test("group_roles FKs exist before the backfill INSERT (junction usable)", () => {
    const groupFkIdx = find('ADD CONSTRAINT "group_roles_group_id_groups_id_fk"');
    const roleFkIdx = find('ADD CONSTRAINT "group_roles_role_id_roles_id_fk"');
    const backfillIdx = find('INSERT INTO "group_roles"');
    expect(groupFkIdx).toBeGreaterThanOrEqual(0);
    expect(roleFkIdx).toBeGreaterThanOrEqual(0);
    expect(backfillIdx).toBeGreaterThan(groupFkIdx);
    expect(backfillIdx).toBeGreaterThan(roleFkIdx);
  });
});

describe("M131 migration 0065 — final schema shape", () => {
  test("drops groups.role_id column", () => {
    expect(SQL).toMatch(/ALTER TABLE "groups" DROP COLUMN "role_id"/i);
  });

  test("drops the old groups → roles FK name-agnostically (IF EXISTS, both known names)", () => {
    // Constraint name drifts across instances (drizzle-clean
    // `groups_role_id_roles_id_fk` vs inline-REFERENCES `groups_role_id_fkey`),
    // so both are guarded with IF EXISTS and DROP COLUMN mops up the rest.
    expect(SQL).toMatch(
      /DROP CONSTRAINT IF EXISTS "groups_role_id_roles_id_fk"/i,
    );
    expect(SQL).toMatch(/DROP CONSTRAINT IF EXISTS "groups_role_id_fkey"/i);
  });
});
