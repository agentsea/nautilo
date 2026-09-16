import { describe, expect, test } from "bun:test";

import {
  finalizeM282LiveShadowEncryptionMigration,
  M275_LIVE_SHADOW_READ_EVIDENCE_MARKER,
  M282_LIVE_SHADOW_AUTHORITY_MARKER,
  M282_LIVE_SHADOW_FOLLOWUP_AUTHORITY_MARKER,
  M282_LIVE_SHADOW_POLICY_RESET_MARKER,
} from "../../scripts/finalize-m282-live-shadow-encryption";

const GENERATED = `CREATE TABLE "conversation_shadow_turn_operations" (
  "sequence" serial PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "object_id_scheme" text DEFAULT 'message_v2' NOT NULL;
--> statement-breakpoint
ALTER TABLE "encryption_transition_policy" ADD CONSTRAINT "encryption_transition_policy_mode_check" CHECK ("mode" in ('plaintext_only', 'shadow_encryption', 'encrypted_only'));
`;

describe("M282 live Shadow generated-migration finalizer", () => {
  test("adds conservative policy reset and least privilege exactly once", () => {
    const once = finalizeM282LiveShadowEncryptionMigration(GENERATED);
    const twice = finalizeM282LiveShadowEncryptionMigration(once);
    expect(twice).toBe(once);
    expect(once).toContain(M282_LIVE_SHADOW_POLICY_RESET_MARKER);
    expect(once).toContain(M282_LIVE_SHADOW_AUTHORITY_MARKER);
    expect(once.indexOf(M282_LIVE_SHADOW_POLICY_RESET_MARKER)).toBeLessThan(
      once.indexOf("encryption_transition_policy_mode_check"),
    );
    expect(once).toContain(
      "WHERE \"mode\" IN ('shadow_writes', 'shadow_reads', 'encrypted_only')",
    );
    expect(once).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE "conversation_shadow_turn_operations"',
    );
    expect(once).toContain(
      'FROM PUBLIC, "nautilo_agent", "nautilo_crypto"',
    );
    expect(once).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "conversation_shadow_turn_operations"',
    );
    expect(once).not.toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "conversation_shadow_turn_operations"\n  TO "nautilo_agent"',
    );
    expect(once).toContain(
      'CREATE TRIGGER "conversation_shadow_turn_operations_product_valid"',
    );
    expect(once).toContain(
      'CREATE TRIGGER "conversation_shadow_turn_operations_protected"',
    );
    expect(once).toContain("NEW.object_id_scheme");
    expect(once).toContain("NEW.shadow_operation_id");
    expect(once).toContain("NEW.shadow_transcript_ordinal");
    expect(once).toContain("OLD.shadow_stream_terminal_digest IS NOT NULL");
  });

  test("refuses a partial generated lifecycle", () => {
    expect(() => finalizeM282LiveShadowEncryptionMigration(
      'CREATE TABLE "conversation_shadow_turn_operations" ();',
    )).toThrow("M282 live Shadow generation is incomplete");
    expect(() => finalizeM282LiveShadowEncryptionMigration(
      'ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "object_id_scheme" text;',
    )).toThrow("M282 live Shadow generation is incomplete");
  });

  test("hardens additive signer and pre-readiness attempt tables", () => {
    const generated = `CREATE TABLE "conversation_shadow_turn_agent_signers" ();
--> statement-breakpoint
CREATE TABLE "conversation_shadow_turn_plan_attempts" ();`;
    const once = finalizeM282LiveShadowEncryptionMigration(generated);
    expect(finalizeM282LiveShadowEncryptionMigration(once)).toBe(once);
    expect(once).toContain(M282_LIVE_SHADOW_FOLLOWUP_AUTHORITY_MARKER);
    expect(once).toContain(
      'GRANT SELECT, INSERT ON TABLE "conversation_shadow_turn_agent_signers"',
    );
    expect(once).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "conversation_shadow_turn_plan_attempts"',
    );
    expect(once).toContain(
      'ALTER TABLE "conversation_shadow_turn_plan_attempts" FORCE ROW LEVEL SECURITY',
    );
  });

  test("makes retained plan and signed request bytes immutable after publication", () => {
    const generated = `ALTER TABLE "conversation_shadow_turn_operations" ADD COLUMN "plan_bytes" bytea;
--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ADD COLUMN "human_request_bytes" bytea;`;
    const once = finalizeM282LiveShadowEncryptionMigration(generated);
    expect(finalizeM282LiveShadowEncryptionMigration(once)).toBe(once);
    expect(once).toContain(M275_LIVE_SHADOW_READ_EVIDENCE_MARKER);
    expect(once).toContain("OLD.plan_bytes IS NOT NULL");
    expect(once).toContain("OLD.human_request_bytes IS NOT NULL");
    expect(once).toContain(
      'CREATE OR REPLACE FUNCTION "public"."protect_conversation_shadow_turn_operation"()',
    );
    expect(once).not.toContain(
      'CREATE TRIGGER "conversation_shadow_turn_operations_protected"',
    );
  });

  test("ignores unrelated migrations", () => {
    const migration = 'ALTER TABLE "users" ADD COLUMN "timezone" text;\n';
    expect(finalizeM282LiveShadowEncryptionMigration(migration)).toBe(migration);
  });
});
