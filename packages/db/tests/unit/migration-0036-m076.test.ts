/**
 * M076 — validates migration `0036_m076_drop_memories_namespace_id.sql`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const MIGRATION_PATH = resolve(MIGRATIONS_DIR, "0036_m076_drop_memories_namespace_id.sql");
const JOURNAL_PATH = resolve(MIGRATIONS_DIR, "meta/_journal.json");

describe("0036_m076_drop_memories_namespace_id", () => {
  test("drops idx_memories_namespace and memories.namespace_id", () => {
    const sqlText = readFileSync(MIGRATION_PATH, "utf-8");
    expect(sqlText).toContain('DROP INDEX IF EXISTS "idx_memories_namespace"');
    expect(sqlText).toContain('DROP COLUMN IF EXISTS "namespace_id"');
  });

  test("journal references tagged migration at idx 36", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const entry = journal.entries.find((e) => e.idx === 36);
    expect(entry?.tag).toBe("0036_m076_drop_memories_namespace_id");
  });
});
