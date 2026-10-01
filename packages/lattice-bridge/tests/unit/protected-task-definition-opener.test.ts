import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  authorizationRevision,
  createInitialNamespaceKeyrings,
  createNamespaceBinding,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  encryptObjectPayload,
  humanId,
  namespaceBindingHash,
  namespaceId,
  objectId,
  openNamespaceKeyring,
  prepareHumanObjectAccessManifestGenesisSet,
  sealNamespaceKeyring,
  unixTimestamp,
  verifyNamespaceBindingProof,
  wrapObjectDekForNamespace,
  type DomainForegroundSecretEntry,
  type Rng,
} from "@nautilo/lattice-crypto";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import {
  withTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceInputV1,
} from "../../../lattice-crypto/src/background/task-runtime-execution-evidence-v1.ts";

import {
  deriveTaskContentCryptoObjectIdV1,
  TASK_DEFINITION_OBJECT_TYPE_V1,
} from "../../src/task/task-content-repository.ts";
import {
  withProtectedTaskDefinitionV1,
  type ProtectedTaskDefinitionOccurrenceV1,
} from "../../src/task/protected-task-definition-opener.ts";
import { encodeTaskPayloadV1 } from "../../src/task/task-payload-v1.ts";

const NOW = 1_920_000_000_000;
const TASK_ID = "10000000-0000-4000-8000-000000000711";
const RUN_ID = "20000000-0000-4000-8000-000000000711";
const HUMAN_ID = "30000000-0000-4000-8000-000000000711";
const NAMESPACE_ID = "40000000-0000-4000-8000-000000000711";
const DOMAIN_ID = "50000000-0000-4000-8000-000000000711";
const AGENT_ID = "60000000-0000-4000-8000-000000000711";
const DEVICE_ID = "task-definition-device-711";

function bytes(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return {
    bytes(length: number): Uint8Array {
      const result = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        result[index] = state & 0xff;
      }
      return result;
    },
  };
}

async function fixture() {
  const crypto = new LatticeCrypto(seededRng(711), { now: () => NOW });
  const committer = crypto.generateSigningKeyPair();
  const objectSigner = crypto.generateSigningKeyPair();
  const domainRoot = bytes(0x41);
  const humanRoot = bytes(0x31);
  const keyrings = createInitialNamespaceKeyrings(
    crypto,
    namespaceId(NAMESPACE_ID),
  );
  const metadata = {
    domainId: cryptoDomainId(DOMAIN_ID),
    domainEpoch: domainEpoch(4),
    accessRevision: accessRevision(0),
    previousBindingHash: null,
    committerDeviceId: cryptoDeviceId("namespace-committer-711"),
  };
  const humanEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: humanRoot,
    keyring: { ...keyrings.human, accessRevision: accessRevision(0) },
    metadata,
    committerSigningPrivateKey: committer.privateKey,
    resolveCurrentCommitter: () => committer.publicKey,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot,
    keyring: { ...keyrings.ai, accessRevision: accessRevision(0) },
    metadata,
    committerSigningPrivateKey: committer.privateKey,
    resolveCurrentCommitter: () => committer.publicKey,
  });
  const binding = createNamespaceBinding({
    crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: committer.privateKey,
    resolveCurrentCommitter: () => committer.publicKey,
  });
  const trustedHead = verifyNamespaceBindingProof({
    crypto,
    anchor: {
      namespaceId: namespaceId(NAMESPACE_ID),
      accessRevision: accessRevision(0),
      bindingHash: namespaceBindingHash(binding),
    },
    proof: [binding],
    resolveHistoricalCommitter: () => committer.publicKey,
  });
  const occurrence: ProtectedTaskDefinitionOccurrenceV1 = Object.freeze({
    taskId: TASK_ID,
    requesterHumanId: HUMAN_ID,
    objectId: deriveTaskContentCryptoObjectIdV1({
      kind: "definition",
      taskId: TASK_ID,
      contentRevision: 2,
    }),
    contentRevision: 2,
    cryptoAccessRevision: 0,
    namespaceId: NAMESPACE_ID,
    domainId: DOMAIN_ID,
    expectedAccessRevision: 0,
    expectedPolicyRevision: 3,
  });
  const plaintext = encodeTaskPayloadV1({
    formatVersion: 1,
    prompt: "Open the protected definition",
    expectedOutput: "A result",
    protectedMetadata: {},
  });
  const encrypted = encryptObjectPayload(crypto, {
    objectId: objectId(occurrence.objectId),
    keyClass: "ai",
    objectType: TASK_DEFINITION_OBJECT_TYPE_V1,
    createdAt: unixTimestamp(NOW),
  }, plaintext);
  plaintext.fill(0);
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const opened = openNamespaceKeyring({
    crypto,
    domainRoot,
    envelope: aiEnvelope,
    resolveHistoricalCommitter: () => committer.publicKey,
  });
  const generation = opened.generations.find((entry) =>
    entry.generation === opened.currentGeneration
  );
  if (generation === undefined) throw new Error("missing test generation");
  const namespaceEnvelope = wrapObjectDekForNamespace(
    crypto,
    generation.key,
    {
      objectId: objectId(occurrence.objectId),
      namespaceId: namespaceId(NAMESPACE_ID),
      keyClass: "ai",
      keyGeneration: generation.generation,
      bindingRevisionAtWrap: accessRevision(0),
    },
    encrypted.dek,
  );
  const namespaceEnvelopeBytes = encodeNamespaceObjectEnvelopeV2(
    namespaceEnvelope,
  );
  encrypted.dek.fill(0);
  encrypted.payload.ciphertext.fill(0);
  namespaceEnvelope.wrappedDek.fill(0);
  for (const entry of opened.generations) entry.key.fill(0);
  const prepared = prepareHumanObjectAccessManifestGenesisSet(crypto, {
    objectId: objectId(occurrence.objectId),
    payloadHash: crypto.hash(payloadBytes),
    envelopeBytes: [namespaceEnvelopeBytes],
    sourceAuthorized: true,
    targetAuthorized: true,
    subjectHumanId: humanId(HUMAN_ID),
    committerDeviceId: cryptoDeviceId(DEVICE_ID),
    hostAuthorizationRevision: authorizationRevision(5),
    committerSigningPublicKey: objectSigner.publicKey,
    committerSigningPrivateKey: objectSigner.privateKey,
  });
  const domainRequirement = Object.freeze({
    domainId: DOMAIN_ID,
    sourceNamespaceId: NAMESPACE_ID,
    participantDigest: bytes(0x61),
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: 4,
    authorizationRevision: authorizationRevision(9),
    headDigest: bytes(0x62),
    activeNamespaceBindingSetDigest: bytes(0x63),
    activeNamespaceBindingCount: 1,
  });
  const domain: DomainForegroundSecretEntry = Object.freeze({
    ...domainRequirement,
    domainKey: domainRoot.slice(),
  });
  const evidence = Object.freeze({
    requestId: "task-definition-request-711",
    workId: RUN_ID,
    claimId: "task-definition-claim-711",
    claimExpiresAt: NOW + 60_000,
    recipientExpiresAt: NOW + 60_000,
    expiresAt: NOW + 60_000,
    recipientGeneration: 1,
    recipientKeyId: "task-definition-recipient-711",
    authorizationDigest: bytes(0x51),
    policyRevision: 3,
    episodeId: "task-definition-episode-711",
    sourceRoomId: "task-definition-room-711",
    hostAuthorizationRevision: 5,
    recipientAuthorizationRevision: 6,
    result: Object.freeze({
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      contentRevision: 1 as const,
      objectId: "task-definition-result-711",
      signerAgentId: AGENT_ID,
      namespace: Object.freeze({
        namespaceId: NAMESPACE_ID,
        domainId: DOMAIN_ID,
        operations: Object.freeze(["encrypt"] as const),
        expectedAccessRevision: 0,
        expectedPolicyRevision: 3,
      }),
    }),
    domainRequirements: Object.freeze([domainRequirement]),
    namespaceRequirements: Object.freeze([Object.freeze({
      ordinal: 0,
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      operations: Object.freeze(["decrypt", "encrypt"] as const),
      expectedAccessRevision: 0,
      expectedPolicyRevision: 3,
    })]),
  } satisfies TaskRuntimeExecutionEvidenceInputV1);
  return {
    crypto,
    occurrence,
    evidence,
    domain,
    objectSigner,
    committer,
    trustedHead,
    aiEnvelope,
    payloadBytes,
    namespaceEnvelopeBytes,
    prepared,
  };
}

describe("protected Task definition opener", () => {
  test("opens a canonical definition under exact live Task and Namespace authority", async () => {
    const value = await fixture();
    let reads = 0;
    const result = await withTaskRuntimeExecutionEvidenceV1({
      evidence: value.evidence,
      signal: new AbortController().signal,
      now: () => NOW,
      execute: (evidence) => withProtectedTaskDefinitionV1({
        crypto: value.crypto,
        evidence,
        domains: [value.domain],
        storage: {
          getObject: async () => ({
            objectId: value.occurrence.objectId,
            payloadBytes: value.payloadBytes,
          }),
          getObjectAccessState: async () => ({
            head: {
              objectId: value.occurrence.objectId,
              accessRevision: 0,
              manifestHash: value.prepared.manifestHash,
              manifestBytes: value.prepared.manifestBytes,
            },
            namespaceEnvelopes: [{
              namespaceId: NAMESPACE_ID,
              envelopeHash: value.crypto.hash(value.namespaceEnvelopeBytes),
              envelopeBytes: value.namespaceEnvelopeBytes,
            }],
          }),
        },
        namespace: {
          trustedHead: value.trustedHead,
          aiKeyringEnvelope: value.aiEnvelope,
          resolveHistoricalCommitter: () => value.committer.publicKey,
        },
        resolveHistoricalHumanDeviceSigningPublicKey: (context) =>
          context.subjectHumanId === HUMAN_ID
              && context.committerDeviceId === DEVICE_ID
            ? value.objectSigner.publicKey
            : null,
        signal: new AbortController().signal,
        loadCurrentOccurrence: async () => {
          reads += 1;
          return value.occurrence;
        },
        execute: (payload) => `${payload.prompt}:${payload.expectedOutput}`,
      }),
    });
    expect(result).toBe("Open the protected definition:A result");
    expect(reads).toBe(2);
  });

  test("rejects an untrusted historical Human signer", async () => {
    const value = await fixture();
    let failure: unknown;
    try {
      await withTaskRuntimeExecutionEvidenceV1({
        evidence: value.evidence,
        signal: new AbortController().signal,
        now: () => NOW,
        execute: (evidence) => withProtectedTaskDefinitionV1({
        crypto: value.crypto,
        evidence,
        domains: [value.domain],
        storage: {
          getObject: async () => ({
            objectId: value.occurrence.objectId,
            payloadBytes: value.payloadBytes,
          }),
          getObjectAccessState: async () => ({
            head: {
              objectId: value.occurrence.objectId,
              accessRevision: 0,
              manifestHash: value.prepared.manifestHash,
              manifestBytes: value.prepared.manifestBytes,
            },
            namespaceEnvelopes: [{
              namespaceId: NAMESPACE_ID,
              envelopeHash: value.crypto.hash(value.namespaceEnvelopeBytes),
              envelopeBytes: value.namespaceEnvelopeBytes,
            }],
          }),
        },
        namespace: {
          trustedHead: value.trustedHead,
          aiKeyringEnvelope: value.aiEnvelope,
          resolveHistoricalCommitter: () => value.committer.publicKey,
        },
        resolveHistoricalHumanDeviceSigningPublicKey: () => null,
        signal: new AbortController().signal,
        loadCurrentOccurrence: async () => value.occurrence,
        execute: () => "should not open",
        }),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toContain(
      "Human device signing public key must be exactly 32 bytes",
    );
  });
});
