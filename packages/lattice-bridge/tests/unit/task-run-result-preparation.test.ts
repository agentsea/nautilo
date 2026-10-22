import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  agentId,
  authorizationRevision,
  createInitialNamespaceKeyrings,
  createNamespaceBinding,
  cryptoDeviceId,
  cryptoDomainId,
  decryptObjectThroughNamespace,
  deriveAgentRuntimeObjectSignerPublic,
  domainEpoch,
  encryptObjectPayload,
  humanId,
  namespaceBindingHash,
  namespaceGeneration,
  namespaceId,
  objectId,
  openNamespaceKeyring,
  prepareAgentRuntimeInitialization,
  prepareHumanObjectAccessManifestGenesisSet,
  sealNamespaceKeyring,
  verifyNamespaceBindingProof,
  withTaskRuntimeCheckpointNamespace,
  wrapObjectDekForNamespace,
  type Rng,
  type TrustedMinimumObjectAccessHead,
  unixTimestamp,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeLiveShadowMessagePlanV4,
  decodeNamespaceObjectEnvelopeV2,
  encodeAgentRuntimeSignerPublicationV1,
  encodeEncryptedPayloadV2,
  encodeLiveShadowMessagePlanV4,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import type {
  NautiloApiClient,
  ProtectedTaskRunResultReadEnvelopeV1,
} from "@nautilo/api-client/browser";

import {
  encodeClientDeviceProfileV2,
  type OpenedClientDeviceProfileV2,
} from "../../src/client-vault/profile-v2.ts";
import {
  createClientDeviceProfileV3Candidate,
  destroyOpenedClientDeviceProfileV3,
  encodeClientDeviceProfileV3,
} from "../../src/client-vault/profile-v3.ts";
import {
  addClientSharedHumanDomainSignerEvidenceV4,
  createClientDeviceProfileV4Candidate,
  destroyOpenedClientDeviceProfileV4,
  encodeClientDeviceProfileV4,
} from "../../src/client-vault/profile-v4.ts";
import {
  createSharedHumanDomainTrustAcceptanceV1,
  encodeSharedHumanDomainTrustAcceptanceV1,
} from "../../src/delivery/shared-human-domain-trust.ts";
import type { ClientProfileCoordinates } from
  "../../src/client-vault/types.ts";
import { MemoryClientProfileVault } from
  "../../src/testing/client-profile-vault.ts";
import { createAuthorizedHumanTaskRunResultReaderV1 } from
  "../../src/client/task/authorized-human-task-run-result.ts";
import {
  createVaultHumanTaskRunResultReaderV1,
  type VaultHumanTaskRunResultReaderInputV1,
} from
  "../../src/client/task/vault-human-task-run-result.ts";
import { ClassifiedDataOperationError } from
  "../../src/transition/encryption-data-operation-owner.ts";

import {
  withTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceInputV1,
} from "../../../lattice-crypto/src/background/task-runtime-execution-evidence-v1.ts";
import type { TaskContentAuthorityV1 } from
  "../../src/task/task-content-authority-v1.ts";
import {
  readPreparedTaskContentCryptoRevisionSnapshotV1,
} from "../../src/task/task-content-prepared-revision.ts";
import {
  deriveTaskContentCryptoObjectIdV1,
  TASK_RUN_RESULT_OBJECT_TYPE_V1,
} from "../../src/task/task-content-repository.ts";
import { deriveTaskHistoricalContentCryptoObjectIdV1 } from
  "../../src/task/task-historical-content-identity.ts";
import {
  decodeTaskRunResultPayloadV1,
  encodeTaskRunResultPayloadV1,
} from "../../src/task/task-payload-v1.ts";
import {
  prepareTaskRuntimeRunResult,
  taskRuntimePreparedResultDigestV1,
} from "../../src/task/task-run-result-preparation.ts";

const NOW = 1_820_000_000_000;
const TASK_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "20000000-0000-4000-8000-000000000001";
const REQUESTER_ID = "30000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "40000000-0000-4000-8000-000000000001";
const DOMAIN_ID = "50000000-0000-4000-8000-000000000001";
const AGENT_ID = "60000000-0000-4000-8000-000000000001";
const ACCESS_REVISION = 0;
const POLICY_REVISION = 3;
const AGENT_AUTHORIZATION_REVISION = 7;

function bytes(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

function taskReadAuthority() {
  return {
    sourceRoomId: RUN_ID,
    namespaceId: NAMESPACE_ID,
    currentGeneration: 0,
    retainedGenerations: [{
      generation: 0,
      accessRevision: ACCESS_REVISION,
      headDigestBase64url: Buffer.from(bytes(0x71)).toString("base64url"),
      publicationDigestBase64url: Buffer.from(bytes(0x72)).toString("base64url"),
      publicationSetDigestBase64url: Buffer.from(bytes(0x73)).toString("base64url"),
      audienceFingerprintBase64url: Buffer.from(bytes(0x74)).toString("base64url"),
    }],
  };
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

async function setup(seed = 1, configuredNamespaceId = NAMESPACE_ID) {
  const crypto = new LatticeCrypto(seededRng(seed), { now: () => NOW });
  const namespaceCommitter = crypto.generateSigningKeyPair();
  const manager = crypto.generateSigningKeyPair();
  const targetNamespaceId = namespaceId(configuredNamespaceId);
  const targetDomainId = cryptoDomainId(DOMAIN_ID);
  const targetDomainEpoch = domainEpoch(4);
  const targetAccessRevision = accessRevision(ACCESS_REVISION);
  const committerDeviceId = cryptoDeviceId("task-result-committer");
  const aiDomainRoot = bytes(0x41);
  const humanDomainRoot = bytes(0x31);
  const keyrings = createInitialNamespaceKeyrings(crypto, targetNamespaceId);
  const metadata = {
    domainId: targetDomainId,
    domainEpoch: targetDomainEpoch,
    accessRevision: targetAccessRevision,
    previousBindingHash: null,
    committerDeviceId,
  };
  const humanEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: humanDomainRoot,
    keyring: {
      ...keyrings.human,
      accessRevision: targetAccessRevision,
    },
    metadata,
    committerSigningPrivateKey: namespaceCommitter.privateKey,
    resolveCurrentCommitter: () => namespaceCommitter.publicKey,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: aiDomainRoot,
    keyring: {
      ...keyrings.ai,
      accessRevision: targetAccessRevision,
    },
    metadata,
    committerSigningPrivateKey: namespaceCommitter.privateKey,
    resolveCurrentCommitter: () => namespaceCommitter.publicKey,
  });
  const binding = createNamespaceBinding({
    crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: namespaceCommitter.privateKey,
    resolveCurrentCommitter: () => namespaceCommitter.publicKey,
  });
  const trustedHead = verifyNamespaceBindingProof({
    crypto,
    anchor: {
      namespaceId: targetNamespaceId,
      accessRevision: targetAccessRevision,
      bindingHash: namespaceBindingHash(binding),
    },
    proof: [binding],
    resolveHistoricalCommitter: () => namespaceCommitter.publicKey,
  });
  const initialized = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: "task-result-agent-initialization",
    agentId: agentId(AGENT_ID),
    authorizationRevision: authorizationRevision(
      AGENT_AUTHORIZATION_REVISION,
    ),
    configObjects: [{
      objectId: "task-result-agent-config",
      configRevision: authorizationRevision(1),
      plaintextDek: bytes(0x21),
    }],
    domains: [],
    resolveCurrentDomainCommitterAuthority: () => null,
    manager: {
      managerHumanId: humanId(REQUESTER_ID),
      managerAuthorizationRevision: authorizationRevision(2),
      managerDeviceId: cryptoDeviceId("task-result-manager"),
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  const coordinate = Object.freeze({
    kind: "run_result" as const,
    taskId: TASK_ID,
    taskRunId: RUN_ID,
    contentRevision: 1 as const,
  });
  const authority = Object.freeze({
    authorityVersion: 1 as const,
    kind: "requester_private_namespace" as const,
    keyClass: "ai" as const,
    requesterHumanId: REQUESTER_ID,
    namespaceId: configuredNamespaceId,
    domainId: DOMAIN_ID,
    expectedAccessRevision: ACCESS_REVISION,
    expectedPolicyRevision: POLICY_REVISION,
  } satisfies TaskContentAuthorityV1);
  const evidence = Object.freeze({
    requestId: "task-result-request",
    workId: RUN_ID,
    claimId: "task-result-claim",
    claimExpiresAt: NOW + 60_000,
    recipientExpiresAt: NOW + 60_000,
    expiresAt: NOW + 60_000,
    recipientGeneration: 1,
    recipientKeyId: "task-runtime-recipient.1",
    authorizationDigest: bytes(0x51),
    policyRevision: POLICY_REVISION,
    episodeId: "task-result-episode",
    sourceRoomId: "task-result-room",
    hostAuthorizationRevision: 5,
    recipientAuthorizationRevision: 6,
    result: Object.freeze({
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      contentRevision: 1 as const,
      objectId: deriveTaskContentCryptoObjectIdV1(coordinate),
      signerAgentId: AGENT_ID,
      namespace: Object.freeze({
        namespaceId: configuredNamespaceId,
        domainId: DOMAIN_ID,
        operations: Object.freeze(["encrypt"] as const),
        expectedAccessRevision: ACCESS_REVISION,
        expectedPolicyRevision: POLICY_REVISION,
      }),
    }),
    domainRequirements: Object.freeze([Object.freeze({
      domainId: DOMAIN_ID,
      sourceNamespaceId: configuredNamespaceId,
      participantDigest: bytes(0x61),
      participantCount: 1,
      keyClass: "ai" as const,
      domainKeyGeneration: 4,
      authorizationRevision: authorizationRevision(9),
      headDigest: bytes(0x62),
      activeNamespaceBindingSetDigest: bytes(0x63),
      activeNamespaceBindingCount: 1,
    })]),
    namespaceRequirements: Object.freeze([Object.freeze({
      ordinal: 0,
      namespaceId: configuredNamespaceId,
      domainId: DOMAIN_ID,
      operations: Object.freeze(["decrypt", "encrypt"] as const),
      expectedAccessRevision: ACCESS_REVISION,
      expectedPolicyRevision: POLICY_REVISION,
    })]),
  } satisfies TaskRuntimeExecutionEvidenceInputV1);
  return {
    crypto,
    aiDomainRoot,
    aiEnvelope,
    trustedHead,
    namespaceCommitter,
    manager,
    initialized,
    coordinate,
    authority,
    evidence,
  };
}

function prepareInput(
  scenario: Awaited<ReturnType<typeof setup>>,
  evidence: Parameters<
    Parameters<typeof withTaskRuntimeExecutionEvidenceV1>[0]["execute"]
  >[0],
) {
  return {
    crypto: scenario.crypto,
    evidence,
    payload: Object.freeze({
      formatVersion: 1 as const,
      resultText: "Protected Task result",
      lastError: null,
    }),
    authority: scenario.authority,
    createdAt: NOW,
    namespace: {
      trustedHead: scenario.trustedHead,
      aiKeyringEnvelope: scenario.aiEnvelope,
      currentDomainRoot: scenario.aiDomainRoot,
      resolveHistoricalCommitter: () =>
        scenario.namespaceCommitter.publicKey,
    },
    agentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
    runtime: scenario.initialized.runtime,
    signerPublication: scenario.initialized.signerPublication,
    resolveHistoricalSignerPublicationManager: () =>
      scenario.manager.publicKey,
  };
}

describe("Task Runtime result preparation", () => {
  test("encrypts once under the current AI Namespace key and seals a V5 Agent result", async () => {
    const scenario = await setup();
    const controller = new AbortController();
    const revision = await withTaskRuntimeExecutionEvidenceV1({
      evidence: scenario.evidence,
      signal: controller.signal,
      now: () => NOW,
      execute: (evidence) =>
        prepareTaskRuntimeRunResult(prepareInput(scenario, evidence)),
    });
    const snapshot = readPreparedTaskContentCryptoRevisionSnapshotV1(
      revision,
    );
    expect(taskRuntimePreparedResultDigestV1(revision)).toEqual(
      scenario.crypto.hash(snapshot.access.manifestBytes),
    );
    expect(snapshot.coordinate).toEqual(scenario.coordinate);
    expect(snapshot.signerKind).toBe("agent_runtime");
    expect(snapshot.access.manifest.signer).toMatchObject({
      kind: "agent_runtime",
      agentId: AGENT_ID,
      runtimeGeneration: scenario.initialized.runtime.generation,
      signerKeyId: scenario.initialized.signerPublication.signerKeyId,
    });
    const keyring = openNamespaceKeyring({
      crypto: scenario.crypto,
      domainRoot: scenario.aiDomainRoot,
      envelope: scenario.aiEnvelope,
      resolveHistoricalCommitter: () =>
        scenario.namespaceCommitter.publicKey,
    });
    const current = keyring.generations.find((entry) =>
      entry.generation === keyring.currentGeneration
    );
    if (current === undefined) throw new Error("current AI key is missing");
    const plaintext = decryptObjectThroughNamespace(
      scenario.crypto,
      current.key,
      decodeNamespaceObjectEnvelopeV2(snapshot.access.envelopeBytes[0]),
      decodeEncryptedPayloadV2(snapshot.object.payloadBytes.ciphertext),
    );
    if (plaintext === null) throw new Error("prepared result did not decrypt");
    expect(decodeTaskRunResultPayloadV1(plaintext)).toEqual({
      formatVersion: 1,
      resultText: "Protected Task result",
      lastError: null,
    });
    plaintext.fill(0);
    for (const generation of keyring.generations) generation.key.fill(0);
  });

  test.each([false, true])("canonical Namespace authority opens an exact result with an empty legacy keyring (peer device: %s)", async (peerDevice) => {
    const scenario = await setup(0x345);
    const prepared = await withTaskRuntimeExecutionEvidenceV1({
      evidence: scenario.evidence,
      signal: new AbortController().signal,
      now: () => NOW,
      execute: (evidence) =>
        prepareTaskRuntimeRunResult(prepareInput(scenario, evidence)),
    });
    const snapshot = readPreparedTaskContentCryptoRevisionSnapshotV1(prepared);
    const deviceId = peerDevice ? "task-result-reader" : "task-result-manager";
    const signing = peerDevice ? scenario.crypto.generateSigningKeyPair() : scenario.manager;
    const coordinates: ClientProfileCoordinates = Object.freeze({
      serverScope: "https://nautilo.test",
      userId: REQUESTER_ID,
      humanActorId: REQUESTER_ID,
      profileId: "profile:task-result-manager",
      deviceId,
      installationLineageDigest: "34".repeat(32),
    });
    const encryption = await scenario.crypto.generateEncryptionKeyPair();
    const keyring = openNamespaceKeyring({
      crypto: scenario.crypto,
      domainRoot: scenario.aiDomainRoot,
      envelope: scenario.aiEnvelope,
      resolveHistoricalCommitter: () =>
        scenario.namespaceCommitter.publicKey,
    });
    const profile: OpenedClientDeviceProfileV2 = Object.freeze({
      formatVersion: 2,
      deviceId,
      signingPublicKey: signing.publicKey,
      signingPrivateKey: signing.privateKey,
      encryptionPublicKey: encryption.publicKey,
      encryptionPrivateKey: encryption.privateKey,
      trustedDeviceRevision: 2,
      trustedHostAuthorizationRevision: 5,
      deliveryHighWatermark: 1,
      keyringDeliveries: Object.freeze([]),
    });
    const authorityKey = Uint8Array.from(
      keyring.generations.find(entry => entry.generation === 0)!.key,
    );
    const v2Bytes = encodeClientDeviceProfileV2(profile);
    const v3 = await createClientDeviceProfileV3Candidate({
      crypto: scenario.crypto,
      currentProfileBytes: v2Bytes,
      expectedDeviceId: deviceId,
    });
    const v3Bytes = encodeClientDeviceProfileV3(v3);
    const v4 = await createClientDeviceProfileV4Candidate({
      crypto: scenario.crypto,
      currentProfileBytes: v3Bytes,
      expectedDeviceId: deviceId,
    });
    let retained = v4;
    if (peerDevice) {
      const devices = [{ humanId: REQUESTER_ID, deviceId, deviceGeneration: 1,
        signingPublicKey: signing.publicKey }, {
        humanId: REQUESTER_ID, deviceId: "task-result-manager", deviceGeneration: 1,
        signingPublicKey: scenario.manager.publicKey,
      }];
      const accepted = createSharedHumanDomainTrustAcceptanceV1({
        crypto: scenario.crypto, domainId: DOMAIN_ID, domainEpoch: 4,
        participantDigest: bytes(0x45), targetSubmissionDigest: bytes(0x46), devices,
        acceptedByHumanId: REQUESTER_ID, acceptedByDeviceId: deviceId,
        acceptedAt: NOW, acceptingSigningPrivateKey: signing.privateKey,
      });
      const acceptanceBytes = encodeSharedHumanDomainTrustAcceptanceV1(accepted.acceptance);
      retained = await addClientSharedHumanDomainSignerEvidenceV4({
        crypto: scenario.crypto, profile: v4, acceptanceBytes, devices,
      });
      acceptanceBytes.fill(0);
      accepted.devices.forEach(device => device.signingPublicKey.fill(0));
    }
    const profileBytes = encodeClientDeviceProfileV4(retained);
    const historicalSourceDigest = bytes(0x74);
    const historicalObjectId = deriveTaskHistoricalContentCryptoObjectIdV1({
      coordinate: scenario.coordinate,
      namespaceId: NAMESPACE_ID,
      sourceDigest: historicalSourceDigest,
    });
    const historicalPlaintext = encodeTaskRunResultPayloadV1({
      formatVersion: 1,
      resultText: "Historical Task result",
      lastError: null,
    });
    const historicalEncrypted = encryptObjectPayload(scenario.crypto, {
      objectId: objectId(historicalObjectId),
      objectType: TASK_RUN_RESULT_OBJECT_TYPE_V1,
      keyClass: "ai",
      createdAt: unixTimestamp(NOW),
    }, historicalPlaintext);
    historicalPlaintext.fill(0);
    const historicalPayloadBytes = encodeEncryptedPayloadV2(
      historicalEncrypted.payload,
    );
    const currentGeneration = keyring.generations.find(entry =>
      entry.generation === keyring.currentGeneration);
    if (currentGeneration === undefined) throw new Error("current key missing");
    const historicalEnvelopeBytes = encodeNamespaceObjectEnvelopeV2(
      wrapObjectDekForNamespace(
        scenario.crypto,
        currentGeneration.key,
        {
          objectId: objectId(historicalObjectId),
          namespaceId: namespaceId(NAMESPACE_ID),
          keyClass: "ai",
          keyGeneration: namespaceGeneration(currentGeneration.generation),
          bindingRevisionAtWrap: accessRevision(ACCESS_REVISION),
        },
        historicalEncrypted.dek,
      ),
    );
    historicalEncrypted.dek.fill(0);
    const historicalAccess = prepareHumanObjectAccessManifestGenesisSet(
      scenario.crypto,
      {
        objectId: historicalObjectId,
        payloadHash: scenario.crypto.hash(historicalPayloadBytes),
        envelopeBytes: [historicalEnvelopeBytes],
        sourceAuthorized: true,
        targetAuthorized: true,
        subjectHumanId: REQUESTER_ID,
        committerDeviceId: "task-result-manager",
        hostAuthorizationRevision: 2,
        committerSigningPublicKey: scenario.manager.publicKey,
        committerSigningPrivateKey: scenario.manager.privateKey,
      },
    );
    const historicalRepair = Object.freeze({
      version: 2 as const,
      claimId: "70000000-0000-4000-8000-000000000001",
      publisherDeviceId: "task-result-manager",
      signedRequestDigest: "11".repeat(32),
      sourceDigest: Buffer.from(historicalSourceDigest).toString("hex"),
      sourcePayloadHash: "22".repeat(32),
      sourceRevision: 0 as const,
      genesisManifestHash: Buffer.from(
        scenario.crypto.hash(historicalAccess.manifestBytes),
      ).toString("hex"),
    });
    const historicalResultEnvelope = Object.freeze({
      readVersion: 1 as const,
      status: "ready" as const,
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      objectId: historicalObjectId,
      resultRevision: 1 as const,
      cryptoAccessRevision: 0 as const,
      namespaceId: NAMESPACE_ID,
      readAuthority: taskReadAuthority(),
      encryptedPayloadBytesBase64url:
        Buffer.from(historicalPayloadBytes).toString("base64url"),
      accessManifestBytesBase64url:
        Buffer.from(historicalAccess.manifestBytes).toString("base64url"),
      accessManifestProofBytesBase64url: [] as [],
      namespaceEnvelopeBytesBase64url:
        Buffer.from(historicalEnvelopeBytes).toString("base64url"),
      historicalRepair,
      signerEvidence: [Object.freeze({
        kind: "human_device" as const,
        subjectHumanId: REQUESTER_ID,
        committerDeviceId: historicalRepair.publisherDeviceId,
        hostAuthorizationRevision: 2,
        signingPublicKeyBase64url:
          Buffer.from(scenario.manager.publicKey).toString("base64url"),
      })],
    });
    if (retained !== v4) destroyOpenedClientDeviceProfileV4(retained);
    destroyOpenedClientDeviceProfileV4(v4);
    destroyOpenedClientDeviceProfileV3(v3);
    v2Bytes.fill(0);
    v3Bytes.fill(0);
    for (const generation of keyring.generations) generation.key.fill(0);
    const vault = new MemoryClientProfileVault();
    await vault.unlock();
    await vault.stageProfile({
      coordinates,
      stageId: "stage:result",
      generation: 1,
      profileBytes,
      publicState: { clientKind: "browser", publicFingerprint: "34".repeat(32) },
    });
    await vault.activateProfile(coordinates, "stage:result");
    profileBytes.fill(0);
    const anchors = new Map<string, TrustedMinimumObjectAccessHead>();
    const resultEnvelope = {
      readVersion: 1 as const,
      status: "ready" as const,
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      objectId: prepared.objectId,
      resultRevision: 1 as const,
      cryptoAccessRevision: 0 as const,
      namespaceId: NAMESPACE_ID,
      readAuthority: taskReadAuthority(),
      encryptedPayloadBytesBase64url: Buffer.from(
        snapshot.object.payloadBytes.ciphertext,
      ).toString("base64url"),
      accessManifestBytesBase64url: Buffer.from(
        snapshot.access.manifestBytes,
      ).toString("base64url"),
      accessManifestProofBytesBase64url: [] as [],
      namespaceEnvelopeBytesBase64url: Buffer.from(
        snapshot.access.envelopeBytes[0],
      ).toString("base64url"),
      signerEvidence: [{
        kind: "agent_runtime_publication" as const,
        evidenceBytesBase64url: Buffer.from(
          encodeAgentRuntimeSignerPublicationV1(
            scenario.initialized.signerPublication,
          ),
        ).toString("base64url"),
      }],
    };
    const resultSigner = deriveAgentRuntimeObjectSignerPublic(
      scenario.crypto,
      scenario.initialized.runtime,
    );
    const foregroundPlanBytes = encodeLiveShadowMessagePlanV4({
      formatVersion: 4,
      purpose: "message.live_shadow_plan",
      operationId: "task-result-accepted-execution",
      policyRevision: POLICY_REVISION,
      sessionId: TASK_ID,
      roomId: RUN_ID,
      humanMessageId: 1,
      revision: 0,
      createdAt: unixTimestamp(NOW),
      subjectHumanId: humanId(REQUESTER_ID),
      committerDeviceId: cryptoDeviceId(deviceId),
      committerDeviceSigningKeyGeneration: 1,
      hostAuthorizationRevision: authorizationRevision(2),
      recipientAgentId: agentId(AGENT_ID),
      agentAuthorizationRevision: authorizationRevision(4),
      agentRuntimeGeneration: scenario.initialized.runtime.generation,
      agentSignerKeyId: resultSigner.principal.signerKeyId,
      agentSignerPublicKey: Uint8Array.from(resultSigner.publicKey),
      namespaceId: namespaceId(NAMESPACE_ID),
      namespaceAccessRevision: accessRevision(ACCESS_REVISION),
      namespaceKeyGeneration: namespaceGeneration(0),
      namespaceHeadDigest: new Uint8Array(32).fill(0x71),
      namespacePublicationDigest: new Uint8Array(32).fill(0x72),
      namespacePublicationSetDigest: new Uint8Array(32).fill(0x73),
      namespaceAudienceFingerprint: new Uint8Array(32).fill(0x74),
      grantDomainId: DOMAIN_ID,
      grantDomainParticipantDigest: new Uint8Array(32).fill(0x75),
      grantDomainKeyGeneration: 1,
      grantDomainHeadDigest: new Uint8Array(32).fill(0x76),
      grantDomainPublicationDigest: new Uint8Array(32).fill(0x77),
      grantDomainAuthorizationRevision: authorizationRevision(2),
      namespaceBundleGrantDomainAuthorizationRevision: authorizationRevision(2),
      namespaceBundleRevision: 1,
      namespaceBundleDigest: new Uint8Array(32).fill(0x78),
      authorization: {
        disposition: "authorization_reusable",
        sessionReference: "task-result-accepted-session",
        authorizationDigest: new Uint8Array(32).fill(0x79),
      },
      attemptCoordinate: "task-result-accepted-attempt",
      issuedAt: unixTimestamp(NOW),
      deadlineAt: unixTimestamp(NOW + 30_000),
    });
    const foregroundEvidence = {
      kind: "foreground_agent_accepted_execution" as const,
      planBytesBase64url: Buffer.from(foregroundPlanBytes).toString("base64url"),
      planDigestBase64url: Buffer.from(
        scenario.crypto.hash(foregroundPlanBytes),
      ).toString("base64url"),
    };
    const foregroundResultEnvelope = {
      ...resultEnvelope,
      signerEvidence: [foregroundEvidence],
    };
    let response: ProtectedTaskRunResultReadEnvelopeV1 = foregroundResultEnvelope;
    const api = {
      getProtectedTaskRunResultEnvelopeV1: () => Promise.resolve(response),
    } as Pick<NautiloApiClient, "getProtectedTaskRunResultEnvelopeV1">;
    const deviceInput: VaultHumanTaskRunResultReaderInputV1 = {
        crypto: scenario.crypto,
        vault,
        coordinates,
        subjectHumanId: REQUESTER_ID,
        now: () => NOW,
        resolveDeviceAdmissionStatus: () => Promise.resolve({
          responseVersion: 1,
          required: true,
          status: "admitted",
          deviceId,
          deviceGeneration: 1,
          expiresAt: NOW + 60_000,
        }),
        namespaceAuthority: {
          ensure: () => Promise.resolve({ status: "ready" as const }),
          synchronizeRecipients: () => Promise.resolve({ status: "ready" as const }),
          withOpenedAiGenerations: () => Promise.resolve({
            status: "unavailable" as const, reason: "unused",
          }),
          withOpenedGenerations: async <Value>(request: Parameters<NonNullable<
            import("../../src/client/message/namespace-authority-client.ts")
              .NamespaceAuthorityClient["withOpenedGenerations"]
          >>[0], use: (
            entries: readonly import("../../src/client/message/namespace-authority-client.ts")
              .OpenedNamespaceGeneration[],
          ) => Promise<Value> | Value) => ({
            status: "opened" as const,
            value: await use(request.authority.flatMap(authority =>
              authority.retainedGenerations.map(entry => ({
                namespaceId: namespaceId(authority.namespaceId),
                keyClass: "ai" as const,
                accessRevision: accessRevision(entry.accessRevision),
                generation: namespaceGeneration(entry.generation),
                generationKey: authorityKey,
                audienceFingerprint: entry.audienceFingerprint,
                headDigest: entry.headDigest,
              }))
            )),
          }),
        },
        createStageId: () => "stage:signer",
        accessAnchors: {
          load: (id) => Promise.resolve(anchors.get(id) ?? null),
          advance: ({ expected, next }) => {
            if ((anchors.get(next.objectId) ?? null) !== expected) {
              return Promise.resolve(false);
            }
            anchors.set(next.objectId, {
              ...next,
              payloadHash: next.payloadHash.slice(),
              manifestHash: next.manifestHash.slice(),
            });
            return Promise.resolve(true);
          },
        },
    };
    const reader = createAuthorizedHumanTaskRunResultReaderV1({
      api,
      device: createVaultHumanTaskRunResultReaderV1(deviceInput),
    });
    const request = { taskId: TASK_ID, taskRunId: RUN_ID, agentId: AGENT_ID };
    expect(await reader.read(request)).toEqual({
      status: "ready",
      payload: {
        formatVersion: 1,
        resultText: "Protected Task result",
        lastError: null,
      },
    });
    const decodedForegroundPlan = decodeLiveShadowMessagePlanV4(
      foregroundPlanBytes,
    );
    const wrongGenerationBytes = encodeLiveShadowMessagePlanV4({
      ...decodedForegroundPlan,
      agentRuntimeGeneration:
        decodedForegroundPlan.agentRuntimeGeneration + 1,
    });
    const wrongDigest = scenario.crypto.hash(foregroundPlanBytes);
    wrongDigest[0] = wrongDigest[0]! ^ 1;
    for (const signerEvidence of [
      [{
        ...foregroundEvidence,
        planDigestBase64url: Buffer.from(wrongDigest).toString("base64url"),
      }],
      [{
        ...foregroundEvidence,
        planBytesBase64url: Buffer.from(wrongGenerationBytes).toString("base64url"),
        planDigestBase64url: Buffer.from(
          scenario.crypto.hash(wrongGenerationBytes),
        ).toString("base64url"),
      }],
      [foregroundEvidence, foregroundEvidence],
    ]) {
      response = { ...foregroundResultEnvelope, signerEvidence };
      await reader.read(request).then(
        () => { throw new Error("substituted foreground result proof was accepted"); },
        error => expect(error).toBeInstanceOf(ClassifiedDataOperationError),
      );
    }
    wrongDigest.fill(0);
    wrongGenerationBytes.fill(0);
    decodedForegroundPlan.agentSignerPublicKey.fill(0);
    decodedForegroundPlan.namespaceHeadDigest.fill(0);
    decodedForegroundPlan.namespacePublicationDigest.fill(0);
    decodedForegroundPlan.namespacePublicationSetDigest.fill(0);
    decodedForegroundPlan.namespaceAudienceFingerprint.fill(0);
    decodedForegroundPlan.grantDomainParticipantDigest.fill(0);
    decodedForegroundPlan.grantDomainHeadDigest.fill(0);
    decodedForegroundPlan.grantDomainPublicationDigest.fill(0);
    decodedForegroundPlan.namespaceBundleDigest.fill(0);
    if (decodedForegroundPlan.authorization.disposition
      === "authorization_reusable") {
      decodedForegroundPlan.authorization.authorizationDigest.fill(0);
    }
    response = resultEnvelope;
    expect(await reader.read(request)).toMatchObject({
      status: "ready",
      payload: { resultText: "Protected Task result" },
    });
    response = historicalResultEnvelope;
    expect(await reader.read(request)).toEqual({
      status: "ready",
      payload: {
        formatVersion: 1,
        resultText: "Historical Task result",
        lastError: null,
      },
    });
    response = {
      ...historicalResultEnvelope,
      historicalRepair: {
        ...historicalRepair,
        genesisManifestHash: "ff".repeat(32),
      },
    };
    await reader.read(request).then(
      () => { throw new Error("wrong historical genesis was accepted"); },
      error => expect(error).toBeInstanceOf(ClassifiedDataOperationError),
    );
    response = resultEnvelope;
    response = {
      ...resultEnvelope,
      namespaceId: "40000000-0000-4000-8000-000000000099",
    };
    for (const attempted of [
      request,
      { ...request, agentId: "60000000-0000-4000-8000-000000000099" },
    ]) {
      await reader.read(attempted).then(
        () => { throw new Error("substituted result was accepted"); },
        (error: unknown) => {
          expect(error).toBeInstanceOf(ClassifiedDataOperationError);
          if (!(error instanceof ClassifiedDataOperationError)) return;
          expect(error.failureClass).toBe("integrity");
        },
      );
      response = resultEnvelope;
    }
    response = {
      ...resultEnvelope,
      objectId: deriveTaskContentCryptoObjectIdV1({
        kind: "run_result",
        taskId: TASK_ID,
        taskRunId: RUN_ID,
        contentRevision: 2,
      }),
      resultRevision: 2,
    };
    await reader.read(request).then(
      () => { throw new Error("revision-substituted ciphertext was accepted"); },
      (error: unknown) => {
        expect(error).toBeInstanceOf(ClassifiedDataOperationError);
        if (!(error instanceof ClassifiedDataOperationError)) return;
        expect(error.failureClass).toBe("integrity");
      },
    );
    response = resultEnvelope;
    const wrongSubject = createAuthorizedHumanTaskRunResultReaderV1({
      api,
      device: createVaultHumanTaskRunResultReaderV1({
        ...deviceInput,
        subjectHumanId: "30000000-0000-4000-8000-000000000099",
      }),
    });
    await wrongSubject.read(request).then(
      () => { throw new Error("wrong Human subject was accepted"); },
      (error: unknown) => {
        expect(error).toBeInstanceOf(ClassifiedDataOperationError);
        if (!(error instanceof ClassifiedDataOperationError)) return;
        expect(error.failureClass).toBe("integrity");
      },
    );
  });

  test("rejects result, Namespace, and signer substitution before publication", async () => {
    const scenario = await setup(2);
    const wrongNamespace = await setup(
      3,
      "40000000-0000-4000-8000-000000000099",
    );
    expect(withTaskRuntimeExecutionEvidenceV1({
      evidence: {
        ...scenario.evidence,
        result: {
          ...scenario.evidence.result,
          objectId: "substituted-result-object",
        },
      },
      signal: new AbortController().signal,
      now: () => NOW,
      execute: (evidence) =>
        prepareTaskRuntimeRunResult(prepareInput(scenario, evidence)),
    })).rejects.toThrow("coordinate or authority disagrees");

    expect(withTaskRuntimeExecutionEvidenceV1({
      evidence: scenario.evidence,
      signal: new AbortController().signal,
      now: () => NOW,
      execute: (evidence) => prepareTaskRuntimeRunResult({
        ...prepareInput(scenario, evidence),
        namespace: {
          trustedHead: wrongNamespace.trustedHead,
          aiKeyringEnvelope: wrongNamespace.aiEnvelope,
          currentDomainRoot: wrongNamespace.aiDomainRoot,
          resolveHistoricalCommitter: () =>
            wrongNamespace.namespaceCommitter.publicKey,
        },
      }),
    })).rejects.toThrow("authority was substituted");

    expect(withTaskRuntimeExecutionEvidenceV1({
      evidence: scenario.evidence,
      signal: new AbortController().signal,
      now: () => NOW,
      execute: (evidence) => prepareTaskRuntimeRunResult({
        ...prepareInput(scenario, evidence),
        signerPublication: {
          ...scenario.initialized.signerPublication,
          signature: new Uint8Array(
            scenario.initialized.signerPublication.signature.length,
          ).fill(0x7f),
        },
      }),
    })).rejects.toThrow("authority was substituted");
  });

  test("fails closed when Task execution evidence expires or is revoked", async () => {
    const scenario = await setup(4);
    let now = NOW;
    expect(withTaskRuntimeExecutionEvidenceV1({
      evidence: scenario.evidence,
      signal: new AbortController().signal,
      now: () => now,
      execute: (evidence) => {
        now = scenario.evidence.expiresAt;
        return prepareTaskRuntimeRunResult(prepareInput(scenario, evidence));
      },
    })).rejects.toThrow("evidence is not active");

    const controller = new AbortController();
    expect(withTaskRuntimeExecutionEvidenceV1({
      evidence: scenario.evidence,
      signal: controller.signal,
      now: () => NOW,
      execute: (evidence) => {
        controller.abort();
        return prepareTaskRuntimeRunResult(prepareInput(scenario, evidence));
      },
    })).rejects.toThrow("evidence is not active");
  });
});

describe("Task Runtime checkpoint Namespace authority", () => {
  test("opens Task-owned retained keys only during a live grant and rechecks before commit", async () => {
    const scenario = await setup();
    const controller = new AbortController();
    const identity = {
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      sourceRoomId: scenario.evidence.sourceRoomId,
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      expectedAccessRevision: ACCESS_REVISION,
      expectedPolicyRevision: POLICY_REVISION,
    };
    let authorityChecks = 0;
    let retainedKey: Uint8Array | null = null;
    const result = await withTaskRuntimeExecutionEvidenceV1({
      evidence: scenario.evidence,
      signal: controller.signal,
      now: () => NOW,
      execute: evidence => withTaskRuntimeCheckpointNamespace({
        crypto: scenario.crypto,
        evidence,
        identity,
        namespace: prepareInput(scenario, evidence).namespace,
        signal: controller.signal,
        assertCurrentTaskAuthority: async () => { authorityChecks += 1; },
        execute: async (material, assertCommitAllowed) => {
          expect(material.namespaceId).toBe(NAMESPACE_ID);
          expect(material.generations.length).toBeGreaterThan(0);
          retainedKey = material.generations[0]!.key;
          expect(retainedKey.some(value => value !== 0)).toBe(true);
          await assertCommitAllowed();
          return "checkpoint-written";
        },
      }),
    });
    expect(result).toBe("checkpoint-written");
    expect(authorityChecks).toBe(2);
    expect(retainedKey).not.toBeNull();
    expect(retainedKey!.every(value => value === 0)).toBe(true);
  });

  test("rejects source-Room substitution before opening checkpoint keys", async () => {
    const scenario = await setup();
    const controller = new AbortController();
    let opened = false;
    const failure = await withTaskRuntimeExecutionEvidenceV1({
      evidence: scenario.evidence,
      signal: controller.signal,
      now: () => NOW,
      execute: evidence => withTaskRuntimeCheckpointNamespace({
        crypto: scenario.crypto,
        evidence,
        identity: {
          taskId: TASK_ID,
          taskRunId: RUN_ID,
          sourceRoomId: "substituted-room",
          namespaceId: NAMESPACE_ID,
          domainId: DOMAIN_ID,
          expectedAccessRevision: ACCESS_REVISION,
          expectedPolicyRevision: POLICY_REVISION,
        },
        namespace: prepareInput(scenario, evidence).namespace,
        signal: controller.signal,
        assertCurrentTaskAuthority: async () => undefined,
        execute: () => { opened = true; return "wrong"; },
      }),
    }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect(opened).toBe(false);
  });

});
