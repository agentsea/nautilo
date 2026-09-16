import {describe, expect, test} from "bun:test";
import {readFileSync} from "node:fs";
import {finalizeM313MessageBackfillMigration} from "../../scripts/finalize-m313-message-backfill";
import {SENSITIVE_TABLES} from "../../src/utils/agent-role-grants";

const migration = readFileSync(new URL("../../src/migrations/0261_nosy_earthquake.sql", import.meta.url), "utf8");
describe("M313 discovery migration authority", () => {
  test("role reconciliation preserves the generated product-only discovery boundary", () => {
    for (const table of ["message_backfill_scans", "message_backfill_failures"] as const) {
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(`REVOKE ALL PRIVILEGES ON TABLE "${table}" FROM PUBLIC, "nautilo_agent", "nautilo_crypto"`);
      expect(SENSITIVE_TABLES).toContain(table);
    }
    expect(finalizeM313MessageBackfillMigration(migration)).toBe(migration);
    expect(finalizeM313MessageBackfillMigration("SELECT 1;")).toBe("SELECT 1;");
  });
  test("device publisher identity is separate from author and claim deletion follows canonical ownership", () => {
    expect(migration).toContain('ADD COLUMN "repair_publisher_human_id" uuid');
    expect(migration).toContain("case when \"session_message_crypto_revisions\".\"repair_publisher_kind\" = 'human_device'");
    expect(migration).toContain('FOREIGN KEY ("human_actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade');
    expect(migration).toContain('FOREIGN KEY ("message_id") REFERENCES "public"."session_messages"("id") ON DELETE cascade');
  });
});
