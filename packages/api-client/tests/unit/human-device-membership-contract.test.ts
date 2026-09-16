import { describe, expect, test } from "bun:test";
import {
  humanDeviceMembershipBeginRequestV1Schema,
  humanDeviceMembershipPendingV1Schema,
  humanDeviceMembershipRosterV1Schema,
  humanDeviceMembershipStatusV1Schema,
} from "../../src/index.ts";

const UUID = "018f3df1-8d42-7c59-a112-17d92f9aa111";
const HASH = "A".repeat(43);

describe("Human-device membership API contract", () => {
  test("distinguishes an unenrolled device without weakening identity bytes", () => {
    expect(humanDeviceMembershipStatusV1Schema.parse({
      formatVersion: 1,
      serverInstanceId: UUID,
      humanId: UUID,
      deviceId: "browser_new",
      deviceGeneration: 1,
      deviceRevision: 0,
      membershipState: "absent",
      personalAuthority: null,
      head: null,
      welcome: null,
      targetJoin: null,
      commits: [],
      nextSequence: null,
    }).membershipState).toBe("absent");

    expect(humanDeviceMembershipBeginRequestV1Schema.safeParse({
      requestVersion: 1,
      deviceId: "browser_new",
      clientKind: "browser",
      installationLineageDigestBase64url: HASH,
      deviceGeneration: 1,
      signingPublicKeyBase64url: HASH,
      encryptionPublicKeyBase64url: "A".repeat(87),
      idempotencyKey: "enroll_browser_new",
    }).success).toBe(true);
  });

  test("bounds one commit page without imposing a device-count ceiling", () => {
    const base = {
      formatVersion: 1 as const,
      serverInstanceId: UUID,
      humanId: UUID,
      deviceId: "browser_current",
      deviceGeneration: 1,
      deviceRevision: 4,
      membershipState: "catching_up" as const,
      personalAuthority: null,
      head: { headBytesBase64url: "AA", sequence: 65 },
      welcome: null,
      targetJoin: null,
      nextSequence: 64,
    };
    expect(humanDeviceMembershipStatusV1Schema.safeParse({
      ...base,
      commits: Array.from({ length: 64 }, (_, sequence) => ({
        sequence: sequence + 1,
        transitionBytesBase64url: "AA",
      })),
    }).success).toBe(true);
    expect(humanDeviceMembershipStatusV1Schema.safeParse({
      ...base,
      commits: Array.from({ length: 65 }, (_, sequence) => ({
        sequence: sequence + 1,
        transitionBytesBase64url: "AA",
      })),
    }).success).toBe(false);
  });

  test("continues pending approvals instead of imposing a fleet ceiling", () => {
    const pending = Array.from({ length: 64 }, (_, index) => ({
      operationId: `operation_${String(index).padStart(3, "0")}`,
      targetDeviceId: `device_${String(index).padStart(3, "0")}`,
      targetClientKind: index % 2 === 0 ? "browser" as const : "electron" as const,
      targetDeviceGeneration: 1,
      targetSigningPublicKeyBase64url: HASH,
      requestBytesBase64url: "AA",
      createdAt: index,
    }));
    expect(humanDeviceMembershipPendingV1Schema.safeParse({
      formatVersion: 1,
      pending,
      nextOperationId: pending.at(-1)!.operationId,
    }).success).toBe(true);
    expect(humanDeviceMembershipPendingV1Schema.safeParse({
      formatVersion: 1,
      pending: [...pending, { ...pending[0], operationId: "operation_064" }],
      nextOperationId: "operation_064",
    }).success).toBe(false);
  });

  test("keeps device health content-free and internally coherent", () => {
    const device = {
      deviceId: "browser_current",
      clientKind: "browser" as const,
      deviceGeneration: 1,
      deviceRevision: 4,
      membershipState: "current" as const,
      isCurrentDevice: true,
      canRemove: false,
      publicFingerprintBase64url: HASH,
      membershipEvidence: {
        lineageGeneration: 2,
        epoch: 3,
        securityRevision: 4,
        acknowledgedSequence: 5,
        headDigestBase64url: HASH,
      },
      admissionEvidence: { lastProvedAt: 10, expiresAt: 20 },
      domainKeyCoverage: { acknowledged: 7, required: 8 },
      deliveryEvidence: {
        acknowledgedSequence: 9,
        highWatermark: 10,
        blocked: null,
      },
      createdAt: 1,
      lastSeenAt: 2,
      revokedAt: null,
    };
    expect(humanDeviceMembershipRosterV1Schema.safeParse({
      formatVersion: 1,
      currentDeviceId: device.deviceId,
      currentMemberCount: 1,
      devices: [device],
    }).success).toBe(true);
    expect(humanDeviceMembershipRosterV1Schema.safeParse({
      formatVersion: 1,
      currentDeviceId: device.deviceId,
      currentMemberCount: 1,
      devices: [{
        ...device,
        domainKeyCoverage: { acknowledged: 9, required: 8 },
      }],
    }).success).toBe(false);
    expect(humanDeviceMembershipRosterV1Schema.safeParse({
      formatVersion: 1,
      currentDeviceId: device.deviceId,
      currentMemberCount: 1,
      devices: [{
        ...device,
        deliveryEvidence: {
          acknowledgedSequence: 11,
          highWatermark: 10,
          blocked: null,
        },
      }],
    }).success).toBe(false);
  });
});
