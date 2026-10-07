import { and, domainKeyHeads, eq, type PostgresJsBridgeConnection } from "@nautilo/db";
import {
  assertAuthenticTaskRuntimeExecutionEvidence,
  decryptObjectThroughNamespace,
  type DomainForegroundSecretEntry,
  type LatticeCrypto,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import type { ProtectedTaskDefinitionOccurrenceV1 } from "../../task/protected-task-definition-opener.ts";
import {
  deriveTaskContentCryptoObjectIdV1,
  TASK_DEFINITION_OBJECT_TYPE_V1,
} from "../../task/task-content-repository.ts";
import { decodeTaskPayloadV1, type TaskPayloadV1 } from "../../task/task-payload-v1.ts";
import {
  PostgresDomainKeyAuthorityRepository,
  type DomainForegroundNamespaceAuthorityInspectionV2,
} from "../delivery/postgres-domain-key-authority.ts";
import {
  PostgresLatticeStorage,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  readCryptoStorageInteger,
  verifyCryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import {
  destroyVerifiedStoredObjectAccessManifestChainV5,
  verifyStoredObjectAccessManifestChainV5,
} from "../storage/postgres-object-access-manifest-v5.ts";

export type NativeProtectedTaskDefinitionOccurrenceV1 =
  ProtectedTaskDefinitionOccurrenceV1 & Readonly<{
    taskRunId: string;
    sourceRoomId: string;
    agentId: string;
  }>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameOccurrence(
  left: NativeProtectedTaskDefinitionOccurrenceV1,
  right: NativeProtectedTaskDefinitionOccurrenceV1,
): boolean {
  return left.taskId === right.taskId
    && left.taskRunId === right.taskRunId
    && left.sourceRoomId === right.sourceRoomId
    && left.agentId === right.agentId
    && left.requesterHumanId === right.requesterHumanId
    && left.objectId === right.objectId
    && left.contentRevision === right.contentRevision
    && left.cryptoAccessRevision === right.cryptoAccessRevision
    && left.namespaceId === right.namespaceId
    && left.domainId === right.domainId
    && left.expectedAccessRevision === right.expectedAccessRevision
    && left.expectedPolicyRevision === right.expectedPolicyRevision;
}

function exactDomain(
  evidence: TaskRuntimeExecutionEvidence,
  domains: readonly DomainForegroundSecretEntry[],
  occurrence: NativeProtectedTaskDefinitionOccurrenceV1,
): DomainForegroundSecretEntry {
  const requirements = evidence.namespaceRequirements.filter((entry) =>
    entry.namespaceId === occurrence.namespaceId);
  const requirement = requirements[0];
  const result = evidence.result;
  if (evidence.purpose !== "task.runtime.execution"
    || result.taskId !== occurrence.taskId
    || result.taskRunId !== occurrence.taskRunId
    || evidence.workId !== occurrence.taskRunId
    || evidence.sourceRoomId !== occurrence.sourceRoomId
    || result.signerAgentId !== occurrence.agentId
    || result.namespace.namespaceId !== occurrence.namespaceId
    || result.namespace.domainId !== occurrence.domainId
    || result.namespace.expectedAccessRevision !== occurrence.expectedAccessRevision
    || result.namespace.expectedPolicyRevision !== occurrence.expectedPolicyRevision
    || result.namespace.operations.length !== 1
    || result.namespace.operations[0] !== "encrypt"
    || evidence.policyRevision !== occurrence.expectedPolicyRevision
    || occurrence.objectId !== deriveTaskContentCryptoObjectIdV1({
      kind: "definition", taskId: occurrence.taskId, contentRevision: occurrence.contentRevision,
    })
    || occurrence.cryptoAccessRevision !== 0
    || requirements.length !== 1 || requirement === undefined
    || requirement.domainId !== occurrence.domainId
    || requirement.expectedAccessRevision !== occurrence.expectedAccessRevision
    || requirement.expectedPolicyRevision !== occurrence.expectedPolicyRevision
    || requirement.operations.length !== 2
    || requirement.operations[0] !== "decrypt"
    || requirement.operations[1] !== "encrypt") {
    throw new TypeError("Native Task definition occurrence authority was substituted");
  }
  const expected = evidence.domainRequirements.filter((entry) => entry.domainId === occurrence.domainId);
  const opened = domains.filter((entry) => entry.domainId === occurrence.domainId);
  const current = expected[0];
  const domain = opened[0];
  if (expected.length !== 1 || current === undefined
    || opened.length !== 1 || domain === undefined
    || domain.sourceNamespaceId !== current.sourceNamespaceId
    || domain.participantCount !== current.participantCount
    || domain.keyClass !== "ai"
    || domain.domainKeyGeneration !== current.domainKeyGeneration
    || domain.authorizationRevision !== current.authorizationRevision
    || !sameBytes(domain.participantDigest, current.participantDigest)
    || !sameBytes(domain.headDigest, current.headDigest)) {
    throw new TypeError("Native Task definition Domain authority was substituted");
  }
  return domain;
}

function destroyAuthority(authority: DomainForegroundNamespaceAuthorityInspectionV2): void {
  authority.namespaceHeadDigest.fill(0);
  authority.namespacePublicationDigest.fill(0);
  authority.namespacePublicationSetDigest.fill(0);
  authority.namespaceAudienceFingerprint.fill(0);
  authority.domainHeadDigest.fill(0);
  authority.bundleDigest.fill(0);
}

function sameAuthority(
  left: DomainForegroundNamespaceAuthorityInspectionV2,
  right: DomainForegroundNamespaceAuthorityInspectionV2,
): boolean {
  return left.namespaceId === right.namespaceId
    && left.namespaceAccessRevision === right.namespaceAccessRevision
    && left.namespaceKeyGeneration === right.namespaceKeyGeneration
    && left.domainId === right.domainId
    && left.domainKeyGeneration === right.domainKeyGeneration
    && left.domainAuthorizationRevision === right.domainAuthorizationRevision
    && left.bundleRevision === right.bundleRevision
    && sameBytes(left.namespaceHeadDigest, right.namespaceHeadDigest)
    && sameBytes(left.bundleDigest, right.bundleDigest)
    && sameBytes(left.domainHeadDigest, right.domainHeadDigest);
}

/**
 * Native Domain-bundle Task definition opening, deliberately unmounted.
 * The loader must prove the exact current Task/TaskRun and product authority
 * in a short transaction. Neither its transaction nor a Namespace key escapes
 * into ordinary Job input; plaintext is lent only within the live grant callback.
 */
export async function withNativeProtectedTaskDefinitionV1<Value>(input: Readonly<{
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  evidence: TaskRuntimeExecutionEvidence;
  domains: readonly DomainForegroundSecretEntry[];
  signal: AbortSignal;
  loadCurrentOccurrence(): Promise<NativeProtectedTaskDefinitionOccurrenceV1 | null>;
  execute(payload: TaskPayloadV1, assertCurrentOccurrence: () => Promise<void>): Value | PromiseLike<Value>;
}>): Promise<Value> {
  const assertActive = (): void => {
    input.signal.throwIfAborted();
    assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
  };
  assertActive();
  const loaded = await input.loadCurrentOccurrence();
  assertActive();
  if (loaded === null) throw new TypeError("Current native Task definition is unavailable");
  const occurrence = Object.freeze({ ...loaded });
  const domain = exactDomain(input.evidence, input.domains, occurrence);
  const handle = await verifyCryptoPostgresHandle(input.restricted);
  const storage = new PostgresLatticeStorage(handle);
  const repository = new PostgresDomainKeyAuthorityRepository(input.restricted, input.crypto, input.serverScope);
  const authority = await repository.inspectForegroundNamespaceAuthority({ namespaceId: occurrence.namespaceId, keyClass: "ai" });
  if (authority.status !== "ready") throw new TypeError("Native Task Namespace is unavailable");
  const owned: Uint8Array[] = [];
  const assertCurrentDomain = async (): Promise<void> => {
    // Native Domain publication can advance before its Namespace bundles are
    // repaired. A still-current Namespace head alone cannot keep a grant live.
    const heads = await executeTypedCryptoQuery(handle,
      cryptoTypedDb.select({
        domain_id: domainKeyHeads.domainId,
        domain_key_generation: domainKeyHeads.domainKeyGeneration,
        authorization_revision: domainKeyHeads.authorizationRevision,
        head_digest: domainKeyHeads.headDigest,
        participant_digest: domainKeyHeads.participantDigest,
        participant_count: domainKeyHeads.participantCount,
      }).from(domainKeyHeads).where(and(
        eq(domainKeyHeads.domainId, domain.domainId), eq(domainKeyHeads.keyClass, "ai"),
      )).limit(2));
    assertActive();
    const head = heads[0];
    if (heads.length !== 1 || head === undefined
      || head.domain_id !== domain.domainId
      || readCryptoStorageInteger(head, "domain_key_generation") !== domain.domainKeyGeneration
      || readCryptoStorageInteger(head, "authorization_revision") !== domain.authorizationRevision
      || readCryptoStorageInteger(head, "participant_count") !== domain.participantCount
      || !(head.head_digest instanceof Uint8Array)
      || !(head.participant_digest instanceof Uint8Array)
      || !sameBytes(head.head_digest, domain.headDigest)
      || !sameBytes(head.participant_digest, domain.participantDigest)) {
      throw new TypeError("Native Task Domain authority changed while open");
    }
  };
  try {
    assertActive();
    if (authority.namespaceId !== occurrence.namespaceId
      || authority.namespaceAccessRevision !== occurrence.expectedAccessRevision
      || authority.domainId !== domain.domainId
      || authority.domainKeyGeneration !== domain.domainKeyGeneration
      || authority.domainAuthorizationRevision !== domain.authorizationRevision
      || !sameBytes(authority.domainHeadDigest, domain.headDigest)) {
      throw new TypeError("Native Task Namespace authority was substituted");
    }
    await assertCurrentDomain();
    const assertCurrentOccurrence = async (): Promise<void> => {
      assertActive();
      const current = await input.loadCurrentOccurrence();
      assertActive();
      if (current === null || !sameOccurrence(occurrence, current)) {
        throw new TypeError("Native Task definition changed while open");
      }
      const currentAuthority = await repository.inspectForegroundNamespaceAuthority({ namespaceId: occurrence.namespaceId, keyClass: "ai" });
      if (currentAuthority.status !== "ready") throw new TypeError("Native Task Namespace is unavailable");
      try {
        assertActive();
        if (!sameAuthority(authority, currentAuthority)) throw new TypeError("Native Task Namespace changed while open");
      } finally { destroyAuthority(currentAuthority); }
      await assertCurrentDomain();
    };
    const [storedObject, access] = await Promise.all([
      storage.getObject(occurrence.objectId), storage.getObjectAccessState(occurrence.objectId),
    ]);
    if (storedObject !== null) owned.push(storedObject.payloadBytes);
    if (access !== null) {
      owned.push(access.head.manifestBytes, access.head.manifestHash);
      for (const envelope of access.namespaceEnvelopes) owned.push(envelope.envelopeBytes, envelope.envelopeHash);
    }
    assertActive();
    if (storedObject === null || access === null
      || storedObject.objectId !== occurrence.objectId
      || access.head.objectId !== occurrence.objectId
      || access.head.accessRevision !== 0
      || access.namespaceEnvelopes.length !== 1
      || access.namespaceEnvelopes[0]?.namespaceId !== occurrence.namespaceId) {
      throw new TypeError("Native Task definition ciphertext is incomplete");
    }
    const payload = decodeEncryptedPayloadV2(storedObject.payloadBytes);
    let envelope: ReturnType<typeof decodeNamespaceObjectEnvelopeV2> | undefined;
    let payloadHash: Uint8Array | undefined;
    let manifestHash: Uint8Array | undefined;
    let envelopeHash: Uint8Array | undefined;
    try {
      envelope = decodeNamespaceObjectEnvelopeV2(access.namespaceEnvelopes[0].envelopeBytes);
      payloadHash = input.crypto.hash(storedObject.payloadBytes);
      manifestHash = input.crypto.hash(access.head.manifestBytes);
      envelopeHash = input.crypto.hash(access.namespaceEnvelopes[0].envelopeBytes);
      if (payload.context.objectId !== occurrence.objectId
        || payload.context.objectType !== TASK_DEFINITION_OBJECT_TYPE_V1
        || payload.context.keyClass !== "ai"
        || !sameBytes(manifestHash, access.head.manifestHash)
        || !sameBytes(envelopeHash, access.namespaceEnvelopes[0].envelopeHash)
        || envelope.context.objectId !== occurrence.objectId
        || envelope.context.namespaceId !== occurrence.namespaceId
        || envelope.context.keyClass !== "ai"
        || envelope.context.bindingRevisionAtWrap !== occurrence.expectedAccessRevision) {
        throw new TypeError("Native Task definition ciphertext coordinates are invalid");
      }
      const verified = await verifyStoredObjectAccessManifestChainV5({
        executor: handle, crypto: input.crypto, objectId: occurrence.objectId,
        headAccessRevision: 0, expectedPayloadHash: payloadHash,
        expectedHeadManifestHash: access.head.manifestHash,
        resolveHistoricalAgentManagerAuthority: () => Promise.resolve(null),
      });
      try {
        if (verified.headManifest.accessRevision !== 0
          || verified.headManifest.previousManifestHash !== null
          || verified.headManifest.signer.kind !== "human_device"
          || verified.headManifest.signer.subjectHumanId !== occurrence.requesterHumanId
          || verified.headManifest.envelopeHashes.length !== 1
          || !sameBytes(verified.headManifest.envelopeHashes[0]!, envelopeHash)) {
          throw new TypeError("Native Task definition access manifest is invalid");
        }
      } finally { destroyVerifiedStoredObjectAccessManifestChainV5(verified); }
      await assertCurrentOccurrence();
      const openedEnvelope = envelope;
      const opened = await repository.withOpenedForegroundNamespaceKey({
        authority, domainKey: domain.domainKey,
        keyGeneration: openedEnvelope.context.keyGeneration,
        accessRevision: openedEnvelope.context.bindingRevisionAtWrap,
        use: async (key) => {
          assertActive();
          const plaintext = decryptObjectThroughNamespace(input.crypto, key, openedEnvelope, payload);
          if (plaintext === null) throw new TypeError("Native Task definition could not be opened");
          try {
            const decoded = decodeTaskPayloadV1(plaintext);
            const value = await input.execute(decoded, assertCurrentOccurrence);
            await assertCurrentOccurrence();
            // Preserve a callback's legitimate null return distinctly from
            // the native key owner's unavailable outcome.
            return { value };
          } finally { plaintext.fill(0); }
        },
      });
      if (opened === null) throw new TypeError("Native Task Namespace generation is unavailable");
      return opened.value;
    } finally {
      payload.ciphertext.fill(0);
      envelope?.wrappedDek.fill(0);
      payloadHash?.fill(0);
      manifestHash?.fill(0);
      envelopeHash?.fill(0);
    }
  } finally {
    destroyAuthority(authority);
    for (const bytes of owned) bytes.fill(0);
  }
}
