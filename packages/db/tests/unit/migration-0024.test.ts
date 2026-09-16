/**
 * M056: validates that migration `0024_m056_relay_tokens.sql` exists
 * with the expected shape and that the journal references it.
 *
 * Content-only — does NOT apply the migration to a database. Mirrors
 * `migration-0021.test.ts` (M051).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const MIGRATION_PATH = resolve(MIGRATIONS_DIR, "0024_m056_relay_tokens.sql");
const JOURNAL_PATH = resolve(MIGRATIONS_DIR, "meta/_journal.json");

describe("0024_m056_relay_tokens", () => {
  test("creates relay_tokens table with required columns", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf-8");
    expect(sql).toContain('CREATE TABLE "relay_tokens"');
    expect(sql).toMatch(/"id"\s+uuid\s+PRIMARY KEY/i);
    expect(sql).toMatch(/"user_id"\s+uuid\s+NOT NULL/i);
    expect(sql).toMatch(/"actor_id"\s+uuid\s+NOT NULL/i);
    expect(sql).toMatch(/"token_hash"\s+text\s+NOT NULL/i);
    expect(sql).toMatch(/"label"\s+text\s+NOT NULL/i);
    expect(sql).toMatch(/"capabilities"\s+jsonb/i);
    expect(sql).toMatch(/"created_at"\s+timestamp/i);
    expect(sql).toMatch(/"last_seen_at"\s+timestamp/i);
    expect(sql).toMatch(/"revoked_at"\s+timestamp/i);
  });

  test("token_hash is UNIQUE", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf-8");
    expect(sql).toMatch(/UNIQUE\(\s*"token_hash"\s*\)/i);
  });

  test("user_id and actor_id cascade on delete", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf-8");
    expect(sql).toMatch(
      /relay_tokens_user_id_users_id_fk[\s\S]*ON DELETE cascade/i,
    );
    expect(sql).toMatch(
      /relay_tokens_actor_id_actors_id_fk[\s\S]*ON DELETE cascade/i,
    );
  });

  test("partial indexes filter to active (non-revoked) rows", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf-8");
    expect(sql).toMatch(
      /CREATE INDEX "idx_relay_tokens_user_id"[\s\S]*WHERE\s+"revoked_at"\s+IS\s+NULL/i,
    );
    expect(sql).toMatch(
      /CREATE INDEX "idx_relay_tokens_actor_id"[\s\S]*WHERE\s+"revoked_at"\s+IS\s+NULL/i,
    );
  });

  test("journal entry references the M056-tagged migration at idx 24", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const entry = journal.entries.find((e) => e.idx === 24);
    expect(entry).toBeDefined();
    expect(entry?.tag).toBe("0024_m056_relay_tokens");
  });
});
