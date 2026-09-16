import { createHash } from "node:crypto";
import {
  AGENT_SCOPE_CLOSE_MAX_ITEMS,
  agentScopeCloseItems,
  agentScopeCloseOperations,
  agentScopes,
  and,
  createOfflineDirectDb,
  eq,
  exists,
  memories,
  memoryCryptoOperations,
  memoryScopes,
  sql,
} from "@nautilo/db";

export type ScopeCloseScalar = string | number | boolean | Date | Uint8Array | null;
export type ScopeCloseRow = Readonly<Record<string, unknown>>;

export interface ScopeClosePostgresExecutor {
  query<Row extends ScopeCloseRow = ScopeCloseRow>(
    statement: string,
    parameters?: readonly ScopeCloseScalar[],
  ): Promise<readonly Row[]>;
}

export interface ScopeClosePostgresConnection extends ScopeClosePostgresExecutor {
  transaction<Result>(
    callback: (executor: ScopeClosePostgresExecutor) => Promise<Result>,
  ): Promise<Result>;
}

const scopeCloseTypedDb = createOfflineDirectDb();

type CompiledScopeCloseQuery = Readonly<{
  toSQL(): Readonly<{ sql: string; params: unknown[] }>;
}>;

function executeTypedScopeCloseQuery<Row extends ScopeCloseRow = ScopeCloseRow>(
  executor: ScopeClosePostgresExecutor,
  query: CompiledScopeCloseQuery,
): Promise<readonly Row[]> {
  const compiled = query.toSQL();
  return executor.query<Row>(
    compiled.sql,
    compiled.params as readonly ScopeCloseScalar[],
  );
}

export type ProtectedScopeMutationAdmission = Readonly<{
  status: "open";
  scopeId: string;
  scopeRevision: number;
}> | Readonly<{ status: "closing" | "stale_revision" | "not_found" }>;

export type ProtectedScopeCloseItem = Readonly<{
  ordinal: number;
  memoryId: string;
  origin: "seed" | "scope";
  cryptoObjectId: string;
  expectedContentRevision: number;
  expectedAccessRevision: number;
  expectedRequiredNamespaceFingerprint: Uint8Array;
  sourceOriginNamespaceId: string | null;
  action: "detach_seed" | "promote_origin";
  targetNamespaceId: string | null;
}>;

export type ProtectedScopeCloseBeginResult =
  | Readonly<{
      status: "started" | "replayed";
      operationId: string;
      scopeId: string;
      sourceScopeRevision: number;
      capturedItemCount: number;
      inventoryDigest: Uint8Array;
    }>
  | Readonly<{
      status:
        | "not_found"
        | "closing_conflict"
        | "too_many_items"
        | "target_required"
        | "protected_mapping_unavailable";
    }>;

export type ProtectedScopeCloseClaim = Readonly<{
  status: "claimed";
  operationId: string;
  claimToken: string;
  claimOwner: string;
  claimExpiresAt: number;
  attemptCount: number;
  item: ProtectedScopeCloseItem;
}> | Readonly<{ status: "empty" | "not_found" }>;

export type ProtectedScopeCloseObservation = Readonly<{
  operationId: string;
  scopeId: string;
  state: "active" | "complete" | "quarantined";
  failureCode: string | null;
  capturedItemCount: number;
  items: readonly Readonly<{
    ordinal: number;
    memoryId: string;
    state: "pending" | "claimed" | "complete" | "stale" | "quarantined";
    attemptCount: number;
    failureCode: string | null;
  }>[];
}>;

const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function portable(label: string, value: string): string {
  if (!PORTABLE_ID.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function uuid(label: string, value: string): string {
  if (!UUID.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function counter(row: ScopeCloseRow, field: string): number {
  const raw = row[field];
  const value = typeof raw === "bigint" || typeof raw === "string"
    ? Number(raw)
    : raw;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a nonnegative counter`);
  }
  return value as number;
}

function text(row: ScopeCloseRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError(`${field} must be text`);
  return value;
}

function nullableText(row: ScopeCloseRow, field: string): string | null {
  return row[field] === null ? null : text(row, field);
}

function bytes(row: ScopeCloseRow, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array)) throw new TypeError(`${field} must be bytea`);
  return value;
}

function timestamp(row: ScopeCloseRow, field: string): number {
  const value = row[field];
  const normalized = value instanceof Date
    ? value.getTime()
    : typeof value === "string" ? new Date(value).getTime() : Number.NaN;
  if (!Number.isFinite(normalized)) throw new TypeError(`${field} must be a timestamp`);
  return normalized;
}

function iso(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError("Scope close time is invalid");
  }
  return new Date(milliseconds).toISOString();
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function canonicalInventory(items: readonly ProtectedScopeCloseItem[]): Uint8Array {
  const hash = createHash("sha256");
  hash.update("nautilo/agent-scope-close-inventory/v1\0", "utf8");
  for (const item of items) {
    const fields = [
      String(item.ordinal), item.memoryId, item.origin, item.cryptoObjectId,
      String(item.expectedContentRevision), String(item.expectedAccessRevision),
      item.sourceOriginNamespaceId ?? "", item.action,
      item.targetNamespaceId ?? "",
    ];
    for (const field of fields) {
      const encoded = Buffer.from(field, "utf8");
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(encoded.length);
      hash.update(length);
      hash.update(encoded);
    }
    hash.update(item.expectedRequiredNamespaceFingerprint);
  }
  return new Uint8Array(hash.digest());
}

function inventoryItem(
  row: ScopeCloseRow,
  ordinal: number,
  targetNamespaceId: string | null,
): ProtectedScopeCloseItem | null {
  const origin = text(row, "origin");
  if (origin !== "seed" && origin !== "scope") {
    throw new Error("Scope close origin is invalid");
  }
  const cryptoObjectId = nullableText(row, "crypto_object_id");
  const fingerprint = row["crypto_required_namespace_fingerprint"];
  const contentRevision = counter(row, "content_revision");
  const accessRevisionRaw = row["crypto_access_revision"];
  if (cryptoObjectId === null
    || !(fingerprint instanceof Uint8Array)
    || fingerprint.length !== 32
    || contentRevision < 1
    || accessRevisionRaw === null) return null;
  const expectedAccessRevision = counter(row, "crypto_access_revision");
  const sourceOriginNamespaceId = nullableText(row, "scope_origin_namespace_id");
  if (origin === "scope" && (sourceOriginNamespaceId === null
    || targetNamespaceId === null)) return null;
  return Object.freeze({
    ordinal,
    memoryId: text(row, "memory_id"),
    origin,
    cryptoObjectId,
    expectedContentRevision: contentRevision,
    expectedAccessRevision,
    expectedRequiredNamespaceFingerprint: fingerprint.slice(),
    sourceOriginNamespaceId: origin === "scope" ? sourceOriginNamespaceId : null,
    action: origin === "scope" ? "promote_origin" : "detach_seed",
    targetNamespaceId: origin === "scope" ? targetNamespaceId : null,
  });
}

async function exactOperation(
  tx: ScopeClosePostgresExecutor,
  operationId: string,
  lock = false,
): Promise<ScopeCloseRow | null> {
  const rows = await tx.query(
    `/* protected-scope-close:operation */
     SELECT operation_id, scope_id::text, parent_agent_id::text,
            speaker_user_id::text, source_scope_revision,
            captured_item_count, inventory_digest, state, failure_code
       FROM agent_scope_close_operations
      WHERE operation_id = $1 LIMIT 2${lock ? " FOR UPDATE" : ""}`,
    [operationId],
  );
  if (rows.length > 1) throw new Error("Scope close operation identity conflicts");
  return rows[0] ?? null;
}

export class PostgresProtectedScopeCloseSaga {
  constructor(private readonly connection: ScopeClosePostgresConnection) {}

  assertOpenForProtectedMutation(input: Readonly<{
    scopeId: string;
    parentAgentId: string;
    speakerUserId: string;
    expectedRevision?: number;
  }>): Promise<ProtectedScopeMutationAdmission> {
    uuid("scopeId", input.scopeId);
    uuid("parentAgentId", input.parentAgentId);
    uuid("speakerUserId", input.speakerUserId);
    if (input.expectedRevision !== undefined
      && (!Number.isSafeInteger(input.expectedRevision)
        || input.expectedRevision < 0)) {
      throw new TypeError("scope revision is invalid");
    }
    return this.connection.transaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      const rows = await tx.query(
        `/* protected-scope-close:mutation-admission */
         SELECT id::text, lifecycle_state, revision
           FROM agent_scopes
          WHERE id = $1 AND parent_agent_id = $2 AND speaker_user_id = $3
          LIMIT 2 FOR UPDATE`,
        [input.scopeId, input.parentAgentId, input.speakerUserId],
      );
      if (rows.length !== 1) return { status: "not_found" };
      const row = rows[0]!;
      const revision = counter(row, "revision");
      if (text(row, "lifecycle_state") !== "open") return { status: "closing" };
      if (input.expectedRevision !== undefined
        && revision !== input.expectedRevision) return { status: "stale_revision" };
      return Object.freeze({ status: "open" as const,
        scopeId: input.scopeId, scopeRevision: revision });
    });
  }

  begin(input: Readonly<{
    operationId: string;
    scopeId: string;
    parentAgentId: string;
    speakerUserId: string;
    expectedScopeRevision: number;
    targetNamespaceId?: string | null;
  }>): Promise<ProtectedScopeCloseBeginResult> {
    portable("operationId", input.operationId);
    uuid("scopeId", input.scopeId);
    uuid("parentAgentId", input.parentAgentId);
    uuid("speakerUserId", input.speakerUserId);
    if (!Number.isSafeInteger(input.expectedScopeRevision)
      || input.expectedScopeRevision < 0) throw new TypeError("scope revision is invalid");
    const targetNamespaceId = input.targetNamespaceId == null
      ? null : uuid("targetNamespaceId", input.targetNamespaceId);
    return this.connection.transaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `protected-scope-close/${input.scopeId}`,
      ]);
      const scopes = await tx.query(
        `/* protected-scope-close:scope */
         SELECT id::text, parent_agent_id::text, speaker_user_id::text,
                lifecycle_state, revision, close_operation_id
           FROM agent_scopes
          WHERE id = $1 AND parent_agent_id = $2 AND speaker_user_id = $3
          LIMIT 2 FOR UPDATE`,
        [input.scopeId, input.parentAgentId, input.speakerUserId],
      );
      if (scopes.length !== 1) return { status: "not_found" };
      const scope = scopes[0]!;
      if (text(scope, "lifecycle_state") === "closing") {
        if (nullableText(scope, "close_operation_id") !== input.operationId) {
          return { status: "closing_conflict" };
        }
        const existing = await exactOperation(tx, input.operationId);
        if (existing === null
          || text(existing, "scope_id") !== input.scopeId
          || text(existing, "parent_agent_id") !== input.parentAgentId
          || text(existing, "speaker_user_id") !== input.speakerUserId
          || counter(existing, "source_scope_revision") !== input.expectedScopeRevision
          || text(existing, "state") !== "active") {
          return { status: "closing_conflict" };
        }
        const durableRows = await executeTypedScopeCloseQuery(
          tx,
          scopeCloseTypedDb.select({
            ordinal: agentScopeCloseItems.ordinal,
            memory_id: sql<string>`${agentScopeCloseItems.memoryId}::text`,
            origin: agentScopeCloseItems.origin,
            crypto_object_id: agentScopeCloseItems.cryptoObjectId,
            expected_content_revision:
              agentScopeCloseItems.expectedContentRevision,
            expected_access_revision:
              agentScopeCloseItems.expectedAccessRevision,
            expected_required_namespace_fingerprint:
              agentScopeCloseItems.expectedRequiredNamespaceFingerprint,
            source_origin_namespace_id:
              sql<string | null>`${agentScopeCloseItems.sourceOriginNamespaceId}::text`,
            action: agentScopeCloseItems.action,
            target_namespace_id:
              sql<string | null>`${agentScopeCloseItems.targetNamespaceId}::text`,
          }).from(agentScopeCloseItems).where(
            eq(agentScopeCloseItems.operationId, input.operationId),
          ).orderBy(agentScopeCloseItems.ordinal)
            .limit(AGENT_SCOPE_CLOSE_MAX_ITEMS + 1),
        );
        const durableItems = durableRows.map((row, ordinal) => inventoryItem({
          ...row,
          content_revision: row["expected_content_revision"],
          crypto_access_revision: row["expected_access_revision"],
          crypto_required_namespace_fingerprint:
            row["expected_required_namespace_fingerprint"],
          scope_origin_namespace_id: row["source_origin_namespace_id"],
        }, ordinal, nullableText(row, "target_namespace_id")));
        if (durableRows.length !== counter(existing, "captured_item_count")
          || durableRows.length > AGENT_SCOPE_CLOSE_MAX_ITEMS
          || durableItems.some((item) => item === null)
          || durableRows.some((row, index) =>
            counter(row, "ordinal") !== index
            || text(row, "action") !== durableItems[index]!.action
            || nullableText(row, "target_namespace_id")
              !== durableItems[index]!.targetNamespaceId
            || (durableItems[index]!.origin === "scope"
              && durableItems[index]!.targetNamespaceId !== targetNamespaceId)
          )
          || !equalBytes(
            canonicalInventory(durableItems as ProtectedScopeCloseItem[]),
            bytes(existing, "inventory_digest"),
          )) return { status: "closing_conflict" };
        return Object.freeze({
          status: "replayed" as const,
          operationId: input.operationId,
          scopeId: input.scopeId,
          sourceScopeRevision: input.expectedScopeRevision,
          capturedItemCount: counter(existing, "captured_item_count"),
          inventoryDigest: bytes(existing, "inventory_digest").slice(),
        });
      }
      if (text(scope, "lifecycle_state") !== "open"
        || counter(scope, "revision") !== input.expectedScopeRevision) {
        return { status: "closing_conflict" };
      }
      // Operation IDs are globally idempotent. Resolve collisions before any
      // inventory capture or durable mutation rather than leaking a unique-key
      // failure from the insert.
      if (await exactOperation(tx, input.operationId) !== null) {
        return { status: "closing_conflict" };
      }
      const rows = await executeTypedScopeCloseQuery(
        tx,
        scopeCloseTypedDb.select({
          memory_id: sql<string>`${memoryScopes.memoryId}::text`,
          origin: memoryScopes.origin,
          crypto_object_id: memories.cryptoObjectId,
          content_revision: memories.contentRevision,
          crypto_access_revision: memories.cryptoAccessRevision,
          crypto_required_namespace_fingerprint:
            memories.cryptoRequiredNamespaceFingerprint,
          scope_origin_namespace_id:
            sql<string | null>`${memories.scopeOriginNamespaceId}::text`,
          pending_crypto_operation: exists(
            scopeCloseTypedDb.select({ value: sql`1` })
              .from(memoryCryptoOperations)
              .where(and(
                eq(memoryCryptoOperations.memoryId, memories.id),
                eq(memoryCryptoOperations.completion, "pending"),
                eq(memoryCryptoOperations.disposition, "active"),
              )),
          ),
        }).from(memoryScopes).innerJoin(
          memories,
          eq(memories.id, memoryScopes.memoryId),
        ).where(eq(memoryScopes.scopeId, input.scopeId)).orderBy(
          sql`convert_to(${memoryScopes.memoryId}::text, 'UTF8')`,
        ).limit(AGENT_SCOPE_CLOSE_MAX_ITEMS + 1).for("update", {
          of: [memoryScopes, memories],
        }),
      );
      if (rows.length > AGENT_SCOPE_CLOSE_MAX_ITEMS) {
        return { status: "too_many_items" };
      }
      if (rows.some((row) => row["pending_crypto_operation"] === true)) {
        return { status: "protected_mapping_unavailable" };
      }
      if (targetNamespaceId === null
        && rows.some((row) => text(row, "origin") === "scope")) {
        return { status: "target_required" };
      }
      const items: ProtectedScopeCloseItem[] = [];
      for (const [ordinal, row] of rows.entries()) {
        const item = inventoryItem(row, ordinal, targetNamespaceId);
        if (item === null) return { status: "protected_mapping_unavailable" };
        items.push(item);
      }
      const inventoryDigest = canonicalInventory(items);
      await executeTypedScopeCloseQuery(
        tx,
        scopeCloseTypedDb.insert(agentScopeCloseOperations).values({
          operationId: input.operationId,
          scopeId: input.scopeId,
          parentAgentId: input.parentAgentId,
          speakerUserId: input.speakerUserId,
          sourceScopeRevision: input.expectedScopeRevision,
          capturedItemCount: items.length,
          inventoryDigest,
          state: "active",
        }),
      );
      for (const item of items) {
        await executeTypedScopeCloseQuery(
          tx,
          scopeCloseTypedDb.insert(agentScopeCloseItems).values({
            operationId: input.operationId,
            ordinal: item.ordinal,
            memoryId: item.memoryId,
            origin: item.origin,
            cryptoObjectId: item.cryptoObjectId,
            expectedContentRevision: item.expectedContentRevision,
            expectedAccessRevision: item.expectedAccessRevision,
            expectedRequiredNamespaceFingerprint:
              item.expectedRequiredNamespaceFingerprint,
            sourceOriginNamespaceId: item.sourceOriginNamespaceId,
            action: item.action,
            targetNamespaceId: item.targetNamespaceId,
            state: "pending",
            attemptCount: 0,
          }),
        );
      }
      const changed = await executeTypedScopeCloseQuery(
        tx,
        scopeCloseTypedDb.update(agentScopes).set({
          lifecycleState: "closing",
          revision: sql`${agentScopes.revision} + 1`,
          closeOperationId: input.operationId,
        }).where(and(
          eq(agentScopes.id, input.scopeId),
          eq(agentScopes.parentAgentId, input.parentAgentId),
          eq(agentScopes.speakerUserId, input.speakerUserId),
          eq(agentScopes.lifecycleState, "open"),
          eq(agentScopes.revision, input.expectedScopeRevision),
        )).returning({ id: agentScopes.id }),
      );
      if (changed.length !== 1) {
        throw new Error("Scope close lost its lifecycle compare-and-swap");
      }
      return Object.freeze({ status: "started" as const,
        operationId: input.operationId, scopeId: input.scopeId,
        sourceScopeRevision: input.expectedScopeRevision,
        capturedItemCount: items.length, inventoryDigest: inventoryDigest.slice() });
    });
  }

  claim(input: Readonly<{
    operationId: string;
    parentAgentId: string;
    speakerUserId: string;
    claimToken: string;
    claimOwner: string;
    now: number;
    leaseMs: number;
  }>): Promise<ProtectedScopeCloseClaim> {
    portable("operationId", input.operationId);
    uuid("parentAgentId", input.parentAgentId);
    uuid("speakerUserId", input.speakerUserId);
    uuid("claimToken", input.claimToken);
    portable("claimOwner", input.claimOwner);
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1
      || input.leaseMs > 5 * 60_000) throw new RangeError("claim lease is invalid");
    const now = iso(input.now);
    const expires = iso(input.now + input.leaseMs);
    return this.connection.transaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      const operations = await tx.query(
        `SELECT operation_id FROM agent_scope_close_operations
          WHERE operation_id = $1 AND parent_agent_id = $2
            AND speaker_user_id = $3 AND state = 'active'
          LIMIT 2 FOR UPDATE`,
        [input.operationId, input.parentAgentId, input.speakerUserId],
      );
      if (operations.length !== 1) return { status: "not_found" };
      const rows = await tx.query(
        `/* protected-scope-close:claim-candidate */
         SELECT ordinal, memory_id::text, origin, crypto_object_id,
                expected_content_revision, expected_access_revision,
                expected_required_namespace_fingerprint,
                source_origin_namespace_id::text, action,
                target_namespace_id::text, attempt_count
           FROM agent_scope_close_items
          WHERE operation_id = $1
            AND (
              (state = 'pending' AND next_attempt_at <= $2::timestamptz)
              OR (state = 'claimed' AND claim_expires_at <= $2::timestamptz)
            )
            AND attempt_count < 8
          ORDER BY ordinal LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [input.operationId, now],
      );
      if (rows.length === 0) {
        const exhausted = await tx.query(
          `/* protected-scope-close:exhausted-item */
           SELECT ordinal FROM agent_scope_close_items
            WHERE operation_id = $1
              AND attempt_count >= 8
              AND (state = 'pending'
                OR (state = 'claimed' AND claim_expires_at <= $2::timestamptz))
            ORDER BY ordinal LIMIT 1 FOR UPDATE`,
          [input.operationId, now],
        );
        if (exhausted.length === 1) {
          await executeTypedScopeCloseQuery(
            tx,
            scopeCloseTypedDb.update(agentScopeCloseItems).set({
              state: "quarantined",
              claimToken: null,
              claimOwner: null,
              claimExpiresAt: null,
              failureCode: "retry_exhausted",
              terminalAt: new Date(now),
              updatedAt: new Date(now),
            }).where(and(
              eq(agentScopeCloseItems.operationId, input.operationId),
              eq(
                agentScopeCloseItems.ordinal,
                counter(exhausted[0]!, "ordinal"),
              ),
            )),
          );
          await this.quarantine(tx, input.operationId, "item_quarantined", now);
        }
        return { status: "empty" };
      }
      const row = rows[0]!;
      const ordinal = counter(row, "ordinal");
      const item = inventoryItem({
        ...row,
        content_revision: row["expected_content_revision"],
        crypto_access_revision: row["expected_access_revision"],
        crypto_required_namespace_fingerprint:
          row["expected_required_namespace_fingerprint"],
        scope_origin_namespace_id: row["source_origin_namespace_id"],
      }, ordinal, nullableText(row, "target_namespace_id"));
      if (item === null || item.action !== text(row, "action")) {
        throw new Error("Scope close captured item is corrupt");
      }
      const changed = await executeTypedScopeCloseQuery(
        tx,
        scopeCloseTypedDb.update(agentScopeCloseItems).set({
          state: "claimed",
          attemptCount: sql`${agentScopeCloseItems.attemptCount} + 1`,
          claimToken: input.claimToken,
          claimOwner: input.claimOwner,
          claimExpiresAt: new Date(expires),
          updatedAt: new Date(now),
        }).where(and(
          eq(agentScopeCloseItems.operationId, input.operationId),
          eq(agentScopeCloseItems.ordinal, ordinal),
        )).returning({ attempt_count: agentScopeCloseItems.attemptCount }),
      );
      if (changed.length !== 1) throw new Error("Scope close claim lost its lock");
      return Object.freeze({ status: "claimed" as const,
        operationId: input.operationId, claimToken: input.claimToken,
        claimOwner: input.claimOwner, claimExpiresAt: input.now + input.leaseMs,
        attemptCount: counter(changed[0]!, "attempt_count"), item });
    });
  }

  completeClaim(input: Readonly<{
    operationId: string;
    parentAgentId: string;
    speakerUserId: string;
    ordinal: number;
    claimToken: string;
    claimOwner: string;
    now: number;
    result:
      | Readonly<{ status: "complete"; productReceiptRef: string; cryptoReceiptRef: string }>
      | Readonly<{ status: "retry"; nextAttemptAt: number }>
      | Readonly<{ status: "stale" | "quarantined"; failureCode: string }>;
  }>): Promise<"applied" | "duplicate" | "stale_claim"> {
    portable("operationId", input.operationId);
    uuid("parentAgentId", input.parentAgentId);
    uuid("speakerUserId", input.speakerUserId);
    uuid("claimToken", input.claimToken);
    portable("claimOwner", input.claimOwner);
    const now = iso(input.now);
    return this.connection.transaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      const rows = await tx.query(
        `/* protected-scope-close:claimed-item */
         SELECT item.state, item.claim_token::text, item.claim_owner,
                item.claim_expires_at, item.product_receipt_ref,
                item.crypto_receipt_ref, operation.state AS operation_state
           FROM agent_scope_close_items item
           JOIN agent_scope_close_operations operation
             ON operation.operation_id = item.operation_id
          WHERE item.operation_id = $1 AND item.ordinal = $2
            AND operation.parent_agent_id = $3
            AND operation.speaker_user_id = $4
          LIMIT 2 FOR UPDATE OF item, operation`,
        [input.operationId, input.ordinal, input.parentAgentId,
          input.speakerUserId],
      );
      if (rows.length !== 1) return "stale_claim";
      const row = rows[0]!;
      if (text(row, "state") === "complete" && input.result.status === "complete"
        && nullableText(row, "product_receipt_ref") === input.result.productReceiptRef
        && nullableText(row, "crypto_receipt_ref") === input.result.cryptoReceiptRef) {
        return "duplicate";
      }
      if (text(row, "state") !== "claimed"
        || text(row, "operation_state") !== "active"
        || nullableText(row, "claim_token") !== input.claimToken
        || nullableText(row, "claim_owner") !== input.claimOwner
        || timestamp(row, "claim_expires_at") <= input.now) {
        return "stale_claim";
      }
      if (input.result.status === "complete") {
        portable("productReceiptRef", input.result.productReceiptRef);
        portable("cryptoReceiptRef", input.result.cryptoReceiptRef);
        await executeTypedScopeCloseQuery(
          tx,
          scopeCloseTypedDb.update(agentScopeCloseItems).set({
            state: "complete",
            claimToken: null,
            claimOwner: null,
            claimExpiresAt: null,
            productReceiptRef: input.result.productReceiptRef,
            cryptoReceiptRef: input.result.cryptoReceiptRef,
            terminalAt: new Date(now),
            updatedAt: new Date(now),
          }).where(and(
            eq(agentScopeCloseItems.operationId, input.operationId),
            eq(agentScopeCloseItems.ordinal, input.ordinal),
          )),
        );
      } else if (input.result.status === "retry") {
        await executeTypedScopeCloseQuery(
          tx,
          scopeCloseTypedDb.update(agentScopeCloseItems).set({
            state: "pending",
            claimToken: null,
            claimOwner: null,
            claimExpiresAt: null,
            nextAttemptAt: new Date(iso(input.result.nextAttemptAt)),
            updatedAt: new Date(now),
          }).where(and(
            eq(agentScopeCloseItems.operationId, input.operationId),
            eq(agentScopeCloseItems.ordinal, input.ordinal),
          )),
        );
      } else {
        portable("failureCode", input.result.failureCode);
        await executeTypedScopeCloseQuery(
          tx,
          scopeCloseTypedDb.update(agentScopeCloseItems).set({
            state: input.result.status,
            claimToken: null,
            claimOwner: null,
            claimExpiresAt: null,
            failureCode: input.result.failureCode as
              | "scope_state_conflict"
              | "memory_state_conflict"
              | "authorization_unavailable"
              | "target_encryption_not_ready"
              | "storage_transient",
            terminalAt: new Date(now),
            updatedAt: new Date(now),
          }).where(and(
            eq(agentScopeCloseItems.operationId, input.operationId),
            eq(agentScopeCloseItems.ordinal, input.ordinal),
          )),
        );
      }
      return "applied";
    });
  }

  async observe(input: Readonly<{
    operationId: string;
    parentAgentId: string;
    speakerUserId: string;
  }>): Promise<ProtectedScopeCloseObservation | null> {
    portable("operationId", input.operationId);
    uuid("parentAgentId", input.parentAgentId);
    uuid("speakerUserId", input.speakerUserId);
    return this.connection.transaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const operation = await exactOperation(tx, input.operationId);
      if (operation === null
        || text(operation, "parent_agent_id") !== input.parentAgentId
        || text(operation, "speaker_user_id") !== input.speakerUserId) return null;
      const rows = await executeTypedScopeCloseQuery(
        tx,
        scopeCloseTypedDb.select({
          ordinal: agentScopeCloseItems.ordinal,
          memory_id: sql<string>`${agentScopeCloseItems.memoryId}::text`,
          state: agentScopeCloseItems.state,
          attempt_count: agentScopeCloseItems.attemptCount,
          failure_code: agentScopeCloseItems.failureCode,
        }).from(agentScopeCloseItems).where(
          eq(agentScopeCloseItems.operationId, input.operationId),
        ).orderBy(agentScopeCloseItems.ordinal)
          .limit(AGENT_SCOPE_CLOSE_MAX_ITEMS + 1),
      );
      if (rows.length > AGENT_SCOPE_CLOSE_MAX_ITEMS) {
        throw new Error("Scope close item inventory is oversized");
      }
      return Object.freeze({
        operationId: input.operationId,
        scopeId: text(operation, "scope_id"),
        state: text(operation, "state") as ProtectedScopeCloseObservation["state"],
        failureCode: nullableText(operation, "failure_code"),
        capturedItemCount: counter(operation, "captured_item_count"),
        items: Object.freeze(rows.map((row) => Object.freeze({
          ordinal: counter(row, "ordinal"), memoryId: text(row, "memory_id"),
          state: text(row, "state") as ProtectedScopeCloseObservation["items"][number]["state"],
          attemptCount: counter(row, "attempt_count"),
          failureCode: nullableText(row, "failure_code"),
        }))),
      });
    });
  }

  finalize(input: Readonly<{
    operationId: string;
    parentAgentId: string;
    speakerUserId: string;
    now: number;
  }>): Promise<"complete" | "already_complete" | "pending" | "quarantined" | "not_found"> {
    portable("operationId", input.operationId);
    uuid("parentAgentId", input.parentAgentId);
    uuid("speakerUserId", input.speakerUserId);
    const now = iso(input.now);
    return this.connection.transaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      const operation = await exactOperation(tx, input.operationId, true);
      if (operation === null
        || text(operation, "parent_agent_id") !== input.parentAgentId
        || text(operation, "speaker_user_id") !== input.speakerUserId) {
        return "not_found";
      }
      const operationState = text(operation, "state");
      if (operationState === "complete") return "already_complete";
      if (operationState === "quarantined") return "quarantined";
      const scopeId = text(operation, "scope_id");
      const scopes = await tx.query(
        `SELECT id::text, lifecycle_state, revision, close_operation_id
           FROM agent_scopes
          WHERE id = $1 AND parent_agent_id = $2 AND speaker_user_id = $3
          LIMIT 2 FOR UPDATE`,
        [scopeId, input.parentAgentId, input.speakerUserId],
      );
      if (scopes.length !== 1) return "not_found";
      const scope = scopes[0]!;
      if (text(scope, "lifecycle_state") !== "closing"
        || nullableText(scope, "close_operation_id") !== input.operationId
        || counter(scope, "revision")
          !== counter(operation, "source_scope_revision") + 1) {
        await this.quarantine(tx, input.operationId, "scope_state_conflict", now);
        return "quarantined";
      }
      const items = await tx.query(
        `SELECT ordinal, memory_id::text, origin, crypto_object_id,
                expected_content_revision, expected_access_revision,
                expected_required_namespace_fingerprint,
                source_origin_namespace_id::text, action,
                target_namespace_id::text, state
           FROM agent_scope_close_items
          WHERE operation_id = $1 ORDER BY ordinal
          LIMIT ${AGENT_SCOPE_CLOSE_MAX_ITEMS + 1} FOR UPDATE`,
        [input.operationId],
      );
      if (items.length !== counter(operation, "captured_item_count")
        || items.length > AGENT_SCOPE_CLOSE_MAX_ITEMS) {
        await this.quarantine(tx, input.operationId, "inventory_conflict", now);
        return "quarantined";
      }
      if (items.some((row) => ["stale", "quarantined"].includes(
        text(row, "state"),
      ))) {
        await this.quarantine(tx, input.operationId, "item_quarantined", now);
        return "quarantined";
      }
      if (items.some((row) => text(row, "state") !== "complete")) {
        return "pending";
      }
      const canonical = items.map((row, ordinal) => inventoryItem({
        ...row,
        content_revision: row["expected_content_revision"],
        crypto_access_revision: row["expected_access_revision"],
        crypto_required_namespace_fingerprint:
          row["expected_required_namespace_fingerprint"],
        scope_origin_namespace_id: row["source_origin_namespace_id"],
      }, ordinal, nullableText(row, "target_namespace_id")));
      if (canonical.some((item) => item === null)
        || items.some((row, ordinal) => counter(row, "ordinal") !== ordinal)
        || !equalBytes(canonicalInventory(canonical as ProtectedScopeCloseItem[]),
          bytes(operation, "inventory_digest"))) {
        await this.quarantine(tx, input.operationId, "inventory_conflict", now);
        return "quarantined";
      }
      // A terminal item receipt is not itself product state. Require every
      // captured seed/origin edge to have disappeared as well, so a forged,
      // stale, or response-loss-misclassified receipt cannot make deleting
      // the scope silently perform the product transition by FK cascade.
      const remaining = await tx.query(
        `/* protected-scope-close:remaining-edge */
         SELECT ms.memory_id
           FROM memory_scopes ms
          WHERE ms.scope_id = $1
          LIMIT 1 FOR UPDATE OF ms`,
        [scopeId],
      );
      if (remaining.length > 0) {
        await this.quarantine(tx, input.operationId, "inventory_conflict", now);
        return "quarantined";
      }
      const deleted = await executeTypedScopeCloseQuery(
        tx,
        scopeCloseTypedDb.delete(agentScopes).where(and(
          eq(agentScopes.id, scopeId),
          eq(agentScopes.parentAgentId, input.parentAgentId),
          eq(agentScopes.speakerUserId, input.speakerUserId),
          eq(agentScopes.lifecycleState, "closing"),
          eq(agentScopes.closeOperationId, input.operationId),
          eq(
            agentScopes.revision,
            counter(operation, "source_scope_revision") + 1,
          ),
        )).returning({ id: agentScopes.id }),
      );
      if (deleted.length !== 1) throw new Error("Scope close final CAS was lost");
      await executeTypedScopeCloseQuery(
        tx,
        scopeCloseTypedDb.update(agentScopeCloseOperations).set({
          state: "complete",
          updatedAt: new Date(now),
          terminalAt: new Date(now),
        }).where(and(
          eq(agentScopeCloseOperations.operationId, input.operationId),
          eq(agentScopeCloseOperations.state, "active"),
        )),
      );
      return "complete";
    });
  }

  private async quarantine(
    tx: ScopeClosePostgresExecutor,
    operationId: string,
    failureCode: string,
    now: string,
  ): Promise<void> {
    await executeTypedScopeCloseQuery(
      tx,
      scopeCloseTypedDb.update(agentScopeCloseOperations).set({
        state: "quarantined",
        failureCode: failureCode as
          | "scope_state_conflict"
          | "inventory_conflict"
          | "uncaptured_item"
          | "item_quarantined",
        updatedAt: new Date(now),
        terminalAt: new Date(now),
      }).where(and(
        eq(agentScopeCloseOperations.operationId, operationId),
        eq(agentScopeCloseOperations.state, "active"),
      )),
    );
  }
}
