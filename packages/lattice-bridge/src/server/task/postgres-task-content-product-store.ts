import { classifyProtectedTaskMetadataV1 } from "@nautilo/types";
import { isVerifiedMappedTaskContentMetadataProof, readVerifiedForegroundTaskDefinitionAccessRevision, type VerifiedForegroundTaskDefinitionPublication } from "./postgres-foreground-task-definition-inspector.ts";
import { readInspectedHistoricalTaskContentAccessRevision } from "./postgres-task-historical-content-staging.ts";
import {
  and,
  PROTECTED_TASK_CANCELLED_RESULT,
  actors,
  encryptionTransitionPolicy,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  taskDefinitionCryptoRevisions,
  taskRunResultCryptoRevisions,
  taskRuns,
  protectedTaskRunOutputBindings,
  tasks,
  taskLocalExecutionDefinitionInvalidationPatch,
  TASK_LOCAL_EXECUTION_RECREATE_TEXT,
  type ProtectedTaskCancellationOutputIntent,
} from "@nautilo/db";

import type { TaskContentAuthorityV1 } from "../../task/task-content-authority-v1.ts";
import { hasTaskOrdinaryFallbackReceiptV1 } from "../../task/task-ordinary-fallback-receipt.ts";
import {
  TaskCancellationPublicationPolicyUnavailableError,
  TaskHistoricalRepairPublicationUnavailableError,
  TASK_CONTENT_PAYLOAD_VERSION_V1,
  TASK_CONTENT_RECONCILE_MAX_ATTEMPTS,
  TASK_CONTENT_RECONCILE_MAX_BATCH,
  assertTaskContentCoordinateV1,
  assertTaskContentRevisionLifecycleV1,
  deriveTaskContentCryptoObjectIdV1,
  taskContentRevisionObjectIdV1,
  fingerprintTaskContentAuthorityIdentityV1,
  fingerprintTaskContentAuthorityV1,
  fingerprintTaskContentNamespaceV1,
  isTaskOrdinaryFallbackRepairSourceProofV1,
  taskContentObjectTypeV1,
  type TaskContentCoordinateV1,
  type TaskContentFailureCode,
  type TaskContentProductMappingV1,
  type TaskContentProductStorePort,
  type TaskContentRevisionLifecycleV1,
  type TaskContentRevisionStateV1,
  type TaskRunResultContentCoordinateV1,
} from "../../task/task-content-repository.ts";
import {
  assertVerifiedConversationProductPostgresHandle,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresHandle,
  type ConversationProductPostgresTransaction,
} from "../message/postgres-conversation-product-store.ts";
import {
  assertProtectedTaskOperationalMetadataProjectionV1,
  type ProtectedTaskMetadataProjectionV1,
  type ProtectedTaskOperationalMetadataProjectionV1,
} from "@nautilo/types";

import {
  taskContentReconciliationFailureValues,
  taskContentReconciliationLeaseExpiry,
} from "./task-content-reconciliation-policy.ts";
import {
  verifiedStagedCancellationPolicyRevision,
  type StagedTaskCancellationPublicationProofInput,
  type VerifyStagedTaskCancellationPublication,
} from "./postgres-task-cancellation-crypto-staging.ts";
import { parseTaskHistoricalRepairProvenanceV1,
  preparedTaskHistoricalRepairProvenanceV1,
  type TaskHistoricalRepairProvenanceV1 } from
  "../../task/task-historical-repair-provenance.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const FAILURE_CODES = new Set<TaskContentFailureCode>([
  "authority_stale", "crypto_absent", "crypto_incomplete", "crypto_mismatch",
  "storage_transient", "mapping_conflict", "retry_exhausted",
]);

export type ResolveCurrentTaskContentAuthority = (
  input: Readonly<{ requesterHumanId: string; namespaceId: string }>,
) => TaskContentAuthorityV1 | null | Promise<TaskContentAuthorityV1 | null>;

/** Called only inside the Lattice proxy's authorized historical source transaction. */
export type VerifyHistoricalTaskContentSource = (
  transaction: ConversationProductPostgresTransaction,
  input: Readonly<{
    coordinate: TaskContentCoordinateV1;
    requesterHumanId: string;
    namespaceId: string;
    currentAuthority: TaskContentAuthorityV1;
    provenance: TaskHistoricalRepairProvenanceV1;
    phase: "reservation" | "mapping";
  }>,
) => Promise<boolean>;

type LedgerKind = TaskContentCoordinateV1["kind"];
function oneOrNone(
  rows: readonly ConversationProductDatabaseRow[],
  label: string,
): ConversationProductDatabaseRow | null {
  if (rows.length > 1) throw new Error(`${label} returned duplicate rows`);
  return rows[0] ?? null;
}

function text(row: ConversationProductDatabaseRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError(`${key} is not text`);
  return value;
}

function nullableText(row: ConversationProductDatabaseRow, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${key} is not text`);
  return value;
}

function integer(row: ConversationProductDatabaseRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${key} is not an integer`);
  }
  return value;
}

function bytes(row: ConversationProductDatabaseRow, key: string): Uint8Array {
  const value = row[key];
  if (!(value instanceof Uint8Array)) throw new TypeError(`${key} is not binary`);
  return new Uint8Array(value);
}

function nullableBytes(row: ConversationProductDatabaseRow, key: string): Uint8Array | null {
  const value = row[key];
  if (value === null) return null;
  if (!(value instanceof Uint8Array)) throw new TypeError(`${key} is not binary`);
  return new Uint8Array(value);
}

function jsonObject(row: ConversationProductDatabaseRow, key: string): ProtectedTaskMetadataProjectionV1 {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError(`${key} is not JSON text`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError(`${key} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`${key} is not a JSON object`);
  }
  return parsed as ProtectedTaskMetadataProjectionV1;
}

function date(row: ConversationProductDatabaseRow, key: string): Date | null {
  const value = row[key];
  if (value === null) return null;
  const postgres = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?([+-])(\d{2})(?::?(\d{2}))?$/u.exec(value)
    : null;
  const parsed = value instanceof Date
    ? new Date(value.getTime())
    : typeof value === "string"
      && Number.isFinite(Date.parse(value))
      && (new Date(value).toISOString() === value || postgres !== null)
    ? new Date(value)
    : null;
  const postgresOffset = postgres === null ? null
    : (postgres[8] === "-" ? -1 : 1)
      * (Number(postgres[9]) * 60 + Number(postgres[10] ?? "0"));
  const postgresLocal = parsed === null || postgresOffset === null
    ? null
    : new Date(parsed.getTime() + postgresOffset * 60_000);
  if (parsed === null || !Number.isFinite(parsed.getTime())
    || (postgres !== null && (postgresLocal === null
      || Number(postgres[9]) > 23
      || Number(postgres[10] ?? "0") > 59
      || postgresLocal.getUTCFullYear() !== Number(postgres[1])
      || postgresLocal.getUTCMonth() + 1 !== Number(postgres[2])
      || postgresLocal.getUTCDate() !== Number(postgres[3])
      || postgresLocal.getUTCHours() !== Number(postgres[4])
      || postgresLocal.getUTCMinutes() !== Number(postgres[5])
      || postgresLocal.getUTCSeconds() !== Number(postgres[6])
      || postgresLocal.getUTCMilliseconds()
        !== Number((postgres[7] ?? "").padEnd(3, "0").slice(0, 3))))) {
    throw new TypeError(`${key} is not a timestamp`);
  }
  return parsed;
}

function hasFallbackReceiptRow(
  row: ConversationProductDatabaseRow,
): boolean {
  try {
    const policyRevision = row["ordinary_fallback_policy_revision"] === null
      ? null : integer(row, "ordinary_fallback_policy_revision");
    return hasTaskOrdinaryFallbackReceiptV1({
      ordinaryFallbackOperationId:
        nullableText(row, "ordinary_fallback_operation_id"),
      ordinaryFallbackRequestDigest:
        nullableBytes(row, "ordinary_fallback_request_digest"),
      ordinaryFallbackReason:
        nullableText(row, "ordinary_fallback_reason"),
      ordinaryFallbackPolicyRevision: policyRevision,
      ordinaryFallbackCompletedAt:
        date(row, "ordinary_fallback_completed_at"),
    });
  } catch {
    return false;
  }
}

function bool(row: ConversationProductDatabaseRow, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") throw new TypeError(`${key} is not boolean`);
  return value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameJson(value, right[index]));
  }
  if (typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameJson(leftRecord[key], rightRecord[key]));
}

function assertUuid(label: string, value: string): void {
  if (!UUID.test(value)) throw new TypeError(`${label} must be a UUID`);
}

function assertDigest(label: string, value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError(`${label} must contain 32 bytes`);
  }
}

function assertFailureCode(value: TaskContentFailureCode): void {
  if (!FAILURE_CODES.has(value)) throw new TypeError("Task content failure code is invalid");
}

function inAllowedDefinitionStatus(row: ConversationProductDatabaseRow): boolean {
  return ["pending", "paused"].includes(text(row, "task_status"));
}

function coordinateFromRow(kind: LedgerKind, row: ConversationProductDatabaseRow): TaskContentCoordinateV1 {
  const common = {
    taskId: text(row, "task_id"),
    contentRevision: integer(row, kind === "definition" ? "content_revision" : "result_revision"),
  };
  return kind === "definition"
    ? Object.freeze({ kind, ...common })
    : Object.freeze({ kind, ...common, taskRunId: text(row, "task_run_id") });
}

function lifecycleFromRow(kind: LedgerKind, row: ConversationProductDatabaseRow): TaskContentRevisionLifecycleV1 {
  const completion = text(row, "completion");
  const disposition = text(row, "disposition");
  const representation = text(row, "representation");
  const failureCode = nullableText(row, "failure_code");
  if (completion !== "pending" && completion !== "complete") throw new TypeError("Task content completion is invalid");
  if (representation !== "protected" && representation !== "dual") throw new TypeError("Task content representation is invalid");
  if (failureCode !== null && !FAILURE_CODES.has(failureCode as TaskContentFailureCode)) {
    throw new TypeError("Task content failure code is invalid");
  }
  const lifecycle: TaskContentRevisionLifecycleV1 = Object.freeze({
    sequence: integer(row, "sequence"),
    coordinate: coordinateFromRow(kind, row),
    operationId: text(row, "operation_id"),
    requestDigest: bytes(row, "request_digest"),
    requesterHumanId: text(row, "requester_human_id"),
    namespaceId: text(row, "content_namespace_id"),
    cryptoObjectId: text(row, "crypto_object_id"),
    objectType: taskContentObjectTypeV1(coordinateFromRow(kind, row)),
    payloadVersion: integer(row, "payload_version") as 1,
    representation,
    authorityFingerprint: bytes(row, "authority_fingerprint"),
    requiredNamespaceFingerprint: bytes(row, "required_namespace_fingerprint"),
    operationalMetadata: kind === "definition"
      ? Object.freeze({
        ...jsonObject(row, "operational_metadata"),
      }) as ProtectedTaskOperationalMetadataProjectionV1
      : null,
    historicalRepair: row["historical_repair"] == null ? null
      : parseTaskHistoricalRepairProvenanceV1(typeof row["historical_repair"] === "string"
        ? JSON.parse(row["historical_repair"]) as unknown : row["historical_repair"]),
    completion,
    disposition: disposition as TaskContentRevisionLifecycleV1["disposition"],
    attemptCount: integer(row, "attempt_count"),
    nextAttemptAt: date(row, "next_attempt_at"),
    leaseToken: nullableText(row, "lease_token"),
    leaseExpiresAt: date(row, "lease_expires_at"),
    failureCode: failureCode as TaskContentFailureCode | null,
    cryptoCompletedAt: date(row, "crypto_completed_at"),
  });
  assertTaskContentRevisionLifecycleV1(lifecycle);
  return lifecycle;
}

function mappingFromRow(
  coordinate: TaskContentCoordinateV1,
  row: ConversationProductDatabaseRow | null,
): TaskContentProductMappingV1 | null {
  if (row === null) return null;
  return Object.freeze({
    coordinate,
    namespaceId: text(row, coordinate.kind === "definition"
      ? "content_namespace_id" : "result_content_namespace_id"),
    representation: text(row, coordinate.kind === "definition"
      ? "content_representation" : "result_representation") as "protected" | "dual",
    cryptoObjectId: nullableText(row, "crypto_object_id"),
    cryptoAccessRevision: integer(row, "crypto_access_revision"),
    cryptoRequiredNamespaceFingerprint: nullableBytes(row, "crypto_required_namespace_fingerprint"),
    cryptoMappingState: text(row, "crypto_mapping_state") as "verified" | "stale",
  });
}

function leaseMatches(
  row: ConversationProductDatabaseRow,
  lifecycle: TaskContentRevisionLifecycleV1,
  token: string | null,
): boolean {
  return lifecycle.leaseToken === token
    && (token === null || bool(row, "lease_is_live"));
}

function exactReservation(
  lifecycle: TaskContentRevisionLifecycleV1,
  input: Parameters<TaskContentProductStorePort["reserveRevision"]>[0],
): boolean {
  const coordinate = lifecycle.coordinate;
  return coordinate.kind === input.coordinate.kind
    && coordinate.taskId === input.coordinate.taskId
    && coordinate.contentRevision === input.coordinate.contentRevision
    && (coordinate.kind === "definition"
      || (input.coordinate.kind === "run_result" && coordinate.taskRunId === input.coordinate.taskRunId))
    && lifecycle.operationId === input.operationId
    && sameBytes(lifecycle.requestDigest, input.requestDigest)
    && lifecycle.requesterHumanId === input.requesterHumanId
    && lifecycle.namespaceId === input.namespaceId
    && sameBytes(lifecycle.authorityFingerprint, input.authorityFingerprint)
    && sameBytes(lifecycle.requiredNamespaceFingerprint, input.requiredNamespaceFingerprint)
    && lifecycle.representation === input.representation
    && lifecycle.cryptoObjectId === input.cryptoObjectId
    && lifecycle.objectType === input.objectType
    && lifecycle.payloadVersion === input.payloadVersion
    && sameJson(lifecycle.historicalRepair ?? null, input.historicalPrepared === undefined
      ? null : preparedTaskHistoricalRepairProvenanceV1(input.historicalPrepared))
    && sameJson(lifecycle.operationalMetadata, input.operationalMetadata);
}

function sameAuthorityResolutionLifecycle(
  observed: TaskContentRevisionLifecycleV1,
  locked: TaskContentRevisionLifecycleV1,
): boolean {
  return observed.sequence === locked.sequence
    && observed.coordinate.kind === locked.coordinate.kind
    && observed.coordinate.taskId === locked.coordinate.taskId
    && observed.coordinate.contentRevision === locked.coordinate.contentRevision
    && (observed.coordinate.kind === "definition"
      || (locked.coordinate.kind === "run_result"
        && observed.coordinate.taskRunId === locked.coordinate.taskRunId))
    && observed.operationId === locked.operationId
    && sameBytes(observed.requestDigest, locked.requestDigest)
    && observed.requesterHumanId === locked.requesterHumanId
    && observed.namespaceId === locked.namespaceId
    && observed.cryptoObjectId === locked.cryptoObjectId
    && observed.objectType === locked.objectType
    && observed.payloadVersion === locked.payloadVersion
    && observed.representation === locked.representation
    && sameBytes(
      observed.authorityFingerprint,
      locked.authorityFingerprint,
    )
    && sameBytes(
      observed.requiredNamespaceFingerprint,
      locked.requiredNamespaceFingerprint,
    )
    && sameJson(
      observed.operationalMetadata,
      locked.operationalMetadata,
    ) && sameJson(observed.historicalRepair ?? null, locked.historicalRepair ?? null);
}

function isCancellationPublication(input: Pick<StagedTaskCancellationPublicationProofInput,
  "coordinate" | "operationId" | "cryptoObjectId">): boolean {
  return input.coordinate.kind === "run_result" && input.coordinate.contentRevision === 2
    && input.operationId === `task-run-cancelled-result:${input.coordinate.taskRunId}`
    && input.cryptoObjectId === deriveTaskContentCryptoObjectIdV1(input.coordinate);
}

export class PostgresTaskContentProductStore implements TaskContentProductStorePort {
  readonly #handle: ConversationProductPostgresHandle;
  readonly #resolveCurrentAuthority: ResolveCurrentTaskContentAuthority;
  readonly #verifyStagedCancellation: VerifyStagedTaskCancellationPublication | undefined;
  readonly #assertReservationCurrent: ((coordinate: TaskContentCoordinateV1) => void | Promise<void>) | undefined;
  readonly #verifyHistoricalSource: VerifyHistoricalTaskContentSource | undefined;

  constructor(
    handle: ConversationProductPostgresHandle,
    resolveCurrentAuthority: ResolveCurrentTaskContentAuthority,
    assertReservationCurrent?: (coordinate: TaskContentCoordinateV1) => void | Promise<void>,
    verifyStagedCancellation?: VerifyStagedTaskCancellationPublication,
    verifyHistoricalSource?: VerifyHistoricalTaskContentSource,
  ) {
    assertVerifiedConversationProductPostgresHandle(handle);
    if (handle.role !== "nautilo") {
      throw new TypeError("Task content product store requires a direct nautilo product-role handle");
    }
    if (typeof resolveCurrentAuthority !== "function") {
      throw new TypeError("Task content product store requires a current authority resolver");
    }
    this.#handle = handle;
    this.#resolveCurrentAuthority = resolveCurrentAuthority;
    this.#assertReservationCurrent = assertReservationCurrent;
    this.#verifyStagedCancellation = verifyStagedCancellation;
    this.#verifyHistoricalSource = verifyHistoricalSource;
  }

  async reserveRevision(
    input: Parameters<TaskContentProductStorePort["reserveRevision"]>[0],
  ): ReturnType<TaskContentProductStorePort["reserveRevision"]> {
    this.#assertReservation(input);
    if (input.historicalPrepared !== undefined) {
      input = Object.freeze({ ...input, coordinate: Object.freeze({ ...input.coordinate }),
        requestDigest: input.requestDigest.slice(),
        authorityFingerprint: input.authorityFingerprint.slice(),
        requiredNamespaceFingerprint: input.requiredNamespaceFingerprint.slice() });
    }
    const historical = input.historicalPrepared === undefined ? null
      : preparedTaskHistoricalRepairProvenanceV1(input.historicalPrepared);
    if (historical !== null && (input.representation !== "dual"
      || input.coordinate.contentRevision !== 1
      || historical.signedRequestDigest !== Array.from(input.requestDigest,
        byte => byte.toString(16).padStart(2, "0")).join(""))) {
      throw new TypeError("Historical Task source reservation coordinates disagree");
    }
    if (historical !== null && this.#verifyHistoricalSource === undefined) {
      throw new TaskHistoricalRepairPublicationUnavailableError();
    }
    const authority = await this.#resolveCurrentAuthority({
      requesterHumanId: input.requesterHumanId,
      namespaceId: input.namespaceId,
    });
    if (
      authority === null
      || !this.#authorityIdentityMatches(
        authority,
        input.requesterHumanId,
        input.namespaceId,
      )
    ) return { status: "stale" };
    return this.#handle.transaction(async (transaction) => {
      if (input.coordinate.kind === "definition") {
        const policy = await this.#lockedPublicationPolicy(transaction);
        if (!this.#publicationPolicyMatches(policy, authority.expectedPolicyRevision, input.representation)) {
          if (historical !== null) throw new TaskHistoricalRepairPublicationUnavailableError();
          return { status: "stale" };
        }
        await this.#productRow(transaction, input.coordinate, true);
      }
      if (historical !== null) {
        const policy = await this.#lockedPublicationPolicy(transaction);
        if (!this.#publicationPolicyMatches(policy, authority.expectedPolicyRevision, "dual")) {
          throw new TaskHistoricalRepairPublicationUnavailableError();
        }
        if (!await this.#verifyHistoricalSource!(transaction, Object.freeze({
          coordinate: Object.freeze({ ...input.coordinate }),
          requesterHumanId: input.requesterHumanId, namespaceId: input.namespaceId,
          currentAuthority: Object.freeze({ ...authority }), provenance: historical,
          phase: "reservation",
        }))) throw new TaskHistoricalRepairPublicationUnavailableError();
      }
      let stagedIntent: ProtectedTaskCancellationOutputIntent | null = null;
      if (this.#verifyStagedCancellation !== undefined && isCancellationPublication(input)) {
        const policy = await this.#lockedPublicationPolicy(transaction);
        await this.#lockResultProduct(transaction, input.coordinate as TaskRunResultContentCoordinateV1);
        stagedIntent = await this.#stagedIntent({ ...input, currentAuthority: authority });
        if (stagedIntent !== null
          && !this.#publicationPolicyMatches(policy, authority.expectedPolicyRevision, input.representation)) {
          return { status: "stale" };
        }
      }
      const operations = await this.#operationRows(transaction, input.operationId, true);
      if (operations.length > 0) {
        if (operations.length !== 1) return { status: "conflict" };
        const row = operations[0]!;
        const kind = text(row, "kind") as LedgerKind;
        const lifecycle = lifecycleFromRow(kind, row);
        if (!exactReservation(lifecycle, input)) return { status: "conflict" };
        return {
          status: "replayed",
          state: await this.#stateFromLifecycle(transaction, lifecycle, authority, false),
        };
      }
      if (!sameBytes(
        fingerprintTaskContentAuthorityV1(authority),
        input.authorityFingerprint,
      ) && stagedIntent === null && historical?.version !== 2) return { status: "stale" };
      if (await this.#coordinateRow(transaction, input.coordinate, true) !== null) {
        return { status: "conflict" };
      }
      const requesterOwnerId = await this.#requesterOwnerId(
        transaction,
        input.requesterHumanId,
      );
      if (requesterOwnerId === null
        || (stagedIntent !== null && stagedIntent.requesterUserId !== requesterOwnerId)
        || !await this.#predecessorIsCurrent(transaction, input, requesterOwnerId, stagedIntent?.policyRevision ?? authority.expectedPolicyRevision, stagedIntent)) {
        return { status: "stale" };
      }
      // A leased publisher must recheck after acquiring the product locks.
      // Recovery uses these same locks when proving that no reservation exists.
      await this.#assertReservationCurrent?.(Object.freeze({ ...input.coordinate }));
      const inserted = await this.#insertLifecycle(transaction, input);
      if (inserted === null) return { status: "conflict" };
      const lifecycle = lifecycleFromRow(input.coordinate.kind, inserted);
      return {
        status: "reserved",
        state: await this.#stateFromLifecycle(transaction, lifecycle, authority, false),
      };
    }, { isolationLevel: "serializable" });
  }

  async getRevision(coordinate: TaskContentCoordinateV1): Promise<TaskContentRevisionStateV1 | null> {
    assertTaskContentCoordinateV1(coordinate);
    return this.#handle.transaction(async (transaction) => {
      const row = await this.#coordinateRow(transaction, coordinate, false);
      if (row === null) return null;
      const lifecycle = lifecycleFromRow(coordinate.kind, row);
      const authority = await this.#currentAuthority(lifecycle);
      if (authority === null) throw new Error("Current Task content authority is unavailable");
      return this.#stateFromLifecycle(transaction, lifecycle, authority, false);
    }, { isolationLevel: "serializable" });
  }

  async getRevisionByOperation(
    input: Parameters<TaskContentProductStorePort["getRevisionByOperation"]>[0],
  ): ReturnType<TaskContentProductStorePort["getRevisionByOperation"]> {
    if (!PORTABLE_ID.test(input.operationId)
      || new TextEncoder().encode(input.operationId).length > 128) {
      throw new TypeError("Task content operation ID is invalid");
    }
    return this.#handle.transaction(async (transaction) => {
      const rows = await this.#operationRows(transaction, input.operationId, false);
      if (rows.length === 0) return { status: "missing" as const };
      if (rows.length !== 1) return { status: "conflict" as const };
      const row = rows[0]!;
      const kind = text(row, "kind") as LedgerKind;
      const lifecycle = lifecycleFromRow(kind, row);
      const authority = await this.#currentAuthority(lifecycle);
      if (authority === null) return { status: "authority_unavailable" as const };
      return Object.freeze({
        status: "found" as const,
        state: await this.#stateFromLifecycle(
          transaction,
          lifecycle,
          authority,
          false,
        ),
      });
    }, { isolationLevel: "serializable" });
  }

  async markCryptoComplete(
    input: Parameters<TaskContentProductStorePort["markCryptoComplete"]>[0],
  ): ReturnType<TaskContentProductStorePort["markCryptoComplete"]> {
    await this.#assertCoordinateObjectLease(input.coordinate, input.cryptoObjectId, input.leaseToken);
    return this.#handle.transaction(async (transaction) => {
      const row = await this.#lockedLifecycle(transaction, input.coordinate, true);
      if (row === null) return "missing";
      const lifecycle = lifecycleFromRow(input.coordinate.kind, row);
      if (lifecycle.cryptoObjectId !== input.cryptoObjectId
        || !leaseMatches(row, lifecycle, input.leaseToken)
        || !["active", "mapped"].includes(lifecycle.disposition)) return "conflict";
      if (lifecycle.completion === "complete") return "duplicate";
      const updated = await this.#updateLifecycle(transaction, input.coordinate, {
        completion: "complete", cryptoCompletedAt: sql`CURRENT_TIMESTAMP`, updatedAt: sql`CURRENT_TIMESTAMP`,
      }, and(this.#coordinateWhere(input.coordinate), eq(this.#table(input.coordinate).cryptoObjectId, input.cryptoObjectId), sql`${this.#table(input.coordinate).leaseToken} IS NOT DISTINCT FROM ${input.leaseToken}::uuid`));
      return updated ? "applied" : "conflict";
    }, { isolationLevel: "serializable" });
  }

  async compareAndSwapCryptoMapping(
    input: Parameters<TaskContentProductStorePort["compareAndSwapCryptoMapping"]>[0],
  ): ReturnType<TaskContentProductStorePort["compareAndSwapCryptoMapping"]> {
    await this.#assertCoordinateObjectLease(input.coordinate, input.cryptoObjectId, input.leaseToken);
    assertDigest("Expected Task authority fingerprint", input.expectedAuthorityFingerprint);
    if (input.expectedRepresentation !== "protected" && input.expectedRepresentation !== "dual") {
      throw new TypeError("Expected Task representation is invalid");
    }
    if (input.foregroundDefinitionProof !== undefined && (input.coordinate.kind !== "definition"
      || isVerifiedMappedTaskContentMetadataProof(input.foregroundDefinitionProof))) {
      throw new TypeError("Foreground definition proof cannot authorize metadata mapping");
    }
    const metadataHead = input.mappedMetadataProof !== undefined;
    if (metadataHead && (input.foregroundDefinitionProof !== undefined || input.historicalStagedPrepared !== undefined
      || !isVerifiedMappedTaskContentMetadataProof(input.mappedMetadataProof))) {
      throw new TypeError("Mapped metadata proof must be authentic and exclusive");
    }
    const inspectedProof = input.mappedMetadataProof ?? input.foregroundDefinitionProof;
    const observed = await this.#readLifecycle(input.coordinate);
    if (observed === null) return "missing";
    if (observed.historicalRepair != null && !metadataHead && this.#verifyHistoricalSource === undefined) {
      throw new TaskHistoricalRepairPublicationUnavailableError();
    }
    const resolvedAuthority = await this.#currentAuthority(observed);
    const observedResult = input.coordinate.kind === "run_result" ? observed : null;
    const resolvedResultAuthority = input.coordinate.kind === "run_result" ? resolvedAuthority : null;
    return this.#handle.transaction(async (transaction) => {
      if (input.coordinate.kind === "definition") {
        const policy = await this.#lockedPublicationPolicy(transaction);
        if (resolvedAuthority !== null
          && !this.#publicationPolicyMatches(policy, resolvedAuthority.expectedPolicyRevision, input.expectedRepresentation)) {
          if (observed.historicalRepair != null) throw new TaskHistoricalRepairPublicationUnavailableError();
          return "wrong_authority";
        }
        await this.#productRow(transaction, input.coordinate, true);
      }
      const lockedResultPublicationPolicy = input.coordinate.kind === "run_result"
        ? await this.#lockedPublicationPolicy(transaction)
        : null;
      const lockedResult = input.coordinate.kind === "run_result"
        ? await this.#lockResultProduct(transaction, input.coordinate)
        : null;
      const stagedIntent = observedResult !== null && resolvedResultAuthority !== null
        ? await this.#stagedIntent({ ...observedResult, currentAuthority: resolvedResultAuthority })
        : null;
      const row = await this.#lockedLifecycle(transaction, input.coordinate, true);
      if (row === null) return "missing";
      const lifecycle = lifecycleFromRow(input.coordinate.kind, row);
      if (lifecycle.historicalRepair != null && !metadataHead && this.#verifyHistoricalSource === undefined) {
        throw new TaskHistoricalRepairPublicationUnavailableError();
      }
      if (!leaseMatches(row, lifecycle, input.leaseToken)) return "lease_lost";
      if (lifecycle.cryptoObjectId !== input.cryptoObjectId
        || lifecycle.representation !== input.expectedRepresentation
        || lifecycle.completion !== "complete"
        || !["active", "mapped"].includes(lifecycle.disposition)) return "stale";
      if (!sameAuthorityResolutionLifecycle(observed, lifecycle)) {
        return "stale";
      }
      const current = resolvedAuthority;
      if (current === null
        || !this.#authorityIdentityMatches(
          current,
          lifecycle.requesterHumanId,
          lifecycle.namespaceId,
        )
        || !sameBytes(input.expectedAuthorityFingerprint, lifecycle.authorityFingerprint)) {
        if (lifecycle.disposition === "active") await this.#persistAuthorityStale(transaction, lifecycle);
        return "wrong_authority";
      }
      const foregroundAccessRevision = inspectedProof === undefined ? null
        : readVerifiedForegroundTaskDefinitionAccessRevision(inspectedProof, { lifecycle, currentAuthority: current });
      if (foregroundAccessRevision !== null && !await this.#lockPublicationPolicy(transaction, current.expectedPolicyRevision, lifecycle.representation)) return "wrong_authority";
      const inspectedAccessRevision = input.historicalStagedPrepared === undefined ? foregroundAccessRevision
        : lifecycle.historicalRepair?.version !== 2
          ? (() => { throw new TypeError("Inspected historical head requires version-two provenance"); })()
          : readInspectedHistoricalTaskContentAccessRevision(input.historicalStagedPrepared, {
            coordinate: lifecycle.coordinate, objectId: lifecycle.cryptoObjectId,
            currentAuthority: current, provenance: lifecycle.historicalRepair,
          });
      const exactCurrentAuthority = sameBytes(
        fingerprintTaskContentAuthorityV1(current),
        lifecycle.authorityFingerprint,
      );
      const requesterOwnerId = await this.#requesterOwnerId(
        transaction,
        lifecycle.requesterHumanId,
      );
      if (requesterOwnerId === null) {
        if (lifecycle.disposition === "active") {
          await this.#persistAuthorityStale(transaction, lifecycle);
        }
        return "wrong_authority";
      }
      if (lifecycle.historicalRepair != null && !metadataHead
        && !await this.#verifyHistoricalSource!(transaction, Object.freeze({
          coordinate: Object.freeze({ ...lifecycle.coordinate }),
          requesterHumanId: lifecycle.requesterHumanId, namespaceId: lifecycle.namespaceId,
          currentAuthority: Object.freeze({ ...current }), provenance: lifecycle.historicalRepair,
          phase: "mapping",
        }))) throw new TaskHistoricalRepairPublicationUnavailableError();
      const result = input.coordinate.kind === "definition"
        ? await this.#mapDefinition(
          transaction,
          lifecycle,
          exactCurrentAuthority || foregroundAccessRevision !== null,
          requesterOwnerId,
          current.expectedPolicyRevision,
          inspectedAccessRevision,
          inspectedProof,
          current,
        )
        : await this.#mapResult(
          transaction,
          lifecycle,
          exactCurrentAuthority,
          requesterOwnerId,
          current.expectedPolicyRevision,
          lockedResult,
          lockedResultPublicationPolicy,
          stagedIntent,
          inspectedAccessRevision,
          metadataHead,
        );
      if (result === "wrong_authority") {
        if (lifecycle.disposition === "active") await this.#persistAuthorityStale(transaction, lifecycle);
        return result;
      }
      if (result !== "applied" && result !== "duplicate") {
        if (lifecycle.disposition === "active") await this.#persistStaleMapping(transaction, lifecycle);
        return result;
      }
      // A verified access-head refresh preserves the immutable mapped ledger.
      if (lifecycle.disposition === "mapped" && foregroundAccessRevision !== null) return result;
      const mapped = await this.#updateLifecycle(transaction, lifecycle.coordinate, {
        disposition: "mapped", failureCode: null, nextAttemptAt: null,
        leaseToken: null, leaseExpiresAt: null, updatedAt: sql`CURRENT_TIMESTAMP`,
      });
      if (!mapped) throw new Error("Task content mapping lost its lifecycle CAS");
      return result;
    }, { isolationLevel: "serializable" });
  }

  async quarantineRevision(
    input: Parameters<TaskContentProductStorePort["quarantineRevision"]>[0],
  ): ReturnType<TaskContentProductStorePort["quarantineRevision"]> {
    assertTaskContentCoordinateV1(input.coordinate);
    assertFailureCode(input.failureCode);
    if (input.failureCode === "retry_exhausted") throw new TypeError("retry_exhausted is reserved for the final failed claim");
    if (input.leaseToken !== null) assertUuid("Task content lease token", input.leaseToken);
    return this.#terminalTransition(input.coordinate, input.leaseToken, "quarantined", input.failureCode);
  }

  async markAuthorityStale(
    input: Parameters<TaskContentProductStorePort["markAuthorityStale"]>[0],
  ): ReturnType<TaskContentProductStorePort["markAuthorityStale"]> {
    assertTaskContentCoordinateV1(input.coordinate);
    if (input.leaseToken !== null) assertUuid("Task content lease token", input.leaseToken);
    return this.#handle.transaction(async (transaction) => {
      const row = await this.#lockedLifecycle(transaction, input.coordinate, true);
      if (row === null) return null;
      const lifecycle = lifecycleFromRow(input.coordinate.kind, row);
      const targetDisposition = lifecycle.completion === "complete"
        ? "stale_mapping" : "quarantined";
      if (lifecycle.disposition === targetDisposition
        && lifecycle.failureCode === "authority_stale") return lifecycle;
      if (!leaseMatches(row, lifecycle, input.leaseToken)
        || lifecycle.disposition !== "active") return null;
      const updated = await this.#updateLifecycleReturning(transaction, input.coordinate, {
        disposition: targetDisposition, failureCode: "authority_stale",
        nextAttemptAt: null, leaseToken: null, leaseExpiresAt: null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      }, and(this.#coordinateWhere(input.coordinate),
        eq(this.#table(input.coordinate).disposition, "active"),
        sql`${this.#table(input.coordinate).leaseToken} IS NOT DISTINCT FROM ${input.leaseToken}::uuid`));
      return updated === null ? null : lifecycleFromRow(input.coordinate.kind, updated);
    }, { isolationLevel: "serializable" });
  }

  async claimReconciliationCandidates(
    input: Parameters<TaskContentProductStorePort["claimReconciliationCandidates"]>[0],
  ): ReturnType<TaskContentProductStorePort["claimReconciliationCandidates"]> {
    assertUuid("Task content lease token", input.leaseToken);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > TASK_CONTENT_RECONCILE_MAX_BATCH) {
      throw new RangeError("Task content claim limit is out of bounds");
    }
    return this.#handle.transaction(async (transaction) => {
      const candidates = [
        ...await this.#dueRows(transaction, "definition", input.limit),
        ...await this.#dueRows(transaction, "run_result", input.limit),
      ].sort((left, right) => {
        const leftTime = date(left, "next_attempt_at")?.getTime() ?? Number.NEGATIVE_INFINITY;
        const rightTime = date(right, "next_attempt_at")?.getTime() ?? Number.NEGATIVE_INFINITY;
        return leftTime - rightTime
          || text(left, "kind").localeCompare(text(right, "kind"))
          || integer(left, "sequence") - integer(right, "sequence");
      }).slice(0, input.limit);
      const states: TaskContentRevisionStateV1[] = [];
      for (const candidate of candidates) {
        const kind = text(candidate, "kind") as LedgerKind;
        const coordinate = coordinateFromRow(kind, candidate);
        const claimed = await this.#updateLifecycle(transaction, coordinate, {
          leaseToken: input.leaseToken,
          leaseExpiresAt: taskContentReconciliationLeaseExpiry(),
          updatedAt: sql`CURRENT_TIMESTAMP`,
        }, and(this.#coordinateWhere(coordinate), eq(this.#table(coordinate).disposition, "active"), or(isNull(this.#table(coordinate).leaseToken), lte(this.#table(coordinate).leaseExpiresAt, sql`CURRENT_TIMESTAMP`))));
        if (!claimed) continue;
        const row = await this.#coordinateRow(transaction, coordinate, false);
        if (row === null) throw new Error("Claimed Task content lifecycle disappeared");
        const lifecycle = lifecycleFromRow(kind, row);
        const authority = await this.#currentAuthority(lifecycle);
        if (authority === null) {
          await this.#persistAuthorityStale(transaction, lifecycle);
          continue;
        }
        states.push(await this.#stateFromLifecycle(transaction, lifecycle, authority, false));
      }
      return Object.freeze(states);
    }, { isolationLevel: "read committed" });
  }

  async claimReconciliationCoordinate(
    input: Parameters<NonNullable<
      TaskContentProductStorePort["claimReconciliationCoordinate"]
    >>[0],
  ): Promise<TaskContentRevisionStateV1 | null> {
    assertTaskContentCoordinateV1(input.coordinate);
    assertUuid("Task content lease token", input.leaseToken);
    if (!PORTABLE_ID.test(input.operationId)
      || new TextEncoder().encode(input.operationId).length > 128) {
      throw new TypeError("Task content operation ID is invalid");
    }
    const coordinate: TaskContentCoordinateV1 = Object.freeze({
      ...input.coordinate,
    });
    const observed = await this.#readLifecycle(coordinate);
    if (observed === null || observed.operationId !== input.operationId) {
      return null;
    }
    const resolvedAuthority = await this.#currentAuthority(observed);
    return this.#handle.transaction(async (transaction) => {
      const row = await this.#lockedLifecycle(transaction, coordinate, true);
      if (row === null) return null;
      let lifecycle = lifecycleFromRow(coordinate.kind, row);
      if (
        lifecycle.operationId !== input.operationId
        || !sameAuthorityResolutionLifecycle(observed, lifecycle)
      ) return null;

      if (lifecycle.disposition === "mapped") {
        return resolvedAuthority === null
          ? null
          : this.#stateFromLifecycle(
            transaction,
            lifecycle,
            resolvedAuthority,
            false,
          );
      }
      if (lifecycle.disposition !== "active") return null;
      if (
        lifecycle.leaseToken === input.leaseToken
        && bool(row, "lease_is_live")
      ) {
        if (resolvedAuthority === null) {
          await this.#persistAuthorityStale(transaction, lifecycle);
          return null;
        }
        return this.#stateFromLifecycle(
          transaction,
          lifecycle,
          resolvedAuthority,
          false,
        );
      }

      const table = this.#table(coordinate);
      const claimed = await this.#updateLifecycleReturning(
        transaction,
        coordinate,
        {
          leaseToken: input.leaseToken,
          leaseExpiresAt: taskContentReconciliationLeaseExpiry(),
          updatedAt: sql`CURRENT_TIMESTAMP`,
        },
        and(
          this.#coordinateWhere(coordinate),
          eq(table.operationId, input.operationId),
          eq(table.disposition, "active"),
          lt(table.attemptCount, TASK_CONTENT_RECONCILE_MAX_ATTEMPTS),
          lte(table.nextAttemptAt, sql`CURRENT_TIMESTAMP`),
          or(
            isNull(table.leaseToken),
            lte(table.leaseExpiresAt, sql`CURRENT_TIMESTAMP`),
          ),
        ),
      );
      if (claimed === null) return null;
      lifecycle = lifecycleFromRow(coordinate.kind, claimed);
      if (resolvedAuthority === null) {
        await this.#persistAuthorityStale(transaction, lifecycle);
        return null;
      }
      return this.#stateFromLifecycle(
        transaction,
        lifecycle,
        resolvedAuthority,
        false,
      );
    }, { isolationLevel: "read committed" });
  }

  async failReconciliationClaim(
    input: Parameters<TaskContentProductStorePort["failReconciliationClaim"]>[0],
  ): ReturnType<TaskContentProductStorePort["failReconciliationClaim"]> {
    assertTaskContentCoordinateV1(input.coordinate);
    assertUuid("Task content lease token", input.leaseToken);
    assertFailureCode(input.failureCode);
    if (input.failureCode === "retry_exhausted") throw new TypeError("retry_exhausted is reserved for the final failed claim");
    return this.#handle.transaction(async (transaction) => {
      const table = this.#table(input.coordinate);
      const row = await this.#updateLifecycleReturning(transaction, input.coordinate,
        taskContentReconciliationFailureValues(table.attemptCount), and(this.#coordinateWhere(input.coordinate), eq(table.leaseToken, input.leaseToken), sql`${table.leaseExpiresAt} > CURRENT_TIMESTAMP`, eq(table.disposition, "active"), sql`${table.attemptCount} < ${TASK_CONTENT_RECONCILE_MAX_ATTEMPTS}`));
      return row === null ? null : lifecycleFromRow(input.coordinate.kind, row);
    }, { isolationLevel: "serializable" });
  }

  #assertReservation(input: Parameters<TaskContentProductStorePort["reserveRevision"]>[0]): void {
    assertTaskContentCoordinateV1(input.coordinate);
    assertUuid("Task requester Human ID", input.requesterHumanId);
    assertUuid("Task content Namespace ID", input.namespaceId);
    assertDigest("Task request digest", input.requestDigest);
    assertDigest("Task authority fingerprint", input.authorityFingerprint);
    assertDigest("Task Namespace fingerprint", input.requiredNamespaceFingerprint);
    if (input.coordinate.kind === "definition") {
      assertProtectedTaskOperationalMetadataProjectionV1(
        input.operationalMetadata,
      );
    } else if (input.operationalMetadata !== null) {
      throw new TypeError("Task content operational metadata is invalid");
    }
    if (input.fallbackRepairSource !== undefined) {
      const source = input.fallbackRepairSource;
      if (!isTaskOrdinaryFallbackRepairSourceProofV1(source)
        || input.historicalPrepared !== undefined
        || input.coordinate.kind !== "definition"
        || input.representation !== "dual"
        || input.coordinate.taskId !== source.taskId
        || input.coordinate.contentRevision !== source.sourceContentRevision + 1
        || input.namespaceId !== source.sourceNamespaceId) {
        throw new TypeError("Fallback Task repair reservation is invalid");
      }
    }
    if (!PORTABLE_ID.test(input.operationId)
      || new TextEncoder().encode(input.operationId).length > 128) {
      throw new TypeError("Task content operation ID is invalid");
    }
    if (input.cryptoObjectId !== taskContentRevisionObjectIdV1({
      coordinate: input.coordinate, namespaceId: input.namespaceId,
      historicalRepair: input.historicalPrepared === undefined ? null
        : preparedTaskHistoricalRepairProvenanceV1(input.historicalPrepared),
    })
      || input.objectType !== taskContentObjectTypeV1(input.coordinate)
      || input.payloadVersion !== TASK_CONTENT_PAYLOAD_VERSION_V1
      || !sameBytes(input.requiredNamespaceFingerprint, fingerprintTaskContentNamespaceV1(input.namespaceId))) {
      throw new TypeError("Task content reservation coordinates are not canonical");
    }
  }

  async #assertCoordinateObjectLease(coordinate: TaskContentCoordinateV1, objectId: string, leaseToken: string | null): Promise<void> {
    assertTaskContentCoordinateV1(coordinate);
    if (leaseToken !== null) assertUuid("Task content lease token", leaseToken);
    if (objectId === deriveTaskContentCryptoObjectIdV1(coordinate)) return;
    // Historical identity comes only from the exact immutable product ledger;
    // accepting a prefix alone would allow a generic publisher to adopt it.
    const lifecycle = await this.#readLifecycle(coordinate);
    if (lifecycle?.historicalRepair?.version !== 2
      || objectId !== lifecycle.cryptoObjectId
      || objectId !== taskContentRevisionObjectIdV1(lifecycle)) {
      throw new TypeError("Task crypto object ID is not canonical");
    }
  }

  #authorityIdentityMatches(
    authority: TaskContentAuthorityV1,
    requesterHumanId: string,
    namespaceId: string,
  ): boolean {
    return sameBytes(
      fingerprintTaskContentAuthorityIdentityV1(authority),
      fingerprintTaskContentAuthorityIdentityV1({
        requesterHumanId,
        namespaceId,
        keyClass: "ai",
      }),
    );
  }

  #currentAuthority(lifecycle: TaskContentRevisionLifecycleV1): Promise<TaskContentAuthorityV1 | null> {
    return Promise.resolve(this.#resolveCurrentAuthority({
      requesterHumanId: lifecycle.requesterHumanId,
      namespaceId: lifecycle.namespaceId,
    }));
  }

  async #requesterOwnerId(
    transaction: ConversationProductPostgresTransaction,
    requesterHumanId: string,
  ): Promise<string | null> {
    const rows = await executeTypedConversationProductQuery(
      transaction,
      conversationProductTypedDb.select({ owner_id: actors.ownerId })
        .from(actors)
        .where(and(eq(actors.id, requesterHumanId), eq(actors.kind, "user")))
        .for("share", { of: actors })
        .limit(2),
    );
    const row = oneOrNone(rows, "Task requester Human owner lookup");
    return row === null ? null : text(row, "owner_id");
  }

  #table(coordinate: TaskContentCoordinateV1) {
    return coordinate.kind === "definition" ? taskDefinitionCryptoRevisions : taskRunResultCryptoRevisions;
  }

  #coordinateWhere(coordinate: TaskContentCoordinateV1) {
    return coordinate.kind === "definition"
      ? and(eq(taskDefinitionCryptoRevisions.taskId, coordinate.taskId), eq(taskDefinitionCryptoRevisions.contentRevision, coordinate.contentRevision))
      : and(eq(taskRunResultCryptoRevisions.taskId, coordinate.taskId), eq(taskRunResultCryptoRevisions.taskRunId, coordinate.taskRunId), eq(taskRunResultCryptoRevisions.resultRevision, coordinate.contentRevision));
  }

  async #operationRows(transaction: ConversationProductPostgresTransaction, operationId: string, lock: boolean): Promise<readonly ConversationProductDatabaseRow[]> {
    const definitions = conversationProductTypedDb.select({ kind: sql<string>`'definition'`.as("kind"), ...this.#definitionSelection() }).from(taskDefinitionCryptoRevisions).where(eq(taskDefinitionCryptoRevisions.operationId, operationId)).limit(2);
    const results = conversationProductTypedDb.select({ kind: sql<string>`'run_result'`.as("kind"), ...this.#resultSelection() }).from(taskRunResultCryptoRevisions).where(eq(taskRunResultCryptoRevisions.operationId, operationId)).limit(2);
    return [
      ...await executeTypedConversationProductQuery(transaction, lock ? definitions.for("update") : definitions),
      ...await executeTypedConversationProductQuery(transaction, lock ? results.for("update") : results),
    ];
  }

  async #coordinateRow(transaction: ConversationProductPostgresTransaction, coordinate: TaskContentCoordinateV1, lock: boolean): Promise<ConversationProductDatabaseRow | null> {
    const query = coordinate.kind === "definition"
      ? conversationProductTypedDb.select(this.#definitionSelection()).from(taskDefinitionCryptoRevisions).where(this.#coordinateWhere(coordinate)).limit(2)
      : conversationProductTypedDb.select(this.#resultSelection()).from(taskRunResultCryptoRevisions).where(this.#coordinateWhere(coordinate)).limit(2);
    return oneOrNone(await executeTypedConversationProductQuery(transaction, lock ? query.for("update") : query), "Task content lifecycle lookup");
  }

  #definitionSelection() { return {
    sequence: taskDefinitionCryptoRevisions.sequence, task_id: taskDefinitionCryptoRevisions.taskId,
    content_revision: taskDefinitionCryptoRevisions.contentRevision, operation_id: taskDefinitionCryptoRevisions.operationId,
    request_digest: taskDefinitionCryptoRevisions.requestDigest, authority_fingerprint: taskDefinitionCryptoRevisions.authorityFingerprint,
    requester_human_id: taskDefinitionCryptoRevisions.requesterHumanId, content_namespace_id: taskDefinitionCryptoRevisions.contentNamespaceId,
    crypto_object_id: taskDefinitionCryptoRevisions.cryptoObjectId, payload_version: taskDefinitionCryptoRevisions.payloadVersion,
    representation: taskDefinitionCryptoRevisions.representation, required_namespace_fingerprint: taskDefinitionCryptoRevisions.requiredNamespaceFingerprint,
    historical_repair: sql<string | null>`${taskDefinitionCryptoRevisions.historicalRepair}::text`.as("historical_repair"),
    operational_metadata: sql<string>`${taskDefinitionCryptoRevisions.operationalMetadata}::text`.as("operational_metadata"),
    completion: taskDefinitionCryptoRevisions.completion, disposition: taskDefinitionCryptoRevisions.disposition,
    attempt_count: taskDefinitionCryptoRevisions.attemptCount, next_attempt_at: taskDefinitionCryptoRevisions.nextAttemptAt,
    lease_token: taskDefinitionCryptoRevisions.leaseToken, lease_expires_at: taskDefinitionCryptoRevisions.leaseExpiresAt,
    failure_code: taskDefinitionCryptoRevisions.failureCode, crypto_completed_at: taskDefinitionCryptoRevisions.cryptoCompletedAt,
  } as const; }

  #resultSelection() { return {
    sequence: taskRunResultCryptoRevisions.sequence, task_id: taskRunResultCryptoRevisions.taskId,
    task_run_id: taskRunResultCryptoRevisions.taskRunId, result_revision: taskRunResultCryptoRevisions.resultRevision,
    operation_id: taskRunResultCryptoRevisions.operationId, request_digest: taskRunResultCryptoRevisions.requestDigest,
    authority_fingerprint: taskRunResultCryptoRevisions.authorityFingerprint, requester_human_id: taskRunResultCryptoRevisions.requesterHumanId,
    content_namespace_id: taskRunResultCryptoRevisions.contentNamespaceId, crypto_object_id: taskRunResultCryptoRevisions.cryptoObjectId,
    payload_version: taskRunResultCryptoRevisions.payloadVersion, representation: taskRunResultCryptoRevisions.representation,
    required_namespace_fingerprint: taskRunResultCryptoRevisions.requiredNamespaceFingerprint,
    historical_repair: sql<string | null>`${taskRunResultCryptoRevisions.historicalRepair}::text`.as("historical_repair"),
    completion: taskRunResultCryptoRevisions.completion, disposition: taskRunResultCryptoRevisions.disposition,
    attempt_count: taskRunResultCryptoRevisions.attemptCount, next_attempt_at: taskRunResultCryptoRevisions.nextAttemptAt,
    lease_token: taskRunResultCryptoRevisions.leaseToken, lease_expires_at: taskRunResultCryptoRevisions.leaseExpiresAt,
    failure_code: taskRunResultCryptoRevisions.failureCode, crypto_completed_at: taskRunResultCryptoRevisions.cryptoCompletedAt,
  } as const; }

  async #insertLifecycle(transaction: ConversationProductPostgresTransaction, input: Parameters<TaskContentProductStorePort["reserveRevision"]>[0]): Promise<ConversationProductDatabaseRow | null> {
    const values = {
      taskId: input.coordinate.taskId, contentNamespaceId: input.namespaceId,
      operationId: input.operationId, requestDigest: input.requestDigest,
      authorityFingerprint: input.authorityFingerprint, requesterHumanId: input.requesterHumanId,
      anchorNamespaceId: input.namespaceId, cryptoObjectId: input.cryptoObjectId,
      representation: input.representation, payloadVersion: input.payloadVersion,
      cryptoAccessRevision: 0, requiredNamespaceFingerprint: input.requiredNamespaceFingerprint,
      historicalRepair: input.historicalPrepared === undefined ? null
        : sql`convert_from(${new TextEncoder().encode(JSON.stringify(
          preparedTaskHistoricalRepairProvenanceV1(input.historicalPrepared),
        ))}::bytea, 'UTF8')::jsonb`,
    };
    const query = input.coordinate.kind === "definition"
      ? conversationProductTypedDb.insert(taskDefinitionCryptoRevisions).values({
        ...values,
        contentRevision: input.coordinate.contentRevision,
        operationalMetadata: sql`convert_from(${new TextEncoder().encode(JSON.stringify(input.operationalMetadata ?? {}))}::bytea, 'UTF8')::jsonb`,
      }).returning(this.#definitionSelection())
      : conversationProductTypedDb.insert(taskRunResultCryptoRevisions).values({ ...values, taskRunId: input.coordinate.taskRunId, resultRevision: input.coordinate.contentRevision }).returning(this.#resultSelection());
    return oneOrNone(await executeTypedConversationProductQuery(transaction, query), "Task content reservation insert");
  }

  async #stagedIntent(expected: StagedTaskCancellationPublicationProofInput): Promise<ProtectedTaskCancellationOutputIntent | null> {
    if (this.#verifyStagedCancellation === undefined || !isCancellationPublication(expected)) return null;
    const exact = Object.freeze({ ...expected, coordinate: Object.freeze({ ...expected.coordinate }),
      requestDigest: expected.requestDigest.slice(), authorityFingerprint: expected.authorityFingerprint.slice(),
      currentAuthority: Object.freeze({ ...expected.currentAuthority }) });
    const proof = await this.#verifyStagedCancellation(Object.freeze({ ...exact,
      requestDigest: exact.requestDigest.slice(), authorityFingerprint: exact.authorityFingerprint.slice() }));
    if (proof === null || verifiedStagedCancellationPolicyRevision(proof, exact) === null) return null;
    return Object.freeze({ ...proof.intent, terminalAt: new Date(proof.intent.terminalAt) });
  }

  async #predecessorIsCurrent(
    transaction: ConversationProductPostgresTransaction,
    input: Parameters<TaskContentProductStorePort["reserveRevision"]>[0],
    requesterOwnerId: string,
    expectedPolicyRevision: number,
    stagedIntent: ProtectedTaskCancellationOutputIntent | null = null,
  ): Promise<boolean> {
    if (input.coordinate.kind === "definition") {
      const rows = await executeTypedConversationProductQuery(transaction, conversationProductTypedDb.select({
        owner_id: tasks.ownerId,
        requestor_id: tasks.requestorId,
        mutation_version: sql<string>`${tasks}.xmin::text`.as("mutation_version"),
        task_status: sql<string>`${tasks.status}`.as("task_status"),
        fire_lock_id: tasks.fireLockId,
        content_namespace_id: tasks.contentNamespaceId,
        content_revision: tasks.contentRevision, content_representation: tasks.contentRepresentation,
        crypto_object_id: tasks.cryptoObjectId,
        crypto_access_revision: tasks.cryptoAccessRevision,
        crypto_required_namespace_fingerprint: tasks.cryptoRequiredNamespaceFingerprint,
        crypto_mapping_state: tasks.cryptoMappingState,
        ordinary_fallback_operation_id: tasks.ordinaryFallbackOperationId,
        ordinary_fallback_request_digest: tasks.ordinaryFallbackRequestDigest,
        ordinary_fallback_reason: tasks.ordinaryFallbackReason,
        ordinary_fallback_policy_revision: tasks.ordinaryFallbackPolicyRevision,
        ordinary_fallback_completed_at: tasks.ordinaryFallbackCompletedAt,
        updated_at: tasks.updatedAt,
      }).from(tasks).where(eq(tasks.id, input.coordinate.taskId)).for("update").limit(2));
      const row = oneOrNone(rows, "Task predecessor lookup");
      if (input.coordinate.contentRevision === 1) {
        if (input.historicalPrepared !== undefined) {
          return row !== null && text(row, "requestor_id") === requesterOwnerId
            && ["pending", "paused", "completed", "errored", "cancelled"]
              .includes(text(row, "task_status"))
            && nullableText(row, "fire_lock_id") === null
            && integer(row, "content_revision") === 0
            && nullableText(row, "content_namespace_id") === null
            && text(row, "content_representation") === "ordinary";
        }
        return row === null || (text(row, "requestor_id") === requesterOwnerId
          && inAllowedDefinitionStatus(row)
          && nullableText(row, "fire_lock_id") === null
          && integer(row, "content_revision") === 0
          && nullableText(row, "content_namespace_id") === null
          && text(row, "content_representation") === "ordinary");
      }
      if (input.fallbackRepairSource !== undefined) {
        return this.#fallbackRepairPredecessorIsCurrent(
          transaction,
          row,
          input,
          requesterOwnerId,
        );
      }
      return row !== null && text(row, "owner_id") === requesterOwnerId
        && text(row, "requestor_id") === requesterOwnerId
        && inAllowedDefinitionStatus(row)
        && nullableText(row, "fire_lock_id") === null
        && nullableText(row, "content_namespace_id") === input.namespaceId
        && integer(row, "content_revision") === input.coordinate.contentRevision - 1
        && ["protected", "dual"].includes(text(row, "content_representation"))
        && nullableText(row, "crypto_object_id") !== null
        && nullableBytes(row, "crypto_required_namespace_fingerprint") !== null
        && text(row, "crypto_mapping_state") === "verified";
    }
    const rows = await executeTypedConversationProductQuery(transaction, conversationProductTypedDb.select({
      task_id: taskRuns.taskId, result_revision: taskRuns.resultRevision,
      result_content_namespace_id: taskRuns.resultContentNamespaceId,
      result_representation: taskRuns.resultRepresentation,
      result_crypto_object_id: taskRuns.resultCryptoObjectId,
      result_crypto_required_namespace_fingerprint: taskRuns.resultCryptoRequiredNamespaceFingerprint,
      result_crypto_mapping_state: taskRuns.resultCryptoMappingState,
      run_status: sql<string>`${taskRuns.status}`.as("run_status"),
      owner_id: tasks.ownerId,
      requestor_id: tasks.requestorId,
      task_status: sql<string>`${tasks.status}`.as("task_status"),
      parent_namespace_id: sql<string | null>`${tasks.contentNamespaceId}`.as("parent_namespace_id"),
    }).from(taskRuns).innerJoin(tasks, eq(tasks.id, taskRuns.taskId)).where(eq(taskRuns.id, input.coordinate.taskRunId)).for("update", { of: taskRuns }).limit(2));
    const row = oneOrNone(rows, "Task result predecessor lookup");
    if (row === null || text(row, "task_id") !== input.coordinate.taskId
      || text(row, "owner_id") !== requesterOwnerId
      || text(row, "requestor_id") !== requesterOwnerId
      || nullableText(row, "parent_namespace_id") !== input.namespaceId) return false;
    const previous = integer(row, "result_revision");
    if (input.historicalPrepared !== undefined) {
      return input.coordinate.contentRevision === 1 && previous === 0
        && ["completed", "errored", "cancelled"].includes(text(row, "run_status"))
        && text(row, "result_representation") === "ordinary"
        && nullableText(row, "result_content_namespace_id") === null;
    }
    if (text(row, "task_status") === "cancelled" || text(row, "run_status") === "cancelled") {
      return text(row, "task_status") === "cancelled" && text(row, "run_status") === "cancelled"
        && previous === 0 && text(row, "result_representation") === "ordinary"
        && nullableText(row, "result_content_namespace_id") === null
        && await this.#exactCancellationIntent(transaction, input.coordinate, input.operationId, input.cryptoObjectId, input.representation, expectedPolicyRevision, stagedIntent);
    }
    return previous === input.coordinate.contentRevision - 1
      && (previous === 0
        ? nullableText(row, "result_content_namespace_id") === null
          && text(row, "result_representation") === "ordinary"
        : nullableText(row, "result_content_namespace_id") === input.namespaceId
          && ["protected", "dual"].includes(text(row, "result_representation"))
          && nullableText(row, "result_crypto_object_id") !== null
          && nullableBytes(row, "result_crypto_required_namespace_fingerprint") !== null
          && text(row, "result_crypto_mapping_state") === "verified");
  }

  async #fallbackRepairPredecessorIsCurrent(
    transaction: ConversationProductPostgresTransaction,
    row: ConversationProductDatabaseRow | null,
    input: Parameters<TaskContentProductStorePort["reserveRevision"]>[0],
    requesterOwnerId: string,
  ): Promise<boolean> {
    const source = input.fallbackRepairSource;
    if (source === undefined
      || !isTaskOrdinaryFallbackRepairSourceProofV1(source)
      || row === null
      || input.coordinate.kind !== "definition"
      || input.historicalPrepared !== undefined
      || input.representation !== "dual"
      || input.coordinate.taskId !== source.taskId
      || input.coordinate.contentRevision !== source.sourceContentRevision + 1
      || input.namespaceId !== source.sourceNamespaceId
      || text(row, "owner_id") !== requesterOwnerId
      || text(row, "requestor_id") !== requesterOwnerId
      || !inAllowedDefinitionStatus(row)
      || nullableText(row, "fire_lock_id") !== null
      || text(row, "mutation_version") !== source.sourceMutationVersion
      || integer(row, "content_revision") !== source.sourceContentRevision
      || nullableText(row, "content_namespace_id") !== source.sourceNamespaceId
      || text(row, "content_representation") !== "dual"
      || nullableText(row, "crypto_object_id") !== source.sourceCryptoObjectId
      || integer(row, "crypto_access_revision") !== source.sourceCryptoAccessRevision
      || !sameBytes(
        nullableBytes(row, "crypto_required_namespace_fingerprint")
          ?? new Uint8Array(),
        source.sourceRequiredNamespaceFingerprint,
      )
      || text(row, "crypto_mapping_state") !== "stale"
      || !hasFallbackReceiptRow(row)
      || nullableText(row, "ordinary_fallback_operation_id")
        !== source.fallbackOperationId
      || !sameBytes(
        nullableBytes(row, "ordinary_fallback_request_digest")
          ?? new Uint8Array(),
        source.fallbackRequestDigest,
      )
      || integer(row, "ordinary_fallback_policy_revision")
        !== source.fallbackPolicyRevision
      || date(row, "ordinary_fallback_completed_at")?.getTime()
        !== source.fallbackCompletedAt.getTime()
      || date(row, "updated_at")?.getTime() !== source.sourceUpdatedAt.getTime()) {
      return false;
    }
    const predecessor = await this.#coordinateRow(transaction, {
      kind: "definition",
      taskId: source.taskId,
      contentRevision: source.sourceContentRevision,
    }, true);
    if (predecessor === null) return false;
    const lifecycle = lifecycleFromRow("definition", predecessor);
    return lifecycle.completion === "complete"
      && lifecycle.disposition === "mapped"
      && lifecycle.representation === "dual"
      && lifecycle.namespaceId === source.sourceNamespaceId
      && lifecycle.cryptoObjectId === source.sourceCryptoObjectId
      && sameBytes(
        lifecycle.requiredNamespaceFingerprint,
        source.sourceRequiredNamespaceFingerprint,
      );
  }

  async #productRow(transaction: ConversationProductPostgresTransaction, coordinate: TaskContentCoordinateV1, lock: boolean): Promise<ConversationProductDatabaseRow | null> {
    const query = coordinate.kind === "definition"
      ? conversationProductTypedDb.select({ task_id: sql<string>`${tasks.id}`.as("task_id"), owner_id: tasks.ownerId, requestor_id: tasks.requestorId, task_status: sql<string>`${tasks.status}`.as("task_status"), prompt: tasks.prompt, expected_output: tasks.expectedOutput, last_error: tasks.lastError, metadata_json: sql<string>`${tasks.metadata}::text`.as("metadata_json"), content_revision: tasks.contentRevision, content_namespace_id: tasks.contentNamespaceId, content_representation: tasks.contentRepresentation, crypto_object_id: tasks.cryptoObjectId, crypto_access_revision: tasks.cryptoAccessRevision, crypto_required_namespace_fingerprint: tasks.cryptoRequiredNamespaceFingerprint, crypto_mapping_state: tasks.cryptoMappingState, ordinary_fallback_operation_id: tasks.ordinaryFallbackOperationId, ordinary_fallback_request_digest: tasks.ordinaryFallbackRequestDigest, ordinary_fallback_reason: tasks.ordinaryFallbackReason, ordinary_fallback_policy_revision: tasks.ordinaryFallbackPolicyRevision, ordinary_fallback_completed_at: tasks.ordinaryFallbackCompletedAt }).from(tasks).where(eq(tasks.id, coordinate.taskId)).limit(2)
      : conversationProductTypedDb.select({ task_id: taskRuns.taskId, task_run_id: sql<string>`${taskRuns.id}`.as("task_run_id"), run_status: sql<string>`${taskRuns.status}`.as("run_status"), result_revision: taskRuns.resultRevision, result_content_namespace_id: taskRuns.resultContentNamespaceId, result_representation: taskRuns.resultRepresentation, crypto_object_id: sql<string | null>`${taskRuns.resultCryptoObjectId}`.as("crypto_object_id"), crypto_access_revision: sql<number>`${taskRuns.resultCryptoAccessRevision}`.as("crypto_access_revision"), crypto_required_namespace_fingerprint: sql<Uint8Array | null>`${taskRuns.resultCryptoRequiredNamespaceFingerprint}`.as("crypto_required_namespace_fingerprint"), crypto_mapping_state: sql<string>`${taskRuns.resultCryptoMappingState}`.as("crypto_mapping_state") }).from(taskRuns).where(and(eq(taskRuns.id, coordinate.taskRunId), eq(taskRuns.taskId, coordinate.taskId))).limit(2);
    return oneOrNone(await executeTypedConversationProductQuery(transaction, lock ? query.for("update") : query), "Task content product lookup");
  }

  async #stateFromLifecycle(transaction: ConversationProductPostgresTransaction, lifecycle: TaskContentRevisionLifecycleV1, authority: TaskContentAuthorityV1, lock: boolean): Promise<TaskContentRevisionStateV1> {
    const row = await this.#productRow(transaction, lifecycle.coordinate, lock);
    const revisionKey = lifecycle.coordinate.kind === "definition" ? "content_revision" : "result_revision";
    const namespaceKey = lifecycle.coordinate.kind === "definition" ? "content_namespace_id" : "result_content_namespace_id";
    const product = row !== null && integer(row, revisionKey) === lifecycle.coordinate.contentRevision
      && nullableText(row, namespaceKey) === lifecycle.namespaceId
      ? mappingFromRow(lifecycle.coordinate, row) : null;
    return Object.freeze({ product, lifecycle, authority });
  }

  async #lockedLifecycle(transaction: ConversationProductPostgresTransaction, coordinate: TaskContentCoordinateV1, includeLease: boolean): Promise<ConversationProductDatabaseRow | null> {
    const table = this.#table(coordinate);
    const selection = coordinate.kind === "definition" ? this.#definitionSelection() : this.#resultSelection();
    const query = conversationProductTypedDb.select({ ...selection, ...(includeLease ? { lease_is_live: sql<boolean>`CASE WHEN ${table.leaseToken} IS NULL THEN TRUE ELSE ${table.leaseExpiresAt} > CURRENT_TIMESTAMP END`.as("lease_is_live") } : {}) }).from(table).where(this.#coordinateWhere(coordinate)).for("update").limit(2);
    return oneOrNone(await executeTypedConversationProductQuery(transaction, query), "Task content locked lifecycle");
  }

  async #readLifecycle(
    coordinate: TaskContentCoordinateV1,
  ): Promise<TaskContentRevisionLifecycleV1 | null> {
    return this.#handle.transaction(async transaction => {
      const row = await this.#coordinateRow(transaction, coordinate, false);
      return row === null ? null : lifecycleFromRow(coordinate.kind, row);
    }, { isolationLevel: "serializable" });
  }

  async #mapDefinition(
    transaction: ConversationProductPostgresTransaction,
    lifecycle: TaskContentRevisionLifecycleV1,
    exactCurrentAuthority: boolean,
    requesterOwnerId: string,
    expectedPolicyRevision: number,
    inspectedAccessRevision: number | null,
    foregroundProof: VerifiedForegroundTaskDefinitionPublication | undefined,
    currentAuthority: TaskContentAuthorityV1,
  ): Promise<"applied" | "duplicate" | "missing" | "stale" | "wrong_authority"> {
    const coordinate = lifecycle.coordinate;
    if (coordinate.kind !== "definition") throw new Error("Definition mapping kind mismatch");
    const row = await this.#productRow(transaction, coordinate, true);
    if (row === null) return "missing";
    const sameMappedDefinition = text(row, "owner_id") === requesterOwnerId
      && text(row, "requestor_id") === requesterOwnerId
      && integer(row, "content_revision") === coordinate.contentRevision
      && nullableText(row, "crypto_object_id") === lifecycle.cryptoObjectId
      && nullableText(row, "content_namespace_id") === lifecycle.namespaceId
      && text(row, "content_representation") === lifecycle.representation
      && text(row, "crypto_mapping_state") === "verified"
      && (lifecycle.representation !== "protected" || (
        text(row, "prompt") === ""
        && nullableText(row, "expected_output") === null
        && (nullableText(row, "last_error") === null || nullableText(row, "last_error") === TASK_LOCAL_EXECUTION_RECREATE_TEXT)
        && sameJson(jsonObject(row, "metadata_json"), lifecycle.operationalMetadata)
      ))
      && sameBytes(nullableBytes(row, "crypto_required_namespace_fingerprint") ?? new Uint8Array(), lifecycle.requiredNamespaceFingerprint);
    if (foregroundProof !== undefined && lifecycle.disposition === "mapped") {
      // The live inspection holds the signed crypto head stable and authorizes
      // exactly this mapped payload. Never route a refresh through content CAS.
      if (!sameMappedDefinition || inspectedAccessRevision === null
        || integer(row, "crypto_access_revision") > inspectedAccessRevision) return "stale";
      const metadata = classifyProtectedTaskMetadataV1(jsonObject(row, "metadata_json"));
      if (lifecycle.representation === "dual" && metadata.status !== "supported") return "stale";
      readVerifiedForegroundTaskDefinitionAccessRevision(foregroundProof, { lifecycle, currentAuthority,
        ...(lifecycle.representation === "dual" && metadata.status === "supported" ? {
          ordinaryPayload: { formatVersion: 1, prompt: text(row, "prompt"),
            expectedOutput: nullableText(row, "expected_output"), protectedMetadata: metadata.protectedContent },
        } : {}),
      });
      if (integer(row, "crypto_access_revision") === inspectedAccessRevision) return "duplicate";
      const updated = await executeTypedConversationProductQuery(transaction, conversationProductTypedDb.update(tasks)
        .set({ cryptoAccessRevision: inspectedAccessRevision })
        .where(and(eq(tasks.id, coordinate.taskId), eq(tasks.ownerId, requesterOwnerId),
          eq(tasks.requestorId, requesterOwnerId), eq(tasks.contentRevision, coordinate.contentRevision),
          eq(tasks.contentNamespaceId, lifecycle.namespaceId), eq(tasks.contentRepresentation, lifecycle.representation),
          eq(tasks.cryptoObjectId, lifecycle.cryptoObjectId), eq(tasks.cryptoMappingState, "verified"),
          eq(tasks.cryptoAccessRevision, integer(row, "crypto_access_revision")),
          eq(tasks.cryptoRequiredNamespaceFingerprint, lifecycle.requiredNamespaceFingerprint)))
        .returning({ task_id: tasks.id }));
      readVerifiedForegroundTaskDefinitionAccessRevision(foregroundProof, { lifecycle, currentAuthority });
      return oneOrNone(updated, "Task definition access-head CAS") === null ? "stale" : "applied";
    }
    if (sameMappedDefinition && (inspectedAccessRevision === null
      || integer(row, "crypto_access_revision") === inspectedAccessRevision)) return "duplicate";
    if (!exactCurrentAuthority && lifecycle.historicalRepair == null) return "wrong_authority";
    if (!await this.#lockPublicationPolicy(
      transaction,
      expectedPolicyRevision,
      lifecycle.representation,
    )) return "wrong_authority";
    const expected = coordinate.contentRevision - 1;
    const fallbackRepair = await this.#isFallbackRepairMappingPredecessor(
      transaction,
      row,
      lifecycle,
      requesterOwnerId,
    );
    const fallbackObjectId = fallbackRepair
      ? nullableText(row, "crypto_object_id") : null;
    const fallbackOperationId = fallbackRepair
      ? nullableText(row, "ordinary_fallback_operation_id") : null;
    const fallbackRequestDigest = fallbackRepair
      ? nullableBytes(row, "ordinary_fallback_request_digest") : null;
    const fallbackCompletedAt = fallbackRepair
      ? date(row, "ordinary_fallback_completed_at") : null;
    if (fallbackRepair && (fallbackObjectId === null
      || fallbackOperationId === null
      || fallbackRequestDigest === null
      || fallbackCompletedAt === null)) {
      throw new Error("Fallback Task repair mapping predecessor is incomplete");
    }
    const updated = await executeTypedConversationProductQuery(transaction, conversationProductTypedDb.update(tasks).set({
      ...(expected === 0 ? { ownerId: requesterOwnerId } : {}),
      contentRepresentation: lifecycle.representation, contentNamespaceId: lifecycle.namespaceId,
      contentRevision: coordinate.contentRevision, cryptoObjectId: lifecycle.cryptoObjectId,
      cryptoAccessRevision: inspectedAccessRevision ?? 0, cryptoRequiredNamespaceFingerprint: lifecycle.requiredNamespaceFingerprint,
      cryptoMappingState: "verified", ...(lifecycle.representation === "protected" ? {
        prompt: "",
        expectedOutput: null,
        lastError: null,
        metadata: sql`convert_from(${new TextEncoder().encode(JSON.stringify(lifecycle.operationalMetadata ?? {}))}::bytea, 'UTF8')::jsonb`,
      } : {}),
      ...(lifecycle.historicalRepair != null ? {} : expected === 0
        ? { status: "pending" as const } : taskLocalExecutionDefinitionInvalidationPatch(
        lifecycle.representation === "protected" ? { lastError: null } : {},
      )),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    }).where(and(eq(tasks.id, coordinate.taskId), eq(tasks.requestorId, requesterOwnerId),
      inArray(tasks.status, lifecycle.historicalRepair != null
        ? ["pending", "paused", "completed", "errored", "cancelled"] : ["pending", "paused"]),
      isNull(tasks.fireLockId), eq(tasks.contentRevision, expected), expected === 0
      ? and(isNull(tasks.contentNamespaceId), eq(tasks.contentRepresentation, "ordinary"))
      : fallbackRepair
        ? and(eq(tasks.ownerId, requesterOwnerId),
            eq(tasks.contentNamespaceId, lifecycle.namespaceId),
            eq(tasks.contentRepresentation, "dual"),
            eq(tasks.cryptoMappingState, "stale"),
            eq(tasks.cryptoObjectId, fallbackObjectId!),
            eq(tasks.ordinaryFallbackOperationId,
              fallbackOperationId!),
            eq(tasks.ordinaryFallbackRequestDigest,
              fallbackRequestDigest!),
            eq(tasks.ordinaryFallbackReason, "target_encryption_not_ready"),
            eq(tasks.ordinaryFallbackPolicyRevision,
              integer(row, "ordinary_fallback_policy_revision")),
            eq(tasks.ordinaryFallbackCompletedAt,
              fallbackCompletedAt!))
        : and(eq(tasks.ownerId, requesterOwnerId), eq(tasks.contentNamespaceId, lifecycle.namespaceId), inArray(tasks.contentRepresentation, ["protected", "dual"]), eq(tasks.cryptoMappingState, "verified")))).returning({ task_id: tasks.id }));
    return oneOrNone(updated, "Task definition mapping CAS") === null ? "stale" : "applied";
  }

  async #isFallbackRepairMappingPredecessor(
    transaction: ConversationProductPostgresTransaction,
    row: ConversationProductDatabaseRow,
    lifecycle: TaskContentRevisionLifecycleV1,
    requesterOwnerId: string,
  ): Promise<boolean> {
    if (lifecycle.coordinate.kind !== "definition"
      || lifecycle.coordinate.contentRevision <= 1
      || lifecycle.historicalRepair !== null
      || lifecycle.representation !== "dual"
      || text(row, "owner_id") !== requesterOwnerId
      || text(row, "requestor_id") !== requesterOwnerId
      || integer(row, "content_revision")
        !== lifecycle.coordinate.contentRevision - 1
      || nullableText(row, "content_namespace_id") !== lifecycle.namespaceId
      || text(row, "content_representation") !== "dual"
      || text(row, "crypto_mapping_state") !== "stale"
      || nullableText(row, "crypto_object_id") === null
      || nullableBytes(row, "crypto_required_namespace_fingerprint") === null
      || !hasFallbackReceiptRow(row)) return false;
    const predecessor = await this.#coordinateRow(transaction, {
      kind: "definition",
      taskId: lifecycle.coordinate.taskId,
      contentRevision: lifecycle.coordinate.contentRevision - 1,
    }, true);
    if (predecessor === null) return false;
    const previous = lifecycleFromRow("definition", predecessor);
    return previous.completion === "complete"
      && previous.disposition === "mapped"
      && previous.representation === "dual"
      && previous.namespaceId === lifecycle.namespaceId
      && previous.cryptoObjectId === nullableText(row, "crypto_object_id")
      && sameBytes(
        previous.requiredNamespaceFingerprint,
        nullableBytes(row, "crypto_required_namespace_fingerprint")!,
      );
  }

  async #mapResult(
    transaction: ConversationProductPostgresTransaction,
    lifecycle: TaskContentRevisionLifecycleV1,
    exactCurrentAuthority: boolean,
    requesterOwnerId: string,
    expectedPolicyRevision: number,
    locked: Readonly<{
      parent: ConversationProductDatabaseRow | null;
      run: ConversationProductDatabaseRow | null;
    }> | null,
    lockedPublicationPolicy: Readonly<{
      mode: string;
      revision: number;
    }> | null,
    stagedIntent: ProtectedTaskCancellationOutputIntent | null,
    inspectedAccessRevision: number | null,
    metadataHead: boolean,
  ): Promise<"applied" | "duplicate" | "missing" | "stale" | "wrong_authority"> {
    const coordinate = lifecycle.coordinate;
    if (coordinate.kind !== "run_result") throw new Error("Result mapping kind mismatch");
    if (locked === null) throw new Error("Result mapping product lock is missing");
    const { parent, run: row } = locked;
    if (parent === null
      || text(parent, "owner_id") !== requesterOwnerId
      || text(parent, "requestor_id") !== requesterOwnerId
      || nullableText(parent, "namespace_id") !== lifecycle.namespaceId) {
      return "stale";
    }
    if (row === null) return "missing";
    if (stagedIntent !== null && stagedIntent.requesterUserId !== requesterOwnerId) return "wrong_authority";
    if (stagedIntent !== null
      && !this.#publicationPolicyMatches(lockedPublicationPolicy, expectedPolicyRevision, lifecycle.representation)) {
      throw new TaskCancellationPublicationPolicyUnavailableError();
    }
    if (metadataHead) {
      if (lifecycle.disposition !== "mapped" || inspectedAccessRevision === null
        || !this.#publicationPolicyMatches(lockedPublicationPolicy, expectedPolicyRevision, lifecycle.representation)) return "wrong_authority";
      if (!["completed", "errored", "cancelled"].includes(text(row, "run_status"))
        || integer(row, "result_revision") !== coordinate.contentRevision
        || nullableText(row, "crypto_object_id") !== lifecycle.cryptoObjectId
        || nullableText(row, "result_content_namespace_id") !== lifecycle.namespaceId
        || text(row, "result_representation") !== lifecycle.representation
        || text(row, "crypto_mapping_state") !== "verified"
        || integer(row, "crypto_access_revision") > inspectedAccessRevision
        || !sameBytes(nullableBytes(row, "crypto_required_namespace_fingerprint") ?? new Uint8Array(), lifecycle.requiredNamespaceFingerprint)) return "stale";
      // Only the mapped head changes; terminal result and immutable ledger stay intact.
      const rows = await executeTypedConversationProductQuery(transaction, conversationProductTypedDb.update(taskRuns)
        .set({ resultCryptoAccessRevision: inspectedAccessRevision })
        .where(and(eq(taskRuns.id, coordinate.taskRunId), eq(taskRuns.taskId, coordinate.taskId),
          inArray(taskRuns.status, ["completed", "errored", "cancelled"]),
          eq(taskRuns.resultRevision, coordinate.contentRevision), eq(taskRuns.resultCryptoObjectId, lifecycle.cryptoObjectId),
          eq(taskRuns.resultContentNamespaceId, lifecycle.namespaceId), eq(taskRuns.resultRepresentation, lifecycle.representation),
          eq(taskRuns.resultCryptoMappingState, "verified"), eq(taskRuns.resultCryptoAccessRevision, integer(row, "crypto_access_revision")),
          eq(taskRuns.resultCryptoRequiredNamespaceFingerprint, lifecycle.requiredNamespaceFingerprint),
          lifecycle.representation === "protected" ? and(isNull(taskRuns.resultText), isNull(taskRuns.lastError)) : undefined))
        .returning({ task_run_id: taskRuns.id }));
      if (oneOrNone(rows, "Task result access-head CAS") === null) return "stale";
      return integer(row, "crypto_access_revision") === inspectedAccessRevision ? "duplicate" : "applied";
    }
    if (integer(row, "result_revision") === coordinate.contentRevision
      && nullableText(row, "crypto_object_id") === lifecycle.cryptoObjectId
      && nullableText(row, "result_content_namespace_id") === lifecycle.namespaceId
      && text(row, "result_representation") === lifecycle.representation
      && text(row, "crypto_mapping_state") === "verified"
      && (inspectedAccessRevision === null || integer(row, "crypto_access_revision") === inspectedAccessRevision)
      && sameBytes(nullableBytes(row, "crypto_required_namespace_fingerprint") ?? new Uint8Array(), lifecycle.requiredNamespaceFingerprint)) return "duplicate";
    if (!exactCurrentAuthority && stagedIntent === null && lifecycle.historicalRepair == null) return "wrong_authority";
    const cancelled = text(parent, "task_status") === "cancelled"
      || text(row, "run_status") === "cancelled";
    const historical = lifecycle.historicalRepair != null;
    if (historical && !["completed", "errored", "cancelled"].includes(text(row, "run_status"))) return "stale";
    if (cancelled && !historical && (text(parent, "task_status") !== "cancelled"
      || text(row, "run_status") !== "cancelled"
      || integer(row, "result_revision") !== 0
      || !await this.#exactCancellationIntent(transaction, coordinate, lifecycle.operationId, lifecycle.cryptoObjectId, lifecycle.representation, stagedIntent?.policyRevision ?? expectedPolicyRevision, stagedIntent))) return "stale";
    if (!this.#publicationPolicyMatches(
      lockedPublicationPolicy,
      expectedPolicyRevision,
      lifecycle.representation,
    )) return "wrong_authority";
    const expected = cancelled ? 0 : coordinate.contentRevision - 1;
    const updated = await executeTypedConversationProductQuery(transaction, conversationProductTypedDb.update(taskRuns).set({
      resultRepresentation: lifecycle.representation, resultContentNamespaceId: lifecycle.namespaceId,
      resultRevision: coordinate.contentRevision, resultCryptoObjectId: lifecycle.cryptoObjectId,
      resultCryptoAccessRevision: inspectedAccessRevision ?? 0, resultCryptoRequiredNamespaceFingerprint: lifecycle.requiredNamespaceFingerprint,
      resultCryptoMappingState: "verified", ...(lifecycle.representation === "protected"
        ? { resultText: null, lastError: null } : {}),
    }).where(and(eq(taskRuns.id, coordinate.taskRunId), eq(taskRuns.taskId, coordinate.taskId),
      historical ? eq(taskRuns.status, text(row, "run_status") as "completed" | "errored" | "cancelled")
        : cancelled ? eq(taskRuns.status, "cancelled") : ne(taskRuns.status, "cancelled"),
      eq(taskRuns.resultRevision, expected), expected === 0
      ? and(isNull(taskRuns.resultContentNamespaceId), eq(taskRuns.resultRepresentation, "ordinary"))
      : and(eq(taskRuns.resultContentNamespaceId, lifecycle.namespaceId), inArray(taskRuns.resultRepresentation, ["protected", "dual"]), eq(taskRuns.resultCryptoMappingState, "verified")))).returning({ task_run_id: taskRuns.id }));
    return oneOrNone(updated, "Task result mapping CAS") === null ? "stale" : "applied";
  }

  /** Only the dedicated, stopped-result intent admits the deliberate 0 -> 2 mapping. */
  async #exactCancellationIntent(
    transaction: ConversationProductPostgresTransaction,
    coordinate: TaskRunResultContentCoordinateV1,
    operationId: string,
    cryptoObjectId: string,
    representation: "protected" | "dual",
    expectedPolicyRevision: number,
    stagedIntent: ProtectedTaskCancellationOutputIntent | null = null,
  ): Promise<boolean> {
    if (coordinate.contentRevision !== 2
      || operationId !== `task-run-cancelled-result:${coordinate.taskRunId}`
      || cryptoObjectId !== deriveTaskContentCryptoObjectIdV1(coordinate)) return false;
    const binding = protectedTaskRunOutputBindings;
    const rows = await executeTypedConversationProductQuery(transaction,
      conversationProductTypedDb.select({ task_run_id: binding.taskRunId })
        .from(binding).innerJoin(taskRuns, eq(taskRuns.id, binding.taskRunId))
        .innerJoin(tasks, eq(tasks.id, taskRuns.taskId)).where(and(
          eq(tasks.id, coordinate.taskId), eq(tasks.status, "cancelled"),
          stagedIntent === null ? undefined : and(
            eq(tasks.agentId, stagedIntent.agentId),
            eq(tasks.contentRepresentation, stagedIntent.representation),
            eq(tasks.contentNamespaceId, stagedIntent.contentNamespaceId),
            eq(tasks.cancelledAt, stagedIntent.terminalAt),
          ),
          eq(taskRuns.id, coordinate.taskRunId), eq(taskRuns.status, "cancelled"),
          eq(taskRuns.completedAt, tasks.cancelledAt),
          eq(binding.resultTerminalAt, taskRuns.completedAt),
          eq(binding.bindingId, `task-run-output:${coordinate.taskRunId}`),
          eq(binding.resultRevision, 2), eq(binding.resultOperationId, operationId),
          eq(binding.acceptedPolicyRevision, expectedPolicyRevision),
          eq(binding.resultObjectId, cryptoObjectId),
          isNull(binding.resultAttachedAt), isNull(binding.messageId),
          isNull(binding.wakeJobId), isNull(binding.completedAt),
          or(isNull(taskRuns.resultText), representation === "dual"
            ? eq(taskRuns.resultText, PROTECTED_TASK_CANCELLED_RESULT) : undefined),
          isNull(taskRuns.lastError),
        )).for("share", { of: binding }).limit(2));
    return oneOrNone(rows, "Cancelled Task result intent") !== null;
  }

  async #lockResultProduct(
    transaction: ConversationProductPostgresTransaction,
    coordinate: TaskRunResultContentCoordinateV1,
  ): Promise<Readonly<{
      parent: ConversationProductDatabaseRow | null;
      run: ConversationProductDatabaseRow | null;
    }>> {
    const parent = oneOrNone(await executeTypedConversationProductQuery(
      transaction,
      conversationProductTypedDb.select({
        owner_id: tasks.ownerId,
        requestor_id: tasks.requestorId,
        namespace_id: sql<string | null>`${tasks.contentNamespaceId}`.as("namespace_id"),
        task_status: sql<string>`${tasks.status}`.as("task_status"),
      }).from(tasks)
        .where(eq(tasks.id, coordinate.taskId))
        .for("update")
        .limit(2),
    ), "Task result parent lookup");
    const run = await this.#productRow(transaction, coordinate, true);
    return Object.freeze({ parent, run });
  }

  async #lockPublicationPolicy(
    transaction: ConversationProductPostgresTransaction,
    expectedRevision: number,
    representation: "protected" | "dual",
  ): Promise<boolean> {
    return this.#publicationPolicyMatches(
      await this.#lockedPublicationPolicy(transaction),
      expectedRevision,
      representation,
    );
  }

  async #lockedPublicationPolicy(
    transaction: ConversationProductPostgresTransaction,
  ): Promise<Readonly<{ mode: string; revision: number }> | null> {
    const rows = await executeTypedConversationProductQuery(
      transaction,
      conversationProductTypedDb.select({
        mode: encryptionTransitionPolicy.mode,
        revision: encryptionTransitionPolicy.revision,
      }).from(encryptionTransitionPolicy)
        .where(eq(encryptionTransitionPolicy.id, "server"))
        .for("share", { of: encryptionTransitionPolicy })
        .limit(2),
    );
    const row = oneOrNone(rows, "Task publication policy fence");
    return row === null ? null : Object.freeze({
      mode: text(row, "mode"),
      revision: integer(row, "revision"),
    });
  }

  #publicationPolicyMatches(
    policy: Readonly<{ mode: string; revision: number }> | null,
    expectedRevision: number,
    representation: "protected" | "dual",
  ): boolean {
    if (policy === null || policy.revision !== expectedRevision) return false;
    return representation === "dual"
      ? policy.mode === "shadow_encryption"
      : policy.mode === "encrypted_only";
  }

  async #terminalTransition(coordinate: TaskContentCoordinateV1, leaseToken: string | null, disposition: "quarantined" | "stale_mapping", failureCode: TaskContentFailureCode): Promise<"applied" | "duplicate" | "missing" | "conflict"> {
    return this.#handle.transaction(async (transaction) => {
      const row = await this.#lockedLifecycle(transaction, coordinate, true);
      if (row === null) return "missing";
      const lifecycle = lifecycleFromRow(coordinate.kind, row);
      if (lifecycle.disposition === disposition) return lifecycle.failureCode === failureCode ? "duplicate" : "conflict";
      if (!leaseMatches(row, lifecycle, leaseToken) || lifecycle.disposition !== "active") return "conflict";
      return await this.#updateLifecycle(transaction, coordinate, { disposition, failureCode, nextAttemptAt: null, leaseToken: null, leaseExpiresAt: null, updatedAt: sql`CURRENT_TIMESTAMP` }, and(this.#coordinateWhere(coordinate), eq(this.#table(coordinate).disposition, "active"), sql`${this.#table(coordinate).leaseToken} IS NOT DISTINCT FROM ${leaseToken}::uuid`)) ? "applied" : "conflict";
    }, { isolationLevel: "serializable" });
  }

  #persistAuthorityStale(transaction: ConversationProductPostgresTransaction, lifecycle: TaskContentRevisionLifecycleV1): Promise<void> {
    return this.#persistTerminal(
      transaction,
      lifecycle,
      "authority_stale",
      lifecycle.completion === "complete" ? "stale_mapping" : "quarantined",
    );
  }

  #persistStaleMapping(transaction: ConversationProductPostgresTransaction, lifecycle: TaskContentRevisionLifecycleV1): Promise<void> {
    return this.#persistTerminal(transaction, lifecycle, "mapping_conflict", "stale_mapping");
  }

  async #persistTerminal(transaction: ConversationProductPostgresTransaction, lifecycle: TaskContentRevisionLifecycleV1, code: "authority_stale" | "mapping_conflict", disposition: "quarantined" | "stale_mapping"): Promise<void> {
    const updated = await this.#updateLifecycle(transaction, lifecycle.coordinate, { disposition, failureCode: code, nextAttemptAt: null, leaseToken: null, leaseExpiresAt: null, updatedAt: sql`CURRENT_TIMESTAMP` }, and(this.#coordinateWhere(lifecycle.coordinate), eq(this.#table(lifecycle.coordinate).disposition, "active")));
    if (!updated) throw new Error("Task content stale receipt lost its lifecycle CAS");
  }

  async #dueRows(transaction: ConversationProductPostgresTransaction, kind: LedgerKind, limit: number): Promise<readonly ConversationProductDatabaseRow[]> {
    const table = kind === "definition" ? taskDefinitionCryptoRevisions : taskRunResultCryptoRevisions;
    const selection = kind === "definition" ? this.#definitionSelection() : this.#resultSelection();
    return executeTypedConversationProductQuery(transaction, conversationProductTypedDb.select({ kind: sql<string>`${kind}`.as("kind"), ...selection }).from(table).where(and(eq(table.disposition, "active"), sql`${table.attemptCount} < ${TASK_CONTENT_RECONCILE_MAX_ATTEMPTS}`, lte(table.nextAttemptAt, sql`CURRENT_TIMESTAMP`), or(isNull(table.leaseToken), lte(table.leaseExpiresAt, sql`CURRENT_TIMESTAMP`)))).orderBy(table.nextAttemptAt, table.sequence).limit(limit).for("update", { skipLocked: true }));
  }

  async #updateLifecycle(transaction: ConversationProductPostgresTransaction, coordinate: TaskContentCoordinateV1, values: Record<string, unknown>, where = this.#coordinateWhere(coordinate)): Promise<boolean> {
    return (await this.#updateLifecycleReturning(transaction, coordinate, values, where)) !== null;
  }

  async #updateLifecycleReturning(transaction: ConversationProductPostgresTransaction, coordinate: TaskContentCoordinateV1, values: Record<string, unknown>, where: ReturnType<typeof and>): Promise<ConversationProductDatabaseRow | null> {
    const query = coordinate.kind === "definition"
      ? conversationProductTypedDb.update(taskDefinitionCryptoRevisions).set(values).where(where).returning(this.#definitionSelection())
      : conversationProductTypedDb.update(taskRunResultCryptoRevisions).set(values).where(where).returning(this.#resultSelection());
    return oneOrNone(await executeTypedConversationProductQuery(transaction, query), "Task content lifecycle update");
  }
}
