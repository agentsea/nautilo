import { describe, expect, mock, test } from "bun:test";
import * as bridge from "@nautilo/lattice-bridge";
import * as bridgeServer from "@nautilo/lattice-bridge/server";
import * as runtime from "@nautilo/runtime";
import { MemoryMutationAuthorityError } from "@nautilo/agent";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

type RepositoryInput = Parameters<typeof bridge.createInvocationBoundProtectedAgentMemoryRepository>[0];
let captured: RepositoryInput | undefined;
let repairReaders = 0;
let transactionFailure: unknown;

mock.module("@nautilo/lattice-bridge", () => ({
  ...bridge,
  createInvocationBoundProtectedAgentMemoryRepository(input: RepositoryInput) {
    captured = input;
    return {};
  },
}));
mock.module("@nautilo/lattice-bridge/server", () => ({
  ...bridgeServer,
  PostgresAgentMemoryProductPort: class {},
}));
mock.module("@nautilo/runtime", () => ({
  ...runtime,
  createForegroundDomainMemoryCryptoSession: () => ({ session: {}, completion: {} }),
  createForegroundMemoryHistoryRepairer: () => {
    repairReaders += 1;
    return { protect: async () => ({ status: "verified", memories: [{ id: "memory" }] }) };
  },
}));
mock.module("../../src/routes/foreground-message-product-store", () => ({
  createForegroundProductTransactionContext: async () => ({ handle: {},
    canonicalRunner: { transaction: async () => { throw transactionFailure; } } }),
}));

const { createForegroundMemoryRepository } = await import("../../src/routes/foreground-memory-repository");
const envelope: MemoryAccessEnvelope = {
  ownerId: "human", actorId: "actor", agentId: "agent", roomId: "room",
  readableNamespaces: ["namespace"], mutableNamespaces: ["namespace"],
  writableNamespaces: ["namespace"], toolPolicy: {},
};

describe("production foreground Memory repair mode boundary", () => {
  test("Full rejects a structural dedup candidate before assembling an ordinary repair reader", async () => {
    for (const mode of ["encrypted_only", "shadow_encryption"] as const) {
      for (const shadowBehavior of ["strict", "fallback"] as const) {
        captured = undefined;
        repairReaders = 0;
        await createForegroundMemoryRepository({ envelope,
          policy: { mode, shadowBehavior, revision: 1 },
          resolvePolicy: async () => ({ mode, shadowBehavior, revision: 1 }),
          domain: { subjectUserId: "human", agentId: "agent",
            entrypointId: "foreground.main", entities: {} } as never,
          wakeEffectRecovery() {},
        });
        if (captured === undefined) throw new Error("Production Memory composition was not assembled");
        const input: RepositoryInput = captured;
        const result = await input.repairExactCandidate({
          operationId: "operation",
          authority: { mode: "namespace", subjectUserId: "human", agentId: "agent",
            readableNamespaceIds: ["namespace"], mutableNamespaceIds: ["namespace"],
            writableNamespaceId: "namespace" },
          selection: { memoryId: "memory", contentRevision: 1, score: 1,
            repairRequired: true, repair: { representation: "structural", id: "memory",
              type: null, importance: 1, tier: 1, createdAt: new Date(0), score: 1 } },
        });
        expect(repairReaders).toBe(mode === "encrypted_only" ? 0 : 1);
        expect(result.status).toBe(mode === "encrypted_only" ? "unavailable" : "success");
      }
    }
  });
  test("fallback reports typed authority races but preserves unrelated failures", async () => {
    await createForegroundMemoryRepository({ envelope,
      policy: { mode: "shadow_encryption", shadowBehavior: "fallback", revision: 1 },
      resolvePolicy: async () => ({
        mode: "shadow_encryption" as const,
        shadowBehavior: "fallback" as const,
        revision: 1,
      }),
      domain: { subjectUserId: "human", agentId: "agent",
        entrypointId: "foreground.main", entities: {} } as never,
      wakeEffectRecovery() {},
    });
    if (captured === undefined) throw new Error("Production Memory composition was not assembled");
    const request = { authority: { mode: "namespace" }, plan: {},
      embedding: { provider: "openai" }, content: {}, reason: "encryption_pending" } as never;
    transactionFailure = new MemoryMutationAuthorityError("source_changed");
    expect(await captured.fallbackOrdinary(request)).toEqual({
      status: "unavailable", reason: "stale_revision",
    });
    transactionFailure = new MemoryMutationAuthorityError("memory_unavailable");
    expect(await captured.fallbackOrdinary(request)).toEqual({
      status: "unavailable", reason: "authorization_required",
    });
    for (const failure of [new Error("storage is unavailable"),
      new DOMException("cancelled", "AbortError"), new TypeError("programming defect")]) {
      transactionFailure = failure;
      expect(captured.fallbackOrdinary(request)).rejects.toBe(failure);
    }
  });
});
