import { describe, expect, test } from "bun:test";

import {
  finalizeM298RuntimeForegroundAuthorityMigration,
  M298_RUNTIME_CONDUCTOR_LIFECYCLE_MARKER,
  M298_RUNTIME_FOREGROUND_AUTHORITY_MARKER,
  M298_RUNTIME_FOREGROUND_RESUME_AUTHORITY_MARKER,
  M298_RUNTIME_HUMAN_AUDIENCE_REVISION_MARKER,
} from "../../scripts/finalize-m298-runtime-foreground-authority.ts";

const COMPLETE = `CREATE TABLE "conversation_shared_agent_shadow_invocations" ();
ALTER TABLE "conversation_shared_agent_shadow_operations" ALTER COLUMN "agent_id" DROP NOT NULL;
ALTER TABLE "conversation_shared_agent_shadow_executions" ADD COLUMN "invocation_id" text;
DROP INDEX "uq_conversation_shared_agent_shadow_execution_inputs_operation";`;

const RESUME = `ALTER TABLE "conversation_shared_agent_shadow_executions" ADD COLUMN "authorization_device_id" text NOT NULL;
ALTER TABLE "conversation_shared_agent_shadow_executions" ADD COLUMN "execution_kind" text DEFAULT 'turn' NOT NULL;
ALTER TABLE "conversation_shared_agent_shadow_invocations" ADD COLUMN "authorization_device_id" text NOT NULL;`;

const COMBINED = `${COMPLETE.replace(
  'CREATE TABLE "conversation_shared_agent_shadow_invocations" ();',
  'CREATE TABLE "conversation_shared_agent_shadow_invocations" (\n  "authorization_device_id" text NOT NULL\n);',
)}
ALTER TABLE "conversation_shared_agent_shadow_executions" ADD COLUMN "authorization_device_id" text NOT NULL;
ALTER TABLE "conversation_shared_agent_shadow_executions" ADD COLUMN "execution_kind" text DEFAULT 'turn' NOT NULL;`;

const CONDUCTOR_LIFECYCLE = `ALTER TABLE "conversation_shared_agent_shadow_operations" DROP CONSTRAINT "conversation_shared_agent_shadow_operations_time_order";
ALTER TABLE "conversation_shared_agent_shadow_operations" ADD CONSTRAINT "conversation_shared_agent_shadow_operations_time_order" CHECK (
  "conversation_shared_agent_shadow_operations"."conductor_resolved_at" is null
  or "conversation_shared_agent_shadow_operations"."conductor_resolved_at" >= "conversation_shared_agent_shadow_operations"."created_at"
);`;

describe("M298 Runtime foreground authority migration finalizer", () => {
  test("leaves unrelated migrations untouched and rejects partial generation", () => {
    expect(finalizeM298RuntimeForegroundAuthorityMigration("SELECT 1;"))
      .toBe("SELECT 1;");
    expect(() => finalizeM298RuntimeForegroundAuthorityMigration(
      'CREATE TABLE "conversation_shared_agent_shadow_invocations" ();',
    )).toThrow("generation is incomplete");
  });

  test("adds product-only custody and Runtime-aware monotonic triggers once", () => {
    const once = finalizeM298RuntimeForegroundAuthorityMigration(COMPLETE);
    expect(finalizeM298RuntimeForegroundAuthorityMigration(once)).toBe(once);
    expect(once.match(new RegExp(M298_RUNTIME_FOREGROUND_AUTHORITY_MARKER, "g")))
      .toHaveLength(1);
    expect(once).toContain(
      'ALTER TABLE "conversation_shared_agent_shadow_invocations" FORCE ROW LEVEL SECURITY',
    );
    expect(once).toContain(
      'CREATE TRIGGER "conversation_shared_agent_shadow_invocations_protected"',
    );
    expect(once).toContain(
      'CREATE TRIGGER "conversation_shared_agent_shadow_executions_product_valid"',
    );
    expect(once).toContain("session_row.agent_id = NEW.agent_id");
    expect(once).toContain(
      "authority_room.id = COALESCE(source_room.parent_room_id, source_room.id)",
    );
    expect(once).toContain("member.room_id = authority_room.id");
    expect(once).toContain("source_room.kind = 'subthread'");
    expect(once).toContain("invocation.client_action_session_id");
    expect(once).toContain("invocation.input_count = execution.input_count");
    expect(once).toContain("NEW.invocation_id");
    expect(once).toContain("OLD.invocation_id");
    expect(once).toContain("operation.agent_id IS NULL");
    expect(once).toContain(M298_RUNTIME_HUMAN_AUDIENCE_REVISION_MARKER);
    expect(once).toContain("old_is_human boolean := false");
    expect(once).toContain("new_is_human boolean := false");
    expect(once).toContain("AND kind = 'user'");
    expect(once).toContain("invocation.input_set_digest = execution.input_set_digest");
    expect(once).not.toContain("GRANT ALL");
    expect(once).not.toContain('TO "nautilo_agent"');
    expect(once).not.toContain('TO "nautilo_crypto"');
  });

  test("backfills existing turn rows before freezing resume authority", () => {
    const once = finalizeM298RuntimeForegroundAuthorityMigration(RESUME);
    expect(finalizeM298RuntimeForegroundAuthorityMigration(once)).toBe(once);
    expect(once).toContain(
      'SET "authorization_device_id" = "invoking_device_id"',
    );
    expect(once).toContain(
      'ALTER COLUMN "authorization_device_id" SET NOT NULL',
    );
    expect(once).toContain(
      "invocation.authorization_device_id = NEW.authorization_device_id",
    );
    expect(once).toContain("NEW.execution_kind");
    expect(once.match(new RegExp(
      M298_RUNTIME_FOREGROUND_RESUME_AUTHORITY_MARKER,
      "g",
    ))).toHaveLength(1);
  });

  test("finalizes a combined Runtime and resume migration in one pass", () => {
    const once = finalizeM298RuntimeForegroundAuthorityMigration(COMBINED);
    expect(finalizeM298RuntimeForegroundAuthorityMigration(once)).toBe(once);
    expect(once).toContain(M298_RUNTIME_FOREGROUND_AUTHORITY_MARKER);
    expect(once).toContain(M298_RUNTIME_FOREGROUND_RESUME_AUTHORITY_MARKER);
    expect(once).toContain(
      'SET "authorization_device_id" = "invoking_device_id"',
    );
    expect(once).not.toContain(
      'ALTER TABLE "conversation_shared_agent_shadow_executions" ADD COLUMN "authorization_device_id" text NOT NULL;',
    );
  });

  test("permits only exact awaiting-user conductor lifecycle resolution", () => {
    const once = finalizeM298RuntimeForegroundAuthorityMigration(
      CONDUCTOR_LIFECYCLE,
    );
    expect(finalizeM298RuntimeForegroundAuthorityMigration(once)).toBe(once);
    expect(once.match(new RegExp(
      M298_RUNTIME_CONDUCTOR_LIFECYCLE_MARKER,
      "g",
    ))).toHaveLength(1);
    expect(once).toContain("OLD.conductor_state = 'awaiting_user'");
    expect(once).toContain(
      "NEW.conductor_state IN ('selected', 'unavailable')",
    );
    expect(once).toContain("OLD.conductor_reason IS NOT NULL");
    expect(once).toContain("OLD.conductor_resolved_at IS NOT NULL");
    expect(once).not.toContain(
      'CREATE TRIGGER "conversation_shared_agent_shadow_operations_protected"',
    );
  });
});
