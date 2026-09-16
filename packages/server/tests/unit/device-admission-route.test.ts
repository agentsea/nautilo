import { describe, expect, mock, test } from "bun:test";
import Fastify from "fastify";

import {
  deviceAdmissionRoutes,
  type DeviceAdmissionComposition,
} from "../../src/routes/device-admission";

const USER_ID = "10000000-0000-4000-8000-000000000303";
const HUMAN_ID = "20000000-0000-4000-8000-000000000303";
const DEVICE_ID = `crypto:browser:${"a".repeat(64)}`;
const SERVER_ID = "40000000-0000-4000-8000-000000000303";

function appWith(composition: DeviceAdmissionComposition) {
  const app = Fastify({ logger: false });
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("sessionActorId", null);
  app.decorateRequest("accessTokenExpiresAt", null);
  app.addHook("preHandler", async (request) => {
    request.sessionUserId = USER_ID;
    request.sessionActorId = HUMAN_ID;
    request.accessTokenExpiresAt = Date.now() + 60_000;
  });
  deviceAdmissionRoutes(app, {
    composition,
    requiresCryptoDevice: async () => true,
  });
  return app;
}

function composition(
  overrides: Partial<DeviceAdmissionComposition> = {},
): DeviceAdmissionComposition {
  return {
    issueChallenge: mock(async () => null),
    admit: mock(async () => "invalid" as const),
    status: mock(async () => ({
      status: "required" as const,
      reason: "device_admission_required" as const,
    })),
    currentAuthorityForDelegation: mock(async () => null),
    ...overrides,
  };
}

describe("M303 device-admission HTTP contract", () => {
  test("status exposes no roster coordinates or digests", async () => {
    const app = appWith(composition({
      status: mock(async () => ({
        status: "admitted" as const,
        deviceId: DEVICE_ID,
        deviceGeneration: 1,
        serverInstanceId: SERVER_ID,
        lineageGeneration: 2,
        epoch: 3,
        securityRevision: 4,
        headDigest: new Uint8Array(32).fill(9),
        expiresAt: Date.now() + 50_000,
      })),
    }));
    const response = await app.inject({
      method: "GET",
      url: "/api/crypto-device-admission/status",
      headers: { authorization: "Bearer bearer-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json()).sort()).toEqual([
      "deviceGeneration",
      "deviceId",
      "expiresAt",
      "required",
      "responseVersion",
      "status",
    ]);
    await app.close();
  });

  test("challenge and proof round-trip through the strict DTO", async () => {
    const challengeId = `challenge_${"a".repeat(32)}`;
    const nonce = new Uint8Array(32).fill(3);
    const value = composition({
      issueChallenge: mock(async ({ authority, now }:
      Parameters<DeviceAdmissionComposition["issueChallenge"]>[0]) => {
        return Object.freeze({
          formatVersion: 1 as const,
          challengeId,
          credentialDigest: authority.credentialDigest.slice(),
          userId: USER_ID,
          humanActorId: HUMAN_ID,
          deviceId: DEVICE_ID,
          deviceGeneration: 1,
          serverInstanceId: SERVER_ID,
          lineageGeneration: 1,
          epoch: 1,
          securityRevision: 1,
          headDigest: new Uint8Array(32).fill(4),
          nonce,
          issuedAt: now,
          expiresAt: now + 30_000,
        });
      }),
      admit: mock(async () => "admitted" as const),
      status: mock(async () => ({
        status: "admitted" as const,
        deviceId: DEVICE_ID,
        deviceGeneration: 1,
        serverInstanceId: SERVER_ID,
        lineageGeneration: 1,
        epoch: 1,
        securityRevision: 1,
        headDigest: new Uint8Array(32).fill(4),
        expiresAt: Date.now() + 50_000,
      })),
    });
    const app = appWith(value);
    const challenged = await app.inject({
      method: "POST",
      url: "/api/crypto-device-admission/challenge",
      headers: { authorization: "Bearer bearer-1" },
      payload: { requestVersion: 1, deviceId: DEVICE_ID },
    });
    expect(challenged.statusCode).toBe(200);
    const challenge = challenged.json<{
      challenge: Record<string, unknown>;
    }>().challenge;
    const proved = await app.inject({
      method: "POST",
      url: "/api/crypto-device-admission/proof",
      headers: { authorization: "Bearer bearer-1" },
      payload: {
        requestVersion: 1,
        proof: {
          ...challenge,
          signatureBase64url: Buffer.alloc(64, 5).toString("base64url"),
        },
      },
    });
    expect(proved.statusCode).toBe(200);
    expect(proved.json()).toMatchObject({
      responseVersion: 1,
      status: "admitted",
      deviceId: DEVICE_ID,
      deviceGeneration: 1,
    });
    await app.close();
  });

  test("rejects malformed canonical proof fields without entering persistence", async () => {
    const admit = mock(async () => "admitted" as const);
    const app = appWith(composition({ admit }));
    const response = await app.inject({
      method: "POST",
      url: "/api/crypto-device-admission/proof",
      headers: { authorization: "Bearer bearer-1" },
      payload: {
        requestVersion: 1,
        proof: {
          formatVersion: 1,
          challengeId: "challenge_malformed",
          credentialDigestBase64url: Buffer.alloc(32, 1).toString("base64url"),
          userId: USER_ID,
          humanActorId: HUMAN_ID,
          deviceId: DEVICE_ID,
          deviceGeneration: 1,
          serverInstanceId: SERVER_ID,
          lineageGeneration: 1,
          epoch: 1,
          securityRevision: 1,
          headDigestBase64url: Buffer.alloc(32, 2).toString("base64url"),
          nonceBase64url: Buffer.alloc(32, 3).toString("base64url"),
          issuedAt: 10_000,
          expiresAt: 10_000,
          signatureBase64url: Buffer.alloc(64, 4).toString("base64url"),
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(admit).not.toHaveBeenCalled();
    await app.close();
  });
});
