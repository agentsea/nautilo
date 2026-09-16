/**
 * M087 — validates the generated migration that adds `users.timezone`
 * and its journal entry at idx 76. Text-only assertions on the SQL —
 * no database apply.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const TAG = "0076_condemned_tarantula";
const M0076 = resolve(MIGRATIONS_DIR, `${TAG}.sql`);
const JOURNAL_PATH = resolve(MIGRATIONS_DIR, "meta/_journal.json");
const SQL = readFileSync(M0076, "utf-8");

describe("M087 migration 0076 — journal", () => {
  test("journal references idx 76 with the right tag", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const e76 = journal.entries.find((e) => e.idx === 76);
    expect(e76?.tag).toBe(TAG);
  });

  test("journal idx is strictly increasing (no gaps/dupes)", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number }>;
    };
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i]!.idx).toBe(journal.entries[i - 1]!.idx + 1);
    }
  });
});

describe("M087 migration 0076 — users.timezone column", () => {
  test("adds nullable users.timezone text column", () => {
    expect(SQL).toMatch(/ALTER TABLE "users" ADD COLUMN "timezone" text/);
  });

  test("column is nullable (no NOT NULL) and has no default", () => {
    const m = SQL.match(/ADD COLUMN "timezone" text[^;]*/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toMatch(/NOT NULL/i);
    expect(m![0]).not.toMatch(/DEFAULT/i);
  });
});
