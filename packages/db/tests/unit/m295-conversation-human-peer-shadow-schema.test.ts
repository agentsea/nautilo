import { describe, expect, test } from "bun:test";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  conversationHumanPeerShadowAcknowledgements,
  conversationHumanPeerShadowOperations,
  conversationHumanPeerShadowPlanAttempts,
  sessionMessageCryptoRevisions,
} from "../../src/schema";

describe("M295 Human-peer conversation Shadow lifecycle schema", () => {
  test("owns one content-free Human-only protected sibling", () => {
    const columns = getTableColumns(conversationHumanPeerShadowOperations);
    expect(Object.keys(columns)).toEqual([
      "sequence",
      "operationId",
      "clientIdempotencyKey",
      "policyRevision",
      "sessionId",
      "roomId",
      "humanMessageId",
      "humanMessageCreatedAt",
      "transcriptOrdinal",
      "subjectHumanId",
      "committerDeviceId",
      "committerDeviceSigningKeyGeneration",
      "hostAuthorizationRevision",
      "namespaceId",
      "namespaceAccessRevision",
      "namespaceKeyGeneration",
      "namespaceHeadDigest",
      "namespacePublicationDigest",
      "namespacePublicationSetDigest",
      "namespaceAudienceFingerprint",
      "cryptoObjectId",
      "attemptCoordinate",
      "planDigest",
      "planBytes",
      "humanRequestDigest",
      "humanRequestBytes",
      "protectedMessageDigest",
      "finalEventDigest",
      "state",
      "terminalStage",
      "terminalReason",
      "reconciliationAttemptCount",
      "deadlineAt",
      "humanVerifiedAt",
      "terminalAt",
      "createdAt",
      "updatedAt",
    ]);
    expect(columns.state?.enumValues).toEqual([
      "planned",
      "human_verified",
      "published",
      "fallback",
      "failed",
    ]);
    expect(Object.keys(columns)).not.toContainAnyValues([
      "agentId",
      "grantBytes",
      "grantDomainId",
      "recipientPrivateKey",
      "streamFrames",
      "plaintext",
      "ciphertext",
    ]);
    const config = getTableConfig(conversationHumanPeerShadowOperations);
    expect(config.policies.map((policy) => policy.name)).toEqual([
      "conversation_human_peer_shadow_operations_product_all",
    ]);
    expect(config.foreignKeys.map((foreignKey) => foreignKey.getName()))
      .toContainAllValues([
        "conversation_human_peer_shadow_operations_session_fk",
        "conversation_human_peer_shadow_operations_room_namespace_fk",
      ]);
    expect(config.indexes.map((index) => index.config.name))
      .toContainAllValues([
        "uq_conversation_human_peer_shadow_operations_client_request",
        "uq_conversation_human_peer_shadow_operations_message",
        "idx_conversation_human_peer_shadow_operations_due",
      ]);
  });

  test("records each recipient device independently", () => {
    const columns = getTableColumns(
      conversationHumanPeerShadowAcknowledgements,
    );
    expect(Object.keys(columns)).toEqual([
      "sequence",
      "operationId",
      "subjectHumanId",
      "committerDeviceId",
      "committerDeviceSigningKeyGeneration",
      "hostAuthorizationRevision",
      "acknowledgementDigest",
      "status",
      "reason",
      "issuedAt",
      "deadlineAt",
      "createdAt",
    ]);
    expect(columns.status?.enumValues).toEqual(["verified", "fallback"]);
    const config = getTableConfig(
      conversationHumanPeerShadowAcknowledgements,
    );
    expect(config.indexes.map((index) => index.config.name)).toEqual([
      "uq_conversation_human_peer_shadow_acknowledgements_device",
    ]);
  });

  test("counts one retry-idempotent attempt before custody", () => {
    const columns = getTableColumns(conversationHumanPeerShadowPlanAttempts);
    expect(columns.state?.enumValues).toEqual([
      "checking",
      "planned",
      "unavailable",
    ]);
    expect(columns.unavailableReason?.enumValues).toEqual([
      "device_unavailable",
      "namespace_unavailable",
      "recipient_sync_required",
      "unsupported_topology",
      "reservation_unavailable",
    ]);
    expect(Object.keys(columns)).not.toContainAnyValues([
      "deviceId",
      "namespaceId",
      "plaintext",
      "ciphertext",
    ]);
  });

  test("links one lifecycle row to exactly one live parent scheme", () => {
    const columns = getTableColumns(sessionMessageCryptoRevisions);
    expect(columns.shadowOperationId?.notNull).toBeFalse();
    expect(columns.humanPeerShadowOperationId?.notNull).toBeFalse();
    const config = getTableConfig(sessionMessageCryptoRevisions);
    const foreignKeys = config.foreignKeys.map(
      (foreignKey) => foreignKey.getName(),
    );
    expect(foreignKeys).toContain(
      "session_message_crypto_revisions_shadow_operation_fk",
    );
    expect(foreignKeys).toContain(
      "session_message_crypto_revisions_human_peer_operation_fk",
    );
    expect(config.indexes.map((index) => index.config.name))
      .toContain("uq_session_message_crypto_revisions_human_peer_ordinal");
    const checks = config.checks.map((check) => check.name);
    expect(checks).toContain(
      "session_message_crypto_revisions_object_id_scheme",
    );
    expect(checks).toContain(
      "session_message_crypto_revisions_human_peer_shape",
    );
  });
});
