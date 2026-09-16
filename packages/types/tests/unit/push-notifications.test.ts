import { describe, expect, test } from "bun:test";
import {
  mobilePushEnvelopeV1Schema,
  mobilePushInstallationBadgePreferenceRequestSchema,
  mobilePushInstallationProofRevokeRequestSchema,
  mobilePushInstallationRegisterRequestSchema,
  mobilePushRevokeTombstoneSchema,
} from "../../src/push-notifications";

const installationId = "11111111-1111-4111-8111-111111111111";
const bindingId = "22222222-2222-4222-8222-222222222222";
const notificationId = "33333333-3333-4333-8333-333333333333";
const messageId = 444;
const topLevelRoomId = "55555555-5555-4555-8555-555555555555";
const occurredAt = "2026-08-05T20:00:00.000Z";
const revokeProof = "r".repeat(48);

describe("D468 Mobile push installation contracts", () => {
  test("accepts a bounded enabled registration and rejects arbitrary copy", () => {
    const request = {
      version: 1,
      installationId,
      bindingId,
      platform: "ios",
      expoPushToken: "ExponentPushToken[opaque-token]",
      enabled: true,
      tokenGeneration: 1,
      appVersion: "0.1.0",
      permission: "granted",
      revokeProof,
    } as const;
    expect(mobilePushInstallationRegisterRequestSchema.safeParse(request).success).toBe(true);
    expect(mobilePushInstallationRegisterRequestSchema.safeParse({ ...request, title: "leak" }).success).toBe(false);
    expect(mobilePushInstallationRegisterRequestSchema.safeParse({ ...request, expoPushToken: "not-an-expo-token" }).success).toBe(false);
    expect(mobilePushInstallationRegisterRequestSchema.safeParse({ ...request, tokenGeneration: 0 }).success).toBe(false);
  });

  test("requires the revoke proof to authorize only its exact binding", () => {
    expect(mobilePushInstallationProofRevokeRequestSchema.safeParse({
      version: 1,
      bindingId,
      revokeProof,
    }).success).toBe(true);
    expect(mobilePushInstallationProofRevokeRequestSchema.safeParse({
      version: 1,
      bindingId,
      revokeProof: "short",
    }).success).toBe(false);
  });

  test("bounds badge policy to one binding generation and a boolean choice", () => {
    const request = { version: 1, bindingId, tokenGeneration: 1, enabled: true } as const;
    expect(mobilePushInstallationBadgePreferenceRequestSchema.safeParse(request).success).toBe(true);
    expect(mobilePushInstallationBadgePreferenceRequestSchema.safeParse({ ...request, tokenGeneration: 0 }).success).toBe(false);
    expect(mobilePushInstallationBadgePreferenceRequestSchema.safeParse({ ...request, badge: 99 }).success).toBe(false);
  });

  test("accepts each closed envelope branch and rejects target confusion", () => {
    const envelope = {
      version: 1,
      notificationId,
      bindingId,
      kind: "important_message",
      roomId: topLevelRoomId,
      topLevelRoomId,
      messageId,
      occurredAt,
    } as const;
    expect(mobilePushEnvelopeV1Schema.safeParse(envelope).success).toBe(true);
    expect(mobilePushEnvelopeV1Schema.safeParse({ ...envelope, version: 2 }).success).toBe(false);
    expect(mobilePushEnvelopeV1Schema.safeParse({ ...envelope, kind: "marketing" }).success).toBe(false);
    expect(mobilePushEnvelopeV1Schema.safeParse({ ...envelope, messageId: undefined }).success).toBe(false);
    expect(mobilePushEnvelopeV1Schema.safeParse({ ...envelope, messageId: "444" }).success).toBe(false);

    const needsYou = {
      version: 1,
      notificationId,
      bindingId,
      kind: "needs_you",
      roomId: topLevelRoomId,
      topLevelRoomId,
      attentionRequestId: "66666666-6666-4666-8666-666666666666",
      occurredAt,
    } as const;
    expect(mobilePushEnvelopeV1Schema.safeParse(needsYou).success).toBe(true);
    expect(mobilePushEnvelopeV1Schema.safeParse({ ...needsYou, messageId }).success).toBe(false);

    const testEnvelope = {
      version: 1,
      notificationId,
      bindingId,
      kind: "test",
      occurredAt,
    } as const;
    expect(mobilePushEnvelopeV1Schema.safeParse(testEnvelope).success).toBe(true);
    expect(mobilePushEnvelopeV1Schema.safeParse({ ...testEnvelope, roomId: topLevelRoomId }).success).toBe(false);
    expect(mobilePushEnvelopeV1Schema.safeParse({ ...testEnvelope, messageId }).success).toBe(false);
  });

  test("permits a bounded revoke tombstone but never a bearer token", () => {
    const tombstone = {
      version: 1,
      serverUrl: "https://nautilo.example.test",
      bindingId,
      revokeProof,
      createdAt: occurredAt,
    };
    expect(mobilePushRevokeTombstoneSchema.safeParse(tombstone).success).toBe(true);
    expect(mobilePushRevokeTombstoneSchema.safeParse({ ...tombstone, accessToken: "forbidden" }).success).toBe(false);
  });
});
