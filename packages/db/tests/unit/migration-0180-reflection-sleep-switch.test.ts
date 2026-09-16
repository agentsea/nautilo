import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrations = resolve(import.meta.dir, "../../src/migrations");
const tag = "0180_dazzling_norrin_radd";
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as { entries: readonly { idx: number; tag: string }[] };

describe("Reflection Sleep server control migration", () => {
  test("adds one default-off kill switch at its immutable migration position", () => {
    const entry = journal.entries.find(({ tag: entryTag }) => entryTag === tag);
    expect(entry?.idx).toBe(180);
    expect(entry?.tag).toBe(tag);
    expect(migration).toBe(
      'ALTER TABLE "server_context_config" ADD COLUMN '
      + '"reflection_sleep_enabled" boolean DEFAULT false NOT NULL;',
    );
  });

  test("does not alter Reflection work or Record tables", () => {
    expect(migration).not.toContain("reflection_record_");
    expect(migration.match(/ALTER TABLE/gu)).toHaveLength(1);
  });
});
