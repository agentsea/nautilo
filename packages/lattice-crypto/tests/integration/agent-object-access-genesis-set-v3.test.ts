import { describe, expect, test } from "bun:test";

import {
  createAgentRuntimeInitializationSignerPublicationV1,
} from "../../src/agent-runtime/signer-publication-v1.ts";
import type { AgentRuntimeGenerationV2 } from "../../src/agent-runtime/types.ts";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  decodeObjectAccessManifestV5,
} from "../../src/format/object-access-manifest-v5.ts";
import {
  NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2,
  decodeNamespaceObjectEnvelopeV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../../src/format/object-v2.ts";
import { serializeGrantV2 } from "../../src/format/grant-v2.ts";
import { mintGrantV2 } from "../../src/grant/authorization.ts";
import type {
  GrantAuthoritySetAuthorizationV2,
} from "../../src/grant/set-authorization.ts";
import {
  coordinateGrantAuthoritySetUseV2,
  preflightGrantAuthoritySetUseV2,
  withGrantAuthoritySetExecutionEvidenceNamespaceSubsetV2,
  withGrantAuthoritySetExecutionEvidenceSubsetV2,
  type GrantAuthoritySetExecutionEvidenceV2,
} from "../../src/grant/set-storage-coordinator.ts";
import {
  assertAuthenticPreparedAgentObjectAccessManifestGenesisSetV3,
  assertAuthenticPreparedAgentMemoryDeletionV1,
  assertAuthenticPreparedAgentObjectAccessManifestUpdateSetV3,
  prepareAgentObjectAccessManifestGenesisSetV3,
  prepareAgentObjectAccessManifestUpdateSetV3,
  prepareAgentMemoryDeletionV1,
  type AgentObjectAccessSetNamespaceBindingV3,
  type PreparedAgentObjectAccessManifestGenesisSetV3,
  type PreparedAgentObjectAccessManifestUpdateSetV3,
  type PreparedAgentMemoryDeletionV1,
} from "../../src/object/agent-access-manifest-set.ts";
import { InMemoryV2Store } from "../../src/storage/v2-store.ts";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
} from "../../src/v2-types/ids.ts";
import { opaqueBytes } from "../../src/v2-types/opaque.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

const NOW = 9_000_000;

function fixtureNamespaceId(index: number, count: number): string {
  if (count === 2) return index === 0 ? "namespace-a" : "namespace-b";
  return `namespace-${index.toString().padStart(3, "0")}`;
}

function replaceEnvelopeContext(
  bytes: Uint8Array,
  context: Partial<ReturnType<
    typeof decodeNamespaceObjectEnvelopeV2
  >["context"]>,
): Uint8Array {
  const envelope = decodeNamespaceObjectEnvelopeV2(bytes);
  return encodeNamespaceObjectEnvelopeV2({
    ...envelope,
    context: { ...envelope.context, ...context },
  });
}

function nonArraySequence<T>(values: readonly T[]): T[] {
  const copy = [...values];
  return {
    length: copy.length,
    map: copy.map.bind(copy),
    every: copy.every.bind(copy),
    [Symbol.iterator]: copy[Symbol.iterator].bind(copy),
  } as unknown as T[];
}

function inheritedNamespaceBinding(
  binding: AgentObjectAccessSetNamespaceBindingV3,
  includeReplacementField: boolean,
): AgentObjectAccessSetNamespaceBindingV3 {
  const candidate = Object.create({ namespaceId: binding.namespaceId }) as
    Record<string, unknown>;
  Object.assign(candidate, {
    bindingHash: binding.bindingHash,
    domainId: binding.domainId,
    expectedAccessRevision: binding.expectedAccessRevision,
    expectedPolicyRevision: binding.expectedPolicyRevision,
    ...(includeReplacementField ? { zzUnexpected: true } : {}),
  });
  return candidate as unknown as AgentObjectAccessSetNamespaceBindingV3;
}

function replaceWrappedDek(bytes: Uint8Array, fill: number): Uint8Array {
  const envelope = decodeNamespaceObjectEnvelopeV2(bytes);
  return encodeNamespaceObjectEnvelopeV2({
    ...envelope,
    wrappedDek: new Uint8Array(envelope.wrappedDek.length).fill(fill),
  });
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
}

function expectEnvelopeBytesMatchManifest(
  prepared:
    | PreparedAgentObjectAccessManifestGenesisSetV3
    | PreparedAgentObjectAccessManifestUpdateSetV3,
): void {
  const crypto = new LatticeCrypto(seededRng(0x243_13));
  expect(prepared.envelopeBytes.map((bytes) => crypto.hash(bytes))).toEqual(
    [...prepared.manifest.envelopeHashes],
  );
}

async function prepareSet(
  mutate?: (input: {
    envelopeBytes: Uint8Array[];
    evidence: GrantAuthoritySetExecutionEvidenceV2;
    namespaceBindings: AgentObjectAccessSetNamespaceBindingV3[];
  }) => void,
  operation: "decrypt" | "encrypt" | "both" = "encrypt",
  subsetNamespaceIds?: readonly string[],
  updateTargetNamespaceIds?: readonly string[],
  mutateUpdate?: (input: {
    currentManifestBytes: Uint8Array;
    currentEnvelopeBytes: Uint8Array[];
    currentNamespaceBindings: AgentObjectAccessSetNamespaceBindingV3[];
    targetEnvelopeBytes: Uint8Array[];
    targetNamespaceBindings: AgentObjectAccessSetNamespaceBindingV3[];
  }) => void,
  options: Readonly<{
    namespaceCount?: number;
    aggregateEnvelopeBytes?: number;
    initialNamespaceIds?: readonly string[];
    namespaceOperations?: readonly (
      readonly ("decrypt" | "encrypt")[]
    )[];
    reverseNamespaceDomains?: boolean;
    updateAuthorityNamespaceIds?: readonly string[];
    updateRequiredOperations?: readonly ("decrypt" | "encrypt")[];
    useDifferentGenesisRuntime?: boolean;
    useDifferentUpdateRuntime?: boolean;
    genesisAgentAuthorizationRevision?: number;
    updateAgentAuthorizationRevision?: number;
  }> = {},
): Promise<{
  prepared: PreparedAgentObjectAccessManifestGenesisSetV3;
  updated?: PreparedAgentObjectAccessManifestUpdateSetV3;
  deleted?: PreparedAgentMemoryDeletionV1;
  retainedEvidence: GrantAuthoritySetExecutionEvidenceV2;
  prepareAgain: () => PreparedAgentObjectAccessManifestGenesisSetV3;
}> {
  const crypto = new LatticeCrypto(seededRng(0x243_12));
  const issuer = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const manager = crypto.generateSigningKeyPair();
  const runtime: AgentRuntimeGenerationV2 = {
    agentId: agentId("memory-agent"),
    keyClass: "runtime",
    generation: agentRuntimeGeneration(0),
    key: new Uint8Array(32).fill(0x31),
  };
  const agentAuthorizationRevision = authorizationRevision(17);
  const signerPublication =
    createAgentRuntimeInitializationSignerPublicationV1({
      crypto,
      operationId: "memory-agent-runtime-init",
      publicState: {
        agentId: runtime.agentId,
        authorizationRevision: agentAuthorizationRevision,
        runtimeGeneration: runtime.generation,
        configInventory: {
          objectCount: 1,
          digest: new Uint8Array(32).fill(0x32),
        },
        domainEnvelopes: [],
      },
      runtime,
      manager: {
        managerHumanId: humanId("alice"),
        managerAuthorizationRevision: authorizationRevision(8),
        managerDeviceId: cryptoDeviceId("alice-device"),
      },
      managerSigningPrivateKey: manager.privateKey,
      resolveCurrentManagerAuthority: () => manager.publicKey,
    });
  const alternateRuntime: AgentRuntimeGenerationV2 =
    options.useDifferentGenesisRuntime === true
      || options.useDifferentUpdateRuntime === true
      ? {
        agentId: agentId("other-memory-agent"),
        keyClass: "runtime",
        generation: agentRuntimeGeneration(0),
        key: new Uint8Array(32).fill(0x33),
      }
      : runtime;
  const alternateSignerPublication = options.useDifferentGenesisRuntime === true
      || options.useDifferentUpdateRuntime === true
    ? createAgentRuntimeInitializationSignerPublicationV1({
      crypto,
      operationId: "other-memory-agent-runtime-init",
      publicState: {
        agentId: alternateRuntime.agentId,
        authorizationRevision: agentAuthorizationRevision,
        runtimeGeneration: alternateRuntime.generation,
        configInventory: {
          objectCount: 1,
          digest: new Uint8Array(32).fill(0x34),
        },
        domainEnvelopes: [],
      },
      runtime: alternateRuntime,
      manager: {
        managerHumanId: humanId("alice"),
        managerAuthorizationRevision: authorizationRevision(8),
        managerDeviceId: cryptoDeviceId("alice-device"),
      },
      managerSigningPrivateKey: manager.privateKey,
      resolveCurrentManagerAuthority: () => manager.publicKey,
    })
    : signerPublication;
  const genesisRuntime = options.useDifferentGenesisRuntime === true
    ? alternateRuntime
    : runtime;
  const genesisSignerPublication = options.useDifferentGenesisRuntime === true
    ? alternateSignerPublication
    : signerPublication;
  const genesisAuthorizationRevision = authorizationRevision(
    options.genesisAgentAuthorizationRevision ?? agentAuthorizationRevision,
  );
  const updateRuntime = options.useDifferentUpdateRuntime === true
    ? alternateRuntime
    : runtime;
  const updateSignerPublication = options.useDifferentUpdateRuntime === true
    ? alternateSignerPublication
    : signerPublication;
  const updateAuthorizationRevision = authorizationRevision(
    options.updateAgentAuthorizationRevision ?? agentAuthorizationRevision,
  );
  const domains = [
    {
      domainId: cryptoDomainId("domain-a"),
      domainEpoch: domainEpoch(4),
      agentAuthorizationRevision: authorizationRevision(11),
      aiRoot: new Uint8Array(32).fill(0x41),
    },
    {
      domainId: cryptoDomainId("domain-b"),
      domainEpoch: domainEpoch(6),
      agentAuthorizationRevision: authorizationRevision(13),
      aiRoot: new Uint8Array(32).fill(0x42),
    },
  ] as const;
  const operations: readonly ("decrypt" | "encrypt")[] = operation === "both"
    ? ["decrypt", "encrypt"]
    : [operation];
  const grant = await mintGrantV2(crypto, {
    id: grantId("memory-output-grant"),
    issuingDeviceId: cryptoDeviceId("alice-device"),
    issuingHumanId: humanId("alice"),
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    recipientAgentId: runtime.agentId,
    recipientKeyId: "memory-output-recipient",
    recipientEncryptionPublicKey: recipient.publicKey,
    scope: [humanId("alice")],
    operations,
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    coveredDomains: domains,
    singleUse: true,
  });
  const namespaceCount = options.namespaceCount ?? 2;
  const namespaceRequirements = Array.from(
    { length: namespaceCount },
    (_, index) => ({
      namespaceId: namespaceId(fixtureNamespaceId(index, namespaceCount)),
      domainId: domains[
        options.reverseNamespaceDomains === true
          ? domains.length - 1 - (index % domains.length)
          : index % domains.length
      ]!.domainId,
      operations: options.namespaceOperations?.[index] ?? operations,
      namespaceParticipants: [humanId("alice")],
      expectedAccessRevision: accessRevision(index === 0
        ? 2
        : index === 1
        ? 5
        : index + 5),
      expectedPolicyRevision: authorizationRevision(21 + index),
    }),
  );
  const authorization: GrantAuthoritySetAuthorizationV2 = {
    now: NOW + 1,
    expectedIssuingDeviceId: grant.issuingDeviceId,
    issuingDeviceHumanId: humanId("alice"),
    issuingDeviceSigningPublicKey: issuer.publicKey,
    issuingDeviceActive: true,
    recipientAgentId: runtime.agentId,
    recipientKeyId: grant.recipientKeyId,
    recipientEncryptionPrivateKey: recipient.privateKey,
    singleUseAvailable: true,
    grantScope: grant.scope,
    namespaceRequirements,
    domainRequirements: domains.map((entry) => ({
      domainId: entry.domainId,
      expectedEpoch: entry.domainEpoch,
      expectedAgentAuthorizationRevision:
        entry.agentAuthorizationRevision,
    })),
    hostAllowsOperation: true,
  };
  const namespaceBindings = namespaceRequirements.map((requirement, index) => ({
    namespaceId: requirement.namespaceId,
    domainId: requirement.domainId,
    expectedAccessRevision: requirement.expectedAccessRevision,
    expectedPolicyRevision: requirement.expectedPolicyRevision,
    bindingHash: new Uint8Array(32).fill(0x70 + index),
  }));
  const store = new InMemoryV2Store();
  await store.putGrant({
    grantId: grant.id,
    grantBytes: opaqueBytes("grant", serializeGrantV2(grant)),
    consumed: false,
  });
  const preflight = await preflightGrantAuthoritySetUseV2(
    crypto,
    grant,
    authorization,
  );
  if (preflight === null) throw new Error("expected Grant-set preflight");
  const targetObjectId = objectId("memory-object-revision-1");
  const minimumEnvelopes = namespaceRequirements.map((requirement, index) =>
    encodeNamespaceObjectEnvelopeV2({
      formatVersion: NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2,
      context: {
        objectId: targetObjectId,
        namespaceId: requirement.namespaceId,
        keyClass: "ai",
        keyGeneration: namespaceGeneration(index + 1),
        bindingRevisionAtWrap: requirement.expectedAccessRevision,
      },
      wrappedDek: new Uint8Array(40).fill(0x50 + index),
    })
  );
  let remainingEnvelopeBytes = options.aggregateEnvelopeBytes === undefined
    ? undefined
    : options.aggregateEnvelopeBytes - minimumEnvelopes.reduce(
      (total, bytes) => total + bytes.length,
      0,
    );
  if (remainingEnvelopeBytes !== undefined && remainingEnvelopeBytes < 0) {
    throw new Error("requested aggregate envelope size is below minimum");
  }
  const envelopeBytes = namespaceRequirements.map((requirement, index) => {
    const extraBytes = remainingEnvelopeBytes === undefined
      ? 8
      : Math.min(remainingEnvelopeBytes, V2_LIMITS.wrappedDekBytes - 40);
    if (remainingEnvelopeBytes !== undefined) {
      remainingEnvelopeBytes -= extraBytes;
    }
    return encodeNamespaceObjectEnvelopeV2({
      formatVersion: NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2,
      context: {
        objectId: targetObjectId,
        namespaceId: requirement.namespaceId,
        keyClass: "ai",
        keyGeneration: namespaceGeneration(index + 1),
        bindingRevisionAtWrap: requirement.expectedAccessRevision,
      },
      wrappedDek: new Uint8Array(40 + extraBytes).fill(0x50 + index),
    });
  });
  if (remainingEnvelopeBytes !== undefined && remainingEnvelopeBytes !== 0) {
    throw new Error("requested aggregate envelope size exceeds capacity");
  }
  const payloadHash = new Uint8Array(32).fill(0x61);
  let retainedEvidence: GrantAuthoritySetExecutionEvidenceV2 | null = null;
  let prepareAgain: (() => PreparedAgentObjectAccessManifestGenesisSetV3)
    | null = null;
  const result = await coordinateGrantAuthoritySetUseV2({
    preflight,
    storage: store,
    resolveCurrentAuthorization: (context) => ({
      context,
      currentTime: context.preflightTime,
      issuingDeviceActive: true,
      recipientAgentAuthorized: true,
      requestedNamespacesAuthorized: true,
      requestedDomainsAuthorized: true,
      hostAllowsOperation: true,
      currentSingleUseStatus: context.singleUseStatus,
    }),
    execute: async (_opened, evidence) => {
      const run = async (
        activeEvidence: GrantAuthoritySetExecutionEvidenceV2,
      ): Promise<Readonly<{
        prepared: PreparedAgentObjectAccessManifestGenesisSetV3;
        updated?: PreparedAgentObjectAccessManifestUpdateSetV3;
        deleted?: PreparedAgentMemoryDeletionV1;
      }>> => {
        const initialNamespaceIds = options.initialNamespaceIds
          ?? subsetNamespaceIds;
        const selected = initialNamespaceIds === undefined
          ? namespaceRequirements.map((_, index) => index)
          : initialNamespaceIds.map((selectedNamespaceId) =>
            namespaceRequirements.findIndex((entry) =>
              entry.namespaceId === selectedNamespaceId
            )
          );
        const selectedEnvelopeBytes = selected.map((index) =>
          envelopeBytes[index]!
        );
        const selectedBindings = selected.map((index) =>
          namespaceBindings[index]!
        );
        mutate?.({
          envelopeBytes: selectedEnvelopeBytes,
          evidence: activeEvidence,
          namespaceBindings: selectedBindings,
        });
        const prepare = (
          genesisEvidence: GrantAuthoritySetExecutionEvidenceV2,
        ) => prepareAgentObjectAccessManifestGenesisSetV3(
          crypto,
          {
            objectId: targetObjectId,
            payloadHash,
            envelopeBytes: selectedEnvelopeBytes,
            authoritySet: genesisEvidence,
            namespaceBindings: selectedBindings,
            agentAuthorizationRevision: genesisAuthorizationRevision,
            runtime: genesisRuntime,
            signerPublication: genesisSignerPublication,
          },
        );
        let prepared: PreparedAgentObjectAccessManifestGenesisSetV3;
        if (options.initialNamespaceIds === undefined) {
          prepareAgain = () => prepare(activeEvidence);
          prepared = prepare(activeEvidence);
        } else {
          prepared = await withGrantAuthoritySetExecutionEvidenceNamespaceSubsetV2({
            evidence: activeEvidence,
            namespaceRequirements: options.initialNamespaceIds.map(
              (selectedNamespaceId) => ({
                namespaceId: namespaceId(selectedNamespaceId),
                requiredOperations: ["encrypt"],
              }),
            ),
            execute: (genesisEvidence) => {
              prepareAgain = () => prepare(genesisEvidence);
              return prepare(genesisEvidence);
            },
          });
        }
        if (updateTargetNamespaceIds === undefined) {
          retainedEvidence = activeEvidence;
          return { prepared };
        }
        const targetIndexes = updateTargetNamespaceIds.map(
          (selectedNamespaceId) =>
            namespaceRequirements.findIndex((entry) =>
              entry.namespaceId === selectedNamespaceId
            ),
        );
        const updateInput: {
          currentManifestBytes: Uint8Array;
          currentEnvelopeBytes: Uint8Array[];
          currentNamespaceBindings: AgentObjectAccessSetNamespaceBindingV3[];
          targetEnvelopeBytes: Uint8Array[];
          targetNamespaceBindings: AgentObjectAccessSetNamespaceBindingV3[];
        } = {
          currentManifestBytes: prepared.manifestBytes,
          currentEnvelopeBytes: [...prepared.envelopeBytes],
          currentNamespaceBindings: selectedBindings,
          targetEnvelopeBytes: targetIndexes.map((index) =>
            envelopeBytes[index]!
          ),
          targetNamespaceBindings: targetIndexes.map((index) =>
            namespaceBindings[index]!
          ),
        };
        mutateUpdate?.(updateInput);
        const currentIds: string[] = updateInput.currentNamespaceBindings.map((entry) =>
          entry.namespaceId
        );
        const targetIds = updateInput.targetNamespaceBindings.map((entry) =>
          entry.namespaceId
        );
        const removedIds = currentIds.filter((id) => !targetIds.includes(id));
        const addedIds = targetIds.filter((id) => !currentIds.includes(id));
        const deltaIds = namespaceRequirements
          .map((entry) => entry.namespaceId)
          .filter((id) => removedIds.includes(id) || addedIds.includes(id));
        const currentVerification = {
          trustedMinimumHead: {
            objectId: prepared.manifest.objectId,
            payloadHash: prepared.manifest.payloadHash,
            accessRevision: prepared.manifest.accessRevision,
            manifestHash: prepared.manifestHash,
          },
          proof: [] as const,
          resolveHistoricalHumanDeviceSigningPublicKey: () => null,
          resolveAgentRuntimeSignerPublicKey: () =>
            signerPublication.signerPublicKey,
          resolveProcessorSignerAuthorizationBytes: () => null,
          resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
        };
        if (deltaIds.length === 0) {
          return {
            prepared,
            updated: prepareAgentObjectAccessManifestUpdateSetV3(crypto, {
              ...updateInput,
              authoritySet: activeEvidence,
              ...currentVerification,
              agentAuthorizationRevision: updateAuthorizationRevision,
              runtime: updateRuntime,
              signerPublication: updateSignerPublication,
            }),
          };
        }
        const removedSet = new Set<string>(removedIds);
        return withGrantAuthoritySetExecutionEvidenceNamespaceSubsetV2({
          evidence,
          namespaceRequirements:
            (options.updateAuthorityNamespaceIds ?? deltaIds).map(
              (namespaceId) => ({
                namespaceId,
                requiredOperations: options.updateRequiredOperations
                  ?? [removedSet.has(namespaceId) ? "decrypt" : "encrypt"],
              }),
            ),
          execute: (updateEvidence) => {
            retainedEvidence = updateEvidence;
            if (targetIndexes.length === 0) {
              const deleted = prepareAgentMemoryDeletionV1(crypto, {
                currentManifestBytes: updateInput.currentManifestBytes,
                currentEnvelopeBytes: updateInput.currentEnvelopeBytes,
                currentNamespaceBindings: selectedBindings,
                authoritySet: updateEvidence,
                ...currentVerification,
                agentAuthorizationRevision: updateAuthorizationRevision,
                runtime: updateRuntime,
                signerPublication: updateSignerPublication,
              });
              return { prepared, deleted };
            }
            const updated = prepareAgentObjectAccessManifestUpdateSetV3(
              crypto,
              {
                ...updateInput,
                authoritySet: updateEvidence,
                ...currentVerification,
                agentAuthorizationRevision: updateAuthorizationRevision,
                runtime: updateRuntime,
                signerPublication: updateSignerPublication,
              },
            );
            return { prepared, updated };
          },
        });
      };
      return subsetNamespaceIds === undefined
        ? run(evidence)
        : withGrantAuthoritySetExecutionEvidenceSubsetV2({
          evidence,
          namespaceIds: subsetNamespaceIds,
          requiredOperations: ["encrypt"],
          execute: run,
        });
    },
  });
  if (result.status !== "executed") throw new Error("expected execution");
  return {
    prepared: result.value.prepared,
    ...(result.value.updated === undefined
      ? {}
      : { updated: result.value.updated }),
    ...(result.value.deleted === undefined
      ? {}
      : { deleted: result.value.deleted }),
    retainedEvidence: retainedEvidence!,
    prepareAgain: prepareAgain!,
  };
}

describe("Agent common-v5 exact-set genesis through the V3 preparation API", () => {
  test("accepts an authentic per-output subset without widening its manifest", async () => {
    const { prepared } = await prepareSet(
      undefined,
      "encrypt",
      [namespaceId("namespace-b")],
    );
    expect(prepared.envelopeBytes).toHaveLength(1);
    expect(prepared.authority.namespaceRequirements.map((entry) =>
      entry.namespaceId
    )).toEqual(["namespace-b"]);
    expect(prepared.authority.domainRequirements.map((entry) =>
      entry.domainId
    )).toEqual(["domain-b"]);
    expect(() =>
      assertAuthenticPreparedAgentObjectAccessManifestGenesisSetV3(prepared)
    ).not.toThrow();
  });

  test("prepares an exact two-Domain Namespace set without reserving its next revision", async () => {
    const { prepared } = await prepareSet();
    expect(() =>
      assertAuthenticPreparedAgentObjectAccessManifestGenesisSetV3(prepared)
    ).not.toThrow();
    const genesis = decodeObjectAccessManifestV5(prepared.manifestBytes);
    expect(genesis.accessRevision).toBe(accessRevision(0));
    expect(genesis.envelopeHashes).toHaveLength(2);
    expect(prepared.envelopeBytes).toHaveLength(2);
    expect(prepared.authority.namespaceRequirements.map((entry) =>
      entry.namespaceId
    )).toEqual(["namespace-a", "namespace-b"]);
    expect(prepared.authority.domainRequirements.map((entry) =>
      entry.domainId
    )).toEqual(["domain-a", "domain-b"]);
    expect(prepared.authority.namespaceBindings.map((entry) =>
      entry.namespaceId
    )).toEqual(["namespace-a", "namespace-b"]);
    expectEnvelopeBytesMatchManifest(prepared);
    expect("preauthorizedTombstone" in prepared).toBeFalse();
  });

  test("appends an exact-set update at the next unreserved revision", async () => {
    const result = await prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-b")],
    );
    const updated = result.updated;
    expect(updated).toBeDefined();
    expect(() =>
      assertAuthenticPreparedAgentObjectAccessManifestUpdateSetV3(updated!)
    ).not.toThrow();
    const previous = decodeObjectAccessManifestV5(
      result.prepared.manifestBytes,
    );
    const manifest = decodeObjectAccessManifestV5(updated!.manifestBytes);
    expect(previous.envelopeHashes).toHaveLength(2);
    expect(manifest.accessRevision).toBe(accessRevision(1));
    expect(manifest.previousManifestHash).toEqual(
      result.prepared.manifestHash,
    );
    expect(manifest.envelopeHashes).toHaveLength(1);
    expect(updated!.envelopeBytes).toHaveLength(1);
    expect(updated!.authority.currentNamespaceBindings.map((entry) =>
      entry.namespaceId
    )).toEqual([
      "namespace-a",
      "namespace-b",
    ]);
    expect(updated!.authority.removedNamespaceIds).toEqual(["namespace-a"]);
    expect(updated!.authority.addedNamespaceIds).toEqual([]);
    expect(updated!.authority.targetNamespaceBindings.map((entry) =>
      entry.namespaceId
    )).toEqual(["namespace-b"]);
    expect("preauthorizedTombstone" in updated!).toBeFalse();
  });

  test("retains inaccessible Namespace binding and envelope bytes without its root", async () => {
    const result = await prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-b")],
    );
    const updated = result.updated!;
    expect(result.retainedEvidence.namespaceRequirements.map((entry) =>
      entry.namespaceId
    )).toEqual(["namespace-a"]);
    expect(result.retainedEvidence.namespaceRequirements[0]!.operations)
      .toEqual(["decrypt"]);
    const retainedBefore = result.prepared.envelopeBytes.find((bytes) =>
      decodeNamespaceObjectEnvelopeV2(bytes).context.namespaceId
        === namespaceId("namespace-b")
    );
    expect(updated.envelopeBytes[0]).toEqual(retainedBefore);
    expect(updated.authority.targetNamespaceBindings[0]).toEqual(
      updated.authority.currentNamespaceBindings[1],
    );
    expect(updated.authority.targetEnvelopes[0]).toEqual(
      updated.authority.currentEnvelopes[1],
    );
  });

  test("adds a Namespace with encrypt authority only and no retained roots", async () => {
    const result = await prepareSet(
      undefined,
      "both",
      [namespaceId("namespace-a")],
      [namespaceId("namespace-a"), namespaceId("namespace-b")],
    );
    expect(result.retainedEvidence.namespaceRequirements.map((entry) =>
      entry.namespaceId
    )).toEqual(["namespace-b"]);
    expect(result.retainedEvidence.namespaceRequirements[0]!.operations)
      .toEqual(["encrypt"]);
    expect(result.updated!.authority.removedNamespaceIds).toEqual([]);
    expect(result.updated!.authority.addedNamespaceIds).toEqual([
      "namespace-b",
    ]);
  });

  test("accepts a retained historical wrap but rejects a stale added wrap", async () => {
    const retained = await prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-b")],
      ({ currentNamespaceBindings, targetNamespaceBindings }) => {
        currentNamespaceBindings[1] = {
          ...currentNamespaceBindings[1]!,
          expectedAccessRevision: accessRevision(8),
        };
        targetNamespaceBindings[0] = {
          ...targetNamespaceBindings[0]!,
          expectedAccessRevision: accessRevision(8),
        };
      },
    );
    expect(retained.updated!.authority.targetEnvelopes[0]!
      .bindingRevisionAtWrap).toBe(accessRevision(5));

    expect(prepareSet(
      undefined,
      "both",
      [namespaceId("namespace-000"), namespaceId("namespace-001")],
      [
        namespaceId("namespace-000"),
        namespaceId("namespace-001"),
        namespaceId("namespace-002"),
      ],
      ({ targetEnvelopeBytes }) => {
        targetEnvelopeBytes[2] = replaceEnvelopeContext(
          targetEnvelopeBytes[2]!,
          { bindingRevisionAtWrap: accessRevision(6) },
        );
      },
      { namespaceCount: 3 },
    )).rejects.toThrow("stale binding revision");
  });

  test("rejects retained substitutions and inexact delta authority", () => {
    expect(prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-b")],
      ({ targetNamespaceBindings }) => {
        targetNamespaceBindings[0] = {
          ...targetNamespaceBindings[0]!,
          bindingHash: new Uint8Array(32).fill(0x7f),
        };
      },
    )).rejects.toThrow("retained Namespace binding or envelope was substituted");
    expect(prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-b")],
      ({ targetEnvelopeBytes }) => {
        const envelope = decodeNamespaceObjectEnvelopeV2(
          targetEnvelopeBytes[0]!,
        );
        targetEnvelopeBytes[0] = encodeNamespaceObjectEnvelopeV2({
          ...envelope,
          wrappedDek: new Uint8Array(envelope.wrappedDek.length).fill(0x7f),
        });
      },
    )).rejects.toThrow("retained Namespace binding or envelope was substituted");
    expect(prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-b")],
      undefined,
      { updateRequiredOperations: ["encrypt"] },
    )).rejects.toThrow("delta authority disagrees");
    expect(prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-b")],
      undefined,
      { updateRequiredOperations: ["decrypt", "encrypt"] },
    )).rejects.toThrow("delta authority disagrees");
    expect(prepareSet(
      undefined,
      "both",
      [namespaceId("namespace-a")],
      [namespaceId("namespace-a"), namespaceId("namespace-b")],
      undefined,
      { updateRequiredOperations: ["decrypt"] },
    )).rejects.toThrow("delta authority disagrees");
    expect(prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-b")],
      undefined,
      {
        updateAuthorityNamespaceIds: [
          namespaceId("namespace-a"),
          namespaceId("namespace-b"),
        ],
      },
    )).rejects.toThrow("exactly cover its removed and added Namespace sets");
  });

  test("keeps every multi-target update envelope aligned with its manifest hash", async () => {
    const result = await prepareSet(
      undefined,
      "both",
      [namespaceId("namespace-a")],
      [namespaceId("namespace-a"), namespaceId("namespace-b")],
    );
    expect(result.updated!.envelopeBytes).toHaveLength(2);
    expectEnvelopeBytesMatchManifest(result.updated!);
  });

  test("rejects stale current state, incomplete target inventory, and missing source authority", () => {
    expect(prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-b")],
      ({ currentManifestBytes }) => {
        currentManifestBytes[0] = currentManifestBytes[0]! ^ 1;
      },
    )).rejects.toThrow();
    expect(prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-b")],
      ({ targetNamespaceBindings }) => targetNamespaceBindings.pop(),
    )).rejects.toThrow("target Namespace bindings count");
    expect(prepareSet(
      undefined,
      "encrypt",
      undefined,
      [namespaceId("namespace-b")],
    )).rejects.toThrow();
  });

  test("rejects malformed current and target update coordinates independently", () => {
    const appendByte = (bytes: Uint8Array): Uint8Array => {
      const noncanonical = new Uint8Array(bytes.length + 1);
      noncanonical.set(bytes);
      return noncanonical;
    };
    const cases: Array<(
      input: Parameters<NonNullable<Parameters<typeof prepareSet>[4]>>[0],
    ) => void> = [
      ({ currentNamespaceBindings }) => {
        currentNamespaceBindings[0] = null as unknown as
          AgentObjectAccessSetNamespaceBindingV3;
      },
      ({ currentNamespaceBindings }) => {
        currentNamespaceBindings[0] = {
          ...currentNamespaceBindings[0]!,
          unexpected: true,
        } as AgentObjectAccessSetNamespaceBindingV3;
      },
      ({ currentNamespaceBindings }) => currentNamespaceBindings.reverse(),
      ({ targetNamespaceBindings }) => {
        targetNamespaceBindings[0] = Object.assign(
          () => undefined,
          targetNamespaceBindings[0],
        ) as unknown as AgentObjectAccessSetNamespaceBindingV3;
      },
      ({ currentEnvelopeBytes }) => {
        currentEnvelopeBytes[0] = replaceEnvelopeContext(
          currentEnvelopeBytes[0]!,
          { keyClass: "human" as "ai" },
        );
      },
      ({ targetEnvelopeBytes }) => {
        targetEnvelopeBytes[0] = replaceEnvelopeContext(
          targetEnvelopeBytes[0]!,
          { keyClass: "human" as "ai" },
        );
      },
      ({ currentEnvelopeBytes }) => {
        currentEnvelopeBytes[0] = appendByte(currentEnvelopeBytes[0]!);
      },
      ({ targetEnvelopeBytes }) => {
        targetEnvelopeBytes[0] = appendByte(targetEnvelopeBytes[0]!);
      },
      ({ targetEnvelopeBytes }) => targetEnvelopeBytes.pop(),
    ];
    for (const mutateUpdate of cases) {
      expect(prepareSet(
        undefined,
        "both",
        undefined,
        [namespaceId("namespace-b")],
        mutateUpdate,
      )).rejects.toThrow();
    }

    expect(prepareSet(
      undefined,
      "both",
      [namespaceId("namespace-a")],
      [namespaceId("namespace-a"), namespaceId("namespace-b")],
      ({ targetNamespaceBindings }) => targetNamespaceBindings.reverse(),
    )).rejects.toThrow("canonical unique Namespace ordering");

    expect(prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-a"), namespaceId("namespace-b")],
    )).rejects.toThrow("exact target is unchanged");
  });

  test("requires real arrays at both exact-set update boundaries", () => {
    expect(prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-b")],
      (input) => {
        input.currentNamespaceBindings = nonArraySequence(
          input.currentNamespaceBindings,
        );
      },
    )).rejects.toThrow("must be an array");

    expect(prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-b")],
      (input) => {
        input.currentEnvelopeBytes = nonArraySequence(
          input.currentEnvelopeBytes,
        );
      },
    )).rejects.toThrow("must be an array");
  });

  test("requires binding coordinates to be exact own fields", () => {
    for (const includeReplacementField of [false, true]) {
      expect(prepareSet(
        undefined,
        "both",
        undefined,
        [namespaceId("namespace-b")],
        ({ currentNamespaceBindings }) => {
          currentNamespaceBindings[0] = inheritedNamespaceBinding(
            currentNamespaceBindings[0]!,
            includeReplacementField,
          );
        },
      )).rejects.toThrow("fields must be exact");
    }
  });

  test("rejects independently malformed newly-added envelope coordinates", () => {
    const currentNamespaceIds = [namespaceId("namespace-a")];
    const targetNamespaceIds = [
      namespaceId("namespace-a"),
      namespaceId("namespace-b"),
    ];
    expect(prepareSet(
      undefined,
      "both",
      undefined,
      targetNamespaceIds,
      ({ targetEnvelopeBytes }) => {
        targetEnvelopeBytes[1] = replaceEnvelopeContext(
          targetEnvelopeBytes[1]!,
          { objectId: objectId("other-memory-object") },
        );
      },
      { initialNamespaceIds: currentNamespaceIds },
    )).rejects.toThrow("coordinates disagree");

    expect(prepareSet(
      undefined,
      "both",
      undefined,
      targetNamespaceIds,
      ({ targetEnvelopeBytes }) => {
        targetEnvelopeBytes[1] = replaceEnvelopeContext(
          targetEnvelopeBytes[1]!,
          { keyClass: "human" as "ai" },
        );
      },
      { initialNamespaceIds: currentNamespaceIds },
    )).rejects.toThrow("coordinates disagree");
  });

  test("accepts canonical update delta and Domain ordering", async () => {
    const namespaceA = namespaceId("namespace-000");
    const namespaceB = namespaceId("namespace-001");
    const namespaceC = namespaceId("namespace-002");
    const orderedDelta = await prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceA, namespaceB],
      undefined,
      {
        namespaceCount: 3,
        initialNamespaceIds: [namespaceB, namespaceC],
      },
    );
    expect(orderedDelta.updated).toBeDefined();

    const reverseDomainOrder = await prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-a")],
      undefined,
      {
        initialNamespaceIds: [namespaceId("namespace-b")],
        reverseNamespaceDomains: true,
      },
    );
    expect(reverseDomainOrder.updated).toBeDefined();
  });

  test("rejects a partially overlapping update authority set", () => {
    const namespaceA = namespaceId("namespace-000");
    const namespaceB = namespaceId("namespace-001");
    const namespaceC = namespaceId("namespace-002");
    expect(prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceA, namespaceB],
      undefined,
      {
        namespaceCount: 3,
        initialNamespaceIds: [namespaceB, namespaceC],
        updateAuthorityNamespaceIds: [namespaceA, namespaceB],
        updateRequiredOperations: ["encrypt"],
      },
    )).rejects.toThrow("exactly cover its removed and added Namespace sets");
  });

  test("rejects every removed-binding disagreement with update authority", () => {
    const mutations: Array<(
      binding: AgentObjectAccessSetNamespaceBindingV3,
    ) => AgentObjectAccessSetNamespaceBindingV3> = [
      (binding) => ({
        ...binding,
        domainId: cryptoDomainId("domain-other"),
      }),
      (binding) => ({
        ...binding,
        expectedAccessRevision: accessRevision(99),
      }),
      (binding) => ({
        ...binding,
        expectedPolicyRevision: authorizationRevision(99),
      }),
    ];
    for (const mutateBinding of mutations) {
      expect(prepareSet(
        undefined,
        "both",
        undefined,
        [namespaceId("namespace-b")],
        ({ currentNamespaceBindings }) => {
          currentNamespaceBindings[0] = mutateBinding(
            currentNamespaceBindings[0]!,
          );
        },
      )).rejects.toThrow("delta authority disagrees");
    }
  });

  test("rejects update Runtime recipient and authorization-revision drift", () => {
    expect(prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-b")],
      undefined,
      { useDifferentUpdateRuntime: true },
    )).rejects.toThrow("Runtime signer authority disagrees");

    expect(prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-b")],
      undefined,
      { updateAgentAuthorizationRevision: 18 },
    )).rejects.toThrow("Runtime signer authority disagrees");
  });

  test("rejects mixed genesis operation authority", () => {
    expect(prepareSet(
      undefined,
      "both",
      undefined,
      undefined,
      undefined,
      {
        namespaceOperations: [
          ["decrypt", "encrypt"],
          ["decrypt"],
        ],
      },
    )).rejects.toThrow("requires encrypt authority");
  });

  test("requires genesis binding coordinates to be exact own fields", () => {
    for (const includeReplacementField of [false, true]) {
      expect(prepareSet(({ namespaceBindings }) => {
        namespaceBindings[0] = inheritedNamespaceBinding(
          namespaceBindings[0]!,
          includeReplacementField,
        );
      })).rejects.toThrow("coordinates must exactly match authority");
    }
  });

  test("rejects a human-key genesis envelope", () => {
    expect(prepareSet(({ envelopeBytes }) => {
      envelopeBytes[0] = replaceEnvelopeContext(envelopeBytes[0]!, {
        keyClass: "human" as "ai",
      });
    })).rejects.toThrow("envelope coordinates disagree");
  });

  test("rejects distinct genesis envelopes for the same Namespace", () => {
    expect(prepareSet(({ envelopeBytes }) => {
      envelopeBytes[1] = replaceEnvelopeContext(envelopeBytes[1]!, {
        namespaceId: namespaceId("namespace-a"),
        bindingRevisionAtWrap: accessRevision(2),
      });
    })).rejects.toThrow("exact Namespace envelope set");
  });

  test("rejects genesis Runtime recipient and authorization-revision drift", () => {
    expect(prepareSet(
      undefined,
      "encrypt",
      undefined,
      undefined,
      undefined,
      { useDifferentGenesisRuntime: true },
    )).rejects.toThrow("Runtime signer authority disagrees");

    expect(prepareSet(
      undefined,
      "encrypt",
      undefined,
      undefined,
      undefined,
      { genesisAgentAuthorizationRevision: 18 },
    )).rejects.toThrow("Runtime signer authority disagrees");
  });

  test("canonicalizes genesis authority envelopes and public purpose", async () => {
    const crypto = new LatticeCrypto(seededRng(0x243_14));
    const result = await prepareSet(({ envelopeBytes }) => {
      const namespaceAHash = crypto.hash(envelopeBytes[0]!);
      for (let fill = 0; fill < 256; fill += 1) {
        const candidate = replaceWrappedDek(envelopeBytes[1]!, fill);
        if (compareBytes(crypto.hash(candidate), namespaceAHash) < 0) {
          envelopeBytes[1] = candidate;
          return;
        }
      }
      throw new Error("failed to construct reverse hash order");
    });
    expect(result.prepared.authority.envelopes.map((entry) =>
      entry.namespaceId
    )).toEqual([namespaceId("namespace-a"), namespaceId("namespace-b")]);
    expect(result.prepared.authority.purpose).toBe(
      "persist-agent-object-access-genesis-set",
    );
  });

  test("rejects a phantom current binding absent from the manifest", () => {
    const namespaceA = namespaceId("namespace-000");
    const namespaceB = namespaceId("namespace-001");
    const namespaceC = namespaceId("namespace-002");
    expect(prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceA, namespaceC],
      ({ currentNamespaceBindings }) => {
        currentNamespaceBindings.push({
          namespaceId: namespaceB,
          domainId: cryptoDomainId("domain-b"),
          expectedAccessRevision: accessRevision(5),
          expectedPolicyRevision: authorizationRevision(22),
          bindingHash: new Uint8Array(32).fill(0x71),
        });
      },
      {
        namespaceCount: 3,
        initialNamespaceIds: [namespaceA],
      },
    )).rejects.toThrow("envelope set must match its binding set");
  });

  test("rejects a substituted removed envelope outside current inventory", () => {
    expect(prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-b")],
      ({ currentEnvelopeBytes }) => {
        currentEnvelopeBytes[0] = replaceWrappedDek(
          currentEnvelopeBytes[0]!,
          0x7f,
        );
      },
    )).rejects.toThrow("current envelope inventory is inexact");
  });

  test("rejects an exact-prefix subset of the current envelope inventory", () => {
    const namespaceA = namespaceId("namespace-000");
    const namespaceB = namespaceId("namespace-001");
    const namespaceC = namespaceId("namespace-002");
    expect(prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceC],
      (input) => {
        const retainedEnvelope = input.currentEnvelopeBytes[0]!;
        const retainedNamespaceId = decodeNamespaceObjectEnvelopeV2(
          retainedEnvelope,
        ).context.namespaceId;
        const retainedBinding = input.currentNamespaceBindings.find((entry) =>
          entry.namespaceId === retainedNamespaceId
        )!;
        input.currentEnvelopeBytes = [retainedEnvelope];
        input.currentNamespaceBindings = [retainedBinding];
      },
      {
        namespaceCount: 3,
        initialNamespaceIds: [namespaceA, namespaceB],
      },
    )).rejects.toThrow("current envelope inventory is inexact");
  });

  test("rejects one matching and one substituted current inventory hash", () => {
    expect(prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-a"), namespaceId("namespace-b")],
      (input) => {
        const crypto = new LatticeCrypto(seededRng(0x243_15));
        const retainedEnvelope = input.currentEnvelopeBytes[0]!;
        const removedEnvelope = input.currentEnvelopeBytes[1]!;
        const retainedHash = crypto.hash(retainedEnvelope);
        let substitutedRemovedEnvelope: Uint8Array | null = null;
        for (let fill = 0; fill < 256; fill += 1) {
          const candidate = replaceWrappedDek(removedEnvelope, fill);
          const candidateHash = crypto.hash(candidate);
          if (
            compareBytes(candidateHash, retainedHash) > 0
            && !candidate.every((byte, index) =>
              byte === removedEnvelope[index]
            )
          ) {
            substitutedRemovedEnvelope = candidate;
            break;
          }
        }
        if (substitutedRemovedEnvelope === null) {
          throw new Error("failed to construct a partial inventory mismatch");
        }
        const retainedNamespaceId = decodeNamespaceObjectEnvelopeV2(
          retainedEnvelope,
        ).context.namespaceId;
        const retainedBinding = input.currentNamespaceBindings.find((entry) =>
          entry.namespaceId === retainedNamespaceId
        )!;
        input.currentEnvelopeBytes[1] = substitutedRemovedEnvelope;
        input.targetEnvelopeBytes = [retainedEnvelope];
        input.targetNamespaceBindings = [retainedBinding];
      },
    )).rejects.toThrow("current envelope inventory is inexact");
  });

  test("returns the canonical update authority purpose", async () => {
    const result = await prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-b")],
    );
    expect(result.updated!.authority.purpose).toBe(
      "persist-agent-object-access-update-set",
    );
  });

  test("detects mutation of an authentic prepared exact-set update", async () => {
    const result = await prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-b")],
    );
    const updated = result.updated!;
    updated.envelopeBytes[0]![0] = updated.envelopeBytes[0]![0]! ^ 1;
    expect(() =>
      assertAuthenticPreparedAgentObjectAccessManifestUpdateSetV3(updated)
    ).toThrow("authentic prepared exact-set update");
  });

  test("rejects expired evidence and exact-set envelope drift", async () => {
    const complete = await prepareSet();
    expect(() => complete.prepareAgain()).toThrow("is not active");
    expect(prepareSet(({ envelopeBytes }) => envelopeBytes.pop()))
      .rejects.toThrow("exact Namespace envelope set");
    expect(prepareSet(({ envelopeBytes }) => {
      const first = envelopeBytes[0]!;
      first[0] = first[0]! ^ 1;
    })).rejects.toThrow();
  });

  test("rejects oversized genesis and update envelope inventories before decoding", () => {
    expect(prepareSet(({ envelopeBytes }) => {
      envelopeBytes[0] = new Uint8Array(
        V2_LIMITS.manifestEnvelopeBytes + 1,
      );
    })).rejects.toThrow("envelope bytes exceed limit");
    expect(prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-b")],
      ({ targetEnvelopeBytes }) => {
        targetEnvelopeBytes[0] = new Uint8Array(
          V2_LIMITS.manifestEnvelopeBytes + 1,
        );
      },
    )).rejects.toThrow("envelope bytes exceed limit");
  });

  test("accepts the inclusive aggregate envelope ceiling for genesis and update", async () => {
    const namespaceIds = Array.from(
      { length: V2_LIMITS.namespaceEnvelopesPerManifest },
      (_, index) => namespaceId(fixtureNamespaceId(
        index,
        V2_LIMITS.namespaceEnvelopesPerManifest,
      )),
    );
    const genesis = await prepareSet(
      undefined,
      "encrypt",
      undefined,
      undefined,
      undefined,
      {
        namespaceCount: V2_LIMITS.namespaceEnvelopesPerManifest,
        aggregateEnvelopeBytes: V2_LIMITS.manifestEnvelopeBytes,
      },
    );
    const update = await prepareSet(
      undefined,
      "both",
      namespaceIds.slice(0, -1),
      namespaceIds,
      undefined,
      {
        namespaceCount: V2_LIMITS.namespaceEnvelopesPerManifest,
        aggregateEnvelopeBytes: V2_LIMITS.manifestEnvelopeBytes,
      },
    );
    expect(genesis.prepared.envelopeBytes.reduce(
      (total, bytes) => total + bytes.length,
      0,
    )).toBe(V2_LIMITS.manifestEnvelopeBytes);
    expect(update.updated!.envelopeBytes.reduce(
      (total, bytes) => total + bytes.length,
      0,
    )).toBe(V2_LIMITS.manifestEnvelopeBytes);
  });

  test("canonicalizes envelope order and detects prepared-byte mutation", async () => {
    const canonical = await prepareSet();
    const reversed = await prepareSet(({ envelopeBytes }) => {
      envelopeBytes.reverse();
    });
    expect(reversed.prepared.manifestBytes).toEqual(
      canonical.prepared.manifestBytes,
    );
    expect(reversed.prepared.envelopeBytes).toEqual(
      canonical.prepared.envelopeBytes,
    );
    canonical.prepared.manifestHash[0] =
      canonical.prepared.manifestHash[0]! ^ 1;
    expect(() =>
      assertAuthenticPreparedAgentObjectAccessManifestGenesisSetV3(
        canonical.prepared,
      )
    ).toThrow("authentic prepared exact-set genesis");
  });

  test("prepares deletion on demand from exact live decrypt authority", async () => {
    const result = await prepareSet(
      undefined,
      "both",
      undefined,
      [],
    );
    const deleted = result.deleted!;
    expect(() => assertAuthenticPreparedAgentMemoryDeletionV1(deleted))
      .not.toThrow();
    const manifest = decodeObjectAccessManifestV5(deleted.manifestBytes);
    expect(manifest.accessRevision).toBe(accessRevision(1));
    expect(manifest.previousManifestHash).toEqual(
      result.prepared.manifestHash,
    );
    expect(manifest.envelopeHashes).toEqual([]);
    expect(deleted.authority.currentNamespaceBindings.map((entry) =>
      entry.namespaceId
    )).toEqual(["namespace-a", "namespace-b"]);
    deleted.manifestHash[0] = deleted.manifestHash[0]! ^ 1;
    expect(() => assertAuthenticPreparedAgentMemoryDeletionV1(deleted))
      .toThrow("authentic prepared empty-envelope manifest");
  });

  test("rejects every inexact Namespace binding coordinate", () => {
    expect(prepareSet(({ namespaceBindings }) => namespaceBindings.pop()))
      .rejects.toThrow("binding set must be exact");
    expect(prepareSet(({ namespaceBindings }) => {
      namespaceBindings.push(structuredClone(namespaceBindings[0]!));
    })).rejects.toThrow("binding set must be exact");
    expect(prepareSet(({ namespaceBindings }) => namespaceBindings.reverse()))
      .rejects.toThrow("coordinates must exactly match authority");
    expect(prepareSet(({ namespaceBindings }) => {
      namespaceBindings[0] = {
        ...namespaceBindings[0]!,
        namespaceId: namespaceId("namespace-substitute"),
      };
    })).rejects.toThrow("coordinates must exactly match authority");
    expect(prepareSet(({ namespaceBindings }) => {
      namespaceBindings[0] = {
        ...namespaceBindings[0]!,
        domainId: cryptoDomainId("domain-substitute"),
      };
    })).rejects.toThrow("coordinates must exactly match authority");
    expect(prepareSet(({ namespaceBindings }) => {
      namespaceBindings[0] = {
        ...namespaceBindings[0]!,
        expectedAccessRevision: accessRevision(3),
      };
    })).rejects.toThrow("coordinates must exactly match authority");
    expect(prepareSet(({ namespaceBindings }) => {
      namespaceBindings[0] = {
        ...namespaceBindings[0]!,
        expectedPolicyRevision: authorizationRevision(23),
      };
    })).rejects.toThrow("coordinates must exactly match authority");
    expect(prepareSet(({ namespaceBindings }) => {
      namespaceBindings[0] = {
        ...namespaceBindings[0]!,
        bindingHash: new Uint8Array(31),
      };
    })).rejects.toThrow("binding hash must be exactly 32 bytes");
  });

  test("detects a prepared Namespace binding-hash mutation", async () => {
    const { prepared } = await prepareSet();
    const bindingHash = prepared.authority.namespaceBindings[0]!.bindingHash;
    bindingHash[0] = bindingHash[0]! ^ 1;
    expect(() =>
      assertAuthenticPreparedAgentObjectAccessManifestGenesisSetV3(prepared)
    ).toThrow("authentic prepared exact-set genesis");
  });

  test("authenticates every prepared genesis, update, and deletion byte", async () => {
    const genesis = await prepareSet();
    const update = await prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-b")],
    );
    const deletion = await prepareSet(
      undefined,
      "both",
      undefined,
      [],
    );
    const cases = [
      {
        bytes: genesis.prepared.manifestBytes,
        assert: () =>
          assertAuthenticPreparedAgentObjectAccessManifestGenesisSetV3(
            genesis.prepared,
          ),
      },
      {
        bytes: genesis.prepared.envelopeBytes[0]!,
        assert: () =>
          assertAuthenticPreparedAgentObjectAccessManifestGenesisSetV3(
            genesis.prepared,
          ),
      },
      {
        bytes: genesis.prepared.authority.grantHash,
        assert: () =>
          assertAuthenticPreparedAgentObjectAccessManifestGenesisSetV3(
            genesis.prepared,
          ),
      },
      {
        bytes: update.updated!.manifestBytes,
        assert: () =>
          assertAuthenticPreparedAgentObjectAccessManifestUpdateSetV3(
            update.updated!,
          ),
      },
      {
        bytes: update.updated!.manifestHash,
        assert: () =>
          assertAuthenticPreparedAgentObjectAccessManifestUpdateSetV3(
            update.updated!,
          ),
      },
      {
        bytes: update.updated!.authority.grantHash,
        assert: () =>
          assertAuthenticPreparedAgentObjectAccessManifestUpdateSetV3(
            update.updated!,
          ),
      },
      ...update.updated!.authority.currentNamespaceBindings.map((entry) => ({
        bytes: entry.bindingHash,
        assert: () =>
          assertAuthenticPreparedAgentObjectAccessManifestUpdateSetV3(
            update.updated!,
          ),
      })),
      ...update.updated!.authority.currentEnvelopes.map((entry) => ({
        bytes: entry.envelopeHash,
        assert: () =>
          assertAuthenticPreparedAgentObjectAccessManifestUpdateSetV3(
            update.updated!,
          ),
      })),
      ...update.updated!.authority.targetEnvelopes.map((entry) => ({
        bytes: entry.envelopeHash,
        assert: () =>
          assertAuthenticPreparedAgentObjectAccessManifestUpdateSetV3(
            update.updated!,
          ),
      })),
      {
        bytes: deletion.deleted!.manifestBytes,
        assert: () =>
          assertAuthenticPreparedAgentMemoryDeletionV1(deletion.deleted!),
      },
      {
        bytes: deletion.deleted!.authority.grantHash,
        assert: () =>
          assertAuthenticPreparedAgentMemoryDeletionV1(deletion.deleted!),
      },
    ];
    for (const candidate of cases) {
      candidate.bytes.fill(candidate.bytes[0]! ^ 1, 0, 1);
      expect(candidate.assert).toThrow("authentic prepared");
      candidate.bytes.fill(candidate.bytes[0]! ^ 1, 0, 1);
      expect(candidate.assert).not.toThrow();
    }
  });

  test("preserves complete authority evidence and authenticates every nested hash", async () => {
    const genesis = await prepareSet();
    const update = await prepareSet(
      undefined,
      "both",
      undefined,
      [namespaceId("namespace-b")],
    );
    const deletion = await prepareSet(
      undefined,
      "both",
      undefined,
      [],
    );

    expect(genesis.prepared.authority.grantScope).toEqual(
      genesis.retainedEvidence.grantScope,
    );
    expect(genesis.prepared.authority.grantOperations).toEqual(
      genesis.retainedEvidence.operations,
    );
    expect(genesis.prepared.authority.namespaceRequirements).toEqual(
      genesis.retainedEvidence.namespaceRequirements,
    );
    expect(genesis.prepared.authority.domainRequirements).toEqual(
      genesis.retainedEvidence.domainRequirements,
    );
    expect(genesis.prepared.authority.namespaceBindings).toHaveLength(2);
    expect(genesis.prepared.authority.envelopes).toHaveLength(2);

    expect(update.updated!.authority.grantScope).toEqual(
      update.retainedEvidence.grantScope,
    );
    expect(update.updated!.authority.grantOperations).toEqual(
      update.retainedEvidence.operations,
    );
    expect(update.updated!.authority.namespaceRequirements).toEqual(
      update.retainedEvidence.namespaceRequirements,
    );
    expect(update.updated!.authority.domainRequirements).toEqual(
      update.retainedEvidence.domainRequirements,
    );
    expect(update.updated!.authority.currentNamespaceIds).toEqual([
      "namespace-a",
      "namespace-b",
    ]);
    expect(update.updated!.authority.targetNamespaceBindings).toHaveLength(1);
    expect(update.updated!.authority.envelopes).toHaveLength(1);

    expect(deletion.deleted!.authority.namespaceRequirements).toEqual(
      deletion.retainedEvidence.namespaceRequirements,
    );
    expect(deletion.deleted!.authority.domainRequirements).toEqual(
      deletion.retainedEvidence.domainRequirements,
    );
    expect(deletion.deleted!.authority.currentNamespaceBindings).toHaveLength(
      2,
    );
    expect(deletion.deleted!.authority.currentAccessRevision).toBe(
      accessRevision(0),
    );

    const authenticatedBytes = [
      {
        bytes: genesis.prepared.authority.payloadHash,
        assert: () =>
          assertAuthenticPreparedAgentObjectAccessManifestGenesisSetV3(
            genesis.prepared,
          ),
      },
      ...genesis.prepared.authority.namespaceBindings.map((entry) => ({
        bytes: entry.bindingHash,
        assert: () =>
          assertAuthenticPreparedAgentObjectAccessManifestGenesisSetV3(
            genesis.prepared,
          ),
      })),
      ...genesis.prepared.authority.envelopes.map((entry) => ({
        bytes: entry.envelopeHash,
        assert: () =>
          assertAuthenticPreparedAgentObjectAccessManifestGenesisSetV3(
            genesis.prepared,
          ),
      })),
      {
        bytes: update.updated!.authority.payloadHash,
        assert: () =>
          assertAuthenticPreparedAgentObjectAccessManifestUpdateSetV3(
            update.updated!,
          ),
      },
      ...update.updated!.authority.currentNamespaceBindings.map((entry) => ({
        bytes: entry.bindingHash,
        assert: () =>
          assertAuthenticPreparedAgentObjectAccessManifestUpdateSetV3(
            update.updated!,
          ),
      })),
      ...update.updated!.authority.targetNamespaceBindings.map((entry) => ({
        bytes: entry.bindingHash,
        assert: () =>
          assertAuthenticPreparedAgentObjectAccessManifestUpdateSetV3(
            update.updated!,
          ),
      })),
      ...update.updated!.authority.currentEnvelopes.map((entry) => ({
        bytes: entry.envelopeHash,
        assert: () =>
          assertAuthenticPreparedAgentObjectAccessManifestUpdateSetV3(
            update.updated!,
          ),
      })),
      ...update.updated!.authority.targetEnvelopes.map((entry) => ({
        bytes: entry.envelopeHash,
        assert: () =>
          assertAuthenticPreparedAgentObjectAccessManifestUpdateSetV3(
            update.updated!,
          ),
      })),
      ...update.updated!.authority.envelopes.map((entry) => ({
        bytes: entry.envelopeHash,
        assert: () =>
          assertAuthenticPreparedAgentObjectAccessManifestUpdateSetV3(
            update.updated!,
          ),
      })),
      {
        bytes: deletion.deleted!.authority.payloadHash,
        assert: () =>
          assertAuthenticPreparedAgentMemoryDeletionV1(deletion.deleted!),
      },
      {
        bytes: deletion.deleted!.authority.currentManifestHash,
        assert: () =>
          assertAuthenticPreparedAgentMemoryDeletionV1(deletion.deleted!),
      },
      ...deletion.deleted!.authority.currentNamespaceBindings.map((entry) => ({
        bytes: entry.bindingHash,
        assert: () =>
          assertAuthenticPreparedAgentMemoryDeletionV1(deletion.deleted!),
      })),
    ];
    for (const candidate of authenticatedBytes) {
      candidate.bytes[0] = candidate.bytes[0]! ^ 1;
      expect(candidate.assert).toThrow("authentic prepared");
      candidate.bytes[0] = candidate.bytes[0] ^ 1;
      expect(candidate.assert).not.toThrow();
    }
  });

  test("rejects every substituted genesis envelope coordinate", () => {
    const substitutions: Array<Partial<ReturnType<
      typeof decodeNamespaceObjectEnvelopeV2
    >["context"]>> = [
      { objectId: objectId("memory-object-other") },
      { namespaceId: namespaceId("namespace-other") },
      { bindingRevisionAtWrap: accessRevision(99) },
    ];
    for (const substitution of substitutions) {
      expect(prepareSet(({ envelopeBytes }) => {
        envelopeBytes[0] = replaceEnvelopeContext(
          envelopeBytes[0]!,
          substitution,
        );
      })).rejects.toThrow("envelope coordinates disagree");
    }
    expect(prepareSet(({ envelopeBytes }) => {
      envelopeBytes[1] = envelopeBytes[0]!.slice();
    })).rejects.toThrow("exact Namespace envelope set");
  });

  test("rejects every stale update envelope and binding coordinate", async () => {
    const envelopeMutations: Array<(input: {
      currentEnvelopeBytes: Uint8Array[];
      targetEnvelopeBytes: Uint8Array[];
    }) => void> = [
      ({ currentEnvelopeBytes }) => currentEnvelopeBytes.pop(),
      ({ currentEnvelopeBytes }) => {
        currentEnvelopeBytes[0] = replaceEnvelopeContext(
          currentEnvelopeBytes[0]!,
          { objectId: objectId("memory-object-other") },
        );
      },
      ({ targetEnvelopeBytes }) => {
        targetEnvelopeBytes[0] = replaceEnvelopeContext(
          targetEnvelopeBytes[0]!,
          { objectId: objectId("memory-object-other") },
        );
      },
      ({ targetEnvelopeBytes }) => {
        targetEnvelopeBytes[0] = replaceEnvelopeContext(
          targetEnvelopeBytes[0]!,
          { namespaceId: namespaceId("namespace-other") },
        );
      },
      ({ targetEnvelopeBytes }) => {
        targetEnvelopeBytes[0] = replaceEnvelopeContext(
          targetEnvelopeBytes[0]!,
          { bindingRevisionAtWrap: accessRevision(99) },
        );
      },
    ];
    for (const mutateUpdate of envelopeMutations) {
      expect(prepareSet(
        undefined,
        "both",
        undefined,
        [namespaceId("namespace-b")],
        mutateUpdate,
      )).rejects.toThrow();
    }

    const bindingMutations: Array<(
      binding: AgentObjectAccessSetNamespaceBindingV3,
    ) => object> = [
      (binding) => ({
        ...binding,
        namespaceId: namespaceId("namespace-other"),
      }),
      (binding) => ({
        ...binding,
        domainId: cryptoDomainId("domain-other"),
      }),
      (binding) => ({
        ...binding,
        expectedAccessRevision: accessRevision(99),
      }),
      (binding) => ({
        ...binding,
        expectedPolicyRevision: authorizationRevision(99),
      }),
      (binding) => ({ ...binding, bindingHash: new Uint8Array(31) }),
      (binding) => ({ ...binding, unexpected: true }),
    ];
    for (const mutateBinding of bindingMutations) {
      expect(prepareSet(
        undefined,
        "both",
        undefined,
        [namespaceId("namespace-b")],
        ({ targetNamespaceBindings }) => {
          targetNamespaceBindings[0] = mutateBinding(
            targetNamespaceBindings[0]!,
          ) as AgentObjectAccessSetNamespaceBindingV3;
        },
      )).rejects.toThrow();
    }
  });

  test("rejects every stale deletion Namespace binding coordinate", async () => {
    const mutations: Array<(
      bindings: AgentObjectAccessSetNamespaceBindingV3[],
    ) => void> = [
      (bindings) => bindings.pop(),
      (bindings) => bindings.reverse(),
      (bindings) => {
        bindings[0] = {
          ...bindings[0]!,
          namespaceId: namespaceId("namespace-other"),
        };
      },
      (bindings) => {
        bindings[0] = {
          ...bindings[0]!,
          domainId: cryptoDomainId("domain-other"),
        };
      },
      (bindings) => {
        bindings[0] = {
          ...bindings[0]!,
          expectedAccessRevision: accessRevision(99),
        };
      },
      (bindings) => {
        bindings[0] = {
          ...bindings[0]!,
          expectedPolicyRevision: authorizationRevision(99),
        };
      },
      (bindings) => {
        bindings[0] = { ...bindings[0]!, bindingHash: new Uint8Array(31) };
      },
    ];
    for (const mutateBindings of mutations) {
      expect(prepareSet(
        undefined,
        "both",
        undefined,
        [],
        ({ currentNamespaceBindings }) =>
          mutateBindings(currentNamespaceBindings),
      )).rejects.toThrow();
    }
  });

  test("rejects an authority Namespace without encrypt operation", async () => {
    expect(prepareSet(undefined, "decrypt"))
      .rejects.toThrow("requires encrypt authority");
  });
});
