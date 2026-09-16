import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrations = resolve(import.meta.dir, "../../src/migrations");
const tag = "0198_tiny_absorbing_man";
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as {
  entries: readonly {
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }[];
};

describe("Reflection Sleep default-on migration", () => {
  test("changes only the default for new configuration", () => {
    const entry = journal.entries.find(({ tag: entryTag }) => entryTag === tag);
    expect(entry?.idx).toBe(198);
    expect(entry?.version).toBe("7");
    expect(entry?.when).toBeGreaterThan(0);
    expect(entry?.tag).toBe(tag);
    expect(entry?.breakpoints).toBe(true);
    expect(migration).toBe(
      'ALTER TABLE "server_context_config" ALTER COLUMN '
      + '"reflection_sleep_enabled" SET DEFAULT true;',
    );
  });

  test("does not rewrite any existing operator selection", () => {
    expect(migration).not.toMatch(/\bUPDATE\b/iu);
    expect(migration).not.toMatch(/\bINSERT\b/iu);
    expect(migration).not.toContain("reflection_record_");
  });
});
