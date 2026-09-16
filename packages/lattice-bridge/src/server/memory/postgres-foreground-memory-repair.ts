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
import { resolveRequiredMemoryNamespaceIds } from
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
  type ConversationProductPostgresExecutor,
  type ConversationProductPostgresHandle,
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
  accessNamespaceIds: readonly string[];
  createdAt: number;
  plaintextBytes: Uint8Array | null;
  requestCommitment: Uint8Array;
  completedRepairReceipt?: true;
}>;

function exactDate(value: unknown): Date {
  // Raw postgres-js returns Date; the owned Drizzle pool returns wire text.
  const parsed = typeof value === "string" ? new Date(value) : value;
  if (!(parsed instanceof Date) || Number.isNaN(parsed.getTime())) {
    throw new TypeError("Memory timestamp is invalid");
  }
  return parsed;
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

/** Resolve exact current payload and audience for already-selected Memories. */
export async function loadPostgresForegroundMemoryRepairSources(input: Readonly<{
  product: ConversationProductPostgresHandle;
  crypto: LatticeCrypto;
  memories: readonly ForegroundMemoryRepairSelection[];
  representationMode?: "ordinary-and-protected" | "protected-only";
}>): Promise<readonly ForegroundMemoryRepairSource[]> {
  const representationMode = input.representationMode
    ?? "ordinary-and-protected";
  return input.product.transaction(async (tx) => {
    const sources: ForegroundMemoryRepairSource[] = [];
    for (const expected of input.memories) {
      const rows = await executeTypedConversationProductQuery(tx,
        conversationProductTypedDb.select({
          id: memories.id,
          ...(representationMode === "ordinary-and-protected"
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
          scopeOriginNamespaceId: memories.scopeOriginNamespaceId,
        }).from(memories).where(eq(memories.id, expected.id)).limit(2)
          .for("update"));
      const row = rows[0];
      if (
        rows.length !== 1
        || row === undefined
      ) throw new ForegroundProductChangedError("Selected Memory changed");
      const createdAt = exactDate(row.created_at);
      if (
        (representationMode === "ordinary-and-protected"
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
        executeTypedConversationProductQuery(tx,
          conversationProductTypedDb.select({
            namespaceId: memoryNamespaces.namespaceId,
          }).from(memoryNamespaces).where(
            eq(memoryNamespaces.memoryId, expected.id),
          ).orderBy(asc(memoryNamespaces.namespaceId))),
        executeTypedConversationProductQuery(tx,
          conversationProductTypedDb.select({ origin: memoryScopes.origin })
            .from(memoryScopes).where(eq(memoryScopes.memoryId, expected.id))
            .orderBy(asc(memoryScopes.scopeId))),
      ]);
      const accessNamespaceIds = resolveRequiredMemoryNamespaceIds({
        namespaceIds: namespaceRows.map((entry) => entry.namespace_id),
        scopeOrigins: scopeRows.map((entry) => {
          if (entry.origin !== "seed" && entry.origin !== "scope") {
            throw new TypeError("Memory scope origin is invalid");
          }
          return entry.origin;
        }),
        originWritableNamespaceId: row.scope_origin_namespace_id,
      });
      const expectedContentRevision = row.content_revision;
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
      const plaintextBytes = representationMode === "protected-only"
          || ordinaryType === null
          || ordinaryContent === null
        ? null
        : encodeMemoryPayloadV1({
          formatVersion: 1,
          type: ordinaryType,
          content: ordinaryContent,
        });
      let targetContentRevision = expectedContentRevision;
      let requestCommitment: Uint8Array = new Uint8Array(32);
      let completedRepairReceipt: true | undefined;
      if (row.crypto_object_id === null && plaintextBytes !== null) {
        const baseRevision = Math.max(1, expectedContentRevision);
        const lifecycleRows = await executeTypedConversationProductQuery(tx,
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
          )).orderBy(desc(memoryCryptoRevisions.contentRevision)).limit(1));
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
          await executeTypedConversationProductQuery(tx,
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
        const lifecycleRows = await executeTypedConversationProductQuery(tx,
          conversationProductTypedDb.select({
            allocationRequestDigest:
              memoryCryptoRevisions.allocationRequestDigest,
            completion: memoryCryptoRevisions.completion,
            disposition: memoryCryptoRevisions.disposition,
          }).from(memoryCryptoRevisions).where(and(
            eq(memoryCryptoRevisions.memoryId, expected.id),
            eq(memoryCryptoRevisions.contentRevision, expectedContentRevision),
            eq(memoryCryptoRevisions.cryptoObjectId, row.crypto_object_id),
          )).limit(2));
        const lifecycle = lifecycleRows[0];
        if (lifecycleRows.length === 1 && lifecycle !== undefined
          && lifecycle.completion === "complete"
          && lifecycle.disposition === "mapped") {
          requestCommitment = lifecycle.allocation_request_digest.slice();
          completedRepairReceipt = true;
        }
      }
      sources.push(Object.freeze({
        memory: Object.freeze({
          ...expected,
          type: ordinaryType,
          content: ordinaryContent,
        }),
        representationMode,
        expectedContentRevision,
        targetContentRevision,
        existingObjectId: row.crypto_object_id,
        expectedAccessRevision: row.crypto_access_revision,
        accessNamespaceIds,
        createdAt: createdAt.getTime(),
        plaintextBytes,
        requestCommitment,
        ...(completedRepairReceipt === true ? { completedRepairReceipt } : {}),
      }));
    }
    return Object.freeze(sources);
  }, { isolationLevel: "serializable" });
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

export async function attachPostgresForegroundMemoryRepair(input:
  ForegroundMemoryRepairAttachment & (
    | Readonly<{ product: ConversationProductPostgresHandle }>
    | Readonly<{
      canonical: ConversationProductCanonicalTransactionRunner;
      expectedPolicyRevision: number;
      authorizeSource(transaction: CanonicalTranscriptTx): Promise<boolean>;
    }>
  )): Promise<"attached" | "replayed" | "conflict"> {
  if (
    input.source.plaintextBytes === null
    || input.source.memory.type === null
    || input.source.memory.content === null
  ) return "conflict";
  const ordinaryType = input.source.memory.type;
  const ordinaryContent = input.source.memory.content;
  const expectedObjectId = deriveMemoryCryptoObjectIdV1({
    memoryId: input.source.memory.id,
    contentRevision: input.source.targetContentRevision,
  });
  if (
    input.objectId !== expectedObjectId
    || !equalBytes(input.requestCommitment, input.source.requestCommitment)
  ) return "conflict";
  const fingerprint = fingerprintRequiredMemoryNamespaces(
    input.source.accessNamespaceIds,
  );
  const attach = async (tx: ConversationProductPostgresExecutor) => {
      const rows = await executeTypedConversationProductQuery(tx,
        conversationProductTypedDb.select({
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
        }).from(memories).where(eq(
          memories.id,
          input.source.memory.id,
        )).limit(2));
      const row = rows[0];
      if (
        rows.length !== 1
        || row === undefined
        || row.type !== input.source.memory.type
        || row.content !== input.source.memory.content
        || row.importance !== input.source.memory.importance
        || row.tier !== input.source.memory.tier
        || exactDate(row.created_at).getTime()
          !== input.source.memory.createdAt.getTime()
      ) return "conflict";
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
      if (!equalStrings(currentNamespaceIds, input.source.accessNamespaceIds)) {
        return "conflict";
      }
      const replay = (
        row.content_revision === input.source.targetContentRevision
        && row.crypto_object_id === input.objectId
        && row.crypto_access_revision === 0
        && row.crypto_mapping_state === "verified"
        && equalBytes(row.crypto_required_namespace_fingerprint, fingerprint)
      );
      if (!replay && (
        row.content_revision !== input.source.expectedContentRevision
        || row.crypto_object_id !== null
      )) return "conflict";
      const lifecycleRows = await executeTypedConversationProductQuery(tx,
        conversationProductTypedDb.select({
          objectId: memoryCryptoRevisions.cryptoObjectId,
          allocationRequestDigest:
            memoryCryptoRevisions.allocationRequestDigest,
          requiredNamespaceFingerprint:
            memoryCryptoRevisions.requiredNamespaceFingerprint,
          completion: memoryCryptoRevisions.completion,
          disposition: memoryCryptoRevisions.disposition,
        }).from(memoryCryptoRevisions).where(and(
          eq(memoryCryptoRevisions.memoryId, input.source.memory.id),
          eq(
            memoryCryptoRevisions.contentRevision,
            input.source.targetContentRevision,
          ),
        )).limit(2));
      const lifecycle = lifecycleRows[0];
      if (
        lifecycleRows.length !== 1
        || lifecycle === undefined
        || lifecycle.crypto_object_id !== input.objectId
        || !equalBytes(
          lifecycle.allocation_request_digest,
          input.requestCommitment,
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
      const completedAt = new Date();
      const completed = await executeTypedConversationProductQuery(tx,
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
          eq(memoryCryptoRevisions.memoryId, input.source.memory.id),
          eq(
            memoryCryptoRevisions.contentRevision,
            input.source.targetContentRevision,
          ),
          eq(memoryCryptoRevisions.cryptoObjectId, input.objectId),
          eq(memoryCryptoRevisions.disposition, "active"),
        )).returning({ sequence: memoryCryptoRevisions.sequence }));
      if (completed.length !== 1) throw new ForegroundProductChangedError(
        "Memory repair lifecycle changed before attachment",
      );
      const updated = await executeTypedConversationProductQuery(tx,
        conversationProductTypedDb.update(memories).set({
          contentRevision: input.source.targetContentRevision,
          cryptoObjectId: input.objectId,
          cryptoAccessRevision: 0,
          cryptoRequiredNamespaceFingerprint: fingerprint,
          cryptoMappingState: "verified",
          updatedAt: completedAt,
        }).where(and(
          eq(memories.id, input.source.memory.id),
          eq(memories.type, ordinaryType),
          eq(memories.content, ordinaryContent),
          eq(memories.contentRevision, input.source.expectedContentRevision),
          isNull(memories.cryptoObjectId),
        )).returning({ id: memories.id }));
      if (updated.length !== 1) throw new ForegroundProductChangedError(
        "Memory changed before repair attachment",
      );
      return "attached" as const;
  };
  try {
    if ("canonical" in input) {
      return await input.canonical.transaction(async (transaction, executor) => {
        await acquireEncryptionPublicationFence(transaction, {
          expectedRevision: input.expectedPolicyRevision,
          representation: "ordinary_and_protected",
        });
        if (!await input.authorizeSource(transaction)) return "conflict";
        return attach(executor);
      }, { isolationLevel: "serializable" });
    }
    return await input.product.transaction(attach, {
      isolationLevel: "serializable",
    });
  } catch (error) {
    if (isForegroundProductChangedError(error)
      || error instanceof EncryptionPublicationPolicyError
      || error instanceof EncryptionTransitionPolicyConflictError) {
      return "conflict";
    }
    throw error;
  }
}
