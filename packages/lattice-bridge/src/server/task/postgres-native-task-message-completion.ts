import { bytesToHex } from "@noble/hashes/utils.js";
import {
  cryptoObjects, eq, objectCryptoAccessHeads, objectCryptoAccessManifests,
  objectCryptoNamespaceEnvelopes,
} from "@nautilo/db";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  decodeAgentRuntimeSignerPublicationV1, decodeEncryptedPayloadV2, decodeNamespaceObjectEnvelopeV2, decodeObjectAccessManifestV5,
} from "@nautilo/lattice-crypto/wire";
import { CONVERSATION_MESSAGE_OBJECT_TYPE, deriveMessageCryptoObjectIdV2 } from "../../message/conversation-repository.ts";
import type { ResolveHistoricalAgentRuntimeSignerManagerAuthority } from "../storage/agent-runtime-signer-history.ts";
import {
  assertVerifiedCryptoPostgresHandle, cryptoTypedDb, executeTypedCryptoQuery, withVerifiedCryptoPostgresTransaction,
  type CryptoPostgresExecutor, type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import {
  destroyVerifiedStoredObjectAccessManifestChainV5, verifyStoredObjectAccessManifestChainV5,
} from "../storage/postgres-object-access-manifest-v5.ts";
import type { DatabaseRow } from "../storage/postgres-record-codecs.ts";
import {
  readPreparedNativeTaskMessage, type NativeTaskMessageAuthority,
  type NativeTaskMessageSnapshot, type PreparedNativeTaskMessage,
} from "./native-task-message-preparation.ts";

export class NativeTaskMessageCryptoCompletionConflictError extends Error {
  readonly code = "native_task_message_crypto_completion_conflict" as const;
  constructor(message: string) { super(message); this.name = "NativeTaskMessageCryptoCompletionConflictError"; }
}

export type NativeTaskMessageCryptoCompletionPort = Readonly<{
  /** Stores only opaque crypto bytes. Does not allocate, publish, map or expose a product Message. */
  complete(prepared: PreparedNativeTaskMessage): Promise<"created" | "duplicate">;
}>;

export type NativeTaskMessageCryptoCompletionDependencies = Readonly<{
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  /**
   * Reprove the exact live Task/Run/grant, Message/Session/Room audience,
   * policy, Domain/Namespace and Runtime signer projection on every call.
   * These checks cannot atomically fence a different product connection.
   * A future product publisher must hold its own current authority fence and
   * verify these durable bytes before mapping them. Success here is never
   * product-publication authority; orphan ciphertext is intentionally safe.
   */
  resolveCurrentAuthority(expected: NativeTaskMessageAuthority): Promise<NativeTaskMessageAuthority | null>;
  resolveHistoricalAgentSignerAuthority: ResolveHistoricalAgentRuntimeSignerManagerAuthority;
}>;

/** @internal Shared only with terminal Message crypto staging. */
export type NativeTaskMessageOpaqueAuthority = Readonly<{
  sessionId: string;
  messageId: number;
  revision: number;
  objectId: string;
  namespaceId: string;
  namespaceAccessRevision: number;
  namespaceKeyGeneration: number;
  createdAt: number;
  signerAgentId: string;
  runtimeGeneration: number;
  agentAuthorizationRevision: number;
  signerKeyId: string;
  signerAuthorizationHash?: string;
  signerHostAuthorizationRevision?: number;
}>;

/** @internal Product-reconstructable coordinates for durable inspection. */
export type NativeTaskMessageOpaqueInspectionAuthority = Readonly<{
  sessionId: string;
  messageId: number;
  revision: number;
  objectId: string;
  namespaceId: string;
  namespaceAccessRevision: number;
  createdAt: number;
  signerAgentId: string;
}>;

/** @internal Opaque V5 bytes; no product or grant authority is conveyed. */
export type NativeTaskMessageOpaqueSnapshot = Readonly<{
  authority: NativeTaskMessageOpaqueAuthority;
  object: NativeTaskMessageSnapshot["object"];
  manifestBytes: Uint8Array;
  manifestHash: Uint8Array;
  envelopeBytes: readonly [Uint8Array];
  signerEvidenceBytes?: Uint8Array;
}>;

type Exact = NativeTaskMessageOpaqueSnapshot & Readonly<{
  payloadHash: Uint8Array;
  envelopeHash: Uint8Array;
}>;

function conflict(message: string): never { throw new NativeTaskMessageCryptoCompletionConflictError(message); }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
function sameAuthority(left: NativeTaskMessageAuthority, right: NativeTaskMessageAuthority): boolean {
  const fields = Object.keys(left) as (keyof NativeTaskMessageAuthority)[];
  return Object.keys(right).length === fields.length && fields.every((field) => left[field] === right[field]);
}
function rowBytesEqual(row: DatabaseRow, key: string, expected: Uint8Array): boolean {
  const value = row[key]; return value instanceof Uint8Array && sameBytes(value, expected);
}
function rowCounter(row: DatabaseRow, key: string): number {
  const raw = row[key];
  const value = typeof raw === "bigint" ? Number(raw)
    : typeof raw === "string" && /^(0|[1-9][0-9]*)$/u.test(raw) ? Number(raw) : raw;
  if (!Number.isSafeInteger(value) || (value as number) < 0) conflict(`Task Message ${key} is invalid`);
  return value as number;
}
function destroyExact(value: Exact): void {
  value.object.payloadBytes.ciphertext.fill(0); value.manifestBytes.fill(0); value.manifestHash.fill(0);
  value.signerEvidenceBytes?.fill(0);
  value.envelopeBytes[0].fill(0); value.payloadHash.fill(0); value.envelopeHash.fill(0);
}

function exactPublication(crypto: LatticeCrypto, snapshot: NativeTaskMessageOpaqueSnapshot): Exact {
  const exact: Exact = {
    authority: Object.freeze({ ...snapshot.authority }),
    object: snapshot.object,
    manifestBytes: snapshot.manifestBytes.slice(),
    manifestHash: snapshot.manifestHash.slice(),
    ...(snapshot.signerEvidenceBytes === undefined ? {} : { signerEvidenceBytes: snapshot.signerEvidenceBytes.slice() }),
    envelopeBytes: Object.freeze([snapshot.envelopeBytes[0].slice()] as const),
    payloadHash: crypto.hash(snapshot.object.payloadBytes.ciphertext),
    envelopeHash: crypto.hash(snapshot.envelopeBytes[0]),
  };
  try {
    const { authority } = exact;
    const payload = decodeEncryptedPayloadV2(exact.object.payloadBytes.ciphertext);
    const envelope = decodeNamespaceObjectEnvelopeV2(exact.envelopeBytes[0]);
    const manifest = decodeObjectAccessManifestV5(exact.manifestBytes);
    if ((authority.signerAuthorizationHash === undefined)
        !== (authority.signerHostAuthorizationRevision === undefined)
      || authority.objectId !== deriveMessageCryptoObjectIdV2(authority)
      || exact.object.objectId !== authority.objectId || payload.context.objectId !== authority.objectId
      || payload.context.objectType !== CONVERSATION_MESSAGE_OBJECT_TYPE || payload.context.keyClass !== "ai"
      || payload.context.createdAt !== authority.createdAt
      || envelope.context.objectId !== authority.objectId || envelope.context.namespaceId !== authority.namespaceId
      || envelope.context.keyClass !== "ai" || envelope.context.keyGeneration !== authority.namespaceKeyGeneration
      || envelope.context.bindingRevisionAtWrap !== authority.namespaceAccessRevision
      || manifest.objectId !== authority.objectId || manifest.accessRevision !== 0 || manifest.previousManifestHash !== null
      || (authority.signerAuthorizationHash === undefined
        ? manifest.signerAuthorizationHash !== null || exact.signerEvidenceBytes !== undefined
        : manifest.signerAuthorizationHash === null || exact.signerEvidenceBytes === undefined
          || bytesToHex(manifest.signerAuthorizationHash) !== authority.signerAuthorizationHash
          || bytesToHex(crypto.hash(exact.signerEvidenceBytes)) !== authority.signerAuthorizationHash)
      || !sameBytes(manifest.payloadHash, exact.payloadHash)
      || manifest.envelopeHashes.length !== 1 || !sameBytes(manifest.envelopeHashes[0]!, exact.envelopeHash)
      || !sameBytes(crypto.hash(exact.manifestBytes), exact.manifestHash)
      || manifest.signer.kind !== "agent_runtime" || manifest.signer.agentId !== authority.signerAgentId
      || manifest.signer.runtimeGeneration !== authority.runtimeGeneration || manifest.signer.signerKeyId !== authority.signerKeyId
      || manifest.hostAuthorizationRevision !== (authority.signerHostAuthorizationRevision ?? authority.agentAuthorizationRevision)) {
      conflict("Prepared Task Message bytes disagree with their authority");
    }
    return exact;
  } catch (error) { destroyExact(exact); throw error; }
}

async function readAndVerifyExact(
  input: Pick<NativeTaskMessageCryptoCompletionDependencies,
    "crypto" | "resolveHistoricalAgentSignerAuthority">,
  executor: CryptoPostgresExecutor,
  exact: Exact,
): Promise<boolean> {
  const id = exact.authority.objectId;
  const objects = await executeTypedCryptoQuery(executor, cryptoTypedDb.select({
    object_id: cryptoObjects.objectId, payload_hash: cryptoObjects.payloadHash, payload_bytes: cryptoObjects.payloadBytes,
  }).from(cryptoObjects).where(eq(cryptoObjects.objectId, id)).limit(2));
  const heads = await executeTypedCryptoQuery(executor, cryptoTypedDb.select({
    object_id: objectCryptoAccessHeads.objectId, access_revision: objectCryptoAccessHeads.accessRevision,
    manifest_hash: objectCryptoAccessHeads.manifestHash,
  }).from(objectCryptoAccessHeads).where(eq(objectCryptoAccessHeads.objectId, id)).limit(2));
  const manifests = await executeTypedCryptoQuery(executor, cryptoTypedDb.select({
    object_id: objectCryptoAccessManifests.objectId, access_revision: objectCryptoAccessManifests.accessRevision,
    previous_manifest_hash: objectCryptoAccessManifests.previousManifestHash, payload_hash: objectCryptoAccessManifests.payloadHash,
    manifest_hash: objectCryptoAccessManifests.manifestHash, manifest_bytes: objectCryptoAccessManifests.manifestBytes,
    signer_evidence_bytes: objectCryptoAccessManifests.signerEvidenceBytes,
  }).from(objectCryptoAccessManifests).where(eq(objectCryptoAccessManifests.objectId, id)).limit(2));
  const envelopes = await executeTypedCryptoQuery(executor, cryptoTypedDb.select({
    object_id: objectCryptoNamespaceEnvelopes.objectId, access_revision: objectCryptoNamespaceEnvelopes.accessRevision,
    namespace_id: objectCryptoNamespaceEnvelopes.namespaceId, ordinal: objectCryptoNamespaceEnvelopes.ordinal,
    envelope_hash: objectCryptoNamespaceEnvelopes.envelopeHash, envelope_bytes: objectCryptoNamespaceEnvelopes.envelopeBytes,
  }).from(objectCryptoNamespaceEnvelopes).where(eq(objectCryptoNamespaceEnvelopes.objectId, id)).limit(2));
  if ([objects, heads, manifests, envelopes].every((rows) => rows.length === 0)) return false;
  if ([objects, heads, manifests, envelopes].some((rows) => rows.length !== 1)) {
    conflict("Task Message crypto state is partial or has an advanced access head");
  }
  const object = objects[0]!; const head = heads[0]!; const manifest = manifests[0]!; const envelope = envelopes[0]!;
  if ([object, head, manifest, envelope].some((row) => row["object_id"] !== id)
    || rowCounter(head, "access_revision") !== 0 || rowCounter(manifest, "access_revision") !== 0
    || rowCounter(envelope, "access_revision") !== 0 || rowCounter(envelope, "ordinal") !== 0
    || manifest["previous_manifest_hash"] !== null || envelope["namespace_id"] !== exact.authority.namespaceId
    || !rowBytesEqual(object, "payload_bytes", exact.object.payloadBytes.ciphertext)
    || !rowBytesEqual(object, "payload_hash", exact.payloadHash) || !rowBytesEqual(manifest, "payload_hash", exact.payloadHash)
    || !rowBytesEqual(head, "manifest_hash", exact.manifestHash) || !rowBytesEqual(manifest, "manifest_hash", exact.manifestHash)
    || !rowBytesEqual(manifest, "manifest_bytes", exact.manifestBytes)
    || (exact.signerEvidenceBytes === undefined
      ? manifest["signer_evidence_bytes"] != null
      : !rowBytesEqual(manifest, "signer_evidence_bytes", exact.signerEvidenceBytes))
    || !rowBytesEqual(envelope, "envelope_bytes", exact.envelopeBytes[0]) || !rowBytesEqual(envelope, "envelope_hash", exact.envelopeHash)) {
    conflict("Task Message crypto completion conflicts with durable bytes");
  }
  // No foreground signer override: native Task Messages use retained HIVE Runtime publication history.
  const verified = await verifyStoredObjectAccessManifestChainV5({
    executor, crypto: input.crypto, objectId: id, headAccessRevision: 0,
    expectedPayloadHash: exact.payloadHash, expectedHeadManifestHash: exact.manifestHash,
    resolveHistoricalAgentManagerAuthority: input.resolveHistoricalAgentSignerAuthority,
    resolveHistoricalHumanDeviceSigningPublicKey: () => Promise.resolve(null),
  });
  try {
    const signer = verified.headManifest.signer;
    if (exact.authority.signerAuthorizationHash === undefined) {
    const publications = verified.signerEvidence.filter((entry) => entry.kind === "agent_runtime_publication");
    if (publications.length !== 1) conflict("Task Message retained signer publication is not exact");
    const publication = decodeAgentRuntimeSignerPublicationV1(publications[0]!.evidenceBytes);
    if (publication.agentId !== exact.authority.signerAgentId
      || publication.runtimeGeneration !== exact.authority.runtimeGeneration
      || publication.authorizationRevision !== exact.authority.agentAuthorizationRevision
      || publication.signerKeyId !== exact.authority.signerKeyId) {
      conflict("Task Message retained signer publication disagrees with its authority");
    }
    } else if (verified.headManifest.signerAuthorizationHash === null
      || bytesToHex(verified.headManifest.signerAuthorizationHash) !== exact.authority.signerAuthorizationHash
      || verified.signerEvidence.filter(entry => entry.kind === "task_runtime_signer_certificate").length !== 1) {
      conflict("Task Message retained signer certificate is not exact");
    }
    if (signer.kind !== "agent_runtime" || signer.agentId !== exact.authority.signerAgentId
      || signer.runtimeGeneration !== exact.authority.runtimeGeneration || signer.signerKeyId !== exact.authority.signerKeyId
      || verified.headManifest.hostAuthorizationRevision !== (exact.authority.signerHostAuthorizationRevision ?? exact.authority.agentAuthorizationRevision)) {
      conflict("Task Message historical signer disagrees with its authority");
    }
    return true;
  } finally { destroyVerifiedStoredObjectAccessManifestChainV5(verified); }
}

async function insertExact(executor: CryptoPostgresExecutor, exact: Exact): Promise<void> {
  const objectId = exact.authority.objectId;
  await executeTypedCryptoQuery(executor, cryptoTypedDb.insert(cryptoObjects).values({
    objectId, payloadHash: exact.payloadHash, payloadBytes: exact.object.payloadBytes.ciphertext,
  }));
  await executeTypedCryptoQuery(executor, cryptoTypedDb.insert(objectCryptoAccessManifests).values({
    objectId, accessRevision: 0, manifestHash: exact.manifestHash, previousManifestHash: null,
    payloadHash: exact.payloadHash, manifestBytes: exact.manifestBytes,
    signerEvidenceBytes: exact.signerEvidenceBytes ?? null,
  }));
  await executeTypedCryptoQuery(executor, cryptoTypedDb.insert(objectCryptoNamespaceEnvelopes).values({
    objectId, accessRevision: 0, namespaceId: exact.authority.namespaceId, ordinal: 0,
    envelopeHash: exact.envelopeHash, envelopeBytes: exact.envelopeBytes[0],
  }));
  await executeTypedCryptoQuery(executor, cryptoTypedDb.insert(objectCryptoAccessHeads).values({
    objectId, accessRevision: 0, manifestHash: exact.manifestHash,
  }));
}

export type CompleteNativeTaskMessageOpaqueSnapshotInput = Readonly<{
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  snapshot: NativeTaskMessageOpaqueSnapshot;
  resolveHistoricalAgentSignerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority;
  /** Caller-specific authentic evidence and current authority fence. */
  assertCurrent(): void | Promise<void>;
}>;

export type InspectNativeTaskMessageOpaquePublicationInput = Readonly<{
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  authority: NativeTaskMessageOpaqueInspectionAuthority;
  expectedGenesisManifestHash: Uint8Array;
  resolveHistoricalAgentSignerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority;
}>;

/** @internal Verify immutable durable bytes without opening or decrypting them. */
export async function inspectNativeTaskMessageOpaquePublication(
  input: InspectNativeTaskMessageOpaquePublicationInput,
): Promise<boolean> {
  assertVerifiedCryptoPostgresHandle(input.handle);
  if (input.authority.objectId !== deriveMessageCryptoObjectIdV2(
    input.authority)) {
    conflict("Task Message durable coordinate is invalid");
  }
  return withVerifiedCryptoPostgresTransaction(input.handle, async executor => {
    const id = input.authority.objectId;
    const objects = await executeTypedCryptoQuery(executor, cryptoTypedDb.select({
      object_id: cryptoObjects.objectId,
      payload_hash: cryptoObjects.payloadHash,
      payload_bytes: cryptoObjects.payloadBytes,
    }).from(cryptoObjects).where(eq(cryptoObjects.objectId, id)).limit(2));
    const heads = await executeTypedCryptoQuery(executor, cryptoTypedDb.select({
      object_id: objectCryptoAccessHeads.objectId,
      access_revision: objectCryptoAccessHeads.accessRevision,
      manifest_hash: objectCryptoAccessHeads.manifestHash,
    }).from(objectCryptoAccessHeads).where(eq(objectCryptoAccessHeads.objectId, id)).limit(2));
    const manifests = await executeTypedCryptoQuery(executor, cryptoTypedDb.select({
      object_id: objectCryptoAccessManifests.objectId,
      access_revision: objectCryptoAccessManifests.accessRevision,
      previous_manifest_hash: objectCryptoAccessManifests.previousManifestHash,
      payload_hash: objectCryptoAccessManifests.payloadHash,
      manifest_hash: objectCryptoAccessManifests.manifestHash,
      manifest_bytes: objectCryptoAccessManifests.manifestBytes,
    }).from(objectCryptoAccessManifests).where(eq(
      objectCryptoAccessManifests.objectId, id)).limit(2));
    const envelopes = await executeTypedCryptoQuery(executor, cryptoTypedDb.select({
      object_id: objectCryptoNamespaceEnvelopes.objectId,
      access_revision: objectCryptoNamespaceEnvelopes.accessRevision,
      namespace_id: objectCryptoNamespaceEnvelopes.namespaceId,
      ordinal: objectCryptoNamespaceEnvelopes.ordinal,
      envelope_hash: objectCryptoNamespaceEnvelopes.envelopeHash,
      envelope_bytes: objectCryptoNamespaceEnvelopes.envelopeBytes,
    }).from(objectCryptoNamespaceEnvelopes).where(eq(
      objectCryptoNamespaceEnvelopes.objectId, id)).limit(2));
    if ([objects, heads, manifests, envelopes].every(rows => rows.length === 0)) {
      return false;
    }
    if ([objects, heads, manifests, envelopes].some(rows => rows.length !== 1)) {
      conflict("Task Message crypto state is partial or has an advanced access head");
    }
    const object = objects[0]!;
    const head = heads[0]!;
    const manifestRow = manifests[0]!;
    const envelopeRow = envelopes[0]!;
    const payloadBytes = object["payload_bytes"];
    const payloadHash = object["payload_hash"];
    const manifestBytes = manifestRow["manifest_bytes"];
    const envelopeBytes = envelopeRow["envelope_bytes"];
    if (!(payloadBytes instanceof Uint8Array) || !(payloadHash instanceof Uint8Array)
      || !(manifestBytes instanceof Uint8Array) || !(envelopeBytes instanceof Uint8Array)) {
      conflict("Task Message durable crypto bytes are malformed");
    }
    const calculatedPayloadHash = input.crypto.hash(payloadBytes);
    const calculatedEnvelopeHash = input.crypto.hash(envelopeBytes);
    const calculatedManifestHash = input.crypto.hash(manifestBytes);
    try {
      const payload = decodeEncryptedPayloadV2(payloadBytes);
      const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
      const manifest = decodeObjectAccessManifestV5(manifestBytes);
      if ([object, head, manifestRow, envelopeRow].some(row => row["object_id"] !== id)
        || rowCounter(head, "access_revision") !== 0
        || rowCounter(manifestRow, "access_revision") !== 0
        || rowCounter(envelopeRow, "access_revision") !== 0
        || rowCounter(envelopeRow, "ordinal") !== 0
        || manifestRow["previous_manifest_hash"] !== null
        || envelopeRow["namespace_id"] !== input.authority.namespaceId
        || !rowBytesEqual(object, "payload_hash", calculatedPayloadHash)
        || !rowBytesEqual(manifestRow, "payload_hash", calculatedPayloadHash)
        || !rowBytesEqual(envelopeRow, "envelope_hash", calculatedEnvelopeHash)
        || !rowBytesEqual(head, "manifest_hash", calculatedManifestHash)
        || !rowBytesEqual(manifestRow, "manifest_hash", calculatedManifestHash)
        || !sameBytes(calculatedManifestHash, input.expectedGenesisManifestHash)
        || payload.context.objectId !== id
        || payload.context.objectType !== CONVERSATION_MESSAGE_OBJECT_TYPE
        || payload.context.keyClass !== "ai"
        || payload.context.createdAt !== input.authority.createdAt
        || envelope.context.objectId !== id
        || envelope.context.namespaceId !== input.authority.namespaceId
        || envelope.context.keyClass !== "ai"
        || envelope.context.bindingRevisionAtWrap
          !== input.authority.namespaceAccessRevision
        || manifest.objectId !== id || manifest.accessRevision !== 0
        || manifest.previousManifestHash !== null
        || !sameBytes(manifest.payloadHash, calculatedPayloadHash)
        || manifest.envelopeHashes.length !== 1
        || !sameBytes(manifest.envelopeHashes[0]!, calculatedEnvelopeHash)
        || manifest.signer.kind !== "agent_runtime"
        || manifest.signer.agentId !== input.authority.signerAgentId) {
        conflict("Task Message durable publication conflicts with authority");
      }
      const verified = await verifyStoredObjectAccessManifestChainV5({
        executor,
        crypto: input.crypto,
        objectId: id,
        headAccessRevision: 0,
        expectedPayloadHash: calculatedPayloadHash,
        expectedHeadManifestHash: calculatedManifestHash,
        resolveHistoricalAgentManagerAuthority:
          input.resolveHistoricalAgentSignerAuthority,
        resolveHistoricalHumanDeviceSigningPublicKey: () => Promise.resolve(null),
      });
      try {
        if (manifest.signerAuthorizationHash === null) {
        const publications = verified.signerEvidence.filter(entry =>
          entry.kind === "agent_runtime_publication");
        if (publications.length !== 1) {
          conflict("Task Message retained signer publication is not exact");
        }
        const publication = decodeAgentRuntimeSignerPublicationV1(
          publications[0]!.evidenceBytes);
        if (publication.agentId !== input.authority.signerAgentId
          || publication.runtimeGeneration !== manifest.signer.runtimeGeneration
          || publication.authorizationRevision
            !== manifest.hostAuthorizationRevision
          || publication.signerKeyId !== manifest.signer.signerKeyId) {
          conflict("Task Message retained signer publication disagrees");
        }
        } else if (verified.signerEvidence.filter(entry => entry.kind === "task_runtime_signer_certificate").length !== 1) {
          conflict("Task Message retained signer certificate is not exact");
        }
      } finally {
        destroyVerifiedStoredObjectAccessManifestChainV5(verified);
      }
      return true;
    } finally {
      calculatedPayloadHash.fill(0);
      calculatedEnvelopeHash.fill(0);
      calculatedManifestHash.fill(0);
    }
  });
}

/**
 * @internal Persist one already authenticated opaque snapshot. Passing a
 * transaction-scoped handle keeps these writes in the caller's transaction.
 * This helper does not accept or mint a prepared product/grant token.
 */
export async function completeNativeTaskMessageOpaqueSnapshot(
  input: CompleteNativeTaskMessageOpaqueSnapshotInput,
): Promise<"created" | "duplicate"> {
  assertVerifiedCryptoPostgresHandle(input.handle);
  if (typeof input.resolveHistoricalAgentSignerAuthority !== "function"
    || typeof input.assertCurrent !== "function") {
    throw new TypeError("Native Task Message opaque completion authorities are required");
  }
  const exact = exactPublication(input.crypto, input.snapshot);
  try {
    return await withVerifiedCryptoPostgresTransaction(input.handle, async executor => {
      await executor.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
        [exact.authority.objectId],
      );
      await input.assertCurrent();
      const exists = await readAndVerifyExact(input, executor, exact);
      if (!exists) {
        await insertExact(executor, exact);
        if (!await readAndVerifyExact(input, executor, exact)) {
          conflict("Task Message completion failed durable readback");
        }
      }
      await input.assertCurrent();
      return exists ? "duplicate" : "created";
    });
  } finally {
    destroyExact(exact);
  }
}

/**
 * Dark genesis-only crypto storage port. Its transaction is confined to the
 * crypto role; it neither substitutes for a product publication fence nor
 * authorizes Message allocation/mapping. Advanced heads require the distinct
 * historical-read/rewrap path and are never rolled back or overwritten here.
 */
export function createPostgresNativeTaskMessageCryptoCompletion(
  input: NativeTaskMessageCryptoCompletionDependencies,
): NativeTaskMessageCryptoCompletionPort {
  assertVerifiedCryptoPostgresHandle(input.handle);
  if (typeof input.resolveCurrentAuthority !== "function" || typeof input.resolveHistoricalAgentSignerAuthority !== "function") {
    throw new TypeError("Native Task Message completion authority resolvers are required");
  }
  const dependencies = Object.freeze({ ...input });
  return Object.freeze({ async complete(prepared: PreparedNativeTaskMessage): Promise<"created" | "duplicate"> {
    const snapshot = readPreparedNativeTaskMessage(prepared);
    const opaque: NativeTaskMessageOpaqueSnapshot = Object.freeze({
      ...snapshot,
      authority: Object.freeze({
        sessionId: snapshot.authority.sessionId,
        messageId: snapshot.authority.messageId,
        revision: snapshot.authority.revision,
        objectId: snapshot.authority.objectId,
        namespaceId: snapshot.authority.namespaceId,
        namespaceAccessRevision: snapshot.authority.namespaceAccessRevision,
        namespaceKeyGeneration: snapshot.authority.namespaceKeyGeneration,
        createdAt: snapshot.authority.createdAt,
        signerAgentId: snapshot.authority.agentId,
        runtimeGeneration: snapshot.authority.runtimeGeneration,
        agentAuthorizationRevision:
          snapshot.authority.agentAuthorizationRevision,
        signerKeyId: snapshot.authority.signerKeyId,
        ...(snapshot.authority.signerAuthorizationHash === undefined ? {} : {
          signerAuthorizationHash: snapshot.authority.signerAuthorizationHash,
          signerHostAuthorizationRevision: snapshot.authority.hostAuthorizationRevision,
        }),
      }),
    });
    const check = async (): Promise<void> => {
      const current = await dependencies.resolveCurrentAuthority(snapshot.authority);
      if (current === null || !sameAuthority(snapshot.authority, current)) {
        conflict("Task Message completion authority is stale");
      }
    };
    return completeNativeTaskMessageOpaqueSnapshot({
      handle: dependencies.handle,
      crypto: dependencies.crypto,
      snapshot: opaque,
      resolveHistoricalAgentSignerAuthority:
        dependencies.resolveHistoricalAgentSignerAuthority,
      assertCurrent: check,
    });
  } });
}
