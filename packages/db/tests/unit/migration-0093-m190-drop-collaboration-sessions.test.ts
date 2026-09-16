/**
 * M190 rollback — validates the forward inverse migration that drops
 * `collaboration_sessions` while preserving historical migration 0092.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const TAG = "0093_sharp_norman_osborn";
const M0093 = resolve(MIGRATIONS_DIR, `${TAG}.sql`);
const JOURNAL_PATH = resolve(MIGRATIONS_DIR, "meta/_journal.json");
const SQL = readFileSync(M0093, "utf-8");

describe("M190 rollback migration 0093 — journal", () => {
  test("journal references idx 93 with the right tag", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const e93 = journal.entries.find((e) => e.idx === 93);
    expect(e93?.tag).toBe(TAG);
  });

  test("historical 0092 remains in the journal", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const e92 = journal.entries.find((e) => e.idx === 92);
    expect(e92?.tag).toBe("0092_lively_synch");
  });
});

describe("M190 rollback migration 0093 — collaboration_sessions", () => {
  test("drops collaboration_sessions", () => {
    expect(SQL.trim()).toBe('DROP TABLE "collaboration_sessions" CASCADE;');
  });

  test("does not alter the historical 0092 migration file", () => {
    const m0092 = readFileSync(
      resolve(MIGRATIONS_DIR, "0092_lively_synch.sql"),
      "utf-8",
    );
    expect(m0092).toContain('CREATE TABLE "collaboration_sessions"');
  });
});
