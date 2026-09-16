import { describe, expect, mock, test } from "bun:test";
import Fastify from "fastify";
import {
  humanDeviceMembershipRoutes,
  type HumanDeviceMembershipComposition,
} from "../../src/routes/human-device-membership.ts";

const USER = "018f3df1-8d42-7c59-a112-17d92f9aa110";
const HUMAN = "018f3df1-8d42-7c59-a112-17d92f9aa111";

function fixture() {
  const app = Fastify();
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("sessionActorId", null);
  app.addHook("preHandler", async (request) => {
    request.sessionUserId = request.headers["x-user"] === "yes" ? USER : null;
    request.sessionActorId = request.headers["x-user"] === "yes" ? HUMAN : null;
  });
  const status = mock(async () => ({
    formatVersion: 1 as const,
    serverInstanceId: HUMAN,
    humanId: HUMAN,
    deviceId: "browser_route",
    deviceGeneration: 1,
    deviceRevision: 0,
      membershipState: "absent" as const,
      personalAuthority: null,
    head: null,
    welcome: null,
    targetJoin: null,
    commits: [],
    nextSequence: null,
  }));
  const roster = mock(async () => ({
    formatVersion: 1 as const,
    currentDeviceId: "browser_route",
    currentMemberCount: 1,
    devices: [{
      deviceId: "browser_route",
      clientKind: "browser" as const,
      membershipState: "current" as const,
      deviceGeneration: 1,
      deviceRevision: 1,
      isCurrentDevice: true,
      publicFingerprintBase64url: "A".repeat(43),
      membershipEvidence: {
        lineageGeneration: 1,
        epoch: 0,
        securityRevision: 1,
        acknowledgedSequence: 0,
        headDigestBase64url: "H".repeat(43),
      },
      admissionEvidence: null,
      domainKeyCoverage: { acknowledged: 0, required: 0 },
      deliveryEvidence: {
        acknowledgedSequence: 0,
        highWatermark: 0,
        blocked: null,
      },
      createdAt: 1,
      lastSeenAt: 2,
      revokedAt: null,
      canRemove: false,
    }],
  }));
  const publishRemove = mock(async () => ({
    formatVersion: 1 as const,
    status: "published" as const,
  }));
  const beginRecovery = mock(async () => ({
    formatVersion: 1 as const,
    operationId: "recovery_route",
    challengeBytesBase64url: "AQ",
    serverInstanceId: HUMAN,
    currentLineageGeneration: 1,
    nextLineageGeneration: 2,
    personalAuthority: null,
  }));
  const completeRecovery = mock(async () => ({
    formatVersion: 1 as const,
    status: "created" as const,
  }));
  const unused = async () => {
    throw new Error("unexpected");
  };
  humanDeviceMembershipRoutes(app, {
    status,
    establishInitial: unused,
    begin: unused,
    publishJoin: unused,
    pending: unused,
    roster,
    publishAdd: unused,
    publishRemove,
    beginRecovery,
    completeRecovery,
    acknowledge: unused,
  } as unknown as HumanDeviceMembershipComposition);
  return {
    app,
    status,
    roster,
    publishRemove,
    beginRecovery,
    completeRecovery,
  };
}

describe("Human-device membership routes", () => {
  test("requires a signed-in Human and forwards only their authority", async () => {
    const { app, status } = fixture();
    expect((await app.inject({
      method: "POST",
      url: "/api/protected/devices/membership/status",
      payload: { requestVersion: 1, deviceId: "browser_route" },
    })).statusCode).toBe(401);

    const response = await app.inject({
      method: "POST",
      url: "/api/protected/devices/membership/status",
      headers: { "x-user": "yes" },
      payload: { requestVersion: 1, deviceId: "browser_route" },
    });
    expect(response.statusCode).toBe(200);
    expect(status).toHaveBeenCalledWith({
      authority: { userId: USER, humanActorId: HUMAN },
      request: { requestVersion: 1, deviceId: "browser_route" },
    });
    await app.close();
  });

  test("rejects malformed operation identifiers before composition", async () => {
    const { app } = fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/protected/devices/membership/%20/add",
      headers: { "x-user": "yes" },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  test("returns the MLS-authenticated roster without accepting a Human id", async () => {
    const { app, roster } = fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/protected/devices/membership/roster",
      headers: { "x-user": "yes" },
      payload: { requestVersion: 1, currentDeviceId: "browser_route" },
    });
    expect(response.statusCode).toBe(200);
    expect(roster).toHaveBeenCalledWith({
      authority: { userId: USER, humanActorId: HUMAN },
      request: { requestVersion: 1, currentDeviceId: "browser_route" },
    });
    await app.close();
  });

  test("forwards a PIN-confirmed Remove under the signed-in Human authority", async () => {
    const { app, publishRemove } = fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/protected/devices/membership/remove_route/remove",
      headers: { "x-user": "yes" },
      payload: {
        requestVersion: 1,
        committerDeviceId: "browser_route",
        transitionBytesBase64url: "AQ",
        pin: "123456",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(publishRemove).toHaveBeenCalledWith({
      authority: { userId: USER, humanActorId: HUMAN },
      operationId: "remove_route",
      request: {
        requestVersion: 1,
        committerDeviceId: "browser_route",
        transitionBytesBase64url: "AQ",
        pin: "123456",
      },
    });
    await app.close();
  });

  test("rejects malformed removal PINs before cryptographic mutation", async () => {
    const { app, publishRemove } = fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/protected/devices/membership/remove_route/remove",
      headers: { "x-user": "yes" },
      payload: {
        requestVersion: 1,
        committerDeviceId: "browser_route",
        transitionBytesBase64url: "AQ",
        pin: "123",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(publishRemove).not.toHaveBeenCalled();
    await app.close();
  });

  test("keeps the recovery phrase client-side across begin and completion", async () => {
    const { app, beginRecovery, completeRecovery } = fixture();
    const beginRequest = {
      requestVersion: 1 as const,
      deviceId: "browser_recovered",
      clientKind: "browser" as const,
      installationLineageDigestBase64url: "A".repeat(43),
      deviceGeneration: 1 as const,
      signingPublicKeyBase64url: "A".repeat(43),
      encryptionPublicKeyBase64url: "A".repeat(87),
      idempotencyKey: "recovery_route",
    };
    expect((await app.inject({
      method: "POST",
      url: "/api/protected/devices/membership/recovery/begin",
      headers: { "x-user": "yes" },
      payload: beginRequest,
    })).statusCode).toBe(200);
    expect(beginRecovery).toHaveBeenCalledWith({
      authority: { userId: USER, humanActorId: HUMAN },
      request: beginRequest,
    });

    const completionRequest = {
      requestVersion: 1 as const,
      deviceId: "browser_recovered",
      challengeHashBase64url: "A".repeat(43),
      responseBase64url: "B".repeat(43),
      headBytesBase64url: "AQ",
      rosterBytesBase64url: "AQ",
    };
    expect((await app.inject({
      method: "POST",
      url: "/api/protected/devices/membership/recovery_route/recovery",
      headers: { "x-user": "yes" },
      payload: completionRequest,
    })).statusCode).toBe(200);
    expect(completeRecovery).toHaveBeenCalledWith({
      authority: { userId: USER, humanActorId: HUMAN },
      operationId: "recovery_route",
      request: completionRequest,
    });
    expect((await app.inject({
      method: "POST",
      url: "/api/protected/devices/membership/recovery/begin",
      headers: { "x-user": "yes" },
      payload: { ...beginRequest, mnemonic: "must remain local" },
    })).statusCode).toBe(400);
    await app.close();
  });
});
