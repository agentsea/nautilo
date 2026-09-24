import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as v2 from "../../src/internal-v2.ts";
import type {
  CryptoDomainId,
  GrantV2,
  NamespaceBindingV2,
  V2GroupKeyProvider,
  V2Storage,
} from "../../src/internal-v2.ts";

// @ts-expect-error imported v1 model types must never enter the v2 surface
import type { Grant } from "../../src/internal-v2.ts";
// @ts-expect-error imported v1 engine must never enter the v2 surface
import type { LatticeCryptoEngine } from "../../src/internal-v2.ts";
// @ts-expect-error opaque constructors are internal storage-boundary tools
import type { opaqueBytes } from "../../src/internal-v2.ts";
// @ts-expect-error dummy bootstrap secrets must remain test-only
import type { DummyProviderBootstrapV2 } from "../../src/internal-v2.ts";
// @ts-expect-error plaintext Grant-secret roots must remain coordinator-internal
import type { GrantSecretDomainRootV2 } from "../../src/internal-v2.ts";
// @ts-expect-error opened provider candidate plaintext is device-internal
import type { OpenedProviderCandidateStateV2 } from "../../src/internal-v2.ts";

type RequiredV2Types = [
  CryptoDomainId,
  GrantV2,
  NamespaceBindingV2,
  V2GroupKeyProvider,
  V2Storage,
];

const requiredTypesCompile: RequiredV2Types | null = null;
const splitNamespaceMutatorsCompile: [
  "putBindingIfAbsent" extends keyof V2Storage ? true : false,
  "compareAndSwapNamespaceHead" extends keyof V2Storage ? true : false,
] = [false, false];
const unboundedDomainScanCompile:
  "listDomains" extends keyof V2Storage ? true : false = false;
const directRecoveryPutCompile:
  "putRecoveryArchive" extends keyof V2Storage ? true : false = false;

const EXPECTED_V2_RUNTIME_EXPORTS = Object.freeze([
  "AGENT_MANAGER_RECOVERY_DOMAIN",
  "AGENT_MANAGER_RECOVERY_VERSION",
  "AGENT_RUNTIME_DOMAIN_ENVELOPE_DOMAIN",
  "AGENT_RUNTIME_DOMAIN_ENVELOPE_FORMAT_VERSION",
  "AGENT_RUNTIME_HANDOFF_DOMAIN",
  "AGENT_RUNTIME_KEY_BYTES",
  "AGENT_RUNTIME_MANAGER_HANDOFF_DOMAIN",
  "AGENT_RUNTIME_ROTATION_MANAGER_SOURCE_PROOF_V2",
  "AI_DOMAIN_ROOT_EXPORTER_LABEL",
  "AgentRuntimeChallengeReservationOutcomeUnknownV2",
  "AgentRuntimeInitializationOutcomeUnknownV2",
  "AgentRuntimeRotationOutcomeUnknownV2",
  "DEVICE_TRANSFER_APPROVAL_DOMAIN",
  "DEVICE_TRANSFER_FORMAT_VERSION",
  "DEVICE_TRANSFER_KEYRING_DOMAIN",
  "DOMAIN_ROOT_BYTES",
  "DeviceProviderStateVaultV2",
  "ENCRYPTED_PAYLOAD_DOMAIN_V2",
  "ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2",
  "GRANT_V2_FORMAT_VERSION",
  "GRANT_V2_SCHEME",
  "GrantClaimOutcomeUnknownV2",
  "HUMAN_DOMAIN_ROOT_EXPORTER_LABEL",
  "HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_DOMAIN_V1",
  "HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_FORMAT_VERSION_V1",
  "HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_PURPOSE_V1",
  "HUMAN_MEMORY_CONTENT_EMBEDDING_PROCESSOR_CONTRACT_VERSION_V2",
  "HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_DIMENSIONS_V2",
  "HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_DOMAIN_V2",
  "HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_FORMAT_VERSION_V2",
  "HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_CONTENT_BYTES_V2",
  "HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_NAMESPACE_ENVELOPES_V2",
  "HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_TTL_MS_V2",
  "HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_PURPOSE_V2",
  "HUMAN_RECOVERY_ARCHIVE_DOMAIN",
  "HUMAN_RECOVERY_FORMAT_VERSION",
  "HumanRecoveryArchivePersistenceOutcomeUnknownV2",
  "InMemoryV2Store",
  "LatticeCrypto",
  "MAX_HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1",
  "MAX_HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_WIRE_BYTES_V2",
  "MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5",
  "NAMESPACE_BINDING_DOMAIN",
  "NAMESPACE_BINDING_FORMAT_VERSION",
  "NAMESPACE_KEYRING_DOMAIN",
  "NAMESPACE_KEYRING_FORMAT_VERSION",
  "NAMESPACE_KEY_BYTES",
  "NAMESPACE_OBJECT_ENVELOPE_DOMAIN_V2",
  "NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2",
  "NAMESPACE_RECOVERY_PACKAGE_DOMAIN",
  "NamespaceBindingPersistenceOutcomeUnknownV2",
  "OBJECT_ACCESS_MANIFEST_DOMAIN_V2",
  "OBJECT_ACCESS_MANIFEST_DOMAIN_V5",
  "OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V2",
  "OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V5",
  "ObjectAccessPersistenceOutcomeUnknownV2",
  "OpenMlsV2GroupProvider",
  "PARTICIPANT_DIGEST_DOMAIN",
  "ProviderCandidateStateError",
  "ProviderTransitionOutcomeUnknownV2",
  "RECOVERY_DEVICE_ACTIVATION_DOMAIN",
  "RECOVERY_PUBLIC_KEY_DIGEST_BYTES",
  "SIGNING_PUBLIC_KEY_BYTES",
  "TsMlsV2GroupProvider",
  "V2LimitError",
  "V2ProviderStateError",
  "V2ValidationError",
  "V2_LIMITS",
  "V2_PROVIDER_STATE_FORMAT_VERSION",
  "V2_PROVIDER_STATE_MAX_BYTES",
  "V2_PROVIDER_TRANSITION_FORMAT_VERSION",
  "abortGrantAuthoritySetUseV2",
  "abortGrantUseV2",
  "accessRevision",
  "agentId",
  "agentManagerRecoveryPackageAad",
  "agentManagerRecoveryPackageSigningBytes",
  "agentRuntimeConfigDekAadV2",
  "agentRuntimeConfigInventoryCommitmentV2",
  "agentRuntimeDomainEnvelopeAad",
  "agentRuntimeDomainEnvelopeSigningBytes",
  "agentRuntimeGeneration",
  "aggregateAgentRuntimeRotationV2",
  "answerRecoveryDeviceActivationChallengeV2",
  "appendNamespaceGeneration",
  "assertAgentRuntimeDomainEnvelope",
  "assertAgentRuntimeGeneration",
  "assertAuthenticPreparedAgentMemoryDeletionV1",
  "assertAuthenticPreparedAgentObjectAccessManifestGenesisSetV3",
  "assertAuthenticPreparedAgentObjectAccessManifestUpdateSetV3",
  "assertAuthenticPreparedHumanMemoryDeletionV1",
  "assertAuthenticPreparedHumanObjectAccessManifestGenesisSetV1",
  "assertCanonicalAgentManagerKeyring",
  "assertCanonicalHumanRecoveryArchive",
  "assertCanonicalNamespaceKeyring",
  "assertEnvelopeAuthorizedV2",
  "assertNamespaceBinding",
  "assertNamespaceKeyringEnvelope",
  "assertNamespaceRecoveryPackage",
  "assertPortableId",
  "assertTrustedCurrentRecoveryKey",
  "assertU64Counter",
  "assertV2Limit",
  "assertV2Range",
  "assertVerifiedNamespaceBindingHead",
  "assessRecoveryDeviceReadinessV2",
  "authorizationRevision",
  "canonicalizeParticipants",
  "compareUnsignedUtf8",
  "coordinateGrantAuthoritySetUseV2",
  "coordinateGrantUseV2",
  "coordinateProviderTransitionV2",
  "createAgentObjectAccessManifestV5",
  "createAgentRuntimeGeneration",
  "createHumanObjectAccessManifestV5",
  "createInitialNamespaceKeyrings",
  "createNamespaceBinding",
  "createObjectAccessManifestV2",
  "createProcessorObjectAccessManifestV5",
  "cryptoDeviceId",
  "cryptoDomainId",
  "decodeAgentManagerKeyring",
  "decodeAgentManagerRecoveryPackage",
  "decodeAgentRuntimeGeneration",
  "decodeDeviceTransferApproval",
  "decodeEncryptedPayloadV2",
  "decodeHumanExistingMessageRepresentationPublicationRequestV1",
  "decodeHumanMemoryContentEmbeddingRequestV2",
  "decodeHumanRecoveryArchive",
  "decodeNamespaceKeyring",
  "decodeNamespaceObjectEnvelopeV2",
  "decodeNamespaceRecoveryPackage",
  "decodeObjectAccessManifestV2",
  "decodeObjectAccessManifestV5",
  "decodeObjectAccessStorageManifest",
  "decodeRecoveryDeviceActivationChallenge",
  "decodeRecoveryDeviceActivationProof",
  "decryptObjectBatchV2",
  "decryptObjectPayloadV2",
  "decryptObjectThroughNamespaceV2",
  "deduplicateAgentRuntimeDomains",
  "destroyAgentRuntimeRotationSourceLocalV2",
  "deviceTransferApprovalSigningBytes",
  "deviceTransferInventoryDigestV2",
  "deviceTransferInventoryRevision",
  "deviceTransferPackageAad",
  "digestPublicKey",
  "domainEpoch",
  "domainRootExporterContext",
  "encodeAgentManagerKeyring",
  "encodeAgentRuntimeGeneration",
  "encodeEncryptedPayloadV2",
  "encodeHumanExistingMessageRepresentationPublicationRequestV1",
  "encodeHumanMemoryContentEmbeddingRequestV2",
  "encodeNamespaceKeyring",
  "encodeNamespaceObjectEnvelopeV2",
  "encodeObjectAccessManifestV2",
  "encodeObjectAccessManifestV5",
  "encryptObjectBatchV2",
  "encryptObjectPayloadV2",
  "encryptedObjectWriteRecordV2",
  "encryptedPayloadAadV2",
  "enumerateGrantDomains",
  "exportDomainRoot",
  "findOrCreateCryptoDomain",
  "grantId",
  "grantV2SigningBytes",
  "grantWriteRecordV2",
  "humanExistingMessageRepresentationPublicationRequestSigningBytesV1",
  "humanId",
  "humanMemoryContentEmbeddingRequestSigningBytesV2",
  "humanRecoveryArchiveSigningBytes",
  "mintGrantV2",
  "namespaceBindingHash",
  "namespaceBindingSigningBytes",
  "namespaceGeneration",
  "namespaceId",
  "namespaceKeyringEnvelopeAad",
  "namespaceKeyringEnvelopeHash",
  "namespaceKeyringEnvelopeSigningBytes",
  "namespaceKeyringsEqual",
  "namespaceObjectEnvelopeAadV2",
  "namespaceRecoveryPackageAad",
  "namespaceRecoveryPackageSigningBytes",
  "normalizeEncryptedPayloadContextV2",
  "normalizeNamespaceObjectEnvelopeContextV2",
  "objectAccessManifestSigningBytesV2",
  "objectAccessManifestSigningBytesV5",
  "objectId",
  "openAgentManagerRecoveryPackage",
  "openAgentRuntimeFromDomain",
  "openDeviceTransferV2",
  "openHumanRecoveryArchiveV2",
  "openNamespaceKeyring",
  "openObjectDekForNamespaceV2",
  "parseAgentRuntimeDomainEnvelope",
  "parseGrantV2",
  "parseNamespaceBinding",
  "parseNamespaceKeyringEnvelope",
  "participantDigest",
  "participantDigestInput",
  "pendingDeviceRevision",
  "persistAgentRuntimeInitializationV2",
  "persistAgentRuntimeRotationV2",
  "persistNamespaceBindingV2",
  "persistPreparedAgentObjectAccessManifestGenesisV3",
  "persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1",
  "persistPreparedHumanObjectAccessManifestGenesisSetV1",
  "persistPreparedObjectAccessManifestGenesisV2",
  "persistPreparedObjectAccessManifestUpdateV2",
  "persistPublishedHumanRecoveryArchiveV2",
  "portableIdIsValid",
  "preflightGrantAuthoritySetUseV2",
  "preflightGrantUseV2",
  "prepareAgentMemoryDeletionV1",
  "prepareAgentObjectAccessManifestGenesisSetV3",
  "prepareAgentObjectAccessManifestGenesisV3",
  "prepareAgentObjectAccessManifestUpdateSetV3",
  "prepareAgentRuntimeHandoffChallenge",
  "prepareAgentRuntimeHandoffResponse",
  "prepareAgentRuntimeHandoffTarget",
  "prepareAgentRuntimeInitializationV2",
  "prepareAgentRuntimeManagerHandoffChallenge",
  "prepareAgentRuntimeManagerHandoffResponse",
  "prepareAgentRuntimeManagerHandoffTarget",
  "prepareAgentRuntimeRotationSourceV2",
  "prepareDeviceTransferV2",
  "prepareDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1",
  "prepareDomainEpochAdvanceV2",
  "prepareHumanExistingMessageRepresentationPublicationRequestV1",
  "prepareHumanMemoryContentEmbeddingRequestV2",
  "prepareHumanMemoryDeletionV1",
  "prepareHumanNamespaceRebindV2",
  "prepareHumanObjectAccessManifestGenesisSetV1",
  "prepareNamespaceKeyringRevision",
  "prepareObjectAccessManifestGenesisV2",
  "prepareObjectAccessManifestGenesisWithTombstoneV2",
  "prepareObjectAccessManifestUpdateV2",
  "prepareRecoveryDeviceActivationChallengeV2",
  "publishAgentManagerRecoveryPackage",
  "publishHumanRecoveryArchiveV2",
  "recoveryKeyGeneration",
  "recoveryPublicKeyDigest",
  "recoveryReadinessDigest",
  "resealNamespaceKeyring",
  "reserveAgentRuntimeRotationChallengesV2",
  "resolveAuthorizedNamespaceObjectKeyV2",
  "sealAgentRuntimeToDomain",
  "sealNamespaceKeyring",
  "serializeAgentManagerRecoveryPackage",
  "serializeAgentRuntimeDomainEnvelope",
  "serializeDeviceTransferApproval",
  "serializeGrantV2",
  "serializeHumanRecoveryArchive",
  "serializeNamespaceBinding",
  "serializeNamespaceKeyringEnvelope",
  "serializeNamespaceRecoveryPackage",
  "serializeRecoveryDeviceActivationChallenge",
  "serializeRecoveryDeviceActivationProof",
  "systemClock",
  "systemRng",
  "unixTimestamp",
  "verifyBindingEnvelopePair",
  "verifyHumanExistingMessageRepresentationPublicationRequestExactReplayV1",
  "verifyHumanExistingMessageRepresentationPublicationRequestV1",
  "verifyHumanMemoryContentEmbeddingRequestV2",
  "verifyNamespaceBinding",
  "verifyNamespaceBindingProof",
  "verifyNamespaceKeyringEnvelope",
  "verifyObjectAccessManifestChainV2",
  "verifyObjectAccessManifestChainV5",
  "verifyObjectAccessManifestV5",
  "verifyRecoveryDeviceActivationProofV2",
  "verifyRecoveryDeviceReadinessV2",
  "withGrantAuthoritySetExecutionEvidenceNamespaceSubsetV2",
  "withGrantAuthoritySetExecutionEvidenceSubsetV2",
  "wrapObjectDekForNamespaceV2",
] as const);

function signingKeyLimitViolations(source: string): number[] {
  const lines = source.split("\n");
  return lines.flatMap((line, index) => {
    const isPublic = line.includes("V2_LIMITS.signingPublicKeyBytes");
    const isPrivate = line.includes("V2_LIMITS.signingPrivateKeyBytes");
    if (!isPublic && !isPrivate) return [];
    const previous = lines.slice(Math.max(0, index - 4), index);
    // A neighboring completed statement is not this key's contract.
    const boundary = previous.map((contextLine) => contextLine.trimEnd().endsWith(";"))
      .lastIndexOf(true);
    const contract = [...previous.slice(boundary + 1), line].join(" ").toLowerCase();
    const expected = isPublic ? "public" : "private";
    const unexpected = isPublic ? "private" : "public";
    return !contract.includes(expected) || contract.includes(unexpected) ? [index + 1] : [];
  });
}

describe("frozen M225 internal v2 export inventory", () => {
  test("is an explicit value-and-type allowlist without implementation wildcards", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/internal-v2.ts", import.meta.url)),
      "utf8",
    );
    expect(source.match(/^export (?:type )?\*/gmu) ?? []).toEqual([]);
  });

  test("exports exactly the reviewed runtime allowlist", () => {
    expect(Object.keys(v2).sort()).toEqual([...EXPECTED_V2_RUNTIME_EXPORTS]);
  });

  test("keeps public and private signing-key limits attached to their own contracts", () => {
    const sourceRoot = fileURLToPath(new URL("../../src", import.meta.url));
    const sourceFiles = readdirSync(sourceRoot, {
      recursive: true,
      encoding: "utf8",
    }).filter((path) => path.endsWith(".ts"));

    for (const path of sourceFiles) {
      const source = readFileSync(`${sourceRoot}/${path}`, "utf8");
      expect(signingKeyLimitViolations(source).map((line) => `${path}:${line}`)).toEqual([]);
    }
  });

  test("key-limit contracts ignore adjacent statements but reject swapped limits", () => {
    expect(signingKeyLimitViolations([
      'const issuerDigests = ["signingPublicKeyHash"];',
      "const secretWireMaximum = 4 + domainKeyBytes",
      "  + V2_LIMITS.signingPrivateKeyBytes;",
      "const publicKeyMaximum = V2_LIMITS.signingPublicKeyBytes;",
    ].join("\n"))).toEqual([]);
    expect(signingKeyLimitViolations([
      "const publicKeyMaximum = V2_LIMITS.signingPrivateKeyBytes;",
      "const privateKeyMaximum = V2_LIMITS.signingPublicKeyBytes;",
    ].join("\n"))).toEqual([1, 2]);
    expect(signingKeyLimitViolations([
      'exactBytes("private; signing key", bytes,',
      "  V2_LIMITS.signingPublicKeyBytes);",
    ].join("\n"))).toEqual([2]);
  });

  test("contains the required v2 construction and workflow entry points", () => {
    expect(requiredTypesCompile).toBeNull();
    for (const symbol of [
      "LatticeCrypto",
      "findOrCreateCryptoDomain",
      "createInitialNamespaceKeyrings",
      "prepareHumanNamespaceRebindV2",
      "prepareDomainEpochAdvanceV2",
      "coordinateProviderTransitionV2",
      "encryptObjectBatchV2",
      "prepareObjectAccessManifestGenesisV2",
      "persistPreparedObjectAccessManifestGenesisV2",
      "persistPreparedObjectAccessManifestUpdateV2",
      "ObjectAccessPersistenceOutcomeUnknownV2",
      "preflightGrantUseV2",
      "abortGrantUseV2",
      "coordinateGrantUseV2",
      "prepareAgentRuntimeRotationSourceV2",
      "persistAgentRuntimeRotationV2",
      "prepareAgentRuntimeInitializationV2",
      "persistAgentRuntimeInitializationV2",
      "publishHumanRecoveryArchiveV2",
      "persistPublishedHumanRecoveryArchiveV2",
      "HumanRecoveryArchivePersistenceOutcomeUnknownV2",
      "encryptedObjectWriteRecordV2",
      "grantWriteRecordV2",
      "InMemoryV2Store",
      "TsMlsV2GroupProvider",
      "OpenMlsV2GroupProvider",
    ] as const) {
      expect(v2[symbol]).toBeDefined();
    }
  });

  test("does not expose imported v1 engines, formats, providers, or stores", () => {
    for (const symbol of [
      "LatticeCryptoEngine",
      "ENCRYPTED_OBJECT_FORMAT_VERSION",
      "GRANT_FORMAT_VERSION",
      "RECOVERY_KIT_FORMAT_VERSION",
      "DeviceStateVault",
      "DummyGroupProvider",
      "MlsGroupProvider",
      "OpenMlsGroupProvider",
      "EnumerationScheme",
      "InMemoryRelationalStore",
      "defineConformanceTests",
      "opaqueBytes",
      "cloneOpaqueBytes",
      "authenticatedAgentRuntimeConfigDekV2",
      "DummyV2GroupProvider",
      "DummyProviderBootstrapV2",
      "createDummyV2Bootstrap",
      "openGrantV2ForOperation",
      "putBindingIfAbsent",
      "compareAndSwapNamespaceHead",
      "objectAccessStorageStateV2",
      "authorizeProviderHeadWriteV2",
      "authorizedProviderHeadWriteV2",
      "mintAuthorizedProviderHeadWriteV2",
      "authorizeObjectAccessWriteV2",
      "hydrateNamespaceBindingRecordV2",
      "hydrateEncryptedObjectRecordV2",
      "hydrateObjectAccessStorageStateV2",
      "hydrateAgentRuntimeAtomicStorageStateV2",
      "hydrateGrantRecordV2",
      "hydrateRecoveryArchiveRecordV2",
      "recoveryArchiveWriteRecordV2",
      "namespaceBindingWriteRecordV2",
      "authorizeAgentRuntimeInitializationWriteV2",
      "authorizeAgentRuntimeChallengeReservationWriteV2",
      "authorizeAgentRuntimeRotationWriteV2",
      "assertBytes",
      "assertCompleteKeyring",
      "assertExactFields",
      "assertKeyClass",
      "currentGeneration",
      "equalBytes",
      "HASH_BYTES",
      "INVENTORY_COMMITMENT_FIELDS",
      "LIVE_DOMAIN_FIELDS",
      "MAX_METADATA_BYTES",
      "normalizeInventory",
      "predictedHpkeCiphertextBytes",
      "preflightInventoryShape",
      "readExactText",
      "READINESS_INVENTORY_FIELDS",
      "RECOVERY_CHALLENGE_FIELDS",
      "RECOVERY_KEY_FIELDS",
      "RECOVERY_PROOF_FIELDS",
      "RECOVERY_VERIFIER_FIELDS",
      "resolveExactInventoryCommitment",
      "resolvePending",
      "validatePendingCandidate",
      "V2_PROVIDER_CANDIDATE_SOURCE_ID",
      "agentRuntimeManagerHandoffPlansEqualV1",
      "agentRuntimeManagerHandoffRuntimeCommitmentV1",
      "assertAgentRuntimeRotationSourceLocalV2",
      "assertAuthenticPreparedObjectAccessManifestGenesisV2",
      "assertAuthenticPreparedObjectAccessManifestUpdateV2",
      "assertDeviceTransferApprovalWireLengthV2",
      "assertHumanRecoveryArchiveAggregateBytesV2",
      "assertOpenedHumanRecoveryArchiveV2",
      "assertPreparedAgentRuntimeManagerHandoffTarget",
      "candidatePayloadSnapshotV2",
      "cloneProviderHeadV2",
      "cloneProviderPublicTransitionV2",
      "destroyOpenedProviderCandidateStateV2",
      "markLocalProviderCandidateV2",
      "openLocalProviderCandidateV2",
      "parseGrantSecretV2",
      "providerHeadsEqualV2",
      "providerPublicTransitionDigestMatchesV2",
      "providerPublicTransitionDigestV2",
      "sealLocalProviderCandidateV2",
      "serializeGrantSecretV2",
      "verifyPreparedAgentRuntimeManagerHandoffTarget",
    ] as const) {
      expect(symbol in v2).toBe(false);
    }
  });

  test("exposes only the atomic Namespace binding/head mutation", () => {
    expect(splitNamespaceMutatorsCompile).toEqual([false, false]);
    expect(unboundedDomainScanCompile).toBe(false);
    const store = new v2.InMemoryV2Store();
    expect("putBindingIfAbsent" in store).toBe(false);
    expect("compareAndSwapNamespaceHead" in store).toBe(false);
    expect("compareAndSwapNamespaceBindingAndHead" in store).toBe(true);
    expect(directRecoveryPutCompile).toBe(false);
    expect("putRecoveryArchive" in store).toBe(false);
  });

  test("rejects a structural Namespace binding/head write at the supported storage surface", async () => {
    const store = new v2.InMemoryV2Store();
    const direct = store.compareAndSwapNamespaceBindingAndHead as unknown as (
      write: unknown,
    ) => Promise<unknown>;
    expect(direct.call(store, {
      expected: null,
      binding: {},
      next: {},
    })).rejects.toThrow("authorized write capability");
    expect(await store.getNamespaceHead("namespace-structural-bypass"))
      .toBeNull();
  });

  test("rejects a structural object-access write at the supported storage surface", async () => {
    const store = new v2.InMemoryV2Store();
    const direct = store.compareAndSwapObjectAccessState as unknown as (
      write: unknown,
    ) => Promise<unknown>;
    expect(direct.call(store, {
      expected: null,
      intended: {},
      authorization: {},
    })).rejects.toThrow("authorized object access write capability");
    expect(await store.getObjectAccessState("object-structural-bypass"))
      .toBeNull();
  });

  test("rejects structural Runtime initialization, reservation, rotation, and authorization-transition writes", async () => {
    const store = new v2.InMemoryV2Store();
    expect(store.putAgentRuntimeAtomicStateIfAbsent({
      state: {},
    } as never)).rejects.toThrow("authorized write capability");
    expect(store.compareAndSwapAgentRuntimeChallengeReservations({
      expected: {},
      additions: [],
    } as never)).rejects.toThrow("authorized write capability");
    expect(store.compareAndSwapAgentRuntimeRotation({
      expected: {},
      intended: {},
    } as never)).rejects.toThrow("authorized write capability");
    expect(store.compareAndSwapAgentRuntimeAuthorizationTransition({
      expected: {},
      intended: {},
      authorization: {},
    } as never)).rejects.toThrow("authorized write capability");
  });

  test("rejects a structural provider-head write at the supported storage surface", async () => {
    const store = new v2.InMemoryV2Store();
    const domainId = v2.cryptoDomainId("domain-public-provider-capability");
    const initial = {
      providerId: "provider-public-capability",
      domainId,
      epoch: v2.domainEpoch(0),
      stateHash: new Uint8Array(32).fill(0x41),
    };
    const rosterBytes = new Uint8Array([1, 2, 3]);
    await store.createDomainIfAbsent({
      id: domainId,
      participantDigest: v2.participantDigest([v2.humanId("alice")]),
      participants: [v2.humanId("alice")],
      epoch: v2.domainEpoch(0),
      authorizationRevision: v2.authorizationRevision(0),
      rosterBytes,
    });
    await store.putDomainProviderHeadIfAbsent(initial, rosterBytes);

    const direct = store.compareAndSwapDomainProviderHead as unknown as (
      write: unknown,
    ) => Promise<unknown>;
    expect(direct.call(store, {
      expected: initial,
      next: {
        ...initial,
        epoch: v2.domainEpoch(1),
        stateHash: new Uint8Array(32).fill(0x42),
      },
      nextRosterBytes: new Uint8Array([4, 5, 6]),
    })).rejects.toThrow("authorized provider-head write capability");
    expect(await store.getDomainProviderHead(domainId)).toEqual(initial);
  });

  test("constructs initial durable writes and exposes detached raw reads after restart", async () => {
    const crypto = new v2.LatticeCrypto();
    const deviceId = v2.cryptoDeviceId("device-public-hydration");
    const targetDomainId = v2.cryptoDomainId("domain-public-hydration");
    const payloadBytes = v2.encodeEncryptedPayloadV2({
      formatVersion: v2.ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
      context: {
        objectId: v2.objectId("object-public-hydration"),
        keyClass: "human",
        objectType: "public-hydration",
        createdAt: v2.unixTimestamp(1),
      },
      ciphertext: new Uint8Array(40).fill(0x31),
    });
    const objectCommitter = crypto.generateSigningKeyPair();

    const runtimeAgentId = v2.agentId("agent-public-hydration");

    const grantBytes = v2.serializeGrantV2({
      formatVersion: v2.GRANT_V2_FORMAT_VERSION,
      id: v2.grantId("grant-public-hydration"),
      issuingDeviceId: deviceId,
      recipientAgentId: runtimeAgentId,
      recipientKeyId: "recipient-key",
      scope: [v2.humanId("alice")],
      operations: ["decrypt"],
      issuedAt: 1,
      expiresAt: 2,
      coveredDomains: [{
        domainId: targetDomainId,
        domainEpoch: v2.domainEpoch(0),
        agentAuthorizationRevision: v2.authorizationRevision(0),
      }],
      encryptedSecret: new Uint8Array(40).fill(0x51),
      scheme: v2.GRANT_V2_SCHEME,
      signature: new Uint8Array(v2.V2_LIMITS.signatureBytes).fill(0x52),
      singleUse: true,
      consumed: false,
    });
    // The raw byte copies model database serialization plus a new process.
    const restarted = new v2.InMemoryV2Store();
    const object = v2.encryptedObjectWriteRecordV2(payloadBytes.slice());
    await restarted.putObject(object);
    const objectAccess = v2.prepareObjectAccessManifestGenesisV2(crypto, {
      objectId: v2.objectId("object-public-hydration"),
      payloadHash: crypto.hash(payloadBytes),
      envelopeBytes: [],
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: deviceId,
      hostAuthorizationRevision: v2.authorizationRevision(0),
      signingPrivateKey: objectCommitter.privateKey,
    });
    expect(
      await v2.persistPreparedObjectAccessManifestGenesisV2({
        crypto,
        storage: restarted,
        prepared: objectAccess,
        resolveCurrentAuthorization: (context) => ({
          ...context,
          sourceAuthorized: true,
          targetAuthorized: true,
          currentHostAuthorizationRevision: 0,
          committerSigningPublicKey: objectCommitter.publicKey,
        }),
      }),
    ).toBe("applied");

    await restarted.putGrant(v2.grantWriteRecordV2(grantBytes.slice()));

    expect(await restarted.getObject(object.objectId)).not.toBeNull();
    expect(
      await restarted.getObjectAccessState(object.objectId),
    ).not.toBeNull();
    expect(
      await restarted.getGrant("grant-public-hydration"),
    ).not.toBeNull();
  });

  test("root object genesis survives raw-adapter restart and fails closed", async () => {
    const crypto = new v2.LatticeCrypto();
    const signing = crypto.generateSigningKeyPair();
    const payloadBytes = v2.encodeEncryptedPayloadV2({
      formatVersion: v2.ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
      context: {
        objectId: v2.objectId("object-public-genesis"),
        keyClass: "human",
        objectType: "public-genesis",
        createdAt: v2.unixTimestamp(1),
      },
      ciphertext: new Uint8Array(40).fill(0x41),
    });
    const prepared = v2.prepareObjectAccessManifestGenesisV2(crypto, {
      objectId: v2.objectId("object-public-genesis"),
      payloadHash: crypto.hash(payloadBytes),
      envelopeBytes: [],
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: v2.cryptoDeviceId("device-public-genesis"),
      hostAuthorizationRevision: v2.authorizationRevision(4),
      signingPrivateKey: signing.privateKey,
    });
    const authorization:
      v2.ResolveCurrentObjectAccessGenesisAuthorizationV2 = (context) => ({
        ...context,
        sourceAuthorized: true,
        targetAuthorized: true,
        currentHostAuthorizationRevision: 4,
        committerSigningPublicKey: signing.publicKey,
      });
    const createBacking = async () => {
      const backing = new v2.InMemoryV2Store();
      await backing.putObject(
        v2.encryptedObjectWriteRecordV2(payloadBytes.slice()),
      );
      return backing;
    };
    const backing = await createBacking();
    const rawAdapter = (): v2.ObjectAccessStateCasStorageV2 => ({
      getObject: (id) => backing.getObject(id),
      compareAndSwapObjectAccessState: (authorized) =>
        backing.compareAndSwapObjectAccessState(authorized),
    });

    expect(
      await v2.persistPreparedObjectAccessManifestGenesisV2({
        crypto,
        storage: rawAdapter(),
        prepared,
        resolveCurrentAuthorization: authorization,
      }),
    ).toBe("applied");
    expect(
      await v2.persistPreparedObjectAccessManifestGenesisV2({
        crypto,
        // A fresh adapter instance models a process restart over durable rows.
        storage: rawAdapter(),
        prepared,
        resolveCurrentAuthorization: authorization,
      }),
    ).toBe("duplicate");

    const forgeryError = await v2
      .persistPreparedObjectAccessManifestGenesisV2({
        crypto,
        storage: rawAdapter(),
        prepared: { ...prepared },
        resolveCurrentAuthorization: authorization,
      })
      .catch((observed: unknown) => observed);
    expect(forgeryError).toBeInstanceOf(TypeError);
    expect((forgeryError as Error).message).toContain(
      "authentic prepared genesis",
    );

    const revokedBacking = await createBacking();
    let revokedCasAttempts = 0;
    expect(
      await v2.persistPreparedObjectAccessManifestGenesisV2({
        crypto,
        storage: {
          getObject: (id) => revokedBacking.getObject(id),
          compareAndSwapObjectAccessState: (authorized) => {
            revokedCasAttempts += 1;
            return revokedBacking.compareAndSwapObjectAccessState(
              authorized,
            );
          },
        },
        prepared,
        resolveCurrentAuthorization: () => null,
      }),
    ).toBe("stale");
    expect(revokedCasAttempts).toBe(0);

    const ambiguousBacking = await createBacking();
    const cause = new Error("raw adapter lost the genesis response");
    let ambiguousCasAttempts = 0;
    const error = await v2.persistPreparedObjectAccessManifestGenesisV2({
      crypto,
      storage: {
        getObject: (id) => ambiguousBacking.getObject(id),
        compareAndSwapObjectAccessState: async (authorized) => {
          ambiguousCasAttempts += 1;
          await ambiguousBacking.compareAndSwapObjectAccessState(
            authorized,
          );
          throw cause;
        },
      },
      prepared,
      resolveCurrentAuthorization: authorization,
    }).catch((observed: unknown) => observed);
    expect(error).toBeInstanceOf(
      v2.ObjectAccessPersistenceOutcomeUnknownV2,
    );
    expect((error as Error).cause).toBe(cause);
    expect(ambiguousCasAttempts).toBe(1);
    expect(
      await v2.persistPreparedObjectAccessManifestGenesisV2({
        crypto,
        storage: ambiguousBacking,
        prepared,
        resolveCurrentAuthorization: authorization,
      }),
    ).toBe("duplicate");
  });

  test("a raw durable adapter can restart a real Grant core workflow", async () => {
    const crypto = new v2.LatticeCrypto();
    const issuer = crypto.generateSigningKeyPair();
    const recipient = await crypto.generateEncryptionKeyPair();
    const grant = await v2.mintGrantV2(crypto, {
      id: v2.grantId("grant-public-raw-restart"),
      issuingDeviceId: v2.cryptoDeviceId("alice-phone"),
      issuingHumanId: v2.humanId("alice"),
      issuingDeviceSigningPrivateKey: issuer.privateKey,
      recipientAgentId: v2.agentId("genie"),
      recipientKeyId: "recipient-key",
      recipientEncryptionPublicKey: recipient.publicKey,
      scope: [v2.humanId("alice")],
      operations: ["decrypt"],
      issuedAt: 100,
      expiresAt: 200,
      coveredDomains: [{
        domainId: v2.cryptoDomainId("domain-alice"),
        domainEpoch: v2.domainEpoch(3),
        agentAuthorizationRevision: v2.authorizationRevision(5),
        aiRoot: new Uint8Array(32).fill(0xa5),
      }],
      singleUse: true,
    });
    const preflight = await v2.preflightGrantUseV2(crypto, grant, {
      now: 101,
      expectedIssuingDeviceId: v2.cryptoDeviceId("alice-phone"),
      issuingDeviceHumanId: v2.humanId("alice"),
      issuingDeviceSigningPublicKey: issuer.publicKey,
      issuingDeviceActive: true,
      recipientAgentId: v2.agentId("genie"),
      recipientKeyId: "recipient-key",
      recipientEncryptionPrivateKey: recipient.privateKey,
      operation: "decrypt",
      singleUseAvailable: true,
      namespaceId: v2.namespaceId("room-alice"),
      namespaceAccessRevision: v2.accessRevision(0),
      namespaceParticipants: [v2.humanId("alice")],
      domainId: v2.cryptoDomainId("domain-alice"),
      domainEpoch: v2.domainEpoch(3),
      agentAuthorizationRevision: v2.authorizationRevision(5),
      hostAllowsOperation: true,
    });
    if (preflight === null) throw new Error("expected Grant preflight");

    const durableBytes = v2.serializeGrantV2(grant);
    const rawAdapter: Pick<V2Storage, "consumeGrant"> = {
      consumeGrant: async (requestedId) => ({
        grantId: requestedId,
        grantBytes: durableBytes.slice(),
        consumed: true,
      }),
    };
    const result = await v2.coordinateGrantUseV2({
      preflight,
      storage: rawAdapter,
      resolveCurrentAuthorization: (context) => ({
        context,
        currentTime: 101,
        issuingDeviceActive: true,
        recipientAgentAuthorized: true,
        requestedNamespacesAuthorized: true,
        requestedDomainsAuthorized: true,
        hostAllowsOperation: true,
        currentSingleUseStatus: context.singleUseStatus,
      }),
      execute: (opened) => ({
        domainId: opened.domainId,
        root: opened.aiRoot.slice(),
      }),
    });

    expect(result.status).toBe("executed");
    if (result.status !== "executed") {
      throw new Error("expected executed Grant");
    }
    expect(result.value.domainId).toBe(v2.cryptoDomainId("domain-alice"));
    expect(result.value.root).toEqual(new Uint8Array(32).fill(0xa5));
  });

  test("root initialization survives a fake raw durable adapter restart", async () => {
    const crypto = new v2.LatticeCrypto();
    const managerSigning = crypto.generateSigningKeyPair();
    const prepared = await v2.prepareAgentRuntimeInitializationV2({
      crypto,
      operationId: "operation-public-initialization",
      agentId: v2.agentId("agent-public-initialization"),
      authorizationRevision: v2.authorizationRevision(2),
      configObjects: [{
        objectId: v2.objectId("config-public-initialization"),
        configRevision: v2.authorizationRevision(1),
        plaintextDek: new Uint8Array(32).fill(0x71),
      }],
      domains: [],
      resolveCurrentDomainCommitterAuthority: () => null,
      manager: {
        managerHumanId: v2.humanId("human-manager"),
        managerAuthorizationRevision: v2.authorizationRevision(2),
        managerDeviceId: v2.cryptoDeviceId("device-manager"),
      },
      managerSigningPrivateKey: managerSigning.privateKey,
      resolveCurrentManagerAuthority: () => managerSigning.publicKey,
    });
    let durable: v2.AgentRuntimeAtomicStorageWireV2 | null = null;
    let durableSignerPublication:
      typeof prepared.signerPublication | null = null;
    let puts = 0;
    const adapter: v2.AgentRuntimeInitializationStorageV2 = {
      getAgentRuntimeAtomicState: async () =>
        durable === null ? null : structuredClone(durable),
      getAgentRuntimeSignerPublication: async () =>
        durableSignerPublication === null
          ? null
          : structuredClone(durableSignerPublication),
      putAgentRuntimeAtomicStateIfAbsent: async (authorized) => {
        puts += 1;
        const intended = authorized.state;
        durable = {
          runtime: structuredClone(intended.runtime),
          configInventory: structuredClone(intended.configInventory),
          configObjects: intended.configObjects.map((entry) => ({
            agentId: entry.agentId,
            objectId: entry.objectId,
            configRevision: entry.configRevision,
            runtimeGeneration: entry.runtimeGeneration,
            wrappedDekHash: entry.wrappedDekHash.slice(),
            wrappedDekBytes: entry.wrappedDek.ciphertext.slice(),
          })),
          domainEnvelopes: intended.domainEnvelopes.map((entry) => ({
            agentId: entry.agentId,
            domainId: entry.domainId,
            domainEpoch: entry.domainEpoch,
            agentAuthorizationRevision: entry.agentAuthorizationRevision,
            runtimeGeneration: entry.runtimeGeneration,
            committerDeviceId: entry.committerDeviceId,
            envelopeHash: entry.envelopeHash.slice(),
            envelopeBytes: entry.envelopeBytes.ciphertext.slice(),
          })),
          challengeConsumptions: [],
        };
        durableSignerPublication =
          structuredClone(authorized.signerPublication);
        return "inserted";
      },
    };

    expect(await v2.persistAgentRuntimeInitializationV2({
      crypto,
      storage: adapter,
      prepared,
      resolveCurrentAuthorization: () => ({
        currentState: {
          agentId: prepared.runtime.agentId,
          authorizationRevision: v2.authorizationRevision(2),
          runtimeGeneration: v2.agentRuntimeGeneration(0),
        },
        currentManager: {
          managerHumanId: v2.humanId("human-manager"),
          managerAuthorizationRevision: v2.authorizationRevision(2),
          managerDeviceId: v2.cryptoDeviceId("device-manager"),
        },
        currentManagerSigningPublicKey: managerSigning.publicKey,
        domains: [],
      }),
    })).toBe("inserted");
    expect(await v2.persistAgentRuntimeInitializationV2({
      crypto,
      storage: adapter,
      prepared,
      resolveCurrentAuthorization: () => ({
        currentState: {
          agentId: prepared.runtime.agentId,
          authorizationRevision: v2.authorizationRevision(2),
          runtimeGeneration: v2.agentRuntimeGeneration(0),
        },
        currentManager: {
          managerHumanId: v2.humanId("human-manager"),
          managerAuthorizationRevision: v2.authorizationRevision(2),
          managerDeviceId: v2.cryptoDeviceId("device-manager"),
        },
        currentManagerSigningPublicKey: managerSigning.publicKey,
        domains: [],
      }),
    })).toBe("duplicate");
    expect(puts).toBe(1);
    const restarted = await adapter.getAgentRuntimeAtomicState(
      prepared.runtime.agentId,
    );
    expect(restarted?.configObjects).toHaveLength(1);
  });

  test("write factories reject plaintext and no generic root hydrator can brand a padded secret", async () => {
    expect(() =>
      v2.encryptedObjectWriteRecordV2(new Uint8Array(40).fill(7))
    ).toThrow();
    expect(() => v2.grantWriteRecordV2(new Uint8Array(40).fill(9)))
      .toThrow();
    expect(
      Object.keys(v2).filter((symbol) => symbol.startsWith("hydrate")),
    ).toEqual([]);
    expect(new v2.InMemoryV2Store().putGrant({
      grantId: "grant-structural-substitution",
      grantBytes: {
        classification: "opaque-ciphertext",
        kind: "grant",
        ciphertext: new Uint8Array(40),
      },
      consumed: false,
    } as never)).rejects.toThrow("must be opaque grant ciphertext");
  });
});
