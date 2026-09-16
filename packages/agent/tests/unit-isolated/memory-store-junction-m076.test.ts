/**
 * M076 — memory ↔ namespace junction mechanics without Postgres.
 *
 * These tests **mock `@nautilo/db`**. Bun resolves workspace packages once per
 * process; after any test loads the real `@nautilo/db`, `mock.module` cannot
 * replace bindings for later imports. This file therefore runs in a **separate**
 * `bun test` invocation (see `package.json` `test:unit`) so the module cache is
 * clean — real unit isolation for CI.
 *
 * Mocks: `@nautilo/db`, `@nautilo/logger`, `./embeddings` (relative to memory-store).
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  memoryEmbeddingCompatibilityCondition,
  memoryEmbeddingValues,
} from "../../../db/src/utils/memory-embedding";

const embedding = {
  vector: Array.from({ length: 1536 }, () => 0.02),
  provider: "openai" as const,
  canonicalModel: "text-embedding-test",
  dimensions: 1536,
  contractVersion: 1 as const,
};

beforeEach(() => {
  mock.restore();
});

async function importMemoryStore(): Promise<typeof import("../../src/store/memory-store")> {
  const href = new URL("../../src/store/memory-store.ts", import.meta.url).href;
  const mod = (await import(`${href}?t=${Date.now()}`)) as typeof import(
    "../../src/store/memory-store"
  );
  return mod;
}

function mockLogger(): void {
  mock.module("@nautilo/logger", () => ({
    log: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    setLogLevel: () => {},
    setLogOutput: () => {},
    runWithTurn: <T>(fn: () => T) => fn(),
    getCurrentTurnId: () => undefined,
  }));
}

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]) {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    out += String(values[i]) + (strings[i + 1] ?? "");
  }
  return { as: () => out, toString: () => out };
}

function makeSqlTag() {
  const sqlTag = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => fakeSql(strings, ...values),
    {
      join: (parts: unknown[], sep: unknown) =>
        parts.map((p) => String(p)).join(String(sep)),
    },
  );
  return sqlTag as ((strings: TemplateStringsArray, ...values: unknown[]) => ReturnType<typeof fakeSql>) & {
    join: (parts: unknown[], sep: unknown) => string;
  };
}

interface FakeDbHandle {
  execute: (q: unknown) => Promise<{ rows: unknown[] }>;
  transaction: <T>(fn: (tx: FakeDbHandle) => Promise<T>) => Promise<T>;
  insert: (table: unknown) => {
    values: (values: unknown) => FakeMutationQuery;
  };
  update: (table: unknown) => {
    set: (values: unknown) => { where: (predicate: unknown) => FakeMutationQuery };
  };
  delete: (table: unknown) => {
    where: (predicate: unknown) => FakeMutationQuery;
  };
  select: (projection?: unknown) => { from: (table: unknown) => unknown };
  selectDistinctOn: (columns: unknown[], projection: unknown) => unknown;
}

let currentDbHandle: FakeDbHandle;
const isolationStatements: string[] = [];
const sharedDbHandle = {
  transaction: async <T>(fn: (tx: FakeDbHandle) => Promise<T>) => fn(currentDbHandle),
};

interface FakeMutationQuery extends PromiseLike<unknown[]> {
  onConflictDoNothing: () => FakeMutationQuery;
  returning: (projection: unknown) => Promise<unknown[]>;
}

interface FakeMutation {
  kind: "insert" | "update" | "delete";
  table: unknown;
  values?: unknown;
  predicate?: unknown;
}

function mockUsageModule(): void {
  mock.module("../../src/usage/record-usage", () => ({
    recordLlmUsage: () => {},
  }));
  mock.module("../../src/usage/usage-context", () => ({
    getUsageContext: () => null,
  }));
}

function mockDbModule(opts: {
  execute: (query: unknown, callIndex: number) => Promise<{ rows: unknown[] }>;
  mutate?: (mutation: FakeMutation, callIndex: number) => Promise<unknown[]>;
  namespaceRowsForSelect?: { namespaceId: string }[];
  vectorRows?: unknown[];
  comparisons?: unknown[][];
}) {
  let idx = 0;
  let mutationIndex = 0;
  const nsRows = opts.namespaceRowsForSelect ?? [];
  const mutationQuery = (mutation: FakeMutation): FakeMutationQuery => {
    let result: Promise<unknown[]> | undefined;
    const run = (): Promise<unknown[]> => {
      result ??= opts.mutate?.(mutation, mutationIndex++) ?? Promise.resolve([]);
      return result;
    };
    const query: FakeMutationQuery = {
      onConflictDoNothing: () => query,
      returning: () => run(),
      then: (onfulfilled, onrejected) => run().then(onfulfilled, onrejected),
    };
    return query;
  };
  const ranked = { kind: "ranked" };
  const dbHandle: FakeDbHandle = {
    execute: async (q: unknown) => {
      if (String(q).startsWith("SET TRANSACTION")) { isolationStatements.push(String(q)); return { rows: [] }; }
      return opts.execute(q, idx++);
    },
    transaction: async <T>(fn: (tx: FakeDbHandle) => Promise<T>) => fn(dbHandle),
    insert: (table) => ({
      values: (values) => mutationQuery({ kind: "insert", table, values }),
    }),
    update: (table) => ({
      set: (values) => ({ where: (predicate) => mutationQuery({ kind: "update", table, values, predicate }) }),
    }),
    delete: (table) => ({
      where: (predicate) => mutationQuery({ kind: "delete", table, predicate }),
    }),
    select: () => ({
      from: (table: unknown) => table === ranked
        ? { orderBy: () => ({ limit: async () => opts.vectorRows ?? [] }) }
        : { where: async () => nsRows },
    }),
    selectDistinctOn: () => ({
      from: () => ({ innerJoin: () => ({ where: () => ({ orderBy: () => ({ as: () => ranked }) }) }) }),
    }),
  };
  currentDbHandle = dbHandle;
  mock.module("@nautilo/db", () => ({
    agentDb: dbHandle,
    db: dbHandle,
    memories: { id: "id", type: "type", content: "content", importance: "importance", tier: "tier", createdAt: "created_at", embedding: "embedding", contentRevision: "content_revision" },
    memoryCryptoOperations: {},
    memoryCryptoRevisions: {},
    memoryNamespaces: { memoryId: "memory_id", namespaceId: "namespace_id" },
    getSharedDirectAgentDb: () => sharedDbHandle,
    setTrustContextOnTx: async () => {},
    withTrustContext: async <T>(
      _ctx: unknown,
      fn: (tx: FakeDbHandle) => Promise<T>,
      _db?: unknown,
    ) => fn(dbHandle),
    eq: (...args: unknown[]) => { opts.comparisons?.push(args); return {}; },
    and: () => ({}),
    or: () => ({}),
    isNull: () => ({}),
    sql: makeSqlTag(),
    desc: () => ({}),
    ilike: () => ({}),
    inArray: (...args: unknown[]) => { opts.comparisons?.push(args); return {}; },
    notInArray: () => ({}),
    lte: () => ({}),
    lt: () => ({}),
    getCachedServerModelConfigRow: () => null,
    kickServerModelConfigRefresh: () => {},
    memoryEmbeddingValues,
    memoryEmbeddingCompatibilityCondition,
  }));
  return dbHandle;
}

describe("M076 — attachMemoryToNamespace / detachMemoryFromNamespace", () => {
  test("attach and detach use typed junction mutations and emit only real changes", async () => {
    const mutations: FakeMutation[] = [];
    const events: unknown[] = [];
    mockLogger();
    mockUsageModule();
    mockDbModule({
      execute: async () => ({ rows: [] }),
      mutate: async (mutation, callIndex) => {
        mutations.push(mutation);
        return callIndex === 0 || callIndex === 2 ? [{ memoryId: "changed" }] : [];
      },
    });
    const semanticChanges = await import("../../src/store/authored-memory-semantic-change");
    semanticChanges._resetAuthoredMemorySemanticChangeSinkForTests();
    semanticChanges.installAuthoredMemorySemanticChangeSink(async (event) => {
      events.push(event);
    });
    const { attachMemoryToNamespace, detachMemoryFromNamespace } =
      await importMemoryStore();
    const mid = "550e8400-e29b-41d4-a716-446655440001";
    const nid = "550e8400-e29b-41d4-a716-446655440002";
    await attachMemoryToNamespace(mid, nid);
    await attachMemoryToNamespace(mid, nid);
    expect(mutations.slice(0, 2).map((mutation) => mutation.kind)).toEqual(["insert", "insert"]);
    expect(mutations[0]?.values).toEqual({ memoryId: mid, namespaceId: nid });

    await detachMemoryFromNamespace(mid, nid);
    expect(mutations.map((mutation) => mutation.kind)).toEqual(["insert", "insert", "delete"]);
    expect(events).toHaveLength(2);
    expect(events).toEqual([
      expect.objectContaining({ memoryId: mid, changeKind: "scope" }),
      expect.objectContaining({ memoryId: mid, changeKind: "scope" }),
    ]);
    semanticChanges._resetAuthoredMemorySemanticChangeSinkForTests();
  });
});

describe("M076 — saveMemory + mocked vector path", () => {
  test("insert path writes the full embedding tuple then attaches the namespace", async () => {
    let execCount = 0;
    const batches: unknown[] = [];
    const mutations: FakeMutation[] = [];
    mockLogger();
    mock.module("../../src/store/embeddings", () => ({
      embedTextWithProvenance: async () => embedding,
    }));
    mockDbModule({
      execute: async (q, callIndex) => {
        batches.push(q);
        execCount++;
        if (callIndex === 0) return { rows: [] };
        return { rows: [] };
      },
      mutate: async (mutation) => {
        mutations.push(mutation);
        return [];
      },
    });

    const { saveMemory } = await importMemoryStore();
    const r = await saveMemory({
      userId: "human",
      agentId: "770e8400-e29b-41d4-a716-446655440001",
      type: "fact",
      content: "junction-insert-path",
      namespaceId: "880e8400-e29b-41d4-a716-446655440001",
    });
    expect(r.action).toBe("created");
    expect(isolationStatements).toContain("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(execCount).toBe(0);
    expect(mutations).toHaveLength(2);
    expect(mutations[0]).toMatchObject({ kind: "insert", values: {
      embedding: embedding.vector,
      embeddingRevision: 0,
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-test",
      embeddingDimensions: 1536,
      embeddingContractVersion: 1,
    } });
    expect(mutations[1]?.kind).toBe("insert");
    expect(mutations[1]?.values).toEqual({
      memoryId: r.id,
      namespaceId: "880e8400-e29b-41d4-a716-446655440001",
    });
  });

  test("M127: vector dedup query is namespace-only — no agent_id predicate", async () => {
    const batches: unknown[] = [];
    const comparisons: unknown[][] = [];
    mockLogger();
    mock.module("../../src/store/embeddings", () => ({
      embedTextWithProvenance: async () => embedding,
    }));
    mockDbModule({
      comparisons,
      execute: async (q) => {
        batches.push(q);
        return { rows: [] };
      },
    });
    const agentId = "770e8400-e29b-41d4-a716-446655440055";
    const { saveMemory } = await importMemoryStore();
    await saveMemory({
      userId: "human",
      agentId,
      type: "fact",
      content: "agent-filter-on-vector",
      namespaceId: "880e8400-e29b-41d4-a716-446655440001",
    });
    // Post-M127 the dedup SQL no longer predicates by agent_id.
    expect(comparisons).toContainEqual([
      "namespace_id",
      ["880e8400-e29b-41d4-a716-446655440001"],
    ]);
    expect(JSON.stringify(comparisons)).not.toContain(agentId);
    expect(batches.every((batch) => !String(batch).match(/agent_id|owner_id|persona_id/i))).toBe(true);
  });

  test("dedup blocked by namespace assert falls through to typed insert plus attachment", async () => {
    let execCount = 0;
    const batches: unknown[] = [];
    const mutations: FakeMutation[] = [];
    const writableNs = "880e8400-e29b-41d4-a716-446655440002";
    const otherNs = "880e8400-e29b-41d4-a716-446655440099";
    mockLogger();
    mock.module("../../src/store/embeddings", () => ({
      embedTextWithProvenance: async () => embedding,
    }));
    mockDbModule({
      execute: async (q) => {
        batches.push(q);
        execCount++;
        return { rows: [] };
      },
      mutate: async (mutation) => {
        mutations.push(mutation);
        return [];
      },
      vectorRows: [{ id: "990e8400-e29b-41d4-a716-446655440099", type: "fact", content: "prior", importance: 0.6, tier: 1, createdAt: new Date(), score: 0.99 }],
      namespaceRowsForSelect: [{ namespaceId: otherNs }],
    });

    const { saveMemory } = await importMemoryStore();
    const r = await saveMemory({
      userId: "human",
      agentId: "770e8400-e29b-41d4-a716-446655440022",
      type: "fact",
      content: "dedup-fallthrough-insert",
      namespaceId: writableNs,
    });
    expect(r.action).toBe("created");
    expect(execCount).toBe(0);
    expect(mutations).toHaveLength(2);
    expect(mutations[0]?.kind).toBe("insert");
    expect(mutations[1]?.values).toEqual({ memoryId: r.id, namespaceId: writableNs });
  });

  test("dedup hit runs UPDATE only — no junction INSERT after vector hit", async () => {
    let execCount = 0;
    const batches: unknown[] = [];
    const events: unknown[] = [];
    const mutations: FakeMutation[] = [];
    mockLogger();
    mock.module("../../src/store/embeddings", () => ({
      embedTextWithProvenance: async () => embedding,
    }));
    mockDbModule({
      execute: async (q) => {
        batches.push(q);
        execCount++;
        return { rows: [] };
      },
      vectorRows: [{ id: "990e8400-e29b-41d4-a716-446655440099", type: "fact", content: "prior", importance: 0.6, tier: 1, createdAt: new Date(), score: 0.99 }],
      mutate: async (mutation) => { mutations.push(mutation); return []; },
      namespaceRowsForSelect: [
        { namespaceId: "880e8400-e29b-41d4-a716-446655440002" },
      ],
    });

    const semanticChanges = await import("../../src/store/authored-memory-semantic-change");
    semanticChanges._resetAuthoredMemorySemanticChangeSinkForTests();
    semanticChanges.installAuthoredMemorySemanticChangeSink(async (event) => {
      events.push(event);
    });
    const { saveMemory } = await importMemoryStore();
    const r = await saveMemory({
      userId: "human",
      agentId: "770e8400-e29b-41d4-a716-446655440002",
      type: "fact",
      content: "dedup-no-junction-touch",
      namespaceId: "880e8400-e29b-41d4-a716-446655440002",
    });
    expect(r.action).toBe("updated");
    expect(execCount).toBe(0);
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({ kind: "update", values: {
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-test",
      embeddingDimensions: 1536,
      embeddingContractVersion: 1,
    } });
    expect(mutations.some((mutation) => mutation.kind === "insert")).toBe(false);
    expect(events).toEqual([
      expect.objectContaining({
        memoryId: "990e8400-e29b-41d4-a716-446655440099",
        changeKind: "replace",
      }),
    ]);
    semanticChanges._resetAuthoredMemorySemanticChangeSinkForTests();
  });
});


describe("prepared canonical Memory publication", () => {
  test("uses prepared embedding and ID without provider work or opening another transaction", async () => {
    mockLogger();
    mockUsageModule();
    mock.module("../../src/store/embeddings", () => ({ embedTextWithProvenance: async () => { throw new Error("provider must not run during publication"); } }));
    const queries: string[] = [];
    const mutations: FakeMutation[] = [];
    const handle = mockDbModule({
      execute: async (query) => { queries.push(String(query)); return { rows: [] }; },
      mutate: async (mutation) => { mutations.push(mutation); return []; },
    });
    const store = await importMemoryStore();
    const result = await store.saveMemoryWithDb(handle as unknown as Parameters<typeof store.saveMemoryWithDb>[0], {
      userId: "human", agentId: "agent", namespaceId: "namespace", type: "fact", content: "Prepared fact",
    }, { id: "stable-memory", embedding, expectedDedupId: null });
    expect(result).toEqual({ id: "stable-memory", action: "created" });
    expect(queries).toHaveLength(0);
    expect(mutations[0]).toMatchObject({ kind: "insert", values: {
      id: "stable-memory",
      embedding: embedding.vector,
      embeddingRevision: 0,
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-test",
      embeddingDimensions: 1536,
      embeddingContractVersion: 1,
    } });
    expect(queries.some((query) => query.includes("SET TRANSACTION"))).toBe(false);
  });
  test("a changed canonical dedup target aborts before any mutation", async () => {
    mockLogger();
    mockUsageModule();
    const queries: string[] = [];
    const handle = mockDbModule({
      namespaceRowsForSelect: [{ namespaceId: "namespace" }],
      vectorRows: [{ id: "unexpected", content: "existing", type: "fact", importance: 0.6, tier: 1, createdAt: new Date(0), score: 1 }],
      execute: async (query) => {
      queries.push(String(query));
      return { rows: [] };
    } });
    const store = await importMemoryStore();
    const error = await store.saveMemoryWithDb(handle as unknown as Parameters<typeof store.saveMemoryWithDb>[0], {
      userId: "human", agentId: "agent", namespaceId: "namespace", type: "fact", content: "Prepared fact",
    }, { id: "stable-memory", embedding, expectedDedupId: null }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(queries).toHaveLength(0);
  });
});
