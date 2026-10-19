import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, test } from "bun:test";

import {
  LatticeCrypto,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  cryptoDeviceId,
  humanId,
  mintDomainForegroundAuthorization,
  objectId,
} from "@nautilo/lattice-crypto";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  createTaskRuntimeBackgroundAuthorizationRequestV2,
  createTaskRuntimeBackgroundAuthorizationRequestV3,
  createTaskRuntimeSignerAuthorizationV1,
  createTaskRuntimeSignerAuthorizationV2,
  encodeTaskRuntimeBackgroundAuthorizationRequestV2,
  encodeTaskRuntimeBackgroundAuthorizationRequestV3,
  readTaskRuntimeSignerAuthorizationIssuer,
  readTaskRuntimeSignerAuthorizationIssuerV1,
} from "@nautilo/lattice-crypto/background";
import {
  agentRuntimeObjectSignerKeyIdV1,
  serializeDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";
import { seededRng } from "@nautilo/lattice-crypto/testing";

import type { OpenedClientDeviceProfileV4 } from
  "../../src/client-vault/profile-v4.ts";
import { withTaskRuntimeSignerEvidenceResolversV1 } from
  "../../src/client/task-runtime-signer-evidence.ts";

const NOW = 1_801_100_000_000;
const HUMAN = "human:task";
const DEVICE = "device:task";
const TASK = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function profile(
  signingPublicKey: Uint8Array,
  shared: readonly Readonly<{
    humanId: string;
    deviceId: string;
    deviceGeneration: number;
    signingPublicKey: Uint8Array;
  }>[] = [],
): OpenedClientDeviceProfileV4 {
  return {
    baseProfile: { baseProfile: { deviceId: DEVICE, signingPublicKey } },
    signerEvidence: shared.length === 0 ? [] : [{
      kind: "shared_human_domain_trust",
      devices: shared,
    }],
  } as unknown as OpenedClientDeviceProfileV4;
}

async function fixture(publication = false) {
  const crypto = new LatticeCrypto(seededRng(2_711_001), { now: () => NOW });
  const device = crypto.generateSigningKeyPair();
  const recipient = await crypto.deriveEncryptionKeyPair(bytes(0x41));
  const signer = crypto.generateSigningKeyPair();
  const domain = {
    domainId: "domain:task", sourceNamespaceId: "namespace:task",
    participantDigest: bytes(0x11), participantCount: 2, keyClass: "ai" as const,
    domainKeyGeneration: 5, authorizationRevision: authorizationRevision(7),
    headDigest: bytes(0x12), activeNamespaceBindingSetDigest: bytes(0x13),
    activeNamespaceBindingCount: 1,
  };
  const plan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: "request:task", policyRevision: 9,
    sessionId: "episode:task", roomId: "room:task",
    subjectHumanId: humanId(HUMAN), committerDeviceId: cryptoDeviceId(DEVICE),
    committerDeviceSigningGeneration: 4,
    hostAuthorizationRevision: authorizationRevision(6),
    recipientKind: "runtime", recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 0, recipientKeyId: "recipient:task",
    operations: ["decrypt", "encrypt"], issuedAt: NOW,
    deadlineAt: NOW + 60_000, maximumSecretBytes: 2_048, domains: [domain],
  });
  const baseRequest = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: "request:task", workId: RUN,
    workKind: publication ? "task.deliver_result" : "task.execute",
    workPurpose: publication ? "task.deliver_result" : "task.execute",
    recipientGeneration: 0,
    episodeId: "episode:task", sourceRoomId: "room:task",
    recipientKeyId: "recipient:task", recipientPublicKey: recipient.publicKey,
    authorizationPlan: plan, issuedAt: NOW, deadlineAt: NOW + 60_000,
  });
  const resultObjectId = `task-run-result:v1:${bytesToHex(crypto.hash(
    new TextEncoder().encode(
      `nautilo/task-run-result-crypto-object/v1\n${TASK}\n${RUN}\n1`,
    ),
  ))}`;
  const requestAuthority = {
    signer: { agentId: "agent:task", runtimeGeneration: 0,
      signerKeyId: agentRuntimeObjectSignerKeyIdV1(crypto, signer.publicKey),
      signerPublicKey: signer.publicKey },
    deviceGroupHead: { serverInstanceId: "server:task", lineageGeneration: 3,
      epoch: 10, headDigest: bytes(0x22),
      signingPublicKeyHash: crypto.hash(device.publicKey) },
    namespaceRequirements: [{ ordinal: 0, namespaceId: "namespace:task",
      domainId: "domain:task", operations: ["decrypt", "encrypt"],
      expectedAccessRevision: 8, expectedPolicyRevision: 9 }],
  } as const;
  const request = publication
    ? createTaskRuntimeBackgroundAuthorizationRequestV3(crypto, {
      baseRequest,
      work: { kind: "task.deliver_result", taskId: TASK, taskRunId: RUN,
        contentRevision: 1, workIdentityHash: bytes(0x21) },
      ...requestAuthority,
    })
    : createTaskRuntimeBackgroundAuthorizationRequestV2(crypto, {
      baseRequest,
      work: { taskId: TASK, taskRunId: RUN,
        inputObjectId: `task-definition:v1:${"b".repeat(64)}`,
        resultObjectId, executionSegment: 1, workIdentityHash: bytes(0x21) },
      ...requestAuthority,
    });
  const authorization = await mintDomainForegroundAuthorization(crypto, {
    plan, domains: [{ ...domain, domainKey: bytes(0x31) }],
    committerDeviceSigningPrivateKey: device.privateKey,
    recipientEncryptionPublicKey: recipient.publicKey,
  });
  const requestBytes = request.formatVersion === 3
    ? encodeTaskRuntimeBackgroundAuthorizationRequestV3(crypto, request)
    : encodeTaskRuntimeBackgroundAuthorizationRequestV2(crypto, request);
  const authorizationBytes = serializeDomainForegroundAuthorizationV2(
    authorization,
  );
  const certificateBytes = (publication
    ? createTaskRuntimeSignerAuthorizationV2
    : createTaskRuntimeSignerAuthorizationV1)(crypto, {
    requestBytes, authorizationBytes,
    expectedAuthorizationPlanBytes:
      serializeDomainForegroundAuthorizationPlanV2(plan),
    expectedAuthorizationHash: crypto.hash(authorizationBytes),
    issuerSigningPrivateKey: device.privateKey,
  });
  return { crypto, device, certificateBytes };
}

describe("Task Runtime signer read evidence", () => {
  test("scopes exact certificate bytes and trusts only exact Device generations", async () => {
    const value = await fixture();
    const encoded = Buffer.from(value.certificateBytes).toString("base64url");
    const issuer = readTaskRuntimeSignerAuthorizationIssuerV1(
      value.crypto, value.certificateBytes,
    );
    const profileKey = value.device.publicKey.slice();
    const evidenceInput = value.certificateBytes.slice();
    const result = withTaskRuntimeSignerEvidenceResolversV1({
      crypto: value.crypto,
      profile: profile(profileKey),
      subjectHumanId: HUMAN,
      ownDeviceGeneration: 4,
      expectedWork: { taskId: TASK, taskRunId: RUN },
      evidence: [{ kind: "task_runtime_signer_certificate",
        evidenceBytesBase64url: encoded }],
      operation: resolvers => ({
        certificate: resolvers.resolveTaskRuntimeSignerAuthorizationBytes({
          signer: { kind: "agent_runtime", agentId: agentId("agent:task"),
            runtimeGeneration: agentRuntimeGeneration(0),
            signerKeyId: "signer:task" },
          authorizationHash: value.crypto.hash(value.certificateBytes),
          objectId: objectId(`task-run-result:v1:${"a".repeat(64)}`),
        })?.slice(),
        key: resolvers.resolveHistoricalTaskRuntimeIssuer({
          issuer, projection: { work: { taskId: TASK, taskRunId: RUN } } as never,
        })?.slice(),
      }),
    });
    expect(Buffer.from(result.certificate ?? []).equals(
      Buffer.from(value.certificateBytes),
    )).toBeTrue();
    expect(Buffer.from(result.key ?? []).equals(
      Buffer.from(value.device.publicKey),
    )).toBeTrue();
    expect(Buffer.from(profileKey).equals(
      Buffer.from(value.device.publicKey),
    )).toBeTrue();
    expect(Buffer.from(evidenceInput).equals(
      Buffer.from(value.certificateBytes),
    )).toBeTrue();

    const mismatched = withTaskRuntimeSignerEvidenceResolversV1({
      crypto: value.crypto, profile: profile(value.device.publicKey),
      subjectHumanId: HUMAN, ownDeviceGeneration: 5,
      expectedWork: { taskId: TASK, taskRunId: RUN },
      evidence: [{ kind: "task_runtime_signer_certificate",
        evidenceBytesBase64url: encoded }],
      operation: resolvers => resolvers.resolveHistoricalTaskRuntimeIssuer({
        issuer, projection: { work: { taskId: TASK, taskRunId: RUN } } as never,
      }),
    });
    expect(mismatched).toBeNull();

    const shared = withTaskRuntimeSignerEvidenceResolversV1({
      crypto: value.crypto, profile: profile(bytes(0x7f), [{ humanId: HUMAN,
        deviceId: DEVICE, deviceGeneration: 4,
        signingPublicKey: value.device.publicKey }]),
      subjectHumanId: "human:reader", evidence: [],
      expectedWork: { taskId: TASK, taskRunId: RUN },
      operation: resolvers => resolvers.resolveHistoricalTaskRuntimeIssuer({
        issuer, projection: { work: { taskId: TASK, taskRunId: RUN } } as never,
      })?.slice(),
    });
    expect(Buffer.from(shared ?? []).equals(
      Buffer.from(value.device.publicKey),
    )).toBeTrue();

    const wrongRun = withTaskRuntimeSignerEvidenceResolversV1({
      crypto: value.crypto, profile: profile(value.device.publicKey),
      subjectHumanId: HUMAN, ownDeviceGeneration: 4,
      expectedWork: { taskId: TASK,
        taskRunId: "55555555-5555-4555-8555-555555555555" },
      evidence: [],
      operation: resolvers => resolvers.resolveHistoricalTaskRuntimeIssuer({
        issuer, projection: { work: { taskId: TASK, taskRunId: RUN } } as never,
      }),
    });
    expect(wrongRun).toBeNull();
  });

  test("rejects malformed and duplicate evidence", async () => {
    const value = await fixture();
    const encoded = Buffer.from(value.certificateBytes).toString("base64url");
    const base = { crypto: value.crypto, profile: profile(value.device.publicKey),
      subjectHumanId: HUMAN, ownDeviceGeneration: 4,
      operation: () => undefined };
    expect(() => withTaskRuntimeSignerEvidenceResolversV1({
      ...base, evidence: [{ kind: "task_runtime_signer_certificate",
        evidenceBytesBase64url: "!" }],
    })).toThrow();
    expect(() => withTaskRuntimeSignerEvidenceResolversV1({
      ...base, evidence: [
        { kind: "task_runtime_signer_certificate",
          evidenceBytesBase64url: encoded },
        { kind: "task_runtime_signer_certificate",
          evidenceBytesBase64url: encoded },
      ],
    })).toThrow();
  });

  test("dispatches publication certificates through the retained Device resolver", async () => {
    const value = await fixture(true);
    const issuer = readTaskRuntimeSignerAuthorizationIssuer(
      value.crypto, value.certificateBytes,
    );
    try {
      const resolved = withTaskRuntimeSignerEvidenceResolversV1({
        crypto: value.crypto,
        profile: profile(value.device.publicKey),
        subjectHumanId: HUMAN,
        ownDeviceGeneration: 4,
        expectedWork: { taskId: TASK, taskRunId: RUN },
        evidence: [{ kind: "task_runtime_signer_certificate",
          evidenceBytesBase64url:
            Buffer.from(value.certificateBytes).toString("base64url") }],
        operation: resolvers => ({
          certificate: resolvers.resolveTaskRuntimeSignerAuthorizationBytes({
            signer: { kind: "agent_runtime", agentId: agentId("agent:task"),
              runtimeGeneration: agentRuntimeGeneration(0),
              signerKeyId: "signer:task" },
            authorizationHash: value.crypto.hash(value.certificateBytes),
            objectId: objectId(`memory:v2:${"e".repeat(64)}`),
          })?.slice(),
          issuerKey: resolvers.resolveHistoricalTaskRuntimeIssuer({
            issuer,
            projection: { work: { taskId: TASK, taskRunId: RUN } } as never,
          })?.slice(),
        }),
      });
      expect(Buffer.from(resolved.certificate ?? []).equals(
        Buffer.from(value.certificateBytes),
      )).toBeTrue();
      expect(Buffer.from(resolved.issuerKey ?? []).equals(
        Buffer.from(value.device.publicKey),
      )).toBeTrue();
    } finally {
      issuer.headDigest.fill(0);
      issuer.signingPublicKeyHash.fill(0);
    }
  });
});
