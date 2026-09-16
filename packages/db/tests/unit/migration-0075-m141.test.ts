/**
 * M141 — validates migration `0075_m141_tasks_substrate.sql` and its
 * journal entry at idx 75.
 *
 * Text-only assertions on the SQL — no database apply. Catches load-bearing
 * mistakes: missing tables/columns, forgotten rooms_kind_check rewrite, or
 * absent indexes / self-FK on parent_task_id.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const M0075 = resolve(MIGRATIONS_DIR, "0075_m141_tasks_substrate.sql");
const JOURNAL_PATH = resolve(MIGRATIONS_DIR, "meta/_journal.json");

const SQL = readFileSync(M0075, "utf-8");

describe("M141 migration 0075 — journal", () => {
  test("journal references 0075 at idx 75 with the right tag", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const e75 = journal.entries.find((e) => e.idx === 75);
    expect(e75?.tag).toBe("0075_m141_tasks_substrate");
  });

  test("journal idx is strictly increasing through 75 (no gaps/dupes)", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number }>;
    };
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i]!.idx).toBe(journal.entries[i - 1]!.idx + 1);
    }
    expect(journal.entries.some((e) => e.idx === 75)).toBe(true);
  });
});

describe("M141 migration 0075 — tasks substrate SQL shape", () => {
  test("creates tasks table", () => {
    expect(SQL).toMatch(/CREATE TABLE "tasks"/);
  });

  test("creates task_runs table", () => {
    expect(SQL).toMatch(/CREATE TABLE "task_runs"/);
  });

  test("adds session_messages.metadata", () => {
    expect(SQL).toMatch(
      /ALTER TABLE "session_messages" ADD COLUMN "metadata" jsonb/,
    );
  });

  test("self-FK on parent_task_id", () => {
    expect(SQL).toMatch(
      /ADD CONSTRAINT "tasks_parent_task_id_fkey"[\s\S]*?FOREIGN KEY \("parent_task_id"\)[\s\S]*?REFERENCES[\s\S]*?"tasks"\("id"\)[\s\S]*?set null/i,
    );
  });

  test("rooms_kind_check widen to include task while preserving prior kinds", () => {
    expect(SQL).toMatch(/DROP CONSTRAINT IF EXISTS "rooms_kind_check"/i);
    expect(SQL).toMatch(
      /ADD CONSTRAINT "rooms_kind_check"[\s\S]*?CHECK[\s\S]*?'task'/i,
    );

    const addIdx = SQL.indexOf('ADD CONSTRAINT "rooms_kind_check"');
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

  test("creates expected indexes", () => {
    expect(SQL).toContain("tasks_due_idx");
    expect(SQL).toContain("tasks_owner_idx");
    expect(SQL).toContain("tasks_calling_room_idx");
    expect(SQL).toContain("task_runs_task_idx");
  });
});
