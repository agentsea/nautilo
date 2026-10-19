import { sha256 } from "@noble/hashes/sha2.js";
import {
  asc,
  backgroundCryptoAuthorizationDomainRequirements,
  backgroundCryptoAuthorizationNamespaceRequirements,
  backgroundCryptoAuthorizationRequests,
  cryptoObjects,
  eq,
  or,
  sql,
  taskTerminalMessageCryptoStagingReceipts,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  assertAuthenticTaskRuntimeRunResultReadEvidence,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";

import {
  assertAuthenticNativeProtectedTaskRunResultMessageSourceV1,
} from "./native-protected-task-run-result-opener.ts";
import {
  prepareNativeTaskRunResultMessage,
  readPreparedNativeTaskRunResultMessage,
  type NativeTaskRunResultMessageAuthority,
  type PrepareNativeTaskRunResultMessageInput,
} from "./native-task-run-result-message-preparation.ts";
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

import { deriveMessageCryptoObjectIdV2 } from "../../message/conversation-repository.ts";
import { decodeObjectAccessManifestV5, decodeEncryptedPayloadV2 } from "@nautilo/lattice-crypto/wire";
import { readDurableTaskContentPublication } from "./postgres-task-content-crypto-completion.ts";
import { deriveTaskContentCryptoObjectIdV1, TASK_RUN_RESULT_OBJECT_TYPE_V1 } from "../../task/task-content-repository.ts";
import { taskRuntimeAcceptedResponseIsCurrent } from
  "./task-runtime-accepted-response-integrity.ts";

const receipts = taskTerminalMessageCryptoStagingReceipts;
const encoder = new TextEncoder();
declare const verifiedRunResultMessageBrand: unique symbol;

export type NativeTaskRunResultMessageIntent = Readonly<{
  taskId: string;
  taskRunId: string;
  bindingId: string;
  messageOperationId: string;
  sessionId: string;
  messageId: number;
  revision: 0;
  objectId: string;
  roomId: string;
  namespaceId: string;
  domainId: string;
  mode: NativeTaskRunResultMessageAuthority["mode"];
  acceptedPolicyRevision: number;
  publicationPolicyRevision: number;
  signerAgentId: string;
  payloadDigest: string;
  role: "assistant";
  createdAt: number;
  requesterHumanId: string;
  requestId: string;
  resultTerminalStatus: "completed" | "errored";
  resultContentRevision: 1;
  resultObjectId: string;
  resultGenesisManifestHash: string;
  resultCryptoAccessRevision: number;
  resultNamespaceId: string;
  resultDomainId: string;
  resultNamespaceAccessRevision: number;
}>;

export type NativeTaskRunResultMessageCurrentAuthority = Readonly<{
  taskId: string;
  taskRunId: string;
  bindingId: string;
  messageOperationId: string;
  sessionId: string;
  messageId: number;
  revision: 0;
  objectId: string;
  roomId: string;
  namespaceId: string;
  domainId: string;
  mode: NativeTaskRunResultMessageAuthority["mode"];
  acceptedPolicyRevision: number;
  currentPolicyRevision: number;
  namespaceAccessRevision: number;
  requesterHumanId: string;
  resultTerminalStatus: "completed" | "errored";
  resultContentRevision: 1;
  resultObjectId: string;
  resultGenesisManifestHash: string;
  resultCryptoAccessRevision: number;
  resultNamespaceId: string;
  resultDomainId: string;
  resultNamespaceAccessRevision: number;
}>;

export type VerifiedStagedTaskRunResultMessagePublication = Readonly<{
  intent: NativeTaskRunResultMessageIntent;
  requestId: string;
  recipientGeneration: number;
  claimId: string;
  authorizationDigest: Uint8Array;
  genesisManifestHash: Uint8Array;
  authorityFingerprint: Uint8Array;
  readonly [verifiedRunResultMessageBrand]: true;
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
    conflict(`Invalid Task result Message staging ${key}`);
  }
  return Uint8Array.from(value);
}

function integer(row: Readonly<Record<string, unknown>>, key: string): number {
  const raw = row[key];
  const value = typeof raw === "bigint" ? Number(raw)
    : typeof raw === "string" && /^(0|[1-9][0-9]*)$/u.test(raw)
      ? Number(raw)
      : raw;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    conflict(`Invalid Task result Message staging ${key}`);
  }
  return value as number;
}

function tuple(intent: NativeTaskRunResultMessageIntent): readonly unknown[] {
  return [
    "nautilo/task-run-result-message-delivery-intent/v1",
    intent.taskId, intent.taskRunId, intent.bindingId,
    intent.messageOperationId, intent.sessionId, intent.messageId,
    intent.revision, intent.objectId, intent.roomId,
    intent.namespaceId, intent.domainId, intent.mode,
    intent.acceptedPolicyRevision, intent.publicationPolicyRevision,
    intent.signerAgentId, intent.payloadDigest, intent.role,
    intent.createdAt, intent.requesterHumanId, intent.requestId,
    intent.resultTerminalStatus, intent.resultContentRevision,
    intent.resultObjectId, intent.resultGenesisManifestHash,
    intent.resultCryptoAccessRevision, intent.resultNamespaceId,
    intent.resultDomainId, intent.resultNamespaceAccessRevision,
  ];
}

const retainedIntentStringFields = [
  "taskId", "taskRunId", "bindingId", "messageOperationId", "sessionId", "objectId",
  "roomId", "namespaceId", "domainId", "mode", "signerAgentId", "payloadDigest", "role",
  "requesterHumanId", "requestId", "resultTerminalStatus", "resultObjectId",
  "resultGenesisManifestHash", "resultNamespaceId", "resultDomainId",
] as const;
const retainedIntentNumberFields = [
  "messageId", "revision", "acceptedPolicyRevision", "publicationPolicyRevision", "createdAt",
  "resultContentRevision", "resultCryptoAccessRevision", "resultNamespaceAccessRevision",
] as const;

function retainedIntent(value: unknown): NativeTaskRunResultMessageIntent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    conflict("Task result Message retained intent is invalid");
  }
  const row = value as Record<string, unknown>;
  const keys = [...retainedIntentStringFields, ...retainedIntentNumberFields];
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))
    || retainedIntentStringFields.some(key => typeof row[key] !== "string" || row[key].length === 0)
    || retainedIntentNumberFields.some(key => !Number.isSafeInteger(row[key]) || (row[key] as number) < 0)) {
    conflict("Task result Message retained intent has an invalid shape");
  }
  const intent = { ...row } as unknown as NativeTaskRunResultMessageIntent;
  if (intent.messageId < 1 || intent.revision !== 0 || intent.role !== "assistant"
    || (intent.mode !== "encrypted_only" && intent.mode !== "shadow_encryption")
    || (intent.resultTerminalStatus !== "completed" && intent.resultTerminalStatus !== "errored")
    || intent.resultContentRevision !== 1
    || intent.publicationPolicyRevision < intent.acceptedPolicyRevision
    || !/^[0-9a-f]{64}$/u.test(intent.payloadDigest)
    || !/^[0-9a-f]{64}$/u.test(intent.resultGenesisManifestHash)
    || intent.requestId !== `task-run-delivery-result-authorization:${intent.taskRunId}`
    || intent.bindingId !== `task-run-output:${intent.taskRunId}`
    || intent.messageOperationId !== `task-run-delivery-message:${intent.taskRunId}`
    || intent.objectId !== deriveMessageCryptoObjectIdV2({ sessionId: intent.sessionId,
      messageId: intent.messageId, revision: 0 })
    || intent.resultObjectId !== deriveTaskContentCryptoObjectIdV1({ kind: "run_result",
      taskId: intent.taskId, taskRunId: intent.taskRunId, contentRevision: 1 })) {
    conflict("Task result Message retained intent coordinate is invalid");
  }
  return Object.freeze(intent);
}

function deliveryIntentHash(intent: NativeTaskRunResultMessageIntent): Uint8Array {
  return sha256(encoder.encode(JSON.stringify(tuple(intent))));
}

function authorityFingerprint(
  intent: NativeTaskRunResultMessageIntent,
  namespaceAccessRevision: number,
): Uint8Array {
  return sha256(encoder.encode(JSON.stringify([
    "nautilo/task-run-result-message-authority/v1",
    ...tuple(intent), namespaceAccessRevision,
  ])));
}

function sameIntent(
  left: NativeTaskRunResultMessageIntent,
  right: NativeTaskRunResultMessageIntent,
): boolean {
  return JSON.stringify(tuple(left)) === JSON.stringify(tuple(right));
}

function intentFromAuthority(
  authority: NativeTaskRunResultMessageAuthority,
): NativeTaskRunResultMessageIntent {
  return Object.freeze({
    taskId: authority.taskId,
    taskRunId: authority.taskRunId,
    bindingId: authority.bindingId,
    messageOperationId: authority.messageOperationId,
    sessionId: authority.sessionId,
    messageId: authority.messageId,
    revision: 0,
    objectId: authority.objectId,
    roomId: authority.roomId,
    namespaceId: authority.namespaceId,
    domainId: authority.domainId,
    mode: authority.mode,
    acceptedPolicyRevision: authority.acceptedPolicyRevision,
    publicationPolicyRevision: authority.publicationPolicyRevision,
    signerAgentId: authority.signerAgentId,
    payloadDigest: authority.payloadDigest,
    role: "assistant",
    createdAt: authority.createdAt,
    requesterHumanId: authority.requesterHumanId,
    requestId: authority.requestId,
    resultTerminalStatus: authority.resultTerminalStatus,
    resultContentRevision: 1,
    resultObjectId: authority.resultObjectId,
    resultGenesisManifestHash: authority.resultGenesisManifestHash,
    resultCryptoAccessRevision: authority.resultCryptoAccessRevision,
    resultNamespaceId: authority.resultNamespaceId,
    resultDomainId: authority.resultDomainId,
    resultNamespaceAccessRevision: authority.resultNamespaceAccessRevision,
  });
}

function intentFromPreparation(
  preparation: PrepareNativeTaskRunResultMessageInput,
): NativeTaskRunResultMessageIntent {
  const result = preparation.evidence.result;
  const invocation = preparation.evidence.invocation;
  const write = preparation.evidence.messageWrite;
  if (invocation.kind !== "raw" || write === null
    || result.contentRevision !== 1
    || preparation.allocation.acceptedPolicyRevision < 1
    || preparation.allocation.publicationPolicyRevision
      < preparation.allocation.acceptedPolicyRevision
    || (result.terminalStatus !== "completed"
      && result.terminalStatus !== "errored")) {
    conflict("Task result Message preparation is not raw revision one");
  }
  return Object.freeze({
    taskId: result.taskId,
    taskRunId: result.taskRunId,
    bindingId: invocation.bindingId,
    messageOperationId: invocation.operationId,
    sessionId: preparation.allocation.sessionId,
    messageId: preparation.allocation.messageId,
    revision: 0,
    objectId: preparation.allocation.objectId,
    roomId: invocation.roomId,
    namespaceId: write.namespace.namespaceId,
    domainId: write.namespace.domainId,
    mode: preparation.allocation.mode,
    acceptedPolicyRevision: preparation.allocation.acceptedPolicyRevision,
    publicationPolicyRevision:
      preparation.allocation.publicationPolicyRevision,
    signerAgentId: write.signerAgentId,
    payloadDigest: Array.from(preparation.source.payloadDigest, value =>
      value.toString(16).padStart(2, "0")).join(""),
    role: "assistant",
    createdAt: preparation.allocation.createdAt,
    requesterHumanId: preparation.evidence.requesterHumanId,
    requestId: preparation.evidence.requestId,
    resultTerminalStatus: result.terminalStatus,
    resultContentRevision: 1,
    resultObjectId: result.objectId,
    resultGenesisManifestHash: Array.from(result.genesisManifestHash, value =>
      value.toString(16).padStart(2, "0")).join(""),
    resultCryptoAccessRevision: result.cryptoAccessRevision,
    resultNamespaceId: result.namespace.namespaceId,
    resultDomainId: result.namespace.domainId,
    resultNamespaceAccessRevision: result.namespace.expectedAccessRevision,
  });
}

function compatibleCurrent(
  intent: NativeTaskRunResultMessageIntent,
  current: NativeTaskRunResultMessageCurrentAuthority,
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
    && current.currentPolicyRevision >= intent.publicationPolicyRevision
    && current.requesterHumanId === intent.requesterHumanId
    && current.resultTerminalStatus === intent.resultTerminalStatus
    && current.resultContentRevision === 1
    && current.resultObjectId === intent.resultObjectId
    && current.resultGenesisManifestHash === intent.resultGenesisManifestHash
    && Number.isSafeInteger(current.resultCryptoAccessRevision)
    && current.resultCryptoAccessRevision >= intent.resultCryptoAccessRevision
    && current.resultNamespaceId === intent.resultNamespaceId
    // Historical source authority describes how the already-staged bytes were
    // read. Current source admission is supplied independently by the held owner.
    && typeof current.resultDomainId === "string" && current.resultDomainId.length > 0
    && Number.isSafeInteger(current.resultNamespaceAccessRevision)
    && current.resultNamespaceAccessRevision >= 0;
}

function samePreparedAuthority(
  left: NativeTaskRunResultMessageAuthority,
  right: NativeTaskRunResultMessageAuthority,
): boolean {
  const fields = Object.keys(left) as (keyof NativeTaskRunResultMessageAuthority)[];
  return Object.keys(right).length === fields.length
    && fields.every(field => left[field] === right[field]);
}

function opaqueAuthority(
  authority: NativeTaskRunResultMessageAuthority,
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
  intent: NativeTaskRunResultMessageIntent,
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

function tokenSnapshot(
  token: VerifiedStagedTaskRunResultMessagePublication,
): string {
  return JSON.stringify([
    tuple(token.intent), token.requestId, token.recipientGeneration,
    token.claimId, Array.from(token.authorizationDigest),
    Array.from(token.genesisManifestHash),
    Array.from(token.authorityFingerprint),
  ]);
}

async function receiptRows(
  handle: CryptoPostgresHandle,
  intent: NativeTaskRunResultMessageIntent,
) {
  return executeTypedCryptoQuery(handle, cryptoTypedDb.select().from(receipts)
    .where(or(
      eq(receipts.requestId, intent.requestId),
      eq(receipts.cryptoObjectId, intent.objectId),
    )).limit(2));
}

export type InspectStagedTaskRunResultMessagePublicationInput = Readonly<{
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  intent: NativeTaskRunResultMessageIntent;
  currentAuthority: NativeTaskRunResultMessageCurrentAuthority;
  resolveHistoricalAgentSignerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority;
}>;

/** Verify staged raw result delivery from receipt and immutable crypto only. */
export async function inspectStagedTaskRunResultMessagePublication(
  input: InspectStagedTaskRunResultMessagePublicationInput,
): Promise<VerifiedStagedTaskRunResultMessagePublication | null> {
  const intent = Object.freeze({ ...input.intent });
  const current = Object.freeze({ ...input.currentAuthority });
  if (!compatibleCurrent(intent, current)
    || !Number.isSafeInteger(current.namespaceAccessRevision)
    || current.namespaceAccessRevision < 0) {
    conflict("Task result Message current authority is incompatible");
  }
  return withVerifiedCryptoPostgresTransaction(input.handle, async handle => {
    const rows = await receiptRows(handle, intent);
    if (rows.length === 0) return null;
    const row = rows[0]!;
    if (row.raw_result_message_intent !== null && row.raw_result_message_intent !== undefined
      && JSON.stringify(tuple(retainedIntent(row.raw_result_message_intent))) !== JSON.stringify(tuple(intent))) {
      conflict("Task result Message retained intent conflicts with requested provenance");
    }
    const intentHash = deliveryIntentHash(intent);
    const fingerprint = authorityFingerprint(
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
        || !equal(bytes(row, "authority_fingerprint"), fingerprint)) {
        conflict("Task result Message staging receipt conflicts with intent");
      }
      // A retained receipt proves the original read, not a later access head.
      // Re-authenticate the immutable source chain before adopting a repaired mapping.
      if (current.resultCryptoAccessRevision !== intent.resultCryptoAccessRevision) {
        const source = await readDurableTaskContentPublication({ executor: handle,
          crypto: input.crypto, objectId: current.resultObjectId,
          resolveHistoricalAgentSignerAuthority: input.resolveHistoricalAgentSignerAuthority });
        if (source === null) conflict("Task result Message source ciphertext is missing");
        const payload = decodeEncryptedPayloadV2(source.payloadBytes);
        try {
          const genesis = decodeObjectAccessManifestV5(source.genesisManifestBytes);
          if (source.accessRevision !== current.resultCryptoAccessRevision
            || source.namespaceId !== current.resultNamespaceId
            || source.bindingRevisionAtWrap > current.resultNamespaceAccessRevision
            || payload.context.objectType !== TASK_RUN_RESULT_OBJECT_TYPE_V1
            || genesis.signer.kind !== "agent_runtime" || genesis.signer.agentId !== intent.signerAgentId
            || Array.from(source.genesisManifestHash, byte => byte.toString(16).padStart(2, "0")).join("")
              !== intent.resultGenesisManifestHash) {
            conflict("Task result Message source access lineage changed");
          }
        } finally {
          payload.ciphertext.fill(0);
          for (const value of Object.values(source)) if (value instanceof Uint8Array) value.fill(0);
        }
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
      if (!exists) conflict("Task result Message staging ciphertext is missing");
      if (typeof row.claim_id !== "string" || row.claim_id.length === 0) {
        conflict("Task result Message staging claim is invalid");
      }
      const token = Object.freeze({
        intent,
        requestId: intent.requestId,
        recipientGeneration: integer(row, "recipient_generation"),
        claimId: row.claim_id,
        authorizationDigest: bytes(row, "authorization_digest"),
        genesisManifestHash,
        authorityFingerprint: fingerprint.slice(),
      }) as VerifiedStagedTaskRunResultMessagePublication;
      verified.set(token, {
        snapshot: tokenSnapshot(token),
        current: JSON.stringify(current),
      });
      return token;
    } finally {
      intentHash.fill(0);
      fingerprint.fill(0);
    }
  });
}

export function assertVerifiedStagedTaskRunResultMessagePublication(
  token: VerifiedStagedTaskRunResultMessagePublication,
  currentAuthority: NativeTaskRunResultMessageCurrentAuthority,
): void {
  const state = verified.get(token as object);
  if (state === undefined || state.snapshot !== tokenSnapshot(token)
    || state.current !== JSON.stringify(currentAuthority)
    || !compatibleCurrent(token.intent, currentAuthority)) {
    throw new TypeError("Task result Message staging proof is not authentic");
  }
}

export type StageNativeTaskRunResultMessagePublicationInput = Readonly<{
  restricted: PostgresJsBridgeConnection;
  preparation: PrepareNativeTaskRunResultMessageInput;
  resolveHistoricalAgentSignerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority;
  assertCurrentClaim(): void | Promise<void>;
  resolveCurrentDeliveryAuthority(expected: NativeTaskRunResultMessageIntent):
    Promise<NativeTaskRunResultMessageCurrentAuthority | null>;
}>;

/** Stage one raw revision-one result Message while read and write authority live. */
export async function stageNativeTaskRunResultMessagePublication(
  input: StageNativeTaskRunResultMessagePublicationInput,
): Promise<"staged" | "already_staged"> {
  const preparation = input.preparation;
  const evidence = preparation.evidence;
  const source = preparation.source;
  const intent = intentFromPreparation(preparation);
  let current: NativeTaskRunResultMessageCurrentAuthority;
  const assertLive = async (): Promise<NativeTaskRunResultMessageCurrentAuthority> => {
    preparation.signal.throwIfAborted();
    assertAuthenticTaskRuntimeRunResultReadEvidence(evidence);
    assertAuthenticNativeProtectedTaskRunResultMessageSourceV1(source);
    await input.assertCurrentClaim();
    const resolved = await input.resolveCurrentDeliveryAuthority(intent);
    if (resolved === null || !compatibleCurrent(intent, resolved)
      || resolved.resultCryptoAccessRevision !== intent.resultCryptoAccessRevision
      || resolved.currentPolicyRevision !== intent.publicationPolicyRevision
      || resolved.resultDomainId !== intent.resultDomainId
      || resolved.resultNamespaceAccessRevision !== intent.resultNamespaceAccessRevision) {
      conflict("Task result Message delivery authority is not current");
    }
    assertAuthenticTaskRuntimeRunResultReadEvidence(evidence);
    assertAuthenticNativeProtectedTaskRunResultMessageSourceV1(source);
    return Object.freeze({ ...resolved });
  };
  current = await assertLive();
  const namespaceAccessRevision = current.namespaceAccessRevision;
  const handle = await verifyCryptoPostgresHandle(input.restricted);
  return withVerifiedCryptoPostgresTransaction(handle, async transaction => {
    const assertDurableClaim = async (): Promise<void> => {
      const requests = backgroundCryptoAuthorizationRequests;
      const requestRows = await executeTypedCryptoQuery(transaction,
        cryptoTypedDb.select({
          request_id: requests.requestId,
          work_id: requests.workId,
          work_kind: requests.workKind,
          purpose: requests.purpose,
          state: requests.state,
          format_version: requests.formatVersion,
          credential_subject_kind: requests.credentialSubjectKind,
          runtime_kind: requests.runtimeKind,
          runtime_version: requests.runtimeVersion,
          claim_id: requests.claimId,
          recipient_generation: requests.recipientGeneration,
          recipient_key_id: requests.recipientKeyId,
          idempotency_key: requests.idempotencyKey,
          accepted_response_kind: requests.acceptedResponseKind,
          accepted_response_hash: requests.acceptedResponseHash,
          accepted_response_bytes: requests.acceptedResponseBytes,
          expected_policy_revision: requests.expectedPolicyRevision,
          namespace_id: requests.namespaceId,
          domain_id: requests.domainId,
          expected_namespace_access_revision:
            requests.expectedNamespaceAccessRevision,
          expected_domain_epoch: requests.expectedDomainEpoch,
          live: sql<boolean>`${requests.claimExpiresAt} > clock_timestamp()
            and ${requests.authorizationExpiresAt} > clock_timestamp()
            and ${requests.recipientExpiresAt} > clock_timestamp()
            and ${requests.acceptedAt} <= clock_timestamp()
            and to_timestamp(${Math.min(
              evidence.claimExpiresAt,
              evidence.recipientExpiresAt,
              evidence.authorizationExpiresAt,
              evidence.expiresAt,
            )} / 1000.0) > clock_timestamp()`.as("live"),
        }).from(requests).where(eq(requests.requestId, evidence.requestId))
          .limit(2).for("update"));
      const row = requestRows[0];
      const namespaceTable = backgroundCryptoAuthorizationNamespaceRequirements;
      const namespaceRows = await executeTypedCryptoQuery(transaction,
        cryptoTypedDb.select({
          request_id: namespaceTable.requestId,
          namespace_id: namespaceTable.namespaceId,
          ordinal: namespaceTable.ordinal,
          domain_id: namespaceTable.domainId,
          operation_mask: namespaceTable.operationMask,
          expected_access_revision: namespaceTable.expectedAccessRevision,
          expected_policy_revision: namespaceTable.expectedPolicyRevision,
        }).from(namespaceTable).where(eq(
          namespaceTable.requestId, evidence.requestId,
        )).orderBy(asc(namespaceTable.ordinal)));
      const domainTable = backgroundCryptoAuthorizationDomainRequirements;
      const domainRows = await executeTypedCryptoQuery(transaction,
        cryptoTypedDb.select({
          request_id: domainTable.requestId,
          domain_id: domainTable.domainId,
          ordinal: domainTable.ordinal,
          expected_epoch: domainTable.expectedEpoch,
          expected_agent_authorization_revision:
            domainTable.expectedAgentAuthorizationRevision,
          expected_authorization_revision:
            domainTable.expectedAuthorizationRevision,
        }).from(domainTable).where(eq(
          domainTable.requestId, evidence.requestId,
        )).orderBy(asc(domainTable.ordinal)));
      const write = evidence.messageWrite;
      if (write === null) conflict("Task result Message write proof is absent");
      const namespaceExpectations = new Map<string, Readonly<{
        domainId: string; operations: number; accessRevision: number;
        ordinal: number;
      }>>();
      namespaceExpectations.set(evidence.result.namespace.namespaceId, {
        domainId: evidence.result.namespace.domainId, operations: 1,
        accessRevision: evidence.result.namespace.expectedAccessRevision,
        ordinal: 0,
      });
      const prior = namespaceExpectations.get(write.namespace.namespaceId);
      if (prior !== undefined
        && (prior.domainId !== write.namespace.domainId
          || prior.accessRevision
            !== write.namespace.expectedAccessRevision)) {
        conflict("Task result Message Namespace authority is inconsistent");
      }
      namespaceExpectations.set(write.namespace.namespaceId, {
        domainId: write.namespace.domainId,
        operations: (prior?.operations ?? 0) | 2,
        accessRevision: write.namespace.expectedAccessRevision,
        ordinal: prior?.ordinal ?? 1,
      });
      const domainExpectations = new Map([
        [evidence.resultDomain.domainId, evidence.resultDomain],
      ]);
      const priorDomain = domainExpectations.get(write.domain.domainId);
      if (priorDomain !== undefined
        && (priorDomain.domainKeyGeneration
            !== write.domain.domainKeyGeneration
          || priorDomain.authorizationRevision
            !== write.domain.authorizationRevision)) {
        conflict("Task result Message Domain authority is inconsistent");
      }
      domainExpectations.set(write.domain.domainId, write.domain);
      const namespaceRowsMatch = namespaceRows.length
        === namespaceExpectations.size
        && namespaceRows.every(entry => {
          const expected = namespaceExpectations.get(entry.namespace_id);
          return expected !== undefined
            && integer(entry, "ordinal") === expected.ordinal
            && entry.request_id === evidence.requestId
            && entry.domain_id === expected.domainId
            && integer(entry, "operation_mask") === expected.operations
            && integer(entry, "expected_access_revision")
              === expected.accessRevision
            && integer(entry, "expected_policy_revision")
              === evidence.policyRevision;
        });
      const domainRowsMatch = domainRows.length === domainExpectations.size
        && domainRows.every(entry => {
          const expected = domainExpectations.get(entry.domain_id);
          return expected !== undefined
            && entry.request_id === evidence.requestId
            && integer(entry, "expected_epoch")
              === expected.domainKeyGeneration
            && entry.expected_agent_authorization_revision === null
            && integer(entry, "expected_authorization_revision")
              === expected.authorizationRevision;
        });
      const acceptedResponseHash = row === undefined ? undefined
        : bytes(row, "accepted_response_hash");
      const acceptedResponseCurrent = acceptedResponseHash !== undefined
        && row?.accepted_response_bytes instanceof Uint8Array
        && await taskRuntimeAcceptedResponseIsCurrent({
          crypto: preparation.crypto,
          evidence,
          acceptedResponseHash,
          acceptedResponseBytes: row.accepted_response_bytes,
        });
      if (requestRows.length !== 1 || row === undefined || row.live !== true
        || row.request_id !== evidence.requestId
        || row.work_id !== evidence.workId
        || row.work_kind !== "task.deliver_result"
        || row.purpose !== "task.deliver_result"
        || row.state !== "running" || row.format_version !== 3
        || row.credential_subject_kind !== "runtime"
        || row.runtime_kind !== "task" || row.runtime_version !== 1
        || row.claim_id !== evidence.claimId
        || integer(row, "recipient_generation")
          !== evidence.recipientGeneration
        || row.recipient_key_id !== evidence.recipientKeyId
        || typeof row.idempotency_key !== "string"
        || !/^task-output-read:[0-9a-f]{64}$/u.test(row.idempotency_key)
        || row.accepted_response_kind !== "runtime"
        || integer(row, "expected_policy_revision")
          !== evidence.policyRevision
        || row.namespace_id !== evidence.result.namespace.namespaceId
        || row.domain_id !== evidence.result.namespace.domainId
        || integer(row, "expected_namespace_access_revision")
          !== evidence.result.namespace.expectedAccessRevision
        || integer(row, "expected_domain_epoch")
          !== evidence.resultDomain.domainKeyGeneration
        || !acceptedResponseCurrent
        || !namespaceRowsMatch || !domainRowsMatch) {
        conflict("Task result Message staging claim is not current");
      }
    };
    await assertDurableClaim();
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [intent.requestId],
    );
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [intent.objectId],
    );
    const existing = await inspectStagedTaskRunResultMessagePublication({
      handle: transaction,
      crypto: preparation.crypto,
      intent,
      currentAuthority: current,
      resolveHistoricalAgentSignerAuthority:
        input.resolveHistoricalAgentSignerAuthority,
    });
    if (existing !== null) {
      if (existing.recipientGeneration !== evidence.recipientGeneration
        || existing.claimId !== evidence.claimId
        || !equal(existing.authorizationDigest, evidence.authorizationDigest)) {
        conflict("Task result Message stage belongs to another claim");
      }
      current = await assertLive();
      await assertDurableClaim();
      return "already_staged";
    }
    const publicationRows = await executeTypedCryptoQuery(transaction,
      cryptoTypedDb.select({ request_id: receipts.requestId })
        .from(receipts).where(or(
          eq(receipts.requestId, evidence.requestId),
          eq(receipts.cryptoObjectId, intent.objectId),
        )).limit(1));
    const objectRows = await executeTypedCryptoQuery(transaction,
      cryptoTypedDb.select({ object_id: cryptoObjects.objectId })
        .from(cryptoObjects).where(eq(
          cryptoObjects.objectId, intent.objectId,
        )).limit(1));
    if (publicationRows.length !== 0 || objectRows.length !== 0) {
      conflict("Task result Message ciphertext has no staging receipt");
    }
    const prepared = await prepareNativeTaskRunResultMessage(preparation);
    if (!sameIntent(intentFromAuthority(prepared.authority), intent)
      || prepared.authority.namespaceAccessRevision
        !== current.namespaceAccessRevision) {
      conflict("Prepared Task result Message authority changed");
    }
    const snapshot = readPreparedNativeTaskRunResultMessage(prepared);
    const opaque: NativeTaskMessageOpaqueSnapshot = Object.freeze({
      ...snapshot,
      authority: opaqueAuthority(snapshot.authority),
    });
    const completion = await completeNativeTaskMessageOpaqueSnapshot({
      handle: transaction,
      crypto: preparation.crypto,
      snapshot: opaque,
      resolveHistoricalAgentSignerAuthority:
        input.resolveHistoricalAgentSignerAuthority,
      assertCurrent: async () => {
        current = await assertLive();
        if (current.namespaceAccessRevision !== namespaceAccessRevision) {
          conflict("Task result Message Namespace authority changed");
        }
        await assertDurableClaim();
        const preparedCurrent = await preparation.resolveCurrentAuthority(
          prepared.authority);
        if (preparedCurrent === null
          || !samePreparedAuthority(prepared.authority, preparedCurrent)) {
          conflict("Prepared Task result Message authority is not current");
        }
      },
    });
    if (completion !== "created") {
      conflict("Task result Message ciphertext appeared without a receipt");
    }
    const intentHash = deliveryIntentHash(intent);
    const fingerprint = authorityFingerprint(
      intent, current.namespaceAccessRevision);
    try {
      await executeTypedCryptoQuery(transaction, cryptoTypedDb.insert(receipts)
        .values({
          requestId: evidence.requestId,
          recipientGeneration: evidence.recipientGeneration,
          claimId: evidence.claimId,
          authorizationDigest: evidence.authorizationDigest.slice(),
          deliveryIntentHash: intentHash,
          rawResultMessageIntent: retainedIntent(intent),
          acceptedPolicyRevision: intent.acceptedPolicyRevision,
          publicationPolicyRevision: intent.publicationPolicyRevision,
          authorityFingerprint: fingerprint,
          cryptoObjectId: intent.objectId,
          genesisManifestHash: snapshot.manifestHash.slice(),
          stagedAt: sql`clock_timestamp()`,
        }));
    } finally {
      intentHash.fill(0);
      fingerprint.fill(0);
      snapshot.object.payloadBytes.ciphertext.fill(0);
      snapshot.manifestBytes.fill(0);
      snapshot.manifestHash.fill(0);
      snapshot.signerEvidenceBytes?.fill(0);
      snapshot.envelopeBytes[0].fill(0);
    }
    current = await assertLive();
    if (current.namespaceAccessRevision !== namespaceAccessRevision) {
      conflict("Task result Message Namespace authority changed");
    }
    await assertDurableClaim();
    return "staged";
  });
}

/** Receipt table is shared; this fence is intentionally existence-only. */
export async function hasTaskRunResultMessageCryptoPublication(
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
    cryptoObjects.objectId, expected.objectId,
  )).limit(1))).length !== 0;
}

/** Metadata reconstruction only. The returned intent is never a publication capability. */
export async function readStagedTaskRunResultMessageIntent(
  handle: CryptoPostgresHandle,
  expected: Readonly<{ requestId: string; objectId: string }>,
): Promise<NativeTaskRunResultMessageIntent | null> {
  assertVerifiedCryptoPostgresHandle(handle);
  const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select().from(receipts)
    .where(or(eq(receipts.requestId, expected.requestId), eq(receipts.cryptoObjectId, expected.objectId))).limit(2));
  if (rows.length === 0) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || row.request_id !== expected.requestId || row.crypto_object_id !== expected.objectId) {
    conflict("Task result Message retained receipt coordinate conflicts");
  }
  if (row.raw_result_message_intent === null || row.raw_result_message_intent === undefined) return null;
  const intent = retainedIntent(row.raw_result_message_intent);
  if (intent.requestId !== expected.requestId || intent.objectId !== expected.objectId
    || intent.acceptedPolicyRevision !== integer(row, "accepted_policy_revision")
    || intent.publicationPolicyRevision !== integer(row, "publication_policy_revision")
    || !equal(deliveryIntentHash(intent), bytes(row, "delivery_intent_hash"))) {
    conflict("Task result Message retained intent hash conflicts");
  }
  return intent;
}
