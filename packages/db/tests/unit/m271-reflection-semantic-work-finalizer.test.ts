import { describe, expect, test } from "bun:test";

import {
  M271_REFLECTION_SEMANTIC_WORK_SECURITY_MARKER,
  finalizeM271ReflectionSemanticWorkMigration,
} from "../../scripts/finalize-m271-reflection-semantic-work";

describe("M271 generated Reflection semantic work finalizer", () => {
  const generated = [
    'CREATE TABLE "reflection_record_source_dependency_index" ("record_id" text);',
    'CREATE TABLE "reflection_record_semantic_work_admissions" ("record_id" text);',
    'CREATE TABLE "reflection_record_source_change_repairs" ("source_change_commitment" bytea);',
    'CREATE TABLE "reflection_record_semantic_work" ("record_id" text);',
    "",
  ].join("\n");

  test("adds product-only security and transition guards exactly once", () => {
    const once = finalizeM271ReflectionSemanticWorkMigration(generated);
    expect(finalizeM271ReflectionSemanticWorkMigration(once)).toBe(once);
    expect(
      once.match(
        new RegExp(M271_REFLECTION_SEMANTIC_WORK_SECURITY_MARKER, "g"),
      ),
    ).toHaveLength(1);
    for (const table of [
      "reflection_record_source_dependency_index",
      "reflection_record_semantic_work_admissions",
      "reflection_record_source_change_repairs",
      "reflection_record_semantic_work",
    ]) {
      expect(once).toContain(
        `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`,
      );
      expect(once).toContain(
        `REVOKE ALL ON TABLE "${table}" FROM PUBLIC, "nautilo_agent", "nautilo_crypto"`,
      );
      expect(once).toContain(
        table === "reflection_record_source_change_repairs"
          ? `GRANT SELECT, INSERT, UPDATE ON TABLE "${table}" TO "nautilo"`
          : `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${table}" TO "nautilo"`,
      );
    }
    expect(once).not.toMatch(/GRANT [^;]+TO "nautilo_(?:agent|crypto)"/u);
    expect(once).toContain(
      "reflection_record_source_dependency_index_immutable",
    );
    expect(once).toContain(
      "reflection_record_semantic_work_admissions_immutable",
    );
    expect(once).toContain(
      "reflection_record_source_change_repairs_update_guard",
    );
    expect(once).toContain("reflection_record_semantic_work_update_guard");
    expect(once).toContain(
      "New Reflection semantic work generation must advance exactly once and reset to due authority projection",
    );
    expect(once).toContain(
      "Terminal Reflection semantic work requires a newer generation",
    );
    expect(once).toContain(
      "Invalid Reflection semantic work stage checkpoint",
    );
    expect(once).toContain(
      "Reflection semantic work reason cannot weaken within a generation",
    );
    expect(once).toContain("IF (CASE NEW.change_reason");
    expect(once).toContain("END) < (CASE OLD.change_reason");
  });

  test("ignores partial and unrelated migrations", () => {
    expect(finalizeM271ReflectionSemanticWorkMigration(
      'CREATE TABLE "other" ("id" text);\n',
    )).toBe('CREATE TABLE "other" ("id" text);\n');
    expect(finalizeM271ReflectionSemanticWorkMigration(
      'CREATE TABLE "reflection_record_semantic_work" ("record_id" text);\n',
    )).toBe(
      'CREATE TABLE "reflection_record_semantic_work" ("record_id" text);\n',
    );
  });
});
