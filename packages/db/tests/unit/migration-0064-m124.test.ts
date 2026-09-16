/**
 * M124 P1 — validates migration `0064_m124_rooms_kind_open.sql` and its
 * journal entry at idx 64.
 *
 * Checks open-room admission while preserving the subthread invariant.
 *
 * Text-only assertions on the SQL — populated-DB apply coverage is the
 * operator's manual-QA step (requires applying the migration). Per
 * coordinator rules, unit tests must be independent of any DB/server, so
 * we inspect the SQL shape. This still catches the load-bearing mistakes:
 * forgetting to drop the old CHECK first (re-add would no-op / error), or
 * dropping a previously-valid kind value from the new CHECK.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const M0064 = resolve(MIGRATIONS_DIR, "0064_m124_rooms_kind_open.sql");
const JOURNAL_PATH = resolve(MIGRATIONS_DIR, "meta/_journal.json");

const SQL = readFileSync(M0064, "utf-8");

describe("M124 migration 0064 — journal", () => {
  test("journal references 0064 at idx 64 with the right tag", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const e64 = journal.entries.find((e) => e.idx === 64);
    expect(e64?.tag).toBe("0064_m124_rooms_kind_open");
  });

  test("journal idx is strictly increasing through 64 (no gaps/dupes at the tail)", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number }>;
    };
    // The journal is strictly increasing with no gaps/dupes. Pinning the
    // *tail* to 64 is brittle — later migrations (e.g. M131's 0065)
    // legitimately extend the journal. The M124 invariant is that idx 64
    // exists and the sequence is contiguous up to and including it.
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i]!.idx).toBe(journal.entries[i - 1]!.idx + 1);
    }
    expect(journal.entries.some((e) => e.idx === 64)).toBe(true);
  });
});

describe("M124 migration 0064 — CHECK rewrite shape", () => {
  test("drops the existing rooms_kind_check before re-adding (IF EXISTS, idempotent)", () => {
    expect(SQL).toMatch(
      /DROP CONSTRAINT IF EXISTS rooms_kind_check/i,
    );
  });

  test("re-adds rooms_kind_check including 'open'", () => {
    expect(SQL).toMatch(
      /ADD CONSTRAINT rooms_kind_check[\s\S]*?CHECK\s*\(\s*kind IN \([^)]*'open'/i,
    );
  });

  test("the new CHECK preserves every pre-M124 kind value (no accidental narrowing)", () => {
    const addIdx = SQL.toLowerCase().indexOf("add constraint rooms_kind_check");
    expect(addIdx).toBeGreaterThanOrEqual(0);
    const body = SQL.slice(addIdx);
    for (const kind of [
      "'private'",
      "'group'",
      "'multi_agent'",
      "'subthread'",
      "'open'",
    ]) {
      expect(body).toContain(kind);
    }
  });

  test("drop precedes re-add (order invariant)", () => {
    const dropIdx = SQL.toLowerCase().indexOf("drop constraint if exists rooms_kind_check");
    const addIdx = SQL.toLowerCase().indexOf("add constraint rooms_kind_check");
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThan(dropIdx);
  });

  test("wrapped in a transaction (BEGIN/COMMIT)", () => {
    expect(SQL).toMatch(/^\s*BEGIN;/im);
    expect(SQL).toMatch(/COMMIT;\s*$/im);
  });
});
