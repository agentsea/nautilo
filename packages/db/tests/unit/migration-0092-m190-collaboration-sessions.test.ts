/**
 * M190 — validates the generated migration for `collaboration_sessions`
 * and its journal entry at idx 92. Text-only assertions on the SQL — no
 * database apply.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const TAG = "0092_lively_synch";
const M0092 = resolve(MIGRATIONS_DIR, `${TAG}.sql`);
const JOURNAL_PATH = resolve(MIGRATIONS_DIR, "meta/_journal.json");
const SQL = readFileSync(M0092, "utf-8");

describe("M190 migration 0092 — journal", () => {
  test("journal references idx 92 with the right tag", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const e92 = journal.entries.find((e) => e.idx === 92);
    expect(e92?.tag).toBe(TAG);
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

describe("M190 migration 0092 — collaboration_sessions", () => {
  test("creates collaboration_sessions table", () => {
    expect(SQL).toContain('CREATE TABLE "collaboration_sessions"');
  });

  test("y_state is bytea NOT NULL", () => {
    expect(SQL).toMatch(/"y_state"\s+"bytea"\s+NOT NULL/i);
  });

  test("document_name unique index exists", () => {
    expect(SQL).toMatch(/uq_collaboration_sessions_document_name/i);
  });

  test("provenance foreign keys have cleanup-safe delete behavior", () => {
    expect(SQL).toMatch(/creator_user_id_users_id_fk"[^;]+ON DELETE cascade/i);
    expect(SQL).toMatch(/relay_owner_user_id_users_id_fk"[^;]+ON DELETE set null/i);
    expect(SQL).toMatch(/created_by_agent_id_agents_id_fk"[^;]+ON DELETE set null/i);
    expect(SQL).toMatch(/room_id_rooms_id_fk"[^;]+ON DELETE set null/i);
  });

  test("partial unique artifact active/recoverable indexes exist", () => {
    expect(SQL).toMatch(/uq_collaboration_sessions_artifact_room_active/i);
    expect(SQL).toMatch(/uq_collaboration_sessions_artifact_no_room_active/i);
    expect(SQL).toMatch(/target_kind.*artifact/i);
    expect(SQL).toMatch(/room_id" IS NOT NULL/i);
    expect(SQL).toMatch(/room_id" IS NULL/i);
    expect(SQL).toMatch(/active.*recoverable|recoverable.*active/i);
  });

  test("current-file lookup index exists", () => {
    expect(SQL).toMatch(/idx_collaboration_sessions_current_file/i);
    expect(SQL).toMatch(/relay_owner_user_id/i);
    expect(SQL).toMatch(/current_folder_ref/i);
    expect(SQL).toMatch(/current_relative_path/i);
  });

  test("expires_at GC index exists", () => {
    expect(SQL).toMatch(/idx_collaboration_sessions_expires_at/i);
  });

  test("creator and relay-owner lookup indexes exist", () => {
    expect(SQL).toMatch(/idx_collaboration_sessions_creator_user_id/i);
    expect(SQL).toMatch(/idx_collaboration_sessions_relay_owner_user_id/i);
  });

  test("does not persist plaintext collaboration token column", () => {
    expect(SQL).not.toMatch(/"token"/i);
    expect(SQL).not.toMatch(/token_hash/i);
  });
});
