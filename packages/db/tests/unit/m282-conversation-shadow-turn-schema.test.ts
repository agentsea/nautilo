import { describe, expect, test } from "bun:test";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  conversationShadowTurnOperations,
  conversationShadowTurnAgentSigners,
  conversationShadowTurnPlanAttempts,
  sessionMessageCryptoRevisions,
} from "../../src/schema";

describe("M282 live conversation Shadow lifecycle schema", () => {
  test("reserves one content-free product-owned turn before Message creation", () => {
    const columns = getTableColumns(conversationShadowTurnOperations);
    expect(Object.keys(columns)).toEqual([
      "sequence",
      "operationId",
      "clientIdempotencyKey",
      "policyRevision",
      "sessionId",
      "roomId",
      "humanMessageId",
      "humanMessageCreatedAt",
      "subjectHumanId",
      "committerDeviceId",
      "committerDeviceSigningKeyGeneration",
      "hostAuthorizationRevision",
      "agentId",
      "agentAuthorizationRevision",
      "namespaceId",
      "namespaceAuthorityScheme",
      "namespaceBindingHash",
      "namespaceAccessRevision",
      "namespaceKeyGeneration",
      "bindingRevisionAtWrap",
      "domainId",
      "domainEpoch",
      "namespaceHeadDigest",
      "namespacePublicationDigest",
      "namespacePublicationSetDigest",
      "namespaceAudienceFingerprint",
      "grantDomainId",
      "grantDomainParticipantDigest",
      "grantDomainKeyGeneration",
      "grantDomainHeadDigest",
      "grantDomainPublicationDigest",
      "grantDomainAuthorizationRevision",
      "namespaceBundleRevision",
      "namespaceBundleDigest",
      "agentGrantPlanBytes",
      "agentGrantPlanDigest",
      "recipientId",
      "recipientKeyId",
      "recipientPublicKey",
      "attemptCoordinate",
      "planDigest",
      "planBytes",
      "humanRequestDigest",
      "humanRequestBytes",
      "grantDigest",
      "finalCausalEventDigest",
      "clientVerificationDigest",
      "jobId",
      "state",
      "terminalStage",
      "terminalReason",
      "reconciliationAttemptCount",
      "deadlineAt",
      "startedAt",
      "terminalAt",
      "createdAt",
      "updatedAt",
    ]);
    expect(columns.state?.enumValues).toEqual([
      "planned",
      "human_verified",
      "running",
      "fallback",
      "completed",
      "client_verified",
      "failed",
    ]);
    expect(columns.humanRequestDigest?.notNull).toBeFalse();
    expect(columns.planBytes?.notNull).toBeFalse();
    expect(columns.humanRequestBytes?.notNull).toBeFalse();
    expect(columns.grantDigest?.notNull).toBeFalse();
    expect(columns.clientVerificationDigest?.notNull).toBeFalse();
    expect(columns.namespaceAuthorityScheme?.notNull).toBeTrue();
    expect(columns.namespaceAuthorityScheme?.default).toBe("domain_key_v2");
    expect(columns.namespaceBindingHash?.notNull).toBeFalse();
    expect(columns.namespaceHeadDigest?.notNull).toBeFalse();
    expect(columns.grantDomainId?.notNull).toBeFalse();
    expect(columns.namespaceBundleDigest?.notNull).toBeFalse();
    expect(columns.agentGrantPlanBytes?.notNull).toBeFalse();
    expect(Object.keys(columns)).not.toContainAllValues([
      "plaintext",
      "ciphertext",
      "grantBytes",
      "recipientPrivateKey",
      "streamFrames",
    ]);

    const config = getTableConfig(conversationShadowTurnOperations);
    expect(config.policies.map((policy) => policy.name)).toEqual([
      "conversation_shadow_turn_operations_product_all",
    ]);
    expect(config.uniqueConstraints.map((constraint) => constraint.name))
      .toContain("uq_conversation_shadow_turn_operations_id");
    expect(config.indexes.map((index) => index.config.name)).toContainAllValues([
      "uq_conversation_shadow_turn_operations_client_request",
      "uq_conversation_shadow_turn_operations_job",
      "idx_conversation_shadow_turn_operations_due",
    ]);
  });

  test("binds one immutable turn-scoped Agent signer to a planned turn", () => {
    const columns = getTableColumns(conversationShadowTurnAgentSigners);
    expect(Object.keys(columns)).toEqual([
      "operationId",
      "agentRuntimeGeneration",
      "agentSignerKeyId",
      "agentSignerPublicKey",
      "createdAt",
    ]);
    expect(columns.operationId?.primary).toBeTrue();
    const config = getTableConfig(conversationShadowTurnAgentSigners);
    expect(config.policies.map((policy) => policy.name)).toEqual([
      "conversation_shadow_turn_agent_signers_product_all",
    ]);
  });

  test("counts one content-free pre-readiness attempt per ordinary send", () => {
    const columns = getTableColumns(conversationShadowTurnPlanAttempts);
    expect(Object.keys(columns)).toEqual([
      "sequence",
      "sessionId",
      "roomId",
      "clientIdempotencyKey",
      "policyRevision",
      "subjectUserId",
      "subjectHumanActorId",
      "state",
      "unavailableReason",
      "operationId",
      "createdAt",
      "updatedAt",
    ]);
    expect(columns.state?.enumValues).toEqual([
      "checking",
      "planned",
      "unavailable",
    ]);
    expect(Object.keys(columns)).not.toContainAllValues([
      "plaintext",
      "ciphertext",
      "deviceId",
      "namespaceId",
      "grantBytes",
    ]);
    const config = getTableConfig(conversationShadowTurnPlanAttempts);
    expect(config.policies.map((policy) => policy.name)).toEqual([
      "conversation_shadow_turn_plan_attempts_product_all",
    ]);
    expect(config.indexes.map((index) => index.config.name)).toEqual([
      "uq_conversation_shadow_turn_plan_attempts_request",
      "uq_conversation_shadow_turn_plan_attempts_operation",
    ]);
  });

  test("links ordered Message revisions without storing transient frames", () => {
    const columns = getTableColumns(sessionMessageCryptoRevisions);
    expect(columns.objectIdScheme?.enumValues).toEqual([
      "message_v2",
      "live_shadow_v1",
      "human_message_edit_v1",
    ]);
    expect(columns.objectIdScheme?.default).toBe("message_v2");
    expect(columns.shadowOperationId?.notNull).toBeFalse();
    expect(columns.shadowTranscriptOrdinal?.notNull).toBeFalse();
    expect(columns.shadowStreamId?.notNull).toBeFalse();
    expect(columns.shadowStreamStartDigest?.notNull).toBeFalse();
    expect(columns.shadowStreamTerminalDigest?.notNull).toBeFalse();
    expect(columns.shadowStreamedTextDigest?.notNull).toBeFalse();
    expect(columns.shadowDurableEventDigest?.notNull).toBeFalse();

    const config = getTableConfig(sessionMessageCryptoRevisions);
    expect(config.foreignKeys.map((foreignKey) => foreignKey.getName()))
      .toContain("session_message_crypto_revisions_shadow_operation_fk");
    expect(config.indexes.map((index) => index.config.name))
      .toContain("uq_session_message_crypto_revisions_shadow_ordinal");
    const checks = config.checks.map((check) => check.name);
    expect(checks).toContain(
      "session_message_crypto_revisions_object_id_scheme",
    );
    expect(checks).toContain(
      "session_message_crypto_revisions_shadow_digest_shape",
    );
  });
});
