import { describe, expect, test } from "bun:test";

import packageJson from "../../package.json";
import {
  M274_ENCRYPTION_TRANSITION_MARKER,
  finalizeM274EncryptionTransitionMigration,
} from "../../scripts/finalize-m274-encryption-transition";

const GENERATED = [
  'CREATE TABLE "encryption_transition_policy" ();',
  'CREATE TABLE "encryption_transition_observation_buckets" ();',
  'CREATE TABLE "encryption_transition_outcome_totals" ();',
  'CREATE TABLE "encryption_transition_observation_admissions" ();',
  'ALTER TABLE "memories" ADD COLUMN "crypto_mapping_state" text DEFAULT \'unmapped\' NOT NULL;',
  'ALTER TABLE "artifacts" ADD COLUMN "crypto_mapping_state" text DEFAULT \'unmapped\' NOT NULL;',
  'ALTER TABLE "memories" ADD CONSTRAINT "memories_crypto_mapping_revision_coherent" CHECK (true);',
  'ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_crypto_mapping_coherent" CHECK (true);',
  "",
].join("\n");

describe("M274 generated encryption transition finalizer", () => {
  test("backfills existing mappings before new coherence checks", () => {
    const finalized = finalizeM274EncryptionTransitionMigration(GENERATED);
    expect(finalized.indexOf('UPDATE "memories"')).toBeLessThan(
      finalized.indexOf("memories_crypto_mapping_revision_coherent"),
    );
    expect(finalized.indexOf('UPDATE "artifacts"')).toBeLessThan(
      finalized.indexOf("artifacts_crypto_mapping_coherent"),
    );
    expect(finalized).toContain('"crypto_mapping_state" = \'verified\'');
  });

  test("forces product-only least privilege, seeds the singleton, and is idempotent", () => {
    const once = finalizeM274EncryptionTransitionMigration(GENERATED);
    expect(finalizeM274EncryptionTransitionMigration(once)).toBe(once);
    expect(once).toContain(M274_ENCRYPTION_TRANSITION_MARKER);
    for (const table of [
      "encryption_transition_policy",
      "encryption_transition_observation_buckets",
      "encryption_transition_outcome_totals",
      "encryption_transition_observation_admissions",
    ]) expect(once).toContain(
      `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`,
    );
    expect(once).toContain('FROM PUBLIC, "nautilo_agent", "nautilo_crypto"');
    expect(once).toContain(
      'INSERT INTO "encryption_transition_policy" DEFAULT VALUES',
    );
    expect(once).toContain(
      'GRANT SELECT, UPDATE ON TABLE "encryption_transition_policy"',
    );
    expect(once).not.toMatch(/GRANT [^;]+TO "nautilo_crypto"/u);
    for (const functionName of [
      "nautilo_m274_stale_memory_crypto_mapping",
      "nautilo_m274_stale_artifact_crypto_mapping",
      "nautilo_m274_stale_memory_crypto_mapping_edge",
      "nautilo_m274_stale_artifact_crypto_mapping_edge",
    ]) expect(once).toContain(
      `REVOKE ALL ON FUNCTION "${functionName}"()`,
    );
    expect(packageJson.scripts["db:generate"]?.split(" && ")).toContain(
      "bun scripts/finalize-m274-encryption-transition.ts",
    );
  });

  test("invalidates verified Memory and Artifact mappings at the canonical DB boundary", () => {
    const finalized = finalizeM274EncryptionTransitionMigration(GENERATED);
    expect(finalized).toContain('TRIGGER "trg_m274_stale_memory_crypto_mapping"');
    expect(finalized).toContain('TRIGGER "trg_m274_stale_artifact_crypto_mapping"');
    expect(finalized).toContain('AFTER INSERT OR DELETE ON "memory_namespaces"');
    expect(finalized).toContain('AFTER INSERT OR DELETE ON "artifact_namespaces"');
    expect(finalized).toContain('NEW."crypto_mapping_state" := \'stale\'');
    expect(finalized).not.toContain(
      'NEW."deleted_at" IS DISTINCT FROM OLD."deleted_at"',
    );
    const memoryTrigger = finalized.slice(
      finalized.indexOf('FUNCTION "nautilo_m274_stale_memory_crypto_mapping"'),
      finalized.indexOf('TRIGGER "trg_m274_stale_memory_crypto_mapping"'),
    );
    for (const field of [
      "content", "type", "scope_origin_namespace_id", "embedding",
      "embedding_revision", "embedding_provider", "embedding_model",
      "embedding_dimensions", "embedding_contract_version",
    ]) expect(memoryTrigger).toContain(
      `NEW."${field}" IS DISTINCT FROM OLD."${field}"`,
    );
    expect(memoryTrigger).not.toContain('NEW."tier" IS DISTINCT');
    expect(memoryTrigger).not.toContain('NEW."importance" IS DISTINCT');
    const artifactTrigger = finalized.slice(
      finalized.indexOf('FUNCTION "nautilo_m274_stale_artifact_crypto_mapping"'),
      finalized.indexOf('TRIGGER "trg_m274_stale_artifact_crypto_mapping"'),
    );
    expect(artifactTrigger).toContain(
      'NEW."crypto_object_id" IS DISTINCT FROM OLD."crypto_object_id"\n        AND NEW."revision" IS DISTINCT',
    );
  });

  test("rejects a partial transition generation", () => {
    expect(() => finalizeM274EncryptionTransitionMigration(
      'CREATE TABLE "encryption_transition_policy" ();\n',
    )).toThrow("generation is incomplete");
  });
});
