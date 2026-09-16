import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  M282_LIVE_SHADOW_AUTHORITY_MARKER,
  M282_LIVE_SHADOW_POLICY_RESET_MARKER,
} from "../../scripts/finalize-m282-live-shadow-encryption";

const migrations = resolve(import.meta.dir, "../../src/migrations");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as { entries: readonly { idx: number; tag: string }[] };
const entry = journal.entries.find(({ idx }) => idx === 189);
if (entry === undefined) throw new Error("M282 migration journal entry missing");
const migration = readFileSync(resolve(migrations, `${entry.tag}.sql`), "utf8");

describe("M282 generated live Shadow encryption migration", () => {
  test("is the canonical generated 0189 migration", () => {
    expect(entry.tag).toBe("0189_remarkable_microchip");
    expect(migration).toContain(
      'CREATE TABLE "conversation_shadow_turn_operations"',
    );
    expect(migration).toContain(
      'RENAME COLUMN "shadow_writes_started_at" TO "shadow_encryption_started_at"',
    );
    expect(migration).toContain(M282_LIVE_SHADOW_POLICY_RESET_MARKER);
    expect(migration).toContain(M282_LIVE_SHADOW_AUTHORITY_MARKER);
  });

  test("resets every old active mode before installing the new closed check", () => {
    const reset = migration.indexOf(M282_LIVE_SHADOW_POLICY_RESET_MARKER);
    const closedCheck = migration.indexOf(
      'ADD CONSTRAINT "encryption_transition_policy_mode_check"',
    );
    expect(reset).toBeGreaterThan(-1);
    expect(reset).toBeLessThan(closedCheck);
    expect(migration).toContain(
      "WHERE \"mode\" IN ('shadow_writes', 'shadow_reads', 'encrypted_only')",
    );
    expect(migration).toContain(
      "in ('plaintext_only', 'shadow_encryption', 'encrypted_only')",
    );
  });

  test("keeps old Message rows valid and adds only nullable live links", () => {
    expect(migration).toContain(
      'ADD COLUMN "object_id_scheme" text DEFAULT \'message_v2\' NOT NULL',
    );
    for (const column of [
      "shadow_operation_id",
      "shadow_transcript_ordinal",
      "shadow_stream_terminal_digest",
      "shadow_durable_event_digest",
    ]) {
      expect(migration).toContain(`ADD COLUMN "${column}"`);
      expect(migration).not.toContain(`ADD COLUMN "${column}" text NOT NULL`);
    }
    expect(migration).not.toMatch(/(?:DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM)/u);
  });

  test("forces product-only RLS and protects exact replay receipts", () => {
    expect(migration).toContain(
      'ALTER TABLE "conversation_shadow_turn_operations" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'FROM PUBLIC, "nautilo_agent", "nautilo_crypto"',
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "conversation_shadow_turn_operations"',
    );
    expect(migration).toContain(
      'CREATE TRIGGER "conversation_shadow_turn_operations_protected"',
    );
    expect(migration).toContain(
      "OLD.client_verification_digest IS NOT NULL",
    );
    expect(migration).toContain(
      "OLD.shadow_stream_terminal_digest IS NOT NULL",
    );
  });
});
