import { describe, expect, mock, test } from "bun:test";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

const realBridge = await import("@nautilo/lattice-bridge");
const realBridgeServer = await import("@nautilo/lattice-bridge/server");
const realRuntime = await import("@nautilo/runtime");
const realEffects = await import(
  "../../src/routes/foreground-memory-effect-receipts"
);
const realPublication = await import(
  "../../src/routes/foreground-memory-publication-authority"
);

const productInputs: Readonly<Record<string, unknown>>[] = [];

mock.module("@nautilo/lattice-bridge", () => ({
  ...realBridge,
  createInvocationBoundProtectedAgentMemoryRepository: (input: {
    product: { searchCandidates(request: unknown): Promise<unknown> };
  }) => ({
    search: (request: unknown) => input.product.searchCandidates(request),
    save: () => Promise.resolve({ status: "unavailable",
      reason: "authorization_required" }),
    replace: () => Promise.resolve({ status: "unavailable",
      reason: "authorization_required" }),
    setTier: () => Promise.resolve({ status: "unavailable",
      reason: "authorization_required" }),
  }),
}));

mock.module("@nautilo/lattice-bridge/server", () => ({
  ...realBridgeServer,
  PostgresAgentMemoryProductPort: class {
    readonly input: Readonly<Record<string, unknown>>;
    constructor(input: Readonly<Record<string, unknown>>) {
      this.input = input;
      productInputs.push(input);
    }
    searchCandidates() {
      return Promise.resolve({ status: "success", value: [] });
    }
  },
}));

mock.module("@nautilo/runtime", () => ({
  ...realRuntime,
  createForegroundDomainMemoryCryptoSession: () => ({
    session: {}, completion: {}, readPreparedPayload: () => null,
  }),
}));

mock.module("../../src/routes/foreground-message-product-store", () => ({
  createForegroundProductTransactionContext: () => Promise.resolve({
    handle: { role: "nautilo_agent" },
    canonicalRunner: { transaction: () => Promise.resolve() },
  }),
}));

mock.module("../../src/routes/foreground-memory-effect-receipts", () => ({
  ...realEffects,
  withForegroundMemoryEffectReceipts: ({ repository }: { repository: unknown }) =>
    repository,
}));

mock.module("../../src/routes/foreground-memory-publication-authority", () => ({
  ...realPublication,
  createForegroundMemoryPublicationAuthority: () => ({
    representation: "protected_only",
    allowOrdinaryFallback: false,
    beforeLocks: () => Promise.resolve(),
  }),
}));

const { createForegroundMemoryRepository } = await import(
  "../../src/routes/foreground-memory-repository"
);

const envelope: MemoryAccessEnvelope = {
  ownerId: "human", actorId: "actor", agentId: "agent", roomId: "room",
  readableNamespaces: ["namespace"], mutableNamespaces: ["namespace"],
  writableNamespaces: ["namespace"], toolPolicy: {},
};

describe("foreground Memory repository held publication", () => {
  test("opens a genuine Agent product context and delegates currentness to the held owner", async () => {
    productInputs.length = 0;
    const held = mock(() => Promise.resolve({ receipt: true }));
    const repository = await createForegroundMemoryRepository({
      envelope,
      policy: { mode: "encrypted_only", shadowBehavior: "strict", revision: 1 },
      resolvePolicy: () => Promise.resolve({ mode: "encrypted_only" as const,
        shadowBehavior: "strict" as const, revision: 1 }),
      domain: { subjectUserId: "human", agentId: "agent",
        entrypointId: "foreground.main", entities: {},
        persist: () => Promise.resolve("created"),
        read: () => Promise.resolve(null) } as never,
      wakeEffectRecovery() {},
      withCurrentPublication: held as never,
    });

    await repository.search({ authority: { mode: "namespace" }, query: "memory",
      limit: 1, includeArchive: false, mode: "vector" } as never);

    const productInput = productInputs.at(-1);
    expect(productInput?.["handle"]).toEqual({ role: "nautilo_agent" });
    const publication = productInput?.["publication"] as {
      representation?: unknown;
      beforeLocks?: unknown;
      withCurrentPublication?: unknown;
    };
    expect(publication.representation).toBe("protected_only");
    expect(publication.beforeLocks).toBeUndefined();
    expect(publication.withCurrentPublication).toBe(held);
  });
});
