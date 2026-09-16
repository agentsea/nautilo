/**
 * D418 Wave 2 / Stack 193 — pins the compatibility-only cleanup migration
 * for databases where immutable 0100 encountered retired preset rows.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const TAG = "0101_d418_remove_workstation_preset";
const SQL = readFileSync(resolve(MIGRATIONS_DIR, `${TAG}.sql`), "utf-8");
const JOURNAL_PATH = resolve(MIGRATIONS_DIR, "meta/_journal.json");
const SNAPSHOT_0100_PATH = resolve(MIGRATIONS_DIR, "meta/0100_snapshot.json");
const SNAPSHOT_0101_PATH = resolve(MIGRATIONS_DIR, "meta/0101_snapshot.json");

describe("D418 migration 0101 — journal and snapshot", () => {
  test("journal references idx 101 with the right tag after 0100", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const e100 = journal.entries.find((entry) => entry.idx === 100);
    const e101 = journal.entries.find((entry) => entry.idx === 101);
    expect(e100?.tag).toBe("0100_d418_system_managed_groups");
    expect(e101?.tag).toBe(TAG);
    expect(journal.entries.at(-1)?.idx).toBeGreaterThanOrEqual(101);
  });

  test("0101 snapshot preserves the corrected 0100 schema and chains from it", () => {
    const s100 = JSON.parse(readFileSync(SNAPSHOT_0100_PATH, "utf-8")) as {
      id: string;
      tables: unknown;
      enums: unknown;
      schemas: unknown;
      sequences: unknown;
      roles: unknown;
      policies: unknown;
      views: unknown;
    };
    const s101 = JSON.parse(readFileSync(SNAPSHOT_0101_PATH, "utf-8")) as {
      id: string;
      prevId: string;
      tables: unknown;
      enums: unknown;
      schemas: unknown;
      sequences: unknown;
      roles: unknown;
      policies: unknown;
      views: unknown;
    };
    expect(s101.id).not.toBe(s100.id);
    expect(s101.prevId).toBe(s100.id);
    expect(s101.tables).toEqual(s100.tables);
    expect(s101.enums).toEqual(s100.enums);
    expect(s101.schemas).toEqual(s100.schemas);
    expect(s101.sequences).toEqual(s100.sequences);
    expect(s101.roles).toEqual(s100.roles);
    expect(s101.policies).toEqual(s100.policies);
    expect(s101.views).toEqual(s100.views);
  });
});

describe("D418 migration 0101 — scoped compatibility cleanup", () => {
  test("deletes the retired Group's NO ACTION challenges, Group, and Role", () => {
    expect(SQL).toMatch(
      /DELETE\s+FROM\s+"approval_challenges"\s+WHERE\s+"group_id"\s+IN\s*\(\s*SELECT\s+"id"\s+FROM\s+"groups"\s+WHERE\s+"type"\s*=\s*'workstation_users'\s*\)/i,
    );
    expect(SQL).toMatch(
      /DELETE\s+FROM\s+"groups"\s+WHERE\s+"type"\s*=\s*'workstation_users'/i,
    );
    expect(SQL).toMatch(
      /DELETE\s+FROM\s+"roles"\s+WHERE\s+"slug"\s*=\s*'workstation-user'/i,
    );
    expect(SQL.match(/DELETE\s+FROM/gi)).toHaveLength(3);
    expect(SQL).not.toMatch(/TRUNCATE|DROP\s+TABLE|DELETE\s+FROM\s+"capabilities"/i);
  });

  test("deletes NO ACTION challenges before the Group, then the Role", () => {
    const challengeDelete = SQL.indexOf('DELETE FROM "approval_challenges"');
    const groupDelete = SQL.indexOf('DELETE FROM "groups"');
    const roleDelete = SQL.indexOf('DELETE FROM "roles"');
    expect(challengeDelete).toBeGreaterThanOrEqual(0);
    expect(groupDelete).toBeGreaterThan(challengeDelete);
    expect(roleDelete).toBeGreaterThan(groupDelete);
  });

  test("uses plain scoped DELETEs so missing rows are a no-op", () => {
    expect(SQL).not.toMatch(/RAISE|SELECT\s+INTO|ASSERT/i);
    expect(SQL).toContain('WHERE "type" = \'workstation_users\'');
    expect(SQL).toContain('WHERE "slug" = \'workstation-user\'');
  });
});
