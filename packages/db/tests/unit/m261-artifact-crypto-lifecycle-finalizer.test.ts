import { describe, expect, test } from "bun:test";
import {
  M261_ARTIFACT_CRYPTO_LIFECYCLE_MARKER,
  finalizeM261ArtifactCryptoLifecycleMigration,
} from "../../scripts/finalize-m261-artifact-crypto-lifecycle";

describe("M261 generated Artifact lifecycle finalizer", () => {
  test("adds forced RLS, immutable identity, and product-only least privilege", () => {
    const generated = [
      'CREATE TABLE "artifact_crypto_operations" ("sequence" serial);',
      'CREATE TABLE "artifact_crypto_revisions" ("sequence" serial);',
      'CREATE TABLE "artifact_crypto_blobs" ("sequence" serial);',
      "",
    ].join("\n");
    const once = finalizeM261ArtifactCryptoLifecycleMigration(generated);
    expect(finalizeM261ArtifactCryptoLifecycleMigration(once)).toBe(once);
    expect(once.match(new RegExp(M261_ARTIFACT_CRYPTO_LIFECYCLE_MARKER, "g")))
      .toHaveLength(1);
    for (const table of [
      "artifact_crypto_operations", "artifact_crypto_revisions",
      "artifact_crypto_blobs",
    ]) expect(once).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    expect(once).toContain("artifact_crypto_revisions_identity_immutable");
    expect(once).toContain("NEW.mime_class, NEW.size_bucket, NEW.created_at");
    expect(once).toContain("NEW.expected_required_namespace_fingerprint");
    expect(once).toContain("artifact_crypto_blobs_identity_immutable");
    expect(once).toMatch(/GRANT SELECT, INSERT ON TABLE[\s\S]+TO "nautilo"/u);
    expect(once).not.toMatch(/GRANT [^;]+TO "nautilo_(?:agent|crypto)"/u);
    expect(once).not.toMatch(/GRANT DELETE/u);
  });

  test("ignores unrelated migrations and rejects partial generation", () => {
    expect(finalizeM261ArtifactCryptoLifecycleMigration(
      'CREATE TABLE "other" ("id" text);\n',
    )).toBe('CREATE TABLE "other" ("id" text);\n');
    expect(() => finalizeM261ArtifactCryptoLifecycleMigration(
      'CREATE TABLE "artifact_crypto_operations" ("sequence" serial);\n',
    )).toThrow("generation is incomplete");
  });
});
