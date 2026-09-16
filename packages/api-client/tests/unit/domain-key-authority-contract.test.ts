import { describe, expect, test } from "bun:test";

import {
  domainKeyAuthorityPlanResponseV2Schema,
  domainKeyEnvelopeFetchRequestV2Schema,
  domainKeyPendingSourceListResponseV2Schema,
  domainKeyPendingSourceListV2Schema,
} from
  "../../src/schemas/domain-key-authority.ts";

const digest = "A".repeat(43);
const bytes = "AQ";

function rotationPlan() {
  return {
    responseVersion: 2 as const,
    status: "create_required" as const,
    domainId: "domain-v2:rotation",
    participantDigestBase64url: digest,
    participantCount: 1,
    keyClass: "human" as const,
    domainKeyGeneration: 2,
    authorizationRevision: 2,
    previousHeadDigestBase64url: digest,
    issuerHumanId: "human_rotation",
    issuerDeviceId: "device_rotation",
    issuerDeviceSigningGeneration: 1,
    issuerSigningPublicKeyBase64url: bytes,
    recipientEncryptionPublicKeyBase64url: bytes,
    recipientPublicKeyDigestBase64url: digest,
    recoveryKeyId: "recovery_rotation",
    recoveryKeyGeneration: 1,
    recoveryPublicKeyBase64url: bytes,
    recoveryPublicKeyDigestBase64url: digest,
    issuedAt: 1,
    deadlineAt: 2,
  };
}

describe("V2 Domain-key rotation HTTP contract", () => {
  test("carries one exact predecessor for a successor generation", () => {
    expect(domainKeyAuthorityPlanResponseV2Schema.parse(rotationPlan()))
      .toEqual(rotationPlan());
  });

  test("does not present a successor as a genesis publication", () => {
    expect(domainKeyAuthorityPlanResponseV2Schema.safeParse({
      ...rotationPlan(),
      previousHeadDigestBase64url: null,
    }).success).toBe(false);
  });
});

describe("M305 durable Domain-key convergence HTTP contract", () => {
  test("bounds a content-free source backlog", () => {
    expect(domainKeyPendingSourceListV2Schema.parse({
      requestVersion: 2,
      serverId: "server",
      clientDeviceId: "device",
      limit: 32,
    })).toBeDefined();
    expect(domainKeyPendingSourceListV2Schema.safeParse({
      requestVersion: 2,
      serverId: "server",
      clientDeviceId: "device",
      limit: 33,
    }).success).toBe(false);
    expect(domainKeyPendingSourceListResponseV2Schema.safeParse({
      responseVersion: 2,
      work: [{
        sourceRoomId: "38608e92-a31f-46af-ad5e-a847c8a6b300",
        namespaceId: "083a7e99-055e-4827-b4f5-0d8ad3c3c2b4",
        keyClass: "human",
        protectedContent: "not allowed",
      }],
    }).success).toBe(false);
  });

  test("requires exact recovery-envelope coordinates together", () => {
    const base = {
      requestVersion: 2 as const,
      serverId: "server",
      clientDeviceId: "device",
      keyClass: "human" as const,
    };
    expect(domainKeyEnvelopeFetchRequestV2Schema.safeParse({
      ...base,
      recipientKind: "recovery",
      recoveryKeyId: "recovery",
      recoveryKeyGeneration: 1,
    }).success).toBe(true);
    expect(domainKeyEnvelopeFetchRequestV2Schema.safeParse({
      ...base,
      recipientKind: "recovery",
      recoveryKeyId: "recovery",
    }).success).toBe(false);
    expect(domainKeyEnvelopeFetchRequestV2Schema.safeParse({
      ...base,
      recoveryKeyId: "recovery",
      recoveryKeyGeneration: 1,
    }).success).toBe(false);
  });
});
