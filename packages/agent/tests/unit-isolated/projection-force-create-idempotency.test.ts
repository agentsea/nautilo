/**
 * D476 — isolated atomic projection tests. This file owns its Bun process because
 * it mocks the DB and embedding modules (see scripts/run-unit.sh).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  memoryEmbeddingCompatibilityCondition,
  memoryEmbeddingValues,
} from "../../../db/src/utils/memory-embedding";

const embedding = {
  vector: Array.from({ length: 1536 }, (_, index) => index === 0 ? 0.25 : 0),
  provider: "openrouter" as const,
  canonicalModel: "qwen/qwen3-embedding-8b",
  dimensions: 1536,
  contractVersion: 1 as const,
};

beforeEach(() => {
  mock.restore();
});

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): string {
  let output = strings[0] ?? "";
  for (let index = 0; index < values.length; index += 1) {
    output += String(values[index]) + (strings[index + 1] ?? "");
  }
  return output;
}

interface MockRuntimeHandle {
  execute(query: unknown): Promise<{ rows: unknown[] }>;
  insert(table: unknown): {
    values(values: unknown): Promise<{ rows: unknown[] }>;
  };
  transaction<T>(fn: (tx: MockRuntimeHandle) => Promise<T>): Promise<T>;
}

function mockRuntime(execute: (query: unknown) => Promise<{ rows: unknown[] }>): void {
  const memories = { contentRevision: "content_revision" };
  const memoryNamespaces = { memoryId: "memory_id", namespaceId: "namespace_id" };
  const memoryCryptoOperations = { operationId: "operation_id" };
  const memoryCryptoRevisions = { memoryId: "memory_id" };
  const handle: MockRuntimeHandle = {
    execute,
    insert: (table: unknown) => ({
      values: (values: unknown) => execute(
        table === memoryNamespaces
          ? `INSERT INTO memory_namespaces ${JSON.stringify(values)}`
          : table === memories
            ? `INSERT INTO memories ${JSON.stringify(values)}`
            : `INSERT INTO unknown_table ${JSON.stringify(values)}`,
      ),
    }),
    transaction: async <T>(fn: (tx: MockRuntimeHandle) => Promise<T>) => fn(handle),
  };
  const sqlWithRaw = Object.assign(fakeSql, {
    raw: (value: string) => value,
    join: (values: unknown[], separator: unknown) => values.join(String(separator)),
  });
  mock.module("@nautilo/db", () => ({
    agentDb: handle,
    db: handle,
    memories,
    memoryNamespaces,
    memoryCryptoOperations,
    memoryCryptoRevisions,
    getSharedDirectAgentDb: () => handle,
    withTrustContext: async <T>(
      _context: unknown,
      fn: (tx: MockRuntimeHandle) => Promise<T>,
    ) => fn(handle),
    eq: () => ({}),
    and: () => ({}),
    or: () => ({}),
    sql: sqlWithRaw,
    acquireRoomWriteLock: async (tx: MockRuntimeHandle, roomId: string) => {
      await tx.execute(`ROOM_LOCK ${roomId}`);
    },
    findMemoryIdByCreationKeyWith: async (_handle: MockRuntimeHandle, creationKey: string) => {
      const result = await execute(`MEMORY_ID_BY_CREATION_KEY ${creationKey}`);
      const row = result.rows[0] as { id?: string } | undefined;
      return row?.id ?? null;
    },
    findProjectionRoomByIdWith: async (_handle: MockRuntimeHandle, roomId: string) => {
      const result = await execute(`PROJECTION_ROOM_BY_ID ${roomId}`);
      return result.rows[0] ?? null;
    },
    setTrustContextOnTx: async () => {},
    desc: () => ({}),
    ilike: () => ({}),
    inArray: () => ({}),
    notInArray: () => ({}),
    lte: () => ({}),
    lt: () => ({}),
    isNull: () => ({}),
    memoryEmbeddingValues,
    memoryEmbeddingCompatibilityCondition,
  }));
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
  mock.module("../../src/store/trust-agent-db", () => ({
    withAgentTrustContext: async <T>(
      _context: unknown,
      fn: (tx: MockRuntimeHandle) => Promise<T>,
    ) => fn(handle),
    withSerializableAgentTrustContext: async <T>(
      _context: unknown,
      fn: (tx: MockRuntimeHandle) => Promise<T>,
    ) => {
      await handle.execute("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      return fn(handle);
    },
  }));
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function importMemoryStore(): Promise<typeof import("../../src/store/memory-store")> {
  const href = new URL("../../src/store/memory-store.ts", import.meta.url).href;
  return (await import(`${href}?t=${Date.now()}`)) as typeof import(
    "../../src/store/memory-store"
  );
}

const input = {
  userId: "550e8400-e29b-41d4-a716-446655440001",
  agentId: "550e8400-e29b-41d4-a716-446655440002",
  namespaceId: "550e8400-e29b-41d4-a716-446655440003",
  creationKey: "projection:550e8400-e29b-41d4-a716-446655440010",
  type: "fact",
  content: "Approved projection only.",
  importance: 0.8,
};

const atomicInput = {
  userId: input.userId,
  agentId: input.agentId,
  requesterActorId: "550e8400-e29b-41d4-a716-446655440005",
  sourceFingerprints: [{
    id: "550e8400-e29b-41d4-a716-446655440006",
    contentHash: hash("Private evidence."),
  }],
  frozenReadableNamespaceIds: ["550e8400-e29b-41d4-a716-446655440007"],
  currentReadableNamespaceIds: ["550e8400-e29b-41d4-a716-446655440007"],
  content: input.content,
  contentHash: hash(input.content),
  type: input.type,
  importance: input.importance,
  roomId: "550e8400-e29b-41d4-a716-446655440008",
  namespaceId: input.namespaceId,
  roomLabel: "pub-room",
  roomKind: "open",
  audienceFingerprint: "",
  creationKey: "projection:550e8400-e29b-41d4-a716-446655440011",
  expiresAt: Date.now() + 60_000,
};

async function rejectedMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("D476 atomic projection idempotency", () => {
  test("atomic projection locks Room before canonical membership/source rows, then creates one destination edge", async () => {
    const queries: string[] = [];
    const events: string[] = [];
    const memberRow = {
      actorId: atomicInput.requesterActorId,
      actorKind: "user",
      ownerId: atomicInput.userId,
    };
    const membership = `user:${atomicInput.userId}:${atomicInput.requesterActorId}`;
    mockRuntime(async (query) => {
      const text = String(query);
      queries.push(text);
      if (text.includes("MEMORY_ID_BY_CREATION_KEY")) return { rows: [] };
      if (text.includes("SET TRANSACTION") || text.startsWith("ROOM_LOCK")) return { rows: [] };
      if (text.includes("PROJECTION_ROOM_BY_ID")) return { rows: [{
        id: atomicInput.roomId,
        namespaceId: atomicInput.namespaceId,
        label: atomicInput.roomLabel,
        kind: atomicInput.roomKind,
        archivedAt: null,
      }] };
      if (text.includes("FROM actors")) return { rows: [{ id: atomicInput.requesterActorId }] };
      if (text.includes("FROM room_members")) return { rows: [memberRow] };
      if (text.includes("FROM group_members")) return { rows: [{ groupId: "550e8400-e29b-41d4-a716-446655440009" }] };
      if (text.includes("FROM memories") && text.includes("WHERE id = ANY")) return { rows: [{
        id: atomicInput.sourceFingerprints[0]!.id,
        content: "Private evidence.",
      }] };
      if (text.includes("FROM memory_namespaces") && text.includes("WHERE memory_id = ANY")) return { rows: [{
        memoryId: atomicInput.sourceFingerprints[0]!.id,
        namespaceId: atomicInput.frozenReadableNamespaceIds[0],
      }] };
      if (text.includes("WHERE creation_key") && text.includes("FOR UPDATE")) return { rows: [] };
      if (text.includes("INSERT INTO memories") && text.includes("creationKey")) return { rows: [] };
      if (text.includes("INSERT INTO memory_namespaces")) return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    mock.module("../../src/store/embeddings", () => ({
      embedTextWithProvenance: async (content: string) => {
        events.push(`embed:${content}`);
        return embedding;
      },
    }));

    const {
      executeAtomicProjectionMemory,
      fingerprintProjectionReadableAuthority,
      setMemoryAuditSink,
    } = await importMemoryStore();
    const auditEvents: unknown[] = [];
    setMemoryAuditSink((event) => auditEvents.push(event));
    const result = await executeAtomicProjectionMemory({
      ...atomicInput,
      frozenReadableAuthorityFingerprint: fingerprintProjectionReadableAuthority(atomicInput.frozenReadableNamespaceIds),
      audienceFingerprint: hash(`d476:room-audience:v1\u0000${atomicInput.roomId}\u0000${membership}`),
    });
    setMemoryAuditSink(null);

    expect(result.status).toBe("created");
    expect(result.status === "created" ? result.memoryId : "").toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(auditEvents).toEqual([{
      kind: "memory.edit",
      memoryId: result.status === "created" ? result.memoryId : "",
      action: "save",
      outcome: "success",
      namespaceId: atomicInput.namespaceId,
      actorId: atomicInput.userId,
      ip: "",
      userAgent: undefined,
    }]);
    expect(events).toEqual([`embed:${atomicInput.content}`]);
    expect(queries.findIndex((query) => query.startsWith("ROOM_LOCK"))).toBeGreaterThan(
      queries.findIndex((query) => query.includes("MEMORY_ID_BY_CREATION_KEY")),
    );
    expect(queries.findIndex((query) => query.startsWith("ROOM_LOCK"))).toBeGreaterThan(-1);
    expect(queries.findIndex((query) => query.includes("FROM room_members"))).toBeGreaterThan(
      queries.findIndex((query) => query.startsWith("ROOM_LOCK")),
    );
    expect(queries.findIndex((query) => query.includes("WHERE id = ANY"))).toBeGreaterThan(
      queries.findIndex((query) => query.includes("FROM group_members")),
    );
    const memoryInsert = queries.find((query) => query.includes("INSERT INTO memories")) ?? "";
    const edgeInsert = queries.find((query) => query.includes("INSERT INTO memory_namespaces")) ?? "";
    expect(memoryInsert).toContain('"embeddingRevision":0');
    expect(memoryInsert).toContain('"embeddingProvider":"openrouter"');
    expect(memoryInsert).toContain('"embeddingModel":"qwen/qwen3-embedding-8b"');
    expect(memoryInsert).toContain('"embeddingDimensions":1536');
    expect(memoryInsert).toContain('"embeddingContractVersion":1');
    expect(memoryInsert).not.toMatch(/RETURNING/i);
    expect(edgeInsert).toMatch(/INSERT INTO memory_namespaces/i);
    expect(queries.indexOf(edgeInsert)).toBeGreaterThan(queries.indexOf(memoryInsert));
  });

  test("atomic projection fails closed for source drift, same-count audience swap, and capability loss", async () => {
    const memberRow = {
      actorId: atomicInput.requesterActorId,
      actorKind: "user",
      ownerId: atomicInput.userId,
    };
    const membership = `user:${atomicInput.userId}:${atomicInput.requesterActorId}`;
    let mode: "source" | "audience" | "capability" = "source";
    let writes = 0;
    mockRuntime(async (query) => {
      const text = String(query);
      if (text.includes("MEMORY_ID_BY_CREATION_KEY") || text.includes("SET TRANSACTION") || text.startsWith("ROOM_LOCK")) return { rows: [] };
      if (text.includes("PROJECTION_ROOM_BY_ID")) return { rows: [{ id: atomicInput.roomId, namespaceId: atomicInput.namespaceId, label: atomicInput.roomLabel, kind: atomicInput.roomKind, archivedAt: null }] };
      if (text.includes("FROM actors")) return { rows: [{ id: atomicInput.requesterActorId }] };
      if (text.includes("FROM room_members")) return { rows: [mode === "audience" ? {
        ...memberRow,
        actorId: "550e8400-e29b-41d4-a716-446655440099",
      } : memberRow] };
      if (text.includes("FROM group_members")) return { rows: mode === "capability" ? [] : [{ groupId: "550e8400-e29b-41d4-a716-446655440009" }] };
      if (text.includes("FROM memories") && text.includes("WHERE id = ANY")) return { rows: [{ id: atomicInput.sourceFingerprints[0]!.id, content: mode === "source" ? "changed evidence" : "Private evidence." }] };
      if (text.includes("FROM memory_namespaces") && text.includes("WHERE memory_id = ANY")) return { rows: [{ memoryId: atomicInput.sourceFingerprints[0]!.id, namespaceId: atomicInput.frozenReadableNamespaceIds[0] }] };
      if (text.includes("WHERE creation_key") && text.includes("FOR UPDATE")) return { rows: [] };
      if (
        (text.includes("INSERT INTO memories") && text.includes("creationKey"))
        || text.includes("INSERT INTO memory_namespaces")
      ) {
        writes += 1;
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    mock.module("../../src/store/embeddings", () => ({ embedTextWithProvenance: async () => embedding }));
    const { executeAtomicProjectionMemory, fingerprintProjectionReadableAuthority } = await importMemoryStore();
    const frozen = {
      ...atomicInput,
      frozenReadableAuthorityFingerprint: fingerprintProjectionReadableAuthority(atomicInput.frozenReadableNamespaceIds),
      audienceFingerprint: hash(`d476:room-audience:v1\u0000${atomicInput.roomId}\u0000${membership}`),
    };

    expect(await executeAtomicProjectionMemory(frozen)).toEqual({ status: "stale", reason: "source_changed" });
    mode = "audience";
    expect(await executeAtomicProjectionMemory(frozen)).toEqual({ status: "stale", reason: "destination_membership_changed" });
    mode = "capability";
    expect(await executeAtomicProjectionMemory(frozen)).toEqual({ status: "stale", reason: "capability_lost" });
    expect(writes).toBe(0);
  });

  test("atomic projection reuses one embedding across a serialization retry", async () => {
    const memberRow = { actorId: atomicInput.requesterActorId, actorKind: "user", ownerId: atomicInput.userId };
    const membership = `user:${atomicInput.userId}:${atomicInput.requesterActorId}`;
    let embedCalls = 0;
    let insertAttempts = 0;
    mockRuntime(async (query) => {
      const text = String(query);
      if (text.includes("MEMORY_ID_BY_CREATION_KEY")) return { rows: [] };
      if (text.includes("SET TRANSACTION") || text.startsWith("ROOM_LOCK")) return { rows: [] };
      if (text.includes("PROJECTION_ROOM_BY_ID")) return { rows: [{ id: atomicInput.roomId, namespaceId: atomicInput.namespaceId, label: atomicInput.roomLabel, kind: atomicInput.roomKind, archivedAt: null }] };
      if (text.includes("FROM actors")) return { rows: [{ id: atomicInput.requesterActorId }] };
      if (text.includes("FROM room_members")) return { rows: [memberRow] };
      if (text.includes("FROM group_members")) return { rows: [{ groupId: "550e8400-e29b-41d4-a716-446655440009" }] };
      if (text.includes("FROM memories") && text.includes("WHERE id = ANY")) return { rows: [{ id: atomicInput.sourceFingerprints[0]!.id, content: "Private evidence." }] };
      if (text.includes("FROM memory_namespaces") && text.includes("WHERE memory_id = ANY")) return { rows: [{ memoryId: atomicInput.sourceFingerprints[0]!.id, namespaceId: atomicInput.frozenReadableNamespaceIds[0] }] };
      if (text.includes("WHERE creation_key") && text.includes("FOR UPDATE")) return { rows: [] };
      if (text.includes("INSERT INTO memories") && text.includes("creationKey")) {
        insertAttempts += 1;
        if (insertAttempts === 1) throw Object.assign(new Error("serialization failure"), { code: "40001" });
        return { rows: [] };
      }
      if (text.includes("INSERT INTO memory_namespaces")) return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    mock.module("../../src/store/embeddings", () => ({ embedTextWithProvenance: async () => { embedCalls += 1; return embedding; } }));
    const { executeAtomicProjectionMemory, fingerprintProjectionReadableAuthority } = await importMemoryStore();
    const result = await executeAtomicProjectionMemory({
      ...atomicInput,
      frozenReadableAuthorityFingerprint: fingerprintProjectionReadableAuthority(atomicInput.frozenReadableNamespaceIds),
      audienceFingerprint: hash(`d476:room-audience:v1\u0000${atomicInput.roomId}\u0000${membership}`),
    });
    expect(result.status).toBe("created");
    expect(embedCalls).toBe(1);
    expect(insertAttempts).toBe(2);
  });

  test("atomic projection replays an existing key without embedding or writing a second edge", async () => {
    const existingMemoryId = "550e8400-e29b-41d4-a716-446655440010";
    const memberRow = { actorId: atomicInput.requesterActorId, actorKind: "user", ownerId: atomicInput.userId };
    const membership = `user:${atomicInput.userId}:${atomicInput.requesterActorId}`;
    let embedCalls = 0;
    let writes = 0;
    mockRuntime(async (query) => {
      const text = String(query);
      if (text.includes("MEMORY_ID_BY_CREATION_KEY")) return { rows: [{
        id: existingMemoryId,
        content: atomicInput.content,
        type: atomicInput.type,
        importance: 0.800000011920929,
        namespaceIds: [atomicInput.namespaceId],
      }] };
      if (text.includes("SET TRANSACTION") || text.startsWith("ROOM_LOCK")) return { rows: [] };
      if (text.includes("PROJECTION_ROOM_BY_ID")) return { rows: [{ id: atomicInput.roomId, namespaceId: atomicInput.namespaceId, label: atomicInput.roomLabel, kind: atomicInput.roomKind, archivedAt: null }] };
      if (text.includes("FROM actors")) return { rows: [{ id: atomicInput.requesterActorId }] };
      if (text.includes("FROM room_members")) return { rows: [memberRow] };
      if (text.includes("FROM group_members")) return { rows: [{ groupId: "550e8400-e29b-41d4-a716-446655440009" }] };
      if (text.includes("FROM memories") && text.includes("WHERE id = ANY")) return { rows: [{ id: atomicInput.sourceFingerprints[0]!.id, content: "Private evidence." }] };
      if (text.includes("FROM memory_namespaces") && text.includes("WHERE memory_id = ANY")) return { rows: [{ memoryId: atomicInput.sourceFingerprints[0]!.id, namespaceId: atomicInput.frozenReadableNamespaceIds[0] }] };
      if (text.includes("WHERE creation_key") && text.includes("FOR UPDATE")) return { rows: [{ id: existingMemoryId, content: atomicInput.content, type: atomicInput.type, importance: 0.800000011920929 }] };
      if (text.includes("FROM memory_namespaces") && text.includes(`WHERE memory_id = ${existingMemoryId}`)) return { rows: [{ namespaceId: atomicInput.namespaceId }] };
      if (
        (text.includes("INSERT INTO memories") && text.includes("creationKey"))
        || text.includes("INSERT INTO memory_namespaces")
      ) {
        writes += 1;
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    mock.module("../../src/store/embeddings", () => ({ embedTextWithProvenance: async () => { embedCalls += 1; return embedding; } }));
    const { executeAtomicProjectionMemory, fingerprintProjectionReadableAuthority } = await importMemoryStore();
    expect(await executeAtomicProjectionMemory({
      ...atomicInput,
      frozenReadableAuthorityFingerprint: fingerprintProjectionReadableAuthority(atomicInput.frozenReadableNamespaceIds),
      audienceFingerprint: hash(`d476:room-audience:v1\u0000${atomicInput.roomId}\u0000${membership}`),
    })).toEqual({ status: "replayed", memoryId: existingMemoryId });
    expect(embedCalls).toBe(0);
    expect(writes).toBe(0);
  });

  test("atomic projection bubbles an edge failure so the transaction rolls back both writes", async () => {
    const memberRow = { actorId: atomicInput.requesterActorId, actorKind: "user", ownerId: atomicInput.userId };
    const membership = `user:${atomicInput.userId}:${atomicInput.requesterActorId}`;
    const writes: string[] = [];
    mockRuntime(async (query) => {
      const text = String(query);
      if (text.includes("MEMORY_ID_BY_CREATION_KEY") || text.includes("SET TRANSACTION") || text.startsWith("ROOM_LOCK")) return { rows: [] };
      if (text.includes("PROJECTION_ROOM_BY_ID")) return { rows: [{ id: atomicInput.roomId, namespaceId: atomicInput.namespaceId, label: atomicInput.roomLabel, kind: atomicInput.roomKind, archivedAt: null }] };
      if (text.includes("FROM actors")) return { rows: [{ id: atomicInput.requesterActorId }] };
      if (text.includes("FROM room_members")) return { rows: [memberRow] };
      if (text.includes("FROM group_members")) return { rows: [{ groupId: "550e8400-e29b-41d4-a716-446655440009" }] };
      if (text.includes("FROM memories") && text.includes("WHERE id = ANY")) return { rows: [{ id: atomicInput.sourceFingerprints[0]!.id, content: "Private evidence." }] };
      if (text.includes("FROM memory_namespaces") && text.includes("WHERE memory_id = ANY")) return { rows: [{ memoryId: atomicInput.sourceFingerprints[0]!.id, namespaceId: atomicInput.frozenReadableNamespaceIds[0] }] };
      if (text.includes("WHERE creation_key") && text.includes("FOR UPDATE")) return { rows: [] };
      if (text.includes("INSERT INTO memories") && text.includes("creationKey")) {
        writes.push(text);
        return { rows: [] };
      }
      if (text.includes("INSERT INTO memory_namespaces")) {
        writes.push(text);
        throw new Error("destination edge rejected");
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    mock.module("../../src/store/embeddings", () => ({ embedTextWithProvenance: async () => embedding }));
    const { executeAtomicProjectionMemory, fingerprintProjectionReadableAuthority } = await importMemoryStore();
    expect(await rejectedMessage(executeAtomicProjectionMemory({
      ...atomicInput,
      frozenReadableAuthorityFingerprint: fingerprintProjectionReadableAuthority(atomicInput.frozenReadableNamespaceIds),
      audienceFingerprint: hash(`d476:room-audience:v1\u0000${atomicInput.roomId}\u0000${membership}`),
    }))).toContain("destination edge rejected");
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatch(/INSERT INTO memories/i);
    expect(writes[0]).not.toMatch(/RETURNING/i);
    expect(writes[1]).toMatch(/INSERT INTO memory_namespaces/i);
  });

});
