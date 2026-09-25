import { bytesToHex } from "@noble/hashes/utils.js";

import {
  agentRuntimeSignerPublicationMatchesRuntimeV1,
  verifyHistoricalAgentRuntimeSignerPublicationV1,
  type AgentRuntimeSignerPublicationV1,
  type ResolveHistoricalAgentRuntimeSignerPublicationManagerV1,
} from "../agent-runtime/signer-publication-v1.ts";
import type { AgentRuntimeGenerationV2 } from "../agent-runtime/types.ts";
import {
  assertAuthenticTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionDomainAuthorityV1,
  type TaskRuntimeExecutionEvidenceV1,
} from "../background/task-runtime-execution-evidence-v1.ts";
import type { LatticeCrypto } from "../crypto/index.ts";
import {
  createAgentObjectAccessManifestV5,
  type ObjectAccessManifestV5,
} from "../format/object-access-manifest-v5.ts";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../format/object-v2.ts";
import {
  assertVerifiedNamespaceBindingHead,
  namespaceKeyringEnvelopeHash,
} from "../namespace/bindings.ts";
import type { HistoricalCommitterResolverV2 } from
  "../namespace/authorization.ts";
import { openNamespaceKeyring } from "../namespace/keyrings.ts";
import type {
  NamespaceKeyringEnvelopeV2,
  VerifiedNamespaceBindingHeadV2,
} from "../namespace/types.ts";
import {
  accessRevision,
  authorizationRevision,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../v2-types/ids.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  encryptedObjectWriteRecordV2,
} from "../storage/v2-record-policy.ts";
import type { OpaqueEncryptedObjectRecordV2 } from
  "../storage/v2-records.ts";
import { encryptObjectPayloadV2 } from "./payload.ts";
import { wrapObjectDekForNamespaceV2 } from "./namespace-envelope.ts";

const HASH_BYTES = 32;

export type TaskRuntimeResultNamespaceSourceV1 = Readonly<{
  trustedHead: VerifiedNamespaceBindingHeadV2;
  aiKeyringEnvelope: NamespaceKeyringEnvelopeV2;
  currentDomainRoot: Uint8Array;
  resolveHistoricalCommitter: HistoricalCommitterResolverV2;
}>;

export type PrepareTaskRuntimeResultObjectV1Input = Readonly<{
  evidence: TaskRuntimeExecutionEvidenceV1;
  plaintext: Uint8Array;
  objectType: string;
  createdAt: number;
  namespace: TaskRuntimeResultNamespaceSourceV1;
  agentAuthorizationRevision: number;
  runtime: AgentRuntimeGenerationV2;
  signerPublication: AgentRuntimeSignerPublicationV1;
  resolveHistoricalSignerPublicationManager:
    ResolveHistoricalAgentRuntimeSignerPublicationManagerV1;
}>;

export type TaskRuntimeResultObjectAuthorityV1 = Readonly<{
  purpose: "persist-task-runtime-result-genesis";
  requestId: string;
  workId: string;
  claimId: string;
  authorizationDigest: Uint8Array;
  objectId: string;
  payloadHash: Uint8Array;
  taskId: string;
  taskRunId: string;
  namespace: Readonly<{
    namespaceId: string;
    domainId: string;
    expectedAccessRevision: number;
    expectedPolicyRevision: number;
    bindingHash: Uint8Array;
    keyGeneration: number;
    envelopeHash: Uint8Array;
  }>;
  domain: TaskRuntimeExecutionDomainAuthorityV1;
  agentId: string;
  runtimeGeneration: number;
  agentAuthorizationRevision: number;
  signerKeyId: string;
}>;

export type PreparedTaskRuntimeResultObjectV1 = Readonly<{
  object: OpaqueEncryptedObjectRecordV2;
  access: Readonly<{
    manifest: ObjectAccessManifestV5;
    manifestBytes: Uint8Array;
    manifestHash: Uint8Array;
    envelopeBytes: readonly [Uint8Array];
    authority: TaskRuntimeResultObjectAuthorityV1;
  }>;
}>;

type PreparedSnapshot = Readonly<{
  payloadBytes: Uint8Array;
  manifestBytes: Uint8Array;
  manifestHash: Uint8Array;
  envelopeBytes: Uint8Array;
  authorityFingerprint: string;
}>;

const preparedSnapshots = new WeakMap<object, PreparedSnapshot>();

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function exactHash(label: string, value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== HASH_BYTES) {
    throw new TypeError(`${label} must be exactly ${HASH_BYTES} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function cloneDomain(
  value: TaskRuntimeExecutionDomainAuthorityV1,
): TaskRuntimeExecutionDomainAuthorityV1 {
  return Object.freeze({
    ...value,
    participantDigest: exactHash(
      "Task result Domain participant digest",
      value.participantDigest,
    ),
    headDigest: exactHash("Task result Domain head digest", value.headDigest),
    activeNamespaceBindingSetDigest: exactHash(
      "Task result Domain binding-set digest",
      value.activeNamespaceBindingSetDigest,
    ),
  });
}

function cloneAuthority(
  value: TaskRuntimeResultObjectAuthorityV1,
): TaskRuntimeResultObjectAuthorityV1 {
  return Object.freeze({
    ...value,
    authorizationDigest: exactHash(
      "Task result authorization digest",
      value.authorizationDigest,
    ),
    payloadHash: exactHash("Task result payload hash", value.payloadHash),
    namespace: Object.freeze({
      ...value.namespace,
      bindingHash: exactHash(
        "Task result Namespace binding hash",
        value.namespace.bindingHash,
      ),
      envelopeHash: exactHash(
        "Task result Namespace envelope hash",
        value.namespace.envelopeHash,
      ),
    }),
    domain: cloneDomain(value.domain),
  });
}

function authorityFingerprint(value: TaskRuntimeResultObjectAuthorityV1): string {
  return JSON.stringify({
    ...value,
    authorizationDigest: bytesToHex(value.authorizationDigest),
    payloadHash: bytesToHex(value.payloadHash),
    namespace: {
      ...value.namespace,
      bindingHash: bytesToHex(value.namespace.bindingHash),
      envelopeHash: bytesToHex(value.namespace.envelopeHash),
    },
    domain: {
      ...value.domain,
      participantDigest: bytesToHex(value.domain.participantDigest),
      headDigest: bytesToHex(value.domain.headDigest),
      activeNamespaceBindingSetDigest:
        bytesToHex(value.domain.activeNamespaceBindingSetDigest),
    },
  });
}

function matchingDomain(
  evidence: TaskRuntimeExecutionEvidenceV1,
): TaskRuntimeExecutionDomainAuthorityV1 {
  const matches = evidence.domainRequirements.filter((entry) =>
    entry.domainId === evidence.result.namespace.domainId
  );
  if (matches.length !== 1) {
    throw new TypeError("Task result Domain authority is not exact");
  }
  return matches[0]!;
}

/**
 * Prepares one Task result only while its opened HIVE Task authorization is
 * live. The persona Agent signs the V5 manifest but is never treated as the
 * grant recipient.
 */
export function prepareTaskRuntimeResultObjectV1(
  crypto: LatticeCrypto,
  input: PrepareTaskRuntimeResultObjectV1Input,
): PreparedTaskRuntimeResultObjectV1 {
  assertAuthenticTaskRuntimeExecutionEvidenceV1(input.evidence);
  if (!(input.plaintext instanceof Uint8Array)) {
    throw new TypeError("Task result plaintext must be Uint8Array");
  }
  assertVerifiedNamespaceBindingHead(input.namespace.trustedHead);
  const evidence = input.evidence;
  const resultNamespace = evidence.result.namespace;
  const head = input.namespace.trustedHead;
  const binding = head.binding;
  const domain = matchingDomain(evidence);
  const targetObjectId = objectId(evidence.result.objectId);
  const targetNamespaceId = namespaceId(resultNamespace.namespaceId);
  const targetAccessRevision = accessRevision(
    resultNamespace.expectedAccessRevision,
  );
  const createdAt = unixTimestamp(input.createdAt);
  const envelopeHash = namespaceKeyringEnvelopeHash(
    input.namespace.aiKeyringEnvelope,
  );
  if (
    evidence.result.taskRunId !== evidence.workId
    || evidence.result.objectId.length < 1
    || evidence.policyRevision !== resultNamespace.expectedPolicyRevision
    || head.namespaceId !== resultNamespace.namespaceId
    || head.accessRevision !== resultNamespace.expectedAccessRevision
    || binding.namespaceId !== resultNamespace.namespaceId
    || binding.domainId !== resultNamespace.domainId
    || binding.domainEpoch !== domain.domainKeyGeneration
    || binding.accessRevision !== resultNamespace.expectedAccessRevision
    || input.namespace.aiKeyringEnvelope.keyClass !== "ai"
    || input.namespace.aiKeyringEnvelope.namespaceId !== binding.namespaceId
    || input.namespace.aiKeyringEnvelope.domainId !== binding.domainId
    || input.namespace.aiKeyringEnvelope.domainEpoch !== binding.domainEpoch
    || input.namespace.aiKeyringEnvelope.accessRevision !== binding.accessRevision
    || input.namespace.aiKeyringEnvelope.currentGeneration
      !== binding.aiCurrentGeneration
    || !sameBytes(envelopeHash, binding.aiKeyringEnvelopeHash)
    || input.runtime.agentId !== evidence.result.signerAgentId
    || input.signerPublication.agentId !== evidence.result.signerAgentId
    || input.signerPublication.authorizationRevision
      !== authorizationRevision(input.agentAuthorizationRevision)
    || !agentRuntimeSignerPublicationMatchesRuntimeV1(
      crypto,
      input.runtime,
      input.signerPublication,
    )
    || !verifyHistoricalAgentRuntimeSignerPublicationV1({
      crypto,
      publication: input.signerPublication,
      resolveHistoricalManagerAuthority:
        input.resolveHistoricalSignerPublicationManager,
    })
  ) {
    envelopeHash.fill(0);
    throw new TypeError("Task result preparation authority was substituted");
  }

  let keyring: ReturnType<typeof openNamespaceKeyring>;
  try {
    keyring = openNamespaceKeyring({
      crypto,
      domainRoot: input.namespace.currentDomainRoot,
      envelope: input.namespace.aiKeyringEnvelope,
      resolveHistoricalCommitter: input.namespace.resolveHistoricalCommitter,
    });
  } catch (error) {
    envelopeHash.fill(0);
    throw error;
  }
  const plaintext = Uint8Array.from(input.plaintext);
  let payloadBytes: Uint8Array | undefined;
  let namespaceEnvelopeBytes: Uint8Array | undefined;
  let payloadHash: Uint8Array | undefined;
  let namespaceEnvelopeHash: Uint8Array | undefined;
  try {
    const current = keyring.generations.find((entry) =>
      entry.generation === keyring.currentGeneration
    );
    if (
      keyring.namespaceId !== resultNamespace.namespaceId
      || keyring.keyClass !== "ai"
      || keyring.accessRevision !== resultNamespace.expectedAccessRevision
      || keyring.currentGeneration !== binding.aiCurrentGeneration
      || current === undefined
    ) throw new TypeError("Task result current Namespace key is unavailable");

    const encrypted = encryptObjectPayloadV2(crypto, {
      objectId: targetObjectId,
      keyClass: "ai",
      objectType: input.objectType,
      createdAt,
    }, plaintext);
    try {
      payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
      const namespaceEnvelope = wrapObjectDekForNamespaceV2(
        crypto,
        current.key,
        {
          objectId: targetObjectId,
          namespaceId: targetNamespaceId,
          keyClass: "ai",
          keyGeneration: current.generation,
          bindingRevisionAtWrap: targetAccessRevision,
        },
        encrypted.dek,
      );
      try {
        namespaceEnvelopeBytes = encodeNamespaceObjectEnvelopeV2(
          namespaceEnvelope,
        );
      } finally {
        namespaceEnvelope.wrappedDek.fill(0);
      }
    } finally {
      encrypted.dek.fill(0);
      encrypted.payload.ciphertext.fill(0);
    }
    payloadHash = crypto.hash(payloadBytes);
    namespaceEnvelopeHash = crypto.hash(namespaceEnvelopeBytes);
    const genesis = createAgentObjectAccessManifestV5(crypto, {
      objectId: targetObjectId,
      payloadHash,
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [namespaceEnvelopeHash],
      signer: {
        kind: "agent_runtime",
        agentId: input.runtime.agentId,
        runtimeGeneration: input.runtime.generation,
        signerKeyId: input.signerPublication.signerKeyId,
      },
      signerAuthorizationHash: null,
      hostAuthorizationRevision: authorizationRevision(
        input.agentAuthorizationRevision,
      ),
    }, input.runtime);
    assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence);
    const authority = cloneAuthority({
      purpose: "persist-task-runtime-result-genesis",
      requestId: evidence.requestId,
      workId: evidence.workId,
      claimId: evidence.claimId,
      authorizationDigest: evidence.authorizationDigest,
      objectId: evidence.result.objectId,
      payloadHash,
      taskId: evidence.result.taskId,
      taskRunId: evidence.result.taskRunId,
      namespace: {
        namespaceId: resultNamespace.namespaceId,
        domainId: resultNamespace.domainId,
        expectedAccessRevision: resultNamespace.expectedAccessRevision,
        expectedPolicyRevision: resultNamespace.expectedPolicyRevision,
        bindingHash: head.bindingHash,
        keyGeneration: current.generation,
        envelopeHash: namespaceEnvelopeHash,
      },
      domain,
      agentId: input.runtime.agentId,
      runtimeGeneration: input.runtime.generation,
      agentAuthorizationRevision: input.agentAuthorizationRevision,
      signerKeyId: input.signerPublication.signerKeyId,
    });
    const prepared = Object.freeze({
      object: encryptedObjectWriteRecordV2(payloadBytes),
      access: Object.freeze({
        manifest: genesis.manifest,
        manifestBytes: genesis.bytes,
        manifestHash: genesis.hash,
        envelopeBytes: Object.freeze([
          copyOwnedBytesV2(namespaceEnvelopeBytes),
        ] as const),
        authority,
      }),
    });
    preparedSnapshots.set(prepared, Object.freeze({
      payloadBytes: copyOwnedBytesV2(prepared.object.payloadBytes.ciphertext),
      manifestBytes: copyOwnedBytesV2(prepared.access.manifestBytes),
      manifestHash: copyOwnedBytesV2(prepared.access.manifestHash),
      envelopeBytes: copyOwnedBytesV2(prepared.access.envelopeBytes[0]),
      authorityFingerprint: authorityFingerprint(authority),
    }));
    return prepared;
  } finally {
    plaintext.fill(0);
    envelopeHash.fill(0);
    payloadHash?.fill(0);
    namespaceEnvelopeHash?.fill(0);
    payloadBytes?.fill(0);
    namespaceEnvelopeBytes?.fill(0);
    for (const generation of keyring.generations) generation.key.fill(0);
  }
}

export function assertAuthenticPreparedTaskRuntimeResultObjectV1(
  prepared: PreparedTaskRuntimeResultObjectV1,
): void {
  const snapshot = preparedSnapshots.get(prepared as object);
  if (
    snapshot === undefined
    || !sameBytes(snapshot.payloadBytes, prepared.object.payloadBytes.ciphertext)
    || !sameBytes(snapshot.manifestBytes, prepared.access.manifestBytes)
    || !sameBytes(snapshot.manifestHash, prepared.access.manifestHash)
    || !sameBytes(snapshot.envelopeBytes, prepared.access.envelopeBytes[0])
    || snapshot.authorityFingerprint
      !== authorityFingerprint(prepared.access.authority)
  ) throw new TypeError(
    "Task result publication requires an authentic prepared object",
  );
}
