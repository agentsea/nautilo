import { describe, expect, test } from "bun:test";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  encryptionTransitionHistoryReadAdmissions,
  encryptionTransitionObservationBuckets,
  encryptionTransitionOutcomeTotals,
} from "../../src/schema/encryption-transition";
import {
  buildAgentRoleGrantsSql,
  SENSITIVE_TABLES,
} from "../../src/utils/agent-role-grants";

describe("M275 history-read observation schema", () => {
  test("adds an explicit read vocabulary without reusing read_repair", () => {
    for (const table of [
      encryptionTransitionObservationBuckets,
      encryptionTransitionOutcomeTotals,
    ]) {
      const columns = getTableColumns(table);
      expect(columns.operation?.enumValues).toContain("read");
      for (const reason of [
        "current_read_authority_unavailable",
        "retained_key_material_unavailable",
        "signer_evidence_unavailable",
        "live_shadow_lifecycle_unavailable",
      ] as const) expect(columns.reason?.enumValues).toContain(reason);
    }
  });

  test("stores one content-free retry-stable admission and terminal receipt", () => {
    const columns = getTableColumns(encryptionTransitionHistoryReadAdmissions);
    expect(Object.keys(columns)).toEqual([
      "operationId",
      "clientRequestKey",
      "policyRevision",
      "subjectHumanId",
      "readerDeviceId",
      "readerDeviceSigningKeyGeneration",
      "hostAuthorizationRevision",
      "roomId",
      "selectedCoordinateDigest",
      "selectedCount",
      "eligibleCount",
      "tokenDigest",
      "state",
      "consumptionKind",
      "acknowledgementDigest",
      "orderedResultSetDigest",
      "verifiedCount",
      "clientCryptoUnavailableCount",
      "clientCustodyUnavailableCount",
      "currentReadAuthorityUnavailableCount",
      "retainedKeyMaterialUnavailableCount",
      "signerEvidenceUnavailableCount",
      "liveShadowLifecycleUnavailableCount",
      "integrityFailureCount",
      "parityMismatchCount",
      "clientObservationExpiredCount",
      "issuedAt",
      "expiresAt",
      "terminalAt",
      "updatedAt",
    ]);
    expect(columns.state?.enumValues).toEqual([
      "planned", "consumed", "expired",
    ]);
    expect(columns.consumptionKind?.enumValues).toEqual([
      "signed_acknowledgement", "unavailable_token", "server_unavailable",
      "ineligible", "expiry",
    ]);
    expect(columns.readerDeviceId?.notNull).toBeFalse();
    expect(columns.readerDeviceSigningKeyGeneration?.notNull).toBeFalse();
    expect(columns.hostAuthorizationRevision?.notNull).toBeFalse();
    for (const forbidden of [
      "token",
      "content",
      "plaintext",
      "ciphertext",
      "contentDigest",
      "messageId",
      "sessionId",
      "namespaceId",
      "key",
      "signature",
    ]) expect(Reflect.has(columns, forbidden)).toBeFalse();
  });

  test("pins device optionality, digest, bound, count closure, and monotonic state", () => {
    const config = getTableConfig(encryptionTransitionHistoryReadAdmissions);
    expect(config.checks.map((check) => check.name)).toContainAllValues([
      "encryption_transition_history_read_admissions_identity_shape",
      "encryption_transition_history_read_admissions_device_shape",
      "encryption_transition_history_read_admissions_time_shape",
      "encryption_transition_history_read_admissions_counts_nonnegative",
      "encryption_transition_history_read_admissions_state_shape",
    ]);
    expect(config.indexes.map((index) => index.config.name)).toContainAllValues([
      "uq_encryption_transition_history_read_request",
      "uq_encryption_transition_history_read_token_digest",
      "idx_encryption_transition_history_read_admissions_expiry",
    ]);
    expect(config.policies.map((policy) => policy.name)).toEqual([
      "encryption_transition_history_read_admissions_product_all",
    ]);
  });

  test("survives broad Agent-role grant repair as product-only state", () => {
    expect(SENSITIVE_TABLES).toContain(
      "encryption_transition_history_read_admissions",
    );
    expect(buildAgentRoleGrantsSql()).toContain(
      "encryption_transition_history_read_admissions",
    );
  });
});
