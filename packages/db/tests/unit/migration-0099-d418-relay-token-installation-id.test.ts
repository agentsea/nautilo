/**
 * D418 — validates migration 0099 adds the nullable `installation_id`
 * column + partial unique index `uq_relay_tokens_user_installation_active`
 * to `relay_tokens` for stable desktop pairing identity.
 *
 * Additive-only: no destructive DDL, no ALTER of prior migrations.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const TAG = "0099_relay_token_installation_id";
const M0099 = resolve(MIGRATIONS_DIR, `${TAG}.sql`);
const JOURNAL_PATH = resolve(MIGRATIONS_DIR, "meta/_journal.json");
const SQL = readFileSync(M0099, "utf-8");

describe("D418 migration 0099 — journal", () => {
  test("journal references idx 99 with the right tag", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const e99 = journal.entries.find((e) => e.idx === 99);
    expect(e99?.tag).toBe(TAG);
  });

  test("historical 0098 remains in the journal (additive, no renumber)", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const e98 = journal.entries.find((e) => e.idx === 98);
    expect(e98?.tag).toBe("0098_llm_usage_events");
  });
});

describe("D418 migration 0099 — relay_tokens.installation_id", () => {
  test("adds nullable installation_id uuid column (additive, no NOT NULL)", () => {
    expect(SQL).toContain(
      'ALTER TABLE "relay_tokens" ADD COLUMN "installation_id" uuid;',
    );
    // No NOT NULL on the ADD COLUMN — legacy rows stay NULL and MAY
    // duplicate. (The partial index's `IS NOT NULL` predicate is
    // unrelated and is asserted separately below.)
    const addColumnLine = SQL.split("-->")[0]!;
    expect(addColumnLine).not.toMatch(/installation_id.*NOT NULL/i);
  });

  test("creates a partial unique index on (user_id, installation_id) for active rows only", () => {
    expect(SQL).toContain(
      'CREATE UNIQUE INDEX "uq_relay_tokens_user_installation_active"',
    );
    expect(SQL).toContain('ON "relay_tokens"');
    expect(SQL).toContain('"user_id","installation_id"');
    // Partial: only rows with a non-NULL installation_id AND not revoked.
    expect(SQL).toContain('"installation_id" IS NOT NULL');
    expect(SQL).toContain('"revoked_at" IS NULL');
  });

  test("does not drop or alter existing relay_tokens columns/indexes", () => {
    expect(SQL).not.toMatch(/DROP\s+(COLUMN|INDEX|TABLE)/i);
    expect(SQL).not.toMatch(/ALTER\s+TABLE.*DROP/i);
  });
});
