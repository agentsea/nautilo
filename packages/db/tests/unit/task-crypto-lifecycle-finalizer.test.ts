import { describe, expect, test } from "bun:test";
import {
  finalizeTaskCryptoLifecycleMigration,
  TASK_CRYPTO_LIFECYCLE_MARKER,
} from "../../scripts/finalize-task-crypto-lifecycle";

describe("protected Task lifecycle migration finalizer", () => {
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

  test("rejects partial generation and ignores unrelated migrations", () => {
    expect(() => finalizeTaskCryptoLifecycleMigration(
      'CREATE TABLE "task_definition_crypto_revisions" ();\n',
    )).toThrow("generation is incomplete");
    expect(finalizeTaskCryptoLifecycleMigration('CREATE TABLE "other" ();\n'))
      .toBe('CREATE TABLE "other" ();\n');
  });
});
