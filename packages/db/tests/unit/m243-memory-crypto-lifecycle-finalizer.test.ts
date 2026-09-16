import { describe, expect, test } from "bun:test";

import {
  M243_MEMORY_CRYPTO_LIFECYCLE_MARKER,
  finalizeM243MemoryCryptoLifecycleMigration,
} from "../../scripts/finalize-m243-memory-crypto-lifecycle";

describe("M243 generated Memory lifecycle finalizer", () => {
  test("adds forced RLS, immutable identity, and least privilege exactly once", () => {
    const generated = [
      'CREATE TABLE "memory_crypto_revisions" ("sequence" serial PRIMARY KEY NOT NULL);',
      'CREATE TABLE "memory_crypto_operations" ("sequence" serial PRIMARY KEY NOT NULL);',
      "",
    ].join("\n");
    const once = finalizeM243MemoryCryptoLifecycleMigration(generated);

    expect(finalizeM243MemoryCryptoLifecycleMigration(once)).toBe(once);
    expect(once.match(
      new RegExp(M243_MEMORY_CRYPTO_LIFECYCLE_MARKER, "g"),
    )).toHaveLength(1);
    expect(once).toMatch(
      /ALTER TABLE "memory_crypto_revisions" FORCE ROW LEVEL SECURITY/,
    );
    expect(once).toMatch(
      /ALTER TABLE "memory_crypto_operations" FORCE ROW LEVEL SECURITY/,
    );
    expect(once).toContain(
      'CREATE FUNCTION "public"."reject_memory_crypto_revision_identity_update"()',
    );
    expect(once).toMatch(
      /GRANT SELECT, INSERT ON TABLE "memory_crypto_revisions", "memory_crypto_operations"\s+TO "nautilo_agent"/,
    );
    expect(once).toMatch(
      /GRANT UPDATE \([\s\S]+"updated_at"[\s\S]+\) ON TABLE "memory_crypto_revisions"\s+TO "nautilo_agent"/,
    );
    expect(once).toMatch(
      /GRANT UPDATE \([\s\S]+"semantic_change_kind"[\s\S]+\) ON TABLE "memory_crypto_operations"\s+TO "nautilo_agent"/,
    );
    expect(once).toMatch(
      /REVOKE ALL PRIVILEGES ON SEQUENCE[\s\S]+"memory_crypto_revisions_sequence_seq",[\s\S]+"memory_crypto_operations_sequence_seq"/,
    );
    expect(once).not.toMatch(/GRANT [^;]*"nautilo_crypto"/);
    expect(once).not.toMatch(/GRANT DELETE/);
  });

  test("ignores unrelated generated migrations", () => {
    const unrelated = 'CREATE TABLE "other" ("id" text);\n';
    expect(finalizeM243MemoryCryptoLifecycleMigration(unrelated))
      .toBe(unrelated);
  });

  test("refuses a partial lifecycle generation", () => {
    expect(() => finalizeM243MemoryCryptoLifecycleMigration(
      'CREATE TABLE "memory_crypto_revisions" ("sequence" serial);\n',
    )).toThrow("generation is incomplete");
  });
});
