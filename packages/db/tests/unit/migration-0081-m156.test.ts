/**
 * M156 — validates the generated migration that drops `agents.display_name`
 * and adds `agents.handle_customized`, plus its journal entry at idx 81.
 * Text-only assertions on the SQL — no database apply.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const TAG = "0081_overjoyed_sentinel";
const M0081 = resolve(MIGRATIONS_DIR, `${TAG}.sql`);
const JOURNAL_PATH = resolve(MIGRATIONS_DIR, "meta/_journal.json");
const SQL = readFileSync(M0081, "utf-8");

describe("M156 migration 0081 — journal", () => {
  test("journal references idx 81 with the right tag", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const e81 = journal.entries.find((e) => e.idx === 81);
    expect(e81?.tag).toBe(TAG);
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

describe("M156 migration 0081 — agents.display_name → handle_customized", () => {
  test("drops agents.display_name", () => {
    expect(SQL).toMatch(/DROP COLUMN(?: IF EXISTS)? "display_name"/);
  });

  test("adds agents.handle_customized boolean NOT NULL DEFAULT false", () => {
    expect(SQL).toMatch(
      /ADD COLUMN "handle_customized" boolean[^;]*NOT NULL[^;]*DEFAULT false|ADD COLUMN "handle_customized" boolean[^;]*DEFAULT false[^;]*NOT NULL/,
    );
  });

  test("does not add display_name (column is removed, not renamed)", () => {
    expect(SQL).not.toMatch(/ADD COLUMN "display_name"/);
    expect(SQL).not.toMatch(/RENAME COLUMN "display_name"/);
  });
});
