import { describe, expect, test } from "bun:test";

import {
  finalizeM295HumanPeerShadowEncryptionMigration,
  M295_HUMAN_PEER_SHADOW_AUTHORITY_MARKER,
} from "../../scripts/finalize-m295-human-peer-shadow-encryption.ts";

const COMPLETE = `CREATE TABLE "conversation_human_peer_shadow_operations" ();
CREATE TABLE "conversation_human_peer_shadow_acknowledgements" ();
CREATE TABLE "conversation_human_peer_shadow_plan_attempts" ();
ALTER TABLE "session_message_crypto_revisions"
  ADD COLUMN "human_peer_shadow_operation_id" text;`;

describe("M295 Human-peer Shadow migration finalizer", () => {
  test("leaves unrelated migrations untouched", () => {
    expect(finalizeM295HumanPeerShadowEncryptionMigration("SELECT 1;"))
      .toBe("SELECT 1;");
  });

  test("rejects a partial table family", () => {
    expect(() => finalizeM295HumanPeerShadowEncryptionMigration(
      'CREATE TABLE "conversation_human_peer_shadow_operations" ();',
    )).toThrow("generation is incomplete");
  });

  test("adds exact product-only authority and monotonic triggers once", () => {
    const once = finalizeM295HumanPeerShadowEncryptionMigration(COMPLETE);
    const twice = finalizeM295HumanPeerShadowEncryptionMigration(once);
    expect(twice).toBe(once);
    expect(once.match(new RegExp(M295_HUMAN_PEER_SHADOW_AUTHORITY_MARKER, "g")))
      .toHaveLength(1);
    for (const table of [
      "conversation_human_peer_shadow_operations",
      "conversation_human_peer_shadow_acknowledgements",
      "conversation_human_peer_shadow_plan_attempts",
    ]) {
      expect(once).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(once).toContain(`REVOKE ALL PRIVILEGES ON TABLE "${table}"`);
    }
    expect(once).toContain(
      'CREATE TRIGGER "conversation_human_peer_shadow_operations_protected"',
    );
    expect(once).toContain(
      "NEW.human_peer_shadow_operation_id",
    );
    expect(once).toContain(
      "OLD.human_peer_shadow_operation_id",
    );
    expect(once).not.toContain('GRANT ALL');
    expect(once).not.toContain('TO "nautilo_agent"');
    expect(once).not.toContain('TO "nautilo_crypto"');
  });
});
