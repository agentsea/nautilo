import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const SQL = readFileSync(
  resolve(MIGRATIONS_DIR, "0124_solid_chameleon.sql"),
  "utf8",
);
const SNAPSHOT = JSON.parse(
  readFileSync(
    resolve(MIGRATIONS_DIR, "meta/0124_snapshot.json"),
    "utf8",
  ),
) as {
  tables: Record<
    string,
    { columns: Record<string, { notNull: boolean; default?: number }> }
  >;
};

describe("M230 migration 0124 — Human message editing", () => {
  test("adds only additive edit and journal-rebuild state", () => {
    expect(SQL).toContain(
      'ADD COLUMN "edited_at" timestamp with time zone',
    );
    expect(SQL).toContain(
      'ADD COLUMN "edit_revision" integer DEFAULT 0 NOT NULL',
    );
    expect(SQL).toContain(
      'ADD COLUMN "rebuild_generation" integer DEFAULT 0 NOT NULL',
    );
    expect(SQL).toContain(
      'ADD COLUMN "rebuild_requested_at" timestamp with time zone',
    );
    expect(SQL).toContain(
      'ADD COLUMN "rebuild_target_message_id" integer',
    );
    expect(SQL).not.toMatch(/\b(?:DROP|RENAME|TRUNCATE|DELETE)\b/i);
  });

  test("snapshot preserves unedited defaults and nullable rebuild markers", () => {
    const messages = SNAPSHOT.tables["public.session_messages"]?.columns;
    const journal = SNAPSHOT.tables["public.room_journal_state"]?.columns;
    expect(messages?.["edited_at"]?.notNull).toBe(false);
    expect(messages?.["edit_revision"]).toMatchObject({
      notNull: true,
      default: 0,
    });
    expect(journal?.["rebuild_generation"]).toMatchObject({
      notNull: true,
      default: 0,
    });
    expect(journal?.["rebuild_requested_at"]?.notNull).toBe(false);
    expect(journal?.["rebuild_target_message_id"]?.notNull).toBe(false);
  });
});
