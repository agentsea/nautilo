import { describe, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  LatticeCrypto,
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  cryptoDeviceId,
  humanId,
  withOpenedDomainForegroundAuthorization,
  type DomainForegroundAuthorityEntry,
  type DomainForegroundSecretEntry,
} from "@nautilo/lattice-crypto";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV2,
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  decodeTaskRuntimeBackgroundAuthorizationResponseV2,
  destroyTaskRuntimeBackgroundAuthorizationRequestV2,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyVerifiedTaskRuntimeSignerAuthorizationV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV2,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
  verifyCurrentTaskRuntimeSignerAuthorizationV1,
  type BackgroundAuthorizationIssuerV2,
} from "@nautilo/lattice-crypto/background";
import {
  agentRuntimeObjectSignerKeyIdV1,
  destroyDomainForegroundAuthorizationPlanV2,
} from "@nautilo/lattice-crypto/wire";
import { seededRng } from "@nautilo/lattice-crypto/testing";

import { tryRespondToCurrentTaskRuntimeAuthorizationV1 } from
  "../../src/client/background/task-runtime-authorization-responder-v1.ts";
import type { DomainForegroundAuthorityClientV2 } from
  "../../src/client/message/domain-foreground-authority-client.ts";

const NOW = 1_900_000_000_000;
const HUMAN_ID = "20000000-0000-4000-8000-000000000907";
const DEVICE_ID = "task-runtime-device-907";
const ROOM_ID = "task-runtime-room-907";
const EPISODE_ID = "task-runtime-episode-907";
const RECIPIENT_GENERATION = 4;
const DEVICE_GENERATION = 7;
const POLICY_REVISION = 11;
const HOST_AUTHORIZATION_REVISION = 13;
const LEGACY_PROFILE_HOST_AUTHORIZATION_REVISION = 4;
const SERVER_INSTANCE_ID = "10000000-0000-4000-8000-000000000907";
const TASK_ID = "30000000-0000-4000-8000-000000000907";
const TASK_RUN_ID = "40000000-0000-4000-8000-000000000907";
const encoder = new TextEncoder();

const DOMAIN: DomainForegroundAuthorityEntry = Object.freeze({
  domainId: "task-runtime-domain-907",
  sourceNamespaceId: "task-runtime-namespace-907",
  participantDigest: new Uint8Array(32).fill(0x31),
  participantCount: 2,
  keyClass: "ai",
  domainKeyGeneration: 3,
  authorizationRevision: authorizationRevision(5),
  headDigest: new Uint8Array(32).fill(0x32),
  activeNamespaceBindingSetDigest: new Uint8Array(32).fill(0x33),
  activeNamespaceBindingCount: 1,
});

async function fixture(workId = "task-run-907") {
  const crypto = new LatticeCrypto(seededRng(907_407), { now: () => NOW });
  const signer = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const plan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: "task-runtime-authorization-907",
    policyRevision: POLICY_REVISION,
    sessionId: EPISODE_ID,
    roomId: ROOM_ID,
    subjectHumanId: humanId(HUMAN_ID),
    committerDeviceId: cryptoDeviceId(DEVICE_ID),
    committerDeviceSigningGeneration: DEVICE_GENERATION,
    hostAuthorizationRevision: authorizationRevision(
      HOST_AUTHORIZATION_REVISION,
    ),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: RECIPIENT_GENERATION,
    recipientKeyId: "task-runtime-recipient-key-907",
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    deadlineAt: NOW + 300_000,
    maximumSecretBytes: 1024,
    domains: [DOMAIN],
  });
  const request = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: plan.authorizationId,
    workId,
    workKind: "task.execute",
    workPurpose: "task.execute",
    recipientGeneration: RECIPIENT_GENERATION,
    episodeId: EPISODE_ID,
    sourceRoomId: ROOM_ID,
    recipientKeyId: plan.recipientKeyId,
    recipientPublicKey: recipient.publicKey,
    authorizationPlan: plan,
    issuedAt: plan.issuedAt,
    deadlineAt: plan.deadlineAt,
  });
  const requestBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(
    request,
  );
  destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
  return { crypto, signer, recipient, plan, requestBytes };
}

function signingAuthority(
  value: Awaited<ReturnType<typeof fixture>>,
  issuer: Partial<BackgroundAuthorizationIssuerV2> = {},
) {
  return {
    issuer: {
      humanId: HUMAN_ID,
      deviceId: DEVICE_ID,
      deviceGeneration: DEVICE_GENERATION,
      serverInstanceId: SERVER_INSTANCE_ID,
      lineageGeneration: 2,
      epoch: 3,
      securityRevision: HOST_AUTHORIZATION_REVISION,
      headDigest: new Uint8Array(32).fill(0x41),
      signingPublicKeyHash: value.crypto.hash(value.signer.publicKey),
      ...issuer,
    },
    signingPrivateKey: value.signer.privateKey,
    policyRevision: POLICY_REVISION,
    hostAuthorizationRevision: LEGACY_PROFILE_HOST_AUTHORIZATION_REVISION,
  };
}

async function v2Fixture() {
  const value = await fixture(TASK_RUN_ID);
  const baseRequest = decodeTaskRuntimeBackgroundAuthorizationRequestV1(
    value.requestBytes,
  );
  if (baseRequest === null) throw new Error("fixture request failed to decode");
  const ephemeral = value.crypto.generateSigningKeyPair();
  const resultObjectId = `task-run-result:v1:${bytesToHex(value.crypto.hash(
    encoder.encode(
      `nautilo/task-run-result-crypto-object/v1\n${TASK_ID}\n${TASK_RUN_ID}\n1`,
    ),
  ))}`;
  const request = createTaskRuntimeBackgroundAuthorizationRequestV2(
    value.crypto,
    {
      baseRequest,
      work: {
        taskId: TASK_ID,
        taskRunId: TASK_RUN_ID,
        inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
        resultObjectId,
        executionSegment: 1,
        workIdentityHash: new Uint8Array(32).fill(0x51),
      },
      signer: {
        agentId: "task-runtime-agent-907",
        runtimeGeneration: 0,
        signerKeyId: agentRuntimeObjectSignerKeyIdV1(
          value.crypto,
          ephemeral.publicKey,
        ),
        signerPublicKey: ephemeral.publicKey,
      },
      deviceGroupHead: {
        serverInstanceId: SERVER_INSTANCE_ID,
        lineageGeneration: 2,
        epoch: 3,
        headDigest: new Uint8Array(32).fill(0x41),
        signingPublicKeyHash: value.crypto.hash(value.signer.publicKey),
      },
      namespaceRequirements: [{
        ordinal: 0,
        namespaceId: DOMAIN.sourceNamespaceId,
        domainId: DOMAIN.domainId,
        operations: ["decrypt", "encrypt"],
        expectedAccessRevision: 6,
        expectedPolicyRevision: POLICY_REVISION,
      }],
    },
  );
  const requestBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV2(
    value.crypto,
    request,
  );
  destroyTaskRuntimeBackgroundAuthorizationRequestV2(request);
  destroyTaskRuntimeBackgroundAuthorizationRequestV1(baseRequest);
  value.requestBytes.fill(0);
  return { ...value, requestBytes, ephemeral };
}

function destroyV2Fixture(value: Awaited<ReturnType<typeof v2Fixture>>): void {
  destroyDomainForegroundAuthorizationPlanV2(value.plan);
  value.requestBytes.fill(0);
  value.signer.privateKey.fill(0);
  value.recipient.privateKey.fill(0);
  value.ephemeral.privateKey.fill(0);
}

function domainAuthority(observedRooms: string[]):
  DomainForegroundAuthorityClientV2 {
  return Object.freeze({
    async withOpenedAuthorizationDomains<Value>(
      request: Parameters<
        DomainForegroundAuthorityClientV2[
          "withOpenedAuthorizationDomains"
        ]
      >[0],
      use: (domains: readonly DomainForegroundSecretEntry[]) =>
        Value | Promise<Value>,
    ) {
      observedRooms.push(request.sourceRoomId);
      const secret: DomainForegroundSecretEntry = Object.freeze({
        ...DOMAIN,
        participantDigest: DOMAIN.participantDigest.slice(),
        headDigest: DOMAIN.headDigest.slice(),
        domainKey: new Uint8Array(32).fill(0x34),
      });
      try {
        return Object.freeze({
          status: "opened" as const,
          value: await use(Object.freeze([secret])),
        });
      } finally {
        secret.participantDigest.fill(0);
        secret.headDigest.fill(0);
        secret.domainKey.fill(0);
      }
    },
    withOpenedTurnAuthority: () => Promise.reject(new Error("unused")),
    withOpenedReusableTurnRoomKey: () => Promise.reject(
      new Error("unused"),
    ),
  });
}

describe("Task Runtime device authorization responder", () => {
  test("mints for the current MLS security revision independently of the legacy profile revision", async () => {
    const value = await fixture();
    const observedRooms: string[] = [];
    let borrowedSigningKey: Uint8Array | undefined;
    try {
      const result = await tryRespondToCurrentTaskRuntimeAuthorizationV1({
        requestBytes: value.requestBytes,
        domainForegroundAuthority: domainAuthority(observedRooms),
        crypto: value.crypto,
        now: () => NOW + 1,
        withCurrentSigningAuthority: async (use) => {
          borrowedSigningKey = value.signer.privateKey.slice();
          try {
            return await use({
              issuer: {
                humanId: HUMAN_ID,
                deviceId: DEVICE_ID,
                deviceGeneration: DEVICE_GENERATION,
                serverInstanceId:
                  "10000000-0000-4000-8000-000000000907",
                lineageGeneration: 2,
                epoch: 3,
                securityRevision: HOST_AUTHORIZATION_REVISION,
                headDigest: new Uint8Array(32).fill(0x41),
                signingPublicKeyHash: value.crypto.hash(
                  value.signer.publicKey,
                ),
              },
              signingPrivateKey: borrowedSigningKey,
              policyRevision: POLICY_REVISION,
              hostAuthorizationRevision:
                LEGACY_PROFILE_HOST_AUTHORIZATION_REVISION,
            });
          } finally {
            borrowedSigningKey.fill(0);
          }
        },
      });

      expect(result.status).toBe("ready");
      expect(observedRooms).toEqual([ROOM_ID]);
      expect(borrowedSigningKey?.every((byte) => byte === 0)).toBe(true);
      if (result.status !== "ready") return;
      expect(result).toMatchObject({
        requestId: value.plan.authorizationId,
        recipientGeneration: RECIPIENT_GENERATION,
        expiresAt: value.plan.deadlineAt,
      });
      expect(await withOpenedDomainForegroundAuthorization(value.crypto, {
        authorizationBytes: result.responseBytes,
        now: NOW + 2,
        current: {
          authorizationId: value.plan.authorizationId,
          policyRevision: POLICY_REVISION,
          sessionId: EPISODE_ID,
          roomId: ROOM_ID,
          subjectHumanId: humanId(HUMAN_ID),
          committerDeviceId: cryptoDeviceId(DEVICE_ID),
          committerDeviceSigningGeneration: DEVICE_GENERATION,
          committerDeviceSigningPublicKey: value.signer.publicKey,
          committerDeviceActive: true,
          hostAuthorizationRevision: authorizationRevision(
            HOST_AUTHORIZATION_REVISION,
          ),
          recipientKind: "runtime",
          recipientPrincipalId: "nautilo_task_runtime",
          recipientAuthorizationRevision: authorizationRevision(0),
          recipientRuntimeGeneration: RECIPIENT_GENERATION,
          recipientKeyId: value.plan.recipientKeyId,
          recipientEncryptionPrivateKey: value.recipient.privateKey,
          recipientAuthorized: true,
          domains: [DOMAIN],
        },
        operation: (entries) => entries.length,
      })).toEqual({ status: "opened", value: 1 });
      result.responseBytes.fill(0);
    } finally {
      destroyDomainForegroundAuthorizationPlanV2(value.plan);
      value.requestBytes.fill(0);
      value.signer.privateKey.fill(0);
      value.recipient.privateKey.fill(0);
    }
  });

  test.each([
    ["device generation", DEVICE_GENERATION + 1, POLICY_REVISION,
      "device_authority_changed"],
    ["policy revision", DEVICE_GENERATION, POLICY_REVISION + 1,
      "policy_changed"],
  ] as const)("refuses changed %s after opening exact Domains", async (
    _coordinate,
    deviceGeneration,
    policyRevision,
    reason,
  ) => {
    const value = await fixture();
    const observedRooms: string[] = [];
    try {
      const result = await tryRespondToCurrentTaskRuntimeAuthorizationV1({
        requestBytes: value.requestBytes,
        domainForegroundAuthority: domainAuthority(observedRooms),
        crypto: value.crypto,
        now: () => NOW + 1,
        withCurrentSigningAuthority: async (use) => use({
          issuer: {
            humanId: HUMAN_ID,
            deviceId: DEVICE_ID,
            deviceGeneration,
            serverInstanceId: "10000000-0000-4000-8000-000000000907",
            lineageGeneration: 2,
            epoch: 3,
            securityRevision: HOST_AUTHORIZATION_REVISION,
            headDigest: new Uint8Array(32).fill(0x41),
            signingPublicKeyHash: value.crypto.hash(value.signer.publicKey),
          },
          signingPrivateKey: value.signer.privateKey,
          policyRevision,
          hostAuthorizationRevision:
            LEGACY_PROFILE_HOST_AUTHORIZATION_REVISION,
        }),
      });
      expect(result).toEqual({
        status: "stale",
        reason,
      });
      expect(observedRooms).toEqual([ROOM_ID]);
    } finally {
      destroyDomainForegroundAuthorizationPlanV2(value.plan);
      value.requestBytes.fill(0);
      value.signer.privateKey.fill(0);
      value.recipient.privateKey.fill(0);
    }
  });

  test("refuses a changed MLS security revision even when the legacy profile revision matches the plan", async () => {
    const value = await fixture();
    const observedRooms: string[] = [];
    try {
      const result = await tryRespondToCurrentTaskRuntimeAuthorizationV1({
        requestBytes: value.requestBytes,
        domainForegroundAuthority: domainAuthority(observedRooms),
        crypto: value.crypto,
        now: () => NOW + 1,
        withCurrentSigningAuthority: async (use) => use({
          issuer: {
            humanId: HUMAN_ID,
            deviceId: DEVICE_ID,
            deviceGeneration: DEVICE_GENERATION,
            serverInstanceId: "10000000-0000-4000-8000-000000000907",
            lineageGeneration: 2,
            epoch: 3,
            securityRevision: HOST_AUTHORIZATION_REVISION + 1,
            headDigest: new Uint8Array(32).fill(0x41),
            signingPublicKeyHash: value.crypto.hash(value.signer.publicKey),
          },
          signingPrivateKey: value.signer.privateKey,
          policyRevision: POLICY_REVISION,
          hostAuthorizationRevision: HOST_AUTHORIZATION_REVISION,
        }),
      });
      expect(result).toEqual({
        status: "stale",
        reason: "device_authority_changed",
      });
      expect(observedRooms).toEqual([ROOM_ID]);
    } finally {
      destroyDomainForegroundAuthorizationPlanV2(value.plan);
      value.requestBytes.fill(0);
      value.signer.privateKey.fill(0);
      value.recipient.privateKey.fill(0);
    }
  });

  test("returns a verified V2 Domain grant and ephemeral signer certificate without mutating inputs", async () => {
    const value = await v2Fixture();
    const originalRequest = value.requestBytes.slice();
    const originalSigningKey = value.signer.privateKey.slice();
    let responseBytes: Uint8Array | undefined;
    try {
      const result = await tryRespondToCurrentTaskRuntimeAuthorizationV1({
        requestBytes: value.requestBytes,
        domainForegroundAuthority: domainAuthority([]),
        crypto: value.crypto,
        now: () => NOW + 1,
        withCurrentSigningAuthority: async use => use(
          signingAuthority(value),
        ),
      });
      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;
      responseBytes = result.responseBytes;
      const response = decodeTaskRuntimeBackgroundAuthorizationResponseV2(
        responseBytes,
      );
      try {
        expect(await withOpenedDomainForegroundAuthorization(value.crypto, {
          authorizationBytes: response.authorizationBytes,
          now: NOW + 2,
          current: {
            authorizationId: value.plan.authorizationId,
            policyRevision: POLICY_REVISION,
            sessionId: EPISODE_ID,
            roomId: ROOM_ID,
            subjectHumanId: humanId(HUMAN_ID),
            committerDeviceId: cryptoDeviceId(DEVICE_ID),
            committerDeviceSigningGeneration: DEVICE_GENERATION,
            committerDeviceSigningPublicKey: value.signer.publicKey,
            committerDeviceActive: true,
            hostAuthorizationRevision: authorizationRevision(
              HOST_AUTHORIZATION_REVISION,
            ),
            recipientKind: "runtime",
            recipientPrincipalId: "nautilo_task_runtime",
            recipientAuthorizationRevision: authorizationRevision(0),
            recipientRuntimeGeneration: RECIPIENT_GENERATION,
            recipientKeyId: value.plan.recipientKeyId,
            recipientEncryptionPrivateKey: value.recipient.privateKey,
            recipientAuthorized: true,
            domains: [DOMAIN],
          },
          operation: entries => entries.length,
        })).toEqual({ status: "opened", value: 1 });
        const verified = await verifyCurrentTaskRuntimeSignerAuthorizationV1(
          value.crypto,
          {
            certificateBytes: response.certificateBytes,
            requestBytes: value.requestBytes,
            expectedRequestHash: value.crypto.hash(value.requestBytes),
            expectedAuthorizationHash: value.crypto.hash(
              response.authorizationBytes,
            ),
            now: NOW + 2,
            resolveCurrentIssuer: context => {
              expect(context.issuer).toEqual(signingAuthority(value).issuer);
              return value.signer.publicKey;
            },
          },
        );
        expect(verified.request.signer.signerPublicKey).toEqual(
          value.ephemeral.publicKey,
        );
        destroyVerifiedTaskRuntimeSignerAuthorizationV1(verified);
      } finally {
        response.authorizationBytes.fill(0);
        response.certificateBytes.fill(0);
      }
      expect(value.requestBytes).toEqual(originalRequest);
      expect(value.signer.privateKey).toEqual(originalSigningKey);
    } finally {
      responseBytes?.fill(0);
      originalRequest.fill(0);
      originalSigningKey.fill(0);
      destroyV2Fixture(value);
    }
  });

  test.each([
    ["human", { humanId: "foreign-human" }],
    ["device", { deviceId: "foreign-device" }],
    ["generation", { deviceGeneration: DEVICE_GENERATION + 1 }],
    ["server", { serverInstanceId: "90000000-0000-4000-8000-000000000907" }],
    ["lineage", { lineageGeneration: 3 }],
    ["epoch", { epoch: 4 }],
    ["security revision", { securityRevision: HOST_AUTHORIZATION_REVISION + 1 }],
    ["head", { headDigest: new Uint8Array(32).fill(0x42) }],
    ["signing key", { signingPublicKeyHash: new Uint8Array(32).fill(0x43) }],
  ] as const)("rejects a V2 %s issuer-coordinate change", async (
    _coordinate,
    changed,
  ) => {
    const value = await v2Fixture();
    try {
      const result = await tryRespondToCurrentTaskRuntimeAuthorizationV1({
        requestBytes: value.requestBytes,
        domainForegroundAuthority: domainAuthority([]),
        crypto: value.crypto,
        now: () => NOW + 1,
        withCurrentSigningAuthority: async use => use(
          signingAuthority(value, changed),
        ),
      });
      expect(result).toEqual({
        status: "stale",
        reason: "device_authority_changed",
      });
    } finally {
      destroyV2Fixture(value);
    }
  });

  test("fails closed for malformed V2 scope, expiry, cancellation, and repeated signing callbacks", async () => {
    const value = await v2Fixture();
    try {
      const malformed = value.requestBytes.slice();
      const domainBytes = encoder.encode(DOMAIN.domainId);
      const offset = malformed.findIndex((_, index) => domainBytes.every(
        (byte, byteIndex) => malformed[index + byteIndex] === byte,
      ));
      expect(offset).toBeGreaterThan(0);
      malformed[offset] = malformed[offset]! ^ 1;
      let authorityCalls = 0;
      const malformedResult = await tryRespondToCurrentTaskRuntimeAuthorizationV1({
        requestBytes: malformed,
        domainForegroundAuthority: domainAuthority([]),
        crypto: value.crypto,
        now: () => NOW + 1,
        withCurrentSigningAuthority: () => {
          authorityCalls += 1;
          return Promise.reject(new Error("must not open"));
        },
      });
      expect(malformedResult).toEqual({
        status: "unavailable",
        reason: "invalid_descriptor",
      });
      expect(authorityCalls).toBe(0);
      malformed.fill(0);

      const expired = await tryRespondToCurrentTaskRuntimeAuthorizationV1({
        requestBytes: value.requestBytes,
        domainForegroundAuthority: domainAuthority([]),
        crypto: value.crypto,
        now: () => value.plan.deadlineAt,
        withCurrentSigningAuthority: () => Promise.reject(
          new Error("must not open"),
        ),
      });
      expect(expired).toEqual({ status: "stale", reason: "expired" });

      const controller = new AbortController();
      controller.abort(new DOMException("cancelled", "AbortError"));
      expect(() => tryRespondToCurrentTaskRuntimeAuthorizationV1({
        requestBytes: value.requestBytes,
        signal: controller.signal,
        domainForegroundAuthority: domainAuthority([]),
        crypto: value.crypto,
        now: () => NOW + 1,
        withCurrentSigningAuthority: () => Promise.reject(
          new Error("must not open"),
        ),
      })).toThrow(expect.objectContaining({ name: "AbortError" }));

      const repeated = await tryRespondToCurrentTaskRuntimeAuthorizationV1({
        requestBytes: value.requestBytes,
        domainForegroundAuthority: domainAuthority([]),
        crypto: value.crypto,
        now: () => NOW + 1,
        withCurrentSigningAuthority: async use => {
          const authority = signingAuthority(value);
          await Promise.resolve(use(authority));
          return Promise.resolve(use(authority));
        },
      });
      expect(repeated).toEqual({
        status: "unavailable",
        reason: "signing_authority_unavailable",
      });
    } finally {
      destroyV2Fixture(value);
    }
  });

  test("leaves non-Task carriers for the existing processor responder", async () => {
    let authorityOpened = false;
    const processorCarrier = Uint8Array.of(1, 2, 3);
    const originalCarrier = processorCarrier.slice();
    const result = await tryRespondToCurrentTaskRuntimeAuthorizationV1({
      requestBytes: processorCarrier,
      domainForegroundAuthority: {
        ...domainAuthority([]),
        withOpenedAuthorizationDomains: () => {
          authorityOpened = true;
          return Promise.reject(new Error("must not open"));
        },
      },
      crypto: new LatticeCrypto(seededRng(907_408)),
      now: () => NOW,
      withCurrentSigningAuthority: () => Promise.reject(
        new Error("must not open"),
      ),
    });
    expect(result).toEqual({ status: "not_task_runtime" });
    expect(processorCarrier).toEqual(originalCarrier);
    expect(authorityOpened).toBe(false);
  });
});
