import { describe, expect, test } from "bun:test";

import { agentRuntimeObjectSignerKeyIdV1 } from
  "../../src/agent-runtime/object-signer-v1.ts";
import { createTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1 } from
  "../../src/background/task-runtime-request-v1.ts";
import { createTaskRuntimeBackgroundAuthorizationRequestV3,
  destroyTaskRuntimeBackgroundAuthorizationRequestV3,
  encodeTaskRuntimeBackgroundAuthorizationRequestV3 } from
  "../../src/background/task-runtime-request-v3.ts";
import {
  MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_PROJECTION_WIRE_BYTES_V2,
  MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_WIRE_BYTES_V2,
  MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_WIRE_BYTES_V1,
  createTaskRuntimeSignerAuthorizationV1,
  createTaskRuntimeSignerAuthorizationV2,
  decodeTaskRuntimeBackgroundAuthorizationResponseV2,
  destroyVerifiedTaskRuntimeSignerAuthorization,
  encodeTaskRuntimeBackgroundAuthorizationResponseV2,
  readTaskRuntimeSignerAuthorizationIssuer,
  readTaskRuntimeSignerAuthorizationIssuerV1,
  verifyCurrentTaskRuntimeSignerAuthorization,
  verifyCurrentTaskRuntimeSignerAuthorizationV1,
  verifyHistoricalTaskRuntimeSignerAuthorization,
  verifyHistoricalTaskRuntimeSignerAuthorizationV1,
} from "../../src/background/task-runtime-signer-authorization-v1.ts";
import type { TaskRuntimePublicationWorkBindingV3 } from "../../src/background/task-runtime-request-v3.ts";
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
const JOB = "55555555-5555-4555-8555-555555555555";
const MESSAGE = `message:v2:${"a".repeat(64)}`;

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

async function fixture(kind: TaskRuntimePublicationWorkBindingV3["kind"] = "task.cancel_result", revision: 1 | 2 = kind === "task.deliver_result" ? 1 : 2) {
  const crypto = new LatticeCrypto(seededRng(808_202), { now: () => NOW });
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
  const operations = kind === "task.cancel_result" || kind === "task.deliver_message"
    ? ["encrypt"] as const : ["decrypt", "encrypt"] as const;
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
    operations, issuedAt: NOW,
    deadlineAt: NOW + 60_000, maximumSecretBytes: 2_048, domains: [domain],
  });
  const baseRequest = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: "request:task", workId: kind === "task.delivery_wake" ? JOB : RUN,
    workKind: kind, workPurpose: kind,
    recipientGeneration: 14, episodeId: "episode:task", sourceRoomId: "room:task",
    recipientKeyId: "recipient:task", recipientPublicKey: recipient.publicKey,
    authorizationPlan: plan, issuedAt: NOW, deadlineAt: NOW + 60_000,
  });
  const commonWork = { taskId: TASK, taskRunId: RUN, workIdentityHash: bytes(0x21) };
  const work: TaskRuntimePublicationWorkBindingV3 = kind === "task.cancel_result"
    ? { ...commonWork, kind, contentRevision: 2 }
    : kind === "task.deliver_result" ? { ...commonWork, kind, contentRevision: 1 }
    : kind === "task.deliver_message" ? { ...commonWork, kind, contentRevision: 2, messageObjectId: MESSAGE }
    : { ...commonWork, kind, contentRevision: revision, jobId: JOB };
  const request = createTaskRuntimeBackgroundAuthorizationRequestV3(crypto, {
    baseRequest, work,
    signer: { agentId: "agent:task", runtimeGeneration: 0,
      signerKeyId: agentRuntimeObjectSignerKeyIdV1(crypto, ephemeral.publicKey),
      signerPublicKey: ephemeral.publicKey },
    deviceGroupHead: { serverInstanceId: "server:task", lineageGeneration: 3,
      epoch: 10, headDigest: bytes(0x22),
      signingPublicKeyHash: crypto.hash(device.publicKey) },
    namespaceRequirements: [{ ordinal: 0, namespaceId: "namespace:task",
      domainId: "domain:task", operations,
      expectedAccessRevision: 8, expectedPolicyRevision: 9 }],
  });
  const authorization = await mintDomainForegroundAuthorizationV2(crypto, {
    plan,
    domains: [{ ...domain, domainKey: bytes(0x31) }],
    committerDeviceSigningPrivateKey: device.privateKey,
    recipientEncryptionPublicKey: recipient.publicKey,
  });
  const requestBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV3(
    crypto, request,
  );
  const authorizationBytes = serializeDomainForegroundAuthorizationV2(
    authorization,
  );
  const planBytes = serializeDomainForegroundAuthorizationPlanV2(plan);
  const authorizationHash = crypto.hash(authorizationBytes);
  const certificateBytes = createTaskRuntimeSignerAuthorizationV2(crypto, {
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
  destroyTaskRuntimeBackgroundAuthorizationRequestV3(f.request);
  destroyTaskRuntimeBackgroundAuthorizationRequestV1(f.baseRequest);
  destroyDomainForegroundAuthorizationV2(f.authorization);
  destroyDomainForegroundAuthorizationPlanV2(f.plan);
  f.requestBytes.fill(0); f.authorizationBytes.fill(0); f.planBytes.fill(0);
  f.authorizationHash.fill(0); f.certificateBytes.fill(0);
  f.device.privateKey.fill(0); f.device.publicKey.fill(0);
  f.ephemeral.privateKey.fill(0); f.ephemeral.publicKey.fill(0);
}


async function rejects(promise: Promise<unknown>, message?: string): Promise<void> {
  let failure: unknown;
  try { await promise; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  if (message !== undefined) expect((failure as Error).message).toContain(message);
}

describe("publication Task Runtime signer authorization", () => {
  for (const kind of ["task.cancel_result", "task.deliver_message", "task.deliver_result", "task.delivery_wake"] as const) {
    test(`${kind}: authenticates exact current work and retained historical proof`, async () => {
      const f = await fixture(kind);
      try {
        const current = await verifyCurrentTaskRuntimeSignerAuthorization(f.crypto, {
          certificateBytes: f.certificateBytes, requestBytes: f.requestBytes,
          expectedRequestHash: f.crypto.hash(f.requestBytes), expectedAuthorizationHash: f.authorizationHash,
          now: NOW + 1, resolveCurrentIssuer: context => {
            expect(context.projection.formatVersion).toBe(2);
            expect(context.projection.work).toEqual(f.request.work);
            // Resolver receives detached copies; changing its context cannot mutate verified facts.
            context.projection.work.workIdentityHash.fill(0);
            return f.device.publicKey;
          },
        });
        expect(current.request).toEqual(f.request);
        expect(current.projection.work).toEqual(f.request.work);
        expect(current.certificate.formatVersion).toBe(2);
        destroyVerifiedTaskRuntimeSignerAuthorization(current);
        const historical = verifyHistoricalTaskRuntimeSignerAuthorization(f.crypto, {
          certificateBytes: f.certificateBytes,
          resolveHistoricalIssuer: () => f.device.publicKey,
        });
        expect(historical.projection.work).toEqual(f.request.work);
        destroyVerifiedTaskRuntimeSignerAuthorization(historical);
        const hint = readTaskRuntimeSignerAuthorizationIssuer(f.crypto, f.certificateBytes);
        expect(hint.deviceId).toBe("device:task");
        hint.headDigest.fill(0); hint.signingPublicKeyHash.fill(0);
        const responseBytes = encodeTaskRuntimeBackgroundAuthorizationResponseV2({
          authorizationBytes: f.authorizationBytes, certificateBytes: f.certificateBytes,
        });
        const response = decodeTaskRuntimeBackgroundAuthorizationResponseV2(responseBytes);
        expect(response.certificateBytes).toEqual(f.certificateBytes);
        response.authorizationBytes.fill(0); response.certificateBytes.fill(0); responseBytes.fill(0);
        expect(f.certificateBytes.length).toBeLessThanOrEqual(MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_WIRE_BYTES_V2);
      } finally { cleanup(f); }
    });
  }
  test("locks the derived publication maxima below the unchanged envelope", () => {
    expect(MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_PROJECTION_WIRE_BYTES_V2).toBe(1735);
    expect(MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_WIRE_BYTES_V2).toBe(1911);
    expect(MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_WIRE_BYTES_V1).toBe(2039);
  });
  test("strict execution entry points never accept a publication proof", async () => {
    const f = await fixture();
    try {
      expect(() => createTaskRuntimeSignerAuthorizationV1(f.crypto, {
        requestBytes: f.requestBytes, authorizationBytes: f.authorizationBytes,
        expectedAuthorizationPlanBytes: f.planBytes, expectedAuthorizationHash: f.authorizationHash,
        issuerSigningPrivateKey: f.device.privateKey,
      })).toThrow();
      expect(() => readTaskRuntimeSignerAuthorizationIssuerV1(f.crypto, f.certificateBytes)).toThrow();
      expect(() => verifyHistoricalTaskRuntimeSignerAuthorizationV1(f.crypto, {
        certificateBytes: f.certificateBytes, resolveHistoricalIssuer: () => f.device.publicKey,
      })).toThrow();
      await rejects(verifyCurrentTaskRuntimeSignerAuthorizationV1(f.crypto, {
        certificateBytes: f.certificateBytes, requestBytes: f.requestBytes,
        expectedAuthorizationHash: f.authorizationHash, now: NOW + 1,
        resolveCurrentIssuer: () => f.device.publicKey,
      }));
    } finally { cleanup(f); }
  });
  test("rejects signed purpose/source-revision/output/job and full request/grant substitution", async () => {
    const original = await fixture("task.delivery_wake", 1);
    const changed = await fixture("task.delivery_wake", 2);
    const terminal = await fixture("task.deliver_message");
    const raw = await fixture("task.deliver_result");
    try {
      for (const replacement of [changed, terminal, raw]) {
        let calls = 0;
        await rejects(verifyCurrentTaskRuntimeSignerAuthorization(original.crypto, {
          certificateBytes: original.certificateBytes, requestBytes: replacement.requestBytes,
          expectedAuthorizationHash: replacement.authorizationHash, now: NOW + 1,
          resolveCurrentIssuer: () => { calls++; return original.device.publicKey; },
        }));
        expect(calls).toBe(0);
      }
      for (const [name, value] of [["jobId", "66666666-6666-4666-8666-666666666666"], ["workIdentityHash", bytes(0x44)]] as const) {
        const modified = createTaskRuntimeBackgroundAuthorizationRequestV3(original.crypto, {
          ...original.request, work: { ...original.request.work, [name]: value } as TaskRuntimePublicationWorkBindingV3,
          ...(name === "jobId" ? { baseRequest: { ...original.request.baseRequest, workId: value as string } } : {}),
        });
        const encoded = encodeTaskRuntimeBackgroundAuthorizationRequestV3(original.crypto, modified);
        await rejects(verifyCurrentTaskRuntimeSignerAuthorization(original.crypto, {
          certificateBytes: original.certificateBytes, requestBytes: encoded,
          expectedAuthorizationHash: original.authorizationHash, now: NOW + 1,
          resolveCurrentIssuer: () => original.device.publicKey,
        }));
        encoded.fill(0); destroyTaskRuntimeBackgroundAuthorizationRequestV3(modified);
      }
      const modifiedMessage = createTaskRuntimeBackgroundAuthorizationRequestV3(terminal.crypto, {
        ...terminal.request,
        work: { ...terminal.request.work, kind: "task.deliver_message", contentRevision: 2, messageObjectId: `message:v2:${"b".repeat(64)}` },
      });
      const encoded = encodeTaskRuntimeBackgroundAuthorizationRequestV3(terminal.crypto, modifiedMessage);
      await rejects(verifyCurrentTaskRuntimeSignerAuthorization(terminal.crypto, {
        certificateBytes: terminal.certificateBytes, requestBytes: encoded,
        expectedAuthorizationHash: terminal.authorizationHash, now: NOW + 1,
        resolveCurrentIssuer: () => terminal.device.publicKey,
      }));
      encoded.fill(0); destroyTaskRuntimeBackgroundAuthorizationRequestV3(modifiedMessage);
      await rejects(verifyCurrentTaskRuntimeSignerAuthorization(original.crypto, {
        certificateBytes: original.certificateBytes, requestBytes: original.requestBytes,
        expectedAuthorizationHash: bytes(0x45), now: NOW + 1,
        resolveCurrentIssuer: () => original.device.publicKey,
      }));
    } finally { [original, changed, terminal, raw].forEach(cleanup); }
  });
  test("expiry and current revocation deny use while retained public proof stays readable", async () => {
    const f = await fixture();
    try {
      for (const now of [NOW - 1, NOW + 60_000]) {
        await rejects(verifyCurrentTaskRuntimeSignerAuthorization(f.crypto, {
          certificateBytes: f.certificateBytes, requestBytes: f.requestBytes,
          expectedAuthorizationHash: f.authorizationHash, now,
          resolveCurrentIssuer: () => f.device.publicKey,
        }), "expired");
      }
      await rejects(verifyCurrentTaskRuntimeSignerAuthorization(f.crypto, {
        certificateBytes: f.certificateBytes, requestBytes: f.requestBytes,
        expectedAuthorizationHash: f.authorizationHash, now: NOW + 1,
        resolveCurrentIssuer: () => null,
      }), "authority_unavailable");
      const verified = verifyHistoricalTaskRuntimeSignerAuthorization(f.crypto, {
        certificateBytes: f.certificateBytes, resolveHistoricalIssuer: () => f.device.publicKey,
      });
      destroyVerifiedTaskRuntimeSignerAuthorization(verified);
      const corrupted = f.certificateBytes.slice();
      for (let index = 0; index < corrupted.length; index++) {
        corrupted[index] = corrupted[index]! ^ 1;
        expect(() => verifyHistoricalTaskRuntimeSignerAuthorization(f.crypto, {
          certificateBytes: corrupted, resolveHistoricalIssuer: () => f.device.publicKey,
        })).toThrow();
        corrupted[index] = corrupted[index]! ^ 1;
      }
      corrupted.fill(0);
    } finally { cleanup(f); }
  });
});
