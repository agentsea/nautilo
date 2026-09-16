import { describe, expect, test } from "bun:test";
import Fastify from "fastify";

import {
  nautiloActorId,
  nautiloUserId,
  type InitialDeviceBootstrapChallenge,
} from "@nautilo/lattice-bridge";
import {
  createProductionInitialDeviceReadinessComposition,
  protectedInitialDeviceReadinessRoutes,
  type ProtectedInitialDeviceReadinessComposition,
} from "../../src/routes/protected-initial-device-readiness";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const HUMAN_ID = "00000000-0000-4000-8000-000000000002";
const DEVICE_ID = "device:browser:1";

function productIds() {
  const userId = nautiloUserId(USER_ID);
  const humanActorId = nautiloActorId(HUMAN_ID);
  if (!userId.ok || !humanActorId.ok) throw new Error("invalid fixture ids");
  return { userId: userId.value, humanActorId: humanActorId.value };
}

function bytes(length: number, value = 7): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function b64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function challenge(): InitialDeviceBootstrapChallenge {
  const ids = productIds();
  return Object.freeze({
    formatVersion: 1,
    ...ids,
    deviceId: DEVICE_ID,
    clientKind: "browser",
    installationLineageDigest: bytes(32, 1),
    signingPublicKey: bytes(32, 2),
    encryptionPublicKey: bytes(65, 3),
    recoveryKeyId: "recovery:1",
    recoveryPublicKey: bytes(65, 4),
    context: Object.freeze({
      kind: "preparation" as const,
      authorityId: `initial-device:${USER_ID}`,
    }),
    idempotencyKey: "bootstrap:1",
    challengeId: "challenge:1",
    authorizationEvidenceDigest: bytes(32, 5),
    authorizationDigest: bytes(32, 6),
    issuedAt: 1_000,
    expiresAt: 2_000,
  });
}

function challengeDto(value: InitialDeviceBootstrapChallenge) {
  return {
    formatVersion: 1,
    userId: value.userId,
    humanActorId: value.humanActorId,
    deviceId: value.deviceId,
    clientKind: value.clientKind,
    installationLineageDigestBase64url: b64(value.installationLineageDigest),
    signingPublicKeyBase64url: b64(value.signingPublicKey),
    encryptionPublicKeyBase64url: b64(value.encryptionPublicKey),
    recoveryKeyId: value.recoveryKeyId,
    recoveryPublicKeyBase64url: b64(value.recoveryPublicKey),
    context: value.context,
    idempotencyKey: value.idempotencyKey,
    challengeId: value.challengeId,
    authorizationEvidenceDigestBase64url: b64(
      value.authorizationEvidenceDigest,
    ),
    authorizationDigestBase64url: b64(value.authorizationDigest),
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  };
}

function receipt() {
  return Object.freeze({
    formatVersion: 1 as const,
    status: "active" as const,
    humanActorId: productIds().humanActorId,
    deviceId: DEVICE_ID,
    recoveryKeyId: "recovery:1",
    recoveryGeneration: 1 as const,
    deviceRevision: 1 as const,
    custodyRevision: 1 as const,
    auditRef: "bootstrap_0123456789abcdef0123456789abcdef",
    committedAt: 2_000,
  });
}

function appWith(composition: ProtectedInitialDeviceReadinessComposition) {
  const app = Fastify();
  app.addHook("preHandler", (request, _reply, done) => {
    const authenticated = request.headers.authorization === "Bearer ok";
    request.sessionUserId = authenticated ? USER_ID : null;
    request.sessionActorId = authenticated ? HUMAN_ID : null;
    request.policyContext = authenticated
      ? {
          actorRole: request.headers["x-test-role"] === "guest"
            ? "guest"
            : "member",
        } as typeof request.policyContext
      : null;
    done();
  });
  protectedInitialDeviceReadinessRoutes(app, {
    composition,
    now: () => 3_000,
  });
  return app;
}

function unreachable(): never {
  throw new Error("unexpected composition call");
}

describe("protected initial device and Human Domain readiness routes", () => {
  test("production registration is reachable without eagerly opening crypto PostgreSQL", async () => {
    const app = Fastify();
    protectedInitialDeviceReadinessRoutes(app, {
      composition: createProductionInitialDeviceReadinessComposition(),
    });
    const routes = app.printRoutes();
    expect(routes).toContain("api/protected/devices/initial-");
    expect(routes).toContain("bootstrap/");
    expect(routes).toContain("begin (POST)");
    expect(routes).toContain("domain (POST)");
    expect(routes).toContain("/plan (POST)");
    await app.close();
  });

  test("derives identity, returns the challenge, and wipes decoded begin bytes", async () => {
    let decoded: Uint8Array | undefined;
    const composition: ProtectedInitialDeviceReadinessComposition = {
      begin: (input) => {
        expect(input.authority).toEqual({
          userId: USER_ID,
          humanActorId: HUMAN_ID,
        });
        decoded = input.request.signingPublicKey;
        return Promise.resolve(challenge());
      },
      complete: unreachable,
      resolveReceipt: unreachable,
      planDomain: unreachable,
      activateDomain: unreachable,
    };
    const app = appWith(composition);
    const response = await app.inject({
      method: "POST",
      url: "/api/protected/devices/initial-bootstrap/begin",
      headers: { authorization: "Bearer ok" },
      payload: {
        requestVersion: 1,
        deviceId: DEVICE_ID,
        clientKind: "browser",
        installationLineageDigestBase64url: b64(bytes(32, 1)),
        signingPublicKeyBase64url: b64(bytes(32, 2)),
        encryptionPublicKeyBase64url: b64(bytes(65, 3)),
        recoveryKeyId: "recovery:1",
        recoveryPublicKeyBase64url: b64(bytes(65, 4)),
        idempotencyKey: "bootstrap:1",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      challengeId: "challenge:1",
      userId: USER_ID,
      humanActorId: HUMAN_ID,
    });
    expect(decoded).toBeDefined();
    expect(decoded!.every((value) => value === 0)).toBeTrue();
    await app.close();
  });

  test("resubmits completion and receipt lookup under the same session identity", async () => {
    let completionBytes: Uint8Array | undefined;
    let fingerprint: Uint8Array | undefined;
    const composition: ProtectedInitialDeviceReadinessComposition = {
      begin: unreachable,
      complete: (input) => {
        completionBytes = input.completion.recoveryArchiveBytes;
        expect(String(input.completion.challenge.userId)).toBe(USER_ID);
        return Promise.resolve(receipt());
      },
      resolveReceipt: (input) => {
        fingerprint = input.query.publicFingerprint;
        expect(String(input.query.userId)).toBe(USER_ID);
        return Promise.resolve(receipt());
      },
      planDomain: unreachable,
      activateDomain: unreachable,
    };
    const app = appWith(composition);
    const complete = await app.inject({
      method: "POST",
      url: "/api/protected/devices/initial-bootstrap/complete",
      headers: { authorization: "Bearer ok" },
      payload: {
        requestVersion: 1,
        challenge: challengeDto(challenge()),
        recoveryArchiveBytesBase64url: b64(bytes(48, 8)),
        deviceProofBase64url: b64(bytes(64, 9)),
      },
    });
    expect(complete.statusCode).toBe(200);
    expect(completionBytes!.every((value) => value === 0)).toBeTrue();

    const lookup = await app.inject({
      method: "POST",
      url: "/api/protected/devices/initial-bootstrap/receipt",
      headers: { authorization: "Bearer ok" },
      payload: {
        requestVersion: 1,
        deviceId: DEVICE_ID,
        challengeId: "challenge:1",
        publicFingerprintBase64url: b64(bytes(32, 10)),
      },
    });
    expect(lookup.statusCode).toBe(200);
    expect(fingerprint!.every((value) => value === 0)).toBeTrue();
    await app.close();
  });

  test("plans and activates only the session Human's deterministic Domain", async () => {
    let signedBytes: Uint8Array | undefined;
    const operationId = "initial-domain:v1:abc";
    const domainId = "domain:v1:abc";
    const composition: ProtectedInitialDeviceReadinessComposition = {
      begin: unreachable,
      complete: unreachable,
      resolveReceipt: unreachable,
      planDomain: (input) => {
        expect(input.authority).toEqual({
          userId: USER_ID,
          humanActorId: HUMAN_ID,
          humanId: HUMAN_ID,
          deviceId: DEVICE_ID,
        });
        return Promise.resolve({
          formatVersion: 1,
          status: "planned",
          operationId,
          humanId: HUMAN_ID,
          deviceId: DEVICE_ID,
          domainId,
          currentDomainHead: null,
          activeDeviceIds: [DEVICE_ID],
          trustedDeviceRevision: 1,
          trustedHostAuthorizationRevision: 1,
          deliveryHighWatermark: 0,
        });
      },
      activateDomain: (input) => {
        signedBytes = input.submission.signature;
        expect(input.now).toBe(3_000);
        expect(input.submission.committerHumanId).toBe(HUMAN_ID);
        return Promise.resolve({
          formatVersion: 1,
          status: "active",
          operationId,
          humanId: HUMAN_ID,
          deviceId: DEVICE_ID,
          domainId,
          providerId: "openmls:v2",
          epoch: 0,
          stateHashBase64url: b64(bytes(32, 11)),
          rosterHashBase64url: b64(bytes(32, 12)),
          submissionDigestBase64url: b64(bytes(32, 13)),
          committedAt: 3_000,
        });
      },
    };
    const app = appWith(composition);
    const plan = await app.inject({
      method: "POST",
      url: "/api/protected/devices/initial-domain/plan",
      headers: { authorization: "Bearer ok" },
      payload: { requestVersion: 1, deviceId: DEVICE_ID },
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.json()).toMatchObject({ status: "planned", domainId });

    const activate = await app.inject({
      method: "POST",
      url: "/api/protected/devices/initial-domain",
      headers: { authorization: "Bearer ok" },
      payload: {
        requestVersion: 1,
        submission: {
          formatVersion: 1,
          operationId,
          targetDomainId: domainId,
          participants: [HUMAN_ID],
          participantDigestBase64url: b64(bytes(32, 14)),
          committerDeviceId: DEVICE_ID,
          committerHumanId: HUMAN_ID,
          initialProviderHead: {
            providerId: "openmls:v2",
            domainId,
            epoch: 0,
            stateHashBase64url: b64(bytes(32, 15)),
          },
          initialRosterBytesBase64url: b64(bytes(32, 16)),
          additions: [],
          chainDigestBase64url: b64(bytes(32, 17)),
          signatureBase64url: b64(bytes(64, 18)),
        },
      },
    });
    expect(activate.statusCode).toBe(200);
    expect(activate.json()).toMatchObject({ status: "active", domainId });
    expect(signedBytes!.every((value) => value === 0)).toBeTrue();
    await app.close();
  });

  test("rejects anonymous, guest, malformed, and substituted-Human requests", async () => {
    let calls = 0;
    const composition: ProtectedInitialDeviceReadinessComposition = {
      begin: () => { calls += 1; return Promise.resolve(challenge()); },
      complete: unreachable,
      resolveReceipt: unreachable,
      planDomain: () => { calls += 1; return Promise.resolve({
        formatVersion: 1,
        status: "unavailable",
        reason: "stale_identity",
      }); },
      activateDomain: unreachable,
    };
    const app = appWith(composition);
    expect((await app.inject({
      method: "POST",
      url: "/api/protected/devices/initial-domain/plan",
      payload: { requestVersion: 1, deviceId: DEVICE_ID },
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url: "/api/protected/devices/initial-domain/plan",
      headers: { authorization: "Bearer ok", "x-test-role": "guest" },
      payload: { requestVersion: 1, deviceId: DEVICE_ID },
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url: "/api/protected/devices/initial-domain/plan",
      headers: { authorization: "Bearer ok" },
      payload: { requestVersion: 2, deviceId: DEVICE_ID },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST",
      url: "/api/protected/devices/initial-bootstrap/begin",
      headers: { authorization: "Bearer ok" },
      payload: {
        requestVersion: 1,
        deviceId: DEVICE_ID,
        clientKind: "browser",
        installationLineageDigestBase64url: b64(bytes(32, 1)),
        signingPublicKeyBase64url: "AB",
        encryptionPublicKeyBase64url: b64(bytes(65, 3)),
        recoveryKeyId: "recovery:1",
        recoveryPublicKeyBase64url: b64(bytes(65, 4)),
        idempotencyKey: "bootstrap:1",
      },
    })).statusCode).toBe(400);
    expect(calls).toBe(0);
    await app.close();
  });
});
