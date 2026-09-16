/**
 * D420 (Wave 2 task 2.2.3 correction) — validates migration 0103 additively
 * widens the `work_acceptances` status CHECK to admit `user_cancelled` (the
 * truthful D349 user-Stop terminal outcome), plus journal + snapshot-chain
 * integrity. File-based (no live DB). Migration 0102 is NOT rewritten.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const META = resolve(MIGRATIONS_DIR, "meta");
const TAG = "0103_d420_user_cancelled_acceptances";
const SQL_PATH = resolve(MIGRATIONS_DIR, `${TAG}.sql`);
const JOURNAL_PATH = resolve(META, "_journal.json");
const SQL = readFileSync(SQL_PATH, "utf-8");

describe("D420 migration 0103 — journal + snapshot chain", () => {
  test("journal references idx 103 with the right tag", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const e103 = journal.entries.find((e) => e.idx === 103);
    expect(e103?.tag).toBe(TAG);
  });

  test("historical 0102 remains in the journal unchanged", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const e102 = journal.entries.find((e) => e.idx === 102);
    expect(e102?.tag).toBe("0102_d420_maintenance_drain");
  });

  test("journal idx stays strictly increasing and contiguous through its current tail", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number }>;
    };
    const idxs = journal.entries.map((e) => e.idx);
    expect(idxs).toEqual(Array.from({ length: idxs.length }, (_, i) => i));
    expect(idxs).toContain(103);
  });

  test("0103 snapshot exists and chains prevId to 0102's id", () => {
    expect(existsSync(resolve(META, "0103_snapshot.json"))).toBe(true);
    const s103 = JSON.parse(
      readFileSync(resolve(META, "0103_snapshot.json"), "utf-8"),
    ) as { id: string; prevId: string };
    const s102 = JSON.parse(
      readFileSync(resolve(META, "0102_snapshot.json"), "utf-8"),
    ) as { id: string };
    expect(s103.prevId).toBe(s102.id);
    expect(s103.id).not.toBe(s102.id);
  });

  test("0103 snapshot widens the work_acceptances status check to include user_cancelled", () => {
    const s = JSON.parse(
      readFileSync(resolve(META, "0103_snapshot.json"), "utf-8"),
    ) as {
      tables: Record<
        string,
        { checkConstraints?: Record<string, { value: string }> }
      >;
    };
    const wa = s.tables["public.work_acceptances"];
    expect(wa).toBeDefined();
    const check = wa?.checkConstraints?.["work_acceptances_status_check"];
    expect(check).toBeDefined();
    expect(check?.value).toContain("user_cancelled");
    expect(check?.value).toContain("maintenance_cancelled");
    expect(check?.value).toContain("accepted");
    expect(check?.value).toContain("dispatched");
  });
});

describe("D420 migration 0103 — additive ALTER shape", () => {
  test("does NOT rewrite 0102: no CREATE TABLE and no DROP TABLE", () => {
    expect(SQL).not.toContain("CREATE TABLE");
    expect(SQL).not.toContain("DROP TABLE");
    // Only the status check constraint is touched.
    expect(SQL).toContain("work_acceptances_status_check");
  });

  test("drops the old 3-value status check and re-adds it with user_cancelled", () => {
    expect(SQL).toContain(
      'ALTER TABLE "work_acceptances" DROP CONSTRAINT "work_acceptances_status_check"',
    );
    expect(SQL).toContain(
      'ALTER TABLE "work_acceptances" ADD CONSTRAINT "work_acceptances_status_check"',
    );
    expect(SQL).toContain("'accepted', 'dispatched', 'user_cancelled', 'maintenance_cancelled'");
  });

  test("0102 SQL is untouched and still carries the original 3-value check", () => {
    // Additivity proof: the prior migration's SQL still records the original
    // constraint; 0103 widens it rather than rewriting history.
    const s102 = readFileSync(
      resolve(MIGRATIONS_DIR, "0102_d420_maintenance_drain.sql"),
      "utf-8",
    );
    expect(s102).toContain(
      "CONSTRAINT \"work_acceptances_status_check\" CHECK (\"work_acceptances\".\"status\" IN ('accepted', 'dispatched', 'maintenance_cancelled'))",
    );
    expect(s102).not.toContain("user_cancelled");
  });
});
