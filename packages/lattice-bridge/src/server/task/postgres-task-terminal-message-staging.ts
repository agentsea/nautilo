import {
  backgroundCryptoAuthorizationRequests,
  cryptoObjects,
  eq,
  or,
  sql,
  taskTerminalMessageCryptoStagingReceipts,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  assertAuthenticTaskRuntimeTerminalMessageEvidence,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import type {
  ResolveHistoricalAgentRuntimeSignerManagerAuthority,
} from "../storage/agent-runtime-signer-history.ts";
import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  verifyCryptoPostgresHandle,
  withVerifiedCryptoPostgresTransaction,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import {
  completeNativeTaskMessageOpaqueSnapshot,
  inspectNativeTaskMessageOpaquePublication,
  NativeTaskMessageCryptoCompletionConflictError,
  type NativeTaskMessageOpaqueAuthority,
  type NativeTaskMessageOpaqueInspectionAuthority,
  type NativeTaskMessageOpaqueSnapshot,
} from "./postgres-native-task-message-completion.ts";
import {
  prepareNativeTaskTerminalMessage,
  readPreparedNativeTaskTerminalMessage,
  type NativeTaskTerminalMessageAuthority,
  type PrepareNativeTaskTerminalMessageInput,
} from "./native-task-terminal-message-preparation.ts";
import { taskRuntimeAcceptedResponseIsCurrent } from
  "./task-runtime-accepted-response-integrity.ts";

const receipts = taskTerminalMessageCryptoStagingReceipts;
const encoder = new TextEncoder();
declare const verifiedTerminalMessageBrand: unique symbol;

export type NativeTaskTerminalMessageCurrentAuthority = Readonly<{
  taskId: string;
  taskRunId: string;
  bindingId: string;
  messageOperationId: string;
  sessionId: string;
  messageId: number;
  revision: number;
  objectId: string;
  roomId: string;
  namespaceId: string;
  domainId: string;
  mode: NativeTaskTerminalMessageAuthority["mode"];
  acceptedPolicyRevision: number;
  currentPolicyRevision: number;
  namespaceAccessRevision: number;
}>;

/** Product-reconstructable immutable delivery identity; no live secret state. */
export type NativeTaskTerminalMessageIntent = Readonly<{
  taskId: string;
  taskRunId: string;
  bindingId: string;
  messageOperationId: string;
  sessionId: string;
  messageId: number;
  revision: number;
  objectId: string;
  roomId: string;
  namespaceId: string;
  domainId: string;
  mode: NativeTaskTerminalMessageAuthority["mode"];
  acceptedPolicyRevision: number;
  publicationPolicyRevision: number;
  signerAgentId: string;
  payloadDigest: string;
  role: "assistant";
  createdAt: number;
  requestId: string;
}>;

export type VerifiedStagedTaskTerminalMessagePublication = Readonly<{
  intent: NativeTaskTerminalMessageIntent;
  requestId: string;
  recipientGeneration: number;
  claimId: string;
  authorizationDigest: Uint8Array;
  genesisManifestHash: Uint8Array;
  authorityFingerprint: Uint8Array;
  readonly [verifiedTerminalMessageBrand]: true;
}>;

const verified = new WeakMap<object, Readonly<{
  snapshot: string;
  current: string;
}>>();

function conflict(message: string): never {
  throw new NativeTaskMessageCryptoCompletionConflictError(message);
}
function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}
function bytes(row: Readonly<Record<string, unknown>>, key: string): Uint8Array {
  const value = row[key];
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    conflict(`Invalid terminal Message staging ${key}`);
  }
  return value.slice();
}
function integer(row: Readonly<Record<string, unknown>>, key: string): number {
  const raw = row[key];
  const value = typeof raw === "bigint" ? Number(raw)
    : typeof raw === "string" && /^(0|[1-9][0-9]*)$/u.test(raw)
      ? Number(raw)
      : raw;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    conflict(`Invalid terminal Message staging ${key}`);
  }
  return value as number;
}

function tuple(intent: NativeTaskTerminalMessageIntent): readonly unknown[] {
  return [
    "nautilo/task-terminal-message-delivery-intent/v1",
    intent.taskId, intent.taskRunId, intent.bindingId,
    intent.messageOperationId, intent.sessionId, intent.messageId,
    intent.revision, intent.objectId, intent.roomId,
    intent.namespaceId, intent.domainId, intent.mode,
    intent.acceptedPolicyRevision, intent.publicationPolicyRevision,
    intent.signerAgentId, intent.payloadDigest, intent.role,
    intent.createdAt, intent.requestId,
  ];
}

function deliveryIntentHash(intent: NativeTaskTerminalMessageIntent): Uint8Array {
  return sha256(encoder.encode(JSON.stringify(tuple(intent))));
}

function fingerprintNativeTaskTerminalMessageAuthority(
  intent: NativeTaskTerminalMessageIntent,
  namespaceAccessRevision: number,
): Uint8Array {
  return sha256(encoder.encode(JSON.stringify([
    "nautilo/task-terminal-message-authority/v1",
    ...tuple(intent), namespaceAccessRevision,
  ])));
}

function intentFromAuthority(
  authority: NativeTaskTerminalMessageAuthority,
): NativeTaskTerminalMessageIntent {
  return Object.freeze({
    taskId: authority.taskId,
    taskRunId: authority.taskRunId,
    bindingId: authority.bindingId,
    messageOperationId: authority.messageOperationId,
    sessionId: authority.sessionId,
    messageId: authority.messageId,
    revision: authority.revision,
    objectId: authority.objectId,
    roomId: authority.roomId,
    namespaceId: authority.namespaceId,
    domainId: authority.domainId,
    mode: authority.mode,
    acceptedPolicyRevision: authority.acceptedPolicyRevision,
    publicationPolicyRevision: authority.publicationPolicyRevision,
    signerAgentId: authority.signerAgentId,
    payloadDigest: authority.payloadDigest,
    role: authority.role,
    createdAt: authority.createdAt,
    requestId: authority.requestId,
  });
}

function sameIntent(
  left: NativeTaskTerminalMessageIntent,
  right: NativeTaskTerminalMessageIntent,
): boolean {
  return JSON.stringify(tuple(left)) === JSON.stringify(tuple(right));
}

function samePreparedAuthority(
  left: NativeTaskTerminalMessageAuthority,
  right: NativeTaskTerminalMessageAuthority,
): boolean {
  const fields = Object.keys(left) as (keyof NativeTaskTerminalMessageAuthority)[];
  return Object.keys(right).length === fields.length
    && fields.every(field => left[field] === right[field]);
}

function intentFromPreparation(
  preparation: PrepareNativeTaskTerminalMessageInput,
): NativeTaskTerminalMessageIntent {
  const { message } = preparation.evidence;
  return Object.freeze({
    taskId: message.taskId,
    taskRunId: message.taskRunId,
    bindingId: message.bindingId,
    messageOperationId: message.messageOperationId,
    sessionId: message.sessionId,
    messageId: message.messageId,
    revision: message.revision,
    objectId: message.objectId,
    roomId: message.roomId,
    namespaceId: message.namespaceId,
    domainId: message.domainId,
    mode: message.mode,
    acceptedPolicyRevision: message.acceptedPolicyRevision,
    publicationPolicyRevision: message.publicationPolicyRevision,
    signerAgentId: message.signerAgentId,
    payloadDigest: Array.from(message.payloadDigest, value =>
      value.toString(16).padStart(2, "0")).join(""),
    role: "assistant",
    createdAt: preparation.createdAt,
    requestId: preparation.evidence.requestId,
  });
}

function compatibleCurrent(
  intent: NativeTaskTerminalMessageIntent,
  current: NativeTaskTerminalMessageCurrentAuthority,
): boolean {
  return current.taskId === intent.taskId
    && current.taskRunId === intent.taskRunId
    && current.bindingId === intent.bindingId
    && current.messageOperationId === intent.messageOperationId
    && current.sessionId === intent.sessionId
    && current.messageId === intent.messageId
    && current.revision === intent.revision
    && current.objectId === intent.objectId
    && current.roomId === intent.roomId
    && current.namespaceId === intent.namespaceId
    && current.domainId === intent.domainId
    && current.mode === intent.mode
    && current.acceptedPolicyRevision === intent.acceptedPolicyRevision
    && current.currentPolicyRevision >= intent.publicationPolicyRevision;
}

function opaqueAuthority(
  authority: NativeTaskTerminalMessageAuthority,
): NativeTaskMessageOpaqueAuthority {
  return Object.freeze({
    sessionId: authority.sessionId,
    messageId: authority.messageId,
    revision: authority.revision,
    objectId: authority.objectId,
    namespaceId: authority.namespaceId,
    namespaceAccessRevision: authority.namespaceAccessRevision,
    namespaceKeyGeneration: authority.namespaceKeyGeneration,
    createdAt: authority.createdAt,
    signerAgentId: authority.signerAgentId,
    runtimeGeneration: authority.runtimeGeneration,
    agentAuthorizationRevision: authority.agentAuthorizationRevision,
    signerKeyId: authority.signerKeyId,
    ...(authority.signerAuthorizationHash === undefined ? {} : {
      signerAuthorizationHash: authority.signerAuthorizationHash,
      signerHostAuthorizationRevision:
        authority.signerHostAuthorizationRevision,
    }),
  });
}

function opaqueInspectionAuthority(
  intent: NativeTaskTerminalMessageIntent,
  namespaceAccessRevision: number,
): NativeTaskMessageOpaqueInspectionAuthority {
  return Object.freeze({
    sessionId: intent.sessionId,
    messageId: intent.messageId,
    revision: intent.revision,
    objectId: intent.objectId,
    namespaceId: intent.namespaceId,
    namespaceAccessRevision,
    createdAt: intent.createdAt,
    signerAgentId: intent.signerAgentId,
  });
}

function tokenSnapshot(token: VerifiedStagedTaskTerminalMessagePublication): string {
  return JSON.stringify([
    tuple(token.intent), token.requestId, token.recipientGeneration,
    token.claimId, Array.from(token.authorizationDigest),
    Array.from(token.genesisManifestHash), Array.from(token.authorityFingerprint),
  ]);
}

async function receiptRows(
  handle: CryptoPostgresHandle,
  intent: NativeTaskTerminalMessageIntent,
) {
  return executeTypedCryptoQuery(handle, cryptoTypedDb.select().from(receipts)
    .where(or(
      eq(receipts.requestId, intent.requestId),
      eq(receipts.cryptoObjectId, intent.objectId),
    )).limit(2));
}

/** Existence-only orphan fence used before claim rotation or preparation. */
export async function hasTaskTerminalMessageCryptoPublication(
  handle: CryptoPostgresHandle,
  expected: Readonly<{ requestId: string; objectId: string }>,
): Promise<boolean> {
  assertVerifiedCryptoPostgresHandle(handle);
  const found = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({
    request_id: receipts.requestId,
  }).from(receipts).where(or(
    eq(receipts.requestId, expected.requestId),
    eq(receipts.cryptoObjectId, expected.objectId),
  )).limit(1));
  if (found.length !== 0) return true;
  return (await executeTypedCryptoQuery(handle, cryptoTypedDb.select({
    object_id: cryptoObjects.objectId,
  }).from(cryptoObjects).where(eq(
    cryptoObjects.objectId, expected.objectId)).limit(1))).length !== 0;
}

/** Untrusted reconstruction metadata; callers must still verify the full staged proof. */
export async function readStagedTaskTerminalMessagePublicationPolicy(
  handle: CryptoPostgresHandle,
  expected: Readonly<{ requestId: string; objectId: string; acceptedPolicyRevision: number }>,
): Promise<number | null> {
  assertVerifiedCryptoPostgresHandle(handle);
  const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({
    request_id: receipts.requestId,
    crypto_object_id: receipts.cryptoObjectId,
    accepted_policy_revision: receipts.acceptedPolicyRevision,
    publication_policy_revision: receipts.publicationPolicyRevision,
  }).from(receipts).where(or(
    eq(receipts.requestId, expected.requestId),
    eq(receipts.cryptoObjectId, expected.objectId),
  )).limit(2));
  if (rows.length === 0) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || row.request_id !== expected.requestId
    || row.crypto_object_id !== expected.objectId
    || integer(row, "accepted_policy_revision") !== expected.acceptedPolicyRevision) {
    conflict("Terminal Message staging policy conflicts with allocation");
  }
  const revision = integer(row, "publication_policy_revision");
  if (revision < expected.acceptedPolicyRevision) {
    conflict("Terminal Message staging policy precedes acceptance");
  }
  return revision;
}

export type InspectStagedTaskTerminalMessagePublicationInput = Readonly<{
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  intent: NativeTaskTerminalMessageIntent;
  currentAuthority: NativeTaskTerminalMessageCurrentAuthority;
  resolveHistoricalAgentSignerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority;
}>;

/** Verify a staged Message from immutable crypto provenance, never plaintext. */
export async function inspectStagedTaskTerminalMessagePublication(
  input: InspectStagedTaskTerminalMessagePublicationInput,
): Promise<VerifiedStagedTaskTerminalMessagePublication | null> {
  const intent = Object.freeze({ ...input.intent });
  const current = Object.freeze({ ...input.currentAuthority });
  if (!compatibleCurrent(intent, current)
    || !Number.isSafeInteger(current.namespaceAccessRevision)
    || current.namespaceAccessRevision < 0) {
    conflict("Terminal Message current authority is incompatible");
  }
  return withVerifiedCryptoPostgresTransaction(input.handle, async handle => {
    const rows = await receiptRows(handle, intent);
    if (rows.length === 0) return null;
    const row = rows[0]!;
    const intentHash = deliveryIntentHash(intent);
    const authorityFingerprint = fingerprintNativeTaskTerminalMessageAuthority(
      intent, current.namespaceAccessRevision);
    try {
      if (rows.length !== 1
        || row.request_id !== intent.requestId
        || row.crypto_object_id !== intent.objectId
        || integer(row, "accepted_policy_revision")
          !== intent.acceptedPolicyRevision
        || integer(row, "publication_policy_revision")
          !== intent.publicationPolicyRevision
        || !equal(bytes(row, "delivery_intent_hash"), intentHash)
        || !equal(bytes(row, "authority_fingerprint"), authorityFingerprint)) {
        conflict("Terminal Message staging receipt conflicts with intent");
      }
      const genesisManifestHash = bytes(row, "genesis_manifest_hash");
      const exists = await inspectNativeTaskMessageOpaquePublication({
        handle,
        crypto: input.crypto,
        authority: opaqueInspectionAuthority(
          intent, current.namespaceAccessRevision),
        expectedGenesisManifestHash: genesisManifestHash,
        resolveHistoricalAgentSignerAuthority:
          input.resolveHistoricalAgentSignerAuthority,
      });
      if (!exists) conflict("Terminal Message staging ciphertext is missing");
      if (typeof row.claim_id !== "string" || row.claim_id.length === 0) {
        conflict("Terminal Message staging claim is invalid");
      }
      const token = Object.freeze({
        intent,
        requestId: intent.requestId,
        recipientGeneration: integer(row, "recipient_generation"),
        claimId: row.claim_id,
        authorizationDigest: bytes(row, "authorization_digest"),
        genesisManifestHash,
        authorityFingerprint: authorityFingerprint.slice(),
      }) as VerifiedStagedTaskTerminalMessagePublication;
      verified.set(token, {
        snapshot: tokenSnapshot(token),
        current: JSON.stringify(current),
      });
      return token;
    } finally {
      intentHash.fill(0);
      authorityFingerprint.fill(0);
    }
  });
}

export function assertVerifiedStagedTaskTerminalMessagePublication(
  token: VerifiedStagedTaskTerminalMessagePublication,
  currentAuthority: NativeTaskTerminalMessageCurrentAuthority,
): void {
  const state = verified.get(token as object);
  if (state === undefined || state.snapshot !== tokenSnapshot(token)
    || state.current !== JSON.stringify(currentAuthority)
    || !compatibleCurrent(token.intent, currentAuthority)) {
    throw new TypeError("Terminal Message staging proof is not authentic");
  }
}

export type StageNativeTaskTerminalMessagePublicationInput = Readonly<{
  restricted: PostgresJsBridgeConnection;
  preparation: PrepareNativeTaskTerminalMessageInput;
  resolveHistoricalAgentSignerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority;
  assertCurrentClaim(): void | Promise<void>;
  resolveCurrentDeliveryAuthority(expected: NativeTaskTerminalMessageIntent):
    Promise<NativeTaskTerminalMessageCurrentAuthority | null>;
}>;

/** Must run while the accepted terminal grant and destination authority live. */
export async function stageNativeTaskTerminalMessagePublication(
  input: StageNativeTaskTerminalMessagePublicationInput,
): Promise<"staged" | "already_staged"> {
  const evidence = input.preparation.evidence;
  const intent = intentFromPreparation(input.preparation);
  let current: NativeTaskTerminalMessageCurrentAuthority;
  const assertLive = async (): Promise<NativeTaskTerminalMessageCurrentAuthority> => {
    input.preparation.signal.throwIfAborted();
    assertAuthenticTaskRuntimeTerminalMessageEvidence(evidence);
    await input.assertCurrentClaim();
    const resolved = await input.resolveCurrentDeliveryAuthority(intent);
    if (resolved === null || !compatibleCurrent(intent, resolved)
      || resolved.currentPolicyRevision !== intent.publicationPolicyRevision) {
      conflict("Terminal Message delivery authority is not current");
    }
    assertAuthenticTaskRuntimeTerminalMessageEvidence(evidence);
    return Object.freeze({ ...resolved });
  };
  current = await assertLive();
  const namespaceAccessRevision = current.namespaceAccessRevision;
  const handle = await verifyCryptoPostgresHandle(input.restricted);
  return withVerifiedCryptoPostgresTransaction(handle, async transaction => {
    const assertDurableClaim = async (): Promise<void> => {
      const table = backgroundCryptoAuthorizationRequests;
      const rows = await executeTypedCryptoQuery(transaction,
        cryptoTypedDb.select({
          request_id: table.requestId,
          work_id: table.workId,
          work_kind: table.workKind,
          purpose: table.purpose,
          state: table.state,
          format_version: table.formatVersion,
          credential_subject_kind: table.credentialSubjectKind,
          runtime_kind: table.runtimeKind,
          runtime_version: table.runtimeVersion,
          claim_id: table.claimId,
          recipient_generation: table.recipientGeneration,
          recipient_key_id: table.recipientKeyId,
          accepted_response_kind: table.acceptedResponseKind,
          accepted_response_hash: table.acceptedResponseHash,
          accepted_response_bytes: table.acceptedResponseBytes,
          expected_policy_revision: table.expectedPolicyRevision,
          namespace_id: table.namespaceId,
          domain_id: table.domainId,
          expected_namespace_access_revision:
            table.expectedNamespaceAccessRevision,
          expected_domain_epoch: table.expectedDomainEpoch,
          live: sql<boolean>`${table.claimExpiresAt} > clock_timestamp()
            and ${table.authorizationExpiresAt} > clock_timestamp()
            and ${table.recipientExpiresAt} > clock_timestamp()
            and ${table.acceptedAt} <= clock_timestamp()
            and to_timestamp(${Math.min(
              evidence.claimExpiresAt,
              evidence.expiresAt,
              evidence.recipientExpiresAt,
            )} / 1000.0) > clock_timestamp()`.as("live"),
        }).from(table).where(eq(table.requestId, evidence.requestId))
          .limit(2).for("update"));
      const row = rows[0];
      const acceptedResponseHash = row === undefined ? undefined
        : bytes(row, "accepted_response_hash");
      const acceptedResponseCurrent = acceptedResponseHash !== undefined
        && row?.accepted_response_bytes instanceof Uint8Array
        && await taskRuntimeAcceptedResponseIsCurrent({
          crypto: input.preparation.crypto,
          evidence,
          acceptedResponseHash,
          acceptedResponseBytes: row.accepted_response_bytes,
        });
      if (rows.length !== 1 || row === undefined || row.live !== true
        || row.request_id !== evidence.requestId
        || row.work_id !== evidence.workId
        || row.work_kind !== "task.deliver_message"
        || row.purpose !== "task.deliver_message"
        || row.state !== "running" || row.format_version !== 3
        || row.credential_subject_kind !== "runtime"
        || row.runtime_kind !== "task" || row.runtime_version !== 1
        || row.claim_id !== evidence.claimId
        || integer(row, "recipient_generation")
          !== evidence.recipientGeneration
        || row.recipient_key_id !== evidence.recipientKeyId
        || row.accepted_response_kind !== "runtime"
        || integer(row, "expected_policy_revision")
          !== intent.publicationPolicyRevision
        || row.namespace_id !== intent.namespaceId
        || row.domain_id !== intent.domainId
        || integer(row, "expected_namespace_access_revision")
          !== namespaceAccessRevision
        || integer(row, "expected_domain_epoch")
          !== evidence.domainRequirements[0]?.domainKeyGeneration
        || !acceptedResponseCurrent) {
        conflict("Terminal Message staging claim is not current");
      }
    };
    await assertDurableClaim();
    await transaction.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
      [intent.objectId],
    );
    const existing = await inspectStagedTaskTerminalMessagePublication({
      handle: transaction,
      crypto: input.preparation.crypto,
      intent,
      currentAuthority: current,
      resolveHistoricalAgentSignerAuthority:
        input.resolveHistoricalAgentSignerAuthority,
    });
    if (existing !== null) {
      if (existing.recipientGeneration !== evidence.recipientGeneration
        || existing.claimId !== evidence.claimId
        || !equal(existing.authorizationDigest, evidence.authorizationDigest)) {
        conflict("Terminal Message stage belongs to another claim");
      }
      current = await assertLive();
      await assertDurableClaim();
      return "already_staged";
    }
    if (await hasTaskTerminalMessageCryptoPublication(transaction, {
      requestId: evidence.requestId,
      objectId: intent.objectId,
    })) conflict("Terminal Message ciphertext has no staging receipt");

    const prepared = await prepareNativeTaskTerminalMessage(input.preparation);
    if (!sameIntent(intentFromAuthority(prepared.authority), intent)
      || prepared.authority.namespaceAccessRevision
        !== current.namespaceAccessRevision) {
      conflict("Prepared terminal Message authority changed");
    }
    const snapshot = readPreparedNativeTaskTerminalMessage(prepared);
    const opaque: NativeTaskMessageOpaqueSnapshot = Object.freeze({
      ...snapshot,
      authority: opaqueAuthority(snapshot.authority),
    });
    const completion = await completeNativeTaskMessageOpaqueSnapshot({
      handle: transaction,
      crypto: input.preparation.crypto,
      snapshot: opaque,
      resolveHistoricalAgentSignerAuthority:
        input.resolveHistoricalAgentSignerAuthority,
      assertCurrent: async () => {
        current = await assertLive();
        if (current.namespaceAccessRevision !== namespaceAccessRevision) {
          conflict("Terminal Message Namespace authority changed");
        }
        await assertDurableClaim();
        const preparedCurrent = await input.preparation.resolveCurrentAuthority(
          prepared.authority);
        if (preparedCurrent === null
          || !samePreparedAuthority(prepared.authority, preparedCurrent)) {
          conflict("Prepared terminal Message authority is not current");
        }
      },
    });
    if (completion !== "created") {
      conflict("Terminal Message ciphertext appeared without a receipt");
    }
    const intentHash = deliveryIntentHash(intent);
    const authorityFingerprint = fingerprintNativeTaskTerminalMessageAuthority(
      intent, current.namespaceAccessRevision);
    try {
      await executeTypedCryptoQuery(transaction, cryptoTypedDb.insert(receipts).values({
        requestId: evidence.requestId,
        recipientGeneration: evidence.recipientGeneration,
        claimId: evidence.claimId,
        authorizationDigest: evidence.authorizationDigest.slice(),
        deliveryIntentHash: intentHash,
        acceptedPolicyRevision: intent.acceptedPolicyRevision,
        publicationPolicyRevision: intent.publicationPolicyRevision,
        authorityFingerprint,
        cryptoObjectId: intent.objectId,
        genesisManifestHash: snapshot.manifestHash.slice(),
        stagedAt: sql`clock_timestamp()`,
      }));
    } finally {
      intentHash.fill(0);
      authorityFingerprint.fill(0);
      snapshot.object.payloadBytes.ciphertext.fill(0);
      snapshot.manifestBytes.fill(0);
      snapshot.manifestHash.fill(0);
      snapshot.signerEvidenceBytes?.fill(0);
      snapshot.envelopeBytes[0].fill(0);
    }
    current = await assertLive();
    if (current.namespaceAccessRevision !== namespaceAccessRevision) {
      conflict("Terminal Message Namespace authority changed");
    }
    await assertDurableClaim();
    return "staged";
  });
}
