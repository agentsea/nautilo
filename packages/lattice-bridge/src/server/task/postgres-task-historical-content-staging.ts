import {
  and,
  cryptoObjects,
  eq,
  objectCryptoNamespaceEnvelopes,
  or,
  sql,
  taskHistoricalContentCryptoStagingReceipts,
} from "@nautilo/db";
import type {
  HumanExistingTaskRepresentationPublicationRequest,
  LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeHumanExistingTaskRepresentationPublicationRequestV1,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
  encodeHumanExistingTaskRepresentationPublicationRequestV1,
} from "@nautilo/lattice-crypto/wire";

import type { TaskContentAuthorityV1 } from
  "../../task/task-content-authority-v1.ts";
import { deriveTaskHistoricalContentCryptoObjectIdV1 } from
  "../../task/task-historical-content-identity.ts";
import { preparedTaskHistoricalRepairProvenanceV1, parseTaskHistoricalRepairProvenanceV1,
  type TaskHistoricalRepairProvenanceV1 } from
  "../../task/task-historical-repair-provenance.ts";
import {
  authenticatePreparedHistoricalTaskContentCryptoRevisionV1,
  readPreparedHistoricalTaskContentRequestV1,
  readPreparedTaskContentCryptoRevisionSnapshotV1,
} from "../../task/task-content-prepared-revision.ts";
import {
  fingerprintTaskContentAuthorityIdentityV1,
  fingerprintTaskContentAuthorityV1,
  sameTaskContentCoordinateV1,
  taskContentObjectTypeV1,
  type PreparedTaskContentCryptoRevisionV1,
  type TaskContentCoordinateV1,
} from "../../task/task-content-repository.ts";
import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  withVerifiedCryptoPostgresTransaction,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import type { DatabaseRow } from "../storage/postgres-record-codecs.ts";
import {
  createPostgresTaskContentCryptoCompletion,
  readDurableTaskContentPublication,
  TaskContentCryptoCompletionConflictError,
} from "./postgres-task-content-crypto-completion.ts";
import { ClassifiedDataOperationError } from
  "../../transition/encryption-data-operation-owner.ts";

const receipts = taskHistoricalContentCryptoStagingReceipts;
type History = Pick<Parameters<typeof createPostgresTaskContentCryptoCompletion>[0],
  "resolveHistoricalAgentSignerAuthority"
  | "resolveHistoricalHumanDeviceSigningPublicKey"
>;

function conflict(message: string): never {
  throw new TaskContentCryptoCompletionConflictError(message);
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function bytes(row: DatabaseRow, key: string, length?: number): Uint8Array {
  const value = row[key];
  if (!(value instanceof Uint8Array) || length !== undefined && value.length !== length) {
    conflict(`Invalid historical staging ${key}`);
  }
  return Uint8Array.from(value);
}

function text(row: DatabaseRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    conflict(`Invalid historical staging ${key}`);
  }
  return value;
}

function copyAuthority(authority: TaskContentAuthorityV1): TaskContentAuthorityV1 {
  // The fingerprint helper is also the canonical closed-shape validator.
  fingerprintTaskContentAuthorityV1(authority);
  return Object.freeze({ ...authority });
}

function exactAuthority(
  left: TaskContentAuthorityV1,
  right: TaskContentAuthorityV1,
): boolean {
  return equal(
    fingerprintTaskContentAuthorityV1(left),
    fingerprintTaskContentAuthorityV1(right),
  );
}

function coordinateFromRequest(
  request: HumanExistingTaskRepresentationPublicationRequest,
): TaskContentCoordinateV1 {
  return request.kind === "definition"
    ? Object.freeze({
        kind: "definition" as const,
        taskId: request.taskId,
        contentRevision: 1,
      })
    : Object.freeze({
        kind: "run_result" as const,
        taskId: request.taskId,
        taskRunId: request.entityId,
        contentRevision: 1,
      });
}

function historicalAuthority(
  current: TaskContentAuthorityV1,
  request: HumanExistingTaskRepresentationPublicationRequest,
): TaskContentAuthorityV1 {
  return Object.freeze({
    ...current,
    expectedAccessRevision: request.expectedNamespaceAccessRevision,
    expectedPolicyRevision: request.expectedPolicyRevision,
  });
}

function compatibleCurrentAuthority(
  current: TaskContentAuthorityV1,
  request: HumanExistingTaskRepresentationPublicationRequest,
): boolean {
  return current.requesterHumanId === request.subjectHumanId
    && current.namespaceId === request.namespaceId
    && current.domainId === request.domainId
    && current.expectedAccessRevision >= request.expectedNamespaceAccessRevision
    && current.expectedPolicyRevision >= request.expectedPolicyRevision
    && equal(
      fingerprintTaskContentAuthorityIdentityV1(current),
      fingerprintTaskContentAuthorityIdentityV1(historicalAuthority(current, request)),
    );
}

async function receiptRows(
  handle: CryptoPostgresHandle,
  input: Readonly<{ objectId: string; operationId: string }>,
) {
  return executeTypedCryptoQuery(handle, cryptoTypedDb.select().from(receipts)
    .where(or(
      eq(receipts.cryptoObjectId, input.objectId),
      eq(receipts.operationId, input.operationId),
    )).limit(2));
}

async function objectExists(
  handle: CryptoPostgresHandle,
  objectId: string,
): Promise<boolean> {
  return (await executeTypedCryptoQuery(handle, cryptoTypedDb.select({
    object_id: cryptoObjects.objectId,
  }).from(cryptoObjects).where(eq(cryptoObjects.objectId, objectId)).limit(1)))
    .length !== 0;
}

async function readGenesisEnvelope(
  handle: CryptoPostgresHandle,
  objectId: string,
): Promise<Readonly<{ bytes: Uint8Array; hash: Uint8Array }> | null> {
  const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({
    envelope_bytes: objectCryptoNamespaceEnvelopes.envelopeBytes,
    envelope_hash: objectCryptoNamespaceEnvelopes.envelopeHash,
  }).from(objectCryptoNamespaceEnvelopes).where(and(
    eq(objectCryptoNamespaceEnvelopes.objectId, objectId),
    eq(objectCryptoNamespaceEnvelopes.accessRevision, 0),
  )).limit(2));
  if (rows.length > 1) conflict("Historical staging genesis envelope is not unique");
  return rows[0] === undefined ? null : Object.freeze({
    bytes: bytes(rows[0], "envelope_bytes"),
    hash: bytes(rows[0], "envelope_hash", 32),
  });
}

export type HistoricalTaskContentStagingExpectedSource = Readonly<{
  coordinate: TaskContentCoordinateV1;
  operationId: string;
  sourceDigest: Uint8Array;
  sourcePayloadHash: Uint8Array;
  operationalFieldsDigest: Uint8Array;
  requesterHumanId: string;
  namespaceId: string;
}>;

export type VerifiedStagedHistoricalTaskContentPublication = Readonly<{
  prepared: PreparedTaskContentCryptoRevisionV1;
  signedRequestDigest: Uint8Array;
  genesisManifestHash: Uint8Array;
  authorityFingerprint: Uint8Array;
  originalAuthority: TaskContentAuthorityV1;
}>;

// Only this inspector records an authenticated durable head. The number is never
// accepted from a publication request or exported token field.
const inspectedHistoricalHeads = new WeakMap<PreparedTaskContentCryptoRevisionV1, Readonly<{
  accessRevision: number;
  currentAuthorityFingerprint: Uint8Array;
  provenance: TaskHistoricalRepairProvenanceV1;
}>>();

export function readInspectedHistoricalTaskContentAccessRevision(
  prepared: PreparedTaskContentCryptoRevisionV1,
  expected: Readonly<{
    coordinate: TaskContentCoordinateV1;
    objectId: string;
    currentAuthority: TaskContentAuthorityV1;
    provenance: TaskHistoricalRepairProvenanceV1;
  }>,
): number | null {
  const snapshot = readPreparedTaskContentCryptoRevisionSnapshotV1(prepared);
  const actual = preparedTaskHistoricalRepairProvenanceV1(prepared);
  const provenance = parseTaskHistoricalRepairProvenanceV1(expected.provenance);
  const sameProvenance = (left: TaskHistoricalRepairProvenanceV1, right: TaskHistoricalRepairProvenanceV1) =>
    Object.keys(left).length === Object.keys(right).length
    && Object.entries(left).every(([key, value]) => Reflect.get(right, key) === value);
  if (actual.version !== 2 || provenance.version !== 2
    || !sameProvenance(actual, provenance)
    || !sameTaskContentCoordinateV1(snapshot.coordinate, expected.coordinate)
    || snapshot.object.objectId !== expected.objectId
    || prepared.objectId !== expected.objectId
    || prepared.objectType !== taskContentObjectTypeV1(snapshot.coordinate)
    || prepared.payloadVersion !== 1
    || !equal(prepared.authorityFingerprint, fingerprintTaskContentAuthorityV1(snapshot.authority))
    || prepared.namespaceId !== expected.currentAuthority.namespaceId) {
    conflict("Historical inspected head coordinates conflict");
  }
  const head = inspectedHistoricalHeads.get(prepared);
  // Existing authenticated, fresh genesis preparations retain their strict
  // revision-zero behavior; they cannot opt into a later durable head.
  if (head === undefined) return null;
  if (!sameProvenance(head.provenance, actual)
    || !equal(head.currentAuthorityFingerprint,
      fingerprintTaskContentAuthorityV1(expected.currentAuthority))) {
    conflict("Historical inspected head authority is stale");
  }
  return head.accessRevision;
}

export type InspectStagedHistoricalTaskContentPublicationInput = History & Readonly<{
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  objectId: string;
  expected: HistoricalTaskContentStagingExpectedSource;
  currentAuthority: TaskContentAuthorityV1;
  assertCurrent(): void | Promise<void>;
}>;

/** Recover authentic prepared custody from immutable public crypto and receipt bytes. */
export async function inspectStagedHistoricalTaskContentPublication(
  input: InspectStagedHistoricalTaskContentPublicationInput,
): Promise<VerifiedStagedHistoricalTaskContentPublication | null> {
  assertVerifiedCryptoPostgresHandle(input.handle);
  const currentAuthority = copyAuthority(input.currentAuthority);
  const expected = Object.freeze({
    ...input.expected,
    coordinate: Object.freeze({ ...input.expected.coordinate }),
    sourceDigest: Uint8Array.from(input.expected.sourceDigest),
    sourcePayloadHash: Uint8Array.from(input.expected.sourcePayloadHash),
    operationalFieldsDigest: Uint8Array.from(input.expected.operationalFieldsDigest),
  });
  if (expected.sourceDigest.length !== 32
    || expected.sourcePayloadHash.length !== 32
    || expected.operationalFieldsDigest.length !== 32
    || expected.requesterHumanId !== currentAuthority.requesterHumanId
    || expected.namespaceId !== currentAuthority.namespaceId
    || input.objectId !== deriveTaskHistoricalContentCryptoObjectIdV1({
      coordinate: expected.coordinate,
      sourceDigest: expected.sourceDigest,
      namespaceId: expected.namespaceId,
    })) conflict("Historical staging expected source is invalid");
  await input.assertCurrent();
  return withVerifiedCryptoPostgresTransaction(input.handle, async transaction => {
    await input.assertCurrent();
    const rows = await receiptRows(transaction, {
      objectId: input.objectId,
      operationId: expected.operationId,
    });
    if (rows.length === 0) {
      if (await objectExists(transaction, input.objectId)) {
        conflict("Historical ciphertext has no staging receipt");
      }
      return null;
    }
    if (rows.length !== 1) conflict("Historical staging receipt conflicts");
    const row = rows[0]!;
    if (text(row, "crypto_object_id") !== input.objectId
      || text(row, "operation_id") !== expected.operationId) {
      conflict("Historical staging receipt coordinates conflict");
    }
    const signedBytes = bytes(row, "signed_publication_request_bytes");
    const signedRequestDigest = bytes(row, "signed_request_digest", 32);
    const receiptAuthorityFingerprint = bytes(row, "authority_fingerprint", 32);
    const receiptGenesisManifestHash = bytes(row, "genesis_manifest_hash", 32);
    const request = decodeHumanExistingTaskRepresentationPublicationRequestV1(signedBytes);
    const coordinate = coordinateFromRequest(request);
    if (!sameTaskContentCoordinateV1(coordinate, expected.coordinate)
      || request.operationId !== expected.operationId
      || !equal(request.sourceDigest, expected.sourceDigest)
      || !equal(request.sourcePayloadHash, expected.sourcePayloadHash)
      || !equal(request.operationalFieldsDigest, expected.operationalFieldsDigest)
      || request.subjectHumanId !== expected.requesterHumanId
      || request.namespaceId !== expected.namespaceId
      || request.cryptoObjectId !== input.objectId
      || !compatibleCurrentAuthority(currentAuthority, request)
      || !equal(input.crypto.hash(signedBytes), signedRequestDigest)) {
      conflict("Historical staging signed source conflicts");
    }
    const originalAuthority = historicalAuthority(currentAuthority, request);
    if (!equal(
      fingerprintTaskContentAuthorityV1(originalAuthority),
      receiptAuthorityFingerprint,
    )) conflict("Historical staging authority conflicts");
    const durable = await readDurableTaskContentPublication({
      ...input,
      executor: transaction,
      objectId: input.objectId,
    });
    const genesisEnvelope = await readGenesisEnvelope(transaction, input.objectId);
    if (durable === null || genesisEnvelope === null) {
      conflict("Historical staging crypto publication is incomplete");
    }
    const payload = decodeEncryptedPayloadV2(durable.payloadBytes);
    const genesis = decodeObjectAccessManifestV5(durable.genesisManifestBytes);
    const envelope = decodeNamespaceObjectEnvelopeV2(genesisEnvelope.bytes);
    if (!equal(durable.payloadHash, request.payloadHash)
      || !equal(durable.genesisManifestHash, receiptGenesisManifestHash)
      || !equal(durable.genesisManifestHash, request.manifestHash)
      || !equal(genesisEnvelope.hash, request.envelopeHash)
      || durable.objectId !== input.objectId
      || durable.namespaceId !== currentAuthority.namespaceId
      || payload.context.objectId !== input.objectId
      || payload.context.objectType !== taskContentObjectTypeV1(coordinate)
      || payload.context.keyClass !== "ai"
      || genesis.objectId !== input.objectId
      || genesis.accessRevision !== 0
      || genesis.signer.kind !== "human_device"
      || genesis.signer.subjectHumanId !== expected.requesterHumanId
      || genesis.signer.committerDeviceId !== request.committerDeviceId
      || genesis.hostAuthorizationRevision !== request.hostAuthorizationRevision
      || envelope.context.objectId !== input.objectId
      || envelope.context.namespaceId !== expected.namespaceId
      || envelope.context.bindingRevisionAtWrap
        !== request.expectedNamespaceAccessRevision) {
      conflict("Historical staging durable publication conflicts");
    }
    if (durable.bindingRevisionAtWrap !== currentAuthority.expectedAccessRevision) {
      if (currentAuthority.expectedAccessRevision
          > request.expectedNamespaceAccessRevision
        && durable.bindingRevisionAtWrap
          >= request.expectedNamespaceAccessRevision
        && durable.bindingRevisionAtWrap
          < currentAuthority.expectedAccessRevision) {
        throw new ClassifiedDataOperationError(
          "key_waiting",
          "Historical staging ciphertext awaits the current Namespace rewrap",
        );
      }
      conflict("Historical staging durable publication authority conflicts");
    }
    const prepared = await authenticatePreparedHistoricalTaskContentCryptoRevisionV1({
      crypto: input.crypto,
      now: request.issuedAt,
      operationId: request.operationId,
      claimId: request.claimId,
      coordinate,
      authority: originalAuthority,
      sourceDigest: request.sourceDigest,
      sourcePayloadHash: request.sourcePayloadHash,
      planDigest: request.planDigest,
      operationalFieldsDigest: request.operationalFieldsDigest,
      payloadBytes: Uint8Array.from(durable.payloadBytes),
      manifestBytes: Uint8Array.from(durable.genesisManifestBytes),
      envelopeBytes: genesisEnvelope.bytes,
      signedPublicationRequestBytes: signedBytes,
      expectedSignedRequestDigest: signedRequestDigest,
      resolveCurrentAuthority: async candidate => {
        if (candidate.committerDeviceId !== request.committerDeviceId
          || candidate.hostAuthorizationRevision !== request.hostAuthorizationRevision
          || candidate.subjectHumanId !== request.subjectHumanId) return null;
        return input.resolveHistoricalHumanDeviceSigningPublicKey({
          subjectHumanId: candidate.subjectHumanId,
          committerDeviceId: candidate.committerDeviceId,
          hostAuthorizationRevision: candidate.hostAuthorizationRevision,
        });
      },
    });
    await input.assertCurrent();
    const provenance = preparedTaskHistoricalRepairProvenanceV1(prepared);
    if (provenance.version !== 2) conflict("Historical inspected head requires source-versioned provenance");
    inspectedHistoricalHeads.set(prepared, Object.freeze({
      accessRevision: durable.accessRevision,
      currentAuthorityFingerprint: fingerprintTaskContentAuthorityV1(currentAuthority),
      provenance,
    }));
    const token = Object.freeze({
      prepared,
      signedRequestDigest: Uint8Array.from(signedRequestDigest),
      genesisManifestHash: Uint8Array.from(receiptGenesisManifestHash),
      authorityFingerprint: Uint8Array.from(receiptAuthorityFingerprint),
      originalAuthority,
    });
    return token;
  });
}

export type StageHistoricalTaskContentPublicationInput = History & Readonly<{
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  prepared: PreparedTaskContentCryptoRevisionV1;
  currentAuthority: TaskContentAuthorityV1;
  assertCurrent(): void | Promise<void>;
}>;

/** Persist exact randomized historical crypto before any product reservation. */
export async function stageHistoricalTaskContentPublication(
  input: StageHistoricalTaskContentPublicationInput,
): Promise<"staged" | "already_staged"> {
  assertVerifiedCryptoPostgresHandle(input.handle);
  const currentAuthority = copyAuthority(input.currentAuthority);
  const request = readPreparedHistoricalTaskContentRequestV1(input.prepared);
  const snapshot = readPreparedTaskContentCryptoRevisionSnapshotV1(input.prepared);
  const provenance = preparedTaskHistoricalRepairProvenanceV1(input.prepared);
  const signedBytes = encodeHumanExistingTaskRepresentationPublicationRequestV1(request);
  const coordinate = coordinateFromRequest(request);
  if (provenance.version !== 2
    || !sameTaskContentCoordinateV1(coordinate, input.prepared.coordinate)
    || request.cryptoObjectId !== input.prepared.objectId
    || request.cryptoObjectId !== deriveTaskHistoricalContentCryptoObjectIdV1({
      coordinate,
      sourceDigest: request.sourceDigest,
      namespaceId: request.namespaceId,
    })
    || request.manifestHash.length !== 32
    || provenance.genesisManifestHash !== Array.from(
      request.manifestHash,
      byte => byte.toString(16).padStart(2, "0"),
    ).join("")
    || !exactAuthority(currentAuthority, snapshot.authority)) {
    conflict("Historical staging preparation is invalid or stale");
  }
  const assertLive = async () => {
    readPreparedHistoricalTaskContentRequestV1(input.prepared);
    readPreparedTaskContentCryptoRevisionSnapshotV1(input.prepared);
    await input.assertCurrent();
    readPreparedHistoricalTaskContentRequestV1(input.prepared);
  };
  await assertLive();
  return withVerifiedCryptoPostgresTransaction(input.handle, async transaction => {
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [input.prepared.objectId],
    );
    await assertLive();
    const existing = await inspectStagedHistoricalTaskContentPublication({
      ...input,
      handle: transaction,
      objectId: input.prepared.objectId,
      expected: {
        coordinate,
        operationId: request.operationId,
        sourceDigest: request.sourceDigest,
        sourcePayloadHash: request.sourcePayloadHash,
        operationalFieldsDigest: request.operationalFieldsDigest,
        requesterHumanId: request.subjectHumanId,
        namespaceId: request.namespaceId,
      },
      currentAuthority,
    });
    if (existing !== null) {
      if (!equal(existing.signedRequestDigest, input.crypto.hash(signedBytes))) {
        conflict("Historical staging is already owned by different prepared bytes");
      }
      await assertLive();
      return "already_staged";
    }
    if (await objectExists(transaction, input.prepared.objectId)) {
      conflict("Historical ciphertext has no staging receipt");
    }
    const completion = createPostgresTaskContentCryptoCompletion({
      ...input,
      handle: transaction,
      resolveCurrentAuthority: candidate => Promise.resolve(
        sameTaskContentCoordinateV1(candidate, coordinate)
          ? currentAuthority
          : null,
      ),
    });
    if (await completion.complete(input.prepared) !== "created") {
      conflict("Historical ciphertext appeared without a receipt");
    }
    await executeTypedCryptoQuery(transaction, cryptoTypedDb.insert(receipts).values({
      cryptoObjectId: input.prepared.objectId,
      operationId: request.operationId,
      signedPublicationRequestBytes: Uint8Array.from(signedBytes),
      signedRequestDigest: input.crypto.hash(signedBytes),
      authorityFingerprint: fingerprintTaskContentAuthorityV1(snapshot.authority),
      genesisManifestHash: Uint8Array.from(request.manifestHash),
      stagedAt: sql`clock_timestamp()`,
    }));
    await assertLive();
    return "staged";
  });
}
