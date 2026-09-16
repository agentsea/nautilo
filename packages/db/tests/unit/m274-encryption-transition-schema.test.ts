import { describe, expect, test } from "bun:test";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  artifacts,
  ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1,
  encryptionTransitionObservationAdmissions,
  encryptionTransitionBoundaryHealth,
  encryptionTransitionObservationBuckets,
  encryptionTransitionOutcomeTotals,
  encryptionTransitionPolicy,
  memories,
} from "../../src/schema";

describe("M274 encryption transition control-plane schema", () => {
  test("persists one revisioned four-value server policy", () => {
    const columns = getTableColumns(encryptionTransitionPolicy);
    expect(columns.mode?.enumValues).toEqual([
      "plaintext_only",
      "shadow_encryption",
      "encrypted_only",
    ]);
    expect(columns.revision?.notNull).toBeTrue();
    expect(columns.shadowBehavior?.enumValues).toEqual(["fallback", "strict"]);
    expect(columns.shadowBehavior?.default).toBe("fallback");
    expect(columns.shadowEncryptionStartedAt?.notNull).toBeFalse();
    for (const field of [
      "observationBoundsRevision",
      "observationBucketWidthMs",
      "observationRetentionMs",
      "observationStorageLimitRows",
      "observationLatencyUpperBoundsMs",
      "observationBoundsConfiguredAt",
    ]) expect(Object.keys(columns)).toContain(field);
    expect(columns.observationBoundsRevision?.default).toBe(1);
    expect(columns.observationBucketWidthMs?.default).toBe(
      ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1.bucketWidthMs,
    );
    expect(columns.observationRetentionMs?.default).toBe(
      ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1.retentionMs,
    );
    expect(columns.observationStorageLimitRows?.default).toBe(10_000);
    expect(getTableConfig(encryptionTransitionPolicy).checks.map((check) => check.name))
      .toContainAllValues([
        "encryption_transition_policy_singleton",
        "encryption_transition_policy_mode_check",
        "encryption_transition_policy_shadow_behavior_check",
        "encryption_transition_policy_revision_nonnegative",
        "encryption_transition_policy_shadow_epoch_coherent",
        "encryption_transition_policy_observation_bounds_coherent",
      ]);
  });

  test("stores only closed content-free aggregate observation buckets", () => {
    const columns = getTableColumns(encryptionTransitionObservationBuckets);
    expect(columns.family?.enumValues).toEqual([
      "message", "memory", "artifact", "record",
    ]);
    expect(columns.operation?.enumValues).toEqual([
      "create",
      "update",
      "access_update",
      "read",
      "read_repair",
      "unsupported",
    ]);
    expect(columns.outcome?.enumValues).toEqual([
      "verified",
      "pending",
      "reconciling",
      "unavailable",
      "failed",
    ]);
    expect(columns.reason?.enumValues).toEqual([
      "none",
      "response_lost",
      "client_observation_expired",
      "unmigrated",
      "unsupported_operation",
      "client_crypto_unavailable",
      "client_crypto_preparation_failed",
      "client_custody_unavailable",
      "current_read_authority_unavailable",
      "retained_key_material_unavailable",
      "signer_evidence_unavailable",
      "live_shadow_lifecycle_unavailable",
      "namespace_encryption_not_ready",
      "stale_authority_product",
      "parity_mismatch",
      "integrity_failure",
      "publication_failure",
    ]);
    for (const field of [
      "policyRevision",
      "bucketStartedAt",
      "boundsRevision",
      "bucketWidthMs",
      "latencyBucket",
      "attemptCount",
    ]) expect(Object.keys(columns)).toContain(field);
    for (const forbidden of [
      "content",
      "prompt",
      "path",
      "mimeType",
      "namespaceId",
      "roomId",
      "userId",
      "deviceId",
      "agentId",
      "productId",
      "objectId",
      "operationId",
      "ciphertext",
      "manifest",
      "key",
      "signature",
      "provider",
    ]) expect(Reflect.has(columns, forbidden)).toBeFalse();
    expect(getTableConfig(encryptionTransitionObservationBuckets).checks.map(
      (check) => check.name,
    )).toContainAllValues([
      "encryption_transition_observations_family_check",
      "encryption_transition_observations_operation_check",
      "encryption_transition_observations_outcome_reason_coherent",
      "encryption_transition_observations_bucket_shape",
      "encryption_transition_observations_count_positive",
    ]);
  });

  test("bounds Strict Shadow health to one content-free registered-boundary row", () => {
    const columns = getTableColumns(encryptionTransitionBoundaryHealth);
    expect(Object.keys(columns)).toEqual([
      "policyRevision",
      "boundaryId",
      "family",
      "operation",
      "actorClass",
      "state",
      "reason",
      "retryable",
      "occurrenceCount",
      "firstObservedAt",
      "lastObservedAt",
    ]);
    expect(columns.actorClass?.enumValues).toEqual([
      "human", "agent", "conductor", "tool", "background",
    ]);
    expect(columns.state?.enumValues).toEqual([
      "verified", "waiting_for_authority", "repairing", "unsupported", "failed",
    ]);
    expect(getTableConfig(encryptionTransitionBoundaryHealth).checks.map(
      (check) => check.name,
    )).toContain("encryption_transition_boundary_health_shape");
    for (const forbidden of [
      "content", "digest", "ciphertext", "key", "grant", "envelope",
      "messageId", "roomId", "namespaceId", "userId", "agentId", "deviceId",
    ]) expect(Reflect.has(columns, forbidden)).toBeFalse();
  });

  test("keeps fixed-cardinality current-epoch totals independent of prunable buckets", () => {
    const columns = getTableColumns(encryptionTransitionOutcomeTotals);
    expect(Object.keys(columns)).toEqual([
      "policyRevision",
      "family",
      "operation",
      "outcome",
      "reason",
      "attemptCount",
      "updatedAt",
    ]);
    expect(getTableConfig(encryptionTransitionOutcomeTotals).checks.map(
      (check) => check.name,
    )).toContainAllValues([
      "encryption_transition_outcome_totals_epoch_check",
      "encryption_transition_outcome_totals_count_positive",
      "encryption_transition_outcome_totals_vocabulary_check",
    ]);
  });

  test("stores one bounded content-free digest admission for client-local outcomes", () => {
    const columns = getTableColumns(encryptionTransitionObservationAdmissions);
    expect(Object.keys(columns)).toEqual([
      "tokenDigest",
      "policyRevision",
      "family",
      "operation",
      "subjectHumanId",
      "memoryId",
      "cryptoObjectId",
      "contentRevision",
      "cryptoAccessRevision",
      "expiresAt",
      "createdAt",
    ]);
    expect(columns.family?.enumValues).toEqual([
      "message", "memory", "artifact", "record",
    ]);
    expect(columns.operation?.enumValues).toEqual([
      "create",
      "update",
      "access_update",
      "read",
      "read_repair",
      "unsupported",
    ]);
    expect(getTableConfig(encryptionTransitionObservationAdmissions).checks.map(
      (check) => check.name,
    )).toContainAllValues([
      "encryption_transition_observation_admissions_digest_shape",
      "encryption_transition_observation_admissions_epoch_check",
      "encryption_transition_observation_admissions_vocabulary_check",
      "encryption_transition_observation_admissions_expiry_check",
      "encryption_transition_observation_admissions_memory_read_binding",
    ]);
    for (const forbidden of [
      "userId", "humanId", "deviceId", "objectId", "namespaceId",
      "operationId", "plaintext", "ciphertext", "signature", "key",
    ]) expect(Reflect.has(columns, forbidden)).toBeFalse();
  });

  test("adds explicit current-mapping selectability to ordinary Memory and Artifact rows", () => {
    expect(getTableColumns(artifacts).cryptoMappingState?.enumValues)
      .toEqual(["unmapped", "verified", "stale"]);
    expect(getTableColumns(memories).cryptoMappingState?.enumValues)
      .toEqual(["unmapped", "verified", "stale"]);
    expect(getTableColumns(artifacts).cryptoMappingState?.default).toBe("unmapped");
    expect(getTableColumns(memories).cryptoMappingState?.default).toBe("unmapped");
    expect(getTableConfig(artifacts).checks.map((check) => check.name))
      .toContain("artifacts_crypto_mapping_coherent");
    expect(getTableConfig(memories).checks.map((check) => check.name))
      .toContain("memories_crypto_mapping_revision_coherent");
  });
});
