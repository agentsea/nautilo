import { describe, expect, test } from "bun:test";

import {
  M264_REFLECTION_SEARCH_SECURITY_MARKER,
  finalizeM264ReflectionSearchMigration,
} from "../../scripts/finalize-m264-reflection-search";

describe("M264 generated Reflection search finalizer", () => {
  test("adds forced RLS and exact product-only privileges once", () => {
    const generated = [
      'CREATE TABLE "reflection_record_search_projections" ("record_id" text);',
      "",
    ].join("\n");
    const once = finalizeM264ReflectionSearchMigration(generated);
    expect(finalizeM264ReflectionSearchMigration(once)).toBe(once);
    expect(once.match(new RegExp(M264_REFLECTION_SEARCH_SECURITY_MARKER, "g")))
      .toHaveLength(1);
    expect(once).toContain(
      'ALTER TABLE "reflection_record_search_projections" FORCE ROW LEVEL SECURITY',
    );
    expect(once).toContain(
      'REVOKE ALL ON TABLE "reflection_record_search_projections" FROM PUBLIC, "nautilo_agent", "nautilo_crypto"',
    );
    expect(once).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "reflection_record_search_projections" TO "nautilo"',
    );
    expect(once).not.toMatch(/GRANT [^;]+TO "nautilo_(?:agent|crypto)"/u);
    expect(once).toContain("reflection_record_search_projections_update_guard");
    expect(once).toContain(
      "Reflection search projection generation must advance exactly once",
    );
    expect(once).toContain(
      "NEW.record_id IS DISTINCT FROM OLD.record_id",
    );
  });

  test("ignores migrations that do not create the projection table", () => {
    const unrelated = 'CREATE TABLE "other" ("id" text);\n';
    expect(finalizeM264ReflectionSearchMigration(unrelated)).toBe(unrelated);
  });
});
