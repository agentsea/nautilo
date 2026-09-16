import { createHash } from "node:crypto";
import type { EmbeddingWithProvenanceV1 } from "@nautilo/types";
import type { MemoryDetail, MemoryResult } from "../store/memory-store";

export type MemoryReviewAction = "save" | "replace" | "promote" | "remove";
export type MemoryReviewMutation = {
  action: MemoryReviewAction;
  content?: string;
  type?: string;
  memory_id?: string;
};
export type StagedMemoryOperation = {
  operationId: string;
  action: MemoryReviewAction;
  memoryId: string;
  expectedDedupId: string | null;
  content?: string;
  type: string;
  embedding?: EmbeddingWithProvenanceV1;
};
export type MemoryReviewSnapshot = { memoryId: string; fingerprint: string };
export type PreparedMemoryWrites = {
  operations: StagedMemoryOperation[];
  snapshots: MemoryReviewSnapshot[];
};
export interface MemoryReviewStagingPorts {
  read(id: string): Promise<MemoryDetail | null>;
  search(query: string, limit: number, includeArchive: boolean): Promise<MemoryResult[]>;
  findSaveTarget(content: string, type: string, embedding: EmbeddingWithProvenanceV1, excludeMemoryIds: string[]): Promise<{ id: string; score: number } | null>;
  embed(content: string): Promise<EmbeddingWithProvenanceV1>;
  dedupThreshold: number;
  /** Scope-origin canonical save includes archived rows in deduplication. */
  dedupIncludesArchive?: boolean;
}
export class MemoryReviewError extends Error {
  constructor(readonly code: "invalid_proposal" | "memory_unavailable" | "source_changed" | "embedding_failed" | "iteration_exhausted" | "model_unavailable" | "provider_failed" | "storage_failed" | "cancelled") {
    super(code);
    this.name = "MemoryReviewError";
  }
}
export function memoryReviewFingerprint(row: MemoryDetail): string {
  return createHash("sha256").update(JSON.stringify([
    row.content, row.type, row.importance, row.tier, row.updatedAt.toISOString(),
    row.demotedAt?.toISOString() ?? null, row.demotedFrom,
    [...row.namespaceIds].sort(),
  ])).digest("hex");
}
function sameEmbeddingCohort(
  a: EmbeddingWithProvenanceV1,
  b: EmbeddingWithProvenanceV1,
): boolean {
  return a.provider === b.provider
    && a.canonicalModel === b.canonicalModel
    && a.dimensions === b.dimensions
    && a.contractVersion === b.contractVersion;
}
function validEmbedding(embedding: EmbeddingWithProvenanceV1): boolean {
  return embedding.contractVersion === 1
    && embedding.provider.length > 0
    && embedding.canonicalModel.length > 0
    && embedding.dimensions === embedding.vector.length
    && embedding.vector.length > 0
    && embedding.vector.every((value) => Number.isFinite(value));
}
function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return -1;
  let dot = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!; aa += a[i]! ** 2; bb += b[i]! ** 2;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : -1;
}
async function storageRead<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (error) {
    if (error instanceof MemoryReviewError) throw error;
    throw new MemoryReviewError("storage_failed");
  }
}
/** Ephemeral model proposal. It never performs a canonical write or stores plaintext durably. */
export function createMemoryReviewStaging(workId: string, ports: MemoryReviewStagingPorts) {
  const operations: StagedMemoryOperation[] = [];
  const snapshots = new Map<string, MemoryReviewSnapshot>();
  const overlay = new Map<string, MemoryDetail & { embedding?: EmbeddingWithProvenanceV1 }>();
  const created = new Set<string>();
  async function read(id: string) {
    const staged = overlay.get(id);
    if (staged) return staged;
    const row = await storageRead(() => ports.read(id));
    if (!row) throw new MemoryReviewError("memory_unavailable");
    snapshots.set(id, { memoryId: id, fingerprint: memoryReviewFingerprint(row) });
    overlay.set(id, row);
    return row;
  }
  return {
    async search(query: string, limit: number, includeArchive: boolean) {
      const rows = await storageRead(() => ports.search(query, limit, includeArchive));
      // Existing semantic ranking stays canonical. Overlay changes prevent stale
      // reads, and pending writes are explicitly returned as additional context.
      const seen = new Set(rows.map((row) => row.id));
      const merged = rows.map((row) => overlay.get(row.id) ?? row);
      for (const row of overlay.values()) if (!seen.has(row.id)) merged.push(row);
      return merged.filter((row) => includeArchive || row.tier <= 2);
    },
    async mutate(input: MemoryReviewMutation): Promise<string> {
      if (!input || !["save", "replace", "promote", "remove"].includes(input.action)) throw new MemoryReviewError("invalid_proposal");
      if ((input.action === "save" || input.action === "replace") && !input.content?.trim()) throw new MemoryReviewError("invalid_proposal");
      if (input.action !== "save" && !input.memory_id) throw new MemoryReviewError("invalid_proposal");
      const type = input.type ?? "fact";
      const existingTarget = input.action === "save" ? null : await read(input.memory_id!);
      let embedding: EmbeddingWithProvenanceV1 | undefined;
      if (input.action === "save" || (input.action === "replace" && existingTarget?.content !== input.content)) {
        try { embedding = await ports.embed(input.content!); } catch { throw new MemoryReviewError("embedding_failed"); }
        if (!validEmbedding(embedding)) throw new MemoryReviewError("embedding_failed");
      }
      let memoryId = input.memory_id ?? "";
      let expectedDedupId: string | null = null;
      if (input.action === "save") {
        // Unchanged content still uses its canonical stored embedding. Only
        // replaced vectors and newly ineligible archive rows leave that search.
        const excluded = [...overlay].filter(([, row]) => row.embedding !== undefined || (!ports.dedupIncludesArchive && row.tier > 2)).map(([id]) => id);
        const target = await storageRead(() => ports.findSaveTarget(input.content!, type, embedding!, excluded));
        let best = target;
        for (const [id, row] of overlay) {
          if (!row.embedding || !sameEmbeddingCohort(embedding!, row.embedding)
            || (!ports.dedupIncludesArchive && row.tier > 2)) continue;
          const score = cosine(embedding!.vector, row.embedding.vector);
          if (score >= ports.dedupThreshold && (!best || score > best.score)) best = { id, score };
        }
        expectedDedupId = best?.id ?? null;
        memoryId = expectedDedupId ?? crypto.randomUUID();
        if (expectedDedupId) await read(expectedDedupId);
        else created.add(memoryId);
      }
      const previous = created.has(memoryId) && !overlay.has(memoryId) ? null : await read(memoryId);
      if (input.action === "promote" && previous && previous.tier > 2) throw new MemoryReviewError("invalid_proposal");
      const row: MemoryDetail & { embedding?: EmbeddingWithProvenanceV1 } = previous ? { ...previous } : {
        id: memoryId, type, content: input.content!, importance: 0, tier: 1,
        createdAt: new Date(), updatedAt: new Date(), demotedAt: null, demotedFrom: null, namespaceIds: [],
      };
      if ((input.action === "save" || input.action === "replace") && input.content !== undefined) row.content = input.content;
      if (input.action === "save") row.type = type;
      if (embedding) row.embedding = embedding;
      if (input.action === "remove" && row.tier < 3) { row.demotedFrom = row.tier; row.tier += 1; }
      if (input.action === "promote") { row.tier = 1; row.demotedFrom = null; row.demotedAt = null; }
      overlay.set(memoryId, row);
      const operationId = `${workId}:mutation:${operations.length}`;
      operations.push({ operationId, action: input.action, memoryId, expectedDedupId, type,
        ...(input.content === undefined ? {} : { content: input.content }), ...(embedding ? { embedding } : {}),
      });
      return `Staged ${input.action} (id: ${memoryId}); publication follows complete review.`;
    },
    prepared(): PreparedMemoryWrites { return { operations: [...operations], snapshots: [...snapshots.values()] }; },
  };
}
