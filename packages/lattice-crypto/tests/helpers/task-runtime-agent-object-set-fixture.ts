import {
  prepareAgentRuntimeInitializationV2,
} from "../../src/agent-runtime/storage-coordinator.ts";
import type {
  TaskRuntimeExecutionEvidenceInputV1,
  TaskRuntimeExecutionEvidenceV1,
} from "../../src/background/task-runtime-execution-evidence-v1.ts";
import {
  withTaskRuntimeExecutionEvidenceV1,
} from "../../src/background/task-runtime-execution-evidence-v1.ts";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  encodeNamespaceObjectEnvelopeV2,
} from "../../src/format/object-v2.ts";
import {
  prepareTaskRuntimeAgentObjectAccessManifestGenesisSetV1,
  type PreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1,
  type PrepareTaskRuntimeAgentObjectAccessManifestGenesisSetInputV1,
} from "../../src/object/task-runtime-agent-access-manifest-set-v1.ts";
import type {
  CurrentTaskRuntimeAgentObjectAccessGenesisSetAuthorizationV1,
} from "../../src/object/task-runtime-agent-storage-coordinator-v1.ts";
import type {
  ObjectAccessStateCasStorageV2,
} from "../../src/object/storage-coordinator.ts";
import { wrapObjectDekForNamespaceV2 } from "../../src/object/namespace-envelope.ts";
import {
  accessRevision,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId as checkedObjectId,
} from "../../src/v2-types/ids.ts";

export const NOW = 2_200_000_000_000;

export function bytes(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

export async function taskRuntimeAgentObjectSetFixture(seed = 90_001) {
  const crypto = new LatticeCrypto(seededRng(seed), { now: () => NOW });
  const manager = crypto.generateSigningKeyPair();
  const runtimeAuthorizationRevision = authorizationRevision(7);
  const initialized = await prepareAgentRuntimeInitializationV2({
    crypto,
    operationId: `task-agent-runtime-initialization-${seed}`,
    agentId: agentId(`task-agent-${seed}`),
    authorizationRevision: runtimeAuthorizationRevision,
    configObjects: [{
      objectId: `task-agent-config-${seed}`,
      configRevision: authorizationRevision(1),
      plaintextDek: bytes(0x21),
    }],
    domains: [],
    resolveCurrentDomainCommitterAuthority: () => null,
    manager: {
      managerHumanId: humanId(`task-manager-${seed}`),
      managerAuthorizationRevision: authorizationRevision(3),
      managerDeviceId: cryptoDeviceId(`task-manager-device-${seed}`),
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  const objectId = checkedObjectId(`task-agent-object-${seed}`);
  const payloadBytes = new Uint8Array(96).fill(0x41);
  const domainFacts = [
    {
      domainId: cryptoDomainId(`task-domain-a-${seed}`),
      sourceNamespaceId: namespaceId(`task-namespace-a-${seed}`),
      participantDigest: bytes(0x31),
      participantCount: 2,
      keyClass: "ai" as const,
      domainKeyGeneration: 4,
      authorizationRevision: authorizationRevision(11),
      headDigest: bytes(0x32),
      activeNamespaceBindingSetDigest: bytes(0x33),
      activeNamespaceBindingCount: 2,
    },
    {
      domainId: cryptoDomainId(`task-domain-b-${seed}`),
      sourceNamespaceId: namespaceId(`task-namespace-c-${seed}`),
      participantDigest: bytes(0x34),
      participantCount: 1,
      keyClass: "ai" as const,
      domainKeyGeneration: 6,
      authorizationRevision: authorizationRevision(13),
      headDigest: bytes(0x35),
      activeNamespaceBindingSetDigest: bytes(0x36),
      activeNamespaceBindingCount: 1,
    },
  ];
  const namespaceFacts = [
    {
      namespaceId: namespaceId(`task-namespace-a-${seed}`),
      accessRevision: accessRevision(5),
      keyGeneration: namespaceGeneration(2),
      domain: domainFacts[0]!,
      headDigest: bytes(0x51),
      publicationDigest: bytes(0x52),
      publicationSetDigest: bytes(0x53),
      audienceFingerprint: bytes(0x54),
    },
    {
      namespaceId: namespaceId(`task-namespace-b-${seed}`),
      accessRevision: accessRevision(7),
      keyGeneration: namespaceGeneration(3),
      domain: domainFacts[0]!,
      headDigest: bytes(0x55),
      publicationDigest: bytes(0x56),
      publicationSetDigest: bytes(0x57),
      audienceFingerprint: bytes(0x58),
    },
    {
      namespaceId: namespaceId(`task-namespace-c-${seed}`),
      accessRevision: accessRevision(9),
      keyGeneration: namespaceGeneration(4),
      domain: domainFacts[1]!,
      headDigest: bytes(0x59),
      publicationDigest: bytes(0x5a),
      publicationSetDigest: bytes(0x5b),
      audienceFingerprint: bytes(0x5c),
    },
  ];
  const nativeNamespaces = namespaceFacts.map((entry) => ({
    namespaceId: entry.namespaceId,
    accessRevision: entry.accessRevision,
    keyGeneration: entry.keyGeneration,
    domainId: entry.domain.domainId,
    domainKeyGeneration: entry.domain.domainKeyGeneration,
    domainAuthorizationRevision: entry.domain.authorizationRevision,
    domainHeadDigest: entry.domain.headDigest,
    headDigest: entry.headDigest,
    publicationDigest: entry.publicationDigest,
    publicationSetDigest: entry.publicationSetDigest,
    audienceFingerprint: entry.audienceFingerprint,
  }));
  const evidence = {
    requestId: `task-request-${seed}`,
    workId: `task-run-${seed}`,
    claimId: `task-claim-${seed}`,
    claimExpiresAt: NOW + 60_000,
    recipientExpiresAt: NOW + 90_000,
    expiresAt: NOW + 60_000,
    recipientGeneration: 4,
    recipientKeyId: `task-recipient-${seed}`,
    authorizationDigest: bytes(0x61),
    policyRevision: 17,
    episodeId: `task-episode-${seed}`,
    sourceRoomId: `task-room-${seed}`,
    hostAuthorizationRevision: 19,
    recipientAuthorizationRevision: 23,
    result: {
      taskId: `task-${seed}`,
      taskRunId: `task-run-${seed}`,
      contentRevision: 1,
      objectId: `task-result-${seed}`,
      signerAgentId: initialized.runtime.agentId,
      namespace: {
        namespaceId: namespaceFacts[0]!.namespaceId,
        domainId: namespaceFacts[0]!.domain.domainId,
        operations: ["encrypt"],
        expectedAccessRevision: namespaceFacts[0]!.accessRevision,
        expectedPolicyRevision: 17,
      },
    },
    domainRequirements: domainFacts,
    namespaceRequirements: namespaceFacts.map((entry, ordinal) => ({
      ordinal,
      namespaceId: entry.namespaceId,
      domainId: entry.domain.domainId,
      operations: ordinal === 1
        ? ["encrypt"] as const
        : ["decrypt", "encrypt"] as const,
      expectedAccessRevision: entry.accessRevision,
      expectedPolicyRevision: 17,
    })),
  } as const satisfies TaskRuntimeExecutionEvidenceInputV1;

  const prepareInput = (
    activeEvidence: TaskRuntimeExecutionEvidenceV1,
    selectedIndexes: readonly number[],
  ): PrepareTaskRuntimeAgentObjectAccessManifestGenesisSetInputV1 => {
    const selectedNamespaces = selectedIndexes.map((index) =>
      nativeNamespaces[index]!
    );
    const envelopeBytes = selectedIndexes.map((index) => {
      const namespace = namespaceFacts[index]!;
      return encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespaceV2(
        crypto,
        bytes(0x70 + index),
        {
          objectId,
          namespaceId: namespace.namespaceId,
          keyClass: "ai",
          keyGeneration: namespace.keyGeneration,
          bindingRevisionAtWrap: namespace.accessRevision,
        },
        bytes(0x7a),
      ));
    });
    return {
      evidence: activeEvidence,
      objectId,
      payloadHash: crypto.hash(payloadBytes),
      envelopeBytes,
      operationId: `task-object-write-${seed}`,
      namespaces: selectedNamespaces,
      agentAuthorizationRevision: runtimeAuthorizationRevision,
      runtime: initialized.runtime,
      signerPublication: initialized.signerPublication,
      resolveHistoricalSignerPublicationManager: () => manager.publicKey,
    };
  };
  const prepare = (
    activeEvidence: TaskRuntimeExecutionEvidenceV1,
    selectedIndexes: readonly number[],
  ): PreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1 =>
    prepareTaskRuntimeAgentObjectAccessManifestGenesisSetV1(
      crypto,
      prepareInput(activeEvidence, selectedIndexes),
    );
  const currentAuthorization = (
    storage: ObjectAccessStateCasStorageV2,
  ): CurrentTaskRuntimeAgentObjectAccessGenesisSetAuthorizationV1 => ({
    storage,
    currentRuntime: {
      agentId: initialized.runtime.agentId,
      authorizationRevision: runtimeAuthorizationRevision,
      runtimeGeneration: initialized.runtime.generation,
    },
    signerPublication: structuredClone(initialized.signerPublication),
    currentManagerSigningPublicKey: manager.publicKey.slice(),
  });
  const withEvidence = <Value>(
    signal: AbortSignal,
    now: () => number,
    execute: (activeEvidence: TaskRuntimeExecutionEvidenceV1) =>
      Value | PromiseLike<Value>,
  ) => withTaskRuntimeExecutionEvidenceV1({
    evidence,
    signal,
    now,
    execute,
  });

  return {
    crypto,
    manager,
    initialized,
    objectId,
    payloadBytes,
    domainFacts,
    namespaceFacts,
    nativeNamespaces,
    evidence,
    prepareInput,
    prepare,
    currentAuthorization,
    withEvidence,
  };
}
