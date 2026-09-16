/**
 * D263 P0 — validates the generated migration that adds the `skills` table
 * (speaker-scoped agent skills). Text-only assertions on the SQL + journal —
 * no database apply. Round-trip / speaker-isolation behavior is covered by
 * integration tests (live Postgres).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const TAG = "0077_skills_d263";
const M0077 = resolve(MIGRATIONS_DIR, `${TAG}.sql`);
const JOURNAL_PATH = resolve(MIGRATIONS_DIR, "meta/_journal.json");
const SQL = readFileSync(M0077, "utf-8");

describe("D263 migration 0077 — journal", () => {
  test("journal references idx 77 with the right tag", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const e77 = journal.entries.find((e) => e.idx === 77);
    expect(e77?.tag).toBe(TAG);
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

describe("D263 migration 0077 — skills table", () => {
  test("creates the skills table", () => {
    expect(SQL).toMatch(/CREATE TABLE "skills"/);
  });

  test("is speaker-scoped: both agent_id and user_id columns exist (R1)", () => {
    expect(SQL).toMatch(/"agent_id" uuid NOT NULL/);
    expect(SQL).toMatch(/"user_id" uuid NOT NULL/);
  });

  test("cascades from both agents and users", () => {
    expect(SQL).toMatch(
      /"agent_id"\) REFERENCES "public"\."agents"\("id"\) ON DELETE cascade/,
    );
    expect(SQL).toMatch(
      /"user_id"\) REFERENCES "public"\."users"\("id"\) ON DELETE cascade/,
    );
  });

  test("requires_tools is a text[] array defaulting to empty (R15)", () => {
    expect(SQL).toMatch(/"requires_tools" text\[\] DEFAULT '\{\}' NOT NULL/);
  });

  test("name uniqueness is per-(agent, user) and partial on live rows", () => {
    const m = SQL.match(/CREATE UNIQUE INDEX "uniq_skills_agent_user_name"[^;]*/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/"agent_id","user_id","name"/);
    expect(m![0]).toMatch(/WHERE .*"deleted_at" IS NULL/);
  });

  test("enabled selector index is partial on enabled + live rows", () => {
    const m = SQL.match(/CREATE INDEX "idx_skills_agent_user_enabled"[^;]*/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/"agent_id","user_id"/);
    expect(m![0]).toMatch(/WHERE .*"enabled".*"deleted_at" IS NULL/);
  });

  test("soft-delete column exists and is nullable", () => {
    const m = SQL.match(/"deleted_at" timestamp with time zone[^,\n]*/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toMatch(/NOT NULL/);
  });
});
