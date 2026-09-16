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
  type LatticeStorage,
  type PreparedAgentObjectAccessManifestGenesisSet,
} from "@nautilo/lattice-crypto";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import { decodeRecordPayloadV1 } from "../record-payload-v1";
import type { ProtectedAuthorityRepublisherPort } from "./authority-contracts";
import { deriveProtectedRecordObjectId } from "./protected-record-crypto";

export interface ProtectedRecordAuthorityNamespaceMaterial {
  readonly namespaceId: string;
  readonly domainId: string;
  readonly domainEpoch: number;
  readonly accessRevision: number;
  readonly policyRevision: number;
  readonly domainAgentAuthorizationRevision: number;
  readonly bindingHash: Uint8Array;
  readonly currentGeneration: number;
  readonly aiKey: Uint8Array;
}

export interface PreparedProtectedAuthorityPublication {
  readonly recordRef: string;
  readonly expectedRepresentationGeneration: number;
  readonly targetRepresentationGeneration: number;
  readonly objectId: string;
  readonly exactAccessNamespaceIds: readonly string[];
}

interface PreparedSnapshot {
  readonly publicHandle: PreparedProtectedAuthorityPublication;
  readonly object: Parameters<LatticeStorage["putObject"]>[0];
  readonly access: PreparedAgentObjectAccessManifestGenesisSet;
}

const snapshots = new WeakMap<PreparedProtectedAuthorityPublication, PreparedSnapshot>();

function exactAuthority(
  namespaces: readonly ProtectedRecordAuthorityNamespaceMaterial[],
  authority: GrantAuthoritySetExecutionEvidence,
): boolean {
  if (
    namespaces.length !== authority.namespaceRequirements.length
    || authority.domainRequirements.length
      !== new Set(namespaces.map((entry) => entry.domainId)).size
  ) return false;
  const domains = new Map(
    authority.domainRequirements.map((entry) => [entry.domainId, entry] as const),
  );
  const requirements = new Map(
    authority.namespaceRequirements.map((entry) => [entry.namespaceId, entry] as const),
  );
  if (requirements.size !== authority.namespaceRequirements.length) return false;
  return namespaces.every((entry) => {
    const requirement = requirements.get(entry.namespaceId);
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
 * Prepares one byte-identical canonical Record payload for an exact access-
 * Namespace set while Wave-11 authority and Namespace AI keys are live.
 */
export function prepareProtectedAuthorityPublication(input: Readonly<{
  crypto: LatticeCrypto;
  recordRef: string;
  expectedRepresentationGeneration: number;
  targetRepresentationGeneration: number;
  canonicalPayloadBytes: Uint8Array;
  createdAt: number;
  recipientAgentId: string;
  runtimeAuthorizationRevision: number;
  namespaces: readonly ProtectedRecordAuthorityNamespaceMaterial[];
  authoritySet: GrantAuthoritySetExecutionEvidence;
  runtime: AgentRuntimeKeyGeneration;
  signerPublication: AgentRuntimeSignerPublication;
}>): PreparedProtectedAuthorityPublication {
  decodeRecordPayloadV1(input.canonicalPayloadBytes);
  const namespaceIds = input.namespaces.map((entry) => entry.namespaceId);
  if (
    namespaceIds.length < 1
    || namespaceIds.length > 256
    || new Set(namespaceIds).size !== namespaceIds.length
    || input.authoritySet.recipientAgentId !== input.recipientAgentId
    || input.runtime.agentId !== input.recipientAgentId
    || input.signerPublication.authorizationRevision
      !== input.runtimeAuthorizationRevision
    || !exactAuthority(input.namespaces, input.authoritySet)
  ) throw new TypeError("Protected Record exact authority set disagrees");
  const plaintext = input.canonicalPayloadBytes.slice();
  const namespaceKeys: Uint8Array[] = [];
  let dek: Uint8Array | null = null;
  try {
    const durableObjectId = deriveProtectedRecordObjectId(
      input.crypto,
      input.recordRef,
      input.targetRepresentationGeneration,
    );
    const encrypted = encryptObjectPayload(input.crypto, {
      objectId: objectId(durableObjectId),
      keyClass: "ai",
      objectType: "nautilo.reflection.record.v1",
      createdAt: unixTimestamp(input.createdAt),
    }, plaintext);
    dek = encrypted.dek;
    const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
    const envelopeBytes = input.namespaces.map((entry) => {
      const key = entry.aiKey.slice();
      namespaceKeys.push(key);
      return encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(
        input.crypto,
        key,
        {
          objectId: objectId(durableObjectId),
          namespaceId: namespaceId(entry.namespaceId),
          keyClass: "ai",
          keyGeneration: namespaceGeneration(entry.currentGeneration),
          bindingRevisionAtWrap: accessRevision(entry.accessRevision),
        },
        dek!,
      ));
    });
    const access = prepareAgentObjectAccessManifestGenesisSet(input.crypto, {
      objectId: objectId(durableObjectId),
      payloadHash: input.crypto.hash(payloadBytes),
      envelopeBytes,
      authoritySet: input.authoritySet,
      namespaceBindings: input.namespaces.map((entry) => ({
        namespaceId: namespaceId(entry.namespaceId),
        domainId: cryptoDomainId(entry.domainId),
        expectedAccessRevision: accessRevision(entry.accessRevision),
        expectedPolicyRevision: authorizationRevision(entry.policyRevision),
        bindingHash: entry.bindingHash,
      })),
      agentAuthorizationRevision: authorizationRevision(
        input.runtimeAuthorizationRevision,
      ),
      runtime: input.runtime,
      signerPublication: input.signerPublication,
    });
    const publicHandle = Object.freeze({
      recordRef: input.recordRef,
      expectedRepresentationGeneration: input.expectedRepresentationGeneration,
      targetRepresentationGeneration: input.targetRepresentationGeneration,
      objectId: durableObjectId,
      exactAccessNamespaceIds: Object.freeze([...namespaceIds]),
    });
    snapshots.set(publicHandle, Object.freeze({
      publicHandle,
      object: encryptedObjectWriteRecord(payloadBytes),
      access,
    }));
    return publicHandle;
  } finally {
    plaintext.fill(0);
    dek?.fill(0);
    namespaceKeys.forEach((key) => key.fill(0));
  }
}

export interface ProtectedAuthorityCompletionPort {
  complete(input: Readonly<{
    object: Parameters<LatticeStorage["putObject"]>[0];
    access: PreparedAgentObjectAccessManifestGenesisSet;
  }>): Promise<"created" | "duplicate">;
  retire(cryptoObjectId: string): Promise<void>;
}

/** Opaque capability adapter; no caller-constructed ciphertext is accepted. */
export function createProtectedAuthorityRepublisherPort(input: Readonly<{
  resolvePrepared(
    workBindingRef: string,
    request: Parameters<ProtectedAuthorityRepublisherPort["republishExact"]>[0],
  ): PreparedProtectedAuthorityPublication | null;
  completion: ProtectedAuthorityCompletionPort;
}>): ProtectedAuthorityRepublisherPort {
  const port: ProtectedAuthorityRepublisherPort = {
    republishExact() {
      // Historical Agent-owned material cannot mint a live named Reflection
      // attachment fence. The current Lattice adapter owns this boundary.
      return Promise.resolve({status: "unavailable" as const, reason: "authorization_unavailable" as const});
    },
    retire: (cryptoObjectId: string) => input.completion.retire(cryptoObjectId),
  };
  return Object.freeze(port);
}
