import {
  and,
  eq,
  memoryCryptoOperations,
  memoryNamespaces,
  memoryScopes,
  sql,
} from "@nautilo/db";
import type {
  ProtectedMemoryAuthority,
  ProtectedMemoryResult,
} from "../../memory/active-memory-repository.ts";
import {
  agentMemoryExactAccessRequestDigest,
  foregroundAgentMemoryNativeExactAccessDigest,
  type AgentMemoryExactAccessBindingFact,
  type AgentMemoryExactAccessCryptoCompletionPort,
  type AgentMemoryExactAccessCryptoObservation,
  type AgentMemoryExactAccessCryptoReceipt,
  type AgentMemoryExactAccessPlan,
  type ForegroundAgentMemoryNativeExactAccessPlan,
  type ForegroundAgentMemoryNativeExactAccessPublication,
  type PreparedAgentMemoryExactAccess,
} from "../../memory/agent-memory-exact-access.ts";
import { fingerprintRequiredMemoryNamespaces } from "../../memory/memory-repository.ts";
import {
  assertVerifiedConversationProductPostgresHandle,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresHandle,
  type ConversationProductPostgresTransaction,
} from "../message/postgres-conversation-product-store.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const OBJECT_ID = /^memory:v1:[0-9a-f]{64}$/;

type ProductSnapshot = Readonly<{
  contentRevision: number;
  accessRevision: number;
  objectId: string;
  fingerprint: Uint8Array;
  namespaceIds: readonly string[];
  scopeOriginCount: number;
  scopeOriginNamespaceId: string | null;
}>;

export type AgentMemoryExactAccessAuthorityFacts = Readonly<{
  currentBindings: readonly AgentMemoryExactAccessBindingFact[];
  targetBindings: readonly AgentMemoryExactAccessBindingFact[];
}>;

export type AgentMemoryExactAccessProductPlanResult = ProtectedMemoryResult<
  | Readonly<{ status: "unchanged"; memoryId: string }>
  | Readonly<{
      status: "prepared";
      sourceNamespaceId: string;
      plan: AgentMemoryExactAccessPlan;
    }>
>;

export type ForegroundAgentMemoryNativeExactAccessProductPlanResult =
  ProtectedMemoryResult<
    | Readonly<{ status: "unchanged"; memoryId: string;
        sourceNamespaceId: string;
        plan: ForegroundAgentMemoryNativeExactAccessPlan }>
    | Readonly<{ status: "prepared"; sourceNamespaceId: string;
        plan: ForegroundAgentMemoryNativeExactAccessPlan }>
  >;

export type AgentMemoryExactAccessReconcileResult =
  | Readonly<{ status: "pending"; phase: "crypto" }>
  | Readonly<{
      status: "completed";
      operationId: string;
      memoryId: string;
      cryptoAccessRevision: number;
      requiredNamespaceIds: readonly string[];
    }>
  | Readonly<{ status: "stale" | "denied" | "quarantined" }>;

export type ResolveAgentMemoryGrantUserNamespace = (input: Readonly<{
  authority: Extract<ProtectedMemoryAuthority, { mode: "namespace" }>;
  userHandle: string;
}>) => Promise<string | null>;

export type ResolveAgentMemoryExactAccessAuthority = (input: Readonly<{
  authority: Extract<ProtectedMemoryAuthority, { mode: "namespace" }>;
  currentNamespaceIds: readonly string[];
  targetNamespaceIds: readonly string[];
}>) => Promise<AgentMemoryExactAccessAuthorityFacts | null>;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function unavailable<Value>(
  reason: "authorization_required" | "stale_revision"
    | "target_encryption_not_ready" | "integrity_failure",
): ProtectedMemoryResult<Value> {
  return Object.freeze({ status: "unavailable", reason });
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
  const value = row[field];
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${field} must be text`);
  return value;
}

function rowCounter(row: ConversationProductDatabaseRow, field: string): number {
  const raw = row[field];
  const value = typeof raw === "bigint" ? Number(raw)
    : typeof raw === "string" ? Number(raw) : raw;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a safe counter`);
  }
  return value as number;
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

function canonicalIds(value: unknown, allowEmpty = false): readonly string[] {
  const parsed: unknown = typeof value === "string"
    ? JSON.parse(value) as unknown
    : value;
  if (
    !Array.isArray(parsed)
    || (!allowEmpty && parsed.length < 1)
    || parsed.length > 256
  ) {
    throw new TypeError("Agent Memory exact Namespace inventory is invalid");
  }
  const result = parsed.map((entry) => {
    if (typeof entry !== "string" || !UUID.test(entry)) {
      throw new TypeError("Agent Memory exact Namespace inventory is invalid");
    }
    return entry;
  }).sort();
  if (result.some((entry, index) =>
    index > 0 && result[index - 1] === entry
  )) throw new TypeError("Agent Memory exact Namespace inventory is duplicated");
  return Object.freeze(result);
}

function exactBindings(
  label: string,
  bindings: readonly AgentMemoryExactAccessBindingFact[],
  expectedIds: readonly string[],
): readonly AgentMemoryExactAccessBindingFact[] {
  if (bindings.length !== expectedIds.length) {
    throw new TypeError(`${label} binding inventory is not exact`);
  }
  return Object.freeze(bindings.map((binding, index) => {
    if (
      binding.namespaceId !== expectedIds[index]
      || !PORTABLE_ID.test(binding.domainId)
      || !Number.isSafeInteger(binding.expectedAccessRevision)
      || binding.expectedAccessRevision < 0
      || !Number.isSafeInteger(binding.expectedPolicyRevision)
      || binding.expectedPolicyRevision < 0
      || binding.bindingHash.length !== 32
    ) throw new TypeError(`${label} binding authority is invalid`);
    return Object.freeze({
      ...binding,
      bindingHash: binding.bindingHash.slice(),
    });
  }));
}

function authorityReadable(
  authority: ProtectedMemoryAuthority,
  boundReadableNamespaceIds: readonly string[],
): authority is Extract<ProtectedMemoryAuthority, { mode: "namespace" }> {
  if (authority.mode !== "namespace") return false;
  const readable = canonicalIds(authority.readableNamespaceIds);
  const mutable = canonicalIds(authority.mutableNamespaceIds);
  return readable.every((id) => boundReadableNamespaceIds.includes(id))
    && mutable.every((id) => readable.includes(id))
    && (authority.writableNamespaceId === null
      || mutable.includes(authority.writableNamespaceId));
}

async function assertIdentity(
  tx: ConversationProductPostgresTransaction,
  authority: Extract<ProtectedMemoryAuthority, { mode: "namespace" }>,
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
    || rows[0]?.["current_user_id"] !== authority.subjectUserId
    || rows[0]?.["current_agent_id"] !== authority.agentId
  ) throw new TypeError("Agent Memory exact-access identity is unavailable");
}

async function loadProduct(
  tx: ConversationProductPostgresTransaction,
  memoryId: string,
): Promise<ProductSnapshot> {
  const row = oneOrNull(await tx.query(
    `/* agent-memory:exact-access:lock-product */
     SELECT m.id::text AS memory_id, m.content_revision,
            m.crypto_access_revision, m.crypto_object_id,
            m.crypto_required_namespace_fingerprint,
            m.scope_origin_namespace_id::text AS scope_origin_namespace_id,
            COALESCE((SELECT json_agg(mn.namespace_id::text ORDER BY mn.namespace_id)
              FROM memory_namespaces mn WHERE mn.memory_id = m.id), '[]'::json)::text AS namespace_ids,
            (SELECT COUNT(*)::int FROM memory_scopes ms
              WHERE ms.memory_id = m.id AND ms.origin = 'scope') AS scope_origin_count
       FROM memories m WHERE m.id = $1::uuid LIMIT 2 FOR UPDATE`,
    [memoryId],
  ), "Agent Memory exact-access product");
  if (row === null) throw new Error("Agent Memory exact-access product is absent");
  const objectId = rowNullableString(row, "crypto_object_id");
  if (objectId === null || !OBJECT_ID.test(objectId)) {
    throw new TypeError("Agent Memory crypto object is invalid");
  }
  const ordinaryNamespaceIds = canonicalIds(row["namespace_ids"], true);
  const scopeOriginCount = rowCounter(row, "scope_origin_count");
  const scopeOriginNamespaceId = rowNullableString(
    row,
    "scope_origin_namespace_id",
  );
  if (
    scopeOriginCount > 1
    || (scopeOriginCount === 1) !== (scopeOriginNamespaceId !== null)
    || (scopeOriginNamespaceId !== null && !UUID.test(scopeOriginNamespaceId))
  ) throw new TypeError("Agent Memory scope-origin mapping is invalid");
  const namespaceIds = canonicalIds([
    ...ordinaryNamespaceIds,
    ...(scopeOriginNamespaceId === null ? [] : [scopeOriginNamespaceId]),
  ]);
  const fingerprint = rowBytes(row, "crypto_required_namespace_fingerprint");
  if (!bytesEqual(fingerprint, fingerprintRequiredMemoryNamespaces(namespaceIds))) {
    throw new TypeError("Agent Memory exact Namespace fingerprint is invalid");
  }
  return Object.freeze({
    contentRevision: rowCounter(row, "content_revision"),
    accessRevision: rowCounter(row, "crypto_access_revision"),
    objectId,
    fingerprint,
    namespaceIds,
    scopeOriginCount,
    scopeOriginNamespaceId,
  });
}

function receiptMatches(
  receipt: AgentMemoryExactAccessCryptoReceipt,
  plan: AgentMemoryExactAccessPlan,
  digest: Uint8Array,
): boolean {
  return receipt.operationId === plan.operationId
    && receipt.memoryId === plan.memoryId
    && receipt.objectId === plan.cryptoObjectId
    && receipt.expectedContentRevision === plan.expectedContentRevision
    && receipt.expectedAccessRevision === plan.expectedCryptoAccessRevision
    && receipt.resultAccessRevision === plan.nextCryptoAccessRevision
    && bytesEqual(receipt.requestDigest, digest)
    && bytesEqual(
      receipt.targetRequiredNamespaceFingerprint,
      plan.targetRequiredNamespaceFingerprint,
    )
    && exactIds(receipt.currentNamespaceIds, plan.currentNamespaceIds)
    && exactIds(receipt.targetNamespaceIds, plan.targetNamespaceIds);
}

export class PostgresAgentMemoryExactAccessProduct {
  readonly #handle: ConversationProductPostgresHandle;
  readonly #readableNamespaceIds: readonly string[];
  readonly #crypto: AgentMemoryExactAccessCryptoCompletionPort | undefined;
  readonly #resolveGrantUserNamespace: ResolveAgentMemoryGrantUserNamespace;
  readonly #resolveCryptoAuthority:
    ResolveAgentMemoryExactAccessAuthority | undefined;

  constructor(input: Readonly<{
    handle: ConversationProductPostgresHandle;
    readableNamespaceIds: readonly string[];
    crypto?: AgentMemoryExactAccessCryptoCompletionPort;
    resolveGrantUserNamespace: ResolveAgentMemoryGrantUserNamespace;
    resolveCryptoAuthority?: ResolveAgentMemoryExactAccessAuthority;
  }>) {
    assertVerifiedConversationProductPostgresHandle(input.handle);
    if (input.handle.role !== "nautilo_agent") {
      throw new TypeError("Agent Memory exact access requires nautilo_agent");
    }
    this.#handle = input.handle;
    this.#readableNamespaceIds = canonicalIds(input.readableNamespaceIds);
    this.#crypto = input.crypto;
    this.#resolveGrantUserNamespace = input.resolveGrantUserNamespace;
    this.#resolveCryptoAuthority = input.resolveCryptoAuthority;
  }

  #transaction<Value>(
    authority: Extract<ProtectedMemoryAuthority, { mode: "namespace" }>,
    execute: (tx: ConversationProductPostgresTransaction) => Promise<Value>,
  ): Promise<Value> {
    return this.#handle.transaction(async (tx) => {
      await assertIdentity(tx, authority);
      return execute(tx);
    }, { isolationLevel: "serializable" });
  }

  #cryptoAuthority(input: Parameters<ResolveAgentMemoryExactAccessAuthority>[0]) {
    return this.#resolveCryptoAuthority?.(input) ?? Promise.resolve(null);
  }

  async planNativeChange(input: Readonly<{
    operationId: string;
    authority: ProtectedMemoryAuthority;
    memoryId: string;
    action: Readonly<{ kind: "grant_user"; userHandle: string }>;
  }>): Promise<ForegroundAgentMemoryNativeExactAccessProductPlanResult> {
    if (
      !PORTABLE_ID.test(input.operationId)
      || !UUID.test(input.memoryId)
      || !PORTABLE_ID.test(input.action.userHandle)
      || !authorityReadable(input.authority, this.#readableNamespaceIds)
    ) return unavailable("authorization_required");
    const authority = input.authority;
    const targetNamespaceId = await this.#resolveGrantUserNamespace({
      authority,
      userHandle: input.action.userHandle,
    });
    if (targetNamespaceId === null || !UUID.test(targetNamespaceId)) {
      return unavailable("target_encryption_not_ready");
    }
    return this.#transaction(authority, async (tx) => {
      const product = await loadProduct(tx, input.memoryId);
      if (product.scopeOriginCount !== 0) {
        throw new TypeError("Scope-origin Memory cannot be shared directly");
      }
      const sourceNamespaceId = product.namespaceIds.find((id) =>
        authority.readableNamespaceIds.includes(id));
      if (sourceNamespaceId === undefined
        || (!authority.mutableNamespaceIds.includes(targetNamespaceId)
          && authority.writableNamespaceId !== targetNamespaceId)) {
        return unavailable("authorization_required");
      }
      if (product.namespaceIds.includes(targetNamespaceId)) {
        const plan: ForegroundAgentMemoryNativeExactAccessPlan = Object.freeze({
          operationId: input.operationId, memoryId: input.memoryId,
          cryptoObjectId: product.objectId,
          expectedContentRevision: product.contentRevision,
          expectedCryptoAccessRevision: product.accessRevision,
          nextCryptoAccessRevision: product.accessRevision + 1,
          anchorNamespaceId: sourceNamespaceId,
          currentNamespaceIds: product.namespaceIds,
          targetNamespaceIds: product.namespaceIds,
          addedNamespaceIds: Object.freeze([]),
          removedNamespaceIds: Object.freeze([]),
          currentRequiredNamespaceFingerprint: product.fingerprint,
          targetRequiredNamespaceFingerprint: product.fingerprint,
          productMutation: Object.freeze({ kind: "grant_namespace" as const,
            namespaceId: targetNamespaceId }),
        });
        return Object.freeze({ status: "success" as const,
          value: Object.freeze({ status: "unchanged" as const,
            memoryId: input.memoryId, sourceNamespaceId, plan }) });
      }
      const targetNamespaceIds = Object.freeze([
        ...product.namespaceIds, targetNamespaceId,
      ].sort());
      const plan: ForegroundAgentMemoryNativeExactAccessPlan = Object.freeze({
        operationId: input.operationId,
        memoryId: input.memoryId,
        cryptoObjectId: product.objectId,
        expectedContentRevision: product.contentRevision,
        expectedCryptoAccessRevision: product.accessRevision,
        nextCryptoAccessRevision: product.accessRevision + 1,
        anchorNamespaceId: sourceNamespaceId,
        currentNamespaceIds: product.namespaceIds,
        targetNamespaceIds,
        addedNamespaceIds: Object.freeze([targetNamespaceId]),
        removedNamespaceIds: Object.freeze([]),
        currentRequiredNamespaceFingerprint: product.fingerprint,
        targetRequiredNamespaceFingerprint:
          fingerprintRequiredMemoryNamespaces(targetNamespaceIds),
        productMutation: Object.freeze({ kind: "grant_namespace" as const,
          namespaceId: targetNamespaceId }),
      });
      return Object.freeze({ status: "success" as const,
        value: Object.freeze({ status: "prepared" as const,
          sourceNamespaceId, plan }) });
    });
  }

  async planChange(input: Readonly<{
    operationId: string;
    authority: ProtectedMemoryAuthority;
    memoryId: string;
    action: Readonly<{ kind: "grant_user"; userHandle: string }>;
  }>): Promise<AgentMemoryExactAccessProductPlanResult> {
    if (
      !PORTABLE_ID.test(input.operationId)
      || !UUID.test(input.memoryId)
      || !PORTABLE_ID.test(input.action.userHandle)
      || !authorityReadable(input.authority, this.#readableNamespaceIds)
    ) return unavailable("authorization_required");
    const authority = input.authority;
    const targetNamespaceId = await this.#resolveGrantUserNamespace({
      authority,
      userHandle: input.action.userHandle,
    });
    if (targetNamespaceId === null || !UUID.test(targetNamespaceId)) {
      return unavailable("target_encryption_not_ready");
    }
    return this.#transaction(authority, async (tx) => {
      const product = await loadProduct(tx, input.memoryId);
      if (product.scopeOriginCount !== 0) {
        throw new TypeError("Scope-origin Memory cannot be shared directly");
      }
      const sourceNamespaceId = product.namespaceIds.find((id) =>
        authority.readableNamespaceIds.includes(id)
      );
      if (
        sourceNamespaceId === undefined
        || (!authority.mutableNamespaceIds.includes(targetNamespaceId)
          && authority.writableNamespaceId !== targetNamespaceId)
      ) return unavailable("authorization_required");
      if (product.namespaceIds.includes(targetNamespaceId)) {
        return Object.freeze({
          status: "success" as const,
          value: Object.freeze({
            status: "unchanged" as const,
            memoryId: input.memoryId,
          }),
        });
      }
      const targetNamespaceIds = Object.freeze([
        ...product.namespaceIds,
        targetNamespaceId,
      ].sort());
      const facts = await this.#cryptoAuthority({
        authority,
        currentNamespaceIds: product.namespaceIds,
        targetNamespaceIds,
      });
      if (facts === null) return unavailable("target_encryption_not_ready");
      const currentBindings = exactBindings(
        "Current Agent Memory",
        facts.currentBindings,
        product.namespaceIds,
      );
      const targetBindings = exactBindings(
        "Target Agent Memory",
        facts.targetBindings,
        targetNamespaceIds,
      );
      const plan: AgentMemoryExactAccessPlan = Object.freeze({
        operationId: input.operationId,
        memoryId: input.memoryId,
        cryptoObjectId: product.objectId,
        expectedContentRevision: product.contentRevision,
        expectedCryptoAccessRevision: product.accessRevision,
        nextCryptoAccessRevision: product.accessRevision + 1,
        anchorNamespaceId: sourceNamespaceId,
        currentNamespaceIds: product.namespaceIds,
        targetNamespaceIds,
        addedNamespaceIds: Object.freeze([targetNamespaceId]),
        removedNamespaceIds: Object.freeze([]),
        currentRequiredNamespaceFingerprint: product.fingerprint,
        targetRequiredNamespaceFingerprint:
          fingerprintRequiredMemoryNamespaces(targetNamespaceIds),
        currentBindings,
        targetBindings,
        productMutation: Object.freeze({
          kind: "grant_namespace" as const,
          namespaceId: targetNamespaceId,
        }),
      });
      return Object.freeze({
        status: "success" as const,
        value: Object.freeze({
          status: "prepared" as const,
          sourceNamespaceId,
          plan,
        }),
      });
    });
  }

  async planScopePromotion(input: Readonly<{
    operationId: string;
    authority: ProtectedMemoryAuthority;
    scopeId: string;
    memoryId: string;
    cryptoObjectId: string;
    expectedContentRevision: number;
    expectedAccessRevision: number;
    expectedRequiredNamespaceFingerprint: Uint8Array;
    sourceOriginNamespaceId: string;
    targetNamespaceId: string;
  }>): Promise<AgentMemoryExactAccessProductPlanResult> {
    if (
      !PORTABLE_ID.test(input.operationId)
      || !UUID.test(input.scopeId)
      || !UUID.test(input.memoryId)
      || !UUID.test(input.sourceOriginNamespaceId)
      || !UUID.test(input.targetNamespaceId)
      || input.sourceOriginNamespaceId === input.targetNamespaceId
      || input.expectedRequiredNamespaceFingerprint.length !== 32
      || !authorityReadable(input.authority, this.#readableNamespaceIds)
    ) return unavailable("authorization_required");
    const authority = input.authority;
    if (
      !authority.mutableNamespaceIds.includes(input.sourceOriginNamespaceId)
      || (!authority.mutableNamespaceIds.includes(input.targetNamespaceId)
        && authority.writableNamespaceId !== input.targetNamespaceId)
    ) return unavailable("authorization_required");
    return this.#transaction(authority, async (tx) => {
      const product = await loadProduct(tx, input.memoryId);
      const edges = await tx.query(
        `/* agent-memory:exact-access:scope-origin */
         SELECT scope_id::text AS scope_id, origin
           FROM memory_scopes
          WHERE memory_id = $1::uuid AND scope_id = $2::uuid
          LIMIT 2 FOR UPDATE`,
        [input.memoryId, input.scopeId],
      );
      if (
        product.scopeOriginCount !== 1
        || product.scopeOriginNamespaceId !== input.sourceOriginNamespaceId
        || product.objectId !== input.cryptoObjectId
        || product.contentRevision !== input.expectedContentRevision
        || product.accessRevision !== input.expectedAccessRevision
        || !bytesEqual(
          product.fingerprint,
          input.expectedRequiredNamespaceFingerprint,
        )
        || edges.length !== 1
        || rowString(edges[0]!, "scope_id") !== input.scopeId
        || rowString(edges[0]!, "origin") !== "scope"
      ) return unavailable("stale_revision");
      const targetNamespaceIds = Object.freeze(product.namespaceIds.map((id) =>
        id === input.sourceOriginNamespaceId ? input.targetNamespaceId : id
      ).sort());
      if (
        targetNamespaceIds.includes(input.sourceOriginNamespaceId)
        || new Set(targetNamespaceIds).size !== targetNamespaceIds.length
      ) return unavailable("integrity_failure");
      const facts = await this.#cryptoAuthority({
        authority,
        currentNamespaceIds: product.namespaceIds,
        targetNamespaceIds,
      });
      if (facts === null) return unavailable("target_encryption_not_ready");
      const plan: AgentMemoryExactAccessPlan = Object.freeze({
        operationId: input.operationId,
        memoryId: input.memoryId,
        cryptoObjectId: product.objectId,
        expectedContentRevision: product.contentRevision,
        expectedCryptoAccessRevision: product.accessRevision,
        nextCryptoAccessRevision: product.accessRevision + 1,
        anchorNamespaceId: input.sourceOriginNamespaceId,
        currentNamespaceIds: product.namespaceIds,
        targetNamespaceIds,
        addedNamespaceIds: Object.freeze([input.targetNamespaceId]),
        removedNamespaceIds: Object.freeze([input.sourceOriginNamespaceId]),
        currentRequiredNamespaceFingerprint: product.fingerprint,
        targetRequiredNamespaceFingerprint:
          fingerprintRequiredMemoryNamespaces(targetNamespaceIds),
        currentBindings: exactBindings(
          "Current scope-origin Memory",
          facts.currentBindings,
          product.namespaceIds,
        ),
        targetBindings: exactBindings(
          "Target promoted Memory",
          facts.targetBindings,
          targetNamespaceIds,
        ),
        productMutation: Object.freeze({
          kind: "promote_scope_origin" as const,
          scopeId: input.scopeId,
          sourceOriginNamespaceId: input.sourceOriginNamespaceId,
          targetNamespaceId: input.targetNamespaceId,
        }),
      });
      return Object.freeze({
        status: "success" as const,
        value: Object.freeze({
          status: "prepared" as const,
          sourceNamespaceId: input.sourceOriginNamespaceId,
          plan,
        }),
      });
    });
  }

  async detachScopeSeed(input: Readonly<{
    closeOperationId: string;
    authority: ProtectedMemoryAuthority;
    scopeId: string;
    memoryId: string;
    cryptoObjectId: string;
    expectedContentRevision: number;
    expectedAccessRevision: number;
    expectedRequiredNamespaceFingerprint: Uint8Array;
  }>): Promise<ProtectedMemoryResult<Readonly<{
    status: "detached" | "replayed";
    productReceiptRef: string;
  }>>> {
    if (
      !PORTABLE_ID.test(input.closeOperationId)
      || !UUID.test(input.scopeId)
      || !UUID.test(input.memoryId)
      || input.expectedRequiredNamespaceFingerprint.length !== 32
      || !authorityReadable(input.authority, this.#readableNamespaceIds)
    ) return unavailable("authorization_required");
    const authority = input.authority;
    return this.#transaction(authority, async (tx) => {
      const scopes = await tx.query(
        `/* agent-memory:scope-close:scope */
         SELECT lifecycle_state, close_operation_id
           FROM agent_scopes
          WHERE id = $1::uuid AND parent_agent_id = $2::uuid
            AND speaker_user_id = $3::uuid
          LIMIT 2 FOR UPDATE`,
        [input.scopeId, authority.agentId, authority.subjectUserId],
      );
      if (
        scopes.length !== 1
        || rowString(scopes[0]!, "lifecycle_state") !== "closing"
        || rowString(scopes[0]!, "close_operation_id")
          !== input.closeOperationId
      ) return unavailable("stale_revision");
      const product = await loadProduct(tx, input.memoryId);
      if (
        product.objectId !== input.cryptoObjectId
        || product.contentRevision !== input.expectedContentRevision
        || product.accessRevision !== input.expectedAccessRevision
        || !bytesEqual(
          product.fingerprint,
          input.expectedRequiredNamespaceFingerprint,
        )
      ) return unavailable("stale_revision");
      const edges = await tx.query(
        `/* agent-memory:scope-close:seed-edge */
         SELECT origin FROM memory_scopes
          WHERE memory_id = $1::uuid AND scope_id = $2::uuid
          LIMIT 2 FOR UPDATE`,
        [input.memoryId, input.scopeId],
      );
      if (edges.length === 0) {
        return Object.freeze({
          status: "success" as const,
          value: Object.freeze({
            status: "replayed" as const,
            productReceiptRef:
              `scope-seed:${input.closeOperationId}:${input.memoryId}`,
          }),
        });
      }
      if (edges.length !== 1 || rowString(edges[0]!, "origin") !== "seed") {
        return unavailable("integrity_failure");
      }
      const removed = await executeTypedConversationProductQuery(
        tx,
        conversationProductTypedDb.delete(memoryScopes).where(and(
          eq(memoryScopes.memoryId, input.memoryId),
          eq(memoryScopes.scopeId, input.scopeId),
          eq(memoryScopes.origin, "seed"),
        )).returning({ memory_id: memoryScopes.memoryId }),
      );
      if (removed.length !== 1) return unavailable("stale_revision");
      return Object.freeze({
        status: "success" as const,
        value: Object.freeze({
          status: "detached" as const,
          productReceiptRef:
            `scope-seed:${input.closeOperationId}:${input.memoryId}`,
        }),
      });
    });
  }

  async #commitProduct(
    tx: ConversationProductPostgresTransaction,
    authority: Extract<ProtectedMemoryAuthority, { mode: "namespace" }>,
    plan: AgentMemoryExactAccessPlan | ForegroundAgentMemoryNativeExactAccessPlan,
    digest: Uint8Array,
  ): Promise<"updated" | "replayed"> {
    const operation = oneOrNull(await tx.query(
      `/* agent-memory:exact-access:operation */
       SELECT operation_id, memory_id::text AS memory_id, operation_type,
              anchor_namespace_id::text AS anchor_namespace_id,
              expected_content_revision, expected_access_revision,
              result_access_revision, request_digest,
              target_required_namespace_fingerprint,
              completion, disposition
         FROM memory_crypto_operations
        WHERE operation_id = $1 LIMIT 2 FOR UPDATE`,
      [plan.operationId],
    ), "Agent Memory exact-access operation");
    if (
      operation === null
      || rowString(operation, "memory_id") !== plan.memoryId
      || rowString(operation, "operation_type") !== "access"
      || !bytesEqual(rowBytes(operation, "request_digest"), digest)
    ) throw new Error("Agent Memory exact-access reservation is absent");
    const product = await loadProduct(tx, plan.memoryId);
    if (
      rowString(operation, "completion") === "complete"
      && rowString(operation, "disposition") === "complete"
      && product.accessRevision === plan.nextCryptoAccessRevision
      && exactIds(product.namespaceIds, plan.targetNamespaceIds)
      && bytesEqual(
        product.fingerprint,
        plan.targetRequiredNamespaceFingerprint,
      )
    ) return "replayed";
    if (
      product.contentRevision !== plan.expectedContentRevision
      || product.accessRevision !== plan.expectedCryptoAccessRevision
      || product.objectId !== plan.cryptoObjectId
      || !exactIds(product.namespaceIds, plan.currentNamespaceIds)
      || !bytesEqual(
        product.fingerprint,
        plan.currentRequiredNamespaceFingerprint,
      )
    ) throw new Error("Agent Memory exact-access product became stale");
    if ("currentBindings" in plan) {
      const currentFacts = await this.#cryptoAuthority({
      authority,
      currentNamespaceIds: plan.currentNamespaceIds,
      targetNamespaceIds: plan.targetNamespaceIds,
      });
      if (currentFacts === null) {
        throw new Error("Agent Memory exact-access authority became stale");
      }
      exactBindings(
      "Current Agent Memory",
      currentFacts.currentBindings,
      plan.currentNamespaceIds,
      ).forEach((binding, index) => {
        const expected = plan.currentBindings[index]!;
        if (
          binding.domainId !== expected.domainId
          || binding.expectedAccessRevision !== expected.expectedAccessRevision
          || binding.expectedPolicyRevision !== expected.expectedPolicyRevision
          || !bytesEqual(binding.bindingHash, expected.bindingHash)
        ) throw new Error("Agent Memory exact-access current binding changed");
      });
      exactBindings(
      "Target Agent Memory",
      currentFacts.targetBindings,
      plan.targetNamespaceIds,
      ).forEach((binding, index) => {
        const expected = plan.targetBindings[index]!;
        if (
          binding.domainId !== expected.domainId
          || binding.expectedAccessRevision !== expected.expectedAccessRevision
          || binding.expectedPolicyRevision !== expected.expectedPolicyRevision
          || !bytesEqual(binding.bindingHash, expected.bindingHash)
        ) throw new Error("Agent Memory exact-access target binding changed");
      });
    }
    if (plan.productMutation.kind === "promote_scope_origin") {
      const mutation = plan.productMutation;
      const removed = await executeTypedConversationProductQuery(
        tx,
        conversationProductTypedDb.delete(memoryScopes).where(and(
          eq(memoryScopes.memoryId, plan.memoryId),
          eq(memoryScopes.scopeId, mutation.scopeId),
          eq(memoryScopes.origin, "scope"),
        )).returning({ memory_id: memoryScopes.memoryId }),
      );
      if (removed.length !== 1) {
        throw new Error("Agent Memory scope-origin promotion lost its edge CAS");
      }
    }
    for (const namespaceId of plan.addedNamespaceIds) {
      const rows = await executeTypedConversationProductQuery(
        tx,
        conversationProductTypedDb.insert(memoryNamespaces).values({
          memoryId: plan.memoryId,
          namespaceId,
        }).returning({ namespace_id: memoryNamespaces.namespaceId }),
      );
      if (rows.length !== 1 || rows[0]?.["namespace_id"] !== namespaceId) {
        throw new Error("Agent Memory exact-access addition lost its CAS");
      }
    }
    const promotion = plan.productMutation.kind
      === "promote_scope_origin" ? plan.productMutation : null;
    const mapped = await tx.query(
      promotion === null
        ? `UPDATE memories
              SET crypto_access_revision = $3,
                  crypto_required_namespace_fingerprint = $4,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1::uuid AND content_revision = $2
              AND crypto_access_revision = $5 AND crypto_object_id = $6
              AND crypto_required_namespace_fingerprint = $7
          RETURNING id::text AS memory_id`
        : `UPDATE memories
              SET crypto_access_revision = $3,
                  crypto_required_namespace_fingerprint = $4,
                  scope_origin_namespace_id = NULL,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1::uuid AND content_revision = $2
              AND crypto_access_revision = $5 AND crypto_object_id = $6
              AND crypto_required_namespace_fingerprint = $7
              AND scope_origin_namespace_id = $8::uuid
          RETURNING id::text AS memory_id`,
      [plan.memoryId, plan.expectedContentRevision,
        plan.nextCryptoAccessRevision,
        plan.targetRequiredNamespaceFingerprint,
        plan.expectedCryptoAccessRevision, plan.cryptoObjectId,
        plan.currentRequiredNamespaceFingerprint,
        ...(promotion === null ? [] : [promotion.sourceOriginNamespaceId])],
    );
    if (mapped.length !== 1) {
      throw new Error("Agent Memory exact-access mapping lost its CAS");
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
        eq(memoryCryptoOperations.operationId, plan.operationId),
        eq(memoryCryptoOperations.memoryId, plan.memoryId),
        eq(memoryCryptoOperations.completion, "pending"),
        eq(memoryCryptoOperations.disposition, "active"),
      )).returning({ operation_id: memoryCryptoOperations.operationId }),
    );
    if (completed.length !== 1) {
      throw new Error("Agent Memory exact-access completion lost its CAS");
    }
    return "updated";
  }

  /** Finish an already-published native grant under fresh foreground custody.
   * The caller authenticates the N+1 head and holds its exact Namespace set.
   * At N (or without one exact pending receipt) this performs no repair. */
  async reconcileNativeCommitted(input: Readonly<{
    authority: ProtectedMemoryAuthority;
    plan: ForegroundAgentMemoryNativeExactAccessPlan;
    head: Readonly<{ objectId: string; accessRevision: number;
      namespaceIds: readonly string[]; manifestHash: Uint8Array }>;
  }>): Promise<boolean> {
    const { plan, head } = input;
    if (!authorityReadable(input.authority, this.#readableNamespaceIds)
      || plan.productMutation.kind !== "grant_namespace"
      || !input.authority.readableNamespaceIds.includes(plan.anchorNamespaceId)
      || (!input.authority.mutableNamespaceIds.includes(plan.productMutation.namespaceId)
        && input.authority.writableNamespaceId !== plan.productMutation.namespaceId)
      || !exactIds(plan.addedNamespaceIds, [plan.productMutation.namespaceId])
      || plan.removedNamespaceIds.length !== 0
      || !exactIds([...plan.currentNamespaceIds, plan.productMutation.namespaceId].sort(),
        plan.targetNamespaceIds)
      || plan.nextCryptoAccessRevision !== plan.expectedCryptoAccessRevision + 1
      || head.objectId !== plan.cryptoObjectId
      || head.accessRevision !== plan.nextCryptoAccessRevision
      || head.manifestHash.length !== 32
      || !exactIds(head.namespaceIds, plan.targetNamespaceIds)) return false;
    const authority = input.authority;
    return this.#transaction(authority, async (tx) => {
      const operations = await executeTypedConversationProductQuery(tx,
        conversationProductTypedDb.select({
          operation_id: memoryCryptoOperations.operationId,
          anchor_namespace_id: memoryCryptoOperations.anchorNamespaceId,
          request_digest: memoryCryptoOperations.requestDigest,
        }).from(memoryCryptoOperations).where(and(
          eq(memoryCryptoOperations.memoryId, plan.memoryId),
          eq(memoryCryptoOperations.operationType, "access"),
          eq(memoryCryptoOperations.expectedContentRevision, plan.expectedContentRevision),
          eq(memoryCryptoOperations.expectedAccessRevision, plan.expectedCryptoAccessRevision),
          eq(memoryCryptoOperations.resultAccessRevision, plan.nextCryptoAccessRevision),
          eq(memoryCryptoOperations.targetRequiredNamespaceFingerprint,
            plan.targetRequiredNamespaceFingerprint),
          eq(memoryCryptoOperations.completion, "pending"),
          eq(memoryCryptoOperations.disposition, "active"),
        )).limit(2).for("update"));
      // Ambiguity is an integrity failure, not permission to guess which
      // approval won. No fresh operation or ciphertext is created here.
      if (operations.length !== 1) return false;
      const operation = operations[0]!;
      const anchorNamespaceId = rowString(operation, "anchor_namespace_id");
      if (!plan.currentNamespaceIds.includes(anchorNamespaceId)
        || !authority.readableNamespaceIds.includes(anchorNamespaceId)) return false;
      const product = await loadProduct(tx, plan.memoryId);
      if (product.scopeOriginCount !== 0) return false;
      await this.#commitProduct(tx, authority, {
        ...plan,
        operationId: rowString(operation, "operation_id"),
        anchorNamespaceId,
      }, rowBytes(operation, "request_digest"));
      return true;
    });
  }

  async commitNativePrepared(input: Readonly<{
    authority: ProtectedMemoryAuthority;
    plan: ForegroundAgentMemoryNativeExactAccessPlan;
    publication: ForegroundAgentMemoryNativeExactAccessPublication;
    persist(): Promise<"created" | "duplicate" | "stale">;
  }>): Promise<ProtectedMemoryResult<Readonly<{
    status: "updated" | "replayed";
    memoryId: string;
  }>>> {
    if (!authorityReadable(input.authority, this.#readableNamespaceIds)
      || input.plan.productMutation.kind === "replace_exact"
      || input.publication.objectId !== input.plan.cryptoObjectId
      || input.publication.expectedAccessRevision
        !== input.plan.expectedCryptoAccessRevision
      || input.publication.nextAccessRevision
        !== input.plan.nextCryptoAccessRevision
      || !exactIds(input.publication.currentEntries.map((entry) => entry.namespaceId),
        input.plan.currentNamespaceIds)
      || !exactIds(input.publication.targetEntries.map((entry) => entry.namespaceId),
        input.plan.targetNamespaceIds)) return unavailable("authorization_required");
    const authority = input.authority;
    const digest = foregroundAgentMemoryNativeExactAccessDigest(
      input.plan,
      input.publication,
    );
    const reserve = await this.#transaction(authority, async (tx) => {
      const existing = oneOrNull(await tx.query(
        `/* agent-memory:native-exact-access:operation */
         SELECT operation_id, memory_id::text AS memory_id, operation_type,
                expected_content_revision, expected_access_revision,
                result_access_revision, request_digest,
                target_required_namespace_fingerprint, completion, disposition
           FROM memory_crypto_operations
          WHERE operation_id = $1 LIMIT 2 FOR UPDATE`,
        [input.plan.operationId],
      ), "Agent Memory native exact-access operation");
      const product = await loadProduct(tx, input.plan.memoryId);
      if (existing !== null) {
        if (rowString(existing, "memory_id") !== input.plan.memoryId
          || rowString(existing, "operation_type") !== "access"
          || !bytesEqual(rowBytes(existing, "request_digest"), digest)) {
          throw new Error("Agent Memory native exact-access replay conflicts");
        }
        if (rowString(existing, "completion") === "complete"
          && rowString(existing, "disposition") === "complete"
          && product.accessRevision === input.plan.nextCryptoAccessRevision
          && exactIds(product.namespaceIds, input.plan.targetNamespaceIds)) {
          return "completed" as const;
        }
        if (rowString(existing, "completion") !== "pending"
          || rowString(existing, "disposition") !== "active") {
          throw new Error("Agent Memory native exact-access replay is stale");
        }
        return "pending" as const;
      }
      if (product.contentRevision !== input.plan.expectedContentRevision
        || product.accessRevision !== input.plan.expectedCryptoAccessRevision
        || product.objectId !== input.plan.cryptoObjectId
        || !exactIds(product.namespaceIds, input.plan.currentNamespaceIds)
        || !bytesEqual(product.fingerprint,
          input.plan.currentRequiredNamespaceFingerprint)) {
        throw new Error("Agent Memory native exact-access reservation became stale");
      }
      await executeTypedConversationProductQuery(tx,
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
          requestDigest: digest,
        }));
      return "reserved" as const;
    });
    if (reserve === "completed") return Object.freeze({
      status: "success" as const,
      value: Object.freeze({ status: "replayed" as const,
        memoryId: input.plan.memoryId }),
    });
    const persisted = await input.persist();
    if (persisted === "stale") return unavailable("stale_revision");
    const committed = await this.#transaction(authority, (tx) =>
      this.#commitProduct(tx, authority, input.plan, digest));
    return Object.freeze({ status: "success" as const,
      value: Object.freeze({ status: committed === "replayed" || reserve === "pending"
        ? "replayed" as const : "updated" as const,
        memoryId: input.plan.memoryId }) });
  }

  async commitPrepared(input: Readonly<{
    authority: ProtectedMemoryAuthority;
    plan: AgentMemoryExactAccessPlan;
    prepared: PreparedAgentMemoryExactAccess;
  }>): Promise<ProtectedMemoryResult<Readonly<{
    status: "updated" | "replayed";
    memoryId: string;
  }>>> {
    if (this.#crypto === undefined) return unavailable("authorization_required");
    if (!authorityReadable(input.authority, this.#readableNamespaceIds)) {
      return unavailable("authorization_required");
    }
    if (input.plan.productMutation.kind === "replace_exact") {
      return unavailable("authorization_required");
    }
    const authority = input.authority;
    const digest = agentMemoryExactAccessRequestDigest(input.prepared);
    const reserve = await this.#transaction(authority, async (tx) => {
      const existing = oneOrNull(await tx.query(
        `/* agent-memory:exact-access:operation */
         SELECT operation_id, memory_id::text AS memory_id, operation_type,
                anchor_namespace_id::text AS anchor_namespace_id,
                expected_content_revision, result_content_revision,
                expected_access_revision, result_access_revision,
                request_digest, target_required_namespace_fingerprint,
                completion, disposition
           FROM memory_crypto_operations
          WHERE operation_id = $1 LIMIT 2 FOR UPDATE`,
        [input.plan.operationId],
      ), "Agent Memory exact-access operation");
      if (existing !== null) {
        if (
          rowString(existing, "memory_id") !== input.plan.memoryId
          || rowString(existing, "operation_type") !== "access"
          || rowString(existing, "anchor_namespace_id")
            !== input.plan.anchorNamespaceId
          || rowCounter(existing, "expected_content_revision")
            !== input.plan.expectedContentRevision
          || rowCounter(existing, "expected_access_revision")
            !== input.plan.expectedCryptoAccessRevision
          || rowCounter(existing, "result_access_revision")
            !== input.plan.nextCryptoAccessRevision
          || !bytesEqual(rowBytes(existing, "request_digest"), digest)
          || !bytesEqual(
            rowBytes(existing, "target_required_namespace_fingerprint"),
            input.plan.targetRequiredNamespaceFingerprint,
          )
        ) throw new Error("Agent Memory exact-access replay conflicts");
        const product = await loadProduct(tx, input.plan.memoryId);
        if (
          rowString(existing, "completion") === "complete"
          && rowString(existing, "disposition") === "complete"
          && product.contentRevision === input.plan.expectedContentRevision
          && product.accessRevision === input.plan.nextCryptoAccessRevision
          && exactIds(product.namespaceIds, input.plan.targetNamespaceIds)
          && bytesEqual(
            product.fingerprint,
            input.plan.targetRequiredNamespaceFingerprint,
          )
        ) return "completed" as const;
        if (
          rowString(existing, "completion") !== "pending"
          || rowString(existing, "disposition") !== "active"
          || product.contentRevision !== input.plan.expectedContentRevision
          || product.accessRevision !== input.plan.expectedCryptoAccessRevision
          || product.objectId !== input.plan.cryptoObjectId
          || !exactIds(product.namespaceIds, input.plan.currentNamespaceIds)
          || !bytesEqual(
            product.fingerprint,
            input.plan.currentRequiredNamespaceFingerprint,
          )
        ) throw new Error("Agent Memory exact-access pending replay is stale");
        return "pending" as const;
      }
      const product = await loadProduct(tx, input.plan.memoryId);
      if (
        product.contentRevision !== input.plan.expectedContentRevision
        || product.accessRevision !== input.plan.expectedCryptoAccessRevision
        || product.objectId !== input.plan.cryptoObjectId
        || !exactIds(product.namespaceIds, input.plan.currentNamespaceIds)
        || !bytesEqual(
          product.fingerprint,
          input.plan.currentRequiredNamespaceFingerprint,
        )
      ) throw new Error("Agent Memory exact-access reservation became stale");
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
          requestDigest: digest,
        }),
      );
      return "reserved" as const;
    });
    if (reserve === "completed") {
      return Object.freeze({
        status: "success" as const,
        value: Object.freeze({
          status: "replayed" as const,
          memoryId: input.plan.memoryId,
        }),
      });
    }
    const receipt = await this.#crypto.complete(input.prepared);
    if (!receiptMatches(receipt, input.plan, digest)) {
      throw new TypeError("Agent Memory exact-access crypto receipt was substituted");
    }
    const committed = await this.#transaction(authority, (tx) =>
      this.#commitProduct(tx, authority, input.plan, digest));
    return Object.freeze({
      status: "success" as const,
      value: Object.freeze({
        status: committed === "replayed" || reserve === "pending"
          ? "replayed" as const
          : "updated" as const,
        memoryId: input.plan.memoryId,
      }),
    });
  }

  /**
   * Restart-only reconciliation. If restricted crypto reached N+1, recover
   * the exact target from its authenticated head and finish the ordinary
   * product CAS without the lost process-local prepared handle. If crypto is
   * still at N, quarantine the abandoned reservation so a fresh foreground
   * Grant/session can create a new operation instead of leaving shadow state
   * pending forever.
   */
  async reconcileAfterProcessLoss(input: Readonly<{
    authority: ProtectedMemoryAuthority;
    operationId: string;
    memoryId: string;
  }>): Promise<AgentMemoryExactAccessReconcileResult> {
    if (this.#crypto === undefined) return Object.freeze({ status: "denied" });
    if (
      !PORTABLE_ID.test(input.operationId)
      || !UUID.test(input.memoryId)
      || !authorityReadable(input.authority, this.#readableNamespaceIds)
    ) return Object.freeze({ status: "denied" as const });
    const authority = input.authority;
    const candidate = await this.#transaction(authority, async (tx) => {
      const operation = oneOrNull(await executeTypedConversationProductQuery(
        tx,
        conversationProductTypedDb.select({
          operation_id: memoryCryptoOperations.operationId,
          memory_id: memoryCryptoOperations.memoryId,
          operation_type: memoryCryptoOperations.operationType,
        }).from(memoryCryptoOperations)
          .where(eq(memoryCryptoOperations.operationId, input.operationId))
          .limit(2),
      ), "Agent Memory exact-access operation");
      if (operation === null) {
        return Object.freeze({ status: "absent" as const });
      }
      if (
        rowString(operation, "memory_id") !== input.memoryId
        || rowString(operation, "operation_type") !== "access"
      ) return Object.freeze({ status: "conflict" as const });
      const product = await loadProduct(tx, input.memoryId);
      return Object.freeze({
        status: "candidate" as const,
        objectId: product.objectId,
      });
    });
    if (candidate.status === "absent") {
      return Object.freeze({ status: "stale" as const });
    }
    if (candidate.status === "conflict") {
      return Object.freeze({ status: "quarantined" as const });
    }
    let observed: AgentMemoryExactAccessCryptoObservation;
    try {
      observed = await this.#crypto.observe(candidate.objectId);
    } catch {
      return Object.freeze({ status: "pending" as const, phase: "crypto" as const });
    }
    return this.#transaction(authority, async (tx) => {
      const operation = oneOrNull(await tx.query(
        `/* agent-memory:exact-access:operation */
         SELECT operation_id, memory_id::text AS memory_id, operation_type,
                anchor_namespace_id::text AS anchor_namespace_id,
                expected_content_revision, expected_access_revision,
                result_access_revision, request_digest,
                target_required_namespace_fingerprint,
                completion, disposition
           FROM memory_crypto_operations
          WHERE operation_id = $1 LIMIT 2 FOR UPDATE`,
        [input.operationId],
      ), "Agent Memory exact-access operation");
      if (
        operation === null
        || rowString(operation, "memory_id") !== input.memoryId
        || rowString(operation, "operation_type") !== "access"
      ) return Object.freeze({ status: "quarantined" as const });
      const product = await loadProduct(tx, input.memoryId);
      if (
        observed.status === "absent"
        || observed.objectId !== product.objectId
        || observed.manifestHash.length !== 32
      ) return Object.freeze({ status: "quarantined" as const });
      let observedIds: readonly string[];
      try {
        observedIds = canonicalIds(observed.namespaceIds);
      } catch {
        return Object.freeze({ status: "quarantined" as const });
      }
      const expectedContentRevision = rowCounter(
        operation,
        "expected_content_revision",
      );
      const expectedAccessRevision = rowCounter(
        operation,
        "expected_access_revision",
      );
      const nextAccessRevision = rowCounter(operation, "result_access_revision");
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
            && observed.accessRevision === nextAccessRevision
            && exactIds(product.namespaceIds, observedIds)
            && bytesEqual(product.fingerprint, targetFingerprint)
          ? Object.freeze({
              status: "completed" as const,
              operationId: input.operationId,
              memoryId: input.memoryId,
              cryptoAccessRevision: product.accessRevision,
              requiredNamespaceIds: product.namespaceIds,
            })
          : Object.freeze({ status: "quarantined" as const });
      }
      if (
        rowString(operation, "completion") !== "pending"
        || rowString(operation, "disposition") !== "active"
        || product.contentRevision !== expectedContentRevision
        || product.accessRevision !== expectedAccessRevision
        || nextAccessRevision !== expectedAccessRevision + 1
      ) return Object.freeze({ status: "stale" as const });
      if (
        observed.accessRevision === expectedAccessRevision
        && exactIds(product.namespaceIds, observedIds)
      ) {
        const abandoned = await executeTypedConversationProductQuery(
          tx,
          conversationProductTypedDb.update(memoryCryptoOperations).set({
            disposition: "quarantined",
            failureCode: "crypto_absent",
            nextAttemptAt: null,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          }).where(and(
            eq(memoryCryptoOperations.operationId, input.operationId),
            eq(memoryCryptoOperations.completion, "pending"),
            eq(memoryCryptoOperations.disposition, "active"),
          )).returning({ operation_id: memoryCryptoOperations.operationId }),
        );
        return Object.freeze({
          status: abandoned.length === 1 ? "stale" as const : "quarantined" as const,
        });
      }
      if (
        observed.accessRevision !== nextAccessRevision
        || !bytesEqual(
          fingerprintRequiredMemoryNamespaces(observedIds),
          targetFingerprint,
        )
      ) return Object.freeze({ status: "quarantined" as const });
      const currentSet = new Set(product.namespaceIds);
      const targetSet = new Set(observedIds);
      const addedNamespaceIds = Object.freeze(observedIds.filter((id) =>
        !currentSet.has(id)
      ));
      const removedNamespaceIds = Object.freeze(product.namespaceIds.filter(
        (id) => !targetSet.has(id),
      ));
      const anchorNamespaceId = rowString(operation, "anchor_namespace_id");
      if (
        !product.namespaceIds.includes(anchorNamespaceId)
        || !authority.readableNamespaceIds.includes(anchorNamespaceId)
      ) return Object.freeze({ status: "denied" as const });
      let productMutation: AgentMemoryExactAccessPlan["productMutation"];
      if (product.scopeOriginCount === 0) {
        if (
          removedNamespaceIds.length !== 0
          || addedNamespaceIds.length !== 1
          || (!authority.mutableNamespaceIds.includes(addedNamespaceIds[0]!)
            && authority.writableNamespaceId !== addedNamespaceIds[0])
        ) return Object.freeze({ status: "denied" as const });
        productMutation = Object.freeze({
          kind: "grant_namespace" as const,
          namespaceId: addedNamespaceIds[0]!,
        });
      } else {
        const sourceOriginNamespaceId = product.scopeOriginNamespaceId;
        if (
          sourceOriginNamespaceId === null
          || removedNamespaceIds.length !== 1
          || removedNamespaceIds[0] !== sourceOriginNamespaceId
          || addedNamespaceIds.length !== 1
          || !authority.mutableNamespaceIds.includes(sourceOriginNamespaceId)
          || (!authority.mutableNamespaceIds.includes(addedNamespaceIds[0]!)
            && authority.writableNamespaceId !== addedNamespaceIds[0])
        ) return Object.freeze({ status: "denied" as const });
        const scopes = await tx.query(
          `SELECT ms.scope_id::text AS scope_id, scope.lifecycle_state
             FROM memory_scopes ms
             JOIN agent_scopes scope ON scope.id = ms.scope_id
            WHERE ms.memory_id = $1::uuid AND ms.origin = 'scope'
              AND scope.parent_agent_id = $2::uuid
              AND scope.speaker_user_id = $3::uuid
            LIMIT 2 FOR UPDATE OF ms, scope`,
          [input.memoryId, authority.agentId, authority.subjectUserId],
        );
        if (
          scopes.length !== 1
          || rowString(scopes[0]!, "lifecycle_state") !== "closing"
        ) return Object.freeze({ status: "denied" as const });
        productMutation = Object.freeze({
          kind: "promote_scope_origin" as const,
          scopeId: rowString(scopes[0]!, "scope_id"),
          sourceOriginNamespaceId,
          targetNamespaceId: addedNamespaceIds[0]!,
        });
      }
      const facts = await this.#cryptoAuthority({
        authority,
        currentNamespaceIds: product.namespaceIds,
        targetNamespaceIds: observedIds,
      });
      if (facts === null) return Object.freeze({ status: "denied" as const });
      let currentBindings: readonly AgentMemoryExactAccessBindingFact[];
      let targetBindings: readonly AgentMemoryExactAccessBindingFact[];
      try {
        currentBindings = exactBindings(
          "Current Agent Memory",
          facts.currentBindings,
          product.namespaceIds,
        );
        targetBindings = exactBindings(
          "Target Agent Memory",
          facts.targetBindings,
          observedIds,
        );
      } catch {
        return Object.freeze({ status: "denied" as const });
      }
      const plan: AgentMemoryExactAccessPlan = Object.freeze({
        operationId: input.operationId,
        memoryId: input.memoryId,
        cryptoObjectId: product.objectId,
        expectedContentRevision,
        expectedCryptoAccessRevision: expectedAccessRevision,
        nextCryptoAccessRevision: nextAccessRevision,
        anchorNamespaceId,
        currentNamespaceIds: product.namespaceIds,
        targetNamespaceIds: observedIds,
        addedNamespaceIds,
        removedNamespaceIds,
        currentRequiredNamespaceFingerprint: product.fingerprint,
        targetRequiredNamespaceFingerprint: targetFingerprint,
        currentBindings,
        targetBindings,
        productMutation,
      });
      await this.#commitProduct(
        tx,
        authority,
        plan,
        rowBytes(operation, "request_digest"),
      );
      return Object.freeze({
        status: "completed" as const,
        operationId: input.operationId,
        memoryId: input.memoryId,
        cryptoAccessRevision: nextAccessRevision,
        requiredNamespaceIds: observedIds,
      });
    });
  }
}
