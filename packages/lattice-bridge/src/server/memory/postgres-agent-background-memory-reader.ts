import type {
  ProtectedAgentBackgroundMemoryRevisionReader,
  ProtectedAgentBackgroundMemoryRevisionReference,
  VerifiedAgentBackgroundMemoryRevisionContent,
} from "../../memory/agent-background-revision-reader.ts";
import type {
  VerifiedAgentMemoryCryptoRevisionContent,
  VerifiedAgentMemoryCryptoRevisionReader,
} from "../../memory/agent-memory-session-content.ts";
import {
  and,
  asc,
  eq,
  memories,
  memoryCryptoRevisions,
  memoryNamespaces,
  memoryScopes,
  sql,
} from "@nautilo/db";
import {
  fingerprintRequiredMemoryNamespaces,
  type MemoryCryptoRevisionReference,
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

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PORTABLE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

type ProductSnapshot = Readonly<{
  reference: MemoryCryptoRevisionReference;
  selectedNamespaceId: string;
  cryptoAccessRevision: number;
  accessKind: "namespace" | "scope_seed" | "scope_origin";
  importance: number;
  tier: 1 | 2 | 3;
  createdAt: number;
  embedding: VerifiedAgentBackgroundMemoryRevisionContent["embedding"];
}>;

function oneOrNull(
  rows: readonly ConversationProductDatabaseRow[],
  label: string,
): ConversationProductDatabaseRow | null {
  if (rows.length > 1) throw new Error(`${label} returned duplicate rows`);
  return rows[0] ?? null;
}

function text(row: ConversationProductDatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new TypeError(`${name} is not text`);
  return value;
}

function nullableText(
  row: ConversationProductDatabaseRow,
  name: string,
): string | null {
  const value = row[name];
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${name} is not text`);
  return value;
}

function integer(row: ConversationProductDatabaseRow, name: string): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${name} is not an integer`);
  }
  return value;
}

function finiteNumber(
  row: ConversationProductDatabaseRow,
  name: string,
): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} is not numeric`);
  }
  return value;
}

function timestamp(row: ConversationProductDatabaseRow, name: string): number {
  const value = row[name];
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${name} is not a timestamp`);
  }
  return value.getTime();
}

function productEmbedding(row: ConversationProductDatabaseRow) {
  let vector: unknown;
  try {
    vector = JSON.parse(text(row, "embedding"));
  } catch {
    throw new TypeError("embedding is not a vector");
  }
  if (
    !Array.isArray(vector)
    || vector.length !== 1536
    || vector.some((entry) =>
      typeof entry !== "number" || !Number.isFinite(entry)
    )
    || integer(row, "embedding_revision") !== integer(row, "content_revision")
    || integer(row, "embedding_dimensions") !== 1536
    || integer(row, "embedding_contract_version") !== 1
  ) throw new TypeError("embedding provenance is invalid");
  return Object.freeze({
    vector: Object.freeze(vector as number[]),
    provider: text(row, "embedding_provider"),
    canonicalModel: text(row, "embedding_model"),
    dimensions: 1536 as const,
    contractVersion: 1,
  });
}

function bytes(row: ConversationProductDatabaseRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) throw new TypeError(`${name} is not binary`);
  return Uint8Array.from(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function equalEmbedding(
  left: VerifiedAgentBackgroundMemoryRevisionContent["embedding"],
  right: VerifiedAgentBackgroundMemoryRevisionContent["embedding"],
): boolean {
  return left.provider === right.provider
    && left.canonicalModel === right.canonicalModel
    && left.dimensions === right.dimensions
    && left.contractVersion === right.contractVersion
    && left.vector.length === right.vector.length
    && left.vector.every((entry, index) => entry === right.vector[index]);
}

function validReference(
  reference: ProtectedAgentBackgroundMemoryRevisionReference,
): boolean {
  return UUID.test(reference.subjectUserId)
    && UUID.test(reference.agentId)
    && UUID.test(reference.memoryId)
    && Number.isSafeInteger(reference.contentRevision)
    && reference.contentRevision > 0
    && Number.isSafeInteger(reference.cryptoAccessRevision)
    && reference.cryptoAccessRevision >= 0
    && PORTABLE.test(reference.objectId)
    && UUID.test(reference.selectedNamespaceId)
    && (reference.productAuthority.mode === "namespace"
      ? reference.accessKind === "namespace"
      : UUID.test(reference.productAuthority.scopeId)
        && UUID.test(reference.productAuthority.originWritableNamespaceId)
        && reference.accessKind !== "namespace");
}

function wipe(content: VerifiedAgentMemoryCryptoRevisionContent | null): void {
  content?.payloadBytes.fill(0);
  content?.accessManifestBytes.fill(0);
  content?.accessManifestHash.fill(0);
  content?.accessManifestSignerPublicKey.fill(0);
  content?.namespaceEnvelopes.forEach((entry) => entry.envelopeBytes.fill(0));
}

function exactContent(
  content: VerifiedAgentMemoryCryptoRevisionContent,
  snapshot: ProductSnapshot,
): boolean {
  const required = snapshot.reference.expectedActiveNamespaceFingerprint;
  const envelopeIds = content.namespaceEnvelopes
    .map((entry) => entry.namespaceId)
    .sort();
    return content.memoryId === snapshot.reference.memoryId
    && content.contentRevision === snapshot.reference.contentRevision
    && content.objectId === snapshot.reference.objectId
    && content.accessRevision === snapshot.cryptoAccessRevision
    && content.accessManifestBytes instanceof Uint8Array
    && content.accessManifestHash instanceof Uint8Array
    && content.accessManifestHash.length === 32
    && content.accessManifestSignerPublicKey instanceof Uint8Array
    && content.payloadBytes instanceof Uint8Array
    && content.namespaceEnvelopes.every((entry) =>
      entry.envelopeBytes instanceof Uint8Array
    )
    && equalStrings(envelopeIds, content.requiredNamespaceIds)
    && new Set(envelopeIds).size === envelopeIds.length
    && content.requiredNamespaceIds.includes(snapshot.selectedNamespaceId)
    && equalBytes(
      fingerprintRequiredMemoryNamespaces(content.requiredNamespaceIds),
      required,
    );
}

export class PostgresAgentBackgroundMemoryRevisionReader
  implements ProtectedAgentBackgroundMemoryRevisionReader {
  readonly #handle: ConversationProductPostgresHandle;
  readonly #cryptoReader: VerifiedAgentMemoryCryptoRevisionReader;

  constructor(input: Readonly<{
    handle: ConversationProductPostgresHandle;
    cryptoReader: VerifiedAgentMemoryCryptoRevisionReader;
  }>) {
    assertVerifiedConversationProductPostgresHandle(input.handle);
    if (input.handle.role !== "nautilo_agent") {
      throw new TypeError(
        "Background Memory reader requires a direct nautilo_agent handle",
      );
    }
    this.#handle = input.handle;
    this.#cryptoReader = input.cryptoReader;
  }

  async #transaction<Value>(
    reference: ProtectedAgentBackgroundMemoryRevisionReference,
    execute: (
      transaction: ConversationProductPostgresTransaction,
    ) => Promise<Value>,
  ): Promise<Value> {
    return this.#handle.transaction(async (transaction) => {
      const identity = oneOrNull(await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({
          current_user_id: sql<string>`app_current_user_id()::text`.as("current_user_id"),
          current_agent_id: sql<string | null>`app_current_agent_id()::text`.as("current_agent_id"),
        }).from(sql`(values (1)) as identity_probe`).limit(2),
      ), "Background Memory identity");
      if (
        identity === null
        || nullableText(identity, "current_user_id") !== reference.subjectUserId
        || nullableText(identity, "current_agent_id") !== reference.agentId
      ) throw new Error("Background Memory product authority changed");
      return execute(transaction);
    }, { isolationLevel: "serializable" });
  }

  async #snapshot(
    reference: ProtectedAgentBackgroundMemoryRevisionReference,
  ): Promise<ProductSnapshot | null> {
    return this.#transaction(reference, async (transaction) => {
      const product = oneOrNull(await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({
          memory_id: sql`${memories.id}`.as("memory_id"),
          content_revision: memories.contentRevision,
          crypto_access_revision: memories.cryptoAccessRevision,
          importance: memories.importance,
          tier: memories.tier,
          created_at: memories.createdAt,
          embedding: sql<string>`${memories.embedding}::text`
            .as("embedding"),
          embedding_revision: memories.embeddingRevision,
          embedding_provider: memories.embeddingProvider,
          embedding_model: memories.embeddingModel,
          embedding_dimensions: memories.embeddingDimensions,
          embedding_contract_version: memories.embeddingContractVersion,
          crypto_object_id: memories.cryptoObjectId,
          crypto_required_namespace_fingerprint:
            memories.cryptoRequiredNamespaceFingerprint,
          scope_origin_namespace_id: memories.scopeOriginNamespaceId,
          lifecycle_object_id: sql`${memoryCryptoRevisions.cryptoObjectId}`
            .as("lifecycle_object_id"),
          required_namespace_fingerprint:
            memoryCryptoRevisions.requiredNamespaceFingerprint,
          completion: memoryCryptoRevisions.completion,
          disposition: memoryCryptoRevisions.disposition,
        }).from(memories).innerJoin(
          memoryCryptoRevisions,
          and(
            eq(memoryCryptoRevisions.memoryId, memories.id),
            eq(
              memoryCryptoRevisions.contentRevision,
              memories.contentRevision,
            ),
          ),
        ).where(and(
          eq(memories.id, reference.memoryId),
          eq(memories.contentRevision, reference.contentRevision),
        )).limit(2),
      ), "Background Memory product snapshot");
      if (product === null) return null;
      const [namespaceRows, scopeRows] = await Promise.all([
        executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb.select({
            namespace_id: memoryNamespaces.namespaceId,
          }).from(memoryNamespaces).where(eq(
            memoryNamespaces.memoryId,
            reference.memoryId,
          )).orderBy(asc(memoryNamespaces.namespaceId)),
        ),
        executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb.select({
            scope_id: memoryScopes.scopeId,
            origin: memoryScopes.origin,
          }).from(memoryScopes).where(eq(
            memoryScopes.memoryId,
            reference.memoryId,
          )).orderBy(asc(memoryScopes.scopeId)),
        ),
      ]);
      const requiredNamespaceIds = resolveRequiredMemoryNamespaceIds({
        namespaceIds: namespaceRows.map((row) => text(row, "namespace_id")),
        scopeOrigins: scopeRows.map((row) => {
          const origin = text(row, "origin");
          if (origin !== "seed" && origin !== "scope") {
            throw new TypeError("Background Memory scope origin is invalid");
          }
          return origin;
        }),
        originWritableNamespaceId: nullableText(
          product,
          "scope_origin_namespace_id",
        ),
      });
      const fingerprint = fingerprintRequiredMemoryNamespaces(
        requiredNamespaceIds,
      );
      const namespaceIds = namespaceRows.map((row) =>
        text(row, "namespace_id")
      );
      const scopeAuthority = reference.productAuthority.mode === "scope"
        ? reference.productAuthority
        : null;
      const exactScope = scopeAuthority !== null
        ? scopeRows.filter((row) =>
          text(row, "scope_id") === scopeAuthority.scopeId
        )
        : [];
      let accessMatches = false;
      if (reference.productAuthority.mode === "namespace") {
        accessMatches = reference.accessKind === "namespace"
          && namespaceIds.includes(reference.selectedNamespaceId);
      } else if (scopeAuthority !== null && exactScope.length === 1) {
        const origin = text(exactScope[0]!, "origin");
        accessMatches = reference.accessKind === "scope_seed"
          ? origin === "seed"
            && namespaceIds.includes(reference.selectedNamespaceId)
          : reference.accessKind === "scope_origin"
            && origin === "scope"
            && nullableText(product, "scope_origin_namespace_id")
              === scopeAuthority.originWritableNamespaceId
            && reference.selectedNamespaceId
              === scopeAuthority.originWritableNamespaceId;
      }
      if (
        text(product, "memory_id") !== reference.memoryId
        || integer(product, "content_revision") !== reference.contentRevision
        || integer(product, "crypto_access_revision")
          !== reference.cryptoAccessRevision
        || nullableText(product, "crypto_object_id") !== reference.objectId
        || text(product, "lifecycle_object_id") !== reference.objectId
        || text(product, "completion") !== "complete"
        || text(product, "disposition") !== "mapped"
        || !equalBytes(
          bytes(product, "crypto_required_namespace_fingerprint"),
          fingerprint,
        )
        || !equalBytes(
          bytes(product, "required_namespace_fingerprint"),
          fingerprint,
        )
        || !requiredNamespaceIds.includes(reference.selectedNamespaceId)
        || !accessMatches
      ) return null;
      const importance = finiteNumber(product, "importance");
      const tier = integer(product, "tier");
      if (
        importance < 0
        || importance > 1
        || (tier !== 1 && tier !== 2 && tier !== 3)
      ) return null;
      return Object.freeze({
        reference: Object.freeze({
          memoryId: reference.memoryId,
          contentRevision: reference.contentRevision,
          objectId: reference.objectId,
          expectedAccessRevision: reference.cryptoAccessRevision,
          expectedActiveNamespaceFingerprint: fingerprint,
        }),
        selectedNamespaceId: reference.selectedNamespaceId,
        cryptoAccessRevision: reference.cryptoAccessRevision,
        accessKind: reference.accessKind,
        importance,
        tier,
        createdAt: timestamp(product, "created_at"),
        embedding: productEmbedding(product),
      });
    });
  }

  async read(
    reference: ProtectedAgentBackgroundMemoryRevisionReference,
  ): Promise<VerifiedAgentBackgroundMemoryRevisionContent | null> {
    if (!validReference(reference)) return null;
    const before = await this.#snapshot(reference);
    if (before === null) return null;
    let content: VerifiedAgentMemoryCryptoRevisionContent | null = null;
    try {
      content = await this.#cryptoReader.read(before.reference);
      if (content === null || !exactContent(content, before)) return null;
      const after = await this.#snapshot(reference);
      if (
        after === null
        || after.reference.objectId !== before.reference.objectId
        || after.cryptoAccessRevision !== before.cryptoAccessRevision
        || after.accessKind !== before.accessKind
        || after.importance !== before.importance
        || after.tier !== before.tier
        || after.createdAt !== before.createdAt
        || !equalEmbedding(after.embedding, before.embedding)
        || !equalBytes(
          after.reference.expectedActiveNamespaceFingerprint,
          before.reference.expectedActiveNamespaceFingerprint,
        )
      ) return null;
      const result = content;
      content = null;
      return Object.freeze({
        ...result,
        cryptoAccessRevision: before.cryptoAccessRevision,
        importance: before.importance,
        tier: before.tier,
        createdAt: before.createdAt,
        embedding: before.embedding,
      });
    } finally {
      wipe(content);
    }
  }
}
