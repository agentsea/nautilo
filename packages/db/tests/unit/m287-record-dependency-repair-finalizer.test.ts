import { describe, expect, test } from "bun:test";

import {
  M287_RECORD_DEPENDENCY_REPAIR_SECURITY_MARKER,
  finalizeM287RecordDependencyRepairMigration,
} from "../../scripts/finalize-m271-reflection-semantic-work";

describe("M287 Record dependency repair finalizer", () => {
  const generated =
    'CREATE TABLE "reflection_record_dependency_change_repairs" ("change_commitment" bytea);\n';

  test("adds product-only security and a monotonic cursor guard once", () => {
    const once = finalizeM287RecordDependencyRepairMigration(generated);
    expect(finalizeM287RecordDependencyRepairMigration(once)).toBe(once);
    expect(once.match(new RegExp(
      M287_RECORD_DEPENDENCY_REPAIR_SECURITY_MARKER,
      "g",
    ))).toHaveLength(1);
    expect(once).toContain(
      'ALTER TABLE "reflection_record_dependency_change_repairs" FORCE ROW LEVEL SECURITY',
    );
    expect(once).toContain(
      'REVOKE ALL ON TABLE "reflection_record_dependency_change_repairs" FROM PUBLIC, "nautilo_agent", "nautilo_crypto"',
    );
    expect(once).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "reflection_record_dependency_change_repairs" TO "nautilo"',
    );
    expect(once).not.toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "reflection_record_dependency_change_repairs"',
    );
    expect(once).toContain(
      "reflection_record_dependency_change_repairs_update_guard",
    );
    expect(once).not.toMatch(/GRANT [^;]+TO "nautilo_(?:agent|crypto)"/u);
  });

  test("ignores unrelated migrations", () => {
    const unrelated = 'CREATE TABLE "other" ("id" text);\n';
    expect(finalizeM287RecordDependencyRepairMigration(unrelated)).toBe(unrelated);
  });
});
