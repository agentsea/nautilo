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
  decodeNamespaceObjectEnvelopeV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../format/object-v2.ts";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  assertPortableId,
  assertU64Counter,
  authorizationRevision,
  cryptoDomainId,
  namespaceGeneration,
  namespaceId,
  objectId,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import type {
  DeviceWrappedAgentEnvelopeAuthorityV1,
  DeviceWrappedAgentNamespaceAuthorityV1,
} from "./device-wrapped-agent-access-manifest-set-v1.ts";

const HASH_BYTES = 32;

export type TaskRuntimeAgentNamespaceAuthorityV1 =
  & DeviceWrappedAgentNamespaceAuthorityV1
  & Readonly<{
    readonly operations: readonly ("decrypt" | "encrypt")[];
    readonly expectedPolicyRevision: number;
  }>;

export interface TaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1 {
  readonly purpose: "persist-task-runtime-agent-object-access-genesis-set";
  readonly objectId: string;
  readonly payloadHash: Uint8Array;
  readonly envelopes: readonly DeviceWrappedAgentEnvelopeAuthorityV1[];
  readonly operationId: string;
  readonly requestId: string;
  readonly workId: string;
  readonly claimId: string;
  readonly authorizationDigest: Uint8Array;
  readonly claimExpiresAt: number;
  readonly recipientExpiresAt: number;
  readonly expiresAt: number;
  readonly recipientGeneration: number;
  readonly recipientKeyId: string;
  readonly policyRevision: number;
  readonly episodeId: string;
  readonly sourceRoomId: string;
  readonly hostAuthorizationRevision: number;
  readonly recipientAuthorizationRevision: number;
  readonly taskId: string;
  readonly taskRunId: string;
  readonly namespaces: readonly TaskRuntimeAgentNamespaceAuthorityV1[];
  readonly domains: readonly TaskRuntimeExecutionDomainAuthorityV1[];
  readonly agentAuthorizationRevision: number;
  readonly agentId: string;
  readonly runtimeGeneration: number;
  readonly signerKeyId: string;
}

export interface PrepareTaskRuntimeAgentObjectAccessManifestGenesisSetInputV1 {
  readonly evidence: TaskRuntimeExecutionEvidenceV1;
  readonly objectId: string;
  readonly payloadHash: Uint8Array;
  readonly envelopeBytes: readonly Uint8Array[];
  readonly operationId: string;
  readonly namespaces: readonly DeviceWrappedAgentNamespaceAuthorityV1[];
  readonly agentAuthorizationRevision: number;
  readonly runtime: AgentRuntimeGenerationV2;
  readonly signerPublication: AgentRuntimeSignerPublicationV1;
  readonly resolveHistoricalSignerPublicationManager:
    ResolveHistoricalAgentRuntimeSignerPublicationManagerV1;
}

export interface PreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1 {
  readonly manifest: ObjectAccessManifestV5;
  readonly manifestBytes: Uint8Array;
  readonly manifestHash: Uint8Array;
  readonly envelopeBytes: readonly Uint8Array[];
  readonly authority:
    TaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1;
}

type PreparedSnapshot = Readonly<{
  evidence: TaskRuntimeExecutionEvidenceV1;
  manifestBytes: Uint8Array;
  manifestHash: Uint8Array;
  envelopeBytes: readonly Uint8Array[];
  authorityFingerprint: string;
}>;

const preparedSnapshots = new WeakMap<object, PreparedSnapshot>();

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
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
  cryptoDomainId(value.domainId);
  namespaceId(value.sourceNamespaceId);
  assertU64Counter("Task Runtime Domain participant count", value.participantCount);
  assertU64Counter("Task Runtime Domain key generation", value.domainKeyGeneration);
  authorizationRevision(value.authorizationRevision);
  assertU64Counter(
    "Task Runtime active Namespace binding count",
    value.activeNamespaceBindingCount,
  );
  if (value.keyClass !== "ai") {
    throw new TypeError("Task Runtime Agent Domain key class must be ai");
  }
  return Object.freeze({
    ...value,
    participantDigest: exactHash(
      "Task Runtime Domain participant digest",
      value.participantDigest,
    ),
    headDigest: exactHash("Task Runtime Domain head digest", value.headDigest),
    activeNamespaceBindingSetDigest: exactHash(
      "Task Runtime Domain binding-set digest",
      value.activeNamespaceBindingSetDigest,
    ),
  });
}

function cloneNativeNamespace(
  value: DeviceWrappedAgentNamespaceAuthorityV1,
): DeviceWrappedAgentNamespaceAuthorityV1 {
  namespaceId(value.namespaceId);
  accessRevision(value.accessRevision);
  namespaceGeneration(value.keyGeneration);
  cryptoDomainId(value.domainId);
  assertU64Counter(
    "Task Runtime Agent Domain key generation",
    value.domainKeyGeneration,
  );
  authorizationRevision(value.domainAuthorizationRevision);
  return Object.freeze({
    ...value,
    domainHeadDigest: exactHash(
      "Task Runtime Agent Domain head digest",
      value.domainHeadDigest,
    ),
    headDigest: exactHash(
      "Task Runtime Agent Namespace head digest",
      value.headDigest,
    ),
    publicationDigest: exactHash(
      "Task Runtime Agent Namespace publication digest",
      value.publicationDigest,
    ),
    publicationSetDigest: exactHash(
      "Task Runtime Agent Namespace publication-set digest",
      value.publicationSetDigest,
    ),
    audienceFingerprint: exactHash(
      "Task Runtime Agent Namespace audience fingerprint",
      value.audienceFingerprint,
    ),
  });
}

function cloneNamespace(
  value: TaskRuntimeAgentNamespaceAuthorityV1,
): TaskRuntimeAgentNamespaceAuthorityV1 {
  const native = cloneNativeNamespace(value);
  authorizationRevision(value.expectedPolicyRevision);
  if (
    value.operations.length < 1
    || value.operations.length > 2
    || value.operations.some((operation, index) =>
      (operation !== "decrypt" && operation !== "encrypt")
      || (index > 0 && value.operations[index - 1]! >= operation)
    )
  ) throw new TypeError("Task Runtime Agent Namespace operations are invalid");
  return Object.freeze({
    ...native,
    operations: Object.freeze([...value.operations]),
    expectedPolicyRevision: value.expectedPolicyRevision,
  });
}

function cloneEnvelope(
  value: DeviceWrappedAgentEnvelopeAuthorityV1,
): DeviceWrappedAgentEnvelopeAuthorityV1 {
  objectId(value.objectId);
  namespaceId(value.namespaceId);
  namespaceGeneration(value.keyGeneration);
  accessRevision(value.bindingRevisionAtWrap);
  if (value.keyClass !== "ai") {
    throw new TypeError("Task Runtime Agent envelope key class must be ai");
  }
  return Object.freeze({
    ...value,
    envelopeHash: exactHash(
      "Task Runtime Agent Namespace envelope hash",
      value.envelopeHash,
    ),
  });
}

export function cloneTaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1(
  value: TaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1,
): TaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1 {
  if (value.purpose !== "persist-task-runtime-agent-object-access-genesis-set") {
    throw new TypeError("Task Runtime Agent object purpose is invalid");
  }
  objectId(value.objectId);
  assertPortableId("Task Runtime Agent operation ID", value.operationId);
  assertPortableId("Task Runtime request ID", value.requestId);
  assertPortableId("Task Runtime work ID", value.workId);
  assertPortableId("Task Runtime claim ID", value.claimId);
  assertPortableId("Task Runtime recipient key ID", value.recipientKeyId);
  assertPortableId("Task Runtime episode ID", value.episodeId);
  assertPortableId("Task Runtime source Room ID", value.sourceRoomId);
  assertPortableId("Task Runtime Task ID", value.taskId);
  assertPortableId("Task Runtime Task Run ID", value.taskRunId);
  [
    value.claimExpiresAt,
    value.recipientExpiresAt,
    value.expiresAt,
    value.recipientGeneration,
    value.policyRevision,
    value.hostAuthorizationRevision,
    value.recipientAuthorizationRevision,
  ].forEach((counter) => assertU64Counter("Task Runtime Agent counter", counter));
  authorizationRevision(value.agentAuthorizationRevision);
  agentId(value.agentId);
  agentRuntimeGeneration(value.runtimeGeneration);
  assertPortableId("Task Runtime Agent signer key ID", value.signerKeyId);
  return Object.freeze({
    ...value,
    payloadHash: exactHash("Task Runtime Agent payload hash", value.payloadHash),
    authorizationDigest: exactHash(
      "Task Runtime authorization digest",
      value.authorizationDigest,
    ),
    envelopes: Object.freeze(value.envelopes.map(cloneEnvelope)),
    namespaces: Object.freeze(value.namespaces.map(cloneNamespace)),
    domains: Object.freeze(value.domains.map(cloneDomain)),
  });
}

function authorityFingerprint(
  value: TaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1,
): string {
  return JSON.stringify({
    ...value,
    payloadHash: bytesToHex(value.payloadHash),
    authorizationDigest: bytesToHex(value.authorizationDigest),
    envelopes: value.envelopes.map((entry) => ({
      ...entry,
      envelopeHash: bytesToHex(entry.envelopeHash),
    })),
    namespaces: value.namespaces.map((entry) => ({
      ...entry,
      domainHeadDigest: bytesToHex(entry.domainHeadDigest),
      headDigest: bytesToHex(entry.headDigest),
      publicationDigest: bytesToHex(entry.publicationDigest),
      publicationSetDigest: bytesToHex(entry.publicationSetDigest),
      audienceFingerprint: bytesToHex(entry.audienceFingerprint),
    })),
    domains: value.domains.map((entry) => ({
      ...entry,
      participantDigest: bytesToHex(entry.participantDigest),
      headDigest: bytesToHex(entry.headDigest),
      activeNamespaceBindingSetDigest:
        bytesToHex(entry.activeNamespaceBindingSetDigest),
    })),
  });
}

function namespaceFingerprint(
  value: TaskRuntimeAgentNamespaceAuthorityV1,
): string {
  return JSON.stringify({
    ...value,
    domainHeadDigest: bytesToHex(value.domainHeadDigest),
    headDigest: bytesToHex(value.headDigest),
    publicationDigest: bytesToHex(value.publicationDigest),
    publicationSetDigest: bytesToHex(value.publicationSetDigest),
    audienceFingerprint: bytesToHex(value.audienceFingerprint),
  });
}

function domainFingerprint(
  value: TaskRuntimeExecutionDomainAuthorityV1,
): string {
  return JSON.stringify({
    ...value,
    participantDigest: bytesToHex(value.participantDigest),
    headDigest: bytesToHex(value.headDigest),
    activeNamespaceBindingSetDigest:
      bytesToHex(value.activeNamespaceBindingSetDigest),
  });
}

function exactSelectedAuthority(
  evidence: TaskRuntimeExecutionEvidenceV1,
  nativeNamespaces: readonly DeviceWrappedAgentNamespaceAuthorityV1[],
): Readonly<{
  namespaces: readonly TaskRuntimeAgentNamespaceAuthorityV1[];
  domains: readonly TaskRuntimeExecutionDomainAuthorityV1[];
}> {
  const namespaces = nativeNamespaces.map((entry, index) => {
    if (index > 0 && nativeNamespaces[index - 1]!.namespaceId >= entry.namespaceId) {
      throw new TypeError("Task Runtime Agent Namespace set is not canonical");
    }
    const requirements = evidence.namespaceRequirements.filter((requirement) =>
      requirement.namespaceId === entry.namespaceId
    );
    const requirement = requirements[0];
    const domains = evidence.domainRequirements.filter((domain) =>
      domain.domainId === entry.domainId
    );
    const domain = domains[0];
    if (
      requirements.length !== 1
      || requirement === undefined
      || domains.length !== 1
      || domain === undefined
      || !requirement.operations.includes("encrypt")
      || requirement.domainId !== entry.domainId
      || requirement.expectedAccessRevision !== entry.accessRevision
      || requirement.expectedPolicyRevision !== evidence.policyRevision
      || entry.domainKeyGeneration !== domain.domainKeyGeneration
      || entry.domainAuthorizationRevision !== domain.authorizationRevision
      || !equalBytes(entry.domainHeadDigest, domain.headDigest)
    ) {
      throw new TypeError("Task Runtime Agent Namespace authority was substituted");
    }
    return cloneNamespace({
      ...entry,
      operations: requirement.operations,
      expectedPolicyRevision: requirement.expectedPolicyRevision,
    });
  });
  const selectedDomainIds = [...new Set(namespaces.map((entry) => entry.domainId))]
    .sort();
  const domains = selectedDomainIds.map((domainId) => {
    const matches = evidence.domainRequirements.filter((entry) =>
      entry.domainId === domainId
    );
    if (matches.length !== 1) {
      throw new TypeError("Task Runtime Agent Domain authority is not exact");
    }
    return cloneDomain(matches[0]!);
  });
  return Object.freeze({
    namespaces: Object.freeze(namespaces),
    domains: Object.freeze(domains),
  });
}

/** Prepare one Runtime-signed native V5 object under active Task authority. */
export function prepareTaskRuntimeAgentObjectAccessManifestGenesisSetV1(
  crypto: LatticeCrypto,
  input: PrepareTaskRuntimeAgentObjectAccessManifestGenesisSetInputV1,
): PreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1 {
  assertAuthenticTaskRuntimeExecutionEvidenceV1(input.evidence);
  if (
    input.namespaces.length < 1
    || input.namespaces.length > V2_LIMITS.namespaceEnvelopesPerManifest
    || input.envelopeBytes.length !== input.namespaces.length
  ) throw new TypeError("Task Runtime Agent Namespace set is invalid");
  const selected = exactSelectedAuthority(input.evidence, input.namespaces);
  const targetObjectId = objectId(input.objectId);
  assertPortableId("Task Runtime Agent operation ID", input.operationId);
  const namespaceById = new Map(
    selected.namespaces.map((entry) => [entry.namespaceId, entry] as const),
  );
  const envelopeEntries = input.envelopeBytes.map((source) => {
    if (!(source instanceof Uint8Array)) {
      throw new TypeError("Task Runtime Agent Namespace envelope must be bytes");
    }
    const bytes = copyOwnedBytesV2(source);
    try {
      const decoded = decodeNamespaceObjectEnvelopeV2(bytes);
      const namespace = namespaceById.get(decoded.context.namespaceId);
      if (
        !equalBytes(encodeNamespaceObjectEnvelopeV2(decoded), bytes)
        || decoded.context.objectId !== targetObjectId
        || decoded.context.keyClass !== "ai"
        || namespace === undefined
        || decoded.context.keyGeneration !== namespace.keyGeneration
        || decoded.context.bindingRevisionAtWrap !== namespace.accessRevision
      ) throw new TypeError("Task Runtime Agent Namespace envelope is invalid");
      return Object.freeze({
        bytes,
        context: cloneEnvelope({
          objectId: targetObjectId,
          namespaceId: decoded.context.namespaceId,
          keyClass: "ai",
          keyGeneration: decoded.context.keyGeneration,
          bindingRevisionAtWrap: decoded.context.bindingRevisionAtWrap,
          envelopeHash: crypto.hash(bytes),
        }),
      });
    } catch (cause) {
      bytes.fill(0);
      throw cause;
    }
  });
  try {
    envelopeEntries.sort((left, right) =>
      left.context.namespaceId < right.context.namespaceId ? -1
        : left.context.namespaceId > right.context.namespaceId ? 1
        : 0
    );
    if (envelopeEntries.some((entry, index) =>
      entry.context.namespaceId !== selected.namespaces[index]!.namespaceId
    )) throw new TypeError("Task Runtime Agent Namespace envelope set is incomplete");
    const evidence = input.evidence;
    const agentAuthorization = authorizationRevision(
      input.agentAuthorizationRevision,
    );
    if (
      evidence.result.taskRunId !== evidence.workId
      || input.runtime.agentId !== evidence.result.signerAgentId
      || input.signerPublication.agentId !== evidence.result.signerAgentId
      || input.signerPublication.authorizationRevision !== agentAuthorization
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
    ) throw new TypeError("Task Runtime Agent signer authority was substituted");
    const payloadHash = exactHash(
      "Task Runtime Agent payload hash",
      input.payloadHash,
    );
    const created = createAgentObjectAccessManifestV5(crypto, {
      objectId: targetObjectId,
      payloadHash,
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: envelopeEntries.map((entry) => entry.context.envelopeHash),
      signer: {
        kind: "agent_runtime",
        agentId: input.runtime.agentId,
        runtimeGeneration: input.runtime.generation,
        signerKeyId: input.signerPublication.signerKeyId,
      },
      signerAuthorizationHash: null,
      hostAuthorizationRevision: agentAuthorization,
    }, input.runtime);
    assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence);
    const authority =
      cloneTaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1({
        purpose: "persist-task-runtime-agent-object-access-genesis-set",
        objectId: targetObjectId,
        payloadHash,
        envelopes: envelopeEntries.map((entry) => entry.context),
        operationId: input.operationId,
        requestId: evidence.requestId,
        workId: evidence.workId,
        claimId: evidence.claimId,
        authorizationDigest: evidence.authorizationDigest,
        claimExpiresAt: evidence.claimExpiresAt,
        recipientExpiresAt: evidence.recipientExpiresAt,
        expiresAt: evidence.expiresAt,
        recipientGeneration: evidence.recipientGeneration,
        recipientKeyId: evidence.recipientKeyId,
        policyRevision: evidence.policyRevision,
        episodeId: evidence.episodeId,
        sourceRoomId: evidence.sourceRoomId,
        hostAuthorizationRevision: evidence.hostAuthorizationRevision,
        recipientAuthorizationRevision:
          evidence.recipientAuthorizationRevision,
        taskId: evidence.result.taskId,
        taskRunId: evidence.result.taskRunId,
        namespaces: selected.namespaces,
        domains: selected.domains,
        agentAuthorizationRevision: agentAuthorization,
        agentId: input.runtime.agentId,
        runtimeGeneration: input.runtime.generation,
        signerKeyId: input.signerPublication.signerKeyId,
      });
    const prepared = Object.freeze({
      manifest: created.manifest,
      manifestBytes: created.bytes,
      manifestHash: created.hash,
      envelopeBytes: Object.freeze(envelopeEntries.map((entry) => entry.bytes)),
      authority,
    });
    preparedSnapshots.set(prepared, Object.freeze({
      evidence,
      manifestBytes: copyOwnedBytesV2(prepared.manifestBytes),
      manifestHash: copyOwnedBytesV2(prepared.manifestHash),
      envelopeBytes: Object.freeze(
        prepared.envelopeBytes.map(copyOwnedBytesV2),
      ),
      authorityFingerprint: authorityFingerprint(authority),
    }));
    return prepared;
  } catch (cause) {
    envelopeEntries.forEach((entry) => entry.bytes.fill(0));
    throw cause;
  }
}

export function assertPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetUsesEvidenceV1(
  prepared: PreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1,
  evidence: TaskRuntimeExecutionEvidenceV1,
): void {
  assertAuthenticPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1(
    prepared,
  );
  if (preparedSnapshots.get(prepared as object)?.evidence !== evidence) {
    throw new TypeError(
      "Task Runtime Agent set persistence requires its exact execution evidence",
    );
  }
  assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence);
}

export function assertAuthenticPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1(
  prepared: PreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1,
): void {
  const snapshot = preparedSnapshots.get(prepared as object);
  if (
    snapshot === undefined
    || !equalBytes(snapshot.manifestBytes, prepared.manifestBytes)
    || !equalBytes(snapshot.manifestHash, prepared.manifestHash)
    || snapshot.envelopeBytes.length !== prepared.envelopeBytes.length
    || snapshot.envelopeBytes.some((entry, index) =>
      !equalBytes(entry, prepared.envelopeBytes[index]!)
    )
    || snapshot.authorityFingerprint !== authorityFingerprint(prepared.authority)
  ) throw new TypeError(
    "Task Runtime Agent set persistence requires authentic preparation",
  );
}

export function taskRuntimeAgentObjectAccessGenesisSetAuthorityMatchesEvidenceV1(
  context: TaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1,
  evidence: TaskRuntimeExecutionEvidenceV1,
): boolean {
  assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence);
  const selected = exactSelectedAuthority(evidence, context.namespaces);
  const cloned = cloneTaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1(
    context,
  );
  return cloned.requestId === evidence.requestId
    && cloned.workId === evidence.workId
    && cloned.claimId === evidence.claimId
    && equalBytes(cloned.authorizationDigest, evidence.authorizationDigest)
    && cloned.claimExpiresAt === evidence.claimExpiresAt
    && cloned.recipientExpiresAt === evidence.recipientExpiresAt
    && cloned.expiresAt === evidence.expiresAt
    && cloned.recipientGeneration === evidence.recipientGeneration
    && cloned.recipientKeyId === evidence.recipientKeyId
    && cloned.policyRevision === evidence.policyRevision
    && cloned.episodeId === evidence.episodeId
    && cloned.sourceRoomId === evidence.sourceRoomId
    && cloned.hostAuthorizationRevision === evidence.hostAuthorizationRevision
    && cloned.recipientAuthorizationRevision
      === evidence.recipientAuthorizationRevision
    && cloned.taskId === evidence.result.taskId
    && cloned.taskRunId === evidence.result.taskRunId
    && cloned.agentId === evidence.result.signerAgentId
    && cloned.namespaces.length === selected.namespaces.length
    && cloned.namespaces.every((entry, index) =>
      namespaceFingerprint(entry)
        === namespaceFingerprint(selected.namespaces[index]!)
    )
    && cloned.domains.length === selected.domains.length
    && cloned.domains.every((entry, index) =>
      domainFingerprint(entry) === domainFingerprint(selected.domains[index]!)
    );
}
