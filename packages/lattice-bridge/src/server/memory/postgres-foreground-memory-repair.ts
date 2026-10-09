import {
  and,
  acquireEncryptionPublicationFence,
  EncryptionPublicationPolicyError,
  EncryptionTransitionPolicyConflictError,
  asc,
  desc,
  eq,
  gte,
  isNull,
  memories,
  memoryCryptoRevisions,
  memoryNamespaces,
  memoryScopes,
} from "@nautilo/db";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

import type { ForegroundMemoryContextItem, ForegroundMemoryRepairSelection } from
  "../../memory/foreground-memory-history.ts";
import { encodeMemoryPayloadV1 } from
  "../../memory/memory-payload-v1.ts";
import {
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
} from "../../memory/memory-repository.ts";
import {
  MemoryAuthorityResolutionError,
  resolveRequiredMemoryNamespaceIds,
} from
  "../../memory/required-namespace-set.ts";
import {
  ForegroundProductChangedError,
  isForegroundProductChangedError,
} from
  "../foreground-product-changed.ts";
import {
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductCanonicalTransactionRunner,
  type ConversationProductPostgresHandle,
  type ConversationProductPostgresTransaction,
} from "../message/postgres-conversation-product-store.ts";

export type ForegroundMemoryRepairSource = Readonly<{
  memory: Omit<ForegroundMemoryContextItem, "type" | "content"> & {
    type: string | null;
    content: string | null;
  };
  representationMode?: "ordinary-and-protected" | "protected-only";
  expectedContentRevision: number;
  targetContentRevision: number;
  existingObjectId: string | null;
  expectedAccessRevision: number;
  /** Held Task repairs require proof that the selected vector is current. */
  expectedEmbeddingRevision?: number | null;
  accessNamespaceIds: readonly string[];
  createdAt: number;
  plaintextBytes: Uint8Array | null;
  requestCommitment: Uint8Array;
  completedRepairReceipt?: true;
}>;

export type TaskScopeMemoryRepairSource = Readonly<{
  source: ForegroundMemoryRepairSource;
  scopeId: string;
  expectedScopeOriginNamespaceId: string;
  expectedEmbeddingRevision: number;
}>;

export type TaskNamespaceMemoryRepairSource = ForegroundMemoryRepairSource &
  Readonly<{ expectedEmbeddingRevision: number }>;

type TaskScopeMemoryRepairExpectation = Readonly<{
  scopeId: string;
  expectedScopeOriginNamespaceId: string;
  expectedContentRevision: number;
}>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function exactDate(value: unknown): Date {
  // Raw postgres-js returns Date; the owned Drizzle pool returns wire text.
  const parsed = typeof value === "string" ? new Date(value) : value;
  if (!(parsed instanceof Date) || Number.isNaN(parsed.getTime())) {
    throw new TypeError("Memory timestamp is invalid");
  }
  return parsed;
}

function resolveRepairRequiredNamespaceIds(
  input: Parameters<typeof resolveRequiredMemoryNamespaceIds>[0],
  taskScopeConflict?: string,
): readonly string[] {
  try {
    return resolveRequiredMemoryNamespaceIds(input);
  } catch (error) {
    if (taskScopeConflict !== undefined
      && error instanceof MemoryAuthorityResolutionError) {
      throw new ForegroundProductChangedError(taskScopeConflict);
    }
    throw error;
  }
}

export function foregroundMemoryRepairCommitment(input: Readonly<{
  crypto: LatticeCrypto;
  memoryId: string;
  expectedContentRevision: number;
  targetContentRevision: number;
  objectId: string;
  requiredNamespaceFingerprint: Uint8Array;
  plaintextBytes: Uint8Array;
}>): Uint8Array {
  const coordinates = new TextEncoder().encode(
    `nautilo.foreground-memory-repair.v2\0${input.memoryId}\0${input.expectedContentRevision}\0${input.targetContentRevision}\0${input.objectId}\0`,
  );
  const bytes = new Uint8Array(
    coordinates.length
      + input.requiredNamespaceFingerprint.length
      + input.plaintextBytes.length,
  );
  bytes.set(coordinates);
  bytes.set(input.requiredNamespaceFingerprint, coordinates.length);
  bytes.set(
    input.plaintextBytes,
    coordinates.length + input.requiredNamespaceFingerprint.length,
  );
  try {
    return input.crypto.hash(bytes);
  } finally {
    coordinates.fill(0);
    bytes.fill(0);
  }
}

async function loadPostgresMemoryRepairSourcesInTransaction(input: Readonly<{
  transaction: ConversationProductPostgresTransaction;
  crypto: LatticeCrypto;
  memories: readonly ForegroundMemoryRepairSelection[];
  representationMode: "ordinary-and-protected" | "protected-only";
  taskScope?: TaskScopeMemoryRepairExpectation;
}>): Promise<readonly ForegroundMemoryRepairSource[]> {
  const sources: ForegroundMemoryRepairSource[] = [];
  const destroyOnFailure: Uint8Array[] = [];
  try {
    for (const expected of input.memories) {
      const rows = await executeTypedConversationProductQuery(input.transaction,
        conversationProductTypedDb.select({
          id: memories.id,
          ...(input.representationMode === "ordinary-and-protected"
            ? { type: memories.type, content: memories.content }
            : {}),
          importance: memories.importance,
          tier: memories.tier,
          createdAt: memories.createdAt,
          contentRevision: memories.contentRevision,
          cryptoObjectId: memories.cryptoObjectId,
          cryptoMappingState: memories.cryptoMappingState,
          cryptoAccessRevision: memories.cryptoAccessRevision,
          cryptoRequiredNamespaceFingerprint:
            memories.cryptoRequiredNamespaceFingerprint,
          embeddingRevision: memories.embeddingRevision,
          scopeOriginNamespaceId: memories.scopeOriginNamespaceId,
        }).from(memories).where(eq(memories.id, expected.id)).limit(2)
          .for("update"));
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) {
        throw new ForegroundProductChangedError("Selected Memory changed");
      }
      const createdAt = exactDate(row.created_at);
      if (
        (input.representationMode === "ordinary-and-protected"
          && (
            (expected.type !== null && row.type !== expected.type)
            || ("content" in expected && row.content !== expected.content)
          ))
        || row.importance !== expected.importance
        || row.tier !== expected.tier
        || createdAt.getTime() !== expected.createdAt.getTime()
        || (
          row.crypto_object_id !== null
          && row.crypto_mapping_state !== "verified"
        )
      ) throw new ForegroundProductChangedError("Selected Memory changed");
      const [namespaceRows, scopeRows] = await Promise.all([
        executeTypedConversationProductQuery(input.transaction,
          conversationProductTypedDb.select({
            namespaceId: memoryNamespaces.namespaceId,
          }).from(memoryNamespaces).where(
            eq(memoryNamespaces.memoryId, expected.id),
          ).orderBy(asc(memoryNamespaces.namespaceId))),
        executeTypedConversationProductQuery(input.transaction,
          conversationProductTypedDb.select({
            scopeId: memoryScopes.scopeId,
            origin: memoryScopes.origin,
          }).from(memoryScopes).where(eq(memoryScopes.memoryId, expected.id))
            .orderBy(asc(memoryScopes.scopeId))),
      ]);
      const accessNamespaceIds = resolveRepairRequiredNamespaceIds({
        namespaceIds: namespaceRows.map((entry) => entry.namespace_id),
        scopeOrigins: scopeRows.map((entry) => {
          if (entry.origin !== "seed" && entry.origin !== "scope") {
            if (input.taskScope !== undefined) {
              throw new ForegroundProductChangedError(
                "Selected Task Scope Memory audience changed",
              );
            }
            throw new TypeError("Memory scope origin is invalid");
          }
          return entry.origin;
        }),
        originWritableNamespaceId: row.scope_origin_namespace_id,
      }, input.taskScope === undefined
        ? undefined
        : "Selected Task Scope Memory audience changed");
      const expectedContentRevision = row.content_revision;
      if (input.taskScope !== undefined && (
        input.memories.length !== 1
        || input.representationMode !== "ordinary-and-protected"
        || expectedContentRevision !== input.taskScope.expectedContentRevision
        || row.embedding_revision !== input.taskScope.expectedContentRevision
        || row.crypto_object_id !== null
        || row.crypto_mapping_state !== "unmapped"
        || row.crypto_required_namespace_fingerprint !== null
        || row.scope_origin_namespace_id
          !== input.taskScope.expectedScopeOriginNamespaceId
        || namespaceRows.length !== 0
        || scopeRows.filter((entry) =>
          entry.scope_id === input.taskScope?.scopeId
          && entry.origin === "scope").length !== 1
        || !equalStrings(accessNamespaceIds, [
          input.taskScope.expectedScopeOriginNamespaceId,
        ])
      )) throw new ForegroundProductChangedError(
        "Selected Task Scope Memory changed",
      );
      const fingerprint = fingerprintRequiredMemoryNamespaces(
        accessNamespaceIds,
      );
      if (
        row.crypto_object_id !== null
        && (
          !Number.isSafeInteger(row.crypto_access_revision)
          || row.crypto_access_revision < 0
          || !equalBytes(
            row.crypto_required_namespace_fingerprint,
            fingerprint,
          )
        )
      ) throw new ForegroundProductChangedError(
        "Selected Memory crypto authority changed",
      );
      const ordinaryType = typeof row.type === "string" ? row.type : null;
      const ordinaryContent = typeof row.content === "string" ? row.content : null;
      const plaintextBytes = input.representationMode === "protected-only"
          || ordinaryType === null
          || ordinaryContent === null
        ? null
        : encodeMemoryPayloadV1({
          formatVersion: 1,
          type: ordinaryType,
          content: ordinaryContent,
        });
      if (plaintextBytes !== null) destroyOnFailure.push(plaintextBytes);
      if (input.taskScope !== undefined && plaintextBytes === null) {
        throw new ForegroundProductChangedError(
          "Selected Task Scope Memory ordinary body changed",
        );
      }
      let targetContentRevision = expectedContentRevision;
      let requestCommitment: Uint8Array = new Uint8Array(32);
      let completedRepairReceipt: true | undefined;
      if (row.crypto_object_id === null && plaintextBytes !== null) {
        const baseRevision = Math.max(1, expectedContentRevision);
        // This read must remain unlocked. Reserve already holds Memory UPDATE and
        // may insert a fresh coordinate, while attachment owns lifecycle before
        // Memory. Locking an existing lifecycle row here would invert that order.
        const lifecycleRows = await executeTypedConversationProductQuery(
          input.transaction,
          conversationProductTypedDb.select({
            contentRevision: memoryCryptoRevisions.contentRevision,
            cryptoObjectId: memoryCryptoRevisions.cryptoObjectId,
            allocationRequestDigest:
              memoryCryptoRevisions.allocationRequestDigest,
            requiredNamespaceFingerprint:
              memoryCryptoRevisions.requiredNamespaceFingerprint,
            completion: memoryCryptoRevisions.completion,
            disposition: memoryCryptoRevisions.disposition,
          }).from(memoryCryptoRevisions).where(and(
            eq(memoryCryptoRevisions.memoryId, expected.id),
            gte(memoryCryptoRevisions.contentRevision, baseRevision),
          )).orderBy(desc(memoryCryptoRevisions.contentRevision)).limit(1),
        );
        const latest = lifecycleRows[0];
        const latestRevision = latest?.content_revision ?? baseRevision;
        const latestObjectId = deriveMemoryCryptoObjectIdV1({
          memoryId: expected.id,
          contentRevision: latestRevision,
        });
        const latestCommitment = foregroundMemoryRepairCommitment({
          crypto: input.crypto,
          memoryId: expected.id,
          expectedContentRevision,
          targetContentRevision: latestRevision,
          objectId: latestObjectId,
          requiredNamespaceFingerprint: fingerprint,
          plaintextBytes,
        });
        destroyOnFailure.push(latestCommitment);
        const mayResumeLatest = latest !== undefined
          && latest.crypto_object_id === latestObjectId
          && equalBytes(latest.allocation_request_digest, latestCommitment)
          && equalBytes(latest.required_namespace_fingerprint, fingerprint)
          && latest.disposition === "active"
          && (
            latest.completion === "pending"
            || latest.completion === "complete"
          );
        if (mayResumeLatest) {
          targetContentRevision = latestRevision;
          requestCommitment = latestCommitment;
        } else {
          latestCommitment.fill(0);
          targetContentRevision = latest === undefined
            ? baseRevision
            : Math.max(baseRevision, latestRevision + 1);
          const objectId = deriveMemoryCryptoObjectIdV1({
            memoryId: expected.id,
            contentRevision: targetContentRevision,
          });
          requestCommitment = foregroundMemoryRepairCommitment({
            crypto: input.crypto,
            memoryId: expected.id,
            expectedContentRevision,
            targetContentRevision,
            objectId,
            requiredNamespaceFingerprint: fingerprint,
            plaintextBytes,
          });
          destroyOnFailure.push(requestCommitment);
          await executeTypedConversationProductQuery(input.transaction,
            conversationProductTypedDb.insert(memoryCryptoRevisions).values({
              memoryId: expected.id,
              contentRevision: targetContentRevision,
              anchorNamespaceId: accessNamespaceIds[0]!,
              cryptoObjectId: objectId,
              payloadVersion: 1,
              allocationRequestDigest: requestCommitment,
              requiredNamespaceFingerprint: fingerprint,
              completion: "pending",
              disposition: "active",
              attemptCount: 0,
            }));
        }
      } else if (row.crypto_object_id !== null) {
        const lifecycleRows = await executeTypedConversationProductQuery(
          input.transaction,
          conversationProductTypedDb.select({
            allocationRequestDigest:
              memoryCryptoRevisions.allocationRequestDigest,
            completion: memoryCryptoRevisions.completion,
            disposition: memoryCryptoRevisions.disposition,
          }).from(memoryCryptoRevisions).where(and(
            eq(memoryCryptoRevisions.memoryId, expected.id),
            eq(memoryCryptoRevisions.contentRevision, expectedContentRevision),
            eq(memoryCryptoRevisions.cryptoObjectId, row.crypto_object_id),
          )).limit(2),
        );
        const lifecycle = lifecycleRows[0];
        if (lifecycleRows.length === 1 && lifecycle !== undefined
          && lifecycle.completion === "complete"
          && lifecycle.disposition === "mapped") {
          requestCommitment = lifecycle.allocation_request_digest.slice();
          destroyOnFailure.push(requestCommitment);
          completedRepairReceipt = true;
        }
      }
      sources.push(Object.freeze({
        memory: Object.freeze({
          ...expected,
          type: ordinaryType,
          content: ordinaryContent,
        }),
        representationMode: input.representationMode,
        expectedContentRevision,
        targetContentRevision,
        existingObjectId: row.crypto_object_id,
        expectedAccessRevision: row.crypto_access_revision,
        expectedEmbeddingRevision: row.embedding_revision,
        accessNamespaceIds,
        createdAt: createdAt.getTime(),
        plaintextBytes,
        requestCommitment,
        ...(completedRepairReceipt === true ? { completedRepairReceipt } : {}),
      }));
    }
    return Object.freeze(sources);
  } catch (error) {
    for (const bytes of destroyOnFailure) bytes.fill(0);
    throw error;
  }
}

/** Resolve exact current payload and audience for already-selected Memories. */
export async function loadPostgresForegroundMemoryRepairSources(input: Readonly<{
  product: ConversationProductPostgresHandle;
  crypto: LatticeCrypto;
  memories: readonly ForegroundMemoryRepairSelection[];
  representationMode?: "ordinary-and-protected" | "protected-only";
}>): Promise<readonly ForegroundMemoryRepairSource[]> {
  const representationMode = input.representationMode
    ?? "ordinary-and-protected";
  return input.product.transaction(transaction =>
    loadPostgresMemoryRepairSourcesInTransaction({
      transaction,
      crypto: input.crypto,
      memories: input.memories,
      representationMode,
    }), { isolationLevel: "serializable" });
}

/** Reserve one exact ordinary Task Scope source on its caller-owned tx. */
export async function reservePostgresTaskScopeMemoryRepairSource(
  input: Readonly<{
    transaction: ConversationProductPostgresTransaction;
    crypto: LatticeCrypto;
    selection: ForegroundMemoryRepairSelection;
    expectedContentRevision: number;
    scopeId: string;
    expectedScopeOriginNamespaceId: string;
  }>,
): Promise<TaskScopeMemoryRepairSource> {
  if (!Number.isSafeInteger(input.expectedContentRevision)
    || input.expectedContentRevision < 0
    || !UUID.test(input.scopeId)
    || !UUID.test(input.expectedScopeOriginNamespaceId)) {
    throw new TypeError("Task Scope Memory repair coordinates are invalid");
  }
  const [source] = await loadPostgresMemoryRepairSourcesInTransaction({
    transaction: input.transaction,
    crypto: input.crypto,
    memories: [input.selection],
    representationMode: "ordinary-and-protected",
    taskScope: Object.freeze({
      scopeId: input.scopeId,
      expectedScopeOriginNamespaceId: input.expectedScopeOriginNamespaceId,
      expectedContentRevision: input.expectedContentRevision,
    }),
  });
  if (source === undefined) {
    throw new ForegroundProductChangedError(
      "Selected Task Scope Memory changed",
    );
  }
  return Object.freeze({
    source,
    scopeId: input.scopeId,
    expectedScopeOriginNamespaceId: input.expectedScopeOriginNamespaceId,
    expectedEmbeddingRevision: input.expectedContentRevision,
  });
}

/** Reserve one exact ordinary Task Namespace/Wide source on its caller-owned tx. */
export async function reservePostgresTaskNamespaceMemoryRepairSource(
  input: Readonly<{
    transaction: ConversationProductPostgresTransaction;
    crypto: LatticeCrypto;
    selection: ForegroundMemoryRepairSelection;
    expectedContentRevision: number;
  }>,
): Promise<TaskNamespaceMemoryRepairSource> {
  if (!Number.isSafeInteger(input.expectedContentRevision)
    || input.expectedContentRevision < 0) {
    throw new TypeError("Task Namespace Memory repair coordinates are invalid");
  }
  const [source] = await loadPostgresMemoryRepairSourcesInTransaction({
    transaction: input.transaction,
    crypto: input.crypto,
    memories: [input.selection],
    representationMode: "ordinary-and-protected",
  });
  if (source === undefined
    || source.expectedContentRevision !== input.expectedContentRevision
    || source.expectedEmbeddingRevision !== input.expectedContentRevision
    || source.accessNamespaceIds.length < 1) {
    source?.plaintextBytes?.fill(0);
    source?.requestCommitment.fill(0);
    throw new ForegroundProductChangedError(
      "Selected Task Namespace Memory changed",
    );
  }
  return source as TaskNamespaceMemoryRepairSource;
}

function equalBytes(left: unknown, right: Uint8Array): boolean {
  return left instanceof Uint8Array
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/** Recheck a reused protected Memory after crypto open and before consumption. */
export async function validatePostgresForegroundMemoryRepairSource(input: Readonly<{
  product: ConversationProductPostgresHandle;
  source: ForegroundMemoryRepairSource;
  objectId: string;
}>): Promise<boolean> {
  if (
    input.source.existingObjectId === null
    || input.objectId !== input.source.existingObjectId
  ) return false;
  return input.product.transaction(async (tx) => {
    const rows = await executeTypedConversationProductQuery(tx,
      conversationProductTypedDb.select({
        ...(input.source.representationMode === "ordinary-and-protected"
          ? { type: memories.type, content: memories.content }
          : {}),
        importance: memories.importance,
        tier: memories.tier,
        createdAt: memories.createdAt,
        contentRevision: memories.contentRevision,
        cryptoObjectId: memories.cryptoObjectId,
        cryptoAccessRevision: memories.cryptoAccessRevision,
        fingerprint: memories.cryptoRequiredNamespaceFingerprint,
        state: memories.cryptoMappingState,
        scopeOriginNamespaceId: memories.scopeOriginNamespaceId,
      }).from(memories).where(eq(
        memories.id,
        input.source.memory.id,
      )).limit(2));
    const row = rows[0];
    if (
      rows.length !== 1
      || row === undefined
      || (
        input.source.representationMode === "ordinary-and-protected"
        && (
          row.type !== input.source.memory.type
          || row.content !== input.source.memory.content
        )
      )
      || row.importance !== input.source.memory.importance
      || row.tier !== input.source.memory.tier
      || exactDate(row.created_at).getTime()
        !== input.source.memory.createdAt.getTime()
      || row.content_revision !== input.source.expectedContentRevision
      || row.crypto_object_id !== input.objectId
      || row.crypto_access_revision !== input.source.expectedAccessRevision
      || row.crypto_mapping_state !== "verified"
    ) return false;
    const [namespaceRows, scopeRows] = await Promise.all([
      executeTypedConversationProductQuery(tx,
        conversationProductTypedDb.select({
          namespaceId: memoryNamespaces.namespaceId,
        }).from(memoryNamespaces).where(eq(
          memoryNamespaces.memoryId,
          input.source.memory.id,
        )).orderBy(asc(memoryNamespaces.namespaceId))),
      executeTypedConversationProductQuery(tx,
        conversationProductTypedDb.select({ origin: memoryScopes.origin })
          .from(memoryScopes).where(eq(
            memoryScopes.memoryId,
            input.source.memory.id,
          )).orderBy(asc(memoryScopes.scopeId))),
    ]);
    const currentNamespaceIds = resolveRequiredMemoryNamespaceIds({
      namespaceIds: namespaceRows.map((entry) => entry.namespace_id),
      scopeOrigins: scopeRows.map((entry) => {
        if (entry.origin !== "seed" && entry.origin !== "scope") {
          throw new TypeError("Memory scope origin is invalid");
        }
        return entry.origin;
      }),
      originWritableNamespaceId: row.scope_origin_namespace_id,
    });
    const fingerprint = fingerprintRequiredMemoryNamespaces(
      currentNamespaceIds,
    );
    return equalStrings(currentNamespaceIds, input.source.accessNamespaceIds)
      && equalBytes(row.crypto_required_namespace_fingerprint, fingerprint);
  }, { isolationLevel: "serializable" });
}

/** Attach a verified Memory object only if its selected ordinary row is current. */
/** Restore one missing Shadow ordinary sibling after authenticated protected open. */
export async function restorePostgresForegroundMemoryOrdinary(input: Readonly<{
  canonical: ConversationProductCanonicalTransactionRunner;
  source: ForegroundMemoryRepairSource;
  objectId: string;
  type: string;
  content: string;
  expectedPolicyRevision: number;
  authorizeSource?(transaction: CanonicalTranscriptTx): Promise<boolean>;
}>): Promise<"restored" | "replayed" | "conflict"> {
  if (
    input.source.existingObjectId !== input.objectId
    || (input.source.plaintextBytes === null
      ? input.source.memory.content !== null
      : input.source.memory.type !== input.type
        || input.source.memory.content !== input.content)
  ) return "conflict";
  try {
    return await input.canonical.transaction(async (tx) => {
      await acquireEncryptionPublicationFence(tx, {
        expectedRevision: input.expectedPolicyRevision,
        representation: "ordinary_and_protected",
      });
      if (input.authorizeSource !== undefined
        && !await input.authorizeSource(tx)) return "conflict";
      const rows = await tx.select({
          type: memories.type,
          content: memories.content,
          importance: memories.importance,
          tier: memories.tier,
          createdAt: memories.createdAt,
          contentRevision: memories.contentRevision,
          cryptoObjectId: memories.cryptoObjectId,
          cryptoAccessRevision: memories.cryptoAccessRevision,
          fingerprint: memories.cryptoRequiredNamespaceFingerprint,
          state: memories.cryptoMappingState,
          scopeOriginNamespaceId: memories.scopeOriginNamespaceId,
        }).from(memories).where(eq(memories.id, input.source.memory.id)).limit(2);
      const row = rows[0];
      if (
        rows.length !== 1 || row === undefined
        || (
          input.source.memory.type !== null
          && row.type !== input.source.memory.type
        )
        || row.importance !== input.source.memory.importance
        || row.tier !== input.source.memory.tier
        || exactDate(row.createdAt).getTime() !== input.source.memory.createdAt.getTime()
        || row.contentRevision !== input.source.targetContentRevision
        || row.cryptoObjectId !== input.objectId
        || row.cryptoAccessRevision !== input.source.expectedAccessRevision
        || row.state !== "verified"
      ) return "conflict";
      const [namespaceRows, scopeRows] = await Promise.all([
        tx.select({ namespaceId: memoryNamespaces.namespaceId })
            .from(memoryNamespaces).where(eq(
              memoryNamespaces.memoryId, input.source.memory.id,
            )).orderBy(asc(memoryNamespaces.namespaceId)),
        tx.select({ origin: memoryScopes.origin })
            .from(memoryScopes).where(eq(
              memoryScopes.memoryId, input.source.memory.id,
            )).orderBy(asc(memoryScopes.scopeId)),
      ]);
      const namespaces = resolveRequiredMemoryNamespaceIds({
        namespaceIds: namespaceRows.map((entry) => entry.namespaceId),
        scopeOrigins: scopeRows.map((entry) => {
          if (entry.origin !== "seed" && entry.origin !== "scope") {
            throw new TypeError("Memory scope origin is invalid");
          }
          return entry.origin;
        }),
        originWritableNamespaceId: row.scopeOriginNamespaceId,
      });
      if (
        !equalStrings(namespaces, input.source.accessNamespaceIds)
        || !equalBytes(
          row.fingerprint,
          fingerprintRequiredMemoryNamespaces(namespaces),
        )
      ) return "conflict";
      if (row.content !== null) {
        return row.type === input.type && row.content === input.content
          ? "replayed"
          : "conflict";
      }
      if (row.type !== null && row.type !== input.type) return "conflict";
      const updated = await tx.update(memories).set({
        type: input.type,
        content: input.content,
      })
          .where(and(
            eq(memories.id, input.source.memory.id),
            eq(memories.contentRevision, input.source.targetContentRevision),
            eq(memories.cryptoObjectId, input.objectId),
            eq(memories.cryptoMappingState, "verified"),
            input.source.memory.type === null
              ? isNull(memories.type)
              : eq(memories.type, input.source.memory.type),
            isNull(memories.content),
          )).returning({ id: memories.id });
      if (updated.length !== 1) return "conflict";
      // The general product trigger correctly marks every ordinary-body change
      // stale. This path has just authenticated the unchanged protected object
      // and all of its current coordinates, so complete the reverse repair by
      // restoring the same verified mapping in this serializable transaction.
      const remapped = await tx.update(memories).set({
        cryptoMappingState: "verified",
      }).where(and(
        eq(memories.id, input.source.memory.id),
        eq(memories.type, input.type),
        eq(memories.content, input.content),
        eq(memories.contentRevision, input.source.targetContentRevision),
        eq(memories.cryptoObjectId, input.objectId),
        eq(memories.cryptoMappingState, "stale"),
      )).returning({ id: memories.id });
      if (remapped.length !== 1) {
        throw new ForegroundProductChangedError(
          "Selected Memory mapping changed during reverse repair",
        );
      }
      return "restored";
    }, { isolationLevel: "serializable" });
  } catch (error) {
    if (
      error instanceof EncryptionPublicationPolicyError
      || error instanceof EncryptionTransitionPolicyConflictError
      || isForegroundProductChangedError(error)
    ) return "conflict";
    throw error;
  }
}

type ForegroundMemoryRepairAttachment = Readonly<{
  source: ForegroundMemoryRepairSource;
  objectId: string;
  requestCommitment: Uint8Array;
}>;

type TaskScopeMemoryRepairAttachment = Readonly<{
  scopeId: string;
  expectedScopeOriginNamespaceId: string;
  expectedEmbeddingRevision: number;
}>;

function taskScopeAttachmentCurrent(input: Readonly<{
  taskScope: TaskScopeMemoryRepairAttachment;
  scopeOriginNamespaceId: string | null;
  embeddingRevision: number | null;
  expectedEmbeddingRevision: number;
  namespaceIds: readonly string[];
  scopeRows: readonly Readonly<{ scope_id: string; origin: string }>[];
  accessNamespaceIds: readonly string[];
}>): boolean {
  return input.scopeOriginNamespaceId
      === input.taskScope.expectedScopeOriginNamespaceId
    && input.embeddingRevision === input.expectedEmbeddingRevision
    && input.namespaceIds.length === 0
    && input.scopeRows.filter(row =>
      row.scope_id === input.taskScope.scopeId
      && row.origin === "scope").length === 1
    && equalStrings(input.accessNamespaceIds, [
      input.taskScope.expectedScopeOriginNamespaceId,
    ]);
}

async function attachPostgresMemoryRepairInTransaction(input: Readonly<{
  transaction: ConversationProductPostgresTransaction;
  attachment: ForegroundMemoryRepairAttachment;
  taskScope?: TaskScopeMemoryRepairAttachment;
  taskNamespace?: true;
}>): Promise<"attached" | "replayed" | "conflict"> {
  const { source, objectId, requestCommitment } = input.attachment;
  if (
    source.plaintextBytes === null
    || source.memory.type === null
    || source.memory.content === null
  ) return "conflict";
  const ordinaryType = source.memory.type;
  const ordinaryContent = source.memory.content;
  const expectedObjectId = deriveMemoryCryptoObjectIdV1({
    memoryId: source.memory.id,
    contentRevision: source.targetContentRevision,
  });
  if (
    objectId !== expectedObjectId
    || !equalBytes(requestCommitment, source.requestCommitment)
  ) return "conflict";
  const fingerprint = fingerprintRequiredMemoryNamespaces(
    source.accessNamespaceIds,
  );
  const lifecycleQuery = conversationProductTypedDb.select({
    objectId: memoryCryptoRevisions.cryptoObjectId,
    allocationRequestDigest:
      memoryCryptoRevisions.allocationRequestDigest,
    requiredNamespaceFingerprint:
      memoryCryptoRevisions.requiredNamespaceFingerprint,
    completion: memoryCryptoRevisions.completion,
    disposition: memoryCryptoRevisions.disposition,
  }).from(memoryCryptoRevisions).where(and(
    eq(memoryCryptoRevisions.memoryId, source.memory.id),
    eq(
      memoryCryptoRevisions.contentRevision,
      source.targetContentRevision,
    ),
  )).limit(2);
  // The caller-owned Task transaction is READ COMMITTED. Lock lifecycle before
  // Memory to match crypto reconciliation/publication, then hold Memory UPDATE
  // while reading its audience. Besides fencing metadata changes, the strong
  // parent lock blocks child-FK inserts whose stale-mapping trigger could have
  // observed the still-unmapped row before this attachment.
  const heldTaskRepair = input.taskScope !== undefined
    || input.taskNamespace === true;
  const lockedTaskLifecycleRows = !heldTaskRepair
    ? null
    : await executeTypedConversationProductQuery(
      input.transaction,
      lifecycleQuery.for("update"),
    );
  const memoryQuery = conversationProductTypedDb.select({
    type: memories.type,
    content: memories.content,
    importance: memories.importance,
    tier: memories.tier,
    createdAt: memories.createdAt,
    contentRevision: memories.contentRevision,
    cryptoObjectId: memories.cryptoObjectId,
    cryptoAccessRevision: memories.cryptoAccessRevision,
    fingerprint: memories.cryptoRequiredNamespaceFingerprint,
    state: memories.cryptoMappingState,
    embeddingRevision: memories.embeddingRevision,
    scopeOriginNamespaceId: memories.scopeOriginNamespaceId,
  }).from(memories).where(eq(
    memories.id,
    source.memory.id,
  )).limit(2);
  const rows = await executeTypedConversationProductQuery(input.transaction,
    !heldTaskRepair
      ? memoryQuery
      : memoryQuery.for("update"));
  const row = rows[0];
  if (
    rows.length !== 1
    || row === undefined
    || row.type !== source.memory.type
    || row.content !== source.memory.content
    || row.importance !== source.memory.importance
    || row.tier !== source.memory.tier
    || exactDate(row.created_at).getTime()
      !== source.memory.createdAt.getTime()
  ) return "conflict";
  const namespaceQuery = conversationProductTypedDb.select({
    namespaceId: memoryNamespaces.namespaceId,
  }).from(memoryNamespaces).where(eq(
    memoryNamespaces.memoryId,
    source.memory.id,
  )).orderBy(asc(memoryNamespaces.namespaceId));
  const scopeQuery = conversationProductTypedDb.select({
    scopeId: memoryScopes.scopeId,
    origin: memoryScopes.origin,
  }).from(memoryScopes).where(eq(
    memoryScopes.memoryId,
    source.memory.id,
  )).orderBy(asc(memoryScopes.scopeId));
  const taskScopeQuery = input.taskScope === undefined
    ? null
    : conversationProductTypedDb.select({
      scopeId: memoryScopes.scopeId,
      origin: memoryScopes.origin,
    }).from(memoryScopes).where(and(
      eq(memoryScopes.memoryId, source.memory.id),
      eq(memoryScopes.scopeId, input.taskScope.scopeId),
    )).limit(2).for("update");
  const [namespaceRows, scopeRows] = input.taskScope === undefined
    ? await Promise.all([
      executeTypedConversationProductQuery(input.transaction, namespaceQuery),
      executeTypedConversationProductQuery(input.transaction, scopeQuery),
    ])
    : [
      // Task Scope repair accepts only an empty ordinary Namespace set. The
      // held Memory UPDATE blocks FK inserts. Do not lock existing Namespace
      // edges here: DELETE locks the child then its trigger updates Memory, so
      // Memory-then-child locking would invert that database-owned order.
      await executeTypedConversationProductQuery(
        input.transaction,
        namespaceQuery,
      ),
      // Only this authored edge proves the selected Task Scope authority.
      // Foreign seed/origin edges resolve through the same singular stored
      // origin and do not widen its audience; leaving them unlocked avoids a
      // Memory→foreign-edge inversion with another Scope's close owner.
      await executeTypedConversationProductQuery(
        input.transaction,
        taskScopeQuery!,
      ),
    ];
  const currentNamespaceIds = resolveRepairRequiredNamespaceIds({
    namespaceIds: namespaceRows.map((entry) => entry.namespace_id),
    scopeOrigins: scopeRows.map((entry) => {
      if (entry.origin !== "seed" && entry.origin !== "scope") {
        if (input.taskScope !== undefined) {
          throw new ForegroundProductChangedError(
            "Task Scope Memory audience changed before repair attachment",
          );
        }
        throw new TypeError("Memory scope origin is invalid");
      }
      return entry.origin;
    }),
    originWritableNamespaceId: row.scope_origin_namespace_id,
  }, input.taskScope === undefined
    ? undefined
    : "Task Scope Memory audience changed before repair attachment");
  if (!equalStrings(currentNamespaceIds, source.accessNamespaceIds)) {
    return "conflict";
  }
  const replay = (
    row.content_revision === source.targetContentRevision
    && row.crypto_object_id === objectId
    && row.crypto_access_revision === 0
    && row.crypto_mapping_state === "verified"
    && equalBytes(row.crypto_required_namespace_fingerprint, fingerprint)
  );
  if (!replay && (
    row.content_revision !== source.expectedContentRevision
    || row.crypto_object_id !== null
  )) return "conflict";
  if (input.taskScope !== undefined && !taskScopeAttachmentCurrent({
    taskScope: input.taskScope,
    scopeOriginNamespaceId: row.scope_origin_namespace_id,
    embeddingRevision: row.embedding_revision,
    expectedEmbeddingRevision: replay
      ? source.targetContentRevision
      : input.taskScope.expectedEmbeddingRevision,
    namespaceIds: namespaceRows.map(entry => entry.namespace_id),
    scopeRows,
    accessNamespaceIds: currentNamespaceIds,
  })) return "conflict";
  if (input.taskNamespace === true && (
    !Number.isSafeInteger(source.expectedEmbeddingRevision)
    || row.embedding_revision !== (replay
      ? source.targetContentRevision
      : source.expectedEmbeddingRevision)
  )) return "conflict";
  const expectedTaskEmbeddingRevision = input.taskScope?.expectedEmbeddingRevision
    ?? (input.taskNamespace === true
      && typeof source.expectedEmbeddingRevision === "number"
      ? source.expectedEmbeddingRevision
      : null);

  const lifecycleRows = lockedTaskLifecycleRows
    ?? await executeTypedConversationProductQuery(
      input.transaction,
      lifecycleQuery,
    );
  const lifecycle = lifecycleRows[0];
  if (
    lifecycleRows.length !== 1
    || lifecycle === undefined
    || lifecycle.crypto_object_id !== objectId
    || !equalBytes(
      lifecycle.allocation_request_digest,
      requestCommitment,
    )
    || !equalBytes(
      lifecycle.required_namespace_fingerprint,
      fingerprint,
    )
  ) throw new ForegroundProductChangedError(
    "Memory repair lifecycle conflicted",
  );
  if (
    replay
      ? lifecycle.completion !== "complete"
        || lifecycle.disposition !== "mapped"
      : (lifecycle.completion !== "pending"
          && lifecycle.completion !== "complete")
        || lifecycle.disposition !== "active"
  ) throw new ForegroundProductChangedError(
      "Memory repair lifecycle conflicted",
    );
  if (replay) return "replayed";

  // Attachment owns lifecycle before Memory. Once this first mutation occurs,
  // every later conflict must escape so the caller-owned transaction rolls the
  // lifecycle update back with the Memory CAS.
  const completedAt = new Date();
  const completed = await executeTypedConversationProductQuery(
    input.transaction,
    conversationProductTypedDb.update(memoryCryptoRevisions).set({
      completion: "complete",
      disposition: "mapped",
      nextAttemptAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
      failureCode: null,
      cryptoCompletedAt: completedAt,
      updatedAt: completedAt,
    }).where(and(
      eq(memoryCryptoRevisions.memoryId, source.memory.id),
      eq(
        memoryCryptoRevisions.contentRevision,
        source.targetContentRevision,
      ),
      eq(memoryCryptoRevisions.cryptoObjectId, objectId),
      eq(memoryCryptoRevisions.disposition, "active"),
    )).returning({ sequence: memoryCryptoRevisions.sequence }),
  );
  if (completed.length !== 1) throw new ForegroundProductChangedError(
    "Memory repair lifecycle changed before attachment",
  );
  const updated = await executeTypedConversationProductQuery(input.transaction,
    conversationProductTypedDb.update(memories).set({
      contentRevision: source.targetContentRevision,
      ...(heldTaskRepair
        ? { embeddingRevision: source.targetContentRevision }
        : {}),
      cryptoObjectId: objectId,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: fingerprint,
      cryptoMappingState: "verified",
      updatedAt: completedAt,
    }).where(and(
      eq(memories.id, source.memory.id),
      eq(memories.type, ordinaryType),
      eq(memories.content, ordinaryContent),
      eq(memories.contentRevision, source.expectedContentRevision),
      isNull(memories.cryptoObjectId),
      input.taskScope === undefined
        ? undefined
        : eq(memories.cryptoAccessRevision, source.expectedAccessRevision),
      expectedTaskEmbeddingRevision === null
        ? undefined
        : eq(memories.embeddingRevision,
          expectedTaskEmbeddingRevision),
      input.taskScope === undefined
        ? undefined
        : eq(
          memories.scopeOriginNamespaceId,
          input.taskScope.expectedScopeOriginNamespaceId,
        ),
      input.taskScope === undefined
        ? undefined
        : eq(memories.cryptoMappingState, "unmapped"),
      input.taskScope === undefined
        ? undefined
        : isNull(memories.cryptoRequiredNamespaceFingerprint),
    )).returning({ id: memories.id }));
  if (updated.length !== 1) throw new ForegroundProductChangedError(
    "Memory changed before repair attachment",
  );
  if (input.taskScope !== undefined) {
    const [currentNamespaceRows, currentScopeRows] = await Promise.all([
      executeTypedConversationProductQuery(input.transaction,
        conversationProductTypedDb.select({
          namespaceId: memoryNamespaces.namespaceId,
        }).from(memoryNamespaces).where(eq(
          memoryNamespaces.memoryId,
          source.memory.id,
        )).orderBy(asc(memoryNamespaces.namespaceId))),
      executeTypedConversationProductQuery(input.transaction,
        conversationProductTypedDb.select({
          scopeId: memoryScopes.scopeId,
          origin: memoryScopes.origin,
        }).from(memoryScopes).where(eq(
          memoryScopes.memoryId,
          source.memory.id,
        )).orderBy(asc(memoryScopes.scopeId))),
    ]);
    const currentAccessNamespaceIds = resolveRepairRequiredNamespaceIds({
      namespaceIds: currentNamespaceRows.map(entry => entry.namespace_id),
      scopeOrigins: currentScopeRows.map(entry => {
        if (entry.origin !== "seed" && entry.origin !== "scope") {
          throw new ForegroundProductChangedError(
            "Task Scope Memory audience changed during repair attachment",
          );
        }
        return entry.origin;
      }),
      originWritableNamespaceId:
        input.taskScope.expectedScopeOriginNamespaceId,
    }, "Task Scope Memory audience changed during repair attachment");
    if (!taskScopeAttachmentCurrent({
      taskScope: input.taskScope,
      scopeOriginNamespaceId:
        input.taskScope.expectedScopeOriginNamespaceId,
      embeddingRevision: source.targetContentRevision,
      expectedEmbeddingRevision: source.targetContentRevision,
      namespaceIds: currentNamespaceRows.map(entry => entry.namespace_id),
      scopeRows: currentScopeRows,
      accessNamespaceIds: currentAccessNamespaceIds,
    })) throw new ForegroundProductChangedError(
      "Task Scope Memory audience changed during repair attachment",
    );
  }
  return "attached";
}

export async function attachPostgresForegroundMemoryRepair(input:
  ForegroundMemoryRepairAttachment & (
    | Readonly<{ product: ConversationProductPostgresHandle }>
    | Readonly<{
      canonical: ConversationProductCanonicalTransactionRunner;
      expectedPolicyRevision: number;
      authorizeSource(transaction: CanonicalTranscriptTx): Promise<boolean>;
    }>
  )): Promise<"attached" | "replayed" | "conflict"> {
  try {
    if ("canonical" in input) {
      return await input.canonical.transaction(async (transaction, executor) => {
        await acquireEncryptionPublicationFence(transaction, {
          expectedRevision: input.expectedPolicyRevision,
          representation: "ordinary_and_protected",
        });
        if (!await input.authorizeSource(transaction)) return "conflict";
        return attachPostgresMemoryRepairInTransaction({
          transaction: executor,
          attachment: input,
        });
      }, { isolationLevel: "serializable" });
    }
    return await input.product.transaction(transaction =>
      attachPostgresMemoryRepairInTransaction({
        transaction,
        attachment: input,
      }), { isolationLevel: "serializable" });
  } catch (error) {
    if (isForegroundProductChangedError(error)
      || error instanceof EncryptionPublicationPolicyError
      || error instanceof EncryptionTransitionPolicyConflictError) {
      return "conflict";
    }
    throw error;
  }
}

/** Attach one exact Task Scope repair on its caller-owned transaction. */
export function attachPostgresTaskScopeMemoryRepair(input: Readonly<{
  transaction: ConversationProductPostgresTransaction;
  source: TaskScopeMemoryRepairSource;
  objectId: string;
  requestCommitment: Uint8Array;
}>): Promise<"attached" | "replayed" | "conflict"> {
  if (!UUID.test(input.source.scopeId)
    || !UUID.test(input.source.expectedScopeOriginNamespaceId)
    || !Number.isSafeInteger(input.source.expectedEmbeddingRevision)
    || input.source.expectedEmbeddingRevision < 0
    || input.source.expectedEmbeddingRevision
      !== input.source.source.expectedContentRevision
    || input.source.source.representationMode !== "ordinary-and-protected"
    || input.source.source.existingObjectId !== null
    || !equalStrings(input.source.source.accessNamespaceIds, [
      input.source.expectedScopeOriginNamespaceId,
    ])) return Promise.resolve("conflict");
  return attachPostgresMemoryRepairInTransaction({
    transaction: input.transaction,
    attachment: {
      source: input.source.source,
      objectId: input.objectId,
      requestCommitment: input.requestCommitment,
    },
    taskScope: {
      scopeId: input.source.scopeId,
      expectedScopeOriginNamespaceId:
        input.source.expectedScopeOriginNamespaceId,
      expectedEmbeddingRevision: input.source.expectedEmbeddingRevision,
    },
  });
}

/** Attach one exact Task Namespace/Wide repair on its caller-owned transaction. */
export function attachPostgresTaskNamespaceMemoryRepair(input: Readonly<{
  transaction: ConversationProductPostgresTransaction;
  source: TaskNamespaceMemoryRepairSource;
  objectId: string;
  requestCommitment: Uint8Array;
}>): Promise<"attached" | "replayed" | "conflict"> {
  if (input.source.representationMode !== "ordinary-and-protected"
    || input.source.accessNamespaceIds.length < 1
    || !Number.isSafeInteger(input.source.expectedEmbeddingRevision)
    || input.source.expectedEmbeddingRevision < 0
    || input.source.expectedEmbeddingRevision
      !== input.source.expectedContentRevision) {
    return Promise.resolve("conflict");
  }
  return attachPostgresMemoryRepairInTransaction({
    transaction: input.transaction,
    attachment: {
      source: input.source,
      objectId: input.objectId,
      requestCommitment: input.requestCommitment,
    },
    taskNamespace: true,
  });
}
