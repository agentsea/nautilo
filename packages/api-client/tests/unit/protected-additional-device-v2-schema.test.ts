import { describe, expect, test } from "bun:test";

import {
  protectedAdditionalDevicePlanV1Schema,
  protectedAdditionalDevicePlanV2Schema,
  protectedAdditionalDeviceTransitionPlanV2Schema,
  protectedAdditionalDeviceTransitionsRequestV2Schema,
  protectedAdditionalDeviceDeliveriesRequestV1Schema,
  protectedAdditionalDeviceActivationV1Schema,
} from "../../src/schemas/protected-additional-device";

const hash = "A".repeat(43);
const approver = {
  deviceId: "device-approver",
  signingPublicKeyBase64url: hash,
};
const enrollment = {
  formatVersion: 1 as const,
  operationId: "operation-1",
  challengeId: "challenge-1",
  userId: "00000000-0000-4000-8000-000000000001",
  humanActorId: "00000000-0000-4000-8000-000000000002",
  deviceId: "device-target",
  clientKind: "electron" as const,
  installationLineageDigestBase64url: hash,
  deviceGeneration: 1 as const,
  signingPublicKeyBase64url: hash,
  encryptionPublicKeyBase64url: "A".repeat(87),
  method: "device_approval" as const,
  idempotencyKey: "idempotency-1",
  authorizationEvidenceDigestBase64url: hash,
  authorizationDigestBase64url: hash,
  expectedCustodyRevision: 1,
  expectedRecoveryGeneration: 1,
  inventoryRevision: 1,
  inventoryCount: 0,
  inventoryDigestBase64url: hash,
  deviceRevision: 0 as const,
  status: "pending" as const,
  issuedAt: 1_000,
  expiresAt: 2_000,
};

function domain(index: number) {
  return {
    domainId: `domain-${index.toString().padStart(3, "0")}`,
    expectedHead: {
      providerId: "provider-1",
      domainId: `domain-${index.toString().padStart(3, "0")}`,
      epoch: 1,
      stateHashBase64url: hash,
    },
    authorizationRevision: 1,
    participantDigestBase64url: hash,
    rosterBytesBase64url: "AQ",
    committerDeviceId: "device-approver",
    committerSigningPublicKeyBase64url: hash,
    namespaces: [],
  };
}

function page(domainCount: number, start = 0, size = 12) {
  const end = Math.min(start + size, domainCount);
  return {
    formatVersion: 2 as const,
    enrollment,
    approver,
    personalAuthority: null,
    domainCount,
    page: {
      start,
      end,
      nextStart: end === domainCount ? null : end,
      pageDigestBase64url: hash,
    },
    domains: Array.from({ length: end - start }, (_, offset) =>
      domain(start + offset)),
  };
}

describe("protected additional-device V2 paging", () => {
  test.each([0, 1, 12, 13, 255, 256])(
    "accepts a bounded page from a %i-Domain complete inventory",
    (domainCount) => {
      expect(protectedAdditionalDevicePlanV2Schema.safeParse(
        page(domainCount),
      ).success).toBe(true);
    },
  );

  test("rejects a 257-Domain complete inventory before transfer", () => {
    expect(protectedAdditionalDevicePlanV2Schema.safeParse(page(257)).success)
      .toBe(false);
  });

  test("keeps twelve as a page bound, not a product bound", () => {
    expect(protectedAdditionalDevicePlanV2Schema.safeParse(page(13, 0, 13)).success)
      .toBe(false);
    expect(protectedAdditionalDevicePlanV1Schema.safeParse({
      formatVersion: 1,
      enrollment,
      domains: Array.from({ length: 13 }, (_, index) => domain(index)),
    }).success).toBe(false);
  });

  test("carries at most one personal authority anchor", () => {
    expect(protectedAdditionalDevicePlanV2Schema.safeParse({
      ...page(0),
      personalAuthority: {
        roomId: "00000000-0000-4000-8000-000000000003",
        namespaceId: "00000000-0000-4000-8000-000000000004",
      },
    }).success).toBe(true);
    expect(protectedAdditionalDevicePlanV2Schema.safeParse({
      ...page(0),
      personalAuthority: [{
        roomId: "00000000-0000-4000-8000-000000000003",
        namespaceId: "00000000-0000-4000-8000-000000000004",
      }],
    }).success).toBe(false);
  });

  test("keeps V2 transition preparation lease-free", () => {
    const value = {
      formatVersion: 2 as const,
      operationId: enrollment.operationId,
      targetDeviceId: enrollment.deviceId,
      domainCount: 1,
      page: {
        start: 0,
        end: 1,
        nextStart: null,
        pageDigestBase64url: hash,
      },
      domains: [{
        plan: domain(0),
        joinPackageBytesBase64url: "AQ",
      }],
    };
    expect(protectedAdditionalDeviceTransitionPlanV2Schema.safeParse(value).success)
      .toBe(true);
    expect(protectedAdditionalDeviceTransitionPlanV2Schema.safeParse({
      ...value,
      domains: [{
        ...value.domains[0],
        claim: {
          state: "preparing",
          workerId: "device-approver",
          retryCount: 0,
          leaseExpiresAt: 2_000,
        },
      }],
    }).success).toBe(false);
  });

  test("rejects missing, overlapping, and unknown page bytes", () => {
    expect(protectedAdditionalDevicePlanV2Schema.safeParse({
      ...page(13),
      page: { ...page(13).page, nextStart: 11 },
    }).success).toBe(false);
    expect(protectedAdditionalDevicePlanV2Schema.safeParse({
      ...page(1),
      unexpected: true,
    }).success).toBe(false);
  });

  test.each([0, 1, 12, 13, 255, 256])(
    "accepts one complete %i-Domain transition campaign",
    (domainCount) => {
      const transitions = Array.from({ length: domainCount }, (_, index) => ({
        domainId: `domain-${index.toString().padStart(3, "0")}`,
        providerSubmissionBytesBase64url: "AQ",
        namespaceSubmissionBytesBase64url: "Ag",
      }));
      expect(protectedAdditionalDeviceTransitionsRequestV2Schema.safeParse({
        requestVersion: 2,
        approverDeviceId: "device-approver",
        inventoryRevision: 1,
        inventoryCount: domainCount,
        inventoryDigestBase64url: hash,
        domainCount,
        transitions,
      }).success).toBe(true);
    },
  );

  test("rejects incomplete and 257-Domain transition campaigns", () => {
    const candidate = {
      requestVersion: 2 as const,
      approverDeviceId: "device-approver",
      inventoryRevision: 1,
      inventoryCount: 1,
      inventoryDigestBase64url: hash,
      domainCount: 1,
      transitions: [],
    };
    expect(protectedAdditionalDeviceTransitionsRequestV2Schema.safeParse(candidate).success)
      .toBe(false);
    expect(protectedAdditionalDeviceTransitionsRequestV2Schema.safeParse({
      ...candidate,
      domainCount: 257,
      transitions: Array.from({ length: 257 }, (_, index) => ({
        domainId: `domain-${index}`,
        providerSubmissionBytesBase64url: "AQ",
        namespaceSubmissionBytesBase64url: "Ag",
      })),
    }).success).toBe(false);
  });

  test("allows one complete bounded delivery fetch", () => {
    expect(protectedAdditionalDeviceDeliveriesRequestV1Schema.safeParse({
      requestVersion: 1,
      requestId: "operation-1",
      humanId: enrollment.humanActorId,
      deviceId: enrollment.deviceId,
      expectedDeviceRevision: 1,
      minimumHighWatermark: 0,
      maximumMessages: 4_096,
      maximumPayloadBytes: 64 * 1_048_576,
      issuedAt: 1_000,
      expiresAt: 2_000,
      signatureBase64url: "AQ",
    }).success).toBe(true);
  });

  test("requires one typed reason for every syncing activation", () => {
    const base = {
      formatVersion: 1 as const,
      operationId: "operation-1",
      deviceId: "device-target",
      deviceRevision: 2,
      custodyRevision: 3,
    };
    expect(protectedAdditionalDeviceActivationV1Schema.safeParse({
      ...base,
      status: "syncing",
      syncReason: "current_domain_sync_required",
    }).success).toBe(true);
    expect(protectedAdditionalDeviceActivationV1Schema.safeParse({
      ...base,
      status: "syncing",
    }).success).toBe(false);
    expect(protectedAdditionalDeviceActivationV1Schema.safeParse({
      ...base,
      status: "active",
      syncReason: "current_domain_sync_required",
    }).success).toBe(false);
    expect(protectedAdditionalDeviceActivationV1Schema.safeParse({
      ...base,
      status: "syncing",
      syncReason: "grant_sync_required",
    }).success).toBe(false);
  });
});
