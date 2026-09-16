import {
  accessRevision,
  authorizationRevision,
  cryptoDomainId,
  encryptedObjectWriteRecord,
  encryptObjectPayload,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareAgentObjectAccessManifestGenesisSet,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type AgentRuntimeKeyGeneration,
  type AgentRuntimeSignerPublication,
  type GrantAuthoritySetExecutionEvidence,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import type {
  ProtectedNamespaceKeyringSetMaterial,
} from "../invocation/protected-namespace-keyring.ts";
import {
  encodeMemoryPayloadV1,
  type MemoryPayloadV1,
} from "./memory-payload-v1.ts";
import {
  deriveMemoryCryptoObjectIdV1,
  MEMORY_OBJECT_TYPE,
  type PreparedMemoryCryptoRevision,
} from "./memory-repository.ts";
import {
  createPreparedMemoryCryptoRevision,
} from "./memory-prepared-revision.ts";

export interface PrepareAgentMemoryCryptoRevisionInput {
  readonly crypto: LatticeCrypto;
  readonly memoryId: string;
  readonly contentRevision: number;
  readonly payload: MemoryPayloadV1;
  readonly createdAt: number;
  readonly namespaceSet: ProtectedNamespaceKeyringSetMaterial;
  readonly authoritySet: GrantAuthoritySetExecutionEvidence;
  readonly runtime: AgentRuntimeKeyGeneration;
  readonly signerPublication: AgentRuntimeSignerPublication;
}

function exactNamespaceAuthority(
  input: PrepareAgentMemoryCryptoRevisionInput,
): boolean {
  const requirements = input.authoritySet.namespaceRequirements;
  const namespaces = input.namespaceSet.namespaces;
  if (
    requirements.length !== namespaces.length
    || input.authoritySet.domainRequirements.length
      !== new Set(namespaces.map((entry) => entry.domainId)).size
  ) return false;
  const domains = new Map(
    input.authoritySet.domainRequirements.map((entry) =>
      [entry.domainId, entry] as const
    ),
  );
  return namespaces.every((entry, index) => {
    const requirement = requirements[index];
    const domain = domains.get(entry.domainId);
    return requirement !== undefined
      && domain !== undefined
      && entry.namespaceId === requirement.namespaceId
      && entry.domainId === requirement.domainId
      && entry.accessRevision === requirement.expectedAccessRevision
      && entry.policyRevision === requirement.expectedPolicyRevision
      && entry.domainEpoch === domain.expectedEpoch
      && entry.domainAgentAuthorizationRevision
        === domain.expectedAgentAuthorizationRevision
      && requirement.operations.includes("encrypt");
  });
}

/**
 * Prepare one Agent-authored Memory revision while exact Grant evidence,
 * current Namespace AI keys, and one Runtime signing generation are live.
 * The payload is encrypted exactly once and its one DEK is wrapped for every
 * Namespace in the complete authority set. All copied secrets are wiped.
 */
export function prepareAgentMemoryCryptoRevision(
  input: PrepareAgentMemoryCryptoRevisionInput,
): PreparedMemoryCryptoRevision {
  if (
    input.namespaceSet.recipientAgentId !== input.authoritySet.recipientAgentId
    || input.runtime.agentId !== input.namespaceSet.recipientAgentId
  ) throw new Error("Agent Memory exact authority recipient disagrees");
  if (
    input.signerPublication.authorizationRevision
      !== input.namespaceSet.runtimeAuthorizationRevision
  ) throw new Error("Agent Memory Runtime authorization disagrees");
  if (!exactNamespaceAuthority(input)) {
    throw new Error("Agent Memory exact authority set disagrees");
  }
  const targetObjectId = deriveMemoryCryptoObjectIdV1({
    memoryId: input.memoryId,
    contentRevision: input.contentRevision,
  });
  const plaintext = encodeMemoryPayloadV1(input.payload);
  const namespaceKeys: Uint8Array[] = [];
  let dek: Uint8Array | null = null;
  try {
    const currentKeys = input.namespaceSet.namespaces.map((entry) => {
      const matches = entry.generations.filter((generation) =>
        generation.generation === entry.currentGeneration
      );
      if (matches.length !== 1) {
        throw new Error("Agent Memory current Namespace key is not exact");
      }
      const key = matches[0]!.key.slice();
      namespaceKeys.push(key);
      return Object.freeze({ entry, key });
    });
    const encrypted = encryptObjectPayload(
      input.crypto,
      {
        objectId: objectId(targetObjectId),
        keyClass: "ai",
        objectType: MEMORY_OBJECT_TYPE,
        createdAt: unixTimestamp(input.createdAt),
      },
      plaintext,
    );
    dek = encrypted.dek;
    const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
    const envelopeBytes = currentKeys.map(({ entry, key }) =>
      encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(
        input.crypto,
        key,
        {
          objectId: objectId(targetObjectId),
          namespaceId: namespaceId(entry.namespaceId),
          keyClass: "ai",
          keyGeneration: namespaceGeneration(entry.currentGeneration),
          bindingRevisionAtWrap: accessRevision(entry.accessRevision),
        },
        dek!,
      ))
    );
    const access = prepareAgentObjectAccessManifestGenesisSet(
      input.crypto,
      {
        objectId: objectId(targetObjectId),
        payloadHash: input.crypto.hash(payloadBytes),
        envelopeBytes,
        authoritySet: input.authoritySet,
        namespaceBindings: input.namespaceSet.namespaces.map((entry) => ({
          namespaceId: namespaceId(entry.namespaceId),
          domainId: cryptoDomainId(entry.domainId),
          expectedAccessRevision: accessRevision(entry.accessRevision),
          expectedPolicyRevision: authorizationRevision(entry.policyRevision),
          bindingHash: entry.bindingHash,
        })),
        agentAuthorizationRevision: authorizationRevision(
          input.namespaceSet.runtimeAuthorizationRevision,
        ),
        runtime: input.runtime,
        signerPublication: input.signerPublication,
      },
    );
    return createPreparedMemoryCryptoRevision({
      memoryId: input.memoryId,
      contentRevision: input.contentRevision,
      objectId: targetObjectId,
      requiredNamespaceIds: Object.freeze(
        input.namespaceSet.namespaces.map((entry) => entry.namespaceId),
      ),
      object: encryptedObjectWriteRecord(payloadBytes),
      access,
    });
  } finally {
    plaintext.fill(0);
    dek?.fill(0);
    namespaceKeys.forEach((key) => key.fill(0));
  }
}
