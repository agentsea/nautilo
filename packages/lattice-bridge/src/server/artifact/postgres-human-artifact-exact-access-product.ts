import {
  and,
  artifactCryptoOperations,
  artifactNamespaces,
  artifacts,
  eq,
  sql,
} from "@nautilo/db";
import {
  deriveHumanArtifactExactAccessChange,
  fingerprintHumanArtifactExactAccessTarget,
  targetAfterHumanArtifactAuthorizedViewDeletion,
  type HumanArtifactExactAccessAuthority,
  type HumanArtifactExactAccessChange,
} from "./human-artifact-exact-access.ts";
import {
  assertVerifiedConversationProductPostgresHandle,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresHandle,
  type ConversationProductPostgresTransaction,
} from "../message/postgres-conversation-product-store.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const OBJECT_ID = /^artifact:v1:[0-9a-f]{64}$/u;

export type HumanArtifactExactAccessTarget =
  | Readonly<{ kind: "replace_exact"; namespaceIds: readonly string[] }>
  | Readonly<{ kind: "delete_authorized_view" }>;

export type HumanArtifactExactAccessBindingFact = Readonly<{
  namespaceId: string;
  domainId: string;
  expectedAccessRevision: number;
  expectedPolicyRevision: number;
  bindingHash: Uint8Array;
}>;

export type HumanArtifactExactAccessAuthorityFacts = Readonly<{
  currentBindings: readonly HumanArtifactExactAccessBindingFact[];
  targetBindings: readonly HumanArtifactExactAccessBindingFact[];
  sourceAuthorized: true;
  targetAuthorized: true;
}>;

export type HumanArtifactExactAccessPlan = Omit<
  HumanArtifactExactAccessChange,
  "status"
> & Readonly<{
  status: "prepared";
  operationId: string;
  subjectHumanId: string;
  anchorNamespaceId: string;
  artifactRowId: string;
  artifactId: string;
  artifactRevision: number;
  cryptoObjectId: string;
  expectedCryptoAccessRevision: number;
  nextCryptoAccessRevision: number;
  blobId: string;
  blobGeneration: number;
  currentRequiredNamespaceFingerprint: Uint8Array;
  targetRequiredNamespaceFingerprint: Uint8Array;
  currentBindings: readonly HumanArtifactExactAccessBindingFact[];
  targetBindings: readonly HumanArtifactExactAccessBindingFact[];
  sourceAuthorized: true;
  targetAuthorized: true;
}>;

export type HumanArtifactExactAccessPlanResult =
  | HumanArtifactExactAccessPlan
  | Readonly<{ status: "unavailable"; reason: "target_encryption_not_ready" }>
  | Readonly<{
      status: "unchanged";
      artifactId: string;
      cryptoAccessRevision: number;
      requiredNamespaceIds: readonly string[];
    }>;

export type HumanArtifactExactAccessCryptoReceipt = Readonly<{
  operationId: string;
  artifactId: string;
  objectId: string;
  artifactRevision: number;
  blobId: string;
  blobGeneration: number;
  expectedAccessRevision: number;
  resultAccessRevision: number;
  currentManifestHash: Uint8Array;
  resultManifestHash: Uint8Array;
  targetRequiredNamespaceFingerprint: Uint8Array;
  requestDigest: Uint8Array;
  currentNamespaceIds: readonly string[];
  targetNamespaceIds: readonly string[];
  status: "applied" | "duplicate";
}>;

export type HumanArtifactExactAccessCryptoObservation =
  | Readonly<{ status: "absent" | "conflict" }>
  | Readonly<{
      status: "current";
      objectId: string;
      accessRevision: number;
      manifestHash: Uint8Array;
      namespaceIds: readonly string[];
    }>
  | Readonly<{
      status: "target";
      objectId: string;
      accessRevision: number;
      manifestHash: Uint8Array;
      previousManifestHash: Uint8Array;
      namespaceIds: readonly string[];
    }>;

export type HumanArtifactExactAccessCommitResult = Readonly<{
  status: "updated" | "replayed";
  operationId: string;
  artifactId: string;
  cryptoAccessRevision: number;
  requiredNamespaceIds: readonly string[];
}>;

export type HumanArtifactExactAccessReplayLookup =
  | Readonly<{ status: "absent" | "conflict" }>
  | Readonly<{ status: "pending"; cryptoObjectId: string }>
  | Readonly<{
      status: "completed";
      cryptoAccessRevision: number;
      requiredNamespaceIds: readonly string[];
    }>;

export type HumanArtifactExactAccessReconcileResult =
  | Readonly<{ status: "pending" }>
  | Readonly<{
      status: "completed";
      cryptoAccessRevision: number;
      requiredNamespaceIds: readonly string[];
    }>
  | Readonly<{ status: "stale" | "denied" | "quarantined" }>;

type ProductSnapshot = Readonly<{
  artifactRowId: string;
  artifactId: string;
  artifactRevision: number;
  accessRevision: number;
  objectId: string;
  blobId: string;
  blobGeneration: number;
  fingerprint: Uint8Array;
  namespaceIds: readonly string[];
  lifecycleState: string;
}>;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function text(row: ConversationProductDatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError(`${field} must be text`);
  return value;
}

function counter(row: ConversationProductDatabaseRow, field: string): number {
  const raw = row[field];
  const value = typeof raw === "bigint" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a safe counter`);
  }
  return value;
}

function digest(row: ConversationProductDatabaseRow, field: string): Uint8Array {
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
    throw new TypeError("Artifact Namespace inventory is invalid");
  }
  const ids = parsed.map((entry) => {
    if (typeof entry !== "string" || !UUID.test(entry)) {
      throw new TypeError("Artifact Namespace inventory is invalid");
    }
    return entry;
  }).sort();
  if (ids.some((id, index) => index > 0 && ids[index - 1] === id)) {
    throw new TypeError("Artifact Namespace inventory is duplicated");
  }
  return Object.freeze(ids);
}

function normalizeFacts(
  change: HumanArtifactExactAccessChange,
  value: HumanArtifactExactAccessAuthorityFacts | null,
): HumanArtifactExactAccessAuthorityFacts | null {
  if (value === null) return null;
  const normalize = (
    label: string,
    bindings: readonly HumanArtifactExactAccessBindingFact[],
    expectedIds: readonly string[],
  ) => {
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
        || !(binding.bindingHash instanceof Uint8Array)
        || binding.bindingHash.length !== 32
      ) throw new TypeError(`${label} binding authority is invalid`);
      return Object.freeze({ ...binding, bindingHash: binding.bindingHash.slice() });
    }));
  };
  if (value.sourceAuthorized !== true || value.targetAuthorized !== true) {
    throw new TypeError("Human Artifact exact-access authority is incomplete");
  }
  return Object.freeze({
    currentBindings: normalize("Current Artifact", value.currentBindings,
      change.currentNamespaceIds),
    targetBindings: normalize("Target Artifact", value.targetBindings,
      change.targetNamespaceIds),
    sourceAuthorized: true,
    targetAuthorized: true,
  });
}

function exactBindings(
  left: readonly HumanArtifactExactAccessBindingFact[],
  right: readonly HumanArtifactExactAccessBindingFact[],
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const expected = right[index];
    return expected !== undefined
      && entry.namespaceId === expected.namespaceId
      && entry.domainId === expected.domainId
      && entry.expectedAccessRevision === expected.expectedAccessRevision
      && entry.expectedPolicyRevision === expected.expectedPolicyRevision
      && bytesEqual(entry.bindingHash, expected.bindingHash);
  });
}

async function assertIdentity(
  tx: ConversationProductPostgresTransaction,
  authority: HumanArtifactExactAccessAuthority,
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
  ) throw new TypeError("Human Artifact exact access identity is unavailable");
}

async function loadProduct(
  tx: ConversationProductPostgresTransaction,
  artifactId: string,
): Promise<ProductSnapshot> {
  const row = oneOrNull(await tx.query(
    `/* human-artifact:exact-access:lock-product */
     SELECT a.id::text AS artifact_row_id, a.artifact_id, a.revision,
            a.crypto_access_revision, a.crypto_object_id, a.blob_id,
            a.blob_generation, a.crypto_required_namespace_fingerprint,
            a.crypto_lifecycle_state,
            COALESCE((SELECT json_agg(an.namespace_id::text ORDER BY an.namespace_id)
              FROM artifact_namespaces an WHERE an.artifact_id = a.id), '[]'::json)::text
              AS namespace_ids
       FROM artifacts a
      WHERE a.artifact_id = $1 AND a.crypto_object_id IS NOT NULL
      LIMIT 2 FOR UPDATE`,
    [artifactId],
  ), "Human Artifact exact-access product");
  if (row === null) throw new Error("Human Artifact exact-access product is unavailable");
  const objectId = text(row, "crypto_object_id");
  const blobId = text(row, "blob_id");
  if (!OBJECT_ID.test(objectId) || !UUID.test(blobId)) {
    throw new TypeError("Human Artifact crypto mapping is invalid");
  }
  const namespaceIds = canonicalIds(row["namespace_ids"]);
  const fingerprint = digest(row, "crypto_required_namespace_fingerprint");
  if (!bytesEqual(fingerprint,
    fingerprintHumanArtifactExactAccessTarget(namespaceIds))) {
    throw new TypeError("Human Artifact Namespace fingerprint is invalid");
  }
  return Object.freeze({
    artifactRowId: text(row, "artifact_row_id"),
    artifactId: text(row, "artifact_id"),
    artifactRevision: counter(row, "revision"),
    accessRevision: counter(row, "crypto_access_revision"),
    objectId,
    blobId,
    blobGeneration: counter(row, "blob_generation"),
    fingerprint,
    namespaceIds,
    lifecycleState: text(row, "crypto_lifecycle_state"),
  });
}

function receiptMatches(
  receipt: HumanArtifactExactAccessCryptoReceipt,
  plan: HumanArtifactExactAccessPlan,
): boolean {
  return receipt.operationId === plan.operationId
    && receipt.artifactId === plan.artifactId
    && receipt.objectId === plan.cryptoObjectId
    && receipt.artifactRevision === plan.artifactRevision
    && receipt.blobId === plan.blobId
    && receipt.blobGeneration === plan.blobGeneration
    && receipt.expectedAccessRevision === plan.expectedCryptoAccessRevision
    && receipt.resultAccessRevision === plan.nextCryptoAccessRevision
    && receipt.currentManifestHash.length === 32
    && receipt.resultManifestHash.length === 32
    && bytesEqual(receipt.targetRequiredNamespaceFingerprint,
      plan.targetRequiredNamespaceFingerprint)
    && exactIds(receipt.currentNamespaceIds, plan.currentNamespaceIds)
    && exactIds(receipt.targetNamespaceIds, plan.targetNamespaceIds);
}

function operationMatches(
  row: ConversationProductDatabaseRow,
  plan: HumanArtifactExactAccessPlan,
  requestDigest: Uint8Array,
): boolean {
  return text(row, "artifact_row_id") === plan.artifactRowId
    && text(row, "artifact_id") === plan.artifactId
    && text(row, "anchor_namespace_id") === plan.anchorNamespaceId
    && text(row, "operation_type") === "access"
    && counter(row, "expected_artifact_revision") === plan.artifactRevision
    && counter(row, "result_artifact_revision") === plan.artifactRevision
    && counter(row, "expected_access_revision")
      === plan.expectedCryptoAccessRevision
    && counter(row, "result_access_revision") === plan.nextCryptoAccessRevision
    && counter(row, "expected_blob_generation") === plan.blobGeneration
    && counter(row, "result_blob_generation") === plan.blobGeneration
    && text(row, "expected_blob_id") === plan.blobId
    && text(row, "result_blob_id") === plan.blobId
    && bytesEqual(digest(row, "request_digest"), requestDigest)
    && bytesEqual(digest(row, "expected_required_namespace_fingerprint"),
      plan.currentRequiredNamespaceFingerprint)
    && bytesEqual(digest(row, "target_required_namespace_fingerprint"),
      plan.targetRequiredNamespaceFingerprint);
}

const OPERATION_COLUMNS = `operation_id, artifact_row_id::text AS artifact_row_id,
  artifact_id, anchor_namespace_id::text AS anchor_namespace_id, operation_type,
  expected_artifact_revision, result_artifact_revision,
  expected_access_revision, result_access_revision,
  expected_blob_generation, result_blob_generation,
  expected_blob_id, result_blob_id, request_digest,
  expected_required_namespace_fingerprint,
  target_required_namespace_fingerprint, completion, disposition`;

export class PostgresHumanArtifactExactAccessProduct {
  readonly #handle: ConversationProductPostgresHandle;
  readonly #resolveCryptoAuthority: (input: Readonly<{
    authority: HumanArtifactExactAccessAuthority;
    change: HumanArtifactExactAccessChange;
  }>) => Promise<HumanArtifactExactAccessAuthorityFacts | null>;

  constructor(input: Readonly<{
    handle: ConversationProductPostgresHandle;
    resolveCryptoAuthority(input: Readonly<{
      authority: HumanArtifactExactAccessAuthority;
      change: HumanArtifactExactAccessChange;
    }>): Promise<HumanArtifactExactAccessAuthorityFacts | null>;
  }>) {
    assertVerifiedConversationProductPostgresHandle(input.handle);
    if (input.handle.role !== "nautilo") {
      throw new TypeError("Human Artifact exact access requires nautilo role");
    }
    this.#handle = input.handle;
    this.#resolveCryptoAuthority = input.resolveCryptoAuthority;
  }

  #transaction<Result>(
    authority: HumanArtifactExactAccessAuthority,
    callback: (tx: ConversationProductPostgresTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.#handle.transaction(async (tx) => {
      await assertIdentity(tx, authority);
      return callback(tx);
    }, { isolationLevel: "serializable" });
  }

  plan(input: Readonly<{
    authority: HumanArtifactExactAccessAuthority;
    operationId: string;
    artifactId: string;
    target: HumanArtifactExactAccessTarget;
  }>): Promise<HumanArtifactExactAccessPlanResult> {
    if (!PORTABLE_ID.test(input.operationId) || !UUID.test(input.artifactId)) {
      throw new TypeError("Human Artifact exact-access identifiers are invalid");
    }
    return this.#transaction(input.authority, async (tx) => {
      const product = await loadProduct(tx, input.artifactId);
      if (product.lifecycleState === "quarantined") {
        throw new Error("Human Artifact exact-access product is quarantined");
      }
      const targetIds = input.target.kind === "delete_authorized_view"
        ? targetAfterHumanArtifactAuthorizedViewDeletion({
            currentNamespaceIds: product.namespaceIds,
            readableNamespaceIds: input.authority.readableNamespaceIds,
          })
        : input.target.namespaceIds;
      const change = deriveHumanArtifactExactAccessChange({
        authority: input.authority,
        currentNamespaceIds: product.namespaceIds,
        proposedTargetNamespaceIds: targetIds,
      });
      if (change.status === "unchanged") return Object.freeze({
        status: "unchanged" as const,
        artifactId: input.artifactId,
        cryptoAccessRevision: product.accessRevision,
        requiredNamespaceIds: product.namespaceIds,
      });
      const facts = normalizeFacts(change, await this.#resolveCryptoAuthority({
        authority: input.authority,
        change,
      }));
      if (facts === null) return Object.freeze({
        status: "unavailable" as const,
        reason: "target_encryption_not_ready" as const,
      });
      return Object.freeze({
        ...change,
        ...facts,
        status: "prepared" as const,
        operationId: input.operationId,
        subjectHumanId: input.authority.subjectHumanId,
        anchorNamespaceId: change.currentNamespaceIds.find((id) =>
          input.authority.readableNamespaceIds.includes(id)
        )!,
        artifactRowId: product.artifactRowId,
        artifactId: product.artifactId,
        artifactRevision: product.artifactRevision,
        cryptoObjectId: product.objectId,
        expectedCryptoAccessRevision: product.accessRevision,
        nextCryptoAccessRevision: product.accessRevision + 1,
        blobId: product.blobId,
        blobGeneration: product.blobGeneration,
        currentRequiredNamespaceFingerprint: product.fingerprint,
        targetRequiredNamespaceFingerprint:
          fingerprintHumanArtifactExactAccessTarget(change.targetNamespaceIds),
      });
    });
  }

  lookupReplay(input: Readonly<{
    authority: HumanArtifactExactAccessAuthority;
    operationId: string;
    artifactId: string;
    signedRequestDigest: Uint8Array;
  }>): Promise<HumanArtifactExactAccessReplayLookup> {
    if (!PORTABLE_ID.test(input.operationId) || !UUID.test(input.artifactId)
      || input.signedRequestDigest.length !== 32) {
      return Promise.resolve(Object.freeze({ status: "conflict" as const }));
    }
    return this.#transaction(input.authority, async (tx) => {
      const row = oneOrNull(await executeTypedConversationProductQuery(
        tx,
        conversationProductTypedDb.select({
          operation_id: artifactCryptoOperations.operationId,
          artifact_id: artifactCryptoOperations.artifactId,
          operation_type: artifactCryptoOperations.operationType,
          anchor_namespace_id: artifactCryptoOperations.anchorNamespaceId,
          result_artifact_revision:
            artifactCryptoOperations.resultArtifactRevision,
          result_access_revision: artifactCryptoOperations.resultAccessRevision,
          request_digest: artifactCryptoOperations.requestDigest,
          target_required_namespace_fingerprint:
            artifactCryptoOperations.targetRequiredNamespaceFingerprint,
          completion: artifactCryptoOperations.completion,
          disposition: artifactCryptoOperations.disposition,
        }).from(artifactCryptoOperations)
          .where(eq(artifactCryptoOperations.operationId, input.operationId))
          .limit(2),
      ), "Human Artifact access replay");
      if (row === null) return Object.freeze({ status: "absent" as const });
      if (text(row, "artifact_id") !== input.artifactId
        || text(row, "operation_type") !== "access"
        || !bytesEqual(digest(row, "request_digest"), input.signedRequestDigest)
        || !input.authority.readableNamespaceIds.includes(
          text(row, "anchor_namespace_id"))) {
        return Object.freeze({ status: "conflict" as const });
      }
      const product = await loadProduct(tx, input.artifactId);
      if (text(row, "completion") !== "complete"
        || text(row, "disposition") !== "complete") {
        return Object.freeze({ status: "pending" as const,
          cryptoObjectId: product.objectId });
      }
      const resultAccess = counter(row, "result_access_revision");
      if (product.accessRevision !== resultAccess
        || product.artifactRevision !== counter(row, "result_artifact_revision")
        || !bytesEqual(product.fingerprint,
          digest(row, "target_required_namespace_fingerprint"))) {
        return Object.freeze({ status: "conflict" as const });
      }
      return Object.freeze({ status: "completed" as const,
        cryptoAccessRevision: resultAccess,
        requiredNamespaceIds: product.namespaceIds });
    });
  }

  reserve(input: Readonly<{
    authority: HumanArtifactExactAccessAuthority;
    plan: HumanArtifactExactAccessPlan;
    signedRequestDigest: Uint8Array;
  }>): Promise<"reserved" | "replayed"> {
    if (input.signedRequestDigest.length !== 32) {
      throw new TypeError("Human Artifact signed request digest is invalid");
    }
    return this.#transaction(input.authority, async (tx) => {
      const product = await loadProduct(tx, input.plan.artifactId);
      if (product.artifactRowId !== input.plan.artifactRowId
        || product.artifactRevision !== input.plan.artifactRevision
        || product.accessRevision !== input.plan.expectedCryptoAccessRevision
        || product.objectId !== input.plan.cryptoObjectId
        || product.blobId !== input.plan.blobId
        || product.blobGeneration !== input.plan.blobGeneration
        || !exactIds(product.namespaceIds, input.plan.currentNamespaceIds)
        || !bytesEqual(product.fingerprint,
          input.plan.currentRequiredNamespaceFingerprint)) {
        throw new Error("Human Artifact access reservation became stale");
      }
      const existing = oneOrNull(await tx.query(
        `SELECT ${OPERATION_COLUMNS} FROM artifact_crypto_operations
          WHERE operation_id = $1 LIMIT 2 FOR UPDATE`, [input.plan.operationId],
      ), "Human Artifact access operation");
      if (existing !== null) {
        if (!operationMatches(existing, input.plan, input.signedRequestDigest)) {
          throw new Error("Human Artifact access replay conflicts");
        }
        return "replayed" as const;
      }
      await executeTypedConversationProductQuery(
        tx,
        conversationProductTypedDb.insert(artifactCryptoOperations).values({
          operationId: input.plan.operationId,
          artifactRowId: input.plan.artifactRowId,
          artifactId: input.plan.artifactId,
          anchorNamespaceId: input.plan.anchorNamespaceId,
          operationType: "access",
          expectedArtifactRevision: input.plan.artifactRevision,
          resultArtifactRevision: input.plan.artifactRevision,
          expectedAccessRevision: input.plan.expectedCryptoAccessRevision,
          resultAccessRevision: input.plan.nextCryptoAccessRevision,
          expectedBlobGeneration: input.plan.blobGeneration,
          resultBlobGeneration: input.plan.blobGeneration,
          expectedBlobId: input.plan.blobId,
          resultBlobId: input.plan.blobId,
          requestDigest: input.signedRequestDigest,
          expectedRequiredNamespaceFingerprint:
            input.plan.currentRequiredNamespaceFingerprint,
          targetRequiredNamespaceFingerprint:
            input.plan.targetRequiredNamespaceFingerprint,
        }),
      );
      return "reserved" as const;
    });
  }

  commit(input: Readonly<{
    authority: HumanArtifactExactAccessAuthority;
    plan: HumanArtifactExactAccessPlan;
    receipt: HumanArtifactExactAccessCryptoReceipt;
  }>): Promise<HumanArtifactExactAccessCommitResult> {
    if (!receiptMatches(input.receipt, input.plan)) {
      throw new TypeError("Human Artifact access crypto receipt was substituted");
    }
    return this.#transaction(input.authority, async (tx) => {
      const operation = oneOrNull(await tx.query(
        `SELECT ${OPERATION_COLUMNS} FROM artifact_crypto_operations
          WHERE operation_id = $1 LIMIT 2 FOR UPDATE`, [input.plan.operationId],
      ), "Human Artifact access operation");
      if (operation === null
        || !operationMatches(operation, input.plan, input.receipt.requestDigest)) {
        throw new Error("Human Artifact access reservation conflicts");
      }
      const product = await loadProduct(tx, input.plan.artifactId);
      if (text(operation, "completion") === "complete"
        && text(operation, "disposition") === "complete"
        && product.accessRevision === input.plan.nextCryptoAccessRevision
        && exactIds(product.namespaceIds, input.plan.targetNamespaceIds)
        && bytesEqual(product.fingerprint,
          input.plan.targetRequiredNamespaceFingerprint)) {
        return Object.freeze({ status: "replayed" as const,
          operationId: input.plan.operationId, artifactId: input.plan.artifactId,
          cryptoAccessRevision: input.plan.nextCryptoAccessRevision,
          requiredNamespaceIds: input.plan.targetNamespaceIds });
      }
      if (product.artifactRevision !== input.plan.artifactRevision
        || product.accessRevision !== input.plan.expectedCryptoAccessRevision
        || product.objectId !== input.plan.cryptoObjectId
        || product.blobId !== input.plan.blobId
        || product.blobGeneration !== input.plan.blobGeneration
        || !exactIds(product.namespaceIds, input.plan.currentNamespaceIds)
        || !bytesEqual(product.fingerprint,
          input.plan.currentRequiredNamespaceFingerprint)) {
        throw new Error("Human Artifact access product became stale");
      }
      const change = deriveHumanArtifactExactAccessChange({ authority: input.authority,
        currentNamespaceIds: product.namespaceIds,
        proposedTargetNamespaceIds: input.plan.targetNamespaceIds });
      const facts = normalizeFacts(change, await this.#resolveCryptoAuthority({
        authority: input.authority, change,
      }));
      if (facts === null
        || !exactBindings(facts.currentBindings, input.plan.currentBindings)
        || !exactBindings(facts.targetBindings, input.plan.targetBindings)) {
        throw new Error("Human Artifact access authority became stale");
      }
      for (const namespaceId of input.plan.removedNamespaceIds) {
        const rows = await executeTypedConversationProductQuery(
          tx,
          conversationProductTypedDb.delete(artifactNamespaces)
            .where(and(
              eq(artifactNamespaces.artifactId, input.plan.artifactRowId),
              eq(artifactNamespaces.namespaceId, namespaceId),
            ))
            .returning({ namespace_id: artifactNamespaces.namespaceId }),
        );
        if (rows.length !== 1 || rows[0]?.["namespace_id"] !== namespaceId) {
          throw new Error("Human Artifact access removal lost its CAS");
        }
      }
      for (const namespaceId of input.plan.addedNamespaceIds) {
        const rows = await executeTypedConversationProductQuery(
          tx,
          conversationProductTypedDb.insert(artifactNamespaces).values({
            artifactId: input.plan.artifactRowId,
            namespaceId,
          }).returning({ namespace_id: artifactNamespaces.namespaceId }),
        );
        if (rows.length !== 1 || rows[0]?.["namespace_id"] !== namespaceId) {
          throw new Error("Human Artifact access addition lost its CAS");
        }
      }
      const mapped = await executeTypedConversationProductQuery(
        tx,
        conversationProductTypedDb.update(artifacts).set({
          cryptoAccessRevision: input.plan.nextCryptoAccessRevision,
          cryptoRequiredNamespaceFingerprint:
            input.plan.targetRequiredNamespaceFingerprint,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        }).where(and(
          eq(artifacts.id, input.plan.artifactRowId),
          eq(artifacts.artifactId, input.plan.artifactId),
          eq(artifacts.revision, input.plan.artifactRevision),
          eq(
            artifacts.cryptoAccessRevision,
            input.plan.expectedCryptoAccessRevision,
          ),
          eq(artifacts.cryptoObjectId, input.plan.cryptoObjectId),
          eq(artifacts.blobId, input.plan.blobId),
          eq(artifacts.blobGeneration, input.plan.blobGeneration),
          sql`${artifacts.cryptoRequiredNamespaceFingerprint} = ${
            input.plan.currentRequiredNamespaceFingerprint
          }`,
        )).returning({ artifact_id: artifacts.artifactId }),
      );
      if (mapped.length !== 1 || mapped[0]?.["artifact_id"] !== input.plan.artifactId) {
        throw new Error("Human Artifact access mapping lost its CAS");
      }
      const complete = await executeTypedConversationProductQuery(
        tx,
        conversationProductTypedDb.update(artifactCryptoOperations).set({
          completion: "complete",
          disposition: "complete",
          cryptoCompletedAt:
            sql`COALESCE(${artifactCryptoOperations.cryptoCompletedAt}, CURRENT_TIMESTAMP)`,
          nextAttemptAt: null,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        }).where(and(
          eq(artifactCryptoOperations.operationId, input.plan.operationId),
          eq(artifactCryptoOperations.completion, "pending"),
          eq(artifactCryptoOperations.disposition, "active"),
        )).returning({ operation_id: artifactCryptoOperations.operationId }),
      );
      if (complete.length !== 1) {
        throw new Error("Human Artifact access completion lost its CAS");
      }
      return Object.freeze({ status: "updated" as const,
        operationId: input.plan.operationId, artifactId: input.plan.artifactId,
        cryptoAccessRevision: input.plan.nextCryptoAccessRevision,
        requiredNamespaceIds: input.plan.targetNamespaceIds });
    });
  }

  async reconcile(input: Readonly<{
    authority: HumanArtifactExactAccessAuthority;
    operationId: string;
    artifactId: string;
    crypto: HumanArtifactExactAccessCryptoObservation;
  }>): Promise<HumanArtifactExactAccessReconcileResult> {
    if (input.crypto.status !== "current" && input.crypto.status !== "target") {
      return Object.freeze({ status: "quarantined" });
    }
    const crypto = input.crypto;
    const recovered = await this.#transaction(input.authority, async (tx) => {
      const operation = oneOrNull(await tx.query(
        `SELECT ${OPERATION_COLUMNS} FROM artifact_crypto_operations
          WHERE operation_id=$1 LIMIT 2 FOR UPDATE`, [input.operationId],
      ), "Human Artifact access reconciliation");
      if (operation === null || text(operation, "artifact_id") !== input.artifactId
        || text(operation, "operation_type") !== "access") {
        return { status: "quarantined" as const };
      }
      const product = await loadProduct(tx, input.artifactId);
      if (crypto.objectId !== product.objectId) {
        return { status: "quarantined" as const };
      }
      const expected = counter(operation, "expected_access_revision");
      const next = counter(operation, "result_access_revision");
      if (text(operation, "completion") === "complete"
        && text(operation, "disposition") === "complete") {
        return product.accessRevision === next && crypto.status === "target"
          && exactIds(product.namespaceIds, crypto.namespaceIds)
          ? { status: "completed" as const, cryptoAccessRevision: next,
              requiredNamespaceIds: product.namespaceIds }
          : { status: "quarantined" as const };
      }
      if (product.accessRevision !== expected) return { status: "stale" as const };
      if (crypto.status === "current") {
        return crypto.accessRevision === expected
          ? { status: "pending" as const }
          : { status: "quarantined" as const };
      }
      if (crypto.accessRevision !== next
        || !bytesEqual(fingerprintHumanArtifactExactAccessTarget(
          crypto.namespaceIds),
        digest(operation, "target_required_namespace_fingerprint"))) {
        return { status: "quarantined" as const };
      }
      const change = deriveHumanArtifactExactAccessChange({ authority: input.authority,
        currentNamespaceIds: product.namespaceIds,
        proposedTargetNamespaceIds: crypto.namespaceIds });
      const facts = normalizeFacts(change, await this.#resolveCryptoAuthority({
        authority: input.authority, change,
      }));
      if (facts === null) return { status: "denied" as const };
      const plan: HumanArtifactExactAccessPlan = Object.freeze({
        ...change, ...facts, status: "prepared", operationId: input.operationId,
        subjectHumanId: input.authority.subjectHumanId,
        anchorNamespaceId: text(operation, "anchor_namespace_id"),
        artifactRowId: product.artifactRowId, artifactId: product.artifactId,
        artifactRevision: counter(operation, "expected_artifact_revision"),
        cryptoObjectId: product.objectId, expectedCryptoAccessRevision: expected,
        nextCryptoAccessRevision: next, blobId: product.blobId,
        blobGeneration: product.blobGeneration,
        currentRequiredNamespaceFingerprint: product.fingerprint,
        targetRequiredNamespaceFingerprint:
          digest(operation, "target_required_namespace_fingerprint"),
      });
      const requestDigest = digest(operation, "request_digest");
      if (!operationMatches(operation, plan, requestDigest)) {
        return { status: "quarantined" as const };
      }
      return { status: "recoverable" as const, plan,
        receipt: Object.freeze({
          operationId: input.operationId, artifactId: input.artifactId,
          objectId: product.objectId, artifactRevision: product.artifactRevision,
          blobId: product.blobId, blobGeneration: product.blobGeneration,
          expectedAccessRevision: expected, resultAccessRevision: next,
          currentManifestHash: crypto.previousManifestHash.slice(),
          resultManifestHash: crypto.manifestHash.slice(),
          targetRequiredNamespaceFingerprint:
            digest(operation, "target_required_namespace_fingerprint"),
          requestDigest, currentNamespaceIds: product.namespaceIds,
          targetNamespaceIds: crypto.namespaceIds, status: "duplicate" as const,
        }) };
    });
    if (recovered.status !== "recoverable") return Object.freeze(recovered);
    const committed = await this.commit({ authority: input.authority,
      plan: recovered.plan, receipt: recovered.receipt });
    return Object.freeze({ status: "completed" as const,
      cryptoAccessRevision: committed.cryptoAccessRevision,
      requiredNamespaceIds: committed.requiredNamespaceIds });
  }
}
