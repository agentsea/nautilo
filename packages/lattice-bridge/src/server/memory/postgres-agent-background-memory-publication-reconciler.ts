import { createHash } from "node:crypto";

import {
  decodeBackgroundAgentWorkDescriptorV2,
  type BackgroundAgentWorkDescriptorV2,
} from "@nautilo/lattice-crypto/wire";
import {
  and,
  eq,
  memories,
  memoryCryptoRevisions,
  sql,
} from "@nautilo/db";

import type {
  AgentMemoryEmbedding,
} from "../../memory/active-memory-composition.ts";
import type {
  ProtectedMemoryAuthority,
} from "../../memory/active-memory-repository.ts";
import {
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
} from "../../memory/memory-repository.ts";
import {
  assertVerifiedConversationProductPostgresHandle,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresHandle,
  type ConversationProductPostgresTransaction,
} from "../message/postgres-conversation-product-store.ts";
import {
  backgroundMemoryOutputRequestDigest,
  backgroundMemoryTierRequestDigest,
} from "./background-memory-product-digest.ts";

export type ProtectedAgentBackgroundMemoryPublicationReconciliationOutcome =
  | "completed"
  | "pending"
  | "stale"
  | "not_started";

export type ProtectedAgentBackgroundMemoryPublicationRecord = Readonly<{
  descriptorBytes: Uint8Array | null;
  snapshot: Readonly<{
    acceptedResponse?: Readonly<{ issuingHumanId: string }> | null;
  }>;
}>;

const MAX_OPERATIONS = 256;

function oneOrNull(
  rows: readonly ConversationProductDatabaseRow[],
  label: string,
): ConversationProductDatabaseRow | null {
  if (rows.length > 1) throw new Error(`${label} is not unique`);
  return rows[0] ?? null;
}

function text(row: ConversationProductDatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError(`${field} is not text`);
  return value;
}

function integer(row: ConversationProductDatabaseRow, field: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${field} is not an integer`);
  }
  return value;
}

function numeric(row: ConversationProductDatabaseRow, field: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${field} is not numeric`);
  }
  return value;
}

function bytes(row: ConversationProductDatabaseRow, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array)) throw new TypeError(`${field} is not binary`);
  return value;
}

function dateMs(row: ConversationProductDatabaseRow, field: string): number {
  const value = row[field];
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${field} is not a timestamp`);
  }
  return value.getTime();
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function parseEmbedding(row: ConversationProductDatabaseRow): AgentMemoryEmbedding {
  const encoded = text(row, "embedding");
  let vector: unknown;
  try {
    vector = JSON.parse(encoded);
  } catch {
    throw new TypeError("embedding is not a JSON vector");
  }
  if (
    !Array.isArray(vector)
    || vector.length !== 1536
    || vector.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
    || integer(row, "embedding_dimensions") !== 1536
  ) throw new TypeError("embedding coordinates are invalid");
  const numericVector = (vector as unknown[]).map((entry) => entry as number);
  return Object.freeze({
    vector: Object.freeze(numericVector),
    provider: text(row, "embedding_provider"),
    canonicalModel: text(row, "embedding_model"),
    dimensions: 1536,
    contractVersion: integer(row, "embedding_contract_version"),
  });
}

function authority(
  descriptor: BackgroundAgentWorkDescriptorV2,
  subjectUserId: string,
): ProtectedMemoryAuthority | null {
  if (
    descriptor.source.kind !== "protected_memory_work"
    || descriptor.subject.kind !== "agent"
  ) return null;
  const source = descriptor.source;
  if (source.productAuthority.mode === "scope") {
    return Object.freeze({
      mode: "scope" as const,
      subjectUserId,
      agentId: descriptor.subject.agentId,
      scopeId: source.productAuthority.scopeId,
      originWritableNamespaceId:
        source.productAuthority.originWritableNamespaceId,
    });
  }
  const writableNamespaceIds = [...new Set(
    descriptor.outputSlots.flatMap((slot) => slot.namespaceIds),
  )].sort();
  return Object.freeze({
    mode: "namespace" as const,
    subjectUserId,
    agentId: descriptor.subject.agentId,
    readableNamespaceIds: Object.freeze(
      descriptor.namespaceRequirements
        .filter((entry) => entry.operations.includes("decrypt"))
        .map((entry) => entry.namespaceId),
    ),
    mutableNamespaceIds: Object.freeze(
      descriptor.namespaceRequirements
        .filter((entry) => entry.operations.includes("encrypt"))
        .map((entry) => entry.namespaceId),
    ),
    writableNamespaceId: writableNamespaceIds.length === 1
      ? writableNamespaceIds[0]!
      : null,
  });
}

/**
 * Product-role restart reconciliation for signed background Memory outputs.
 * Missing signed slots are unused inventory. Every durable operation that
 * does exist must re-bind to the descriptor through its exact request digest;
 * an advanced/superseded content row fails closed as stale because its old
 * embedding preimage is intentionally not retained elsewhere.
 */
export class PostgresAgentBackgroundMemoryPublicationReconciler {
  constructor(private readonly handle: ConversationProductPostgresHandle) {
    assertVerifiedConversationProductPostgresHandle(handle);
    if (handle.role !== "nautilo_agent") {
      throw new TypeError(
        "Agent background Memory reconciliation requires a direct nautilo_agent handle",
      );
    }
  }

  async reconcilePublication(
    record: ProtectedAgentBackgroundMemoryPublicationRecord,
  ): Promise<ProtectedAgentBackgroundMemoryPublicationReconciliationOutcome> {
    const issuingHumanId = record.snapshot.acceptedResponse?.issuingHumanId;
    if (
      record.descriptorBytes === null
      || typeof issuingHumanId !== "string"
      || issuingHumanId.length < 1
    ) return "stale";
    let descriptor: BackgroundAgentWorkDescriptorV2;
    try {
      descriptor = decodeBackgroundAgentWorkDescriptorV2(record.descriptorBytes);
    } catch {
      return "stale";
    }
    const source = descriptor.source;
    const productAuthority = authority(descriptor, issuingHumanId);
    if (source.kind !== "protected_memory_work" || productAuthority === null) {
      return "stale";
    }
    const contentByOperationId = new Map(source.outputRevisions.map(
      (revision, index) => [revision.publicationIdempotencyId, {
        revision,
        slot: descriptor.outputSlots[index]!,
      }] as const,
    ));
    const tierByOperationId = new Map(source.tierMutations.map((mutation) =>
      [mutation.operationIdempotencyId, mutation] as const
    ));
    const operationIds = [
      ...contentByOperationId.keys(),
      ...tierByOperationId.keys(),
    ];
    if (
      operationIds.length > MAX_OPERATIONS
      || new Set(operationIds).size !== operationIds.length
    ) return "stale";
    if (operationIds.length === 0) return "completed";
    const descriptorHash = createHash("sha256")
      .update(record.descriptorBytes)
      .digest();
    return this.handle.transaction(async (transaction) => {
      if (!await this.#identityMatches(transaction, productAuthority)) {
        return "stale";
      }
      const rows = await transaction.query(
        `SELECT operation_id, memory_id, operation_type,
                expected_content_revision, result_content_revision,
                expected_access_revision, request_digest, completion,
                disposition, created_at
           FROM memory_crypto_operations
          WHERE operation_id IN (
            SELECT jsonb_array_elements_text($1::jsonb)
          )
          ORDER BY operation_id
          LIMIT 257`,
        [JSON.stringify(operationIds)],
      );
      if (rows.length === 0) return "not_started";
      if (rows.length > operationIds.length) return "stale";
      const seen = new Set<string>();
      let pending = false;
      for (const row of rows) {
        const operationId = text(row, "operation_id");
        if (seen.has(operationId)) return "stale";
        seen.add(operationId);
        const content = contentByOperationId.get(operationId);
        const tier = tierByOperationId.get(operationId);
        if ((content === undefined) === (tier === undefined)) return "stale";
        const valid = content === undefined
          ? this.#tierRowMatches(
            row,
            tier!,
            descriptorHash,
            productAuthority,
          )
          : await this.#contentRowMatches(
            transaction,
            row,
            content,
            descriptorHash,
            productAuthority,
          );
        if (!valid || text(row, "disposition") === "quarantined") {
          return "stale";
        }
        if (text(row, "completion") !== "complete") pending = true;
      }
      return pending ? "pending" : "completed";
    }, { isolationLevel: "serializable" });
  }

  async #identityMatches(
    transaction: ConversationProductPostgresTransaction,
    expected: ProtectedMemoryAuthority,
  ): Promise<boolean> {
    const row = oneOrNull(await executeTypedConversationProductQuery(
      transaction,
      conversationProductTypedDb.select({
        current_user_id: sql<string>`app_current_user_id()::text`.as("current_user_id"),
        current_agent_id: sql<string | null>`app_current_agent_id()::text`.as("current_agent_id"),
      }).from(sql`(values (1)) as identity_probe`).limit(2),
    ), "Agent background Memory reconciliation identity");
    return row !== null
      && text(row, "current_user_id") === expected.subjectUserId
      && text(row, "current_agent_id") === expected.agentId;
  }

  #tierRowMatches(
    row: ConversationProductDatabaseRow,
    tier: Extract<
      BackgroundAgentWorkDescriptorV2["source"],
      { kind: "protected_memory_work" }
    >["tierMutations"][number],
    descriptorHash: Uint8Array,
    productAuthority: ProtectedMemoryAuthority,
  ): boolean {
    const expectedDigest = backgroundMemoryTierRequestDigest({
      ...tier,
      descriptorHash,
      authority: productAuthority,
      cryptoObjectId: tier.objectId,
    });
    return text(row, "operation_type") === "metadata"
      && text(row, "memory_id") === tier.memoryId
      && integer(row, "expected_content_revision") === tier.contentRevision
      && integer(row, "expected_access_revision") === tier.cryptoAccessRevision
      && sameBytes(bytes(row, "request_digest"), expectedDigest);
  }

  async #contentRowMatches(
    transaction: ConversationProductPostgresTransaction,
    row: ConversationProductDatabaseRow,
    content: Readonly<{
      revision: Extract<BackgroundAgentWorkDescriptorV2["source"], { kind: "protected_memory_work" }>["outputRevisions"][number];
      slot: BackgroundAgentWorkDescriptorV2["outputSlots"][number];
    }>,
    descriptorHash: Uint8Array,
    productAuthority: ProtectedMemoryAuthority,
  ): Promise<boolean> {
    const revision = content.revision;
    if (
      text(row, "operation_type") !== "update"
      || text(row, "memory_id") !== revision.memoryId
      || integer(row, "expected_content_revision")
        !== revision.expectedContentRevision
      || integer(row, "result_content_revision") !== revision.nextContentRevision
      || integer(row, "expected_access_revision")
        !== revision.expectedCryptoAccessRevision
      || dateMs(row, "created_at") !== content.slot.createdAt
      || revision.objectId !== deriveMemoryCryptoObjectIdV1({
        memoryId: revision.memoryId,
        contentRevision: revision.nextContentRevision,
      })
    ) return false;
    const product = oneOrNull(await executeTypedConversationProductQuery(
      transaction,
      conversationProductTypedDb.select({
        memory_id: sql`${memories.id}`.as("memory_id"),
        content_revision: memories.contentRevision,
        crypto_access_revision: memories.cryptoAccessRevision,
        crypto_object_id: memories.cryptoObjectId,
        crypto_required_namespace_fingerprint:
          memories.cryptoRequiredNamespaceFingerprint,
        importance: memories.importance,
        embedding: sql<string>`${memories.embedding}::text`.as("embedding"),
        embedding_revision: memories.embeddingRevision,
        embedding_provider: memories.embeddingProvider,
        embedding_model: memories.embeddingModel,
        embedding_dimensions: memories.embeddingDimensions,
        embedding_contract_version: memories.embeddingContractVersion,
        allocated_object_id: sql`${memoryCryptoRevisions.cryptoObjectId}`
          .as("allocated_object_id"),
        required_namespace_fingerprint:
          memoryCryptoRevisions.requiredNamespaceFingerprint,
        allocation_request_digest: memoryCryptoRevisions.allocationRequestDigest,
      }).from(memories).innerJoin(memoryCryptoRevisions, and(
        eq(memoryCryptoRevisions.memoryId, memories.id),
        eq(memoryCryptoRevisions.contentRevision, revision.nextContentRevision),
      )).where(eq(memories.id, revision.memoryId)).limit(2),
    ), "Agent background Memory reconciliation product");
    if (product === null) return false;
    const exactFingerprint = fingerprintRequiredMemoryNamespaces(
      content.slot.namespaceIds,
    );
    if (
      text(product, "memory_id") !== revision.memoryId
      || integer(product, "content_revision") !== revision.nextContentRevision
      || integer(product, "embedding_revision") !== revision.nextContentRevision
      || text(product, "crypto_object_id") !== revision.objectId
      || text(product, "allocated_object_id") !== revision.objectId
      || !sameBytes(
        bytes(product, "crypto_required_namespace_fingerprint"),
        exactFingerprint,
      )
      || !sameBytes(
        bytes(product, "required_namespace_fingerprint"),
        exactFingerprint,
      )
      || !sameBytes(
        bytes(product, "allocation_request_digest"),
        bytes(row, "request_digest"),
      )
    ) return false;
    const expectedDigest = backgroundMemoryOutputRequestDigest({
      publicationIdempotencyId: revision.publicationIdempotencyId,
      action: revision.action,
      descriptorHash,
      authority: productAuthority,
      memoryId: revision.memoryId,
      expectedContentRevision: revision.expectedContentRevision,
      expectedCryptoAccessRevision: revision.expectedCryptoAccessRevision,
      nextContentRevision: revision.nextContentRevision,
      cryptoObjectId: revision.objectId,
      requiredNamespaceIds: content.slot.namespaceIds,
      createdAt: content.slot.createdAt,
      embedding: parseEmbedding(product),
      importance: numeric(product, "importance"),
    });
    return sameBytes(bytes(row, "request_digest"), expectedDigest);
  }
}
