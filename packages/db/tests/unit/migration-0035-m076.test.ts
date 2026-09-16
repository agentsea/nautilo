/**
 * M076 — validates migration `0035_m076_memory_namespaces_junction.sql` shape
 * and journal wiring (content-only; does not apply SQL).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const MIGRATION_PATH = resolve(MIGRATIONS_DIR, "0035_m076_memory_namespaces_junction.sql");
const JOURNAL_PATH = resolve(MIGRATIONS_DIR, "meta/_journal.json");

describe("0035_m076_memory_namespaces_junction", () => {
  test("creates memory_namespaces with PK and FK constraints", () => {
    const sqlText = readFileSync(MIGRATION_PATH, "utf-8");
    expect(sqlText).toContain('CREATE TABLE "memory_namespaces"');
    expect(sqlText).toContain(
      'REFERENCES "public"."memories"("id") ON DELETE cascade',
    );
    expect(sqlText).toContain(
      'REFERENCES "public"."namespaces"("id") ON DELETE restrict',
    );
    expect(sqlText).toContain('PRIMARY KEY("memory_id","namespace_id")');
    expect(sqlText).toContain("idx_memory_namespaces_namespace");
    expect(sqlText).toContain("idx_memory_namespaces_memory");
  });

  test("backfills junction from legacy memories.namespace_id", () => {
    const sqlText = readFileSync(MIGRATION_PATH, "utf-8");
    expect(sqlText).toContain("INSERT INTO memory_namespaces");
    expect(sqlText).toContain("FROM memories");
    expect(sqlText).toContain("WHERE namespace_id IS NOT NULL");
    expect(sqlText).toContain("ON CONFLICT DO NOTHING");
  });

  test("journal references tagged migration at idx 35", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const entry = journal.entries.find((e) => e.idx === 35);
    expect(entry?.tag).toBe("0035_m076_memory_namespaces_junction");
  });
});
