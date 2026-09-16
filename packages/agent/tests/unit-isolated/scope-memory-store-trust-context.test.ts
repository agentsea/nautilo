/**
 * M033 Phase 2B — scope-memory-store fail-closed trust-context contract.
 *
 * Runs in its own `bun test` invocation (see `package.json` `test:unit`) so
 * `@nautilo/db` mocks from other unit tests do not pollute the module cache.
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";
import {
  memoryEmbeddingCompatibilityCondition,
  memoryEmbeddingValues,
} from "../../../db/src/utils/memory-embedding";

const FIXTURE_AGENT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const FIXTURE_SCOPE = "cccccccc-cccc-cccc-cccc-cccccccccccc";

beforeAll(() => {
  mock.module("@nautilo/config", () => ({
    fromRuntimeConfig: () => ({
      nautilo_memory_search_limit: 10,
      nautilo_memory_dedup_similarity_threshold: 0.95,
    }),
  }));

  mock.module("../../src/store/embeddings", () => ({
    embedTextWithProvenance: async () => ({
      vector: Array.from({ length: 1536 }, (_, index) => index === 0 ? 0.1 : 0),
      provider: "openai",
      canonicalModel: "text-embedding-test",
      dimensions: 1536,
      contractVersion: 1,
    }),
  }));

  mock.module("@nautilo/db", () => ({
    agentDb: {},
    and: (...args: unknown[]) => args,
    desc: (col: unknown) => col,
    eq: (a: unknown, b: unknown) => [a, b],
    ilike: (col: unknown, pat: unknown) => [col, pat],
    inArray: (col: unknown, vals: unknown) => [col, vals],
    notInArray: (col: unknown, vals: unknown) => [col, vals],
    isNull: (col: unknown) => col,
    lte: (a: unknown, b: unknown) => [a, b],
    lt: (a: unknown, b: unknown) => [a, b],
    or: (...args: unknown[]) => args,
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    memories: {
      id: "id",
      type: "type",
      content: "content",
      importance: "importance",
      tier: "tier",
      createdAt: "createdAt",
      embedding: "embedding",
      contentRevision: "contentRevision",
      agentId: "agentId",
    },
    memoryScopes: { memoryId: "memoryId", scopeId: "scopeId", origin: "origin" },
    memoryNamespaces: { memoryId: "memoryId", namespaceId: "namespaceId" },
    memoryCryptoOperations: { operationId: "operationId" },
    memoryCryptoRevisions: { memoryId: "memoryId" },
    getSharedDirectAgentDb: () => ({}),
    memoryEmbeddingValues,
    memoryEmbeddingCompatibilityCondition,
    withTrustContext: async <T>(
      ctx: { userId: string; agentId?: string },
      fn: (tx: unknown) => Promise<T>,
    ): Promise<T> => {
      if (!ctx.userId || ctx.userId.length === 0) {
        throw new Error(
          "withTrustContext: ctx.userId is required (non-empty string). " +
            "Pass the authenticated speaker's users.id.",
        );
      }
      return fn({});
    },
  }));
});

async function importScopeMemoryStore(): Promise<
  typeof import("../../src/store/scope-memory-store")
> {
  const href = new URL("../../src/store/scope-memory-store.ts", import.meta.url).href;
  return import(`${href}?t=${Date.now()}`) as Promise<
    typeof import("../../src/store/scope-memory-store")
  >;
}

const baseOpts = {
  agentId: FIXTURE_AGENT,
  scopeId: FIXTURE_SCOPE,
};

describe("scope-memory-store trust context", () => {
  test("searchScopeMemory rejects empty speakerUserId", async () => {
    const { searchScopeMemory } = await importScopeMemoryStore();
    return expect(
      searchScopeMemory({ ...baseOpts, speakerUserId: "", query: "test" }),
    ).rejects.toThrow(/userId is required/);
  });

  test("saveScopeMemory rejects empty speakerUserId", async () => {
    const { saveScopeMemory } = await importScopeMemoryStore();
    return expect(
      saveScopeMemory({ ...baseOpts, speakerUserId: "", type: "fact", content: "x" }),
    ).rejects.toThrow(/userId is required/);
  });

  test("replaceScopeMemory rejects empty speakerUserId", async () => {
    const { replaceScopeMemory } = await importScopeMemoryStore();
    return expect(
      replaceScopeMemory({
        ...baseOpts,
        speakerUserId: "",
        memoryId: "11111111-1111-4111-8111-111111111111",
        content: "x",
      }),
    ).rejects.toThrow(/userId is required/);
  });

  test("demoteScopeMemory rejects empty speakerUserId", async () => {
    const { demoteScopeMemory } = await importScopeMemoryStore();
    return expect(
      demoteScopeMemory({
        ...baseOpts,
        speakerUserId: "",
        memoryId: "11111111-1111-4111-8111-111111111111",
      }),
    ).rejects.toThrow(/userId is required/);
  });

  test("promoteScopeMemory rejects empty speakerUserId", async () => {
    const { promoteScopeMemory } = await importScopeMemoryStore();
    return expect(
      promoteScopeMemory({
        ...baseOpts,
        speakerUserId: "",
        memoryId: "11111111-1111-4111-8111-111111111111",
      }),
    ).rejects.toThrow(/userId is required/);
  });
});
