import { describe, expect, test } from "bun:test";

import {
  finalizeM296SharedAgentShadowEncryptionMigration,
  M296_SHARED_AGENT_SHADOW_AUTHORITY_MARKER,
} from "../../scripts/finalize-m296-shared-agent-shadow-encryption.ts";

const COMPLETE = `CREATE TABLE "conversation_shared_agent_shadow_operations" ();
CREATE TABLE "conversation_shared_agent_shadow_executions" ();
CREATE TABLE "conversation_shared_agent_shadow_execution_inputs" ();
CREATE TABLE "conversation_shared_agent_shadow_acknowledgements" ();
CREATE TABLE "conversation_shared_agent_shadow_plan_attempts" ();
ALTER TABLE "session_message_crypto_revisions"
  ADD COLUMN "shared_agent_shadow_operation_id" text;
ALTER TABLE "session_message_crypto_revisions"
  ADD COLUMN "shared_agent_shadow_execution_id" text;`;

describe("M296 Shared-Agent Shadow migration finalizer", () => {
  test("leaves unrelated migrations untouched", () => {
    expect(finalizeM296SharedAgentShadowEncryptionMigration("SELECT 1;"))
      .toBe("SELECT 1;");
  });

  test("rejects a partial table family", () => {
    expect(() => finalizeM296SharedAgentShadowEncryptionMigration(
      'CREATE TABLE "conversation_shared_agent_shadow_operations" ();',
    )).toThrow("generation is incomplete");
  });

  test("adds exact product-only authority and monotonic triggers once", () => {
    const once = finalizeM296SharedAgentShadowEncryptionMigration(COMPLETE);
    const twice = finalizeM296SharedAgentShadowEncryptionMigration(once);
    expect(twice).toBe(once);
    expect(once.match(new RegExp(M296_SHARED_AGENT_SHADOW_AUTHORITY_MARKER, "g")))
      .toHaveLength(1);
    for (const table of [
      "conversation_shared_agent_shadow_operations",
      "conversation_shared_agent_shadow_executions",
      "conversation_shared_agent_shadow_execution_inputs",
      "conversation_shared_agent_shadow_acknowledgements",
      "conversation_shared_agent_shadow_plan_attempts",
    ]) {
      expect(once).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(once).toContain(`REVOKE ALL PRIVILEGES ON TABLE "${table}"`);
    }
    expect(once).toContain(
      'CREATE TRIGGER "conversation_shared_agent_shadow_operations_protected"',
    );
    expect(once).toContain(
      "NEW.shared_agent_shadow_operation_id",
    );
    expect(once).toContain(
      "OLD.shared_agent_shadow_operation_id",
    );
    expect(once).toContain("NEW.shared_agent_shadow_execution_id");
    expect(once).toContain(
      'CREATE TRIGGER "conversation_shared_agent_shadow_executions_protected"',
    );
    expect(once).toContain(
      'CREATE TRIGGER "conversation_shared_agent_shadow_execution_inputs_product_valid"',
    );
    expect(once).toContain(
      'CREATE TRIGGER "conversation_shared_agent_shadow_acknowledgements_product_valid"',
    );
    expect(once).toContain("NEW.client_action_session_id");
    expect(once).toContain("OLD.plan_bytes IS NOT NULL");
    expect(once).toContain("OLD.final_causal_event_digest IS NOT NULL");
    expect(once).toContain(
      'JOIN "public"."session_message_crypto_revisions" AS revision',
    );
    expect(once).not.toContain('GRANT ALL');
    expect(once).not.toContain('TO "nautilo_agent"');
    expect(once).not.toContain('TO "nautilo_crypto"');
  });
});
