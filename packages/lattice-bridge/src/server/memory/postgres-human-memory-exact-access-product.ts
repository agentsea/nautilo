import {
  and,
  eq,
  memories,
  memoryCryptoOperations,
  memoryCryptoRevisions,
  memoryNamespaces,
  sql,
} from "@nautilo/db";
import {
  deriveHumanMemoryExactAccessChange,
  fingerprintHumanMemoryExactAccessTarget,
  targetAfterAuthorizedViewDeletion,
  type HumanMemoryExactAccessAuthority,
  type HumanMemoryExactAccessChange,
} from "./human-memory-exact-access.ts";
import {
  assertConversationProductCanonicalTransactionRunner,
  assertVerifiedConversationProductPostgresHandle,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresHandle,
  type ConversationProductCanonicalTransactionRunner,
  type ConversationProductPostgresTransaction,
} from "../message/postgres-conversation-product-store.ts";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import type {
  HumanMemoryExactAccessRequestEntry,
} from "@nautilo/lattice-crypto";
import type {
  MemoryNativeNamespaceAuthorityEntryV1,
} from "@nautilo/lattice-crypto/wire";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const OBJECT_ID = /^memory:v1:[0-9a-f]{64}$/;
export type HumanMemoryExactAccessTarget =
  | Readonly<{ kind: "replace_exact"; namespaceIds: readonly string[] }>
  | Readonly<{ kind: "delete_authorized_view" }>;

export type HumanMemoryExactAccessPlan = Omit<
  HumanMemoryExactAccessChange,
  "status"
> & Readonly<{
  status: "prepared";
  operationId: string;
  subjectHumanId: string;
  anchorNamespaceId: string;
  memoryId: string;
  cryptoObjectId: string;
  expectedContentRevision: number;
  expectedCryptoAccessRevision: number;
  nextCryptoAccessRevision: number;
  currentRequiredNamespaceFingerprint: Uint8Array;
  targetRequiredNamespaceFingerprint: Uint8Array;
}>;

export type HumanMemoryExactAccessPlanResult =
  | HumanMemoryExactAccessPlan
  | Readonly<{
      status: "unavailable";
      reason: "target_encryption_not_ready";
    }>
  | Readonly<{
      status: "unchanged";
      memoryId: string;
      cryptoAccessRevision: number;
      requiredNamespaceIds: readonly string[];
    }>;

export type HumanMemoryExactAccessCryptoReceipt = Readonly<{
  operationId: string;
  memoryId: string;
  objectId: string;
  expectedContentRevision: number;
  expectedAccessRevision: number;
  resultAccessRevision: number;
  currentManifestHash: Uint8Array;
  resultManifestHash: Uint8Array;
  targetRequiredNamespaceFingerprint: Uint8Array;
  requestDigest: Uint8Array;
  currentNamespaceIds: readonly string[];
  targetNamespaceIds: readonly string[];
  status: "applied" | "duplicate";
  publicationAuthority?: HumanMemoryExactAccessPublicationAuthority;
}>;

export type HumanMemoryExactAccessPublicationAuthority = Readonly<{
  purpose: "persist-human-memory-native-access-update";
  operationId: string;
  objectId: string;
  payloadHash: Uint8Array;
  expectedContentRevision: number;
  currentAccessRevision: number;
  currentManifestHash: Uint8Array;
  nextAccessRevision: number;
  nextManifestHash: Uint8Array;
  currentEntries: readonly HumanMemoryExactAccessRequestEntry[];
  targetEntries: readonly HumanMemoryExactAccessRequestEntry[];
  currentAuthorityEntries: readonly MemoryNativeNamespaceAuthorityEntryV1[];
  targetAuthorityEntries: readonly MemoryNativeNamespaceAuthorityEntryV1[];
  subjectHumanId: string;
  committerDeviceId: string;
  hostAuthorizationRevision: number;
}>;

export type HumanMemoryExactAccessPublicationBoundary = Readonly<{
  fence(input: Readonly<{
    transaction: CanonicalTranscriptTx;
    authority: HumanMemoryExactAccessAuthority;
  }>): Promise<void>;
  withLocks<Result>(input: Readonly<{
    authority: HumanMemoryExactAccessAuthority;
    preparedAuthority: HumanMemoryExactAccessPublicationAuthority;
    plan: HumanMemoryExactAccessPlan;
  }>, publish: (lockCryptoAuthority: () => Promise<void>) => Promise<Result>): Promise<Result>;
  allowOrdinaryFallback: boolean;
}>;

export type HumanMemoryExactAccessCommitResult = Readonly<{
  status: "updated" | "replayed" | "ordinary_fallback";
  operationId: string;
  memoryId: string;
  cryptoAccessRevision: number;
  requiredNamespaceIds: readonly string[];
  reason?: "encryption_pending" | "target_encryption_not_ready";
}>;

export type HumanMemoryExactAccessCryptoObservation =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "conflict" }>
  | Readonly<{
      status: "current";
      objectId: string;
      accessRevision: number;
      manifestHash: Uint8Array;
      namespaceIds: readonly string[];
      namespaceEnvelopeCoordinates: readonly Readonly<{
        namespaceId: string;
        generation: number;
        accessRevision: number;
      }>[];
    }>
  | Readonly<{
      status: "target";
      objectId: string;
      accessRevision: number;
      manifestHash: Uint8Array;
      previousManifestHash: Uint8Array;
      namespaceIds: readonly string[];
      namespaceEnvelopeCoordinates: readonly Readonly<{
        namespaceId: string;
        generation: number;
        accessRevision: number;
      }>[];
    }>;

export type HumanMemoryExactAccessReconcileResult =
  | Readonly<{ status: "pending"; phase: "crypto" }>
  | Readonly<{
      status: "completed";
      operationId: string;
      memoryId: string;
      cryptoAccessRevision: number;
      requiredNamespaceIds: readonly string[];
    }>
  | Readonly<{ status: "stale" | "denied" | "quarantined" }>;

declare const replayAdmissionBrand: unique symbol;
export type HumanMemoryExactAccessReplayAdmission = Readonly<{
  [replayAdmissionBrand]: true;
}>;

type ReplayAdmissionSnapshot = Readonly<{
  operationId: string;
  memoryId: string;
  subjectHumanId: string;
  requestDigest: Uint8Array;
}>;

const replayAdmissions = new WeakMap<object, ReplayAdmissionSnapshot>();

function mintReplayAdmission(
  snapshot: ReplayAdmissionSnapshot,
): HumanMemoryExactAccessReplayAdmission {
  const admission = Object.freeze({}) as HumanMemoryExactAccessReplayAdmission;
  replayAdmissions.set(admission, Object.freeze({
    ...snapshot,
    requestDigest: snapshot.requestDigest.slice(),
  }));
  return admission;
}

/** Package-internal validation for an exact durable active reservation. It is
 * not a general freshness bypass and carries no product/crypto authority. */
export function assertHumanMemoryExactAccessReplayAdmission(input: Readonly<{
  admission: HumanMemoryExactAccessReplayAdmission;
  operationId: string;
  memoryId: string;
  subjectHumanId: string;
  requestDigest: Uint8Array;
}>): void {
  const snapshot = replayAdmissions.get(input.admission as object);
  if (snapshot === undefined
    || snapshot.operationId !== input.operationId
    || snapshot.memoryId !== input.memoryId
    || snapshot.subjectHumanId !== input.subjectHumanId
    || !bytesEqual(snapshot.requestDigest, input.requestDigest)) {
    throw new TypeError("Human Memory exact-access replay admission is invalid");
  }
}

export type HumanMemoryExactAccessReplayLookup =
  | Readonly<{ status: "absent" | "conflict" }>
  | Readonly<{
      status: "pending";
      requestDigest: Uint8Array;
      cryptoObjectId: string;
      replayAdmission: HumanMemoryExactAccessReplayAdmission;
    }>
  | Readonly<{
      status: "completed";
      requestDigest: Uint8Array;
      cryptoAccessRevision: number;
      requiredNamespaceIds: readonly string[];
    }>
  | Readonly<{
      status: "ordinary_fallback";
      requestDigest: Uint8Array;
      cryptoAccessRevision: number;
      reason: "encryption_pending" | "target_encryption_not_ready";
    }>;

type ProductSnapshot = Readonly<{
  contentRevision: number;
  accessRevision: number;
  mappingState: string;
  objectId: string;
  fingerprint: Uint8Array;
  namespaceIds: readonly string[];
}>;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function rowString(row: ConversationProductDatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError(`${field} must be text`);
  return value;
}

function rowNullableString(
  row: ConversationProductDatabaseRow,
  field: string,
): string | null {
  return row[field] === null ? null : rowString(row, field);
}

function rowInteger(row: ConversationProductDatabaseRow, field: string): number {
  const raw = row[field];
  const value = typeof raw === "bigint" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a safe counter`);
  }
  return value;
}

function rowBytes(row: ConversationProductDatabaseRow, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError(`${field} must be a 32-byte digest`);
  }
  return value.slice();
}

function oneOrNull(
  rows: readonly ConversationProductDatabaseRow[],
  label: string,
): ConversationProductDatabaseRow | null {
  if (rows.length > 1) throw new Error(`${label} is not unique`);
  return rows[0] ?? null;
}

function canonicalIds(value: unknown): readonly string[] {
  const parsed: unknown = typeof value === "string"
    ? JSON.parse(value) as unknown
    : value;
  if (!Array.isArray(parsed) || parsed.length > 256) {
    throw new TypeError("Memory Namespace inventory is invalid");
  }
  const ids = parsed.map((entry) => {
    if (typeof entry !== "string" || !UUID.test(entry)) {
      throw new TypeError("Memory Namespace inventory is invalid");
    }
    return entry;
  }).sort();
  if (ids.some((id, index) => index > 0 && ids[index - 1] === id)) {
    throw new TypeError("Memory Namespace inventory is duplicated");
  }
  return Object.freeze(ids);
}

function exactSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export { fingerprintHumanMemoryExactAccessTarget };

async function assertIdentity(
  tx: ConversationProductPostgresTransaction,
  authority: HumanMemoryExactAccessAuthority,
): Promise<void> {
  const rows = await executeTypedConversationProductQuery(
    tx,
    conversationProductTypedDb.select({
      current_user_id: sql<string>`app_current_user_id()::text`.as("current_user_id"),
      current_agent_id: sql<string | null>`app_current_agent_id()::text`.as("current_agent_id"),
    }).from(sql`(values (1)) as identity_probe`).limit(2),
  );
  if (
    rows.length !== 1
    || rows[0]?.["current_user_id"] !== authority.userId
    || rows[0]?.["current_agent_id"] !== null
    || authority.agentId !== null
  ) throw new TypeError("Human Memory exact access identity is unavailable");
}

async function loadProduct(
  tx: ConversationProductPostgresTransaction,
  memoryId: string,
): Promise<ProductSnapshot> {
  const row = oneOrNull(await tx.query(
    `/* human-memory:exact-access:lock-product */
     SELECT m.id::text AS memory_id, m.content_revision,
            m.crypto_access_revision, m.crypto_mapping_state, m.crypto_object_id,
            m.crypto_required_namespace_fingerprint,
            COALESCE((SELECT json_agg(mn.namespace_id::text ORDER BY mn.namespace_id)
              FROM memory_namespaces mn WHERE mn.memory_id = m.id), '[]'::json)::text AS namespace_ids,
            (SELECT COUNT(*)::int FROM memory_scopes ms
              WHERE ms.memory_id = m.id) AS scope_count
       FROM memories m WHERE m.id = $1::uuid LIMIT 2 FOR UPDATE`,
    [memoryId],
  ), "Human Memory exact-access product");
  if (row === null) throw new Error("Human Memory exact-access product is unavailable");
  if (rowInteger(row, "scope_count") !== 0) {
    throw new TypeError("Scope Memory exact access is unavailable");
  }
  const objectId = rowString(row, "crypto_object_id");
  if (!OBJECT_ID.test(objectId)) throw new TypeError("Memory crypto object is invalid");
  const namespaceIds = canonicalIds(row["namespace_ids"]);
  const fingerprint = rowBytes(row, "crypto_required_namespace_fingerprint");
  if (!bytesEqual(
    fingerprint,
    fingerprintHumanMemoryExactAccessTarget(namespaceIds),
  )) throw new TypeError("Memory crypto Namespace fingerprint is invalid");
  return Object.freeze({
    contentRevision: rowInteger(row, "content_revision"),
    accessRevision: rowInteger(row, "crypto_access_revision"),
    mappingState: rowString(row, "crypto_mapping_state"),
    objectId,
    fingerprint,
    namespaceIds,
  });
}

function receiptMatches(
  receipt: HumanMemoryExactAccessCryptoReceipt,
  plan: HumanMemoryExactAccessPlan,
): boolean {
  return receipt.publicationAuthority !== undefined
    && receipt.operationId === plan.operationId
    && receipt.memoryId === plan.memoryId
    && receipt.objectId === plan.cryptoObjectId
    && receipt.expectedContentRevision === plan.expectedContentRevision
    && receipt.expectedAccessRevision === plan.expectedCryptoAccessRevision
    && receipt.resultAccessRevision === plan.nextCryptoAccessRevision
    && receipt.currentManifestHash.length === 32
    && receipt.resultManifestHash.length === 32
    && bytesEqual(
      receipt.targetRequiredNamespaceFingerprint,
      plan.targetRequiredNamespaceFingerprint,
    )
    && exactSet(receipt.currentNamespaceIds, plan.currentNamespaceIds)
    && exactSet(receipt.targetNamespaceIds, plan.targetNamespaceIds)
    && receipt.publicationAuthority.purpose === "persist-human-memory-native-access-update"
    && receipt.publicationAuthority.operationId === plan.operationId
    && receipt.publicationAuthority.objectId === plan.cryptoObjectId
    && receipt.publicationAuthority.subjectHumanId === plan.subjectHumanId
    && receipt.publicationAuthority.expectedContentRevision === plan.expectedContentRevision
    && receipt.publicationAuthority.currentAccessRevision === plan.expectedCryptoAccessRevision
    && receipt.publicationAuthority.nextAccessRevision === plan.nextCryptoAccessRevision;
}

function operationMatchesPlan(
  operation: ConversationProductDatabaseRow,
  plan: HumanMemoryExactAccessPlan,
  signedRequestDigest: Uint8Array,
): boolean {
  return rowString(operation, "memory_id") === plan.memoryId
    && rowString(operation, "anchor_namespace_id") === plan.anchorNamespaceId
    && rowString(operation, "operation_type") === "access"
    && rowInteger(operation, "expected_content_revision")
      === plan.expectedContentRevision
    && operation["result_content_revision"] === null
    && rowInteger(operation, "expected_access_revision")
      === plan.expectedCryptoAccessRevision
    && rowInteger(operation, "result_access_revision") === plan.nextCryptoAccessRevision
    && bytesEqual(rowBytes(operation, "request_digest"), signedRequestDigest)
    && bytesEqual(
      rowBytes(operation, "target_required_namespace_fingerprint"),
      plan.targetRequiredNamespaceFingerprint,
    );
}

export class PostgresHumanMemoryExactAccessProduct {
  readonly #canonicalRunner: ConversationProductCanonicalTransactionRunner;
  readonly #publication: HumanMemoryExactAccessPublicationBoundary;

  constructor(
    handle: ConversationProductPostgresHandle,
    options: Readonly<{
      canonicalRunner: ConversationProductCanonicalTransactionRunner;
      publication: HumanMemoryExactAccessPublicationBoundary;
    }>,
  ) {
    assertVerifiedConversationProductPostgresHandle(handle);
    assertConversationProductCanonicalTransactionRunner(handle, options.canonicalRunner);
    if (handle.role !== "nautilo") {
      throw new TypeError("Human Memory exact access requires the ordinary nautilo role");
    }
    this.#canonicalRunner = options.canonicalRunner;
    this.#publication = options.publication;
  }

  #transaction<Result>(
    authority: HumanMemoryExactAccessAuthority,
    callback: (tx: ConversationProductPostgresTransaction) => Promise<Result>,
    fence = false,
  ): Promise<Result> {
    return this.#canonicalRunner.transaction(async (transaction, executor) => {
      await assertIdentity(executor, authority);
      if (fence) await this.#publication.fence({ transaction, authority });
      return callback(executor);
    }, { isolationLevel: "serializable" });
  }

  plan(input: Readonly<{
    authority: HumanMemoryExactAccessAuthority;
    operationId: string;
    memoryId: string;
    target: HumanMemoryExactAccessTarget;
  }>): Promise<HumanMemoryExactAccessPlanResult> {
    if (!PORTABLE_ID.test(input.operationId) || !UUID.test(input.memoryId)) {
      throw new TypeError("Human Memory exact-access identifiers are invalid");
    }
    return this.#transaction(input.authority, async (tx) => {
      const product = await loadProduct(tx, input.memoryId);
      const targetIds = input.target.kind === "delete_authorized_view"
        ? targetAfterAuthorizedViewDeletion({
            currentNamespaceIds: product.namespaceIds,
            readableNamespaceIds: input.authority.readableNamespaceIds,
          })
        : input.target.namespaceIds;
      const change = deriveHumanMemoryExactAccessChange({
        authority: input.authority,
        currentNamespaceIds: product.namespaceIds,
        proposedTargetNamespaceIds: targetIds,
      });
      if (change.status === "unchanged") {
        return Object.freeze({
          status: "unchanged" as const,
          memoryId: input.memoryId,
          cryptoAccessRevision: product.accessRevision,
          requiredNamespaceIds: product.namespaceIds,
        });
      }
      const targetFingerprint = fingerprintHumanMemoryExactAccessTarget(
        change.targetNamespaceIds,
      );
      return Object.freeze({
        ...change,
        status: "prepared" as const,
        operationId: input.operationId,
        subjectHumanId: input.authority.subjectHumanId,
        anchorNamespaceId: change.currentNamespaceIds.find((id) =>
          input.authority.readableNamespaceIds.includes(id)
        )!,
        memoryId: input.memoryId,
        cryptoObjectId: product.objectId,
        expectedContentRevision: product.contentRevision,
        expectedCryptoAccessRevision: product.accessRevision,
        nextCryptoAccessRevision: product.accessRevision + 1,
        currentRequiredNamespaceFingerprint: product.fingerprint,
        targetRequiredNamespaceFingerprint: targetFingerprint,
      });
    }, true);
  }

  commitOrdinaryFallback(input: Readonly<{
    authority: HumanMemoryExactAccessAuthority;
    plan: HumanMemoryExactAccessPlan;
    preparedAuthority: HumanMemoryExactAccessPublicationAuthority;
    signedRequestDigest: Uint8Array;
    reason: "encryption_pending" | "target_encryption_not_ready";
  }>): Promise<HumanMemoryExactAccessCommitResult> {
    if (!this.#publication.allowOrdinaryFallback) {
      throw new Error("Human Memory exact-access ordinary fallback is forbidden by policy");
    }
    if (input.preparedAuthority.operationId !== input.plan.operationId
      || input.preparedAuthority.objectId !== input.plan.cryptoObjectId) {
      throw new TypeError("Human Memory exact-access fallback authority was substituted");
    }
    return this.#publication.withLocks({ authority: input.authority,
      preparedAuthority: input.preparedAuthority, plan: input.plan,
    }, (lockCryptoAuthority) => this.#canonicalRunner.transaction(
      async (transaction, tx) => {
        await assertIdentity(tx, input.authority);
        await this.#publication.fence({ transaction, authority: input.authority });
        await lockCryptoAuthority();
        const operation = oneOrNull(await tx.query(
          `/* human-memory:exact-access:fallback-operation */
           SELECT operation_id, memory_id::text AS memory_id, operation_type,
                  anchor_namespace_id::text AS anchor_namespace_id,
                  expected_content_revision, result_content_revision,
                  expected_access_revision, result_access_revision,
                  request_digest, target_required_namespace_fingerprint,
                  completion, disposition, ordinary_fallback_reason
             FROM memory_crypto_operations
            WHERE operation_id = $1 LIMIT 2 FOR UPDATE`,
          [input.plan.operationId]), "Human Memory exact-access fallback operation");
        if (operation === null
          || !operationMatchesPlan(operation, input.plan, input.signedRequestDigest)) {
          throw new Error("Human Memory exact-access fallback reservation conflicts");
        }
        if (rowString(operation, "completion") === "ordinary_fallback"
          && rowString(operation, "disposition") === "complete") {
          const persistedReason = rowNullableString(
            operation, "ordinary_fallback_reason",
          );
          if (persistedReason !== "encryption_pending"
            && persistedReason !== "target_encryption_not_ready") {
            throw new Error("Human Memory exact-access fallback reason is invalid");
          }
          return Object.freeze({ status: "ordinary_fallback" as const,
            operationId: input.plan.operationId, memoryId: input.plan.memoryId,
            cryptoAccessRevision: input.plan.expectedCryptoAccessRevision,
            requiredNamespaceIds: input.plan.targetNamespaceIds,
            reason: persistedReason });
        }
        const product = await loadProduct(tx, input.plan.memoryId);
        if (product.contentRevision !== input.plan.expectedContentRevision
          || product.accessRevision !== input.plan.expectedCryptoAccessRevision
          || product.objectId !== input.plan.cryptoObjectId
          || !exactSet(product.namespaceIds, input.plan.currentNamespaceIds)
          || !bytesEqual(product.fingerprint,
            input.plan.currentRequiredNamespaceFingerprint)) {
          throw new Error("Human Memory exact-access fallback product became stale");
        }
        deriveHumanMemoryExactAccessChange({ authority: input.authority,
          currentNamespaceIds: product.namespaceIds,
          proposedTargetNamespaceIds: input.plan.targetNamespaceIds });
        if (input.plan.targetNamespaceIds.length === 0) {
          const deleted = await executeTypedConversationProductQuery(tx,
            conversationProductTypedDb.delete(memories).where(and(
              eq(memories.id, input.plan.memoryId),
              eq(memories.contentRevision, input.plan.expectedContentRevision),
              eq(memories.cryptoAccessRevision,
                input.plan.expectedCryptoAccessRevision)))
              .returning({ id: memories.id }));
          if (deleted.length !== 1) throw new Error("Human Memory fallback delete lost its CAS");
        } else {
          for (const namespaceId of input.plan.removedNamespaceIds) {
            const removed = await executeTypedConversationProductQuery(tx,
              conversationProductTypedDb.delete(memoryNamespaces).where(and(
                eq(memoryNamespaces.memoryId, input.plan.memoryId),
                eq(memoryNamespaces.namespaceId, namespaceId)))
                .returning({ id: memoryNamespaces.namespaceId }));
            if (removed.length !== 1) throw new Error("Human Memory fallback removal lost its CAS");
          }
          for (const namespaceId of input.plan.addedNamespaceIds) {
            const added = await executeTypedConversationProductQuery(tx,
              conversationProductTypedDb.insert(memoryNamespaces).values({
                memoryId: input.plan.memoryId, namespaceId })
                .returning({ id: memoryNamespaces.namespaceId }));
            if (added.length !== 1) throw new Error("Human Memory fallback addition lost its CAS");
          }
          const unmapped = await executeTypedConversationProductQuery(tx,
            conversationProductTypedDb.update(memories).set({ cryptoObjectId: null,
              cryptoRequiredNamespaceFingerprint: null,
              cryptoMappingState: "unmapped", updatedAt: sql`CURRENT_TIMESTAMP` })
              .where(and(eq(memories.id, input.plan.memoryId),
                eq(memories.contentRevision, input.plan.expectedContentRevision),
                eq(memories.cryptoAccessRevision,
                  input.plan.expectedCryptoAccessRevision),
                eq(memories.cryptoObjectId, input.plan.cryptoObjectId)))
              .returning({ id: memories.id }));
          if (unmapped.length !== 1) throw new Error("Human Memory fallback mapping lost its CAS");
          const superseded = await executeTypedConversationProductQuery(tx,
            conversationProductTypedDb.update(memoryCryptoRevisions).set({
              disposition: "superseded", updatedAt: sql`CURRENT_TIMESTAMP` })
              .where(and(eq(memoryCryptoRevisions.memoryId, input.plan.memoryId),
                eq(memoryCryptoRevisions.contentRevision,
                  input.plan.expectedContentRevision),
                eq(memoryCryptoRevisions.disposition, "mapped")))
              .returning({ sequence: memoryCryptoRevisions.sequence }));
          if (superseded.length !== 1) throw new Error("Human Memory fallback mapping receipt changed");
        }
        const completed = await executeTypedConversationProductQuery(tx,
          conversationProductTypedDb.update(memoryCryptoOperations).set({
            completion: "ordinary_fallback", disposition: "complete",
            // Planned identity remains immutable. Fallback did not advance
            // crypto: its actual outcome uses expectedAccessRevision on replay.
            ordinaryFallbackReason: input.reason,
            ordinaryFallbackCompletedAt: sql`CURRENT_TIMESTAMP`, nextAttemptAt: null,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          }).where(and(eq(memoryCryptoOperations.operationId, input.plan.operationId),
            eq(memoryCryptoOperations.memoryId, input.plan.memoryId),
            eq(memoryCryptoOperations.completion, "pending"),
            eq(memoryCryptoOperations.disposition, "active")))
            .returning({ id: memoryCryptoOperations.operationId }));
        if (completed.length !== 1) throw new Error("Human Memory fallback receipt changed");
        return Object.freeze({ status: "ordinary_fallback" as const,
          operationId: input.plan.operationId, memoryId: input.plan.memoryId,
          cryptoAccessRevision: input.plan.expectedCryptoAccessRevision,
          requiredNamespaceIds: input.plan.targetNamespaceIds,
          reason: input.reason });
      }, { isolationLevel: "serializable" }));
  }

  /**
   * Content-free pre-authentication lookup for an already authenticated,
   * durable signed request. It never admits a new operation and deliberately
   * An exact completed replay returns only coordinates reloaded from the
   * durable product mapping; it never trusts an expired outer request DTO.
   */
  lookupReplay(input: Readonly<{
    authority: HumanMemoryExactAccessAuthority;
    operationId: string;
    memoryId: string;
    subjectHumanId: string;
    signedRequestDigest: Uint8Array;
  }>): Promise<HumanMemoryExactAccessReplayLookup> {
    if (
      !PORTABLE_ID.test(input.operationId)
      || !UUID.test(input.memoryId)
      || input.subjectHumanId !== input.authority.subjectHumanId
      || input.signedRequestDigest.length !== 32
    ) return Promise.resolve(Object.freeze({ status: "conflict" as const }));
    return this.#transaction(input.authority, async (tx) => {
      const rows = await executeTypedConversationProductQuery(
        tx,
        conversationProductTypedDb.select({
          operation_id: memoryCryptoOperations.operationId,
          memory_id: memoryCryptoOperations.memoryId,
          operation_type: memoryCryptoOperations.operationType,
          anchor_namespace_id: memoryCryptoOperations.anchorNamespaceId,
          expected_content_revision:
            memoryCryptoOperations.expectedContentRevision,
          result_access_revision: memoryCryptoOperations.resultAccessRevision,
          target_required_namespace_fingerprint:
            memoryCryptoOperations.targetRequiredNamespaceFingerprint,
          request_digest: memoryCryptoOperations.requestDigest,
          completion: memoryCryptoOperations.completion,
          disposition: memoryCryptoOperations.disposition,
          expected_access_revision: memoryCryptoOperations.expectedAccessRevision,
          ordinary_fallback_reason: memoryCryptoOperations.ordinaryFallbackReason,
        }).from(memoryCryptoOperations)
          .where(eq(memoryCryptoOperations.operationId, input.operationId))
          .limit(2),
      );
      if (rows.length === 0) return Object.freeze({ status: "absent" as const });
      const row = oneOrNull(rows, "Human Memory exact-access replay operation")!;
      if (
        rowString(row, "memory_id") !== input.memoryId
        || rowString(row, "operation_type") !== "access"
        || !bytesEqual(rowBytes(row, "request_digest"), input.signedRequestDigest)
      ) return Object.freeze({ status: "conflict" as const });
      const completion = rowString(row, "completion");
      const disposition = rowString(row, "disposition");
      if (completion === "ordinary_fallback" && disposition === "complete") {
        const reason = rowNullableString(row, "ordinary_fallback_reason");
        if (reason !== "encryption_pending" && reason !== "target_encryption_not_ready") {
          return Object.freeze({ status: "conflict" as const });
        }
        return Object.freeze({ status: "ordinary_fallback" as const,
          requestDigest: input.signedRequestDigest.slice(),
          cryptoAccessRevision: rowInteger(row, "expected_access_revision"),
          reason });
      }
      const complete = completion === "complete" && disposition === "complete";
      const product = await loadProduct(tx, input.memoryId);
      if (!input.authority.readableNamespaceIds.includes(
        rowString(row, "anchor_namespace_id"),
      )) return Object.freeze({ status: "conflict" as const });
      if (!complete) {
        if (rowString(row, "completion") !== "pending"
          || rowString(row, "disposition") !== "active") {
          return Object.freeze({ status: "conflict" as const });
        }
        const requestDigest = input.signedRequestDigest.slice();
        return Object.freeze({
          status: "pending" as const,
          requestDigest,
          cryptoObjectId: product.objectId,
          replayAdmission: mintReplayAdmission({
            operationId: input.operationId,
            memoryId: input.memoryId,
            subjectHumanId: input.subjectHumanId,
            requestDigest,
          }),
        });
      }
      const resultAccessRevision = rowInteger(row, "result_access_revision");
      if (
        product.contentRevision !== rowInteger(row, "expected_content_revision")
        || product.accessRevision !== resultAccessRevision
        || !bytesEqual(
          product.fingerprint,
          rowBytes(row, "target_required_namespace_fingerprint"),
        )
      ) return Object.freeze({ status: "conflict" as const });
      return Object.freeze({
        status: "completed" as const,
        requestDigest: input.signedRequestDigest.slice(),
        cryptoAccessRevision: resultAccessRevision,
        requiredNamespaceIds: product.namespaceIds,
      });
    });
  }

  reserve(input: Readonly<{
    authority: HumanMemoryExactAccessAuthority;
    plan: HumanMemoryExactAccessPlan;
    signedRequestDigest: Uint8Array;
  }>): Promise<"reserved" | "replayed"> {
    if (input.signedRequestDigest.length !== 32) {
      throw new TypeError("Human Memory signed access request digest is invalid");
    }
    return this.#transaction(input.authority, async (tx) => {
      const product = await loadProduct(tx, input.plan.memoryId);
      if (
        product.contentRevision !== input.plan.expectedContentRevision
        || product.accessRevision !== input.plan.expectedCryptoAccessRevision
        || product.objectId !== input.plan.cryptoObjectId
        || !exactSet(product.namespaceIds, input.plan.currentNamespaceIds)
        || !bytesEqual(product.fingerprint, input.plan.currentRequiredNamespaceFingerprint)
      ) throw new Error("Human Memory exact-access reservation became stale");
      deriveHumanMemoryExactAccessChange({
        authority: input.authority,
        currentNamespaceIds: product.namespaceIds,
        proposedTargetNamespaceIds: input.plan.targetNamespaceIds,
      });
      const existing = oneOrNull(await tx.query(
        `/* human-memory:exact-access:operation */
         SELECT operation_id, memory_id::text AS memory_id, operation_type,
                anchor_namespace_id::text AS anchor_namespace_id,
                expected_content_revision, result_content_revision,
                expected_access_revision, result_access_revision,
                request_digest, target_required_namespace_fingerprint,
                completion, disposition
           FROM memory_crypto_operations
          WHERE operation_id = $1 LIMIT 2 FOR UPDATE`,
        [input.plan.operationId],
      ), "Human Memory exact-access operation");
      if (existing !== null) {
        if (!operationMatchesPlan(existing, input.plan, input.signedRequestDigest)) {
          throw new Error("Human Memory exact-access replay conflicts");
        }
        return "replayed" as const;
      }
      await executeTypedConversationProductQuery(
        tx,
        conversationProductTypedDb.insert(memoryCryptoOperations).values({
          operationId: input.plan.operationId,
          memoryId: input.plan.memoryId,
          anchorNamespaceId: input.plan.anchorNamespaceId,
          operationType: "access",
          expectedContentRevision: input.plan.expectedContentRevision,
          resultContentRevision: null,
          expectedAccessRevision: input.plan.expectedCryptoAccessRevision,
          resultAccessRevision: input.plan.nextCryptoAccessRevision,
          targetRequiredNamespaceFingerprint:
            input.plan.targetRequiredNamespaceFingerprint,
          requestDigest: input.signedRequestDigest,
        }),
      );
      return "reserved" as const;
    }, true);
  }

  commit(input: Readonly<{
    authority: HumanMemoryExactAccessAuthority;
    plan: HumanMemoryExactAccessPlan;
    receipt: HumanMemoryExactAccessCryptoReceipt;
  }>): Promise<HumanMemoryExactAccessCommitResult> {
    const preparedAuthority = input.receipt.publicationAuthority;
    if (preparedAuthority === undefined || !receiptMatches(input.receipt, input.plan)) {
      throw new TypeError("Human Memory exact-access crypto receipt was substituted");
    }
    return this.#publication.withLocks({
      authority: input.authority,
      preparedAuthority,
      plan: input.plan,
    }, (lockCryptoAuthority) => this.#canonicalRunner.transaction(
      async (transaction, tx) => {
      await assertIdentity(tx, input.authority);
      await this.#publication.fence({ transaction, authority: input.authority });
      await lockCryptoAuthority();
      const operation = oneOrNull(await tx.query(
        `/* human-memory:exact-access:operation */
         SELECT operation_id, memory_id::text AS memory_id, operation_type,
                anchor_namespace_id::text AS anchor_namespace_id,
                expected_content_revision, result_content_revision,
                expected_access_revision, result_access_revision,
                request_digest, target_required_namespace_fingerprint,
                completion, disposition
           FROM memory_crypto_operations
          WHERE operation_id = $1 LIMIT 2 FOR UPDATE`,
        [input.plan.operationId],
      ), "Human Memory exact-access operation");
      if (operation === null) throw new Error("Human Memory exact-access reservation is absent");
      const operationMatches = operationMatchesPlan(
        operation,
        input.plan,
        input.receipt.requestDigest,
      );
      if (!operationMatches) throw new Error("Human Memory exact-access reservation conflicts");
      const product = await loadProduct(tx, input.plan.memoryId);
      if (
        rowString(operation, "completion") === "complete"
        && rowString(operation, "disposition") === "complete"
        && product.contentRevision === input.plan.expectedContentRevision
        && product.accessRevision === input.plan.nextCryptoAccessRevision
        && product.mappingState === "verified"
        && exactSet(product.namespaceIds, input.plan.targetNamespaceIds)
        && bytesEqual(product.fingerprint, input.plan.targetRequiredNamespaceFingerprint)
      ) {
        return Object.freeze({
          status: "replayed" as const,
          operationId: input.plan.operationId,
          memoryId: input.plan.memoryId,
          cryptoAccessRevision: input.plan.nextCryptoAccessRevision,
          requiredNamespaceIds: input.plan.targetNamespaceIds,
        });
      }
      if (
        product.contentRevision !== input.plan.expectedContentRevision
        || product.accessRevision !== input.plan.expectedCryptoAccessRevision
        || product.objectId !== input.plan.cryptoObjectId
        || !exactSet(product.namespaceIds, input.plan.currentNamespaceIds)
        || !bytesEqual(product.fingerprint, input.plan.currentRequiredNamespaceFingerprint)
      ) throw new Error("Human Memory exact-access product became stale");
      deriveHumanMemoryExactAccessChange({
        authority: input.authority,
        currentNamespaceIds: product.namespaceIds,
        proposedTargetNamespaceIds: input.plan.targetNamespaceIds,
      });
      if (input.plan.targetNamespaceIds.length === 0) {
        const deleted = await executeTypedConversationProductQuery(
          tx,
          conversationProductTypedDb.delete(memories).where(and(
            eq(memories.id, input.plan.memoryId),
            eq(memories.contentRevision, input.plan.expectedContentRevision),
            eq(memories.cryptoAccessRevision, input.plan.expectedCryptoAccessRevision),
            eq(memories.cryptoObjectId, input.plan.cryptoObjectId),
            sql`${memories.cryptoRequiredNamespaceFingerprint} = ${
              input.plan.currentRequiredNamespaceFingerprint
            }`,
          )).returning({ id: memories.id }),
        );
        if (deleted.length !== 1 || deleted[0]?.["id"] !== input.plan.memoryId) {
          throw new Error("Human Memory exact-access hard delete lost its CAS");
        }
      } else {
      for (const namespaceId of input.plan.removedNamespaceIds) {
        const rows = await executeTypedConversationProductQuery(
          tx,
          conversationProductTypedDb.delete(memoryNamespaces)
            .where(and(
              eq(memoryNamespaces.memoryId, input.plan.memoryId),
              eq(memoryNamespaces.namespaceId, namespaceId),
            ))
            .returning({ namespace_id: memoryNamespaces.namespaceId }),
        );
        if (rows.length !== 1 || rows[0]?.["namespace_id"] !== namespaceId) {
          throw new Error("Human Memory exact-access removal lost its CAS");
        }
      }
      for (const namespaceId of input.plan.addedNamespaceIds) {
        const rows = await executeTypedConversationProductQuery(
          tx,
          conversationProductTypedDb.insert(memoryNamespaces).values({
            memoryId: input.plan.memoryId,
            namespaceId,
          }).returning({ namespace_id: memoryNamespaces.namespaceId }),
        );
        if (rows.length !== 1 || rows[0]?.["namespace_id"] !== namespaceId) {
          throw new Error("Human Memory exact-access addition lost its CAS");
        }
      }
      const mapped = await executeTypedConversationProductQuery(
        tx,
        conversationProductTypedDb.update(memories).set({
          cryptoMappingState: "verified",
          cryptoAccessRevision: input.plan.nextCryptoAccessRevision,
          cryptoRequiredNamespaceFingerprint:
            input.plan.targetRequiredNamespaceFingerprint,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        }).where(and(
          eq(memories.id, input.plan.memoryId),
          eq(memories.contentRevision, input.plan.expectedContentRevision),
          eq(memories.cryptoMappingState, "stale"),
          eq(
            memories.cryptoAccessRevision,
            input.plan.expectedCryptoAccessRevision,
          ),
          eq(memories.cryptoObjectId, input.plan.cryptoObjectId),
          sql`${memories.cryptoRequiredNamespaceFingerprint} = ${
            input.plan.currentRequiredNamespaceFingerprint
          }`,
        )).returning({ id: memories.id }),
      );
      if (mapped.length !== 1 || mapped[0]?.["id"] !== input.plan.memoryId) {
        throw new Error("Human Memory exact-access mapping lost its CAS");
      }
      }
      const completed = await executeTypedConversationProductQuery(
        tx,
        conversationProductTypedDb.update(memoryCryptoOperations).set({
          completion: "complete",
          disposition: "complete",
          cryptoCompletedAt:
            sql`COALESCE(${memoryCryptoOperations.cryptoCompletedAt}, CURRENT_TIMESTAMP)`,
          nextAttemptAt: null,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        }).where(and(
          eq(memoryCryptoOperations.operationId, input.plan.operationId),
          eq(memoryCryptoOperations.memoryId, input.plan.memoryId),
          eq(memoryCryptoOperations.completion, "pending"),
          eq(memoryCryptoOperations.disposition, "active"),
        )).returning({ operation_id: memoryCryptoOperations.operationId }),
      );
      if (completed.length !== 1) {
        throw new Error("Human Memory exact-access receipt completion lost its CAS");
      }
      return Object.freeze({
        status: "updated" as const,
        operationId: input.plan.operationId,
        memoryId: input.plan.memoryId,
        cryptoAccessRevision: input.plan.nextCryptoAccessRevision,
        requiredNamespaceIds: input.plan.targetNamespaceIds,
      });
      }, { isolationLevel: "serializable" }));
  }

  /**
   * Recovers only from a restricted, authenticated crypto-head observation.
   * The observation carries no envelope or key bytes and cannot invent a new
   * signed target. Exact target IDs reconstruct the product plan and its
   * durable digest after process restart.
   */
  async reconcile(input: Readonly<{
    authority: HumanMemoryExactAccessAuthority;
    operationId: string;
    memoryId: string;
    crypto: HumanMemoryExactAccessCryptoObservation;
  }>): Promise<HumanMemoryExactAccessReconcileResult> {
    if (!PORTABLE_ID.test(input.operationId) || !UUID.test(input.memoryId)) {
      return Object.freeze({ status: "quarantined" as const });
    }
    const recovered = await this.#transaction(input.authority, async (tx) => {
      const operation = oneOrNull(await tx.query(
        `/* human-memory:exact-access:operation */
         SELECT operation_id, memory_id::text AS memory_id, operation_type,
                anchor_namespace_id::text AS anchor_namespace_id,
                expected_content_revision, result_content_revision,
                expected_access_revision, result_access_revision,
                request_digest, target_required_namespace_fingerprint,
                completion, disposition
           FROM memory_crypto_operations
          WHERE operation_id = $1 LIMIT 2 FOR UPDATE`,
        [input.operationId],
      ), "Human Memory exact-access operation");
      if (
        operation === null
        || rowString(operation, "memory_id") !== input.memoryId
        || rowString(operation, "operation_type") !== "access"
      ) return { kind: "quarantined" as const };
      const product = await loadProduct(tx, input.memoryId);
      if (input.crypto.status === "absent" || input.crypto.status === "conflict") {
        return { kind: "quarantined" as const };
      }
      let observedIds: readonly string[];
      try {
        observedIds = canonicalIds(input.crypto.namespaceIds);
      } catch {
        return { kind: "quarantined" as const };
      }
      const manifestHash: unknown = input.crypto.manifestHash;
      if (
        input.crypto.objectId !== product.objectId
        || !(manifestHash instanceof Uint8Array)
        || manifestHash.length !== 32
      ) return { kind: "quarantined" as const };
      const expectedContentRevision = rowInteger(
        operation,
        "expected_content_revision",
      );
      const expectedAccessRevision = rowInteger(
        operation,
        "expected_access_revision",
      );
      const nextAccessRevision = rowInteger(operation, "result_access_revision");
      const targetFingerprint = rowBytes(
        operation,
        "target_required_namespace_fingerprint",
      );
      if (
        rowString(operation, "completion") === "complete"
        && rowString(operation, "disposition") === "complete"
      ) {
        return product.contentRevision === expectedContentRevision
            && product.accessRevision === nextAccessRevision
            && product.mappingState === "verified"
            && input.crypto.status === "target"
            && input.crypto.accessRevision === nextAccessRevision
            && exactSet(product.namespaceIds, observedIds)
            && bytesEqual(product.fingerprint, targetFingerprint)
          ? {
              kind: "completed" as const,
              cryptoAccessRevision: product.accessRevision,
              requiredNamespaceIds: product.namespaceIds,
            }
          : { kind: "quarantined" as const };
      }
      if (
        product.contentRevision !== expectedContentRevision
        || product.accessRevision !== expectedAccessRevision
        || nextAccessRevision !== expectedAccessRevision + 1
      ) return { kind: "stale" as const };
      if (input.crypto.status === "current") {
        return input.crypto.accessRevision === expectedAccessRevision
            && exactSet(product.namespaceIds, observedIds)
          ? { kind: "pending" as const }
          : { kind: "quarantined" as const };
      }
      const previousManifestHash: unknown = input.crypto.previousManifestHash;
      if (
        input.crypto.accessRevision !== nextAccessRevision
        || !(previousManifestHash instanceof Uint8Array)
        || previousManifestHash.length !== 32
        || !bytesEqual(
          fingerprintHumanMemoryExactAccessTarget(observedIds),
          targetFingerprint,
        )
      ) return { kind: "quarantined" as const };
      let change: HumanMemoryExactAccessChange;
      try {
        change = deriveHumanMemoryExactAccessChange({
          authority: input.authority,
          currentNamespaceIds: product.namespaceIds,
          proposedTargetNamespaceIds: observedIds,
        });
      } catch {
        return { kind: "denied" as const };
      }
      if (change.status !== "changed") return { kind: "quarantined" as const };
      const signedRequestDigest = rowBytes(operation, "request_digest");
      const plan: HumanMemoryExactAccessPlan = Object.freeze({
        ...change,
        status: "prepared",
        operationId: input.operationId,
        subjectHumanId: input.authority.subjectHumanId,
        anchorNamespaceId: rowString(operation, "anchor_namespace_id"),
        memoryId: input.memoryId,
        cryptoObjectId: product.objectId,
        expectedContentRevision,
        expectedCryptoAccessRevision: expectedAccessRevision,
        nextCryptoAccessRevision: nextAccessRevision,
        currentRequiredNamespaceFingerprint: product.fingerprint,
        targetRequiredNamespaceFingerprint: targetFingerprint,
      });
      if (!operationMatchesPlan(operation, plan, signedRequestDigest)) {
        return { kind: "quarantined" as const };
      }
      const receipt: HumanMemoryExactAccessCryptoReceipt = Object.freeze({
        operationId: input.operationId,
        memoryId: input.memoryId,
        objectId: product.objectId,
        expectedContentRevision,
        expectedAccessRevision,
        resultAccessRevision: nextAccessRevision,
        currentManifestHash: previousManifestHash.slice(),
        resultManifestHash: manifestHash.slice(),
        targetRequiredNamespaceFingerprint: targetFingerprint,
        requestDigest: signedRequestDigest,
        currentNamespaceIds: product.namespaceIds,
        targetNamespaceIds: observedIds,
        status: "duplicate",
      });
      return { kind: "recoverable" as const, plan, receipt };
    });
    if (recovered.kind === "pending") {
      return Object.freeze({ status: "pending" as const, phase: "crypto" as const });
    }
    if (recovered.kind === "completed") {
      return Object.freeze({
        status: "completed" as const,
        operationId: input.operationId,
        memoryId: input.memoryId,
        cryptoAccessRevision: recovered.cryptoAccessRevision,
        requiredNamespaceIds: recovered.requiredNamespaceIds,
      });
    }
    if (recovered.kind !== "recoverable") {
      return Object.freeze({ status: recovered.kind });
    }
    // A restricted head proves crypto durability, but it cannot recreate the
    // signed current Human device/Domain authority needed to publish product
    // edges. The exact signed request retry must reauthenticate that authority.
    return Object.freeze({
      status: "pending" as const,
      phase: "crypto" as const,
    });
  }
}
