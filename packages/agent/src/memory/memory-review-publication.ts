import { agentDb, eq, inArray, memories, memoryNamespaces, memoryScopes } from "@nautilo/db";
import { isScopeMemoryEnvelope, envelopeReadableNamespaces, resolveSpeakerUserId, type MemoryAccessEnvelope } from "@nautilo/trust";
import { fromRuntimeConfig } from "@nautilo/config";
import { embedTextWithProvenance } from "../store/embeddings";
import {
  findMemorySaveTarget, getMemoryById, searchMemory, saveMemoryWithDb,
  replaceMemoryWithDb, demoteMemoryWithDb, promoteMemoryWithDb,
} from "../store/memory-store";
import {
  findScopeMemorySaveTarget, getScopeMemoryById, searchScopeMemory, saveScopeMemoryWithDb,
  replaceScopeMemoryWithDb, demoteScopeMemoryWithDb, promoteScopeMemoryWithDb,
} from "../store/scope-memory-store";
import type { TrustAgentTx } from "../store/trust-agent-db";
import { MemoryMutationAuthorityError, revalidateMemoryMutationAuthority } from "../store/memory-mutation-authority";
import { deliverMemoryAudit, type MemoryAuditSinkInput } from "../store/memory-write-access";
import { deliverAuthoredMemorySemanticChange, type AuthoredMemorySemanticChangeKind } from "../store/authored-memory-semantic-change";
import { createMemoryReviewStaging, memoryReviewFingerprint, MemoryReviewError, type PreparedMemoryWrites } from "./memory-review-staging";

export type MemoryReviewTransaction = TrustAgentTx;
export type PreparedMemoryReview = PreparedMemoryWrites & { envelope: MemoryAccessEnvelope; speakerUserId: string };
export type MemoryReviewEffect = {
  operationId: string;
  memoryId: string;
  action: "created" | "replaced" | "promoted" | "demoted" | "unchanged";
  changeKind?: AuthoredMemorySemanticChangeKind;
  audit: MemoryAuditSinkInput;
};
export type MemoryReviewPublication = {
  counts: { created: number; replaced: number; promoted: number; demoted: number };
  effects: MemoryReviewEffect[];
};

export async function createOrdinaryMemoryReviewStaging(workId: string, envelope: MemoryAccessEnvelope, signal?: AbortSignal) {
  const speakerUserId = await resolveSpeakerUserId(envelope);
  if (!speakerUserId || !envelope.agentId) throw new MemoryReviewError("memory_unavailable");
  const scope = isScopeMemoryEnvelope(envelope) ? { speakerUserId, agentId: envelope.agentId, scopeId: envelope.scopeId } : null;
  const namespaceId = isScopeMemoryEnvelope(envelope) ? undefined : envelope.writableNamespaces[0];
  const trust = { userId: speakerUserId, agentId: envelope.agentId };
  const staging = createMemoryReviewStaging(workId, {
    dedupIncludesArchive: scope !== null,
    dedupThreshold: fromRuntimeConfig().nautilo_memory_dedup_similarity_threshold,
    embed: (content) => embedTextWithProvenance(content, signal),
    async read(memoryId) {
      if (scope) return getScopeMemoryById({ ...scope, memoryId });
      const result = await getMemoryById(memoryId, envelopeReadableNamespaces(envelope), trust);
      if (result === "forbidden") return null;
      if (result && !isScopeMemoryEnvelope(envelope) && !result.namespaceIds.some((id) => envelope.mutableNamespaces.includes(id))) return null;
      return result;
    },
    search: (query, limit, includeArchive) => scope
      ? searchScopeMemory({ ...scope, query, limit, includeArchive, ...(signal ? { signal } : {}) })
      : searchMemory({ ...trust, query, limit, includeArchive, ...(signal ? { signal } : {}), namespaceIds: envelopeReadableNamespaces(envelope) }),
    async findSaveTarget(content, type, embedding, excludeMemoryIds) {
      if (scope) return findScopeMemorySaveTarget(scope, embedding, excludeMemoryIds);
      if (!namespaceId) throw new MemoryReviewError("memory_unavailable");
      return findMemorySaveTarget({ ...trust, namespaceId, content, type }, embedding, excludeMemoryIds);
    },
  });
  return { ...staging, prepared: (): PreparedMemoryReview => ({ ...staging.prepared(), envelope: structuredClone(envelope), speakerUserId }) };
}

/** Caller owns SERIALIZABLE agent-role transaction, current authority/lease fence and receipt write. */
export async function publishPreparedMemoryReview(tx: MemoryReviewTransaction, proposal: PreparedMemoryReview): Promise<MemoryReviewPublication> {
  const handle = tx as unknown as typeof agentDb;
  const { envelope, speakerUserId } = proposal;
  if (!speakerUserId || !envelope.agentId) throw new MemoryReviewError("memory_unavailable");
  const scope = isScopeMemoryEnvelope(envelope) ? { speakerUserId, agentId: envelope.agentId, scopeId: envelope.scopeId } : null;
  await revalidateMemoryReviewAuthority(tx, proposal);
  const ids = proposal.snapshots.map((snapshot) => snapshot.memoryId).sort();
  if (ids.length) {
    const rows = await tx.select().from(memories).where(inArray(memories.id, ids)).orderBy(memories.id).for("update");
    const namespaceRows = await tx.select().from(memoryNamespaces).where(inArray(memoryNamespaces.memoryId, ids)).orderBy(memoryNamespaces.memoryId, memoryNamespaces.namespaceId).for("update");
    const scopeRows = scope ? await tx.select().from(memoryScopes).where(inArray(memoryScopes.memoryId, ids)).orderBy(memoryScopes.memoryId, memoryScopes.scopeId).for("update") : [];
    for (const snapshot of proposal.snapshots) {
      const row = rows.find((candidate) => candidate.id === snapshot.memoryId);
      const namespaceIds = namespaceRows.filter((edge) => edge.memoryId === snapshot.memoryId && envelopeReadableNamespaces(envelope).includes(edge.namespaceId)).map((edge) => edge.namespaceId);
      const authorized = scope
        ? scopeRows.some((edge) => edge.memoryId === snapshot.memoryId && edge.scopeId === scope.scopeId && edge.origin === "scope")
        : !isScopeMemoryEnvelope(envelope) && namespaceIds.some((id) => envelope.mutableNamespaces.includes(id));
      if (!row || row.content === null || !authorized || memoryReviewFingerprint({ ...row, namespaceIds: scope ? [] : namespaceIds }) !== snapshot.fingerprint) throw new MemoryReviewError("source_changed");
    }
  }
  const result: MemoryReviewPublication = { counts: { created: 0, replaced: 0, promoted: 0, demoted: 0 }, effects: [] };
  for (const operation of proposal.operations) {
    const memoryId = operation.memoryId;
    const mutable = isScopeMemoryEnvelope(envelope) ? [] : envelope.mutableNamespaces;
    const namespaceId = isScopeMemoryEnvelope(envelope) ? undefined : envelope.writableNamespaces[0];
    let action: MemoryReviewEffect["action"] = "unchanged";
    let changeKind: AuthoredMemorySemanticChangeKind | undefined;
    if (operation.action === "save") {
      if (!operation.embedding || !operation.content || (!scope && !namespaceId)) throw new MemoryReviewError("invalid_proposal");
      const content = operation.content;
      const prepared = { embedding: operation.embedding, id: memoryId, expectedDedupId: operation.expectedDedupId };
      const saved = await recheckDedup(async () => scope
        ? await saveScopeMemoryWithDb(handle, { ...scope, content, type: operation.type }, prepared)
        : await saveMemoryWithDb(handle, { userId: speakerUserId, agentId: envelope.agentId, namespaceId: namespaceId!, content, type: operation.type }, prepared));
      if (saved.id !== memoryId) throw new MemoryReviewError("source_changed");
      action = saved.action === "created" ? "created" : "replaced";
      if (saved.action === "updated") changeKind = "replace";
    } else {
      const [before] = await tx.select({ content: memories.content, tier: memories.tier }).from(memories).where(eq(memories.id, memoryId));
      if (!before) throw new MemoryReviewError("source_changed");
      if (operation.action === "replace") {
        if (!operation.content || (before.content !== operation.content && !operation.embedding)) throw new MemoryReviewError("invalid_proposal");
        if (scope) await replaceScopeMemoryWithDb(handle, { ...scope, memoryId, content: operation.content }, operation.embedding);
        else await replaceMemoryWithDb(handle, memoryId, operation.content, mutable, operation.embedding);
        if (before.content !== operation.content) { action = "replaced"; changeKind = "replace"; }
      } else if (operation.action === "promote") {
        if (scope) await promoteScopeMemoryWithDb(handle, { ...scope, memoryId });
        else await promoteMemoryWithDb(handle, memoryId, mutable);
        if (before.tier !== 1) { action = "promoted"; changeKind = "restore"; }
      } else {
        if (scope) await demoteScopeMemoryWithDb(handle, { ...scope, memoryId });
        else await demoteMemoryWithDb(handle, memoryId, mutable);
        if (before.tier < 3) { action = "demoted"; changeKind = "demote"; }
      }
    }
    if (action !== "unchanged") result.counts[action] += 1;
    result.effects.push({ operationId: operation.operationId, memoryId, action,
      ...(changeKind ? { changeKind } : {}),
      audit: { kind: operation.action === "remove" ? "memory.delete" : "memory.edit", memoryId, outcome: "success", actorId: speakerUserId, ip: "",
        ...(operation.action === "remove" ? { mode: "archive" as const } : { action: operation.action }),
        ...(scope ? { scopeId: scope.scopeId } : namespaceId ? { namespaceId } : {}),
      },
    });
  }
  return result;
}

/** At-least-once effect delivery: consumers identify repeats by the stable operation ID. */
export async function deliverMemoryReviewEffect(effect: MemoryReviewEffect): Promise<void> {
  if (effect.changeKind) await deliverAuthoredMemorySemanticChange({ memoryId: effect.memoryId,
    changeKind: effect.changeKind, changeRef: `memory-change:stable:${effect.operationId}` });
  deliverMemoryAudit({ ...effect.audit, operationId: effect.operationId });
}

/** Reuse canonical Room locks and Namespace containment; never trust a captured envelope at commit. */
export async function revalidateMemoryReviewAuthority(tx: MemoryReviewTransaction, proposal: Pick<PreparedMemoryReview, "envelope" | "speakerUserId" | "operations">): Promise<void> {
  try {
    await revalidateMemoryMutationAuthority(tx, {
      envelope: proposal.envelope,
      speakerUserId: proposal.speakerUserId,
      mutation: proposal.operations.length > 0,
    });
  } catch (error) {
    if (error instanceof MemoryMutationAuthorityError) {
      throw new MemoryReviewError(error.reason);
    }
    throw error;
  }
}

async function recheckDedup<T>(publish: () => Promise<T>): Promise<T> {
  try { return await publish(); } catch (error) {
    if (error instanceof Error && error.message === "memory_dedup_changed") throw new MemoryReviewError("source_changed");
    throw error;
  }
}
