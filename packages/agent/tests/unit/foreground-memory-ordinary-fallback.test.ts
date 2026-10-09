import { describe, expect, test } from "bun:test";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import { commitForegroundMemoryOrdinaryFallback } from "../../src/store/memory-store";

describe("foreground Memory ordinary fallback", () => {
  function scopeTransaction(input: Readonly<{
    lifecycleState?: "open" | "closing" | "closed";
    candidate?: Readonly<{ id: string; similarity: number }>;
    failFinalCas?: boolean;
  }> = {}) {
    const inserts: Array<Record<string, unknown>> = [];
    const updates: Array<Record<string, unknown>> = [];
    const selected: unknown[][] = [
      [{ lifecycleState: input.lifecycleState ?? "open" }],
      input.candidate === undefined ? [] : [input.candidate],
    ];
    const transaction = {
      execute: async () => [],
      select: () => {
        const builder: Record<string, unknown> = {};
        for (const method of ["from", "innerJoin", "where", "orderBy", "limit"]) {
          builder[method] = () => builder;
        }
        builder["for"] = async () => selected.shift() ?? [];
        return builder;
      },
      insert: () => ({
        values: async (values: Record<string, unknown>) => {
          inserts.push(values);
        },
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          const index = updates.length;
          return {
            where: () => ({
              returning: async () => input.failFinalCas === true && index === 1
                ? [] : [{ id: "memory-1", sequence: 1n }],
            }),
          };
        },
      }),
    } as unknown as CanonicalTranscriptTx;
    return { transaction, inserts, updates };
  }

  function scopeInput() {
    return {
      operationId: "operation-1",
      agentId: "agent-1",
      memoryId: "memory-1",
      expectedContentRevision: 0,
      resultContentRevision: 1,
      expectedAccessRevision: 0,
      expectedCryptoObjectId: null,
      expectedRequiredNamespaceFingerprint: null,
      reservationDigest: new Uint8Array(32).fill(3),
      reservedCryptoObjectId: "urn:nautilo:memory:memory-1:content:1",
      action: "save" as const,
      type: "fact",
      content: "scope fallback body",
      importance: 0.8,
      expectedDedupId: null,
      scope: {
        subjectUserId: "user-1",
        scopeId: "scope-1",
        originWritableNamespaceId: "namespace-1",
      },
      embedding: new Array<number>(1536).fill(0.2),
      embeddingProvider: "openai" as const,
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536 as const,
      embeddingContractVersion: 1,
      reason: "encryption_pending" as const,
    };
  }

  test("publishes the ordinary row and terminal receipt in one supplied canonical transaction", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const inserts: Array<Record<string, unknown>> = [];
    let rawCalls = 0;
    const transaction = {
      execute: async () => {
        rawCalls += 1;
        return [];
      },
      select: () => { throw new Error("unexpected select builder"); },
      insert: () => ({ values: async (values: Record<string, unknown>) => { inserts.push(values); } }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return {
            where: () => ({
              returning: async () => [{ id: "memory-1", sequence: 1n }],
            }),
          };
        },
      }),
    } as unknown as CanonicalTranscriptTx;

    const outcome = await commitForegroundMemoryOrdinaryFallback(transaction, {
      operationId: "operation-1",
      agentId: "agent-1",
      memoryId: "memory-1",
      expectedContentRevision: 0,
      resultContentRevision: 1,
      expectedAccessRevision: 0,
      expectedCryptoObjectId: null,
      expectedRequiredNamespaceFingerprint: null,
      reservationDigest: new Uint8Array(32).fill(3),
      reservedCryptoObjectId: "urn:nautilo:memory:memory-1:content:1",
      action: "save",
      type: "fact",
      content: "ordinary fallback body",
      importance: 0.8,
      expectedDedupId: null,
      embedding: new Array<number>(1536).fill(0.2),
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
      embeddingContractVersion: 1,
      reason: "encryption_pending",
    });
    expect(outcome).toEqual({ id: "memory-1", action: "created" });

    expect(rawCalls).toBe(0);
    expect(inserts).toHaveLength(1);
    // The ordinary helper stamps the vector without taking revision authority
    // from the enclosing foreground protocol's final compare-and-swap.
    expect(inserts[0]).toMatchObject({ embeddingRevision: 0,
      embeddingProvider: "openai", embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536, embeddingContractVersion: 1 });
    expect(inserts[0]).not.toHaveProperty("contentRevision");
    expect(updates).toHaveLength(3);
    expect(updates[0]).toMatchObject({
      contentRevision: 1,
      cryptoObjectId: null,
      cryptoRequiredNamespaceFingerprint: null,
      cryptoMappingState: "unmapped",
      embeddingRevision: 1,
    });
    expect(updates[1]).toMatchObject({ disposition: "superseded" });
    expect(updates[2]).toMatchObject({
      completion: "ordinary_fallback",
      disposition: "complete",
      ordinaryFallbackReason: "encryption_pending",
    });
    expect(updates[2]?.["ordinaryFallbackCompletedAt"]).toBeInstanceOf(Date);
    expect(updates[2]).not.toHaveProperty("cryptoCompletedAt");
  });

  test("validates provenance before an unchanged replace can skip re-embedding", async () => {
    let calls = 0;
    const unexpected = () => { calls += 1; throw new Error("no DB work before provenance validation"); };
    const transaction = { execute: unexpected, select: unexpected, insert: unexpected, update: unexpected } as unknown as CanonicalTranscriptTx;
    let failure: unknown;
    try {
      await commitForegroundMemoryOrdinaryFallback(transaction, {
      operationId: "operation-1", agentId: "agent-1", memoryId: "memory-1",
      expectedContentRevision: 0, resultContentRevision: 1, expectedAccessRevision: 0,
      expectedCryptoObjectId: null, expectedRequiredNamespaceFingerprint: null,
      reservationDigest: new Uint8Array(32), reservedCryptoObjectId: "memory-object",
      action: "replace", content: "unchanged", importance: 0.8,
      embedding: new Array<number>(1536).fill(0.2), embeddingProvider: "venice",
      embeddingModel: " ", embeddingDimensions: 1536, embeddingContractVersion: 1,
      reason: "encryption_pending",
    });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toBe("Invalid Memory embedding provenance");
    expect(calls).toBe(0);
  });

  test("creates a Scope origin row and membership in the fallback transaction", async () => {
    const value = scopeTransaction();
    expect(await commitForegroundMemoryOrdinaryFallback(
      value.transaction,
      scopeInput(),
    )).toEqual({ id: "memory-1", action: "created" });
    expect(value.inserts).toHaveLength(2);
    expect(value.inserts[0]).toMatchObject({
      id: "memory-1",
      scopeOriginNamespaceId: "namespace-1",
    });
    expect(value.inserts[1]).toEqual({
      memoryId: "memory-1",
      scopeId: "scope-1",
      origin: "scope",
    });
    expect(value.updates[0]).toMatchObject({
      contentRevision: 1,
      cryptoMappingState: "unmapped",
    });
  });

  test("updates only the exact Scope origin selected by the reservation", async () => {
    const value = scopeTransaction({
      candidate: { id: "memory-1", similarity: 0.96 },
    });
    const result = await commitForegroundMemoryOrdinaryFallback(
      value.transaction,
      { ...scopeInput(), expectedDedupId: "memory-1" },
    );
    expect(result).toEqual({
      id: "memory-1",
      action: "updated",
      similarity: 0.96,
    });
    expect(value.inserts).toEqual([]);
    expect(value.updates[0]).toMatchObject({
      content: "scope fallback body",
      type: "fact",
    });
    expect(value.updates[1]).toMatchObject({ contentRevision: 1 });
  });

  test("rejects a closed Scope before mutation and a stale final revision", async () => {
    const denied = scopeTransaction({ lifecycleState: "closing" });
    await Promise.resolve(expect(commitForegroundMemoryOrdinaryFallback(
      denied.transaction,
      scopeInput(),
    )).rejects.toThrow("memory_unavailable"));
    expect(denied.inserts).toEqual([]);
    expect(denied.updates).toEqual([]);

    const stale = scopeTransaction({ failFinalCas: true });
    await Promise.resolve(expect(commitForegroundMemoryOrdinaryFallback(
      stale.transaction,
      scopeInput(),
    )).rejects.toThrow("source_changed"));
    expect(stale.inserts).toHaveLength(2);
    expect(stale.updates).toHaveLength(1);
  });

  test("rejects a changed Namespace audience before ordinary mutation", async () => {
    let updates = 0;
    const transaction = {
      execute: async () => [],
      select: () => {
        const builder: Record<string, unknown> = {};
        for (const method of ["from", "innerJoin", "where", "orderBy"]) {
          builder[method] = () => builder;
        }
        builder["for"] = async () => [{ namespaceId: "namespace-other" }];
        return builder;
      },
      insert: () => ({ values: async () => undefined }),
      update: () => {
        updates += 1;
        throw new Error("ordinary mutation must not start");
      },
    } as unknown as CanonicalTranscriptTx;
    const { scope: _scope, ...namespaceInput } = scopeInput();
    await Promise.resolve(expect(commitForegroundMemoryOrdinaryFallback(
      transaction,
      {
        ...namespaceInput,
        expectedDedupId: "memory-1",
        action: "save",
        expectedNamespaceIds: ["namespace-expected"],
      },
    )).rejects.toThrow("source_changed"));
    expect(updates).toBe(0);
  });

  test("rejects a non-canonical executor before ordinary mutation", async () => {
    let failure: unknown;
    try {
      await commitForegroundMemoryOrdinaryFallback({} as CanonicalTranscriptTx,
        {} as never);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toContain("actual canonical Drizzle transaction");
  });
});
