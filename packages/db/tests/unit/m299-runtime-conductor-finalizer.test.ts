import { describe, expect, test } from "bun:test";
import {
  finalizeM299RuntimeConductorMigration,
  M299_RUNTIME_CONDUCTOR_LIFECYCLE_MARKER,
} from "../../scripts/finalize-m299-runtime-conductor";

describe("M299 Runtime Conductor migration finalizer", () => {
  test("ignores unrelated migrations", () => {
    expect(finalizeM299RuntimeConductorMigration("SELECT 1;"))
      .toBe("SELECT 1;");
  });

  test("adds the bounded Conductor evidence transition exactly once", () => {
    const migration =
      'CREATE INDEX "idx_conversation_shared_agent_shadow_invocations_conductor" ON "conversation_shared_agent_shadow_invocations" USING btree ("policy_revision");';
    const once = finalizeM299RuntimeConductorMigration(migration);
    expect(finalizeM299RuntimeConductorMigration(once)).toBe(once);
    expect(once.match(new RegExp(M299_RUNTIME_CONDUCTOR_LIFECYCLE_MARKER, "g")))
      .toHaveLength(1);
    expect(once).toContain("OLD.terminal_reason = 'conductor_pending'");
    expect(once).toContain("NEW.terminal_reason ~ '^conductor_verified_");
    expect(once).toContain("NEW.terminal_reason LIKE 'conductor_fallback_%'");
    expect(once).toContain("NEW.terminal_reason IN ('deadline_expired', 'process_lost')");
    expect(once).toContain("NEW.updated_at < OLD.updated_at");
  });
});
