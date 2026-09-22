import {
  and,
  asc,
  cryptoObjects,
  eq,
  objectCryptoAccessHeads,
  objectCryptoAccessManifests,
  objectCryptoNamespaceEnvelopes,
} from "@nautilo/db";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import type { TaskContentAuthorityV1 } from "../../task/task-content-authority-v1.ts";
import {
  deriveTaskContentCryptoObjectIdV1,
  fingerprintTaskContentAuthorityV1,
  TASK_CONTENT_PAYLOAD_VERSION_V1,
  taskContentObjectTypeV1,
  type AtomicTaskContentCryptoCompletionPort,
  type PreparedTaskContentCryptoRevisionV1,
  type TaskContentCoordinateV1,
  type TaskContentCryptoRevisionReferenceV1,
  type VerifiedTaskContentCryptoRevisionV1,
} from "../../task/task-content-repository.ts";
import {
  readPreparedTaskContentCryptoRevisionSnapshotV1,
} from "../../task/task-content-prepared-revision.ts";
import type {
  ResolveHistoricalAgentRuntimeSignerManagerAuthority,
} from "../storage/agent-runtime-signer-history.ts";
import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  withVerifiedCryptoPostgresTransaction,
  type CryptoPostgresExecutor,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import type { DatabaseRow } from "../storage/postgres-record-codecs.ts";
import {
  destroyVerifiedStoredObjectAccessManifestChainV5,
  verifyStoredObjectAccessManifestChainV5,
  type ResolveHistoricalHumanDeviceSigningPublicKeyV5Async,
} from "../storage/postgres-object-access-manifest-v5.ts";

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function oneOrNull(
  rows: readonly DatabaseRow[],
  label: string,
): DatabaseRow | null {
  if (rows.length > 1) throw new Error(`${label} is not unique`);
  return rows[0] ?? null;
}

function rowString(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError(`${field} must be text`);
  return value;
}

function rowCounter(row: DatabaseRow, field: string): number {
  const raw = row[field];
  const value = typeof raw === "bigint"
    ? Number(raw)
    : typeof raw === "string" && /^(0|[1-9][0-9]*)$/u.test(raw)
    ? Number(raw)
    : raw;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer`);
  }
  return value as number;
}

function rowBytes(row: DatabaseRow, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array)) throw new TypeError(`${field} must be bytea`);
  return value.slice();
}

export class TaskContentCryptoCompletionConflictError extends Error {
  readonly code = "task_content_crypto_completion_conflict" as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TaskContentCryptoCompletionConflictError";
  }
}

function conflict(message: string, cause?: unknown): never {
  throw new TaskContentCryptoCompletionConflictError(message, cause);
}

export type ResolveCurrentTaskContentAuthorityV1 = (
  coordinate: TaskContentCoordinateV1,
) => Promise<TaskContentAuthorityV1 | null>;

type Dependencies = Readonly<{
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  resolveCurrentAuthority: ResolveCurrentTaskContentAuthorityV1;
  resolveHistoricalAgentSignerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority;
  resolveHistoricalHumanDeviceSigningPublicKey:
    ResolveHistoricalHumanDeviceSigningPublicKeyV5Async;
}>;

type ExactPublication = Readonly<{
  coordinate: TaskContentCoordinateV1;
  authority: TaskContentAuthorityV1;
  authorityFingerprint: Uint8Array;
  objectId: string;
  objectType: ReturnType<typeof taskContentObjectTypeV1>;
  payloadBytes: Uint8Array;
  payloadHash: Uint8Array;
  manifestBytes: Uint8Array;
  manifestHash: Uint8Array;
  envelopeBytes: Uint8Array;
  envelopeHash: Uint8Array;
}>;

type DurablePublication = Readonly<{
  objectId: string;
  payloadBytes: Uint8Array;
  payloadHash: Uint8Array;
  accessRevision: number;
  manifestBytes: Uint8Array;
  manifestHash: Uint8Array;
  namespaceId: string;
  envelopeBytes: Uint8Array;
  envelopeHash: Uint8Array;
  bindingRevisionAtWrap: number;
}>;

function exactPublication(
  crypto: LatticeCrypto,
  revision: PreparedTaskContentCryptoRevisionV1,
): ExactPublication {
  const snapshot = readPreparedTaskContentCryptoRevisionSnapshotV1(revision);
  const payloadBytes = snapshot.object.payloadBytes.ciphertext.slice();
  const manifestBytes = snapshot.access.manifestBytes.slice();
  const envelopeBytes = snapshot.access.envelopeBytes[0]!.slice();
  return Object.freeze({
    coordinate: snapshot.coordinate,
    authority: snapshot.authority,
    authorityFingerprint: revision.authorityFingerprint.slice(),
    objectId: revision.objectId,
    objectType: revision.objectType,
    payloadBytes,
    payloadHash: crypto.hash(payloadBytes),
    manifestBytes,
    manifestHash: crypto.hash(manifestBytes),
    envelopeBytes,
    envelopeHash: crypto.hash(envelopeBytes),
  });
}

function authorityMatches(
  left: TaskContentAuthorityV1,
  right: TaskContentAuthorityV1,
): boolean {
  return left.authorityVersion === right.authorityVersion
    && left.kind === right.kind
    && left.keyClass === right.keyClass
    && left.requesterHumanId === right.requesterHumanId
    && left.namespaceId === right.namespaceId
    && left.domainId === right.domainId
    && left.expectedAccessRevision === right.expectedAccessRevision
    && left.expectedPolicyRevision === right.expectedPolicyRevision;
}

async function readDurablePublication(input: Readonly<{
  executor: CryptoPostgresExecutor;
  crypto: LatticeCrypto;
  objectId: string;
  resolveHistoricalAgentSignerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority;
  resolveHistoricalHumanDeviceSigningPublicKey:
    ResolveHistoricalHumanDeviceSigningPublicKeyV5Async;
}>): Promise<DurablePublication | null> {
  const object = oneOrNull(await executeTypedCryptoQuery(
    input.executor,
    cryptoTypedDb.select({
      object_id: cryptoObjects.objectId,
      payload_hash: cryptoObjects.payloadHash,
      payload_bytes: cryptoObjects.payloadBytes,
    }).from(cryptoObjects).where(eq(cryptoObjects.objectId, input.objectId)).limit(2),
  ), "Task encrypted object");
  const head = oneOrNull(await executeTypedCryptoQuery(
    input.executor,
    cryptoTypedDb.select({
      object_id: objectCryptoAccessHeads.objectId,
      access_revision: objectCryptoAccessHeads.accessRevision,
      manifest_hash: objectCryptoAccessHeads.manifestHash,
      payload_hash: objectCryptoAccessManifests.payloadHash,
      manifest_bytes: objectCryptoAccessManifests.manifestBytes,
    }).from(objectCryptoAccessHeads).innerJoin(
      objectCryptoAccessManifests,
      and(
        eq(objectCryptoAccessManifests.objectId, objectCryptoAccessHeads.objectId),
        eq(
          objectCryptoAccessManifests.accessRevision,
          objectCryptoAccessHeads.accessRevision,
        ),
        eq(objectCryptoAccessManifests.manifestHash, objectCryptoAccessHeads.manifestHash),
      ),
    ).where(eq(objectCryptoAccessHeads.objectId, input.objectId)).limit(2),
  ), "Task access head");
  if (object === null && head === null) return null;
  if (object === null || head === null) conflict("Task crypto state is partial");
  const accessRevision = rowCounter(head, "access_revision");
  const envelopes = await executeTypedCryptoQuery(
    input.executor,
    cryptoTypedDb.select({
      object_id: objectCryptoNamespaceEnvelopes.objectId,
      access_revision: objectCryptoNamespaceEnvelopes.accessRevision,
      namespace_id: objectCryptoNamespaceEnvelopes.namespaceId,
      ordinal: objectCryptoNamespaceEnvelopes.ordinal,
      envelope_hash: objectCryptoNamespaceEnvelopes.envelopeHash,
      envelope_bytes: objectCryptoNamespaceEnvelopes.envelopeBytes,
    }).from(objectCryptoNamespaceEnvelopes).where(and(
      eq(objectCryptoNamespaceEnvelopes.objectId, input.objectId),
      eq(objectCryptoNamespaceEnvelopes.accessRevision, accessRevision),
    )).orderBy(asc(objectCryptoNamespaceEnvelopes.ordinal)).limit(2),
  );
  if (envelopes.length !== 1) {
    conflict("Task crypto state requires exactly one Namespace envelope");
  }
  const envelopeRow = envelopes[0]!;
  const payloadBytes = rowBytes(object, "payload_bytes");
  const payloadHash = input.crypto.hash(payloadBytes);
  const manifestBytes = rowBytes(head, "manifest_bytes");
  const manifestHash = rowBytes(head, "manifest_hash");
  const envelopeBytes = rowBytes(envelopeRow, "envelope_bytes");
  const envelopeHash = input.crypto.hash(envelopeBytes);
  const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
  if (
    rowString(object, "object_id") !== input.objectId
    || rowString(head, "object_id") !== input.objectId
    || rowString(envelopeRow, "object_id") !== input.objectId
    || rowCounter(envelopeRow, "access_revision") !== accessRevision
    || rowCounter(envelopeRow, "ordinal") !== 0
    || !equalBytes(rowBytes(object, "payload_hash"), payloadHash)
    || !equalBytes(rowBytes(head, "payload_hash"), payloadHash)
    || !equalBytes(input.crypto.hash(manifestBytes), manifestHash)
    || !equalBytes(rowBytes(envelopeRow, "envelope_hash"), envelopeHash)
    || envelope.context.objectId !== input.objectId
    || envelope.context.keyClass !== "ai"
    || envelope.context.namespaceId !== rowString(envelopeRow, "namespace_id")
  ) conflict("Task crypto state contains substituted bytes");
  const verifiedChain = await verifyStoredObjectAccessManifestChainV5({
    executor: input.executor,
    crypto: input.crypto,
    objectId: input.objectId,
    headAccessRevision: accessRevision,
    expectedPayloadHash: payloadHash,
    expectedHeadManifestHash: manifestHash,
    resolveHistoricalAgentManagerAuthority:
      input.resolveHistoricalAgentSignerAuthority,
    resolveHistoricalHumanDeviceSigningPublicKey:
      input.resolveHistoricalHumanDeviceSigningPublicKey,
  });
  try {
    return Object.freeze({
      objectId: input.objectId,
      payloadBytes,
      payloadHash,
      accessRevision,
      manifestBytes,
      manifestHash,
      namespaceId: envelope.context.namespaceId,
      envelopeBytes,
      envelopeHash,
      bindingRevisionAtWrap: envelope.context.bindingRevisionAtWrap,
    });
  } finally {
    destroyVerifiedStoredObjectAccessManifestChainV5(verifiedChain);
  }
}

function exactMatchesDurable(
  exact: ExactPublication,
  durable: DurablePublication,
): boolean {
  return durable.accessRevision === 0
    && durable.objectId === exact.objectId
    && durable.namespaceId === exact.authority.namespaceId
    && durable.bindingRevisionAtWrap === exact.authority.expectedAccessRevision
    && equalBytes(durable.payloadBytes, exact.payloadBytes)
    && equalBytes(durable.payloadHash, exact.payloadHash)
    && equalBytes(durable.manifestBytes, exact.manifestBytes)
    && equalBytes(durable.manifestHash, exact.manifestHash)
    && equalBytes(durable.envelopeBytes, exact.envelopeBytes)
    && equalBytes(durable.envelopeHash, exact.envelopeHash);
}

async function insertExact(
  executor: CryptoPostgresExecutor,
  exact: ExactPublication,
): Promise<void> {
  await executeTypedCryptoQuery(executor, cryptoTypedDb.insert(cryptoObjects).values({
    objectId: exact.objectId,
    payloadHash: exact.payloadHash,
    payloadBytes: exact.payloadBytes,
  }));
  await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.insert(objectCryptoAccessManifests).values({
      objectId: exact.objectId,
      accessRevision: 0,
      manifestHash: exact.manifestHash,
      previousManifestHash: null,
      payloadHash: exact.payloadHash,
      manifestBytes: exact.manifestBytes,
    }),
  );
  await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.insert(objectCryptoNamespaceEnvelopes).values({
      objectId: exact.objectId,
      accessRevision: 0,
      namespaceId: exact.authority.namespaceId,
      ordinal: 0,
      envelopeHash: exact.envelopeHash,
      envelopeBytes: exact.envelopeBytes,
    }),
  );
  await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.insert(objectCryptoAccessHeads).values({
      objectId: exact.objectId,
      accessRevision: 0,
      manifestHash: exact.manifestHash,
    }),
  );
}

function assertReference(reference: TaskContentCryptoRevisionReferenceV1): void {
  const expectedObjectId = deriveTaskContentCryptoObjectIdV1(reference.coordinate);
  if (
    reference.objectId !== expectedObjectId
    || reference.objectType !== taskContentObjectTypeV1(reference.coordinate)
    || !Number.isSafeInteger(reference.expectedAccessRevision)
    || reference.expectedAccessRevision < 0
    || !(reference.expectedAuthorityFingerprint instanceof Uint8Array)
    || reference.expectedAuthorityFingerprint.length !== 32
  ) throw new TypeError("Task crypto revision reference is invalid");
}

async function verifyReference(
  input: Dependencies,
  reference: TaskContentCryptoRevisionReferenceV1,
): Promise<VerifiedTaskContentCryptoRevisionV1 | null> {
  assertReference(reference);
  const authority = await input.resolveCurrentAuthority(reference.coordinate);
  if (
    authority === null
    || !equalBytes(
      fingerprintTaskContentAuthorityV1(authority),
      reference.expectedAuthorityFingerprint,
    )
  ) return null;
  const durable = await withVerifiedCryptoPostgresTransaction(
    input.handle,
    (executor) => readDurablePublication({
      executor,
      crypto: input.crypto,
      objectId: reference.objectId,
      resolveHistoricalAgentSignerAuthority:
        input.resolveHistoricalAgentSignerAuthority,
      resolveHistoricalHumanDeviceSigningPublicKey:
        input.resolveHistoricalHumanDeviceSigningPublicKey,
    }),
  );
  if (durable === null) return null;
  const payload = decodeEncryptedPayloadV2(durable.payloadBytes);
  if (
    durable.accessRevision !== reference.expectedAccessRevision
    || durable.namespaceId !== authority.namespaceId
    || durable.bindingRevisionAtWrap !== authority.expectedAccessRevision
    || payload.context.objectId !== reference.objectId
    || payload.context.objectType !== reference.objectType
    || payload.context.keyClass !== "ai"
  ) conflict("Task crypto state conflicts with its coordinate or authority");
  return Object.freeze({
    coordinate: reference.coordinate,
    objectId: reference.objectId,
    objectType: reference.objectType,
    payloadVersion: TASK_CONTENT_PAYLOAD_VERSION_V1,
    namespaceId: authority.namespaceId,
    authorityFingerprint: reference.expectedAuthorityFingerprint.slice(),
  });
}

export function createPostgresTaskContentCryptoCompletion(
  input: Dependencies,
): AtomicTaskContentCryptoCompletionPort {
  assertVerifiedCryptoPostgresHandle(input.handle);
  if (
    typeof input.resolveCurrentAuthority !== "function"
    || typeof input.resolveHistoricalAgentSignerAuthority !== "function"
    || typeof input.resolveHistoricalHumanDeviceSigningPublicKey !== "function"
  ) throw new TypeError("Task crypto completion resolvers are required");
  return Object.freeze({
    async complete(
      revision: PreparedTaskContentCryptoRevisionV1,
    ): Promise<"created" | "duplicate"> {
      const exact = exactPublication(input.crypto, revision);
      return withVerifiedCryptoPostgresTransaction(
        input.handle,
        async (executor) => {
          await executor.query(
            `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
            [exact.objectId],
          );
          const durable = await readDurablePublication({
            executor,
            crypto: input.crypto,
            objectId: exact.objectId,
            resolveHistoricalAgentSignerAuthority:
              input.resolveHistoricalAgentSignerAuthority,
            resolveHistoricalHumanDeviceSigningPublicKey:
              input.resolveHistoricalHumanDeviceSigningPublicKey,
          });
          if (durable !== null) {
            if (!exactMatchesDurable(exact, durable)) {
              conflict("Task crypto completion conflicts with durable bytes");
            }
            return "duplicate";
          }
          const currentAuthority = await input.resolveCurrentAuthority(
            exact.coordinate,
          );
          if (
            currentAuthority === null
            || !authorityMatches(currentAuthority, exact.authority)
            || !equalBytes(
              fingerprintTaskContentAuthorityV1(currentAuthority),
              exact.authorityFingerprint,
            )
          ) conflict("Task crypto completion authority is stale");
          await insertExact(executor, exact);
          const inserted = await readDurablePublication({
            executor,
            crypto: input.crypto,
            objectId: exact.objectId,
            resolveHistoricalAgentSignerAuthority:
              input.resolveHistoricalAgentSignerAuthority,
            resolveHistoricalHumanDeviceSigningPublicKey:
              input.resolveHistoricalHumanDeviceSigningPublicKey,
          });
          if (inserted === null || !exactMatchesDurable(exact, inserted)) {
            conflict("Task crypto completion did not persist exact bytes");
          }
          return "created";
        },
      );
    },
    verify(reference: TaskContentCryptoRevisionReferenceV1) {
      return verifyReference(input, reference);
    },
  });
}
