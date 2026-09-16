import { bytesToHex } from "@noble/hashes/utils.js";

import {
  agentRuntimeSignerPublicationMatchesRuntimeV1,
  type AgentRuntimeSignerPublicationV1,
} from "../agent-runtime/signer-publication-v1.ts";
import type { AgentRuntimeGenerationV2 } from "../agent-runtime/types.ts";
import type { LatticeCrypto } from "../crypto/index.ts";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import {
  createAgentObjectAccessManifestV5,
  verifyObjectAccessManifestChainV5,
  type ObjectAccessManifestV5,
  type ResolveAgentRuntimeSignerPublicKeyV5,
  type ResolveHistoricalHumanDeviceSigningPublicKeyV5,
  type ResolveHistoricalProcessorIssuingDevicePublicKeyV5,
  type ResolveProcessorSignerAuthorizationBytesV5,
  type TrustedMinimumObjectAccessHeadV5,
} from "../format/object-access-manifest-v5.ts";
import {
  decodeNamespaceObjectEnvelopeV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../format/object-v2.ts";
import {
  assertAuthenticGrantAuthoritySetExecutionEvidenceV2,
  type GrantAuthoritySetExecutionEvidenceV2,
  type GrantAuthoritySetExecutionUseStatusV2,
} from "../grant/set-storage-coordinator.ts";
import {
  accessRevision,
  authorizationRevision,
  cryptoDomainId,
  namespaceId,
  objectId,
} from "../v2-types/ids.ts";
import { V2_LIMITS, assertV2Range } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

const HASH_BYTES = 32;

export interface AgentObjectAccessSetEnvelopeContextV3 {
  readonly objectId: string;
  readonly namespaceId: string;
  readonly keyClass: "ai";
  readonly keyGeneration: number;
  readonly bindingRevisionAtWrap: number;
  readonly envelopeHash: Uint8Array;
}

export interface AgentObjectAccessSetNamespaceBindingV3 {
  readonly namespaceId: string;
  readonly domainId: string;
  readonly expectedAccessRevision: number;
  readonly expectedPolicyRevision: number;
  readonly bindingHash: Uint8Array;
}

export interface AgentObjectAccessGenesisSetAuthorityContextV3 {
  readonly purpose: "persist-agent-object-access-genesis-set";
  readonly objectId: string;
  readonly payloadHash: Uint8Array;
  readonly grantId: string;
  readonly grantHash: Uint8Array;
  readonly grantUseStatus: GrantAuthoritySetExecutionUseStatusV2;
  readonly grantScope: readonly string[];
  readonly grantOperations: readonly ("decrypt" | "encrypt")[];
  readonly namespaceRequirements:
    GrantAuthoritySetExecutionEvidenceV2["namespaceRequirements"];
  readonly namespaceBindings:
    readonly AgentObjectAccessSetNamespaceBindingV3[];
  readonly domainRequirements:
    GrantAuthoritySetExecutionEvidenceV2["domainRequirements"];
  readonly envelopes: readonly AgentObjectAccessSetEnvelopeContextV3[];
  readonly agentId: string;
  readonly runtimeGeneration: number;
  readonly agentAuthorizationRevision: number;
  readonly signerKeyId: string;
}

export interface PrepareAgentObjectAccessManifestGenesisSetInputV3 {
  readonly objectId: string;
  readonly payloadHash: Uint8Array;
  readonly envelopeBytes: readonly Uint8Array[];
  readonly authoritySet: GrantAuthoritySetExecutionEvidenceV2;
  readonly namespaceBindings:
    readonly AgentObjectAccessSetNamespaceBindingV3[];
  readonly agentAuthorizationRevision: number;
  readonly runtime: AgentRuntimeGenerationV2;
  readonly signerPublication: AgentRuntimeSignerPublicationV1;
}

export interface PreparedAgentObjectAccessManifestGenesisSetV3 {
  readonly manifest: ObjectAccessManifestV5;
  readonly manifestBytes: Uint8Array;
  readonly manifestHash: Uint8Array;
  readonly envelopeBytes: readonly Uint8Array[];
  readonly authority: AgentObjectAccessGenesisSetAuthorityContextV3;
}

export interface AgentObjectAccessUpdateSetAuthorityContextV3 {
  readonly purpose: "persist-agent-object-access-update-set";
  readonly objectId: string;
  readonly payloadHash: Uint8Array;
  readonly grantId: string;
  readonly grantHash: Uint8Array;
  readonly grantUseStatus: GrantAuthoritySetExecutionUseStatusV2;
  readonly grantScope: readonly string[];
  readonly grantOperations: readonly ("decrypt" | "encrypt")[];
  readonly namespaceRequirements:
    GrantAuthoritySetExecutionEvidenceV2["namespaceRequirements"];
  readonly domainRequirements:
    GrantAuthoritySetExecutionEvidenceV2["domainRequirements"];
  readonly currentNamespaceIds: readonly string[];
  readonly currentNamespaceBindings:
    readonly AgentObjectAccessSetNamespaceBindingV3[];
  readonly targetNamespaceBindings:
    readonly AgentObjectAccessSetNamespaceBindingV3[];
  readonly removedNamespaceIds: readonly string[];
  readonly addedNamespaceIds: readonly string[];
  readonly currentEnvelopes:
    readonly AgentObjectAccessSetEnvelopeContextV3[];
  readonly targetEnvelopes:
    readonly AgentObjectAccessSetEnvelopeContextV3[];
  /** @deprecated Use targetEnvelopes. */
  readonly envelopes: readonly AgentObjectAccessSetEnvelopeContextV3[];
  readonly agentId: string;
  readonly runtimeGeneration: number;
  readonly agentAuthorizationRevision: number;
  readonly signerKeyId: string;
}

export interface PrepareAgentObjectAccessManifestUpdateSetInputV3 {
  readonly currentManifestBytes: Uint8Array;
  readonly currentEnvelopeBytes: readonly Uint8Array[];
  readonly targetEnvelopeBytes: readonly Uint8Array[];
  readonly authoritySet: GrantAuthoritySetExecutionEvidenceV2;
  readonly currentNamespaceBindings:
    readonly AgentObjectAccessSetNamespaceBindingV3[];
  readonly targetNamespaceBindings:
    readonly AgentObjectAccessSetNamespaceBindingV3[];
  readonly trustedMinimumHead: TrustedMinimumObjectAccessHeadV5;
  readonly proof: readonly Uint8Array[];
  readonly resolveHistoricalHumanDeviceSigningPublicKey:
    ResolveHistoricalHumanDeviceSigningPublicKeyV5;
  readonly resolveAgentRuntimeSignerPublicKey:
    ResolveAgentRuntimeSignerPublicKeyV5;
  readonly resolveProcessorSignerAuthorizationBytes:
    ResolveProcessorSignerAuthorizationBytesV5;
  readonly resolveHistoricalProcessorIssuingDevicePublicKey:
    ResolveHistoricalProcessorIssuingDevicePublicKeyV5;
  readonly agentAuthorizationRevision: number;
  readonly runtime: AgentRuntimeGenerationV2;
  readonly signerPublication: AgentRuntimeSignerPublicationV1;
}

export interface PreparedAgentObjectAccessManifestUpdateSetV3 {
  readonly manifest: ObjectAccessManifestV5;
  readonly manifestBytes: Uint8Array;
  readonly manifestHash: Uint8Array;
  readonly envelopeBytes: readonly Uint8Array[];
  readonly authority: AgentObjectAccessUpdateSetAuthorityContextV3;
}

type PreparedSnapshot = Readonly<{
  manifestBytes: Uint8Array;
  manifestHash: Uint8Array;
  envelopeBytes: readonly Uint8Array[];
  authorityFingerprint: string;
}>;

const preparedSnapshots = new WeakMap<object, PreparedSnapshot>();
const preparedUpdateSnapshots = new WeakMap<object, PreparedSnapshot>();
const preparedDeletionSnapshots = new WeakMap<object, Readonly<{
  manifestBytes: Uint8Array;
  manifestHash: Uint8Array;
  authorityFingerprint: string;
}>>();

export type PrepareAgentMemoryDeletionInputV1 = Omit<
  PrepareAgentObjectAccessManifestUpdateSetInputV3,
  | "currentNamespaceBindings"
  | "targetEnvelopeBytes"
  | "targetNamespaceBindings"
> & Readonly<{
  currentNamespaceBindings:
    readonly AgentObjectAccessSetNamespaceBindingV3[];
}>;

export interface AgentMemoryDeletionAuthorityContextV1 {
  readonly purpose: "persist-agent-memory-deletion";
  readonly objectId: string;
  readonly payloadHash: Uint8Array;
  readonly currentAccessRevision: number;
  readonly currentManifestHash: Uint8Array;
  readonly grantId: string;
  readonly grantHash: Uint8Array;
  readonly grantUseStatus: GrantAuthoritySetExecutionUseStatusV2;
  readonly namespaceRequirements:
    GrantAuthoritySetExecutionEvidenceV2["namespaceRequirements"];
  readonly currentNamespaceBindings:
    readonly AgentObjectAccessSetNamespaceBindingV3[];
  readonly domainRequirements:
    GrantAuthoritySetExecutionEvidenceV2["domainRequirements"];
  readonly agentId: string;
  readonly runtimeGeneration: number;
  readonly agentAuthorizationRevision: number;
  readonly signerKeyId: string;
}

export interface PreparedAgentMemoryDeletionV1 {
  readonly manifest: ObjectAccessManifestV5;
  readonly manifestBytes: Uint8Array;
  readonly manifestHash: Uint8Array;
  readonly authority: AgentMemoryDeletionAuthorityContextV1;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function exactHash(label: string, value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== HASH_BYTES) {
    throw new TypeError(`${label} must be exactly ${HASH_BYTES} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function cloneNamespaceRequirements(
  value: GrantAuthoritySetExecutionEvidenceV2["namespaceRequirements"],
): GrantAuthoritySetExecutionEvidenceV2["namespaceRequirements"] {
  return Object.freeze(value.map((entry) => Object.freeze({
    ...entry,
    operations: Object.freeze([...entry.operations]),
    namespaceParticipants: Object.freeze([...entry.namespaceParticipants]),
  })));
}

function cloneDomainRequirements(
  value: GrantAuthoritySetExecutionEvidenceV2["domainRequirements"],
): GrantAuthoritySetExecutionEvidenceV2["domainRequirements"] {
  return Object.freeze(value.map((entry) => Object.freeze({ ...entry })));
}

function cloneAuthority(
  value: AgentObjectAccessGenesisSetAuthorityContextV3,
): AgentObjectAccessGenesisSetAuthorityContextV3 {
  return Object.freeze({
    ...value,
    payloadHash: copyOwnedBytesV2(value.payloadHash),
    grantHash: copyOwnedBytesV2(value.grantHash),
    grantScope: Object.freeze([...value.grantScope]),
    grantOperations: Object.freeze([...value.grantOperations]),
    namespaceRequirements:
      cloneNamespaceRequirements(value.namespaceRequirements),
    namespaceBindings: Object.freeze(value.namespaceBindings.map((entry) =>
      Object.freeze({
        ...entry,
        bindingHash: copyOwnedBytesV2(entry.bindingHash),
      })
    )),
    domainRequirements: cloneDomainRequirements(value.domainRequirements),
    envelopes: Object.freeze(value.envelopes.map((entry) => Object.freeze({
      ...entry,
      envelopeHash: copyOwnedBytesV2(entry.envelopeHash),
    }))),
  });
}

function cloneUpdateAuthority(
  value: AgentObjectAccessUpdateSetAuthorityContextV3,
): AgentObjectAccessUpdateSetAuthorityContextV3 {
  return Object.freeze({
    ...value,
    payloadHash: copyOwnedBytesV2(value.payloadHash),
    grantHash: copyOwnedBytesV2(value.grantHash),
    grantScope: Object.freeze([...value.grantScope]),
    grantOperations: Object.freeze([...value.grantOperations]),
    namespaceRequirements:
      cloneNamespaceRequirements(value.namespaceRequirements),
    domainRequirements: cloneDomainRequirements(value.domainRequirements),
    currentNamespaceIds: Object.freeze([...value.currentNamespaceIds]),
    currentNamespaceBindings: Object.freeze(
      value.currentNamespaceBindings.map((entry) => Object.freeze({
        ...entry,
        bindingHash: copyOwnedBytesV2(entry.bindingHash),
      })),
    ),
    targetNamespaceBindings: Object.freeze(
      value.targetNamespaceBindings.map((entry) => Object.freeze({
        ...entry,
        bindingHash: copyOwnedBytesV2(entry.bindingHash),
      })),
    ),
    removedNamespaceIds: Object.freeze([...value.removedNamespaceIds]),
    addedNamespaceIds: Object.freeze([...value.addedNamespaceIds]),
    currentEnvelopes: Object.freeze(value.currentEnvelopes.map((entry) =>
      Object.freeze({
        ...entry,
        envelopeHash: copyOwnedBytesV2(entry.envelopeHash),
      })
    )),
    targetEnvelopes: Object.freeze(value.targetEnvelopes.map((entry) =>
      Object.freeze({
        ...entry,
        envelopeHash: copyOwnedBytesV2(entry.envelopeHash),
      })
    )),
    envelopes: Object.freeze(value.envelopes.map((entry) => Object.freeze({
      ...entry,
      envelopeHash: copyOwnedBytesV2(entry.envelopeHash),
    }))),
  });
}

function authorityFingerprint(
  value: AgentObjectAccessGenesisSetAuthorityContextV3,
): string {
  return JSON.stringify({
    ...value,
    payloadHash: bytesToHex(value.payloadHash),
    grantHash: bytesToHex(value.grantHash),
    namespaceBindings: value.namespaceBindings.map((entry) => ({
      ...entry,
      bindingHash: bytesToHex(entry.bindingHash),
    })),
    envelopes: value.envelopes.map((entry) => ({
      ...entry,
      envelopeHash: bytesToHex(entry.envelopeHash),
    })),
  });
}

function updateAuthorityFingerprint(
  value: AgentObjectAccessUpdateSetAuthorityContextV3,
): string {
  return JSON.stringify({
    ...value,
    payloadHash: bytesToHex(value.payloadHash),
    grantHash: bytesToHex(value.grantHash),
    currentNamespaceBindings: value.currentNamespaceBindings.map((entry) => ({
      ...entry,
      bindingHash: bytesToHex(entry.bindingHash),
    })),
    targetNamespaceBindings: value.targetNamespaceBindings.map((entry) => ({
      ...entry,
      bindingHash: bytesToHex(entry.bindingHash),
    })),
    currentEnvelopes: value.currentEnvelopes.map((entry) => ({
      ...entry,
      envelopeHash: bytesToHex(entry.envelopeHash),
    })),
    targetEnvelopes: value.targetEnvelopes.map((entry) => ({
      ...entry,
      envelopeHash: bytesToHex(entry.envelopeHash),
    })),
    envelopes: value.envelopes.map((entry) => ({
      ...entry,
      envelopeHash: bytesToHex(entry.envelopeHash),
    })),
  });
}

function deletionAuthorityFingerprint(
  value: AgentMemoryDeletionAuthorityContextV1,
): string {
  return JSON.stringify({
    ...value,
    payloadHash: bytesToHex(value.payloadHash),
    currentManifestHash: bytesToHex(value.currentManifestHash),
    grantHash: bytesToHex(value.grantHash),
    currentNamespaceBindings: value.currentNamespaceBindings.map((entry) => ({
      ...entry,
      bindingHash: bytesToHex(entry.bindingHash),
    })),
  });
}

function compareHash(
  left: Readonly<{ envelopeHash: Uint8Array }>,
  right: Readonly<{ envelopeHash: Uint8Array }>,
): number {
  return compareUnsignedUtf8(
    bytesToHex(left.envelopeHash),
    bytesToHex(right.envelopeHash),
  );
}

export function prepareAgentObjectAccessManifestGenesisSetV3(
  crypto: LatticeCrypto,
  input: PrepareAgentObjectAccessManifestGenesisSetInputV3,
): PreparedAgentObjectAccessManifestGenesisSetV3 {
  assertAuthenticGrantAuthoritySetExecutionEvidenceV2(input.authoritySet);
  const targetObjectId = objectId(input.objectId);
  const payloadHash = exactHash("Agent object payload hash", input.payloadHash);
  const requirements = input.authoritySet.namespaceRequirements;
  assertV2Range(
    "Agent object exact Namespace set",
    requirements.length,
    1,
    V2_LIMITS.namespaceEnvelopesPerManifest,
  );
  if (
    requirements.some((entry) => !entry.operations.includes("encrypt"))
  ) {
    throw new TypeError(
      "Agent object exact Namespace set requires encrypt authority",
    );
  }
  if (
    !Array.isArray(input.namespaceBindings as unknown)
    || input.namespaceBindings.length !== requirements.length
  ) {
    throw new TypeError(
      "Agent object Namespace binding set must be exact",
    );
  }
  const namespaceBindings = input.namespaceBindings.map((binding, index) => {
    const fields = Object.keys(binding).sort(compareUnsignedUtf8);
    const expectedFields = [
      "bindingHash",
      "domainId",
      "expectedAccessRevision",
      "expectedPolicyRevision",
      "namespaceId",
    ];
    const requirement = requirements[index]!;
    if (
      fields.length !== expectedFields.length
      || fields.some((field, fieldIndex) =>
        field !== expectedFields[fieldIndex]
      )
      || binding.namespaceId !== requirement.namespaceId
      || binding.domainId !== requirement.domainId
      || binding.expectedAccessRevision
        !== requirement.expectedAccessRevision
      || binding.expectedPolicyRevision
        !== requirement.expectedPolicyRevision
    ) {
      throw new TypeError(
        "Agent object Namespace binding coordinates must exactly match authority",
      );
    }
    return Object.freeze({
      namespaceId: binding.namespaceId,
      domainId: binding.domainId,
      expectedAccessRevision: binding.expectedAccessRevision,
      expectedPolicyRevision: binding.expectedPolicyRevision,
      bindingHash: exactHash(
        "Agent object Namespace binding hash",
        binding.bindingHash,
      ),
    });
  });
  if (
    !Array.isArray(input.envelopeBytes as unknown)
    || input.envelopeBytes.length !== requirements.length
  ) {
    throw new TypeError(
      "Agent object genesis requires the exact Namespace envelope set",
    );
  }
  const requiredDomains = [...new Set(
    requirements.map((entry) => entry.domainId),
  )].sort(compareUnsignedUtf8);
  if (
    requiredDomains.length !== input.authoritySet.domainRequirements.length
    || requiredDomains.some((domainId, index) =>
      domainId !== input.authoritySet.domainRequirements[index]!.domainId
    )
  ) {
    throw new TypeError(
      "Agent object Domain set must exactly cover its Namespace set",
    );
  }
  const requirementByNamespace = new Map(
    requirements.map((entry) => [entry.namespaceId, entry] as const),
  );
  let aggregateBytes = 0;
  const entries: Array<Readonly<{
    envelopeBytes: Uint8Array;
    context: AgentObjectAccessSetEnvelopeContextV3;
  }>> = [];
  try {
    for (const sourceBytes of input.envelopeBytes) {
      if (!(sourceBytes instanceof Uint8Array)) {
        throw new TypeError(
          "Agent object Namespace envelope must be Uint8Array",
        );
      }
      aggregateBytes += sourceBytes.length;
      if (aggregateBytes > V2_LIMITS.manifestEnvelopeBytes) {
        throw new RangeError(
          "Agent object Namespace envelope bytes exceed limit",
        );
      }
      const envelopeBytes = copyOwnedBytesV2(sourceBytes);
      let accepted = false;
      try {
        const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
        const requirement = requirementByNamespace.get(
          envelope.context.namespaceId,
        );
        if (
          requirement === undefined
          || envelope.context.objectId !== targetObjectId
          || envelope.context.keyClass !== "ai"
          || envelope.context.bindingRevisionAtWrap
            !== requirement.expectedAccessRevision
          || !equalBytes(
            encodeNamespaceObjectEnvelopeV2(envelope),
            envelopeBytes,
          )
        ) {
          throw new Error(
            "Agent object exact Namespace envelope coordinates disagree",
          );
        }
        entries.push(Object.freeze({
          envelopeBytes,
          context: Object.freeze({
            objectId: targetObjectId,
            namespaceId: envelope.context.namespaceId,
            keyClass: "ai" as const,
            keyGeneration: envelope.context.keyGeneration,
            bindingRevisionAtWrap: envelope.context.bindingRevisionAtWrap,
            envelopeHash: exactHash(
              "Agent object Namespace envelope hash",
              crypto.hash(envelopeBytes),
            ),
          }),
        }));
        accepted = true;
      } finally {
        if (!accepted) envelopeBytes.fill(0);
      }
    }
  } catch (cause) {
    entries.forEach((entry) => entry.envelopeBytes.fill(0));
    throw cause;
  }
  try {
    const actualNamespaceIds = entries
      .map((entry) => entry.context.namespaceId)
      .sort(compareUnsignedUtf8);
    if (
      new Set(actualNamespaceIds).size !== actualNamespaceIds.length
      || actualNamespaceIds.some((namespaceId, index) =>
        namespaceId !== requirements[index]!.namespaceId
      )
    ) {
      entries.forEach((entry) => entry.envelopeBytes.fill(0));
      throw new TypeError(
        "Agent object genesis requires the exact Namespace envelope set",
      );
    }
    const agentAuthorization = authorizationRevision(
      input.agentAuthorizationRevision,
    );
    if (
      input.authoritySet.recipientAgentId !== input.runtime.agentId
      || input.signerPublication.authorizationRevision !== agentAuthorization
      || !agentRuntimeSignerPublicationMatchesRuntimeV1(
        crypto,
        input.runtime,
        input.signerPublication,
      )
    ) {
      entries.forEach((entry) => entry.envelopeBytes.fill(0));
      throw new Error("Agent object Runtime signer authority disagrees");
    }
    entries.sort((left, right) => compareHash(left.context, right.context));
    const genesis = createAgentObjectAccessManifestV5(
      crypto,
      {
        objectId: targetObjectId,
        payloadHash,
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: entries.map((entry) => entry.context.envelopeHash),
        signer: {
          kind: "agent_runtime",
          agentId: input.runtime.agentId,
          runtimeGeneration: input.runtime.generation,
          signerKeyId: input.signerPublication.signerKeyId,
        },
        signerAuthorizationHash: null,
        hostAuthorizationRevision: agentAuthorization,
      },
      input.runtime,
    );
    const contextsByNamespace = [...entries]
      .sort((left, right) => compareUnsignedUtf8(
        left.context.namespaceId,
        right.context.namespaceId,
      ))
      .map((entry) => entry.context);
    const authority = cloneAuthority({
      purpose: "persist-agent-object-access-genesis-set",
      objectId: targetObjectId,
      payloadHash,
      grantId: input.authoritySet.grantId,
      grantHash: input.authoritySet.grantHash,
      grantUseStatus: input.authoritySet.grantUseStatus,
      grantScope: input.authoritySet.grantScope,
      grantOperations: input.authoritySet.operations,
      namespaceRequirements: input.authoritySet.namespaceRequirements,
      namespaceBindings,
      domainRequirements: input.authoritySet.domainRequirements,
      envelopes: contextsByNamespace,
      agentId: input.runtime.agentId,
      runtimeGeneration: input.runtime.generation,
      agentAuthorizationRevision: agentAuthorization,
      signerKeyId: input.signerPublication.signerKeyId,
    });
    const prepared = Object.freeze({
      manifest: genesis.manifest,
      manifestBytes: genesis.bytes,
      manifestHash: genesis.hash,
      envelopeBytes: Object.freeze(entries.map((entry) => entry.envelopeBytes)),
      authority,
    });
    preparedSnapshots.set(prepared, Object.freeze({
      manifestBytes: copyOwnedBytesV2(prepared.manifestBytes),
      manifestHash: copyOwnedBytesV2(prepared.manifestHash),
      envelopeBytes: Object.freeze(
        prepared.envelopeBytes.map(copyOwnedBytesV2),
      ),
      authorityFingerprint: authorityFingerprint(authority),
    }));
    return prepared;
  } catch (cause) {
    entries.forEach((entry) => {
      entry.envelopeBytes.fill(0);
      entry.context.envelopeHash.fill(0);
    });
    throw cause;
  }
}

function cloneExactUpdateBindingSet(
  label: string,
  bindings: readonly AgentObjectAccessSetNamespaceBindingV3[],
  allowEmpty: boolean,
): readonly AgentObjectAccessSetNamespaceBindingV3[] {
  if (!Array.isArray(bindings as unknown)) {
    throw new TypeError(`${label} must be an array`);
  }
  assertV2Range(
    `${label} count`,
    bindings.length,
    allowEmpty ? 0 : 1,
    V2_LIMITS.namespaceEnvelopesPerManifest,
  );
  const expectedFields = [
    "bindingHash",
    "domainId",
    "expectedAccessRevision",
    "expectedPolicyRevision",
    "namespaceId",
  ];
  const cloned: AgentObjectAccessSetNamespaceBindingV3[] = [];
  try {
    for (const binding of bindings) {
      if (typeof binding !== "object" || binding === null) {
        throw new TypeError(`${label} entry must be an object`);
      }
      const fields = Object.keys(binding).sort(compareUnsignedUtf8);
      if (
        fields.length !== expectedFields.length
        || fields.some((field, index) => field !== expectedFields[index])
      ) throw new TypeError(`${label} fields must be exact`);
      assertV2Range(
        `${label} expected access revision`,
        binding.expectedAccessRevision,
        0,
        Number.MAX_SAFE_INTEGER,
      );
      assertV2Range(
        `${label} expected policy revision`,
        binding.expectedPolicyRevision,
        0,
        Number.MAX_SAFE_INTEGER,
      );
      const next = Object.freeze({
        namespaceId: namespaceId(binding.namespaceId),
        domainId: cryptoDomainId(binding.domainId),
        expectedAccessRevision: accessRevision(
          binding.expectedAccessRevision,
        ),
        expectedPolicyRevision: binding.expectedPolicyRevision,
        bindingHash: exactHash(`${label} binding hash`, binding.bindingHash),
      });
      const previous = cloned.at(-1);
      if (
        previous !== undefined
        && compareUnsignedUtf8(previous.namespaceId, next.namespaceId) >= 0
      ) {
        next.bindingHash.fill(0);
        throw new TypeError(
          `${label} must use canonical unique Namespace ordering`,
        );
      }
      cloned.push(next);
    }
    return Object.freeze(cloned);
  } catch (cause) {
    cloned.forEach((entry) => entry.bindingHash.fill(0));
    throw cause;
  }
}

function bindingFingerprint(
  binding: AgentObjectAccessSetNamespaceBindingV3,
): string {
  return JSON.stringify({
    ...binding,
    bindingHash: bytesToHex(binding.bindingHash),
  });
}

function exactEnvelopeSetForUpdate(
  crypto: LatticeCrypto,
  input: Readonly<{
    objectId: string;
    envelopeBytes: readonly Uint8Array[];
    bindings: readonly AgentObjectAccessSetNamespaceBindingV3[];
    allowEmpty: boolean;
  }>,
): Array<Readonly<{
  envelopeBytes: Uint8Array;
  context: AgentObjectAccessSetEnvelopeContextV3;
}>> {
  if (!Array.isArray(input.envelopeBytes as unknown)) {
    throw new TypeError("Agent object Namespace envelopes must be an array");
  }
  assertV2Range(
    "Agent object exact Namespace set",
    input.envelopeBytes.length,
    input.allowEmpty ? 0 : 1,
    V2_LIMITS.namespaceEnvelopesPerManifest,
  );
  if (input.envelopeBytes.length !== input.bindings.length) {
    throw new TypeError(
      "Agent object exact Namespace envelope set must match its binding set",
    );
  }
  const bindingByNamespace = new Map(
    input.bindings.map((binding) => [binding.namespaceId, binding] as const),
  );
  let aggregateBytes = 0;
  const entries: Array<Readonly<{
    envelopeBytes: Uint8Array;
    context: AgentObjectAccessSetEnvelopeContextV3;
  }>> = [];
  try {
    for (const sourceBytes of input.envelopeBytes) {
      if (!(sourceBytes instanceof Uint8Array)) {
        throw new TypeError("Agent object Namespace envelope must be Uint8Array");
      }
      aggregateBytes += sourceBytes.length;
      if (aggregateBytes > V2_LIMITS.manifestEnvelopeBytes) {
        throw new RangeError("Agent object Namespace envelope bytes exceed limit");
      }
      let envelopeBytes: Uint8Array | undefined;
      let accepted = false;
      try {
        const envelope = decodeNamespaceObjectEnvelopeV2(sourceBytes);
        envelopeBytes = encodeNamespaceObjectEnvelopeV2(envelope);
        const binding = bindingByNamespace.get(
          envelope.context.namespaceId,
        );
        if (
          binding === undefined
          || envelope.context.objectId !== input.objectId
          || envelope.context.keyClass !== "ai"
          || envelope.context.bindingRevisionAtWrap
            > binding.expectedAccessRevision
          || !equalBytes(envelopeBytes, sourceBytes)
        ) {
          throw new Error(
            "Agent object exact Namespace envelope coordinates disagree",
          );
        }
        entries.push(Object.freeze({
          envelopeBytes,
          context: Object.freeze({
            objectId: input.objectId,
            namespaceId: envelope.context.namespaceId,
            keyClass: "ai" as const,
            keyGeneration: envelope.context.keyGeneration,
            bindingRevisionAtWrap: envelope.context.bindingRevisionAtWrap,
            envelopeHash: exactHash(
              "Agent object Namespace envelope hash",
              crypto.hash(envelopeBytes),
            ),
          }),
        }));
        accepted = true;
      } finally {
        if (!accepted) envelopeBytes?.fill(0);
      }
    }
    const namespaceIds = entries.map((entry) => entry.context.namespaceId)
      .sort(compareUnsignedUtf8);
    if (
      new Set(namespaceIds).size !== namespaceIds.length
      || namespaceIds.some((id, index) => id !== input.bindings[index]!.namespaceId)
    ) {
      throw new TypeError(
        "Agent object exact Namespace envelope set must match its binding set",
      );
    }
    entries.sort((left, right) => compareHash(left.context, right.context));
    return entries;
  } catch (cause) {
    entries.forEach((entry) => entry.envelopeBytes.fill(0));
    throw cause;
  }
}

function exactUpdateDelta(
  currentBindings: readonly AgentObjectAccessSetNamespaceBindingV3[],
  targetBindings: readonly AgentObjectAccessSetNamespaceBindingV3[],
  currentEntries: readonly ReturnType<typeof exactEnvelopeSetForUpdate>[number][],
  targetEntries: readonly ReturnType<typeof exactEnvelopeSetForUpdate>[number][],
): Readonly<{
  removedNamespaceIds: readonly string[];
  addedNamespaceIds: readonly string[];
}> {
  const currentEntriesByNamespace = new Map(currentEntries.map((entry) =>
    [entry.context.namespaceId, entry] as const
  ));
  const targetEntriesByNamespace = new Map(targetEntries.map((entry) =>
    [entry.context.namespaceId, entry] as const
  ));
  const currentBindingsByNamespace = new Map(currentBindings.map((binding) =>
    [binding.namespaceId, binding] as const
  ));
  const targetBindingsByNamespace = new Map(targetBindings.map((binding) =>
    [binding.namespaceId, binding] as const
  ));
  const removedNamespaceIds = currentBindings
    .filter((binding) => !targetBindingsByNamespace.has(binding.namespaceId))
    .map((binding) => binding.namespaceId);
  const addedNamespaceIds = targetBindings
    .filter((binding) => !currentBindingsByNamespace.has(binding.namespaceId))
    .map((binding) => binding.namespaceId);
  for (const namespace of addedNamespaceIds) {
    const binding = targetBindingsByNamespace.get(namespace)!;
    const envelope = targetEntriesByNamespace.get(namespace)!;
    if (
      envelope.context.bindingRevisionAtWrap
        !== binding.expectedAccessRevision
    ) throw new TypeError(
      "Agent object added Namespace envelope uses a stale binding revision",
    );
  }
  for (const currentBinding of currentBindings) {
    const targetBinding = targetBindingsByNamespace.get(
      currentBinding.namespaceId,
    );
    if (targetBinding === undefined) continue;
    const currentEnvelope = currentEntriesByNamespace.get(
      currentBinding.namespaceId,
    )!;
    const targetEnvelope = targetEntriesByNamespace.get(
      currentBinding.namespaceId,
    )!;
    if (
      bindingFingerprint(currentBinding) !== bindingFingerprint(targetBinding)
      || !equalBytes(
        currentEnvelope.envelopeBytes,
        targetEnvelope.envelopeBytes,
      )
    ) throw new TypeError(
      "Agent object retained Namespace binding or envelope was substituted",
    );
  }
  if (removedNamespaceIds.length === 0 && addedNamespaceIds.length === 0) {
    throw new TypeError("Agent object exact target is unchanged");
  }
  return Object.freeze({
    removedNamespaceIds: Object.freeze(removedNamespaceIds),
    addedNamespaceIds: Object.freeze(addedNamespaceIds),
  });
}

function cloneEnvelopeContexts(
  entries: readonly ReturnType<typeof exactEnvelopeSetForUpdate>[number][],
): readonly AgentObjectAccessSetEnvelopeContextV3[] {
  return Object.freeze(entries
    .slice()
    .sort((left, right) => compareUnsignedUtf8(
      left.context.namespaceId,
      right.context.namespaceId,
    ))
    .map((entry) => Object.freeze({
      ...entry.context,
      envelopeHash: copyOwnedBytesV2(entry.context.envelopeHash),
    })));
}

/**
 * Creates one authenticated exact Namespace-set access revision. The
 * caller must hold decrypt authority for removed Namespaces and encrypt
 * authority for added Namespaces. Retained bindings and envelopes are copied
 * byte-for-byte without requiring their Domain roots.
 */
function prepareAgentObjectAccessManifestUpdateSetInternalV3(
  crypto: LatticeCrypto,
  input: PrepareAgentObjectAccessManifestUpdateSetInputV3,
  allowEmptyTarget: boolean,
): PreparedAgentObjectAccessManifestUpdateSetV3 {
  assertAuthenticGrantAuthoritySetExecutionEvidenceV2(input.authoritySet);
  const current = verifyObjectAccessManifestChainV5(crypto, {
    manifestBytes: input.currentManifestBytes,
    proof: input.proof,
    trustedMinimumHead: input.trustedMinimumHead,
    resolveHistoricalHumanDeviceSigningPublicKey:
      input.resolveHistoricalHumanDeviceSigningPublicKey,
    resolveAgentRuntimeSignerPublicKey:
      input.resolveAgentRuntimeSignerPublicKey,
    resolveProcessorSignerAuthorizationBytes:
      input.resolveProcessorSignerAuthorizationBytes,
    resolveHistoricalProcessorIssuingDevicePublicKey:
      input.resolveHistoricalProcessorIssuingDevicePublicKey,
  });
  let currentBindings: readonly AgentObjectAccessSetNamespaceBindingV3[] = [];
  let targetBindings: readonly AgentObjectAccessSetNamespaceBindingV3[] = [];
  let currentEntries: ReturnType<typeof exactEnvelopeSetForUpdate> = [];
  let targetEntries: ReturnType<typeof exactEnvelopeSetForUpdate> = [];
  let currentContexts: readonly AgentObjectAccessSetEnvelopeContextV3[] = [];
  let targetContexts: readonly AgentObjectAccessSetEnvelopeContextV3[] = [];
  let succeeded = false;
  try {
    currentBindings = cloneExactUpdateBindingSet(
      "Agent object current Namespace bindings",
      input.currentNamespaceBindings,
      false,
    );
    targetBindings = cloneExactUpdateBindingSet(
      "Agent object target Namespace bindings",
      input.targetNamespaceBindings,
      allowEmptyTarget,
    );
    currentEntries = exactEnvelopeSetForUpdate(crypto, {
      objectId: current.manifest.objectId,
      envelopeBytes: input.currentEnvelopeBytes,
      bindings: currentBindings,
      allowEmpty: false,
    });
    const currentHashes = currentEntries.map((entry) => entry.context.envelopeHash)
      .sort((left, right) => compareUnsignedUtf8(bytesToHex(left), bytesToHex(right)));
    if (
      currentHashes.length !== current.manifest.envelopeHashes.length
      || currentHashes.some((hash, index) =>
        !equalBytes(hash, current.manifest.envelopeHashes[index]!)
      )
    ) {
      throw new Error("Agent object current envelope inventory is inexact");
    }
    targetEntries = exactEnvelopeSetForUpdate(crypto, {
      objectId: current.manifest.objectId,
      envelopeBytes: input.targetEnvelopeBytes,
      bindings: targetBindings,
      allowEmpty: allowEmptyTarget,
    });
    const delta = exactUpdateDelta(
      currentBindings,
      targetBindings,
      currentEntries,
      targetEntries,
    );
    const currentNamespaceIds = currentBindings.map((entry) =>
      entry.namespaceId
    );
    const deltaNamespaceIds = [
      ...delta.removedNamespaceIds,
      ...delta.addedNamespaceIds,
    ].sort(compareUnsignedUtf8);
    const authorizedNamespaceIds = input.authoritySet.namespaceRequirements
      .map((entry) => entry.namespaceId);
    if (
      deltaNamespaceIds.length !== authorizedNamespaceIds.length
      || deltaNamespaceIds.some((entry, index) =>
        entry !== authorizedNamespaceIds[index]
      )
    ) {
      throw new TypeError(
        "Agent object access update authority must exactly cover its removed and added Namespace sets",
      );
    }
    const currentBindingByNamespace = new Map(currentBindings.map((entry) =>
      [entry.namespaceId, entry] as const
    ));
    const targetBindingByNamespace = new Map(targetBindings.map((entry) =>
      [entry.namespaceId, entry] as const
    ));
    const removed = new Set(delta.removedNamespaceIds);
    for (const requirement of input.authoritySet.namespaceRequirements) {
      const binding = removed.has(requirement.namespaceId)
        ? currentBindingByNamespace.get(requirement.namespaceId)
        : targetBindingByNamespace.get(requirement.namespaceId);
      const requiredOperation = removed.has(requirement.namespaceId)
        ? "decrypt"
        : "encrypt";
      if (
        binding === undefined
        || requirement.operations.length !== 1
        || requirement.operations[0] !== requiredOperation
        || binding.domainId !== requirement.domainId
        || binding.expectedAccessRevision !== requirement.expectedAccessRevision
        || binding.expectedPolicyRevision !== requirement.expectedPolicyRevision
      ) {
        throw new TypeError(
          "Agent object access update delta authority disagrees with product binding evidence",
        );
      }
    }
    const requiredDomains = [...new Set(
      input.authoritySet.namespaceRequirements.map((entry) => entry.domainId),
    )].sort(compareUnsignedUtf8);
    if (
      requiredDomains.length !== input.authoritySet.domainRequirements.length
      || requiredDomains.some((entry, index) =>
        entry !== input.authoritySet.domainRequirements[index]!.domainId
      )
    ) {
      throw new TypeError("Agent object access update Domain set is inexact");
    }
    const agentAuthorization = authorizationRevision(
      input.agentAuthorizationRevision,
    );
    if (
      input.authoritySet.recipientAgentId !== input.runtime.agentId
      || input.signerPublication.authorizationRevision !== agentAuthorization
      || !agentRuntimeSignerPublicationMatchesRuntimeV1(
        crypto,
        input.runtime,
        input.signerPublication,
      )
    ) {
      throw new Error("Agent object Runtime signer authority disagrees");
    }
    const next = createAgentObjectAccessManifestV5(crypto, {
      objectId: current.manifest.objectId,
      payloadHash: current.manifest.payloadHash,
      accessRevision: accessRevision(current.manifest.accessRevision + 1),
      previousManifestHash: current.manifestHash,
      envelopeHashes: targetEntries.map((entry) => entry.context.envelopeHash),
      signer: {
        kind: "agent_runtime",
        agentId: input.runtime.agentId,
        runtimeGeneration: input.runtime.generation,
        signerKeyId: input.signerPublication.signerKeyId,
      },
      signerAuthorizationHash: null,
      hostAuthorizationRevision: agentAuthorization,
    }, input.runtime);
    currentContexts = cloneEnvelopeContexts(currentEntries);
    targetContexts = cloneEnvelopeContexts(targetEntries);
    const authority = cloneUpdateAuthority({
      purpose: "persist-agent-object-access-update-set",
      objectId: current.manifest.objectId,
      payloadHash: current.manifest.payloadHash,
      grantId: input.authoritySet.grantId,
      grantHash: input.authoritySet.grantHash,
      grantUseStatus: input.authoritySet.grantUseStatus,
      grantScope: input.authoritySet.grantScope,
      grantOperations: input.authoritySet.operations,
      namespaceRequirements: input.authoritySet.namespaceRequirements,
      domainRequirements: input.authoritySet.domainRequirements,
      currentNamespaceIds,
      currentNamespaceBindings: currentBindings,
      targetNamespaceBindings: targetBindings,
      removedNamespaceIds: delta.removedNamespaceIds,
      addedNamespaceIds: delta.addedNamespaceIds,
      currentEnvelopes: currentContexts,
      targetEnvelopes: targetContexts,
      envelopes: targetContexts,
      agentId: input.runtime.agentId,
      runtimeGeneration: input.runtime.generation,
      agentAuthorizationRevision: agentAuthorization,
      signerKeyId: input.signerPublication.signerKeyId,
    });
    const prepared = Object.freeze({
      manifest: next.manifest,
      manifestBytes: next.bytes,
      manifestHash: next.hash,
      envelopeBytes: Object.freeze(targetEntries.map((entry) =>
        entry.envelopeBytes
      )),
      authority,
    });
    preparedUpdateSnapshots.set(prepared, Object.freeze({
      manifestBytes: copyOwnedBytesV2(prepared.manifestBytes),
      manifestHash: copyOwnedBytesV2(prepared.manifestHash),
      envelopeBytes: Object.freeze(prepared.envelopeBytes.map(copyOwnedBytesV2)),
      authorityFingerprint: updateAuthorityFingerprint(authority),
    }));
    succeeded = true;
    return prepared;
  } finally {
    currentEntries.forEach((entry) => {
      entry.envelopeBytes.fill(0);
      entry.context.envelopeHash.fill(0);
    });
    currentBindings.forEach((entry) => entry.bindingHash.fill(0));
    targetBindings.forEach((entry) => entry.bindingHash.fill(0));
    currentContexts.forEach((entry) => entry.envelopeHash.fill(0));
    targetContexts.forEach((entry) => entry.envelopeHash.fill(0));
    if (!succeeded) {
      targetEntries.forEach((entry) => entry.envelopeBytes.fill(0));
    }
    targetEntries.forEach((entry) => entry.context.envelopeHash.fill(0));
    current.manifestBytes.fill(0);
    current.manifestHash.fill(0);
  }
}

export function prepareAgentObjectAccessManifestUpdateSetV3(
  crypto: LatticeCrypto,
  input: PrepareAgentObjectAccessManifestUpdateSetInputV3,
): PreparedAgentObjectAccessManifestUpdateSetV3 {
  return prepareAgentObjectAccessManifestUpdateSetInternalV3(
    crypto,
    input,
    false,
  );
}

/** Prepares a terminal empty-envelope Memory access revision on demand. */
export function prepareAgentMemoryDeletionV1(
  crypto: LatticeCrypto,
  input: PrepareAgentMemoryDeletionInputV1,
): PreparedAgentMemoryDeletionV1 {
  if (
    !Array.isArray(input.currentNamespaceBindings as unknown)
    || input.currentNamespaceBindings.length
      !== input.authoritySet.namespaceRequirements.length
  ) throw new TypeError(
    "Agent Memory deletion binding set must be exact",
  );
  const currentNamespaceBindings = input.currentNamespaceBindings.map(
    (binding, index) => {
      const requirement = input.authoritySet.namespaceRequirements[index]!;
      const fields = Object.keys(binding).sort(compareUnsignedUtf8);
      const expectedFields = [
        "bindingHash",
        "domainId",
        "expectedAccessRevision",
        "expectedPolicyRevision",
        "namespaceId",
      ];
      if (
        fields.length !== expectedFields.length
        || fields.some((field, fieldIndex) =>
          field !== expectedFields[fieldIndex]
        )
        || binding.namespaceId !== requirement.namespaceId
        || binding.domainId !== requirement.domainId
        || binding.expectedAccessRevision !== requirement.expectedAccessRevision
        || binding.expectedPolicyRevision !== requirement.expectedPolicyRevision
      ) throw new TypeError(
        "Agent Memory deletion binding coordinates must match exact authority",
      );
      return Object.freeze({
        ...binding,
        bindingHash: exactHash(
          "Agent Memory deletion binding hash",
          binding.bindingHash,
        ),
      });
    },
  );
  const prepared = prepareAgentObjectAccessManifestUpdateSetInternalV3(
    crypto,
    {
      ...input,
      targetEnvelopeBytes: [],
      targetNamespaceBindings: [],
    },
    true,
  );
  if (prepared.manifest.previousManifestHash === null) {
    throw new TypeError("Agent Memory deletion requires a current manifest");
  }
  const authority = Object.freeze({
    purpose: "persist-agent-memory-deletion" as const,
    objectId: prepared.manifest.objectId,
    payloadHash: copyOwnedBytesV2(prepared.manifest.payloadHash),
    currentAccessRevision: prepared.manifest.accessRevision - 1,
    currentManifestHash:
      copyOwnedBytesV2(prepared.manifest.previousManifestHash),
    grantId: prepared.authority.grantId,
    grantHash: copyOwnedBytesV2(prepared.authority.grantHash),
    grantUseStatus: prepared.authority.grantUseStatus,
    namespaceRequirements:
      cloneNamespaceRequirements(prepared.authority.namespaceRequirements),
    currentNamespaceBindings: Object.freeze(currentNamespaceBindings),
    domainRequirements:
      cloneDomainRequirements(prepared.authority.domainRequirements),
    agentId: prepared.authority.agentId,
    runtimeGeneration: prepared.authority.runtimeGeneration,
    agentAuthorizationRevision:
      prepared.authority.agentAuthorizationRevision,
    signerKeyId: prepared.authority.signerKeyId,
  });
  const deletion = Object.freeze({
    manifest: prepared.manifest,
    manifestBytes: prepared.manifestBytes,
    manifestHash: prepared.manifestHash,
    authority,
  });
  preparedDeletionSnapshots.set(deletion, Object.freeze({
    manifestBytes: copyOwnedBytesV2(deletion.manifestBytes),
    manifestHash: copyOwnedBytesV2(deletion.manifestHash),
    authorityFingerprint: deletionAuthorityFingerprint(deletion.authority),
  }));
  return deletion;
}

export function assertAuthenticPreparedAgentMemoryDeletionV1(
  prepared: PreparedAgentMemoryDeletionV1,
): void {
  const snapshot = preparedDeletionSnapshots.get(prepared as object);
  if (
    snapshot === undefined
    || prepared.manifest.envelopeHashes.length !== 0
    || !equalBytes(snapshot.manifestBytes, prepared.manifestBytes)
    || !equalBytes(snapshot.manifestHash, prepared.manifestHash)
    || snapshot.authorityFingerprint
      !== deletionAuthorityFingerprint(prepared.authority)
  ) {
    throw new TypeError(
      "Agent Memory deletion requires an authentic prepared empty-envelope manifest",
    );
  }
}

export function assertAuthenticPreparedAgentObjectAccessManifestUpdateSetV3(
  prepared: PreparedAgentObjectAccessManifestUpdateSetV3,
): void {
  const snapshot = preparedUpdateSnapshots.get(prepared as object);
  if (
    snapshot === undefined
    || !equalBytes(snapshot.manifestBytes, prepared.manifestBytes)
    || !equalBytes(snapshot.manifestHash, prepared.manifestHash)
    || snapshot.envelopeBytes.length !== prepared.envelopeBytes.length
    || snapshot.envelopeBytes.some((bytes, index) =>
      !equalBytes(bytes, prepared.envelopeBytes[index]!)
    )
    || snapshot.authorityFingerprint
      !== updateAuthorityFingerprint(prepared.authority)
  ) {
    throw new TypeError(
      "Agent object access persistence requires an authentic prepared exact-set update",
    );
  }
}

export function assertAuthenticPreparedAgentObjectAccessManifestGenesisSetV3(
  prepared: PreparedAgentObjectAccessManifestGenesisSetV3,
): void {
  const snapshot = preparedSnapshots.get(prepared as object);
  if (
    snapshot === undefined
    || !equalBytes(snapshot.manifestBytes, prepared.manifestBytes)
    || !equalBytes(snapshot.manifestHash, prepared.manifestHash)
    || snapshot.envelopeBytes.length !== prepared.envelopeBytes.length
    || snapshot.envelopeBytes.some((bytes, index) =>
      !equalBytes(bytes, prepared.envelopeBytes[index]!)
    )
    || snapshot.authorityFingerprint
      !== authorityFingerprint(prepared.authority)
  ) {
    throw new TypeError(
      "Agent object access persistence requires an authentic prepared exact-set genesis",
    );
  }
}
