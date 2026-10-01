import {
  and, cryptoObjects, domainKeyHeads, eq, objectCryptoAccessHeads,
  objectCryptoAccessManifests, objectCryptoNamespaceEnvelopes,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  assertAuthenticTaskRuntimeExecutionEvidence, decryptObjectThroughNamespace,
  type DomainForegroundSecretEntry, type LatticeCrypto,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import {
  decodeAgentRuntimeSignerPublicationV1, decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2, decodeObjectAccessManifestV5,
} from "@nautilo/lattice-crypto/wire";
import {
  assertConversationDurableKey, CONVERSATION_MESSAGE_OBJECT_TYPE,
  deriveMessageCryptoObjectIdV2,
} from "../../message/conversation-repository.ts";
import {
  decodeMessagePayloadV2, type MessagePayloadV2,
} from "../../message/message-payload-v2.ts";
import {
  PostgresDomainKeyAuthorityRepository,
  type DomainForegroundNamespaceAuthorityInspectionV2,
} from "../delivery/postgres-domain-key-authority.ts";
import type {
  ResolveHistoricalAgentRuntimeSignerManagerAuthority,
} from "../storage/agent-runtime-signer-history.ts";
import {
  cryptoTypedDb, executeTypedCryptoQuery, verifyCryptoPostgresHandle,
  withVerifiedCryptoPostgresTransaction, type CryptoPostgresExecutor,
} from "../storage/postgres-lattice-storage.ts";
import {
  destroyVerifiedStoredObjectAccessManifestChainV5,
  verifyStoredObjectAccessManifestChainV5,
} from "../storage/postgres-object-access-manifest-v5.ts";
import type { DatabaseRow } from "../storage/postgres-record-codecs.ts";

export type NativeTaskMessageReadAuthorityV1 = Readonly<{
  mode: "shadow_encryption" | "encrypted_only";
  taskId: string;
  taskRunId: string;
  sourceRoomId: string;
  roomId: string;
  sessionId: string;
  messageId: number;
  revision: number;
  graphThreadId: string;
  humanTurnId: string;
  agentId: string;
  role: Exclude<MessagePayloadV2["role"], "user">;
  createdAt: number;
  objectId: string;
  cryptoAccessRevision: 0;
  namespaceId: string;
  domainId: string;
  expectedAccessRevision: number;
  expectedPolicyRevision: number;
}>;

declare const nativeTaskMessageReadTargetBrand: unique symbol;

/** V5-only read target. It cannot be passed to the V2/V3 conversation reader. */
export type NativeTaskMessageReadTargetV1 = Readonly<{
  purpose: "native-task-message-read-v1";
  readonly [nativeTaskMessageReadTargetBrand]: true;
}>;

const readTargets = new WeakMap<
  NativeTaskMessageReadTargetV1,
  NativeTaskMessageReadAuthorityV1
>();

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameReadAuthority(
  left: NativeTaskMessageReadAuthorityV1,
  right: NativeTaskMessageReadAuthorityV1,
): boolean {
  const fields = Object.keys(left) as (keyof NativeTaskMessageReadAuthorityV1)[];
  return Object.keys(right).length === fields.length
    && fields.every((field) => left[field] === right[field]);
}

function rowBytes(row: DatabaseRow, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Native Task Message ${field} is invalid`);
  }
  return value.slice();
}

function rowCounter(row: DatabaseRow, field: string): number {
  const raw = row[field];
  const value = typeof raw === "bigint"
    ? Number(raw)
    : typeof raw === "string" && /^(0|[1-9][0-9]*)$/u.test(raw)
    ? Number(raw)
    : raw;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Native Task Message ${field} is invalid`);
  }
  return value as number;
}

function destroyNamespaceAuthority(
  authority: DomainForegroundNamespaceAuthorityInspectionV2,
): void {
  for (const value of [
    authority.namespaceHeadDigest,
    authority.namespacePublicationDigest,
    authority.namespacePublicationSetDigest,
    authority.namespaceAudienceFingerprint,
    authority.domainHeadDigest,
    authority.bundleDigest,
  ]) value.fill(0);
}

function sameNamespaceAuthority(
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

function exactDomain(
  evidence: TaskRuntimeExecutionEvidence,
  domains: readonly DomainForegroundSecretEntry[],
  target: NativeTaskMessageReadAuthorityV1,
): DomainForegroundSecretEntry {
  const requirements = evidence.namespaceRequirements.filter(
    (entry) => entry.namespaceId === target.namespaceId,
  );
  const requirement = requirements[0];
  const expectedDomains = evidence.domainRequirements.filter(
    (entry) => entry.domainId === target.domainId,
  );
  const openedDomains = domains.filter(
    (entry) => entry.domainId === target.domainId,
  );
  const expectedDomain = expectedDomains[0];
  const openedDomain = openedDomains[0];
  if (evidence.purpose !== "task.runtime.execution"
    || evidence.result.taskId !== target.taskId
    || evidence.result.taskRunId !== target.taskRunId
    || evidence.result.signerAgentId !== target.agentId
    || evidence.workId !== target.taskRunId
    || evidence.sourceRoomId !== target.sourceRoomId
    || evidence.policyRevision !== target.expectedPolicyRevision
    || requirements.length !== 1 || requirement === undefined
    || requirement.domainId !== target.domainId
    || requirement.expectedAccessRevision !== target.expectedAccessRevision
    || requirement.expectedPolicyRevision !== target.expectedPolicyRevision
    || !requirement.operations.includes("decrypt")
    || expectedDomains.length !== 1 || expectedDomain === undefined
    || openedDomains.length !== 1 || openedDomain === undefined
    || openedDomain.sourceNamespaceId !== expectedDomain.sourceNamespaceId
    || openedDomain.keyClass !== "ai"
    || openedDomain.domainKeyGeneration !== expectedDomain.domainKeyGeneration
    || openedDomain.authorizationRevision !== expectedDomain.authorizationRevision
    || openedDomain.participantCount !== expectedDomain.participantCount
    || !sameBytes(openedDomain.participantDigest, expectedDomain.participantDigest)
    || !sameBytes(openedDomain.headDigest, expectedDomain.headDigest)) {
    throw new TypeError("Native Task Message grant does not authorize its audience");
  }
  return openedDomain;
}

function readTarget(
  target: NativeTaskMessageReadTargetV1,
): NativeTaskMessageReadAuthorityV1 {
  const authority = readTargets.get(target);
  if (authority === undefined) {
    throw new TypeError("Native Task Message read target was not created by the bridge");
  }
  return authority;
}

/**
 * Creates a nominal V5 Task transcript read target. Current product authority
 * is still reproved by the opener before and after plaintext use.
 */
export function createNativeTaskMessageReadTargetV1(
  input: NativeTaskMessageReadAuthorityV1,
): NativeTaskMessageReadTargetV1 {
  const authority = Object.freeze({ ...input });
  for (const field of [
    "taskId", "taskRunId", "sourceRoomId", "roomId", "graphThreadId",
    "humanTurnId", "agentId", "namespaceId", "domainId",
  ] as const) {
    assertConversationDurableKey(`Native Task Message ${field}`, authority[field]);
  }
  if ((authority.mode !== "shadow_encryption" && authority.mode !== "encrypted_only")
    || !["assistant", "tool", "system"].includes(authority.role)
    || authority.objectId !== deriveMessageCryptoObjectIdV2(authority)
    || authority.cryptoAccessRevision !== 0
    || !Number.isSafeInteger(authority.createdAt) || authority.createdAt < 0
    || !Number.isSafeInteger(authority.expectedAccessRevision)
    || authority.expectedAccessRevision < 0
    || !Number.isSafeInteger(authority.expectedPolicyRevision)
    || authority.expectedPolicyRevision < 0) {
    throw new TypeError("Native Task Message read target is invalid");
  }
  const target = Object.freeze({
    purpose: "native-task-message-read-v1",
  }) as NativeTaskMessageReadTargetV1;
  readTargets.set(target, authority);
  return target;
}

type StoredMessage = Readonly<{
  payloadBytes: Uint8Array;
  envelopeBytes: Uint8Array;
}>;

async function readVerifiedMessage(
  executor: CryptoPostgresExecutor,
  crypto: LatticeCrypto,
  target: NativeTaskMessageReadAuthorityV1,
  resolveHistoricalAgentSignerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority,
): Promise<StoredMessage> {
  const objects = await executeTypedCryptoQuery(executor, cryptoTypedDb.select({
    object_id: cryptoObjects.objectId,
    payload_hash: cryptoObjects.payloadHash,
    payload_bytes: cryptoObjects.payloadBytes,
  }).from(cryptoObjects).where(eq(cryptoObjects.objectId, target.objectId)).limit(2));
  const heads = await executeTypedCryptoQuery(executor, cryptoTypedDb.select({
    object_id: objectCryptoAccessHeads.objectId,
    access_revision: objectCryptoAccessHeads.accessRevision,
    manifest_hash: objectCryptoAccessHeads.manifestHash,
  }).from(objectCryptoAccessHeads).where(eq(
    objectCryptoAccessHeads.objectId,
    target.objectId,
  )).limit(2));
  const manifests = await executeTypedCryptoQuery(executor, cryptoTypedDb.select({
    object_id: objectCryptoAccessManifests.objectId,
    access_revision: objectCryptoAccessManifests.accessRevision,
    previous_manifest_hash: objectCryptoAccessManifests.previousManifestHash,
    payload_hash: objectCryptoAccessManifests.payloadHash,
    manifest_hash: objectCryptoAccessManifests.manifestHash,
    manifest_bytes: objectCryptoAccessManifests.manifestBytes,
  }).from(objectCryptoAccessManifests).where(eq(
    objectCryptoAccessManifests.objectId,
    target.objectId,
  )).limit(2));
  const envelopes = await executeTypedCryptoQuery(executor, cryptoTypedDb.select({
    object_id: objectCryptoNamespaceEnvelopes.objectId,
    access_revision: objectCryptoNamespaceEnvelopes.accessRevision,
    namespace_id: objectCryptoNamespaceEnvelopes.namespaceId,
    ordinal: objectCryptoNamespaceEnvelopes.ordinal,
    envelope_hash: objectCryptoNamespaceEnvelopes.envelopeHash,
    envelope_bytes: objectCryptoNamespaceEnvelopes.envelopeBytes,
  }).from(objectCryptoNamespaceEnvelopes).where(eq(
    objectCryptoNamespaceEnvelopes.objectId,
    target.objectId,
  )).limit(2));
  if ([objects, heads, manifests, envelopes].some((rows) => rows.length !== 1)) {
    throw new TypeError("Native Task Message ciphertext is incomplete or has an unsupported access head");
  }
  const object = objects[0]!;
  const head = heads[0]!;
  const manifestRow = manifests[0]!;
  const envelopeRow = envelopes[0]!;
  const owned: Uint8Array[] = [];
  const take = (row: DatabaseRow, field: string): Uint8Array => {
    const value = rowBytes(row, field);
    owned.push(value);
    return value;
  };
  try {
    const payloadBytes = take(object, "payload_bytes");
    const payloadHash = take(object, "payload_hash");
    const headManifestHash = take(head, "manifest_hash");
    const manifestHash = take(manifestRow, "manifest_hash");
    const manifestPayloadHash = take(manifestRow, "payload_hash");
    const manifestBytes = take(manifestRow, "manifest_bytes");
    const envelopeHash = take(envelopeRow, "envelope_hash");
    const envelopeBytes = take(envelopeRow, "envelope_bytes");
    if ([object, head, manifestRow, envelopeRow].some(
      (row) => row["object_id"] !== target.objectId,
    )
      || rowCounter(head, "access_revision") !== target.cryptoAccessRevision
      || rowCounter(manifestRow, "access_revision") !== target.cryptoAccessRevision
      || rowCounter(envelopeRow, "access_revision") !== target.cryptoAccessRevision
      || rowCounter(envelopeRow, "ordinal") !== 0
      || manifestRow["previous_manifest_hash"] !== null
      || envelopeRow["namespace_id"] !== target.namespaceId
      || !sameBytes(crypto.hash(payloadBytes), payloadHash)
      || !sameBytes(payloadHash, manifestPayloadHash)
      || !sameBytes(crypto.hash(manifestBytes), manifestHash)
      || !sameBytes(manifestHash, headManifestHash)
      || !sameBytes(crypto.hash(envelopeBytes), envelopeHash)) {
      throw new TypeError("Native Task Message durable ciphertext was substituted");
    }
    const payload = decodeEncryptedPayloadV2(payloadBytes);
    const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
    const manifest = decodeObjectAccessManifestV5(manifestBytes);
    try {
      if (payload.context.objectId !== target.objectId
        || payload.context.objectType !== CONVERSATION_MESSAGE_OBJECT_TYPE
        || payload.context.keyClass !== "ai"
        || payload.context.createdAt !== target.createdAt
        || envelope.context.objectId !== target.objectId
        || envelope.context.namespaceId !== target.namespaceId
        || envelope.context.keyClass !== "ai"
        || envelope.context.bindingRevisionAtWrap !== target.expectedAccessRevision
        || manifest.objectId !== target.objectId
        || manifest.accessRevision !== target.cryptoAccessRevision
        || manifest.previousManifestHash !== null
        || manifest.signerAuthorizationHash !== null
        || !sameBytes(manifest.payloadHash, payloadHash)
        || manifest.envelopeHashes.length !== 1
        || !sameBytes(manifest.envelopeHashes[0]!, envelopeHash)
        || manifest.signer.kind !== "agent_runtime"
        || manifest.signer.agentId !== target.agentId) {
        throw new TypeError("Native Task Message ciphertext coordinates were substituted");
      }
      const verified = await verifyStoredObjectAccessManifestChainV5({
        executor,
        crypto,
        objectId: target.objectId,
        headAccessRevision: target.cryptoAccessRevision,
        expectedPayloadHash: payloadHash,
        expectedHeadManifestHash: headManifestHash,
        resolveHistoricalAgentManagerAuthority:
          resolveHistoricalAgentSignerAuthority,
        resolveHistoricalHumanDeviceSigningPublicKey:
          () => Promise.resolve(null),
      });
      try {
        const signer = verified.headManifest.signer;
        const publications = verified.signerEvidence.filter(
          (entry) => entry.kind === "agent_runtime_publication",
        );
        if (signer.kind !== "agent_runtime"
          || signer.agentId !== target.agentId
          || publications.length !== 1) {
          throw new TypeError("Native Task Message historical signer is invalid");
        }
        const publication = decodeAgentRuntimeSignerPublicationV1(
          publications[0]!.evidenceBytes,
        );
        if (publication.agentId !== signer.agentId
          || publication.runtimeGeneration !== signer.runtimeGeneration
          || publication.signerKeyId !== signer.signerKeyId
          || publication.authorizationRevision
            !== verified.headManifest.hostAuthorizationRevision) {
          throw new TypeError("Native Task Message signer publication was substituted");
        }
      } finally {
        destroyVerifiedStoredObjectAccessManifestChainV5(verified);
      }
      return Object.freeze({
        payloadBytes: payloadBytes.slice(),
        envelopeBytes: envelopeBytes.slice(),
      });
    } finally {
      payload.ciphertext.fill(0);
      envelope.wrappedDek.fill(0);
    }
  } finally {
    for (const value of owned) value.fill(0);
  }
}

/**
 * Opens one genesis V5 Task transcript Message under the live background
 * Task grant. The namespace key remains inside the bridge callback and every
 * product, grant, Domain, Namespace, ciphertext and historical-signer fact is
 * checked before plaintext is lent to `execute`.
 */
export async function withNativeTaskMessageV1<Value>(input: Readonly<{
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  evidence: TaskRuntimeExecutionEvidence;
  domains: readonly DomainForegroundSecretEntry[];
  signal: AbortSignal;
  target: NativeTaskMessageReadTargetV1;
  resolveCurrentAuthority(
    expected: NativeTaskMessageReadAuthorityV1,
  ): Promise<NativeTaskMessageReadAuthorityV1 | null>;
  resolveHistoricalAgentSignerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority;
  execute(
    payload: MessagePayloadV2,
    assertCurrentAuthority: () => Promise<void>,
  ): Value | PromiseLike<Value>;
}>): Promise<Value> {
  const target = readTarget(input.target);
  const assertActive = (): void => {
    input.signal.throwIfAborted();
    assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
  };
  assertActive();
  const domain = exactDomain(input.evidence, input.domains, target);
  const handle = await verifyCryptoPostgresHandle(input.restricted);
  const repository = new PostgresDomainKeyAuthorityRepository(
    input.restricted,
    input.crypto,
    input.serverScope,
  );
  const namespace = await repository.inspectForegroundNamespaceAuthority({
    namespaceId: target.namespaceId,
    keyClass: "ai",
  });
  if (namespace.status !== "ready") {
    throw new TypeError("Native Task Message Namespace grant is unavailable");
  }
  let stored: StoredMessage | undefined;
  const assertCurrentDomain = async (): Promise<void> => {
    const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({
      domain_id: domainKeyHeads.domainId,
      domain_key_generation: domainKeyHeads.domainKeyGeneration,
      authorization_revision: domainKeyHeads.authorizationRevision,
      head_digest: domainKeyHeads.headDigest,
      participant_digest: domainKeyHeads.participantDigest,
      participant_count: domainKeyHeads.participantCount,
    }).from(domainKeyHeads).where(and(
      eq(domainKeyHeads.domainId, domain.domainId),
      eq(domainKeyHeads.keyClass, "ai"),
    )).limit(2));
    const row = rows[0];
    assertActive();
    if (rows.length !== 1 || row === undefined
      || row.domain_id !== domain.domainId
      || row.domain_key_generation !== domain.domainKeyGeneration
      || row.authorization_revision !== domain.authorizationRevision
      || row.participant_count !== domain.participantCount
      || !(row.head_digest instanceof Uint8Array)
      || !(row.participant_digest instanceof Uint8Array)
      || !sameBytes(row.head_digest, domain.headDigest)
      || !sameBytes(row.participant_digest, domain.participantDigest)) {
      throw new TypeError("Native Task Message Domain grant changed");
    }
  };
  const assertCurrentAuthority = async (): Promise<void> => {
    assertActive();
    const current = await input.resolveCurrentAuthority(target);
    assertActive();
    if (current === null || !sameReadAuthority(target, current)) {
      throw new TypeError("Native Task Message product authority changed");
    }
    const currentNamespace = await repository.inspectForegroundNamespaceAuthority({
      namespaceId: target.namespaceId,
      keyClass: "ai",
    });
    if (currentNamespace.status !== "ready") {
      throw new TypeError("Native Task Message Namespace grant is unavailable");
    }
    try {
      if (!sameNamespaceAuthority(namespace, currentNamespace)) {
        throw new TypeError("Native Task Message Namespace grant changed");
      }
    } finally {
      destroyNamespaceAuthority(currentNamespace);
    }
    await assertCurrentDomain();
  };
  try {
    if (namespace.namespaceId !== target.namespaceId
      || namespace.namespaceAccessRevision !== target.expectedAccessRevision
      || namespace.domainId !== target.domainId
      || namespace.domainKeyGeneration !== domain.domainKeyGeneration
      || namespace.domainAuthorizationRevision !== domain.authorizationRevision
      || !sameBytes(namespace.domainHeadDigest, domain.headDigest)) {
      throw new TypeError("Native Task Message Namespace grant was substituted");
    }
    await assertCurrentAuthority();
    stored = await withVerifiedCryptoPostgresTransaction(
      handle,
      (executor) => readVerifiedMessage(
        executor,
        input.crypto,
        target,
        input.resolveHistoricalAgentSignerAuthority,
      ),
    );
    await assertCurrentAuthority();
    const payload = decodeEncryptedPayloadV2(stored.payloadBytes);
    const envelope = decodeNamespaceObjectEnvelopeV2(stored.envelopeBytes);
    try {
      const opened = await repository.withOpenedForegroundNamespaceKey({
        authority: namespace,
        domainKey: domain.domainKey,
        keyGeneration: envelope.context.keyGeneration,
        accessRevision: envelope.context.bindingRevisionAtWrap,
        use: async (key) => {
          assertActive();
          const plaintext = decryptObjectThroughNamespace(
            input.crypto,
            key,
            envelope,
            payload,
          );
          if (plaintext === null) {
            throw new TypeError("Native Task Message could not be opened");
          }
          try {
            const decoded = decodeMessagePayloadV2(plaintext);
            if (decoded.role !== target.role) {
              throw new TypeError("Native Task Message role was substituted");
            }
            await assertCurrentAuthority();
            const value = await input.execute(decoded, assertCurrentAuthority);
            await assertCurrentAuthority();
            return { value };
          } finally {
            plaintext.fill(0);
          }
        },
      });
      if (opened === null) {
        throw new TypeError("Native Task Message Namespace generation is unavailable");
      }
      return opened.value;
    } finally {
      payload.ciphertext.fill(0);
      envelope.wrappedDek.fill(0);
    }
  } finally {
    stored?.payloadBytes.fill(0);
    stored?.envelopeBytes.fill(0);
    destroyNamespaceAuthority(namespace);
  }
}
