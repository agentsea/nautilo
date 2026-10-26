import { describe, expect, test } from "bun:test";
import {
  finalizeTaskCryptoLifecycleMigration,
  TASK_CRYPTO_LIFECYCLE_MARKER,
} from "../../scripts/finalize-task-crypto-lifecycle";

describe("protected Task lifecycle migration finalizer", () => {
  test("wake continuation receipts are append-only and product-only", () => {
    const generated = 'CREATE TABLE "protected_task_wake_continuation_receipts" ();\n';
    const once = finalizeTaskCryptoLifecycleMigration(generated);
    expect(finalizeTaskCryptoLifecycleMigration(once)).toBe(once);
    expect(once).toContain('ALTER TABLE "protected_task_wake_continuation_receipts" FORCE ROW LEVEL SECURITY');
    expect(once).toContain('GRANT SELECT, INSERT ON TABLE "protected_task_wake_continuation_receipts" TO "nautilo"');
    expect(once).toContain('CREATE TRIGGER "task_wake_continuation_immutable"');
    expect(once).toContain("NEW IS DISTINCT FROM OLD");
    expect(once).not.toMatch(/GRANT [^;]+TO "nautilo_agent"/);
    expect(once).not.toMatch(/GRANT [^;]+TO "nautilo_crypto"/);
    expect(once).not.toContain("GRANT UPDATE");
    expect(once).not.toContain("GRANT DELETE");
  });

  test("adds immutable identities, stable Namespaces, forced RLS, and product-only DML once", () => {
    const generated = 'CREATE TABLE "task_definition_crypto_revisions" ();\nCREATE TABLE "task_run_result_crypto_revisions" ();\n';
    const once = finalizeTaskCryptoLifecycleMigration(generated);
    expect(finalizeTaskCryptoLifecycleMigration(once)).toBe(once);
    expect(once.match(new RegExp(TASK_CRYPTO_LIFECYCLE_MARKER, "g"))).toHaveLength(1);
    for (const table of [
      "task_definition_crypto_revisions",
      "task_run_result_crypto_revisions",
    ]) {
      expect(once).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(once).toContain(`CREATE TRIGGER "${table}_identity_immutable"`);
    }
    expect(once).toContain('CREATE TRIGGER "tasks_content_namespace_stable"');
    expect(once).toContain('CREATE TRIGGER "task_runs_result_content_namespace_stable"');
    expect(once).toContain("NEW.representation");
    expect(once).toContain("OLD.representation");
    expect(once).toContain("NEW.operational_metadata");
    expect(once).toContain("OLD.operational_metadata");
    expect(once).toMatch(/GRANT SELECT, INSERT[\s\S]+TO "nautilo"/);
    expect(once).not.toMatch(/GRANT [^;]+TO "nautilo_agent"/);
    expect(once).not.toMatch(/GRANT [^;]+TO "nautilo_crypto"/);
    expect(once).not.toContain("GRANT DELETE");
  });

  test("extends existing immutable receipts and confines structural scan DML to product role", () => {
    const generated = 'ALTER TABLE "task_definition_crypto_revisions" ADD COLUMN "historical_repair" jsonb;\nALTER TABLE "task_run_result_crypto_revisions" ADD COLUMN "historical_repair" jsonb;\nCREATE TABLE "task_content_backfill_scans" ();\nCREATE TABLE "task_content_backfill_failures" ();';
    const once = finalizeTaskCryptoLifecycleMigration(generated);
    expect(finalizeTaskCryptoLifecycleMigration(once)).toBe(once);
    expect(once).toContain('CREATE OR REPLACE FUNCTION "public"."reject_task_definition_crypto_revision_identity_update"');
    expect(once).toContain("NEW.historical_repair");
    expect(once).toContain("OLD.historical_repair");
    expect(once).not.toContain("CREATE TRIGGER");
    for (const table of ["task_content_backfill_scans", "task_content_backfill_failures"]) {
      expect(once).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(once).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${table}" TO "nautilo"`);
    }
    expect(once).not.toMatch(/GRANT [^;]+TO "nautilo_agent"/);
    expect(once).not.toMatch(/GRANT [^;]+TO "nautilo_crypto"/);
    expect(() => finalizeTaskCryptoLifecycleMigration('ALTER TABLE "task_definition_crypto_revisions" ADD COLUMN "historical_repair" jsonb;')).toThrow("generation is incomplete");
    expect(() => finalizeTaskCryptoLifecycleMigration('CREATE TABLE "task_content_backfill_scans" ();')).toThrow("generation is incomplete");
  });

  test("rejects partial generation and ignores unrelated migrations", () => {
    expect(() => finalizeTaskCryptoLifecycleMigration(
      'CREATE TABLE "task_definition_crypto_revisions" ();\n',
    )).toThrow("generation is incomplete");
    expect(finalizeTaskCryptoLifecycleMigration('CREATE TABLE "other" ();\n'))
      .toBe('CREATE TABLE "other" ();\n');
  });
});
