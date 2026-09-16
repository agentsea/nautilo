/**
 * D391 — validates migration 0096 adds the `turn_id` column + partial index
 * to `message_attachments` for durable message attachments.
 *
 * (Renumbered 0095 -> 0096 during the rebase onto main, whose 0095 is the
 * unrelated `commands` migration.)
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const TAG = "0096_tearful_night_thrasher";
const M0096 = resolve(MIGRATIONS_DIR, `${TAG}.sql`);
const JOURNAL_PATH = resolve(MIGRATIONS_DIR, "meta/_journal.json");
const SQL = readFileSync(M0096, "utf-8");

describe("D391 migration 0096 — journal", () => {
  test("journal references idx 96 with the right tag", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const e96 = journal.entries.find((e) => e.idx === 96);
    expect(e96?.tag).toBe(TAG);
  });

  test("historical 0094 remains in the journal", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const e94 = journal.entries.find((e) => e.idx === 94);
    expect(e94?.tag).toBe("0094_d374_db_identity_marker");
  });
});

describe("D391 migration 0096 — message_attachments.turn_id", () => {
  test("adds nullable turn_id text column", () => {
    expect(SQL).toContain('ALTER TABLE "message_attachments" ADD COLUMN "turn_id" text');
  });

  test("creates a partial btree index on turn_id (non-null only)", () => {
    expect(SQL).toContain('CREATE INDEX "idx_message_attachments_turn"');
    expect(SQL).toContain('ON "message_attachments"');
    expect(SQL).toContain('"turn_id" IS NOT NULL');
  });
});
