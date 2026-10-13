import { and, domainKeyHeads, eq, objectCryptoAccessManifests, type PostgresJsBridgeConnection } from "@nautilo/db";
import {
  assertAuthenticTaskRuntimeRunResultReadEvidence,
  decryptObjectThroughNamespace,
  type DomainForegroundSecretEntry,
  type LatticeCrypto,
  type TaskRuntimeRunResultReadEvidence,
  type TaskRuntimeRunResultReadProof,
  type TaskRuntimeRunResultReadInvocation,
} from "@nautilo/lattice-crypto";
import {
  decodeObjectAccessManifestV5,
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import type { ResolveHistoricalAgentRuntimeSignerManagerAuthority } from "../storage/agent-runtime-signer-history.ts";
import {
  deriveTaskContentCryptoObjectIdV1,
  TASK_RUN_RESULT_OBJECT_TYPE_V1,
} from "../../task/task-content-repository.ts";
import { decodeTaskRunResultPayloadV1, type TaskRunResultPayloadV1 } from "../../task/task-payload-v1.ts";
import { encodeMessagePayloadV2, type MessagePayloadV2 } from "../../message/message-payload-v2.ts";
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

export type NativeProtectedTaskRunResultOccurrenceV1 = Readonly<{
  requesterHumanId: string;
  result: TaskRuntimeRunResultReadProof;
  invocation: TaskRuntimeRunResultReadInvocation;
}>;

declare const nativeTaskRunResultMessageSourceBrand: unique symbol;

type RawResultReadInvocation = Extract<
  TaskRuntimeRunResultReadInvocation,
  Readonly<{ kind: "raw" }>
>;
type ResultMessageWriteProof = NonNullable<
  TaskRuntimeRunResultReadEvidence["messageWrite"]
>;

export type NativeProtectedTaskRunResultMessageSourceV1 = Readonly<{
  purpose: "native.protected_task_run_result_message_source.v1";
  requesterHumanId: string;
  result: TaskRuntimeRunResultReadProof;
  invocation: RawResultReadInvocation;
  messageWrite: ResultMessageWriteProof;
  payload: MessagePayloadV2 & Readonly<{ role: "assistant" }>;
  payloadDigest: Uint8Array;
  readonly [nativeTaskRunResultMessageSourceBrand]: true;
}>;

export type NativeProtectedTaskRunResultMessageSourceResultV1<Value> =
  | Readonly<{ status: "available"; value: Value }>
  | Readonly<{ status: "unavailable"; reason: "result_text_unavailable" }>;

const messageSourceStates = new WeakMap<object, Readonly<{
  fingerprint: string;
  evidence: TaskRuntimeRunResultReadEvidence;
}>>();

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function copyDomainAuthority(
  value: ResultMessageWriteProof["domain"],
): ResultMessageWriteProof["domain"] {
  return Object.freeze({ ...value,
    participantDigest: Uint8Array.from(value.participantDigest),
    headDigest: Uint8Array.from(value.headDigest),
    activeNamespaceBindingSetDigest:
      Uint8Array.from(value.activeNamespaceBindingSetDigest),
  });
}

function copyMessageWrite(
  value: ResultMessageWriteProof,
): ResultMessageWriteProof {
  return Object.freeze({ ...value,
    namespace: Object.freeze({ ...value.namespace,
      operations: Object.freeze(["encrypt"] as const) }),
    domain: copyDomainAuthority(value.domain),
  });
}

function messageSourceFingerprint(
  source: NativeProtectedTaskRunResultMessageSourceV1,
): string {
  return JSON.stringify(source, (_key, value: unknown) =>
    value instanceof Uint8Array ? Array.from(value) : value);
}

export function assertAuthenticNativeProtectedTaskRunResultMessageSourceV1(
  source: NativeProtectedTaskRunResultMessageSourceV1,
): void {
  const state = messageSourceStates.get(source as object);
  if (state === undefined
    || state.fingerprint !== messageSourceFingerprint(source)) {
    if (state !== undefined) messageSourceStates.delete(source as object);
    throw new TypeError("Native Task result Message source is not active");
  }
  assertAuthenticTaskRuntimeRunResultReadEvidence(state.evidence);
}

function fingerprint(value: NativeProtectedTaskRunResultOccurrenceV1): string {
  const r = value.result;
  const n = r.namespace;
  const i = value.invocation;
  return JSON.stringify([value.requesterHumanId, r.taskId, r.taskRunId, r.terminalStatus,
    r.contentRevision, r.objectId, r.cryptoAccessRevision, Array.from(r.genesisManifestHash),
    r.signerAgentId, n.namespaceId, n.domainId, n.operations, n.expectedAccessRevision,
    n.expectedPolicyRevision, i.kind, i.bindingId, i.operationId, i.roomId, i.sessionId,
    ...(i.kind === "wake" ? [i.jobId, i.reference.kind, i.reference.taskId,
      i.reference.taskRunId, i.reference.bindingId, i.reference.resultObjectId,
      i.reference.wakeOperationId, Object.keys(i.reference).sort()] : [])]);
}

function exactDomain(
  evidence: TaskRuntimeRunResultReadEvidence,
  domains: readonly DomainForegroundSecretEntry[],
  occurrence: NativeProtectedTaskRunResultOccurrenceV1,
): DomainForegroundSecretEntry {
  if (evidence.purpose !== "task.runtime.run_result_read"
    || fingerprint(occurrence) !== fingerprint({ requesterHumanId: evidence.requesterHumanId,
      result: evidence.result, invocation: evidence.invocation })
    || occurrence.result.objectId !== deriveTaskContentCryptoObjectIdV1({
      kind: "run_result", taskId: occurrence.result.taskId,
      taskRunId: occurrence.result.taskRunId, contentRevision: occurrence.result.contentRevision,
    })) throw new TypeError("Native Task result occurrence authority was substituted");
  const current = evidence.resultDomain;
  const domain = domains[0];
  if (domains.length !== 1 || domain === undefined || domain.domainId !== current.domainId
    || domain.sourceNamespaceId !== current.sourceNamespaceId
    || domain.participantCount !== current.participantCount
    || domain.keyClass !== "ai"
    || domain.domainKeyGeneration !== current.domainKeyGeneration
    || domain.authorizationRevision !== current.authorizationRevision
    || !sameBytes(domain.participantDigest, current.participantDigest)
    || !sameBytes(domain.headDigest, current.headDigest)) {
    throw new TypeError("Native Task result Domain authority was substituted");
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
 * Lends one mapped immutable terminal result inside fresh delivery/wake custody.
 * The product loader must re-prove current result and invoking delivery authority;
 * it does not add the private Task Namespace to a foreground readable set.
 */
export async function withNativeProtectedTaskRunResultV1<Value>(input: Readonly<{
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  evidence: TaskRuntimeRunResultReadEvidence;
  domains: readonly DomainForegroundSecretEntry[];
  signal: AbortSignal;
  loadCurrentResult(): Promise<NativeProtectedTaskRunResultOccurrenceV1 | null>;
  resolveHistoricalAgentSignerAuthority: ResolveHistoricalAgentRuntimeSignerManagerAuthority;
  execute(payload: TaskRunResultPayloadV1, assertCurrentResult: () => Promise<void>): Value | PromiseLike<Value>;
}>): Promise<Value> {
  const assertActive = (): void => {
    input.signal.throwIfAborted();
    assertAuthenticTaskRuntimeRunResultReadEvidence(input.evidence);
  };
  assertActive();
  const loaded = await input.loadCurrentResult();
  assertActive();
  if (loaded === null) throw new TypeError("Current native Task result is unavailable");
  const snapshot = fingerprint(loaded);
  const result = loaded.result;
  const occurrence = Object.freeze({ ...result, ...result.namespace,
    genesisManifestHash: Uint8Array.from(result.genesisManifestHash) });
  const domain = exactDomain(input.evidence, input.domains, loaded);
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
    const assertCurrentResult = async (): Promise<void> => {
      assertActive();
      const current = await input.loadCurrentResult();
      assertActive();
      if (current === null || fingerprint(current) !== snapshot) {
        throw new TypeError("Native Task result changed while open");
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
      || access.head.accessRevision !== occurrence.cryptoAccessRevision
      || access.namespaceEnvelopes.length !== 1
      || access.namespaceEnvelopes[0]?.namespaceId !== occurrence.namespaceId) {
      throw new TypeError("Native Task result ciphertext is incomplete");
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
        || payload.context.objectType !== TASK_RUN_RESULT_OBJECT_TYPE_V1
        || payload.context.keyClass !== "ai"
        || !sameBytes(manifestHash, access.head.manifestHash)
        || !sameBytes(envelopeHash, access.namespaceEnvelopes[0].envelopeHash)
        || envelope.context.objectId !== occurrence.objectId
        || envelope.context.namespaceId !== occurrence.namespaceId
        || envelope.context.keyClass !== "ai"
        || envelope.context.bindingRevisionAtWrap > occurrence.expectedAccessRevision) {
        throw new TypeError("Native Task result ciphertext coordinates are invalid");
      }
      const verified = await verifyStoredObjectAccessManifestChainV5({
        executor: handle, crypto: input.crypto, objectId: occurrence.objectId,
        headAccessRevision: occurrence.cryptoAccessRevision, expectedPayloadHash: payloadHash,
        expectedHeadManifestHash: access.head.manifestHash,
        resolveHistoricalAgentManagerAuthority: input.resolveHistoricalAgentSignerAuthority,
      });
      try {
        const genesisRows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({
          manifest_bytes: objectCryptoAccessManifests.manifestBytes,
          manifest_hash: objectCryptoAccessManifests.manifestHash,
        }).from(objectCryptoAccessManifests).where(and(
          eq(objectCryptoAccessManifests.objectId, occurrence.objectId),
          eq(objectCryptoAccessManifests.accessRevision, 0),
        )).limit(2));
        const genesisRow = genesisRows[0];
        if (genesisRows.length !== 1 || genesisRow === undefined
          || !(genesisRow.manifest_bytes instanceof Uint8Array)
          || !(genesisRow.manifest_hash instanceof Uint8Array)) {
          throw new TypeError("Native Task result genesis is unavailable");
        }
        const genesisBytes = Uint8Array.from(genesisRow.manifest_bytes);
        owned.push(genesisBytes);
        const genesis = decodeObjectAccessManifestV5(genesisBytes);
        if (genesis.objectId !== occurrence.objectId || genesis.accessRevision !== 0
          || genesis.previousManifestHash !== null
          || genesis.signer.kind !== "agent_runtime"
          || genesis.signer.agentId !== occurrence.signerAgentId
          || !sameBytes(input.crypto.hash(genesisBytes), occurrence.genesisManifestHash)
          || !sameBytes(genesisRow.manifest_hash, occurrence.genesisManifestHash)
          || !sameBytes(genesis.payloadHash, payloadHash)
          || (occurrence.cryptoAccessRevision === 0 && !sameBytes(genesisBytes, verified.headManifestBytes))
          || verified.headManifest.accessRevision !== occurrence.cryptoAccessRevision
          || verified.headManifest.envelopeHashes.length !== 1
          || !sameBytes(verified.headManifest.envelopeHashes[0]!, envelopeHash)) {
          throw new TypeError("Native Task result access manifest is invalid");
        }
      } finally { destroyVerifiedStoredObjectAccessManifestChainV5(verified); }
      await assertCurrentResult();
      const openedEnvelope = envelope;
      const opened = await repository.withOpenedForegroundNamespaceKey({
        authority, domainKey: domain.domainKey,
        keyGeneration: openedEnvelope.context.keyGeneration,
        accessRevision: openedEnvelope.context.bindingRevisionAtWrap,
        use: async (key) => {
          assertActive();
          const plaintext = decryptObjectThroughNamespace(input.crypto, key, openedEnvelope, payload);
          if (plaintext === null) throw new TypeError("Native Task result could not be opened");
          try {
            const decoded = decodeTaskRunResultPayloadV1(plaintext);
            await assertCurrentResult();
            const value = await input.execute(decoded, assertCurrentResult);
            await assertCurrentResult();
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
    occurrence.genesisManifestHash.fill(0);
    destroyAuthority(authority);
    for (const bytes of owned) bytes.fill(0);
  }
}

/**
 * Opens a normal raw Task result and lends an assistant Message source only
 * while both the private read proof and independently admitted destination
 * write proof remain callback-live. Error text is never a Message source.
 */
export async function withNativeProtectedTaskRunResultMessageSourceV1<Value>(
  input: Readonly<{
    restricted: PostgresJsBridgeConnection;
    crypto: LatticeCrypto;
    serverScope: string;
    evidence: TaskRuntimeRunResultReadEvidence;
    domains: readonly DomainForegroundSecretEntry[];
    signal: AbortSignal;
    loadCurrentResult(): Promise<NativeProtectedTaskRunResultOccurrenceV1 | null>;
    resolveHistoricalAgentSignerAuthority: ResolveHistoricalAgentRuntimeSignerManagerAuthority;
    execute(
      source: NativeProtectedTaskRunResultMessageSourceV1,
      assertCurrentSource: () => Promise<void>,
    ): Value | PromiseLike<Value>;
  }>,
): Promise<NativeProtectedTaskRunResultMessageSourceResultV1<Value>> {
  assertAuthenticTaskRuntimeRunResultReadEvidence(input.evidence);
  const evidence = input.evidence;
  const write = evidence.messageWrite;
  if (evidence.workKind !== "task.deliver_result"
    || evidence.result.contentRevision !== 1
    || (evidence.result.terminalStatus !== "completed"
      && evidence.result.terminalStatus !== "errored")
    || evidence.invocation.kind !== "raw"
    || write === null) {
    throw new TypeError("Native Task result is not an authorized raw Message source");
  }
  return withNativeProtectedTaskRunResultV1({
    ...input,
    execute: async (resultPayload, assertCurrentResult) => {
      if (resultPayload.resultText === null) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "result_text_unavailable" as const,
        });
      }
      const payload = Object.freeze({
        role: "assistant" as const,
        content: resultPayload.resultText,
      });
      const payloadBytes = encodeMessagePayloadV2(payload);
      const payloadDigest = input.crypto.hash(payloadBytes);
      const source = Object.freeze({
        purpose: "native.protected_task_run_result_message_source.v1" as const,
        requesterHumanId: evidence.requesterHumanId,
        result: Object.freeze({ ...evidence.result,
          genesisManifestHash:
            Uint8Array.from(evidence.result.genesisManifestHash),
          namespace: Object.freeze({ ...evidence.result.namespace,
            operations: Object.freeze(["decrypt"] as const) }),
        }),
        invocation: Object.freeze({ ...evidence.invocation }),
        messageWrite: copyMessageWrite(write),
        payload,
        payloadDigest,
      }) as NativeProtectedTaskRunResultMessageSourceV1;
      messageSourceStates.set(source, Object.freeze({
        fingerprint: messageSourceFingerprint(source), evidence,
      }));
      const assertCurrentSource = async (): Promise<void> => {
        assertAuthenticNativeProtectedTaskRunResultMessageSourceV1(source);
        await assertCurrentResult();
        assertAuthenticNativeProtectedTaskRunResultMessageSourceV1(source);
      };
      try {
        await assertCurrentSource();
        const value = await input.execute(source, assertCurrentSource);
        await assertCurrentSource();
        return Object.freeze({ status: "available" as const, value });
      } finally {
        messageSourceStates.delete(source);
        payloadBytes.fill(0);
        source.payloadDigest.fill(0);
        source.result.genesisManifestHash.fill(0);
        source.messageWrite.domain.participantDigest.fill(0);
        source.messageWrite.domain.headDigest.fill(0);
        source.messageWrite.domain.activeNamespaceBindingSetDigest.fill(0);
      }
    },
  });
}
