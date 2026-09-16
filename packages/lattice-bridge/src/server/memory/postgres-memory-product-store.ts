import {
  MEMORY_PAYLOAD_VERSION,
  MEMORY_RECONCILE_MAX_ATTEMPTS,
  MEMORY_RECONCILE_MAX_BATCH,
  assertMemoryRevisionLifecycle,
  fingerprintRequiredMemoryNamespaces,
  type MemoryFailureCode,
  type MemoryProductMapping,
  type MemoryProductMappingCasResult,
  type MemoryProductStorePort,
  type MemoryRevisionDisposition,
  type MemoryRevisionLifecycle,
  type MemoryRevisionState,
} from "../../memory/memory-repository.ts";
import { resolveRequiredMemoryNamespaceIds } from "../../memory/required-namespace-set.ts";
import {
  assertVerifiedConversationProductPostgresHandle,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresHandle,
  type ConversationProductPostgresTransaction,
} from "../message/postgres-conversation-product-store.ts";

const MEMORY_RECONCILE_LEASE_SECONDS = 60;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FAILURE_CODES = new Set<MemoryFailureCode>([
  "namespace_unresolved",
  "scope_origin_unresolved",
  "crypto_absent",
  "crypto_incomplete",
  "crypto_mismatch",
  "authorization_unavailable",
  "recipient_unavailable",
  "target_encryption_not_ready",
  "embedding_unavailable",
  "storage_transient",
  "mapping_conflict",
  "retry_exhausted",
]);
const DISPOSITIONS = new Set<MemoryRevisionDisposition>([
  "active",
  "mapped",
  "blocked",
  "quarantined",
  "superseded",
  "hard_delete",
  "stale_mapping",
]);

const LIFECYCLE_COLUMNS = `lifecycle.sequence,
       lifecycle.memory_id,
       lifecycle.content_revision,
       lifecycle.anchor_namespace_id,
       lifecycle.crypto_object_id,
       lifecycle.payload_version,
       lifecycle.allocation_request_digest,
       lifecycle.required_namespace_fingerprint,
       lifecycle.completion,
       lifecycle.disposition,
       lifecycle.attempt_count,
       lifecycle.next_attempt_at,
       lifecycle.lease_token,
       lifecycle.lease_expires_at,
       lifecycle.failure_code,
       lifecycle.crypto_completed_at`;

const memoryLifecycleSelection = {
  sequence: memoryCryptoRevisions.sequence,
  memory_id: memoryCryptoRevisions.memoryId,
  content_revision: memoryCryptoRevisions.contentRevision,
  anchor_namespace_id: memoryCryptoRevisions.anchorNamespaceId,
  crypto_object_id: memoryCryptoRevisions.cryptoObjectId,
  payload_version: memoryCryptoRevisions.payloadVersion,
  allocation_request_digest: memoryCryptoRevisions.allocationRequestDigest,
  required_namespace_fingerprint:
    memoryCryptoRevisions.requiredNamespaceFingerprint,
  completion: memoryCryptoRevisions.completion,
  disposition: memoryCryptoRevisions.disposition,
  attempt_count: memoryCryptoRevisions.attemptCount,
  next_attempt_at: memoryCryptoRevisions.nextAttemptAt,
  lease_token: memoryCryptoRevisions.leaseToken,
  lease_expires_at: memoryCryptoRevisions.leaseExpiresAt,
  failure_code: memoryCryptoRevisions.failureCode,
  crypto_completed_at: memoryCryptoRevisions.cryptoCompletedAt,
} as const;

function oneOrNone(
  rows: readonly ConversationProductDatabaseRow[],
  label: string,
): ConversationProductDatabaseRow | null {
  if (rows.length > 1) throw new Error(`${label} returned duplicate rows`);
  return rows[0] ?? null;
}

function requiredString(
  row: ConversationProductDatabaseRow,
  name: string,
): string {
  const value = row[name];
  if (typeof value !== "string") throw new TypeError(`${name} is not text`);
  return value;
}

function nullableString(
  row: ConversationProductDatabaseRow,
  name: string,
): string | null {
  const value = row[name];
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${name} is not text`);
  return value;
}

function requiredInteger(
  row: ConversationProductDatabaseRow,
  name: string,
): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${name} is not an integer`);
  }
  return value;
}

function requiredBytes(
  row: ConversationProductDatabaseRow,
  name: string,
): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${name} is not binary`);
  }
  return new Uint8Array(value);
}

function nullableBytes(
  row: ConversationProductDatabaseRow,
  name: string,
): Uint8Array | null {
  const value = row[name];
  if (value === null) return null;
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${name} is not binary`);
  }
  return new Uint8Array(value);
}

function nullableDate(
  row: ConversationProductDatabaseRow,
  name: string,
): Date | null {
  const value = row[name];
  if (value === null) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${name} is not a timestamp`);
  }
  return new Date(value);
}

function requiredBoolean(
  row: ConversationProductDatabaseRow,
  name: string,
): boolean {
  const value = row[name];
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} is not boolean`);
  }
  return value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function assertUuid(label: string, value: string): void {
  if (!UUID.test(value)) throw new TypeError(`${label} must be a UUID`);
}

function assertCoordinates(input: Readonly<{
  memoryId: string;
  contentRevision: number;
}>): void {
  assertUuid("Memory ID", input.memoryId);
  if (
    !Number.isSafeInteger(input.contentRevision)
    || input.contentRevision < 1
    || input.contentRevision > 2_147_483_647
  ) throw new RangeError("Memory content revision is invalid");
}

function assertObjectId(value: string): void {
  if (
    value.length < 1
    || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
  ) throw new TypeError("Memory crypto object ID is invalid");
}

function assertFailureCode(value: MemoryFailureCode): void {
  if (!FAILURE_CODES.has(value)) {
    throw new TypeError("Memory failure code is invalid");
  }
}

function lifecycleFromRow(
  row: ConversationProductDatabaseRow,
): MemoryRevisionLifecycle {
  const memoryId = requiredString(row, "memory_id");
  const anchorNamespaceId = requiredString(row, "anchor_namespace_id");
  const cryptoObjectId = requiredString(row, "crypto_object_id");
  const completion = requiredString(row, "completion");
  const disposition = requiredString(row, "disposition");
  const failureCode = nullableString(row, "failure_code");
  const leaseToken = nullableString(row, "lease_token");
  const leaseExpiresAt = nullableDate(row, "lease_expires_at");
  assertUuid("Memory ID", memoryId);
  assertUuid("Memory anchor Namespace ID", anchorNamespaceId);
  assertObjectId(cryptoObjectId);
  if (completion !== "pending" && completion !== "complete") {
    throw new TypeError("Memory completion is invalid");
  }
  if (!DISPOSITIONS.has(disposition as MemoryRevisionDisposition)) {
    throw new TypeError("Memory disposition is invalid");
  }
  if (failureCode !== null && !FAILURE_CODES.has(failureCode as MemoryFailureCode)) {
    throw new TypeError("Memory failure code is invalid");
  }
  if (leaseToken !== null) assertUuid("Memory lease token", leaseToken);
  if ((leaseToken === null) !== (leaseExpiresAt === null)) {
    throw new TypeError("Memory lease is incoherent");
  }
  const lifecycle = Object.freeze({
    sequence: requiredInteger(row, "sequence"),
    memoryId,
    contentRevision: requiredInteger(row, "content_revision"),
    anchorNamespaceId,
    cryptoObjectId,
    payloadVersion: requiredInteger(row, "payload_version") as 1,
    allocationRequestDigest: requiredBytes(row, "allocation_request_digest"),
    requiredNamespaceFingerprint: requiredBytes(
      row,
      "required_namespace_fingerprint",
    ),
    completion,
    disposition: disposition as MemoryRevisionDisposition,
    attemptCount: requiredInteger(row, "attempt_count"),
    nextAttemptAt: nullableDate(row, "next_attempt_at"),
    leaseToken,
    leaseExpiresAt,
    failureCode: failureCode as MemoryFailureCode | null,
    cryptoCompletedAt: nullableDate(row, "crypto_completed_at"),
  });
  assertMemoryRevisionLifecycle(lifecycle);
  if (lifecycle.payloadVersion !== MEMORY_PAYLOAD_VERSION) {
    throw new TypeError("Memory payload version is invalid");
  }
  return lifecycle;
}

function productFromRow(
  row: ConversationProductDatabaseRow | null,
): MemoryProductMapping | null {
  if (row === null) return null;
  const memoryId = requiredString(row, "memory_id");
  const cryptoObjectId = nullableString(row, "crypto_object_id");
  const fingerprint = nullableBytes(
    row,
    "crypto_required_namespace_fingerprint",
  );
  assertUuid("Memory ID", memoryId);
  if (cryptoObjectId !== null) assertObjectId(cryptoObjectId);
  if ((cryptoObjectId === null) !== (fingerprint === null)) {
    throw new TypeError("Memory product mapping is incoherent");
  }
  return Object.freeze({
    memoryId,
    contentRevision: requiredInteger(row, "content_revision"),
    cryptoObjectId,
    cryptoAccessRevision: requiredInteger(row, "crypto_access_revision"),
    cryptoRequiredNamespaceFingerprint: fingerprint,
  });
}

function leaseMatches(
  row: ConversationProductDatabaseRow,
  lifecycle: MemoryRevisionLifecycle,
  token: string | null,
): boolean {
  return lifecycle.leaseToken === token
    && (token === null || requiredBoolean(row, "lease_is_live"));
}

export class PostgresMemoryProductStore implements MemoryProductStorePort {
  readonly #handle: ConversationProductPostgresHandle;

  constructor(handle: ConversationProductPostgresHandle) {
    assertVerifiedConversationProductPostgresHandle(handle);
    if (handle.role !== "nautilo") {
      throw new TypeError(
        "Memory product store requires a direct nautilo product-role handle",
      );
    }
    this.#handle = handle;
  }

  async getRevision(input: Readonly<{
    memoryId: string;
    contentRevision: number;
  }>): Promise<MemoryRevisionState | null> {
    assertCoordinates(input);
    return this.#handle.transaction(
      (transaction) => this.#loadState(transaction, input, false),
      { isolationLevel: "serializable" },
    );
  }

  async markCryptoComplete(input: Readonly<{
    memoryId: string;
    contentRevision: number;
    cryptoObjectId: string;
    leaseToken: string | null;
  }>): Promise<"applied" | "duplicate" | "missing" | "conflict"> {
    assertCoordinates(input);
    assertObjectId(input.cryptoObjectId);
    if (input.leaseToken !== null) assertUuid("Memory lease token", input.leaseToken);
    return this.#handle.transaction(async (transaction) => {
      const row = await this.#lockedLifecycle(transaction, input, true);
      if (row === null) return "missing";
      const lifecycle = lifecycleFromRow(row);
      if (
        lifecycle.cryptoObjectId !== input.cryptoObjectId
        || !leaseMatches(row, lifecycle, input.leaseToken)
        || ["blocked", "quarantined", "superseded", "hard_delete", "stale_mapping"]
          .includes(lifecycle.disposition)
      ) return "conflict";
      if (lifecycle.completion === "complete") return "duplicate";
      const rows = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb
          .update(memoryCryptoRevisions)
          .set({
            completion: "complete",
            cryptoCompletedAt:
              sql`COALESCE(${memoryCryptoRevisions.cryptoCompletedAt}, CURRENT_TIMESTAMP)`,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(and(
            eq(memoryCryptoRevisions.memoryId, input.memoryId),
            eq(memoryCryptoRevisions.contentRevision, input.contentRevision),
            eq(memoryCryptoRevisions.cryptoObjectId, input.cryptoObjectId),
            sql`${memoryCryptoRevisions.leaseToken} IS NOT DISTINCT FROM ${input.leaseToken}::uuid`,
          ))
          .returning({ sequence: memoryCryptoRevisions.sequence }),
      );
      return oneOrNone(rows, "Memory completion update") === null
        ? "conflict"
        : "applied";
    }, { isolationLevel: "serializable" });
  }

  async compareAndSwapCryptoMapping(input: Readonly<{
    memoryId: string;
    contentRevision: number;
    cryptoObjectId: string;
    expectedRequiredNamespaceFingerprint: Uint8Array;
    leaseToken: string | null;
  }>): Promise<MemoryProductMappingCasResult> {
    assertCoordinates(input);
    assertObjectId(input.cryptoObjectId);
    if (
      !(input.expectedRequiredNamespaceFingerprint instanceof Uint8Array)
      || input.expectedRequiredNamespaceFingerprint.length !== 32
    ) throw new TypeError("Expected Memory Namespace fingerprint is invalid");
    if (input.leaseToken !== null) assertUuid("Memory lease token", input.leaseToken);
    return this.#handle.transaction(async (transaction) => {
      const lifecycleRow = await this.#lockedLifecycle(transaction, input, true);
      if (lifecycleRow === null) return "missing";
      const lifecycle = lifecycleFromRow(lifecycleRow);
      if (!leaseMatches(lifecycleRow, lifecycle, input.leaseToken)) {
        return "lease_lost";
      }
      if (
        lifecycle.cryptoObjectId !== input.cryptoObjectId
        || lifecycle.completion !== "complete"
        || (lifecycle.disposition !== "active"
          && lifecycle.disposition !== "mapped")
      ) return "stale";

      const productRow = await this.#productRow(transaction, input.memoryId, true);
      if (productRow === null) {
        await this.#persistStaleMapping(transaction, lifecycle);
        return "missing";
      }
      const product = productFromRow(productRow)!;
      if (product.contentRevision !== input.contentRevision) {
        await this.#persistStaleMapping(transaction, lifecycle);
        return "stale";
      }
      const requiredNamespaceIds = await this.#requiredNamespaceIds(
        transaction,
        productRow,
      );
      const currentFingerprint = fingerprintRequiredMemoryNamespaces(
        requiredNamespaceIds,
      );
      if (
        !sameBytes(
          input.expectedRequiredNamespaceFingerprint,
          lifecycle.requiredNamespaceFingerprint,
        )
        || !sameBytes(currentFingerprint, lifecycle.requiredNamespaceFingerprint)
      ) {
        if (lifecycle.disposition === "active") {
          await this.#persistStaleMapping(transaction, lifecycle);
        }
        return "wrong_authority";
      }
      if (
        product.cryptoObjectId !== null
        && product.cryptoObjectId !== input.cryptoObjectId
      ) {
        await this.#persistStaleMapping(transaction, lifecycle);
        return "stale";
      }
      if (
        product.cryptoObjectId === input.cryptoObjectId
        && product.cryptoRequiredNamespaceFingerprint !== null
        && !sameBytes(
          product.cryptoRequiredNamespaceFingerprint,
          currentFingerprint,
        )
      ) {
        if (lifecycle.disposition === "active") {
          await this.#persistStaleMapping(transaction, lifecycle);
        }
        return "wrong_authority";
      }
      const duplicate = product.cryptoObjectId === input.cryptoObjectId;
      if (!duplicate) {
        const rows = await executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb
            .update(memories)
            .set({
              cryptoObjectId: input.cryptoObjectId,
              cryptoRequiredNamespaceFingerprint:
                input.expectedRequiredNamespaceFingerprint,
              cryptoMappingState: "verified",
              updatedAt: sql`CURRENT_TIMESTAMP`,
            })
            .where(and(
              eq(memories.id, input.memoryId),
              eq(memories.contentRevision, input.contentRevision),
              isNull(memories.cryptoObjectId),
            ))
            .returning({
              memory_id: sql`${memories.id}`.as("memory_id"),
            }),
        );
        if (oneOrNone(rows, "Memory mapping CAS") === null) {
          await this.#persistStaleMapping(transaction, lifecycle);
          return "stale";
        }
      }
      const mapped = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb
          .update(memoryCryptoRevisions)
          .set({
            disposition: "mapped",
            failureCode: null,
            nextAttemptAt: null,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(and(
            eq(memoryCryptoRevisions.memoryId, input.memoryId),
            eq(memoryCryptoRevisions.contentRevision, input.contentRevision),
            eq(memoryCryptoRevisions.cryptoObjectId, input.cryptoObjectId),
            eq(memoryCryptoRevisions.completion, "complete"),
            inArray(memoryCryptoRevisions.disposition, ["active", "mapped"]),
          ))
          .returning({ sequence: memoryCryptoRevisions.sequence }),
      );
      if (oneOrNone(mapped, "Memory mapped lifecycle") === null) {
        throw new Error("Memory mapping lost its lifecycle CAS");
      }
      return duplicate ? "duplicate" : "applied";
    }, { isolationLevel: "serializable" });
  }

  async quarantineRevision(input: Readonly<{
    memoryId: string;
    contentRevision: number;
    leaseToken: string | null;
    failureCode: MemoryFailureCode;
  }>): Promise<"applied" | "duplicate" | "missing" | "conflict"> {
    assertCoordinates(input);
    assertFailureCode(input.failureCode);
    if (input.failureCode === "retry_exhausted") {
      throw new TypeError(
        "retry_exhausted is reserved for the eighth failed claim",
      );
    }
    if (input.leaseToken !== null) assertUuid("Memory lease token", input.leaseToken);
    return this.#handle.transaction(async (transaction) => {
      const row = await this.#lockedLifecycle(transaction, input, true);
      if (row === null) return "missing";
      const lifecycle = lifecycleFromRow(row);
      if (lifecycle.disposition === "quarantined") {
        return lifecycle.failureCode === input.failureCode
          ? "duplicate"
          : "conflict";
      }
      if (!leaseMatches(row, lifecycle, input.leaseToken)) return "conflict";
      if (lifecycle.disposition !== "active") return "conflict";
      const rows = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb
          .update(memoryCryptoRevisions)
          .set({
            disposition: "quarantined",
            failureCode: input.failureCode,
            nextAttemptAt: null,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(and(
            eq(memoryCryptoRevisions.memoryId, input.memoryId),
            eq(memoryCryptoRevisions.contentRevision, input.contentRevision),
            sql`${memoryCryptoRevisions.leaseToken} IS NOT DISTINCT FROM ${input.leaseToken}::uuid`,
            eq(memoryCryptoRevisions.disposition, "active"),
          ))
          .returning({ sequence: memoryCryptoRevisions.sequence }),
      );
      return oneOrNone(rows, "Memory quarantine") === null
        ? "conflict"
        : "applied";
    }, { isolationLevel: "serializable" });
  }

  async claimReconciliationCandidates(input: Readonly<{
    leaseToken: string;
    limit: number;
  }>): Promise<readonly MemoryRevisionState[]> {
    assertUuid("Memory lease token", input.leaseToken);
    if (
      !Number.isSafeInteger(input.limit)
      || input.limit < 1
      || input.limit > MEMORY_RECONCILE_MAX_BATCH
    ) throw new RangeError("Memory claim limit is out of bounds");
    return this.#handle.transaction(async (transaction) => {
      const claimed = await transaction.query(
        `WITH candidates AS (
           SELECT lifecycle.sequence
             FROM memory_crypto_revisions AS lifecycle
            WHERE lifecycle.disposition = 'active'
              AND lifecycle.attempt_count < ${MEMORY_RECONCILE_MAX_ATTEMPTS}
              AND lifecycle.next_attempt_at <= CURRENT_TIMESTAMP
              AND (
                lifecycle.lease_token IS NULL
                OR lifecycle.lease_expires_at <= CURRENT_TIMESTAMP
              )
            ORDER BY lifecycle.next_attempt_at, lifecycle.sequence
            LIMIT $3
            FOR UPDATE OF lifecycle SKIP LOCKED
         )
         UPDATE memory_crypto_revisions AS lifecycle
            SET lease_token = $1::uuid,
                lease_expires_at = CURRENT_TIMESTAMP
                  + $2 * interval '1 second',
                updated_at = CURRENT_TIMESTAMP
           FROM candidates
          WHERE lifecycle.sequence = candidates.sequence
          RETURNING lifecycle.sequence,
                    lifecycle.memory_id,
                    lifecycle.content_revision,
                    lifecycle.next_attempt_at`,
        [input.leaseToken, MEMORY_RECONCILE_LEASE_SECONDS, input.limit],
      );
      if (claimed.length > input.limit) {
        throw new Error("Memory claim exceeded its requested limit");
      }
      const ordered = [...claimed].sort((left, right) => {
        const leftDue = nullableDate(left, "next_attempt_at")?.getTime()
          ?? Number.NEGATIVE_INFINITY;
        const rightDue = nullableDate(right, "next_attempt_at")?.getTime()
          ?? Number.NEGATIVE_INFINITY;
        return leftDue - rightDue
          || requiredInteger(left, "sequence") - requiredInteger(right, "sequence");
      });
      const states: MemoryRevisionState[] = [];
      for (const row of ordered) {
        const state = await this.#loadState(transaction, {
          memoryId: requiredString(row, "memory_id"),
          contentRevision: requiredInteger(row, "content_revision"),
        }, false);
        if (state === null) throw new Error("Claimed Memory lifecycle disappeared");
        states.push(state);
      }
      return Object.freeze(states);
    }, { isolationLevel: "read committed" });
  }

  async failReconciliationClaim(input: Readonly<{
    memoryId: string;
    contentRevision: number;
    leaseToken: string;
    failureCode: MemoryFailureCode;
  }>): Promise<MemoryRevisionLifecycle | null> {
    assertCoordinates(input);
    assertUuid("Memory lease token", input.leaseToken);
    assertFailureCode(input.failureCode);
    if (input.failureCode === "retry_exhausted") {
      throw new TypeError(
        "retry_exhausted is reserved for the eighth failed claim",
      );
    }
    return this.#handle.transaction(async (transaction) => {
      const rows = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb
          .update(memoryCryptoRevisions)
          .set({
            attemptCount: sql`${memoryCryptoRevisions.attemptCount} + 1`,
            disposition: sql`CASE
              WHEN ${memoryCryptoRevisions.attemptCount} + 1
                >= ${MEMORY_RECONCILE_MAX_ATTEMPTS}
              THEN 'quarantined'
              ELSE 'active'
            END`,
            failureCode: sql`CASE
              WHEN ${memoryCryptoRevisions.attemptCount} + 1
                >= ${MEMORY_RECONCILE_MAX_ATTEMPTS}
              THEN 'retry_exhausted'
              ELSE ${input.failureCode}
            END`,
            nextAttemptAt: sql`CASE
              WHEN ${memoryCryptoRevisions.attemptCount} + 1
                >= ${MEMORY_RECONCILE_MAX_ATTEMPTS}
              THEN NULL
              ELSE CURRENT_TIMESTAMP
                + LEAST(
                    300000,
                    (1000 * power(2, ${memoryCryptoRevisions.attemptCount}))::bigint
                  ) * interval '1 millisecond'
            END`,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(and(
            eq(memoryCryptoRevisions.memoryId, input.memoryId),
            eq(memoryCryptoRevisions.contentRevision, input.contentRevision),
            eq(memoryCryptoRevisions.leaseToken, input.leaseToken),
            sql`${memoryCryptoRevisions.leaseExpiresAt} > CURRENT_TIMESTAMP`,
            eq(memoryCryptoRevisions.disposition, "active"),
            sql`${memoryCryptoRevisions.attemptCount} < ${MEMORY_RECONCILE_MAX_ATTEMPTS}`,
          ))
          .returning(memoryLifecycleSelection),
      );
      const row = oneOrNone(rows, "Memory failed claim");
      return row === null ? null : lifecycleFromRow(row);
    }, { isolationLevel: "serializable" });
  }

  async #loadState(
    transaction: ConversationProductPostgresTransaction,
    coordinates: Readonly<{ memoryId: string; contentRevision: number }>,
    lock: boolean,
  ): Promise<MemoryRevisionState | null> {
    const lifecycleRow = lock
      ? await this.#lockedLifecycle(transaction, coordinates, false)
      : oneOrNone(await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb
          .select()
          .from(memoryCryptoRevisions)
          .where(and(
            eq(memoryCryptoRevisions.memoryId, coordinates.memoryId),
            eq(
              memoryCryptoRevisions.contentRevision,
              coordinates.contentRevision,
            ),
          ))
          .limit(2),
      ), "Memory lifecycle lookup");
    if (lifecycleRow === null) return null;
    const lifecycle = lifecycleFromRow(lifecycleRow);
    const productRow = await this.#productRow(
      transaction,
      coordinates.memoryId,
      lock,
    );
    const product = productFromRow(productRow);
    const requiredNamespaceIds = productRow === null
      ? Object.freeze([lifecycle.anchorNamespaceId])
      : await this.#requiredNamespaceIds(transaction, productRow);
    return Object.freeze({ product, lifecycle, requiredNamespaceIds });
  }

  async #productRow(
    transaction: ConversationProductPostgresTransaction,
    memoryId: string,
    lock: boolean,
  ): Promise<ConversationProductDatabaseRow | null> {
    const rows = await transaction.query(
      `SELECT memory_row.id AS memory_id,
              memory_row.content_revision,
              memory_row.crypto_object_id,
              memory_row.crypto_access_revision,
              memory_row.crypto_required_namespace_fingerprint,
              memory_row.scope_origin_namespace_id
         FROM memories AS memory_row
        WHERE memory_row.id = $1
        LIMIT 2${lock ? "\n        FOR UPDATE OF memory_row" : ""}`,
      [memoryId],
    );
    return oneOrNone(rows, "Memory product lookup");
  }

  async #requiredNamespaceIds(
    transaction: ConversationProductPostgresTransaction,
    productRow: ConversationProductDatabaseRow,
  ): Promise<readonly string[]> {
    const memoryId = requiredString(productRow, "memory_id");
    const namespaceRows = await executeTypedConversationProductQuery(
      transaction,
      conversationProductTypedDb
        .select({ namespace_id: memoryNamespaces.namespaceId })
        .from(memoryNamespaces)
        .where(eq(memoryNamespaces.memoryId, memoryId))
        .orderBy(memoryNamespaces.namespaceId),
    );
    const scopeRows = await executeTypedConversationProductQuery(
      transaction,
      conversationProductTypedDb
        .select({ origin: memoryScopes.origin })
        .from(memoryScopes)
        .where(eq(memoryScopes.memoryId, memoryId))
        .orderBy(memoryScopes.scopeId),
    );
    return resolveRequiredMemoryNamespaceIds({
      namespaceIds: namespaceRows.map((row) => requiredString(row, "namespace_id")),
      scopeOrigins: scopeRows.map((row) => requiredString(row, "origin") as "seed" | "scope"),
      originWritableNamespaceId: nullableString(
        productRow,
        "scope_origin_namespace_id",
      ),
    });
  }

  async #lockedLifecycle(
    transaction: ConversationProductPostgresTransaction,
    coordinates: Readonly<{ memoryId: string; contentRevision: number }>,
    includeLeaseValidity: boolean,
  ): Promise<ConversationProductDatabaseRow | null> {
    const rows = await transaction.query(
      `SELECT ${LIFECYCLE_COLUMNS}${includeLeaseValidity
        ? `,
              CASE
                WHEN lifecycle.lease_token IS NULL THEN TRUE
                ELSE lifecycle.lease_expires_at > CURRENT_TIMESTAMP
              END AS lease_is_live`
        : ""}
         FROM memory_crypto_revisions AS lifecycle
        WHERE lifecycle.memory_id = $1
          AND lifecycle.content_revision = $2
        LIMIT 2
        FOR UPDATE OF lifecycle`,
      [coordinates.memoryId, coordinates.contentRevision],
    );
    return oneOrNone(rows, "Memory locked lifecycle");
  }

  async #persistStaleMapping(
    transaction: ConversationProductPostgresTransaction,
    lifecycle: MemoryRevisionLifecycle,
  ): Promise<void> {
    const rows = await executeTypedConversationProductQuery(
      transaction,
      conversationProductTypedDb
        .update(memoryCryptoRevisions)
        .set({
          disposition: "stale_mapping",
          failureCode: "mapping_conflict",
          nextAttemptAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(and(
          eq(memoryCryptoRevisions.memoryId, lifecycle.memoryId),
          eq(
            memoryCryptoRevisions.contentRevision,
            lifecycle.contentRevision,
          ),
          eq(memoryCryptoRevisions.disposition, "active"),
        ))
        .returning({ sequence: memoryCryptoRevisions.sequence }),
    );
    if (oneOrNone(rows, "Memory stale mapping receipt") === null) {
      throw new Error("Memory stale mapping lost its lifecycle CAS");
    }
  }
}
import {
  and,
  eq,
  inArray,
  isNull,
  memories,
  memoryCryptoRevisions,
  memoryNamespaces,
  memoryScopes,
  sql,
} from "@nautilo/db";
