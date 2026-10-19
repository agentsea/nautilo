import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, test } from "bun:test";

import {
  LatticeCrypto,
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  createCommonAgentObjectAccessManifest,
  createDomainForegroundAuthorizationPlan,
  createTaskRuntimeCommonObjectAccessManifest,
  cryptoDeviceId,
  deriveAgentRuntimeObjectSignerPublic,
  humanId,
  mintDomainForegroundAuthorization,
  objectId,
  type AgentRuntimeKeyGeneration,
} from "@nautilo/lattice-crypto";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  createTaskRuntimeBackgroundAuthorizationRequestV2,
  createTaskRuntimeBackgroundAuthorizationRequestV3,
  createTaskRuntimeSignerAuthorizationV1,
  createTaskRuntimeSignerAuthorizationV2,
  encodeTaskRuntimeBackgroundAuthorizationRequestV2,
  encodeTaskRuntimeBackgroundAuthorizationRequestV3,
} from "@nautilo/lattice-crypto/background";
import {
  serializeDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";
import { seededRng } from "@nautilo/lattice-crypto/testing";

import {
  verifyStoredObjectAccessManifestChainV5,
} from "../../src/server/storage/postgres-object-access-manifest-v5.ts";
import {
  destroyVerifiedStoredTaskRuntimeSignerEvidenceV1,
  loadVerifiedTaskRuntimeSignerEvidenceV1,
} from "../../src/server/storage/postgres-task-runtime-signer-evidence.ts";
import type { CryptoPostgresExecutor } from
  "../../src/server/storage/postgres-lattice-storage.ts";
import type { DatabaseRow } from
  "../../src/server/storage/postgres-record-codecs.ts";

const NOW = 1_801_000_000_000;
const TASK = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function normalizedSql(statement: string): string {
  return statement.replaceAll('"', "").replaceAll(/\s+/gu, " ").trim()
    .toLowerCase();
}

async function fixture(publication = false) {
  const crypto = new LatticeCrypto(seededRng(2_631_101), { now: () => NOW });
  const issuer = crypto.generateSigningKeyPair();
  const recipient = await crypto.deriveEncryptionKeyPair(bytes(0x41));
  const runtime: AgentRuntimeKeyGeneration = {
    agentId: agentId("agent:task"),
    keyClass: "runtime",
    generation: agentRuntimeGeneration(0),
    key: bytes(0x42),
  };
  const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
  const domain = {
    domainId: "domain:task",
    sourceNamespaceId: "namespace:task",
    participantDigest: bytes(0x11),
    participantCount: 2,
    keyClass: "ai" as const,
    domainKeyGeneration: 5,
    authorizationRevision: authorizationRevision(7),
    headDigest: bytes(0x12),
    activeNamespaceBindingSetDigest: bytes(0x13),
    activeNamespaceBindingCount: 1,
  };
  const plan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: "request:task",
    policyRevision: 9,
    sessionId: "episode:task",
    roomId: "room:task",
    subjectHumanId: humanId("human:task"),
    committerDeviceId: cryptoDeviceId("device:task"),
    committerDeviceSigningGeneration: 4,
    hostAuthorizationRevision: authorizationRevision(6),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 0,
    recipientKeyId: "recipient:task",
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    deadlineAt: NOW + 60_000,
    maximumSecretBytes: 2_048,
    domains: [domain],
  });
  const base = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: "request:task",
    workId: RUN,
    workKind: publication ? "task.deliver_result" : "task.execute",
    workPurpose: publication ? "task.deliver_result" : "task.execute",
    recipientGeneration: 0,
    episodeId: "episode:task",
    sourceRoomId: "room:task",
    recipientKeyId: "recipient:task",
    recipientPublicKey: recipient.publicKey,
    authorizationPlan: plan,
    issuedAt: NOW,
    deadlineAt: NOW + 60_000,
  });
  const resultObjectId = `task-run-result:v1:${bytesToHex(crypto.hash(
    new TextEncoder().encode(
      `nautilo/task-run-result-crypto-object/v1\n${TASK}\n${RUN}\n1`,
    ),
  ))}`;
  const requestAuthority = {
    signer: {
      agentId: signer.principal.agentId,
      runtimeGeneration: 0,
      signerKeyId: signer.principal.signerKeyId,
      signerPublicKey: signer.publicKey,
    },
    deviceGroupHead: {
      serverInstanceId: "server:task",
      lineageGeneration: 3,
      epoch: 10,
      headDigest: bytes(0x22),
      signingPublicKeyHash: crypto.hash(issuer.publicKey),
    },
    namespaceRequirements: [{
      ordinal: 0,
      namespaceId: "namespace:task",
      domainId: "domain:task",
      operations: ["decrypt", "encrypt"],
      expectedAccessRevision: 8,
      expectedPolicyRevision: 9,
    }],
  } as const;
  const request = publication
    ? createTaskRuntimeBackgroundAuthorizationRequestV3(crypto, {
      baseRequest: base,
      work: { kind: "task.deliver_result", taskId: TASK, taskRunId: RUN,
        contentRevision: 1, workIdentityHash: bytes(0x21) },
      ...requestAuthority,
    })
    : createTaskRuntimeBackgroundAuthorizationRequestV2(crypto, {
      baseRequest: base,
      work: {
        taskId: TASK,
        taskRunId: RUN,
        inputObjectId: `task-definition:v1:${"b".repeat(64)}`,
        resultObjectId,
        executionSegment: 1,
        workIdentityHash: bytes(0x21),
      },
      ...requestAuthority,
    });
  const authorization = await mintDomainForegroundAuthorization(crypto, {
    plan,
    domains: [{ ...domain, domainKey: bytes(0x31) }],
    committerDeviceSigningPrivateKey: issuer.privateKey,
    recipientEncryptionPublicKey: recipient.publicKey,
  });
  const requestBytes = request.formatVersion === 3
    ? encodeTaskRuntimeBackgroundAuthorizationRequestV3(crypto, request)
    : encodeTaskRuntimeBackgroundAuthorizationRequestV2(crypto, request);
  const authorizationBytes = serializeDomainForegroundAuthorizationV2(
    authorization,
  );
  const planBytes = serializeDomainForegroundAuthorizationPlanV2(plan);
  const authorizationHash = crypto.hash(authorizationBytes);
  const certificateBytes = (publication
    ? createTaskRuntimeSignerAuthorizationV2
    : createTaskRuntimeSignerAuthorizationV1)(crypto, {
    requestBytes,
    authorizationBytes,
    expectedAuthorizationPlanBytes: planBytes,
    expectedAuthorizationHash: authorizationHash,
    issuerSigningPrivateKey: issuer.privateKey,
  });
  const payloadHash = bytes(0x51);
  const manifest = createTaskRuntimeCommonObjectAccessManifest(crypto, {
    objectId: objectId(resultObjectId),
    payloadHash,
    accessRevision: accessRevision(0),
    previousManifestHash: null,
    envelopeHashes: [bytes(0x52)],
    signer: signer.principal,
    signerAuthorizationHash: crypto.hash(certificateBytes),
    hostAuthorizationRevision: authorizationRevision(6),
  }, {
    runtime,
    certificateBytes,
    issuerSigningPublicKey: issuer.publicKey,
    expectedRequestHash: crypto.hash(requestBytes),
    expectedAuthorizationHash: authorizationHash,
    now: NOW + 1,
  });
  return {
    crypto,
    issuer,
    runtime,
    signer,
    certificateBytes,
    payloadHash,
    manifest,
    resultObjectId,
  };
}

function executorFor(
  value: Awaited<ReturnType<typeof fixture>>,
  options: Readonly<{
    state?: "active" | "revoked";
    generation?: number;
    signerEvidenceBytes?: Uint8Array | null;
  }> = {},
): CryptoPostgresExecutor {
  return {
    query: <Row extends DatabaseRow = DatabaseRow>(statement: string) => {
      const sql = normalizedSql(statement);
      if (sql.includes("from object_crypto_access_manifests")) {
        return Promise.resolve([{
          object_id: value.resultObjectId,
          access_revision: 0,
          manifest_hash: value.manifest.hash,
          previous_manifest_hash: null,
          payload_hash: value.payloadHash,
          manifest_bytes: value.manifest.bytes,
          signer_evidence_bytes: "signerEvidenceBytes" in options
            ? options.signerEvidenceBytes
            : value.certificateBytes,
        }] as unknown as readonly Row[]);
      }
      if (sql.includes("from human_crypto_devices")) {
        return Promise.resolve([{
          device_id: "device:task",
          human_id: "human:task",
          device_generation: options.generation ?? 4,
          signing_public_key: value.issuer.publicKey,
          state: options.state ?? "revoked",
        }] as unknown as readonly Row[]);
      }
      throw new Error(`Unexpected Task signer SQL: ${statement}`);
    },
  };
}

describe("stored Task Runtime signer evidence", () => {
  test("authenticates immutable Device history after revocation", async () => {
    const value = await fixture();
    const verified = await loadVerifiedTaskRuntimeSignerEvidenceV1(
      executorFor(value),
      value.crypto,
      value.certificateBytes,
    );
    expect(verified.certificate.projection.signer).toMatchObject({
      agentId: value.signer.principal.agentId,
      runtimeGeneration: value.signer.principal.runtimeGeneration,
      signerKeyId: value.signer.principal.signerKeyId,
      signerPublicKey: value.signer.publicKey,
    });
    expect(verified.issuerPublicKey).toEqual(value.issuer.publicKey);
    destroyVerifiedStoredTaskRuntimeSignerEvidenceV1(verified);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(loadVerifiedTaskRuntimeSignerEvidenceV1(
      executorFor(value, { generation: 5 }),
      value.crypto,
      value.certificateBytes,
    )).rejects.toThrow("issuer history is unavailable");
  });

  test("authenticates retained publication evidence without a new store", async () => {
    const value = await fixture(true);
    const verified = await loadVerifiedTaskRuntimeSignerEvidenceV1(
      executorFor(value), value.crypto, value.certificateBytes,
    );
    try {
      expect(verified.certificate.projection.formatVersion).toBe(2);
      expect(verified.certificate.projection.work).toMatchObject({
        kind: "task.deliver_result",
        taskId: TASK,
        taskRunId: RUN,
        contentRevision: 1,
      });
      expect(verified.issuerPublicKey).toEqual(value.issuer.publicKey);
    } finally {
      destroyVerifiedStoredTaskRuntimeSignerEvidenceV1(verified);
    }
    const chain = await verifyStoredObjectAccessManifestChainV5({
      executor: executorFor(value),
      crypto: value.crypto,
      objectId: value.resultObjectId,
      headAccessRevision: 0,
      expectedPayloadHash: value.payloadHash,
      expectedHeadManifestHash: value.manifest.hash,
      resolveHistoricalAgentManagerAuthority: () => null,
      resolveLiveShadowAgentSigner: () => null,
    });
    expect(chain.headSignerPublicKey).toEqual(value.signer.publicKey);
    expect(chain.headSignerAuthorizationBytes).toEqual(value.certificateBytes);
  });

  test("verifies certified Agent history only from its retained row proof", async () => {
    const value = await fixture();
    let legacyCalls = 0;
    const verified = await verifyStoredObjectAccessManifestChainV5({
      executor: executorFor(value),
      crypto: value.crypto,
      objectId: value.resultObjectId,
      headAccessRevision: 0,
      expectedPayloadHash: value.payloadHash,
      expectedHeadManifestHash: value.manifest.hash,
      resolveHistoricalAgentManagerAuthority: () => {
        legacyCalls += 1;
        return null;
      },
      resolveLiveShadowAgentSigner: () => {
        legacyCalls += 1;
        return null;
      },
    });
    expect(legacyCalls).toBe(0);
    expect(verified.headSignerPublicKey).toEqual(value.signer.publicKey);
    expect(verified.headSignerAuthorizationBytes).toEqual(
      value.certificateBytes,
    );
    expect(verified.signerEvidence).toEqual([{
      kind: "task_runtime_signer_certificate",
      evidenceBytes: value.certificateBytes,
      issuer: {
        subjectHumanId: "human:task",
        deviceId: "device:task",
        hostAuthorizationRevision: 6,
        signingPublicKey: value.issuer.publicKey,
      },
    }]);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(verifyStoredObjectAccessManifestChainV5({
      executor: executorFor(value, { signerEvidenceBytes: null }),
      crypto: value.crypto,
      objectId: value.resultObjectId,
      headAccessRevision: 0,
      expectedPayloadHash: value.payloadHash,
      expectedHeadManifestHash: value.manifest.hash,
      resolveHistoricalAgentManagerAuthority: () => null,
      resolveLiveShadowAgentSigner: () => value.signer.publicKey,
    })).rejects.toThrow("evidence is unavailable or substituted");
  });

  test("rejects retained Task proof on an ordinary Agent manifest", async () => {
    const value = await fixture();
    const targetObjectId = objectId(`memory:v1:${"d".repeat(64)}`);
    const payloadHash = bytes(0x61);
    const legacy = createCommonAgentObjectAccessManifest(value.crypto, {
      objectId: targetObjectId,
      payloadHash,
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [bytes(0x62)],
      signer: value.signer.principal,
      signerAuthorizationHash: null,
      hostAuthorizationRevision: authorizationRevision(0),
    }, value.runtime);
    const executor: CryptoPostgresExecutor = {
      query: <Row extends DatabaseRow = DatabaseRow>(statement: string) => {
        if (!normalizedSql(statement).includes(
          "from object_crypto_access_manifests",
        )) throw new Error(`Unexpected legacy Task signer SQL: ${statement}`);
        return Promise.resolve([{
          object_id: targetObjectId,
          access_revision: 0,
          manifest_hash: legacy.hash,
          previous_manifest_hash: null,
          payload_hash: payloadHash,
          manifest_bytes: legacy.bytes,
          signer_evidence_bytes: value.certificateBytes,
        }] as unknown as readonly Row[]);
      },
    };
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(verifyStoredObjectAccessManifestChainV5({
      executor,
      crypto: value.crypto,
      objectId: targetObjectId,
      headAccessRevision: 0,
      expectedPayloadHash: payloadHash,
      expectedHeadManifestHash: legacy.hash,
      resolveHistoricalAgentManagerAuthority: () => null,
      resolveLiveShadowAgentSigner: () => value.signer.publicKey,
    })).rejects.toThrow("unexpected signer evidence");
  });
});
