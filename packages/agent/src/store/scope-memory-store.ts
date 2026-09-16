/**
 * M033 Phase 2B — scope-scoped memory CRUD via `agentDb` + `withAgentTrustContext`.
 */
import {
  and,
  agentDb as db,
  desc,
  eq,
  ilike,
  lte,
  lt,
  or,
  memories,
  memoryNamespaces,
  memoryScopes,
  memoryEmbeddingValues,
  memoryEmbeddingCompatibilityCondition,
  notInArray,
  sql,
} from "@nautilo/db";
import { embedTextWithProvenance, type EmbeddingWithProvenanceV1 } from "./embeddings";
import { fromRuntimeConfig } from "@nautilo/config";
import { log } from "@nautilo/logger";
import { withAgentTrustContext, withSerializableAgentTrustContext } from "./trust-agent-db";
import type {
  HardDeleteMemoryResult,
  MemoryDetail,
  MemoryListItem,
  MemoryResult,
} from "./memory-store";
import { encodeMemoryListCursor } from "./memory-store";
import {
  emitMemoryAudit,
  memoryAuditMetaFromTrust,
  withMemoryAudit,
} from "./memory-write-access";

const SCOPE_ORIGIN = "scope" as const;
const SEED_ORIGIN = "seed" as const;

const DEFAULT_IMPORTANCE: Record<string, number> = {
  identity: 1.0,
  goal: 0.9,
  decision: 0.8,
  preference: 0.7,
  fact: 0.6,
  event: 0.5,
  observation: 0.4,
  todo: 0.3,
};

function vectorLiteral(v: readonly number[]): string {
  return `[${v.join(",")}]`;
}

export class ScopeMemoryMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeMemoryMutationError";
  }
}

export async function searchScopeMemory(opts: {
  speakerUserId: string;
  agentId: string;
  scopeId: string;
  query: string;
  limit?: number;
  includeArchive?: boolean;
  mode?: "text" | "vector";
  signal?: AbortSignal;
}): Promise<MemoryResult[]> {
  const config = fromRuntimeConfig();
  const {
    speakerUserId,
    agentId,
    scopeId,
    query,
    limit = config.nautilo_memory_search_limit,
    includeArchive = false,
    mode,
  } = opts;

  if (mode === "text") {
    return withAgentTrustContext(
      { userId: speakerUserId, agentId },
      async (tx) => {
        const handle = tx as unknown as typeof db;
        return searchScopeByText(handle, query, limit, includeArchive, scopeId, agentId);
      },
    );
  }

  const embedding = await embedTextWithProvenance(query, opts.signal);

  const vectorRows = await withAgentTrustContext(
    { userId: speakerUserId, agentId },
    async (tx) => {
      const handle = tx as unknown as typeof db;
      return searchScopeByVector(
        handle,
        embedding,
        limit,
        includeArchive,
        scopeId,
        agentId,
      );
    },
  );
  if (mode === "vector") return vectorRows;
  if (vectorRows.length > 0) return vectorRows;

  return withAgentTrustContext(
    { userId: speakerUserId, agentId },
    async (tx) => {
      const handle = tx as unknown as typeof db;
      return searchScopeByText(
        handle,
        query,
        limit,
        includeArchive,
        scopeId,
        agentId,
      );
    },
  );
}

async function searchScopeByVector(
  handle: typeof db,
  embedding: EmbeddingWithProvenanceV1,
  limit: number,
  includeArchive: boolean,
  scopeId: string,
  agentId: string,
): Promise<MemoryResult[]> {
  // M127: scope visibility is enforced via the `memory_scopes` junction
  // + RLS scope branch on `agent_scopes`. `agentId` stays on the
  // signature for trust-context routing only.
  void agentId;
  const distance = sql<number>`${memories.embedding} <=> ${vectorLiteral(embedding.vector)}::vector`;
  const ranked = handle.selectDistinctOn([memories.id], {
    id: memories.id, type: memories.type, content: memories.content,
    importance: memories.importance, tier: memories.tier, createdAt: memories.createdAt,
    score: sql<number>`1 - (${distance})`.as("similarity"),
  }).from(memories).innerJoin(memoryScopes, eq(memoryScopes.memoryId, memories.id))
    .where(and(
      eq(memoryScopes.scopeId, scopeId),
      includeArchive ? undefined : lte(memories.tier, 2),
      memoryEmbeddingCompatibilityCondition(embedding),
    )).orderBy(memories.id, distance).as("ranked");
  const rows = await handle.select().from(ranked).orderBy(desc(ranked.score)).limit(limit);
  return rows.map((row) => {
    if (row.content === null || row.type === null) {
      throw new Error(`Memory ${row.id} ordinary content is unavailable`);
    }
    return { ...row, content: row.content, type: row.type };
  });
}

async function searchScopeByText(
  handle: typeof db,
  query: string,
  limit: number,
  includeArchive: boolean,
  scopeId: string,
  agentId: string,
): Promise<MemoryResult[]> {
  // M127: scope isolation is enforced via the `memory_scopes` junction
  // + RLS scope branch. `agentId` stays on the signature for
  // trust-context routing only.
  void agentId;
  const rows = await handle
    .selectDistinct({
      id: memories.id,
      type: memories.type,
      content: memories.content,
      importance: memories.importance,
      tier: memories.tier,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .innerJoin(memoryScopes, eq(memoryScopes.memoryId, memories.id))
    .where(
      and(
        eq(memoryScopes.scopeId, scopeId),
        ilike(memories.content, `%${query}%`),
        ...(includeArchive ? [] : [lte(memories.tier, 2)]),
      ),
    )
    .orderBy(desc(memories.importance), desc(memories.createdAt))
    .limit(limit);

  return rows.map((r) => {
    if (r.content === null || r.type === null) {
      throw new Error(`Memory ${r.id} ordinary content is unavailable`);
    }
    return {
      id: r.id,
      type: r.type,
      content: r.content,
      importance: r.importance,
      tier: r.tier,
      score: 0,
      createdAt: r.createdAt,
    };
  });
}

export async function saveScopeMemory(opts: {
  speakerUserId: string;
  agentId: string;
  scopeId: string;
  type: string;
  content: string;
  importance?: number;
}): Promise<{ id: string; action: "created" | "updated"; similarity?: number }> {
  const audit = { kind: "memory.edit" as const, action: "save" as const, scopeId: opts.scopeId,
    actorId: opts.speakerUserId, ip: "" };
  try {
    const embedding = await embedTextWithProvenance(opts.content);
    const result = await withSerializableAgentTrustContext(
      { userId: opts.speakerUserId, agentId: opts.agentId },
      (tx) => saveScopeMemoryWithDb(tx as unknown as typeof db, opts, { embedding }),
    );
    emitMemoryAudit({ ...audit, memoryId: result.id, outcome: "success" });
    return result;
  } catch (error) {
    emitMemoryAudit({ ...audit, memoryId: "unknown", outcome: "failure", errorKind: error instanceof Error ? error.name : "Error" });
    throw error;
  }
}

export async function saveScopeMemoryWithDb(handle: typeof db, opts: {
  speakerUserId: string;
  agentId: string;
  scopeId: string;
  type: string;
  content: string;
  importance?: number;
}, prepared?: { embedding: EmbeddingWithProvenanceV1; id?: string; expectedDedupId?: string | null }): Promise<{ id: string; action: "created" | "updated"; similarity?: number }> {
  const { scopeId, type, content } = opts;
  const importance = opts.importance ?? DEFAULT_IMPORTANCE[type] ?? 0.6;
  const embedding = prepared?.embedding ?? await embedTextWithProvenance(content);
  const top = await findScopeMemorySaveTargetWithDb(handle, opts.scopeId, embedding);
  if (top) {
    if (prepared && "expectedDedupId" in prepared && prepared.expectedDedupId !== top.id) throw new Error("memory_dedup_changed");
    log(`[scope-memory-store] Dedup: updating scope memory ${top.id} (similarity: ${top.score.toFixed(3)})`);
    await handle.update(memories).set({
      content, type, importance,
      ...memoryEmbeddingValues(embedding, sql`${memories.contentRevision}`),
      updatedAt: new Date(),
    }).where(eq(memories.id, top.id));
    return { id: top.id, action: "updated", similarity: top.score };
  }

  if (prepared?.expectedDedupId) throw new Error("memory_dedup_changed");
  const id = prepared?.id ?? crypto.randomUUID();
  // M127: row-level Memory access is namespace-only. Scope isolation
  // comes from `memory_scopes` + RLS scope branch on `agent_scopes`.
  await handle.insert(memories).values({
    id, tier: 1, type, content, importance, ...memoryEmbeddingValues(embedding, 0),
  });

  await handle.insert(memoryScopes).values({
    memoryId: id,
    scopeId,
    origin: SCOPE_ORIGIN,
  });

  log(`[scope-memory-store] Created scope memory ${id}`);
  return { id, action: "created" as const };
}

async function requireScopeOriginRow(
  handle: typeof db,
  agentId: string,
  scopeId: string,
  memoryId: string,
): Promise<void> {
  const rows = await handle
    .select({ origin: memoryScopes.origin })
    .from(memoryScopes)
    .innerJoin(memories, eq(memories.id, memoryScopes.memoryId))
    .where(
      and(
        eq(memoryScopes.scopeId, scopeId),
        eq(memoryScopes.memoryId, memoryId),
      ),
    )
    .limit(1);
  // M127: row-level Memory access is namespace-only — visibility for
  // scope mutation is enforced by the scope junction + RLS scope branch.
  void agentId;
  const row = rows[0];
  if (!row) {
    throw new ScopeMemoryMutationError(
      "Memory not found in this scope, or it is not visible to this agent.",
    );
  }
  if (row.origin === SEED_ORIGIN) {
    throw new ScopeMemoryMutationError(
      "This memory was attached as context (seed) and cannot be modified from the subagent. Ask the parent agent to update room memory instead.",
    );
  }
}

export async function replaceScopeMemory(opts: {
  speakerUserId: string;
  agentId: string;
  scopeId: string;
  memoryId: string;
  content: string;
}): Promise<void> {
  const auditMeta = memoryAuditMetaFromTrust({
    userId: opts.speakerUserId,
    auditActorId: opts.speakerUserId,
  });

  await withAgentTrustContext(
    { userId: opts.speakerUserId, agentId: opts.agentId },
    async (tx) => {
      const handle = tx as unknown as typeof db;
      await withMemoryAudit(
        {
          kind: "memory.edit",
          memoryId: opts.memoryId,
          action: "replace",
          scopeId: opts.scopeId,
        },
        auditMeta,
        () => replaceScopeMemoryWithDb(handle, opts),
      );
    },
  );
}

export async function replaceScopeMemoryWithDb(handle: typeof db, opts: {
  speakerUserId: string;
  agentId: string;
  scopeId: string;
  memoryId: string;
  content: string;
}, preparedEmbedding?: EmbeddingWithProvenanceV1): Promise<void> {

  await requireScopeOriginRow(handle, opts.agentId, opts.scopeId, opts.memoryId);
  const existing = await handle
    .select({ content: memories.content })
    .from(memories)
    .where(eq(memories.id, opts.memoryId))
    .limit(1);
  if (existing[0]?.content === opts.content) {
    await handle
      .update(memories)
      .set({ updatedAt: new Date() })
      .where(eq(memories.id, opts.memoryId));
    return;
  }
  const embedding = preparedEmbedding ?? await embedTextWithProvenance(opts.content);
  await handle.update(memories).set({
    content: opts.content,
    ...memoryEmbeddingValues(embedding, sql`${memories.contentRevision}`),
    updatedAt: new Date(),
  }).where(eq(memories.id, opts.memoryId));
}

export async function demoteScopeMemory(opts: {
  speakerUserId: string;
  agentId: string;
  scopeId: string;
  memoryId: string;
}): Promise<void> {
  const auditMeta = memoryAuditMetaFromTrust({
    userId: opts.speakerUserId,
    auditActorId: opts.speakerUserId,
  });

  await withAgentTrustContext(
    { userId: opts.speakerUserId, agentId: opts.agentId },
    async (tx) => {
      const handle = tx as unknown as typeof db;
      await withMemoryAudit(
        {
          kind: "memory.delete",
          memoryId: opts.memoryId,
          mode: "archive",
          scopeId: opts.scopeId,
        },
        auditMeta,
        () => demoteScopeMemoryWithDb(handle, opts),
      );
    },
  );
}

export async function demoteScopeMemoryWithDb(handle: typeof db, opts: {
  speakerUserId: string;
  agentId: string;
  scopeId: string;
  memoryId: string;
}): Promise<void> {

  await requireScopeOriginRow(handle, opts.agentId, opts.scopeId, opts.memoryId);

  const rows = await handle
    .select({ tier: memories.tier })
    .from(memories)
    .where(eq(memories.id, opts.memoryId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ScopeMemoryMutationError(`Memory ${opts.memoryId} not found`);
  if (row.tier >= 3) return;

  await handle
    .update(memories)
    .set({
      demotedFrom: row.tier,
      tier: row.tier + 1,
      demotedAt: new Date(),
    })
    .where(eq(memories.id, opts.memoryId));
}

/** Move a scope memory directly into the archived tier in one user action. */
export async function archiveScopeMemory(opts: {
  speakerUserId: string;
  agentId: string;
  scopeId: string;
  memoryId: string;
}): Promise<void> {
  const auditMeta = memoryAuditMetaFromTrust({
    userId: opts.speakerUserId,
    auditActorId: opts.speakerUserId,
  });

  await withAgentTrustContext(
    { userId: opts.speakerUserId, agentId: opts.agentId },
    async (tx) => {
      const handle = tx as unknown as typeof db;
      await withMemoryAudit(
        {
          kind: "memory.delete",
          memoryId: opts.memoryId,
          mode: "archive",
          scopeId: opts.scopeId,
        },
        auditMeta,
        async () => {
          await requireScopeOriginRow(handle, opts.agentId, opts.scopeId, opts.memoryId);

          const rows = await handle
            .select({ tier: memories.tier })
            .from(memories)
            .where(eq(memories.id, opts.memoryId))
            .limit(1);
          const row = rows[0];
          if (!row) throw new ScopeMemoryMutationError(`Memory ${opts.memoryId} not found`);
          if (row.tier >= 3) return;

          await handle
            .update(memories)
            .set({
              demotedFrom: row.tier,
              tier: 3,
              demotedAt: new Date(),
            })
            .where(eq(memories.id, opts.memoryId));
        },
      );
    },
  );
}

export async function promoteScopeMemory(opts: {
  speakerUserId: string;
  agentId: string;
  scopeId: string;
  memoryId: string;
}): Promise<void> {
  const auditMeta = memoryAuditMetaFromTrust({
    userId: opts.speakerUserId,
    auditActorId: opts.speakerUserId,
  });

  await withAgentTrustContext(
    { userId: opts.speakerUserId, agentId: opts.agentId },
    async (tx) => {
      const handle = tx as unknown as typeof db;
      await withMemoryAudit(
        {
          kind: "memory.edit",
          memoryId: opts.memoryId,
          action: "promote",
          scopeId: opts.scopeId,
        },
        auditMeta,
        () => promoteScopeMemoryWithDb(handle, opts),
      );
    },
  );
}

export async function promoteScopeMemoryWithDb(handle: typeof db, opts: {
  speakerUserId: string;
  agentId: string;
  scopeId: string;
  memoryId: string;
}): Promise<void> {

  await requireScopeOriginRow(handle, opts.agentId, opts.scopeId, opts.memoryId);

  const rows = await handle
    .select({ tier: memories.tier })
    .from(memories)
    .where(eq(memories.id, opts.memoryId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ScopeMemoryMutationError(`Memory ${opts.memoryId} not found`);
  if (row.tier <= 1) return;
  if (row.tier !== 2) {
    throw new ScopeMemoryMutationError(
      `Memory ${opts.memoryId} is in tier ${row.tier}; only tier 2 memories can be promoted`,
    );
  }

  await handle
    .update(memories)
    .set({
      tier: 1,
      demotedFrom: null,
      demotedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(memories.id, opts.memoryId));
}

export async function listScopeMemories(opts: {
  speakerUserId: string;
  agentId: string;
  scopeId: string;
  limit?: number;
  cursor?: { createdAt: Date; id: string };
  includeArchive?: boolean;
}): Promise<{ items: MemoryListItem[]; nextCursor: string | null }> {
  return withAgentTrustContext(
    { userId: opts.speakerUserId, agentId: opts.agentId },
    async (tx) => {
      const handle = tx as unknown as typeof db;
      const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
      const tierFilter = opts.includeArchive ? undefined : lte(memories.tier, 2);
      const cursorFilter = opts.cursor
        ? or(
            lt(memories.createdAt, opts.cursor.createdAt),
            and(eq(memories.createdAt, opts.cursor.createdAt), lt(memories.id, opts.cursor.id)),
          )
        : undefined;

      const rows = await handle
        .select({
          id: memories.id,
          type: memories.type,
          content: memories.content,
          importance: memories.importance,
          tier: memories.tier,
          createdAt: memories.createdAt,
          updatedAt: memories.updatedAt,
        })
        .from(memories)
        .innerJoin(memoryScopes, eq(memoryScopes.memoryId, memories.id))
        .where(
          and(
            eq(memoryScopes.scopeId, opts.scopeId),
            eq(memoryScopes.origin, SCOPE_ORIGIN),
            ...(tierFilter ? [tierFilter] : []),
            ...(cursorFilter ? [cursorFilter] : []),
          ),
        )
        .orderBy(desc(memories.createdAt), desc(memories.id))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const items: MemoryListItem[] = page.map((row) => ({
        id: row.id,
        type: row.type,
        content: row.content,
        importance: row.importance,
        tier: row.tier,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        namespaceIds: [],
      }));

      let nextCursor: string | null = null;
      if (rows.length > limit) {
        const last = page[page.length - 1];
        if (last) nextCursor = encodeMemoryListCursor(last.createdAt, last.id);
      }
      return { items, nextCursor };
    },
  );
}

export async function getScopeMemoryById(opts: {
  speakerUserId: string;
  agentId: string;
  scopeId: string;
  memoryId: string;
}): Promise<MemoryDetail | null> {
  return withAgentTrustContext(
    { userId: opts.speakerUserId, agentId: opts.agentId },
    async (tx) => {
      const handle = tx as unknown as typeof db;
      const scopeRows = await handle
        .select({ memoryId: memoryScopes.memoryId })
        .from(memoryScopes)
        .where(
          and(
            eq(memoryScopes.scopeId, opts.scopeId),
            eq(memoryScopes.memoryId, opts.memoryId),
            eq(memoryScopes.origin, SCOPE_ORIGIN),
          ),
        )
        .limit(1);
      if (!scopeRows[0]) return null;

      const rows = await handle
        .select({
          id: memories.id,
          type: memories.type,
          content: memories.content,
          importance: memories.importance,
          tier: memories.tier,
          createdAt: memories.createdAt,
          updatedAt: memories.updatedAt,
          demotedAt: memories.demotedAt,
          demotedFrom: memories.demotedFrom,
        })
        .from(memories)
        .where(eq(memories.id, opts.memoryId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;

      return {
        id: row.id,
        type: row.type,
        content: row.content,
        importance: row.importance,
        tier: row.tier,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        demotedAt: row.demotedAt,
        demotedFrom: row.demotedFrom,
        namespaceIds: [],
      };
    },
  );
}

export async function updateScopeMemory(opts: {
  speakerUserId: string;
  agentId: string;
  scopeId: string;
  memoryId: string;
  content?: string;
  importance?: number;
}): Promise<void> {
  const auditMeta = memoryAuditMetaFromTrust({
    userId: opts.speakerUserId,
    auditActorId: opts.speakerUserId,
  });

  await withAgentTrustContext(
    { userId: opts.speakerUserId, agentId: opts.agentId },
    async (tx) => {
      const handle = tx as unknown as typeof db;
      await withMemoryAudit(
        {
          kind: "memory.edit",
          memoryId: opts.memoryId,
          action: "patch",
          scopeId: opts.scopeId,
        },
        auditMeta,
        async () => {
          await requireScopeOriginRow(handle, opts.agentId, opts.scopeId, opts.memoryId);
          const rows = await handle
            .select({ content: memories.content, importance: memories.importance })
            .from(memories)
            .where(eq(memories.id, opts.memoryId))
            .limit(1);
          const row = rows[0];
          if (!row) throw new ScopeMemoryMutationError(`Memory ${opts.memoryId} not found`);

          const nextImportance = opts.importance ?? row.importance;
          const contentChanged = opts.content !== undefined && opts.content !== row.content;

          if (opts.content !== undefined && contentChanged) {
            const nextContent = opts.content;
            const embedding = await embedTextWithProvenance(nextContent);
                      await handle.update(memories).set({
              content: nextContent, importance: nextImportance,
              ...memoryEmbeddingValues(embedding, sql`${memories.contentRevision}`),
              updatedAt: new Date(),
            }).where(eq(memories.id, opts.memoryId));
          } else if (opts.importance !== undefined && opts.importance !== row.importance) {
            await handle
              .update(memories)
              .set({ importance: nextImportance, updatedAt: new Date() })
              .where(eq(memories.id, opts.memoryId));
          }
        },
      );
    },
  );
}

export async function hardDeleteScopeMemory(opts: {
  speakerUserId: string;
  agentId: string;
  scopeId: string;
  memoryId: string;
}): Promise<HardDeleteMemoryResult> {
  const auditMeta = memoryAuditMetaFromTrust({
    userId: opts.speakerUserId,
    auditActorId: opts.speakerUserId,
  });

  return withAgentTrustContext(
    { userId: opts.speakerUserId, agentId: opts.agentId },
    async (tx) => {
      const handle = tx as unknown as typeof db;
      await requireScopeOriginRow(handle, opts.agentId, opts.scopeId, opts.memoryId);

      const nsRows = await handle
        .select({ namespaceId: memoryNamespaces.namespaceId })
        .from(memoryNamespaces)
        .where(eq(memoryNamespaces.memoryId, opts.memoryId));
      if (nsRows.length > 0) {
        return {
          status: "blocked",
          namespaceCount: nsRows.length,
          namespaceIds: nsRows.map((r) => r.namespaceId),
        };
      }

      return withMemoryAudit(
        {
          kind: "memory.delete",
          memoryId: opts.memoryId,
          mode: "hard",
          scopeId: opts.scopeId,
        },
        auditMeta,
        async () => {
          await handle
            .delete(memoryScopes)
            .where(
              and(
                eq(memoryScopes.memoryId, opts.memoryId),
                eq(memoryScopes.scopeId, opts.scopeId),
              ),
            );

          const remainingScopes = await handle
            .select({ scopeId: memoryScopes.scopeId })
            .from(memoryScopes)
            .where(eq(memoryScopes.memoryId, opts.memoryId));
          if (remainingScopes.length > 0) {
            return { status: "detached_only" as const };
          }

          await handle.delete(memories).where(eq(memories.id, opts.memoryId));
          return { status: "deleted" as const };
        },
      );
    },
  );
}

/** Same scope-origin nearest-neighbor rule as canonical save. */
export async function findScopeMemorySaveTarget(opts: { speakerUserId: string; agentId: string; scopeId: string }, embedding: EmbeddingWithProvenanceV1, excludeMemoryIds: string[] = []): Promise<{ id: string; score: number } | null> {
  return withAgentTrustContext({ userId: opts.speakerUserId, agentId: opts.agentId }, (tx) =>
    findScopeMemorySaveTargetWithDb(tx as unknown as typeof db, opts.scopeId, embedding, excludeMemoryIds));
}

async function findScopeMemorySaveTargetWithDb(handle: typeof db, scopeId: string, embedding: EmbeddingWithProvenanceV1, excludeMemoryIds: string[] = []): Promise<{ id: string; score: number } | null> {
  const distance = sql<number>`${memories.embedding} <=> ${vectorLiteral(embedding.vector)}::vector`;
  const rows = await handle.select({ id: memories.id, similarity: sql<number>`1 - (${distance})` })
    .from(memories).innerJoin(memoryScopes, eq(memoryScopes.memoryId, memories.id))
    .where(and(
      eq(memoryScopes.scopeId, scopeId), eq(memoryScopes.origin, SCOPE_ORIGIN),
      memoryEmbeddingCompatibilityCondition(embedding),
      excludeMemoryIds.length ? notInArray(memories.id, excludeMemoryIds) : undefined,
    )).orderBy(distance).limit(1);
  const top = rows[0];
  return top && top.similarity >= fromRuntimeConfig().nautilo_memory_dedup_similarity_threshold
    ? { id: top.id, score: top.similarity } : null;
}
