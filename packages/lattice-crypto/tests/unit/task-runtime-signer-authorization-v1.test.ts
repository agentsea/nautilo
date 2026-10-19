import { describe, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";

import { agentRuntimeObjectSignerKeyIdV1 } from
  "../../src/agent-runtime/object-signer-v1.ts";
import { createTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1 } from
  "../../src/background/task-runtime-request-v1.ts";
import { createTaskRuntimeBackgroundAuthorizationRequestV2,
  destroyTaskRuntimeBackgroundAuthorizationRequestV2,
  encodeTaskRuntimeBackgroundAuthorizationRequestV2 } from
  "../../src/background/task-runtime-request-v2.ts";
import {
  MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
  MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_PROJECTION_WIRE_BYTES_V1,
  MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_WIRE_BYTES_V1,
  createTaskRuntimeSignerAuthorizationV1,
  decodeTaskRuntimeBackgroundAuthorizationResponseV2,
  destroyVerifiedTaskRuntimeSignerAuthorizationV1,
  encodeTaskRuntimeBackgroundAuthorizationResponseV2,
  readTaskRuntimeSignerAuthorizationIssuerV1,
  verifyCurrentTaskRuntimeSignerAuthorizationV1,
  verifyHistoricalTaskRuntimeSignerAuthorizationV1,
} from "../../src/background/task-runtime-signer-authorization-v1.ts";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  createDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationV2,
  mintDomainForegroundAuthorizationV2,
  serializeDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationV2,
} from "../../src/format/domain-foreground-authorization-v2.ts";
import { authorizationRevision, cryptoDeviceId, humanId } from
  "../../src/v2-types/ids.ts";

const NOW = 1_800_900_000_000;
const TASK = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

async function fixture(seed = 808_201, executionSegment = 1, deterministicGrant = false) {
  const crypto = new LatticeCrypto(seededRng(seed), { now: () => NOW });
  // Pin only the opaque HPKE envelope for byte-compatibility assertions.
  // The other tests keep real recipient encryption and signature verification.
  if (deterministicGrant) crypto.sealTo = async () => new Uint8Array(128).fill(0xa5);
  const device = crypto.generateSigningKeyPair();
  const recipient = await crypto.deriveEncryptionKeyPair(bytes(0x41));
  const ephemeral = crypto.generateSigningKeyPair();
  const domain = {
    domainId: "domain:task", sourceNamespaceId: "namespace:task",
    participantDigest: bytes(0x11), participantCount: 2, keyClass: "ai" as const,
    domainKeyGeneration: 5, authorizationRevision: authorizationRevision(7),
    headDigest: bytes(0x12), activeNamespaceBindingSetDigest: bytes(0x13),
    activeNamespaceBindingCount: 1,
  };
  const plan = createDomainForegroundAuthorizationPlanV2(crypto, {
    authorizationId: "request:task", policyRevision: 9,
    sessionId: "episode:task", roomId: "room:task",
    subjectHumanId: humanId("human:task"),
    committerDeviceId: cryptoDeviceId("device:task"),
    committerDeviceSigningGeneration: 4,
    hostAuthorizationRevision: authorizationRevision(6),
    recipientKind: "runtime", recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 14, recipientKeyId: "recipient:task",
    operations: ["decrypt", "encrypt"], issuedAt: NOW,
    deadlineAt: NOW + 60_000, maximumSecretBytes: 2_048, domains: [domain],
  });
  const baseRequest = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: "request:task", workId: RUN,
    workKind: "task.execute", workPurpose: "task.execute",
    recipientGeneration: 14, episodeId: "episode:task", sourceRoomId: "room:task",
    recipientKeyId: "recipient:task", recipientPublicKey: recipient.publicKey,
    authorizationPlan: plan, issuedAt: NOW, deadlineAt: NOW + 60_000,
  });
  const resultObjectId = `task-run-result:v1:${bytesToHex(crypto.hash(
    new TextEncoder().encode(
      `nautilo/task-run-result-crypto-object/v1\n${TASK}\n${RUN}\n1`,
    ),
  ))}`;
  const request = createTaskRuntimeBackgroundAuthorizationRequestV2(crypto, {
    baseRequest,
    work: { taskId: TASK, taskRunId: RUN,
      inputObjectId: `task-definition:v1:${"b".repeat(64)}`,
      resultObjectId, executionSegment, workIdentityHash: bytes(0x21) },
    signer: { agentId: "agent:task", runtimeGeneration: 0,
      signerKeyId: agentRuntimeObjectSignerKeyIdV1(crypto, ephemeral.publicKey),
      signerPublicKey: ephemeral.publicKey },
    deviceGroupHead: { serverInstanceId: "server:task", lineageGeneration: 3,
      epoch: 10, headDigest: bytes(0x22),
      signingPublicKeyHash: crypto.hash(device.publicKey) },
    namespaceRequirements: [{ ordinal: 0, namespaceId: "namespace:task",
      domainId: "domain:task", operations: ["decrypt", "encrypt"],
      expectedAccessRevision: 8, expectedPolicyRevision: 9 }],
  });
  const authorization = await mintDomainForegroundAuthorizationV2(crypto, {
    plan,
    domains: [{ ...domain, domainKey: bytes(0x31) }],
    committerDeviceSigningPrivateKey: device.privateKey,
    recipientEncryptionPublicKey: recipient.publicKey,
  });
  const requestBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV2(
    crypto, request,
  );
  const authorizationBytes = serializeDomainForegroundAuthorizationV2(
    authorization,
  );
  const planBytes = serializeDomainForegroundAuthorizationPlanV2(plan);
  const authorizationHash = crypto.hash(authorizationBytes);
  const certificateBytes = createTaskRuntimeSignerAuthorizationV1(crypto, {
    requestBytes, authorizationBytes, expectedAuthorizationPlanBytes: planBytes,
    expectedAuthorizationHash: authorizationHash,
    issuerSigningPrivateKey: device.privateKey,
  });
  recipient.privateKey.fill(0); recipient.publicKey.fill(0);
  return { crypto, device, ephemeral, plan, baseRequest, request, authorization,
    requestBytes, authorizationBytes, planBytes, authorizationHash,
    certificateBytes };
}

function cleanup(f: Awaited<ReturnType<typeof fixture>>): void {
  destroyTaskRuntimeBackgroundAuthorizationRequestV2(f.request);
  destroyTaskRuntimeBackgroundAuthorizationRequestV1(f.baseRequest);
  destroyDomainForegroundAuthorizationV2(f.authorization);
  destroyDomainForegroundAuthorizationPlanV2(f.plan);
  f.requestBytes.fill(0); f.authorizationBytes.fill(0); f.planBytes.fill(0);
  f.authorizationHash.fill(0); f.certificateBytes.fill(0);
  f.device.privateKey.fill(0); f.device.publicKey.fill(0);
  f.ephemeral.privateKey.fill(0); f.ephemeral.publicKey.fill(0);
}

describe("Task Runtime signer authorization v1", () => {
  test("preserves execution certificate and response wire bytes", async () => {
    const f = await fixture(808_201, 1, true);
    const responseBytes = encodeTaskRuntimeBackgroundAuthorizationResponseV2({
      authorizationBytes: f.authorizationBytes,
      certificateBytes: f.certificateBytes,
    });
    try {
      expect(bytesToHex(f.crypto.hash(f.certificateBytes)))
        .toBe("35c2fbf35521813208ca75ac9a6c2bbaf8de52204cfff11da58240674063b27b");
      expect(bytesToHex(f.crypto.hash(responseBytes)))
        .toBe("e96d257fa9102c111d2ca26c29a4bf4ffee23d0d35d7967b3670db2cf915bde6");
    } finally {
      responseBytes.fill(0);
      cleanup(f);
    }
  });

  test("reads a detached untrusted issuer hint and rejects malformed certificates", async () => {
    const f = await fixture();
    const original = f.certificateBytes.slice();
    try {
      const issuer = readTaskRuntimeSignerAuthorizationIssuerV1(
        f.crypto,
        f.certificateBytes,
      );
      expect(issuer).toEqual({
        humanId: "human:task",
        deviceId: "device:task",
        deviceGeneration: 4,
        serverInstanceId: "server:task",
        lineageGeneration: 3,
        epoch: 10,
        securityRevision: 6,
        headDigest: bytes(0x22),
        signingPublicKeyHash: f.crypto.hash(f.device.publicKey),
      });
      issuer.headDigest.fill(0);
      issuer.signingPublicKeyHash.fill(0);
      expect(f.certificateBytes).toEqual(original);
      const freshIssuer = readTaskRuntimeSignerAuthorizationIssuerV1(
        f.crypto,
        f.certificateBytes,
      );
      expect(freshIssuer.headDigest).toEqual(bytes(0x22));
      freshIssuer.headDigest.fill(0);
      freshIssuer.signingPublicKeyHash.fill(0);

      const malformed = f.certificateBytes.slice();
      malformed[0] = malformed[0]! ^ 1;
      expect(() => readTaskRuntimeSignerAuthorizationIssuerV1(
        f.crypto,
        malformed,
      )).toThrow();
      expect(() => readTaskRuntimeSignerAuthorizationIssuerV1(
        f.crypto,
        new Uint8Array(MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_WIRE_BYTES_V1 + 1),
      )).toThrow();
      malformed.fill(0);
    } finally {
      original.fill(0);
      cleanup(f);
    }
  });

  test("verifies current authority and retained history after expiry", async () => {
    const f = await fixture();
    try {
      const current = await verifyCurrentTaskRuntimeSignerAuthorizationV1(
        f.crypto, {
          certificateBytes: f.certificateBytes,
          requestBytes: f.requestBytes,
          expectedRequestHash: f.crypto.hash(f.requestBytes),
          expectedAuthorizationHash: f.authorizationHash,
          now: NOW + 1,
          resolveCurrentIssuer: context => {
            expect(context.issuer.headDigest).toEqual(bytes(0x22));
            expect(context.projection.work.taskRunId).toBe(RUN);
            return f.device.publicKey;
          },
        },
      );
      expect(current.request.signer.signerPublicKey).toEqual(f.ephemeral.publicKey);
      destroyVerifiedTaskRuntimeSignerAuthorizationV1(current);

      const historical = verifyHistoricalTaskRuntimeSignerAuthorizationV1(
        f.crypto, { certificateBytes: f.certificateBytes,
          resolveHistoricalIssuer: context => {
            expect(context.projection.request.deadlineAt).toBeLessThan(NOW + 120_000);
            return f.device.publicKey;
          } },
      );
      expect(historical.projection.request.authorizationHash)
        .toEqual(f.authorizationHash);
      destroyVerifiedTaskRuntimeSignerAuthorizationV1(historical);

      expect(verifyCurrentTaskRuntimeSignerAuthorizationV1(f.crypto, {
        certificateBytes: f.certificateBytes,
        requestBytes: f.requestBytes,
        expectedRequestHash: f.crypto.hash(f.requestBytes),
        expectedAuthorizationHash: f.authorizationHash,
        now: NOW + 60_000, resolveCurrentIssuer: () => f.device.publicKey,
      })).rejects.toMatchObject({ code: "expired" });
    } finally { cleanup(f); }
  });

  test("authenticates execution segment two for current and historical readers", async () => {
    const f = await fixture(808_204, 2);
    try {
      const current = await verifyCurrentTaskRuntimeSignerAuthorizationV1(
        f.crypto,
        {
          certificateBytes: f.certificateBytes,
          requestBytes: f.requestBytes,
          expectedRequestHash: f.crypto.hash(f.requestBytes),
          expectedAuthorizationHash: f.authorizationHash,
          now: NOW + 1,
          resolveCurrentIssuer: context => {
            expect(context.projection.work.executionSegment).toBe(2);
            return f.device.publicKey;
          },
        },
      );
      expect(current.request.work.executionSegment).toBe(2);
      expect(current.projection.work.executionSegment).toBe(2);
      destroyVerifiedTaskRuntimeSignerAuthorizationV1(current);

      const historical = verifyHistoricalTaskRuntimeSignerAuthorizationV1(
        f.crypto,
        {
          certificateBytes: f.certificateBytes,
          resolveHistoricalIssuer: context => {
            expect(context.projection.work.executionSegment).toBe(2);
            return f.device.publicKey;
          },
        },
      );
      expect(historical.projection.work.executionSegment).toBe(2);
      destroyVerifiedTaskRuntimeSignerAuthorizationV1(historical);
    } finally {
      cleanup(f);
    }
  });

  test("rejects request, grant, issuer, key, and wrapper substitution", async () => {
    const f = await fixture();
    try {
      const wrong = bytes(0x99);
      for (const change of [
        { request: wrong, authorization: f.authorizationHash },
        { request: f.crypto.hash(f.requestBytes), authorization: wrong },
      ]) {
        expect(verifyCurrentTaskRuntimeSignerAuthorizationV1(f.crypto, {
          certificateBytes: f.certificateBytes,
          requestBytes: f.requestBytes,
          expectedRequestHash: change.request,
          expectedAuthorizationHash: change.authorization,
          now: NOW + 1, resolveCurrentIssuer: () => f.device.publicKey,
        })).rejects.toMatchObject({ code: "invalid" });
      }
      const foreign = f.crypto.generateSigningKeyPair();
      expect(() => verifyHistoricalTaskRuntimeSignerAuthorizationV1(f.crypto, {
        certificateBytes: f.certificateBytes,
        resolveHistoricalIssuer: () => foreign.publicKey,
      })).toThrow();
      expect(() => verifyHistoricalTaskRuntimeSignerAuthorizationV1(f.crypto, {
        certificateBytes: f.certificateBytes,
        resolveHistoricalIssuer: () => null,
      })).toThrow();
      expect(verifyCurrentTaskRuntimeSignerAuthorizationV1(f.crypto, {
        certificateBytes: f.certificateBytes,
        requestBytes: f.requestBytes,
        expectedRequestHash: f.crypto.hash(f.requestBytes),
        expectedAuthorizationHash: f.authorizationHash,
        now: NOW + 1, resolveCurrentIssuer: () => null,
      })).rejects.toMatchObject({ code: "authority_unavailable" });
      const changed = f.certificateBytes.slice();
      changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
      expect(() => verifyHistoricalTaskRuntimeSignerAuthorizationV1(f.crypto, {
        certificateBytes: changed,
        resolveHistoricalIssuer: () => f.device.publicKey,
      })).toThrow();
      const other = await fixture(808_202);
      try {
        expect(verifyCurrentTaskRuntimeSignerAuthorizationV1(f.crypto, {
          certificateBytes: f.certificateBytes,
          requestBytes: other.requestBytes,
          expectedAuthorizationHash: f.authorizationHash,
          now: NOW + 1,
          resolveCurrentIssuer: () => f.device.publicKey,
        })).rejects.toMatchObject({ code: "invalid" });
        const response = encodeTaskRuntimeBackgroundAuthorizationResponseV2({
          authorizationBytes: other.authorizationBytes,
          certificateBytes: f.certificateBytes,
        });
        const decoded = decodeTaskRuntimeBackgroundAuthorizationResponseV2(response);
        expect(verifyCurrentTaskRuntimeSignerAuthorizationV1(f.crypto, {
          certificateBytes: decoded.certificateBytes,
          requestBytes: f.requestBytes,
          expectedRequestHash: f.crypto.hash(f.requestBytes),
          expectedAuthorizationHash: f.crypto.hash(decoded.authorizationBytes),
          now: NOW + 1, resolveCurrentIssuer: () => f.device.publicKey,
        })).rejects.toMatchObject({ code: "invalid" });
        decoded.authorizationBytes.fill(0); decoded.certificateBytes.fill(0);
      } finally { cleanup(other); }
      wrong.fill(0); foreign.privateKey.fill(0); foreign.publicKey.fill(0);
    } finally { cleanup(f); }
  });

  test("keeps the compact projection below the proof envelope and authenticates every byte", async () => {
    const f = await fixture();
    try {
      expect(MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_PROJECTION_WIRE_BYTES_V1)
        .toBeLessThan(4_096);
      expect(MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_WIRE_BYTES_V1)
        .toBeLessThan(4_096);
      expect(f.certificateBytes.length).toBeLessThan(4_096);
      for (let index = 0; index < f.certificateBytes.length; index += 1) {
        const changed = f.certificateBytes.slice();
        changed[index] = changed[index]! ^ 1;
        expect(() => verifyHistoricalTaskRuntimeSignerAuthorizationV1(
          f.crypto,
          {
            certificateBytes: changed,
            resolveHistoricalIssuer: () => f.device.publicKey,
          },
        )).toThrow();
        changed.fill(0);
      }
    } finally { cleanup(f); }
  });

  test("response codec is strict, bounded, canonical, and crypto-independent", async () => {
    const f = await fixture();
    try {
      const encoded = encodeTaskRuntimeBackgroundAuthorizationResponseV2({
        authorizationBytes: f.authorizationBytes,
        certificateBytes: f.certificateBytes,
      });
      const decoded = decodeTaskRuntimeBackgroundAuthorizationResponseV2(encoded);
      expect(decoded.authorizationBytes).toEqual(f.authorizationBytes);
      expect(decoded.certificateBytes).toEqual(f.certificateBytes);
      expect(encodeTaskRuntimeBackgroundAuthorizationResponseV2(decoded)).toEqual(encoded);
      decoded.authorizationBytes.fill(0); decoded.certificateBytes.fill(0);
      expect(() => decodeTaskRuntimeBackgroundAuthorizationResponseV2(
        Uint8Array.from([...encoded, 0]),
      )).toThrow();
      const badVersion = encoded.slice();
      const domainFrameBytes = 4 + new TextEncoder().encode(
        "nautilo/lattice-crypto/task-runtime-background-authorization-response/v2",
      ).length;
      badVersion[domainFrameBytes + 3] = 3;
      expect(() => decodeTaskRuntimeBackgroundAuthorizationResponseV2(
        badVersion,
      )).toThrow();
      expect(() => encodeTaskRuntimeBackgroundAuthorizationResponseV2({
        authorizationBytes: f.authorizationBytes,
        certificateBytes: f.certificateBytes,
        extra: true,
      } as unknown as Readonly<{
        authorizationBytes: Uint8Array; certificateBytes: Uint8Array;
      }>)).toThrow();
      const certificateVersion = f.certificateBytes.slice();
      const certificateDomainFrameBytes = 4 + new TextEncoder().encode(
        "nautilo/lattice-crypto/task-runtime-signer-authorization/v1",
      ).length;
      certificateVersion[certificateDomainFrameBytes + 3] = 2;
      expect(() => verifyHistoricalTaskRuntimeSignerAuthorizationV1(f.crypto, {
        certificateBytes: certificateVersion,
        resolveHistoricalIssuer: () => f.device.publicKey,
      })).toThrow();
      expect(() => decodeTaskRuntimeBackgroundAuthorizationResponseV2(
        new Uint8Array(
          MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2 + 1,
        ),
      )).toThrow();
      expect(() => verifyHistoricalTaskRuntimeSignerAuthorizationV1(f.crypto, {
        certificateBytes: new Uint8Array(
          MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_WIRE_BYTES_V1 + 1,
        ),
        resolveHistoricalIssuer: () => f.device.publicKey,
      })).toThrow();
    } finally { cleanup(f); }
  });

  test("mint rejects a mismatched grant plan, grant hash, and issuer key", async () => {
    const f = await fixture();
    try {
      expect(() => createTaskRuntimeSignerAuthorizationV1(f.crypto, {
        requestBytes: f.requestBytes, authorizationBytes: f.authorizationBytes,
        expectedAuthorizationPlanBytes: f.planBytes,
        expectedAuthorizationHash: bytes(0x72),
        issuerSigningPrivateKey: f.device.privateKey,
      })).toThrow();
      const other = await fixture(808_203);
      try {
        expect(() => createTaskRuntimeSignerAuthorizationV1(f.crypto, {
          requestBytes: f.requestBytes, authorizationBytes: other.authorizationBytes,
          expectedAuthorizationPlanBytes: f.planBytes,
          expectedAuthorizationHash: f.crypto.hash(other.authorizationBytes),
          issuerSigningPrivateKey: f.device.privateKey,
        })).toThrow();
        expect(() => createTaskRuntimeSignerAuthorizationV1(f.crypto, {
          requestBytes: f.requestBytes, authorizationBytes: f.authorizationBytes,
          expectedAuthorizationPlanBytes: f.planBytes,
          expectedAuthorizationHash: f.authorizationHash,
          issuerSigningPrivateKey: other.device.privateKey,
        })).toThrow();
      } finally { cleanup(other); }
    } finally { cleanup(f); }
  });
});
