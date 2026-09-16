import { describe, expect, test } from "bun:test";

import {
  M327_REFLECTION_ORIGIN_IMMUTABILITY_MARKER,
  M327_REFLECTION_REPLAY_AUTHORITY_MARKER,
  finalizeM327ReflectionReplayAuthorityMigration,
} from "../../scripts/finalize-m327-reflection-replay-authority";

const generated = [
  'CREATE TABLE "reflection_record_authority_dependencies" ("record_id" text);',
  'ALTER TABLE "reflection_record_publications" ADD COLUMN "replay_structural_height" integer;',
  'ALTER TABLE "reflection_record_publications" ADD COLUMN "replay_processing_generation" integer;',
  'ALTER TABLE "reflection_record_publications" ADD COLUMN "replay_predecessor_record_id" text;',
  'ALTER TABLE "reflection_record_publications" ADD COLUMN "replay_predecessor_relation" text;',
  "",
].join("\n");

describe("M327 Reflection replay authority migration finalizer", () => {
  test("adds product-only table security and immutable replay receipts once", () => {
    const once = finalizeM327ReflectionReplayAuthorityMigration(generated);
    expect(finalizeM327ReflectionReplayAuthorityMigration(once)).toBe(once);
    expect(
      once.match(new RegExp(M327_REFLECTION_REPLAY_AUTHORITY_MARKER, "g")),
    ).toHaveLength(1);
    expect(once).toContain(
      'ALTER TABLE "reflection_record_authority_dependencies" FORCE ROW LEVEL SECURITY',
    );
    expect(once).toContain(
      'REVOKE ALL ON TABLE "reflection_record_authority_dependencies" FROM PUBLIC, "nautilo_agent", "nautilo_crypto"',
    );
    expect(once).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "reflection_record_authority_dependencies" TO "nautilo"',
    );
    expect(once).not.toMatch(/GRANT [^;]+TO "nautilo_(?:agent|crypto)"/u);
    expect(once).toContain(
      'CREATE TRIGGER "reflection_record_publications_replay_mutation_guard"',
    );
    expect(once).toContain(
      'BEFORE UPDATE ON "reflection_record_publications"',
    );
    for (const column of [
      "replay_structural_height",
      "replay_processing_generation",
      "replay_predecessor_record_id",
      "replay_predecessor_relation",
    ]) {
      expect(once).toContain(
        `OLD.${column} IS DISTINCT FROM NEW.${column}`,
      );
    }
    expect(once).toContain(
      "Reflection Record publication replay structure is immutable",
    );
    expect(once).not.toContain("OLD.replay_structural_height IS NULL");
  });

  test("ignores unrelated migrations and rejects a partial generated change", () => {
    const unrelated = 'CREATE TABLE "other" ("id" text);\n';
    expect(finalizeM327ReflectionReplayAuthorityMigration(unrelated)).toBe(
      unrelated,
    );
    expect(() => finalizeM327ReflectionReplayAuthorityMigration(
      'CREATE TABLE "reflection_record_authority_dependencies" ("record_id" text);\n',
    )).toThrow("Refusing partial M327 Reflection replay authority finalization");
  });

  test("makes the optional publication origin immutable, including legacy null", () => {
    const generatedOrigin = [
      'ALTER TABLE "reflection_record_publications" ADD COLUMN "origin_publication_binding_ref" text;',
      'ALTER TABLE "reflection_record_publications" ADD CONSTRAINT "reflection_record_publications_origin_binding_portable" CHECK (true);',
      "",
    ].join("\n");
    const once = finalizeM327ReflectionReplayAuthorityMigration(generatedOrigin);
    expect(finalizeM327ReflectionReplayAuthorityMigration(once)).toBe(once);
    expect(
      once.match(new RegExp(M327_REFLECTION_ORIGIN_IMMUTABILITY_MARKER, "g")),
    ).toHaveLength(1);
    expect(once).toContain(
      "OLD.origin_publication_binding_ref IS DISTINCT FROM NEW.origin_publication_binding_ref",
    );
    expect(once).toContain(
      'CREATE TRIGGER "reflection_record_publications_origin_mutation_guard"',
    );
    expect(once).toContain("Reflection Record publication origin is immutable");
    expect(once).not.toContain("OLD.origin_publication_binding_ref IS NULL");
  });
});
