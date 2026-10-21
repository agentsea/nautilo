import {
  backgroundCryptoAuthorizationRequests, cryptoObjects, eq, or, sql,
  taskCancellationCryptoStagingReceipts,
  type ProtectedTaskCancellationOutputIntent,
} from "@nautilo/db";
import { assertAuthenticTaskRuntimeCancellationResultEvidence,
  type LatticeCrypto } from "@nautilo/lattice-crypto";
import { decodeEncryptedPayloadV2, decodeObjectAccessManifestV5 } from "@nautilo/lattice-crypto/wire";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  deriveTaskContentCryptoObjectIdV1, fingerprintTaskContentAuthorityV1,
  fingerprintTaskContentNamespaceV1, sameTaskContentCoordinateV1,
  TASK_RUN_RESULT_OBJECT_TYPE_V1, type TaskContentProductStorePort,
} from "../../task/task-content-repository.ts";
import type { TaskContentAuthorityV1 } from "../../task/task-content-authority-v1.ts";
import { taskRuntimePreparedResultDigestV1 } from "../../task/task-run-result-preparation.ts";
import {
  assertVerifiedCryptoPostgresHandle, cryptoTypedDb, executeTypedCryptoQuery,
  verifyCryptoPostgresHandle, withVerifiedCryptoPostgresTransaction,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import type { DatabaseRow } from "../storage/postgres-record-codecs.ts";
import {
  createPostgresTaskContentCryptoCompletion, readDurableTaskContentPublication,
  TaskContentCryptoCompletionConflictError,
} from "./postgres-task-content-crypto-completion.ts";
import { prepareNativeTaskRuntimeCancelledRunResult,
  type PrepareNativeTaskRuntimeCancelledRunResultInput } from "./native-task-run-result-preparation.ts";
import { taskRuntimeAcceptedResponseIsCurrent } from
  "./task-runtime-accepted-response-integrity.ts";

type Intent = ProtectedTaskCancellationOutputIntent;
type History = Pick<Parameters<typeof createPostgresTaskContentCryptoCompletion>[0],
  "resolveHistoricalAgentSignerAuthority" | "resolveHistoricalHumanDeviceSigningPublicKey">;
declare const stagedCancellationBrand: unique symbol;
export type VerifiedStagedTaskCancellationPublication = Readonly<{
  intent: Intent;
  requestId: string;
  recipientGeneration: number;
  claimId: string;
  authorizationDigest: Uint8Array;
  genesisManifestHash: Uint8Array;
  authorityFingerprint: Uint8Array;
  readonly [stagedCancellationBrand]: true;
}>;
const verified = new WeakMap<object, Readonly<{ snapshot: string; currentAuthorityFingerprint: Uint8Array }>>();
const encoder = new TextEncoder();
const receipts = taskCancellationCryptoStagingReceipts;

function conflict(message: string): never {
  throw new TaskContentCryptoCompletionConflictError(message);
}
function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
function bytes(row: DatabaseRow, key: string): Uint8Array {
  const value = row[key];
  if (!(value instanceof Uint8Array) || value.length !== 32) conflict(`Invalid staging ${key}`);
  return value.slice();
}
function integer(row: DatabaseRow, key: string): number {
  const raw = row[key];
  if (typeof raw !== "number" && typeof raw !== "bigint"
    && !(typeof raw === "string" && /^(0|[1-9][0-9]*)$/u.test(raw))) conflict(`Invalid staging ${key}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) conflict(`Invalid staging ${key}`);
  return value;
}
function requestId(intent: Intent): string {
  return `task-run-cancellation-result-authorization:${intent.taskRunId}`;
}
function coordinate(intent: Intent) {
  return { kind: "run_result" as const, taskId: intent.taskId,
    taskRunId: intent.taskRunId, contentRevision: 2 };
}
function intentTuple(intent: Intent): readonly unknown[] {
  if (intent.taskStatus !== "cancelled" || intent.runStatus !== "cancelled"
    || intent.resultRevision !== 2 || !["protected", "dual"].includes(intent.representation)
    || !Number.isSafeInteger(intent.policyRevision) || intent.policyRevision < 1
    || !Number.isSafeInteger(intent.terminalAt.getTime())
    || intent.resultOperationId !== `task-run-cancelled-result:${intent.taskRunId}`
    || intent.resultObjectId !== deriveTaskContentCryptoObjectIdV1(coordinate(intent))) {
    conflict("Invalid stopped cancellation intent");
  }
  return ["nautilo/task-cancellation-crypto-staging-intent/v1", intent.taskId,
    intent.taskRunId, intent.requesterUserId, intent.agentId, intent.contentNamespaceId,
    intent.representation, intent.resultRevision, intent.resultOperationId,
    intent.resultObjectId, intent.policyRevision, intent.taskStatus, intent.runStatus,
    intent.terminalAt.getTime()];
}
function intentHash(intent: Intent): Uint8Array {
  return sha256(encoder.encode(JSON.stringify(intentTuple(intent))));
}
function stableKey(intent: Intent): string {
  const digest = sha256(encoder.encode(JSON.stringify([
    "nautilo/task-cancellation-result/v1", intent.taskId, intent.taskRunId,
    intent.requesterUserId, intent.agentId, intent.contentNamespaceId,
    intent.resultOperationId, intent.resultObjectId, intent.terminalAt.getTime(),
  ])));
  return `task-cancellation:${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
function copyIntent(intent: Intent): Intent {
  intentTuple(intent);
  return Object.freeze({ ...intent, terminalAt: new Date(intent.terminalAt) });
}
function authorityMatches(intent: Intent, authority: TaskContentAuthorityV1): boolean {
  return authority.kind === "requester_private_namespace" && authority.keyClass === "ai"
    && authority.authorityVersion === 1 && authority.namespaceId === intent.contentNamespaceId
    && authority.expectedPolicyRevision === intent.policyRevision;
}
function tokenFingerprint(token: VerifiedStagedTaskCancellationPublication): string {
  return JSON.stringify([intentTuple(token.intent), token.requestId, token.recipientGeneration,
    token.claimId, Array.from(token.authorizationDigest), Array.from(token.genesisManifestHash),
    Array.from(token.authorityFingerprint)]);
}
async function receiptRows(handle: CryptoPostgresHandle, intent: Intent) {
  return executeTypedCryptoQuery(handle, cryptoTypedDb.select().from(receipts).where(or(
    eq(receipts.requestId, requestId(intent)), eq(receipts.cryptoObjectId, intent.resultObjectId),
  )).limit(2));
}

/** Existence only: an orphan object also fences fresh preparation and claim rotation. */
export async function hasTaskCancellationCryptoPublication(handle: CryptoPostgresHandle,
  expected: Readonly<{ requestId: string; objectId: string }>): Promise<boolean> {
  assertVerifiedCryptoPostgresHandle(handle);
  const receipt = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({ request_id: receipts.requestId })
    .from(receipts).where(or(eq(receipts.requestId, expected.requestId),
      eq(receipts.cryptoObjectId, expected.objectId))).limit(1));
  if (receipt.length !== 0) return true;
  return (await executeTypedCryptoQuery(handle, cryptoTypedDb.select({ object_id: cryptoObjects.objectId })
    .from(cryptoObjects).where(eq(cryptoObjects.objectId, expected.objectId)).limit(1))).length !== 0;
}

export type InspectStagedTaskCancellationPublicationInput = History & Readonly<{
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  intent: Intent;
  /** Current authorization; receipt policy remains immutable historical provenance. */
  authority: TaskContentAuthorityV1;
}>;

/** Receipt and historical signatures prove prior publication; no live grant is reopened. */
export async function inspectStagedTaskCancellationPublication(
  input: InspectStagedTaskCancellationPublicationInput,
): Promise<VerifiedStagedTaskCancellationPublication | null> {
  const intent = copyIntent(input.intent);
  const authority = Object.freeze({ ...input.authority });
  const historicalAuthority = Object.freeze({ ...authority, expectedPolicyRevision: intent.policyRevision });
  if (!authorityMatches(intent, historicalAuthority)
    || authority.expectedPolicyRevision < intent.policyRevision) conflict("Cancellation staging authority disagrees");
  return withVerifiedCryptoPostgresTransaction(input.handle, async handle => {
    const rows = await receiptRows(handle, intent);
    if (rows.length === 0) return null;
    const row = rows[0]!;
    const fingerprint = fingerprintTaskContentAuthorityV1(historicalAuthority);
    if (rows.length !== 1 || row.request_id !== requestId(intent)
      || row.crypto_object_id !== intent.resultObjectId
      || integer(row, "policy_revision") !== intent.policyRevision
      || !equal(bytes(row, "stopped_intent_hash"), intentHash(intent))
      || !equal(bytes(row, "authority_fingerprint"), fingerprint)) conflict("Cancellation staging receipt conflicts with intent");
    const durable = await readDurableTaskContentPublication({ ...input, executor: handle,
      objectId: intent.resultObjectId });
    if (durable === null) conflict("Cancellation staging ciphertext is missing");
    const genesis = decodeObjectAccessManifestV5(durable.genesisManifestBytes);
    const payload = decodeEncryptedPayloadV2(durable.payloadBytes);
    if (!equal(durable.genesisManifestHash, bytes(row, "genesis_manifest_hash"))
      || !equal(input.crypto.hash(durable.genesisManifestBytes), durable.genesisManifestHash)
      || genesis.signer.kind !== "agent_runtime" || genesis.signer.agentId !== intent.agentId
      || genesis.objectId !== intent.resultObjectId || genesis.accessRevision !== 0
      || durable.namespaceId !== intent.contentNamespaceId
      || durable.bindingRevisionAtWrap !== authority.expectedAccessRevision
      || payload.context.objectId !== intent.resultObjectId
      || payload.context.objectType !== TASK_RUN_RESULT_OBJECT_TYPE_V1 || payload.context.keyClass !== "ai") {
      conflict("Cancellation staging ciphertext conflicts with receipt");
    }
    if (typeof row.claim_id !== "string" || row.claim_id.length === 0) conflict("Invalid staging claim");
    const token = Object.freeze({ intent, requestId: requestId(intent),
      recipientGeneration: integer(row, "recipient_generation"), claimId: row.claim_id,
      authorizationDigest: bytes(row, "authorization_digest"),
      genesisManifestHash: bytes(row, "genesis_manifest_hash"), authorityFingerprint: fingerprint,
    }) as VerifiedStagedTaskCancellationPublication;
    verified.set(token, { snapshot: tokenFingerprint(token),
      currentAuthorityFingerprint: fingerprintTaskContentAuthorityV1(authority) });
    return token;
  });
}

export type StageNativeTaskCancellationPublicationInput = History & Readonly<{
  intent: Intent;
  preparation: PrepareNativeTaskRuntimeCancelledRunResultInput;
  assertCurrentClaim(): void | Promise<void>;
}>;

/** Must run inside withAccepted's borrowed restricted transaction and held Run lock. */
export async function stageNativeTaskCancellationPublication(
  input: StageNativeTaskCancellationPublicationInput,
): Promise<"staged" | "already_staged"> {
  const intent = copyIntent(input.intent);
  const preparation = input.preparation;
  const evidence = preparation.evidence;
  const authority = Object.freeze({ ...preparation.authority });
  const assertLive = async () => {
    preparation.signal.throwIfAborted();
    assertAuthenticTaskRuntimeCancellationResultEvidence(evidence);
    await input.assertCurrentClaim();
    await preparation.assertCurrentTaskAuthority();
    assertAuthenticTaskRuntimeCancellationResultEvidence(evidence);
  };
  await assertLive();
  if (!authorityMatches(intent, authority) || evidence.requestId !== requestId(intent)
    || evidence.workId !== intent.taskRunId || evidence.policyRevision !== intent.policyRevision
    || evidence.result.taskId !== intent.taskId || evidence.result.taskRunId !== intent.taskRunId
    || evidence.result.contentRevision !== 2 || evidence.result.objectId !== intent.resultObjectId
    || evidence.result.signerAgentId !== intent.agentId
    || evidence.result.namespace.namespaceId !== authority.namespaceId
    || evidence.result.namespace.domainId !== authority.domainId
    || evidence.result.namespace.expectedAccessRevision !== authority.expectedAccessRevision) {
    conflict("Cancellation staging evidence conflicts with intent");
  }
  const handle = await verifyCryptoPostgresHandle(preparation.restricted);
  return withVerifiedCryptoPostgresTransaction(handle, async transaction => {
    const assertDurableClaim = async () => {
      const table = backgroundCryptoAuthorizationRequests;
      const rows = await executeTypedCryptoQuery(transaction, cryptoTypedDb.select({
        request_id: table.requestId, work_id: table.workId, work_kind: table.workKind,
        purpose: table.purpose, state: table.state, format_version: table.formatVersion,
        credential_subject_kind: table.credentialSubjectKind, runtime_kind: table.runtimeKind,
        runtime_version: table.runtimeVersion, claim_id: table.claimId,
        recipient_generation: table.recipientGeneration, recipient_key_id: table.recipientKeyId,
        accepted_response_kind: table.acceptedResponseKind, accepted_response_hash: table.acceptedResponseHash,
        accepted_response_bytes: table.acceptedResponseBytes, issuing_human_id: table.issuingHumanId,
        expected_policy_revision: table.expectedPolicyRevision, namespace_id: table.namespaceId,
        domain_id: table.domainId, expected_namespace_access_revision: table.expectedNamespaceAccessRevision,
        expected_domain_epoch: table.expectedDomainEpoch,
        idempotency_key: table.idempotencyKey,
        live: sql<boolean>`${table.claimExpiresAt} > clock_timestamp()
          and ${table.authorizationExpiresAt} > clock_timestamp()
          and ${table.recipientExpiresAt} > clock_timestamp()
          and ${table.acceptedAt} <= clock_timestamp()
          and to_timestamp(${Math.min(evidence.claimExpiresAt, evidence.expiresAt, evidence.recipientExpiresAt)} / 1000.0) > clock_timestamp()`.as("live"),
      }).from(table).where(eq(table.requestId, evidence.requestId)).limit(2).for("update"));
      const row = rows[0];
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
      if (rows.length !== 1 || row === undefined || row.live !== true
        || row.request_id !== evidence.requestId || row.work_id !== intent.taskRunId
        || row.work_kind !== "task.cancel_result" || row.purpose !== "task.cancel_result"
        || row.state !== "running" || row.format_version !== 3
        || row.credential_subject_kind !== "runtime" || row.runtime_kind !== "task" || row.runtime_version !== 1
        || row.claim_id !== evidence.claimId || integer(row, "recipient_generation") !== evidence.recipientGeneration
        || row.recipient_key_id !== evidence.recipientKeyId || row.accepted_response_kind !== "runtime"
        || row.issuing_human_id !== authority.requesterHumanId
        || integer(row, "expected_policy_revision") !== intent.policyRevision
        || row.namespace_id !== authority.namespaceId || row.domain_id !== authority.domainId
        || integer(row, "expected_domain_epoch") !== evidence.domainRequirements[0].domainKeyGeneration
        || integer(row, "expected_namespace_access_revision") !== authority.expectedAccessRevision
        || row.idempotency_key !== stableKey(intent)
        || !acceptedResponseCurrent) {
        conflict("Cancellation staging claim is not current");
      }
    };
    await assertDurableClaim();
    await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [intent.resultObjectId]);
    const existing = await inspectStagedTaskCancellationPublication({ ...input,
      handle: transaction, crypto: preparation.crypto, intent, authority });
    if (existing !== null) {
      if (existing.recipientGeneration !== evidence.recipientGeneration || existing.claimId !== evidence.claimId
        || !equal(existing.authorizationDigest, evidence.authorizationDigest)) conflict("Cancellation stage belongs to another claim");
      await assertLive();
      await assertDurableClaim();
      return "already_staged";
    }
    if (await hasTaskCancellationCryptoPublication(transaction,
      { requestId: evidence.requestId, objectId: intent.resultObjectId })) {
      conflict("Cancellation ciphertext has no staging receipt");
    }
    const prepared = await prepareNativeTaskRuntimeCancelledRunResult({ ...preparation, authority });
    const completion = createPostgresTaskContentCryptoCompletion({ ...input,
      handle: transaction, crypto: preparation.crypto,
      resolveCurrentAuthority: candidate => Promise.resolve(
        sameTaskContentCoordinateV1(candidate, coordinate(intent)) ? authority : null),
    });
    if (await completion.complete(prepared) !== "created") conflict("Cancellation ciphertext appeared without a receipt");
    await executeTypedCryptoQuery(transaction, cryptoTypedDb.insert(receipts).values({
      requestId: evidence.requestId, recipientGeneration: evidence.recipientGeneration,
      claimId: evidence.claimId, authorizationDigest: evidence.authorizationDigest.slice(),
      stoppedIntentHash: intentHash(intent), policyRevision: intent.policyRevision,
      authorityFingerprint: fingerprintTaskContentAuthorityV1(authority), cryptoObjectId: intent.resultObjectId,
      genesisManifestHash: taskRuntimePreparedResultDigestV1(prepared), stagedAt: sql`clock_timestamp()`,
    }));
    await assertLive();
    await assertDurableClaim();
    return "staged";
  });
}

/** Reserve from authenticated durable metadata, never from a fabricated prepared object. */
export async function reserveStagedTaskCancellationPublication(input: Readonly<{
  staged: VerifiedStagedTaskCancellationPublication;
  authority: TaskContentAuthorityV1;
  product: Pick<TaskContentProductStorePort, "reserveRevision">;
}>): ReturnType<TaskContentProductStorePort["reserveRevision"]> {
  const token = input.staged;
  if (!verifiedForCurrentAuthority(token, input.authority)) {
    conflict("Unverified or mutated cancellation staging token");
  }
  return input.product.reserveRevision({
    operationId: token.intent.resultOperationId, coordinate: coordinate(token.intent),
    requesterHumanId: input.authority.requesterHumanId, namespaceId: token.intent.contentNamespaceId,
    authorityFingerprint: token.authorityFingerprint.slice(),
    requiredNamespaceFingerprint: fingerprintTaskContentNamespaceV1(token.intent.contentNamespaceId),
    representation: token.intent.representation, requestDigest: token.genesisManifestHash.slice(),
    cryptoObjectId: token.intent.resultObjectId, objectType: TASK_RUN_RESULT_OBJECT_TYPE_V1,
    payloadVersion: 1, operationalMetadata: null,
  });
}


function verifiedForCurrentAuthority(token: VerifiedStagedTaskCancellationPublication,
  current: TaskContentAuthorityV1): boolean {
  const stored = verified.get(token);
  return stored !== undefined && stored.snapshot === tokenFingerprint(token)
    && equal(stored.currentAuthorityFingerprint, fingerprintTaskContentAuthorityV1(current))
    && current.expectedPolicyRevision >= token.intent.policyRevision
    && authorityMatches(token.intent, { ...current, expectedPolicyRevision: token.intent.policyRevision })
    && equal(token.authorityFingerprint, fingerprintTaskContentAuthorityV1({
      ...current, expectedPolicyRevision: token.intent.policyRevision,
    }));
}

export type StagedTaskCancellationPublicationProofInput = Readonly<{
  coordinate: Parameters<TaskContentProductStorePort["reserveRevision"]>[0]["coordinate"];
  operationId: string;
  cryptoObjectId: string;
  requestDigest: Uint8Array;
  authorityFingerprint: Uint8Array;
  representation: "protected" | "dual";
  currentAuthority: TaskContentAuthorityV1;
}>;

/** Runs under product locks; implementations inspect immutable crypto without re-entering product authority. */
export type VerifyStagedTaskCancellationPublication = (
  input: StagedTaskCancellationPublicationProofInput,
) => Promise<VerifiedStagedTaskCancellationPublication | null>;

/** Internal product-store admission: a closed coordinate alone never authorizes policy drift. */
export function verifiedStagedCancellationPolicyRevision(
  token: VerifiedStagedTaskCancellationPublication,
  expected: StagedTaskCancellationPublicationProofInput,
): number | null {
  try {
    return verifiedForCurrentAuthority(token, expected.currentAuthority)
      && sameTaskContentCoordinateV1(coordinate(token.intent), expected.coordinate)
      && token.intent.resultOperationId === expected.operationId
      && token.intent.resultObjectId === expected.cryptoObjectId
      && token.intent.representation === expected.representation
      && equal(token.genesisManifestHash, expected.requestDigest)
      && equal(token.authorityFingerprint, expected.authorityFingerprint)
      ? token.intent.policyRevision : null;
  } catch {
    return null;
  }
}
