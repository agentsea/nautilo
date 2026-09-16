import { describe, expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";

import type {
  AgentMemoryEmbedding,
  ProtectedMemoryMutationPlan,
} from "../../src/memory/active-memory-composition.ts";
import type { ProtectedMemoryAuthority } from "../../src/memory/active-memory-repository.ts";
import {
  MEMORY_OBJECT_TYPE,
  MEMORY_PAYLOAD_VERSION,
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
  type AtomicMemoryCryptoCompletionPort,
  type PreparedMemoryCryptoRevision,
} from "../../src/memory/memory-repository.ts";
import { PostgresAgentMemoryProductPort } from "../../src/server/memory/postgres-agent-memory-product-port.ts";
import {
  bindConversationProductCanonicalTransactionRunner,
  verifyConversationProductPostgresHandle,
  type ConversationProductCanonicalTransactionConnection,
  type ConversationProductCanonicalTransactionRunner,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresHandle,
  type ConversationProductPostgresIsolationLevel,
} from "../../src/server/message/postgres-conversation-product-store.ts";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

type Query = Readonly<{
  statement: string;
  parameters: readonly unknown[];
}>;

function normalizedSql(statement: string): string {
  return statement.replaceAll('"', "").toLowerCase();
}

class ScriptedConnection implements ConversationProductPostgresConnection {
  readonly queries: Query[] = [];
  readonly isolationLevels: ConversationProductPostgresIsolationLevel[] = [];
  readonly #results: unknown[][];

  constructor(results: unknown[][]) {
    this.#results = [...results];
  }

  query<Row>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.queries.push({ statement, parameters });
    const result = this.#results.shift();
    if (result === undefined) throw new Error(`Unexpected SQL: ${statement}`);
    return Promise.resolve(result as Row[]);
  }

  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
    options: Readonly<{
      isolationLevel: ConversationProductPostgresIsolationLevel;
    }>,
  ): Promise<Result> {
    this.isolationLevels.push(options.isolationLevel);
    return callback(this);
  }

  assertExhausted(): void {
    expect(this.#results).toEqual([]);
  }
}

function canonicalConnection(
  connection: ScriptedConnection,
): ConversationProductCanonicalTransactionConnection {
  return {
    transaction: (callback, options) => {
      connection.isolationLevels.push(options.isolationLevel);
      return callback({
        execute: () => Promise.resolve([{
          current_user: "nautilo_agent",
          session_user: "nautilo_agent",
        }]),
      } as unknown as CanonicalTranscriptTx, connection);
    },
  };
}

const USER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "10000000-0000-4000-8000-000000000002";
const MEMORY_ID = "20000000-0000-4000-8000-000000000001";
const MEMORY_ID_2 = "20000000-0000-4000-8000-000000000002";
const NAMESPACE_A = "30000000-0000-4000-8000-000000000001";
const NAMESPACE_B = "30000000-0000-4000-8000-000000000002";
const SCOPE_ID = "40000000-0000-4000-8000-000000000001";
const CREATED_AT = new Date("2027-01-15T08:00:00.123Z");
const MUTATION_COMMITMENT = new Uint8Array(32).fill(0x11);

function stableForegroundDigest(input: Readonly<{
  operationId: string;
  mutationKind: "save" | "replace" | "promote" | "demote";
  memoryId?: string;
  importance?: number;
  mutationCommitment?: Uint8Array;
}>): Uint8Array {
  return sha256(new TextEncoder().encode(JSON.stringify({
    version: 1,
    operationId: input.operationId,
    mutationKind: input.mutationKind,
    subjectUserId: USER_ID,
    agentId: AGENT_ID,
    ...(input.mutationKind === "save"
      ? { logicalWritableNamespaceId: NAMESPACE_A, importance: input.importance }
      : { memoryId: input.memoryId }),
    ...(input.mutationCommitment === undefined ? {} : {
      mutationCommitment: [...input.mutationCommitment],
    }),
  })));
}

const embedding: AgentMemoryEmbedding = Object.freeze({
  vector: Object.freeze(new Array<number>(1536).fill(0.01)),
  provider: "openai",
  canonicalModel: "text-embedding-3-small",
  dimensions: 1536,
  contractVersion: 1,
});

const namespaceAuthority: ProtectedMemoryAuthority = Object.freeze({
  mode: "namespace",
  subjectUserId: USER_ID,
  agentId: AGENT_ID,
  readableNamespaceIds: Object.freeze([NAMESPACE_A, NAMESPACE_B]),
  mutableNamespaceIds: Object.freeze([NAMESPACE_A]),
  writableNamespaceId: NAMESPACE_A,
});

const scopeAuthority: ProtectedMemoryAuthority = Object.freeze({
  mode: "scope",
  subjectUserId: USER_ID,
  agentId: AGENT_ID,
  scopeId: SCOPE_ID,
  originWritableNamespaceId: NAMESPACE_A,
});

const identity = Object.freeze({
  current_user_id: USER_ID,
  current_agent_id: AGENT_ID,
});

function candidateRow(
  requiredNamespaceIds: readonly string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    memory_id: MEMORY_ID,
    content_revision: 1,
    crypto_object_id: deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_ID,
      contentRevision: 1,
    }),
    crypto_mapping_state: "verified",
    crypto_access_revision: 0,
    crypto_required_namespace_fingerprint:
      fingerprintRequiredMemoryNamespaces(requiredNamespaceIds),
    scope_origin_namespace_id: null,
    importance: 0.6,
    tier: 1,
    created_at: CREATED_AT,
    similarity: 0.94,
    ...overrides,
  };
}

function selectedCandidate() {
  return Object.freeze({
    memoryId: MEMORY_ID,
    contentRevision: 1,
    score: 0.94,
    repairRequired: false,
    repair: Object.freeze({ representation: "structural" as const,
      id: MEMORY_ID, type: null, importance: 0.6, tier: 1,
      createdAt: CREATED_AT, score: 0.94 }),
  });
}

function operationRow(overrides: Record<string, unknown> = {}) {
  return {
    operation_id: "memory.save.1",
    memory_id: MEMORY_ID,
    anchor_namespace_id: NAMESPACE_A,
    operation_type: "update",
    expected_content_revision: 0,
    result_content_revision: 1,
    expected_access_revision: 0,
    request_digest: new Uint8Array(32),
    completion: "pending",
    foreground_stable_request_digest: null,
    foreground_mutation_kind: null,
    foreground_required_namespace_ids: null,
    foreground_save_similarity: null,
    ordinary_fallback_reason: null,
    created_at: CREATED_AT.toISOString(),
    ...overrides,
  };
}

async function verifiedHandle(
  connection: ScriptedConnection,
): Promise<ConversationProductPostgresHandle> {
  return verifyConversationProductPostgresHandle(connection);
}

function dependencies() {
  const completed: PreparedMemoryCryptoRevision[] = [];
  return {
    completed,
    cryptoCompletion: {
      complete: (revision: PreparedMemoryCryptoRevision) => {
        completed.push(revision);
        return Promise.resolve("created" as const);
      },
    } satisfies Pick<AtomicMemoryCryptoCompletionPort, "complete">,
  };
}

async function createPort(
  connection: ScriptedConnection,
  input: Readonly<{
    readableNamespaceIds?: readonly string[];
    createMemoryId?: () => string;
    deps?: ReturnType<typeof dependencies>;
    publication?: ConstructorParameters<typeof PostgresAgentMemoryProductPort>[0]["publication"];
  }> = {},
) {
  const deps = input.deps ?? dependencies();
  const handle = await verifiedHandle(connection);
  const canonicalRunner = bindConversationProductCanonicalTransactionRunner(
    handle,
    canonicalConnection(connection),
  );
  return {
    deps,
    port: new PostgresAgentMemoryProductPort({
      handle,
      canonicalRunner,
      readableNamespaceIds: input.readableNamespaceIds
        ?? [NAMESPACE_A, NAMESPACE_B],
      cryptoCompletion: deps.cryptoCompletion,
      publication: input.publication ?? { representation: "protected_only", beforeLocks: async () => {} },
      ...(input.createMemoryId === undefined
        ? {}
        : { createMemoryId: input.createMemoryId }),
    }),
  };
}

describe("Postgres foreground Agent Memory product port", () => {
  test("rejects non-canonical, duplicate, and invalid bound authority inventories", async () => {
    expect(createPort(new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
    ]), {
      readableNamespaceIds: [NAMESPACE_B, NAMESPACE_A],
    })).rejects.toThrow("Agent Memory bound readable Namespace set is invalid");

    expect(createPort(new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
    ]), {
      readableNamespaceIds: [NAMESPACE_A, NAMESPACE_A],
    })).rejects.toThrow("Agent Memory bound readable Namespace set is invalid");

    expect(createPort(new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
    ]), {
      readableNamespaceIds: ["not-a-namespace-id"],
    })).rejects.toThrow("Agent Memory bound readable Namespace set is invalid");
  });

  test("loads only the exact protected projection source inventory", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      [identity],
      [candidateRow([NAMESPACE_A])],
      [{ namespace_id: NAMESPACE_A }],
      [],
    ]);
    const { port } = await createPort(connection);
    const result = await port.loadExactProjectionSources({
      authority: namespaceAuthority, memoryIds: [MEMORY_ID],
    });
    expect(result).toMatchObject({ status: "success", value: [{
      memoryId: MEMORY_ID, cryptoObjectId: deriveMemoryCryptoObjectIdV1({
        memoryId: MEMORY_ID, contentRevision: 1,
      }), requiredNamespaceIds: [NAMESPACE_A],
    }] });
    const sourceQuery = connection.queries.find((query) =>
      normalizedSql(query.statement).includes("from memories")
      && normalizedSql(query.statement).includes("content_revision")
    );
    expect(normalizedSql(sourceQuery?.statement ?? "")).toContain(
      "select id as memory_id, content_revision",
    );
    expect(connection.queries.some((query) =>
      /\b(content|type)\b/u.test(normalizedSql(query.statement))
    )).toBeFalse();
    connection.assertExhausted();
  });

  test("reserves a force-created projection without semantic deduplication", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      [identity], [], [], [],
    ]);
    const { port } = await createPort(connection, {
      createMemoryId: () => MEMORY_ID_2,
    });
    const result = await port.planProjectionCreate({
      operationId: "memory.projection.1", authority: namespaceAuthority,
      embedding, importance: 0.8, mutationCommitment: MUTATION_COMMITMENT,
    });
    expect(result).toMatchObject({ status: "success", value: {
      action: "created", memoryId: MEMORY_ID_2,
      requiredNamespaceIds: [NAMESPACE_A], mutationKind: "save",
    } });
    expect(connection.queries.some((query) =>
      query.statement.includes("embedding <=>")
    )).toBeFalse();
    connection.assertExhausted();
  });

  test("selects one authorized ordinary semantic candidate for exact repair", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      [identity],
      [candidateRow([NAMESPACE_A], {
        crypto_object_id: null,
        crypto_mapping_state: "unmapped",
        crypto_required_namespace_fingerprint: null,
      })],
      [{ namespace_id: NAMESPACE_A }],
      [],
    ]);
    const { port } = await createPort(connection);
    expect(await port.selectSaveCandidate({
      authority: namespaceAuthority,
      embedding,
    })).toEqual({
      status: "success",
      value: {
        memoryId: MEMORY_ID,
        contentRevision: 1,
        score: 0.94,
        repairRequired: true,
        repair: {
          representation: "structural",
          id: MEMORY_ID,
          type: null,
          importance: 0.6,
          tier: 1,
          createdAt: CREATED_AT,
          score: 0.94,
        },
      },
    });
    expect(connection.queries.some((query) =>
      /\bmemory_row\.(content|type)\b/u.test(normalizedSql(query.statement))
    )).toBeFalse();
    const candidateQuery = connection.queries[2]!;
    expect(candidateQuery.statement).toContain('from "memory_namespaces"');
    expect(candidateQuery.statement).not.toContain('from "memory_scopes"');
    expect(candidateQuery.parameters).toContain(NAMESPACE_A);
    expect(candidateQuery.parameters).not.toContain(null);
    connection.assertExhausted();
  });
  test("replays a completed durable outcome without reading the current Memory head", async () => {
    const stable = stableForegroundDigest({
      operationId: "memory.save.replay",
      mutationKind: "save",
      importance: 0.7,
      mutationCommitment: MUTATION_COMMITMENT,
    });
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      [identity],
      [operationRow({
        operation_id: "memory.save.replay",
        completion: "complete",
        foreground_stable_request_digest: stable,
        foreground_mutation_kind: "save",
        foreground_required_namespace_ids: [NAMESPACE_A],
        foreground_save_similarity: 0.94,
      })],
    ]);
    const mutations: boolean[] = [];
    const { port } = await createPort(connection, { publication: {
      representation: "protected_only",
      beforeLocks: async ({ mutation }) => { mutations.push(mutation); },
    } });

    expect(await port.replayCompleted({
      operationId: "memory.save.replay",
      authority: namespaceAuthority,
      mutationKind: "save",
      importance: 0.7,
      mutationCommitment: MUTATION_COMMITMENT,
    })).toEqual({ status: "success", value: {
      mutationKind: "save",
      memoryId: MEMORY_ID,
      action: "created",
      similarity: 0.94,
    } });
    expect(mutations).toEqual([false]);
    expect(connection.queries.some(({ statement }) =>
      normalizedSql(statement).includes("from memories")
    )).toBe(false);
    connection.assertExhausted();
  });

  test("replays the exact durable ordinary fallback reason without current product state", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      [identity],
      [operationRow({ completion: "ordinary_fallback",
        ordinary_fallback_reason: "encryption_pending",
        foreground_stable_request_digest: stableForegroundDigest({
          operationId: "memory.save.1", mutationKind: "save", importance: 0.7,
          mutationCommitment: MUTATION_COMMITMENT,
        }),
        foreground_mutation_kind: "save",
        foreground_required_namespace_ids: [NAMESPACE_A],
      })],
    ]);
    const { port } = await createPort(connection);
    expect(await port.replayCompleted({ operationId: "memory.save.1",
      authority: namespaceAuthority, mutationKind: "save", importance: 0.7,
      mutationCommitment: MUTATION_COMMITMENT })).toEqual({
      status: "success",
      value: { mutationKind: "save", memoryId: MEMORY_ID,
        action: "created", fallbackReason: "encryption_pending" },
    });
    connection.assertExhausted();
  });

  test("rejects completed replay after request or current readable authority drift", async () => {
    const stable = stableForegroundDigest({
      operationId: "memory.replace.replay",
      mutationKind: "replace",
      memoryId: MEMORY_ID,
      mutationCommitment: MUTATION_COMMITMENT,
    });
    for (const [authorityValue, commitment] of [
      [{
        ...namespaceAuthority,
        readableNamespaceIds: [NAMESPACE_B],
        mutableNamespaceIds: [NAMESPACE_B],
        writableNamespaceId: NAMESPACE_B,
      }, MUTATION_COMMITMENT],
      [namespaceAuthority, new Uint8Array(32).fill(0x22)],
    ] as const) {
      const connection = new ScriptedConnection([
        [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
        [identity],
        [operationRow({
          operation_id: "memory.replace.replay",
          expected_content_revision: 4,
          result_content_revision: 5,
          completion: "complete",
          foreground_stable_request_digest: stable,
          foreground_mutation_kind: "replace",
          foreground_required_namespace_ids: [NAMESPACE_A],
        })],
      ]);
      const { port } = await createPort(connection);
      expect(await port.replayCompleted({
        operationId: "memory.replace.replay",
        authority: authorityValue,
        mutationKind: "replace",
        memoryId: MEMORY_ID,
        mutationCommitment: commitment,
      })).toEqual({ status: "unavailable", reason: "authorization_required" });
      connection.assertExhausted();
    }
  });
  test("rejects stale publication authority before any reservation or product read", async () => {
    for (const mutation of [false, true]) {
      const connection = new ScriptedConnection([
        [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }], [identity],
      ]);
      const checked: boolean[] = [];
      const { port } = await createPort(connection, { publication: {
        representation: "protected_only", beforeLocks: async (request) => {
          checked.push(request.mutation);
          expect(request.authority).toEqual(namespaceAuthority);
          expect(typeof request.transaction.execute).toBe("function");
          throw new Error("publication authority expired");
        },
      } });
      const result = mutation
        ? port.planSave({ operationId: "memory.denied", authority: namespaceAuthority,
          embedding, selectedCandidate: null, importance: 0.5,
          mutationCommitment: MUTATION_COMMITMENT })
        : port.searchCandidates({ authority: namespaceAuthority, embedding,
          limit: 3, includeArchive: false });
      expect(result).rejects.toThrow("publication authority expired");
      expect(checked).toEqual([mutation]);
      expect(connection.queries).toHaveLength(2);
      connection.assertExhausted();
    }
  });

  test("rejects a canonical runner bound to a different verified handle", async () => {
    const firstConnection = new ScriptedConnection([[{
      current_user: "nautilo_agent",
      session_user: "nautilo_agent",
    }]]);
    const secondConnection = new ScriptedConnection([[{
      current_user: "nautilo_agent",
      session_user: "nautilo_agent",
    }]]);
    const firstHandle = await verifiedHandle(firstConnection);
    const secondHandle = await verifiedHandle(secondConnection);
    const secondRunner = bindConversationProductCanonicalTransactionRunner(
      secondHandle,
      canonicalConnection(secondConnection),
    );
    expect(() => new PostgresAgentMemoryProductPort({
      handle: firstHandle,
      canonicalRunner: secondRunner,
      readableNamespaceIds: [NAMESPACE_A],
      cryptoCompletion: dependencies().cryptoCompletion,
      publication: { representation: "protected_only", beforeLocks: async () => {} },
    })).toThrow(/exact verified product handle/i);
  });

  test("requires a verified direct agent handle and revalidates both identities", async () => {
    const forged = Object.freeze({ role: "nautilo_agent" }) as unknown as
      ConversationProductPostgresHandle;
    const deps = dependencies();
    expect(() => new PostgresAgentMemoryProductPort({
      handle: forged,
      canonicalRunner: Object.freeze({}) as unknown as
        ConversationProductCanonicalTransactionRunner,
      readableNamespaceIds: [NAMESPACE_A],
      cryptoCompletion: deps.cryptoCompletion,
      publication: { representation: "protected_only", beforeLocks: async () => {} },
    })).toThrow("verified ordinary product Postgres handle");

    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      [{ current_user_id: USER_ID, current_agent_id: null }],
    ]);
    const { port } = await createPort(connection);
    expect(await port.planSave({
      operationId: "memory.invalid-importance.1",
      authority: namespaceAuthority,
      embedding,
      selectedCandidate: null,
      importance: 1.01,
      mutationCommitment: MUTATION_COMMITMENT,
    })).toEqual({
      status: "unavailable",
      reason: "embedding_unavailable",
    });
    expect(port.searchCandidates({
      authority: namespaceAuthority,
      embedding,
      limit: 3,
      includeArchive: false,
    })).rejects.toThrow("transaction authority changed");
    expect(connection.queries).toHaveLength(2);
    connection.assertExhausted();
  });

  test("searches only bounded compatible metadata and permits a scope seed read", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      [identity],
      [candidateRow([NAMESPACE_B])],
      [{ namespace_id: NAMESPACE_B }],
      [{ origin: "seed" }],
    ]);
    const { port } = await createPort(connection);

    const result = await port.searchCandidates({
      authority: scopeAuthority,
      embedding,
      limit: 4,
      includeArchive: false,
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.value).toEqual([{
        memoryId: MEMORY_ID,
        contentRevision: 1,
        cryptoAccessRevision: 0,
        cryptoObjectId: deriveMemoryCryptoObjectIdV1({
          memoryId: MEMORY_ID,
          contentRevision: 1,
        }),
        readNamespaceId: NAMESPACE_B,
        requiredNamespaceIds: [NAMESPACE_B],
        importance: 0.6,
        tier: 1,
        score: 0.94,
        createdAt: CREATED_AT,
      }]);
    }
    const candidateSql = connection.queries[2]!.statement;
    expect(candidateSql).toContain('"embedding_provider" =');
    expect(candidateSql).toContain('from "memory_scopes"');
    expect(candidateSql).toContain('"scope_id" =');
    expect(candidateSql).not.toContain('"origin" =');
    expect(candidateSql).not.toMatch(/"memories"\."(content|type)"/u);
    expect(connection.queries[2]!.parameters).toContain(scopeAuthority.scopeId);
    expect(connection.queries[2]!.parameters).not.toContain(null);
    expect(connection.isolationLevels).toEqual(["serializable"]);
    connection.assertExhausted();
  });

  test("creates one origin-bound plan and replays its exact stable coordinates", async () => {
    const replay = operationRow();
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      [identity],
      [],
      [],
      [],
      [],
      [identity],
      [replay],
      [],
      [{
        crypto_object_id: deriveMemoryCryptoObjectIdV1({
          memoryId: MEMORY_ID,
          contentRevision: 1,
        }),
        required_namespace_fingerprint:
          fingerprintRequiredMemoryNamespaces([NAMESPACE_A]),
      }],
      [identity],
      [replay],
      [{
        memory_id: MEMORY_ID,
        content_revision: 1,
        crypto_access_revision: 0,
        crypto_object_id: deriveMemoryCryptoObjectIdV1({ memoryId: MEMORY_ID, contentRevision: 1 }),
        crypto_mapping_state: "verified",
        scope_origin_namespace_id: null,
        importance: 0.7,
      }],
      [{ namespace_id: NAMESPACE_A }],
      [],
      [{
        crypto_object_id: deriveMemoryCryptoObjectIdV1({ memoryId: MEMORY_ID, contentRevision: 1 }),
        required_namespace_fingerprint: fingerprintRequiredMemoryNamespaces([NAMESPACE_A]),
      }],
      [identity],
      [replay],
    ]);
    const { port } = await createPort(connection, {
      createMemoryId: () => MEMORY_ID,
    });

    const first = await port.planSave({
      operationId: "memory.save.1",
      authority: namespaceAuthority,
      embedding,
      selectedCandidate: null,
      importance: 0.7,
      mutationCommitment: MUTATION_COMMITMENT,
    });
    expect(first.status).toBe("success");
    if (first.status !== "success") throw new Error("plan unavailable");
    const operationInsert = connection.queries.find((query) =>
      normalizedSql(query.statement).includes(
        "insert into memory_crypto_operations",
      )
    );
    expect(operationInsert).toBeDefined();
    const requestDigest = operationInsert!.parameters.find((parameter) =>
      parameter instanceof Uint8Array
    );
    expect(requestDigest).toBeInstanceOf(Uint8Array);
    replay.request_digest = Uint8Array.from(
      requestDigest as Uint8Array,
    );
    replay.created_at = operationInsert!.parameters.find((parameter) =>
      typeof parameter === "string" && parameter.endsWith("Z")
    ) as string;

    const retryEmbedding = Object.freeze({
      ...embedding,
      vector: Object.freeze(new Array<number>(1536).fill(0.125)),
    });
    const second = await port.planSave({
      operationId: "memory.save.1",
      authority: namespaceAuthority,
      embedding: retryEmbedding,
      selectedCandidate: null,
      importance: 0.7,
      mutationCommitment: MUTATION_COMMITMENT,
    });
    expect(second).toEqual(first);
    replay.completion = "complete";
    expect(await port.planSave({
      operationId: "memory.save.1",
      authority: namespaceAuthority,
      embedding: retryEmbedding,
      selectedCandidate: null,
      importance: 0.7,
      mutationCommitment: MUTATION_COMMITMENT,
    })).toEqual(first);
    expect(await port.planSave({
      operationId: "memory.save.1",
      authority: namespaceAuthority,
      embedding,
      selectedCandidate: null,
      importance: 0.7,
      mutationCommitment: new Uint8Array(32).fill(0x12),
    })).toEqual({ status: "unavailable", reason: "integrity_failure" });
    expect(first.value.requiredNamespaceIds).toEqual([NAMESPACE_A]);
    expect(first.value).not.toHaveProperty("similarity");
    expect(operationInsert!.parameters.some((parameter) =>
      typeof parameter === "string" && parameter.endsWith("Z")
    )).toBeTrue();
    expect(connection.queries.some((query) =>
      normalizedSql(query.statement).includes("insert into memories")
      || normalizedSql(query.statement).includes("insert into memory_namespaces")
    )).toBe(false);
    connection.assertExhausted();
  });

  test("keeps a scope seed read-only and creates a new origin-bound Memory", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      [identity],
      [{ lifecycle_state: "open" }],
      [],
      [candidateRow([NAMESPACE_B])],
      [{ namespace_id: NAMESPACE_B }],
      [{ origin: "seed" }],
      [],
      [],
    ]);
    const { port } = await createPort(connection, {
      createMemoryId: () => MEMORY_ID_2,
    });

    const result = await port.planSave({
      operationId: "memory.scope-save.1",
      authority: scopeAuthority,
      embedding,
      selectedCandidate: null,
      importance: 0.7,
      mutationCommitment: MUTATION_COMMITMENT,
    });
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.value.memoryId).toBe(MEMORY_ID_2);
      expect(result.value.action).toBe("created");
      expect(result.value.requiredNamespaceIds).toEqual([NAMESPACE_A]);
    }
    expect(connection.queries.some((query) =>
      normalizedSql(query.statement).includes("update memories")
      && query.parameters[0] === MEMORY_ID
    )).toBe(false);
    expect(connection.queries.some((query) =>
      normalizedSql(query.statement).includes("insert into memory_scopes")
    )).toBe(false);
    connection.assertExhausted();
  });

  test("replays a pending deduplicating save with the requested importance, not the old row value", async () => {
    const replay = operationRow({
      expected_content_revision: 1,
      result_content_revision: 2,
    });
    const nextObjectId = deriveMemoryCryptoObjectIdV1({ memoryId: MEMORY_ID, contentRevision: 2 });
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      [identity],
      [],
      [candidateRow([NAMESPACE_A], { importance: 0.3 })],
      [{ namespace_id: NAMESPACE_A }],
      [],
      [],
      [],
      [identity],
      [replay],
      [{
        memory_id: MEMORY_ID,
        content_revision: 1,
        crypto_access_revision: 0,
        crypto_object_id: deriveMemoryCryptoObjectIdV1({ memoryId: MEMORY_ID, contentRevision: 1 }),
        crypto_mapping_state: "verified",
        scope_origin_namespace_id: null,
        importance: 0.3,
      }],
      [{ namespace_id: NAMESPACE_A }],
      [],
      [{
        crypto_object_id: nextObjectId,
        required_namespace_fingerprint: fingerprintRequiredMemoryNamespaces([NAMESPACE_A]),
      }],
    ]);
    const { port } = await createPort(connection);
    const request = {
      operationId: "memory.save.1",
      authority: namespaceAuthority,
      embedding,
      selectedCandidate: selectedCandidate(),
      importance: 0.8,
      mutationCommitment: MUTATION_COMMITMENT,
    } as const;
    const first = await port.planSave(request);
    expect(first.status).toBe("success");
    if (first.status !== "success") throw new Error("plan unavailable");
    const operationInsert = connection.queries.find((query) =>
      normalizedSql(query.statement).includes("insert into memory_crypto_operations"));
    replay.request_digest = Uint8Array.from(
      operationInsert!.parameters.find((parameter) => parameter instanceof Uint8Array) as Uint8Array,
    );
    replay.created_at = operationInsert!.parameters.find((parameter) =>
      typeof parameter === "string" && parameter.endsWith("Z")
    ) as string;
    const second = await port.planSave(request);
    expect(second.status).toBe("success");
    if (second.status === "success") expect(second.value.importance).toBe(0.8);
    expect(first.value.importance).toBe(0.8);
    connection.assertExhausted();
  });

  test("replays a pending replacement when a provider retry returns a different vector", async () => {
    const replay = operationRow({
      operation_id: "memory.replace.1",
      expected_content_revision: 1,
      result_content_revision: 2,
    });
    const currentObjectId = deriveMemoryCryptoObjectIdV1({ memoryId: MEMORY_ID, contentRevision: 1 });
    const nextObjectId = deriveMemoryCryptoObjectIdV1({ memoryId: MEMORY_ID, contentRevision: 2 });
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      [identity],
      [],
      [{ memory_id: MEMORY_ID, content_revision: 1, crypto_object_id: currentObjectId,
        crypto_access_revision: 0, crypto_required_namespace_fingerprint:
          fingerprintRequiredMemoryNamespaces([NAMESPACE_A]),
        scope_origin_namespace_id: null, importance: 0.4, tier: 1 }],
      [{ namespace_id: NAMESPACE_A }],
      [],
      [],
      [],
      [identity],
      [replay],
      [{ memory_id: MEMORY_ID, content_revision: 1, crypto_access_revision: 0,
        crypto_object_id: currentObjectId, crypto_mapping_state: "verified",
        scope_origin_namespace_id: null, importance: 0.4 }],
      [{ namespace_id: NAMESPACE_A }],
      [],
      [{ crypto_object_id: nextObjectId, required_namespace_fingerprint:
        fingerprintRequiredMemoryNamespaces([NAMESPACE_A]) }],
    ]);
    const { port } = await createPort(connection);
    const first = await port.planReplace({ operationId: "memory.replace.1",
      authority: namespaceAuthority, memoryId: MEMORY_ID, embedding,
      mutationCommitment: MUTATION_COMMITMENT });
    expect(first.status).toBe("success");
    const insert = connection.queries.find((query) => normalizedSql(query.statement)
      .includes("insert into memory_crypto_operations"));
    replay.request_digest = Uint8Array.from(insert!.parameters.find(
      (parameter) => parameter instanceof Uint8Array,
    ) as Uint8Array);
    replay.created_at = insert!.parameters.find((parameter) =>
      typeof parameter === "string" && parameter.endsWith("Z")) as string;
    const drifted = Object.freeze({ ...embedding,
      vector: Object.freeze(new Array<number>(1536).fill(-0.125)) });
    expect(await port.planReplace({ operationId: "memory.replace.1",
      authority: namespaceAuthority, memoryId: MEMORY_ID, embedding: drifted,
      mutationCommitment: MUTATION_COMMITMENT })).toEqual(first);
    connection.assertExhausted();
  });

  test("rejects a protected origin write after scope close starts", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      [identity],
      [{ lifecycle_state: "closing" }],
    ]);
    const { port } = await createPort(connection);
    expect(await port.planSave({
      operationId: "memory.scope-closing.1",
      authority: scopeAuthority,
      embedding,
      selectedCandidate: null,
      importance: 0.7,
      mutationCommitment: MUTATION_COMMITMENT,
    })).toEqual({ status: "unavailable", reason: "stale_revision" });
    expect(connection.queries.some((query) =>
      normalizedSql(query.statement).includes(
        "insert into memory_crypto_operations",
      )
    )).toBeFalse();
    connection.assertExhausted();
  });

  test("does not apply the per-object 256 audience bound to a bound authority inventory", async () => {
    const largeInventory = Object.freeze([
      NAMESPACE_A,
      ...Array.from({ length: 256 }, (_, index) =>
        `50000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`),
    ]);
    const authority: ProtectedMemoryAuthority = Object.freeze({
      mode: "namespace",
      subjectUserId: USER_ID,
      agentId: AGENT_ID,
      readableNamespaceIds: largeInventory,
      mutableNamespaceIds: largeInventory,
      writableNamespaceId: NAMESPACE_A,
    });
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      [identity],
      [],
      [],
      [],
      [],
    ]);
    const { port } = await createPort(connection, {
      readableNamespaceIds: largeInventory,
      createMemoryId: () => MEMORY_ID_2,
    });
    const result = await port.planSave({
      operationId: "memory.large-authority.1",
      authority,
      embedding,
      selectedCandidate: null,
      importance: 0.7,
      mutationCommitment: MUTATION_COMMITMENT,
    });
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.value.requiredNamespaceIds).toEqual([NAMESPACE_A]);
    }
    connection.assertExhausted();
  });

  test("reserves the exact signed background output without deduplication", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      [identity],
      [],
      [],
      [],
      [],
    ]);
    const { port } = await createPort(connection, {
      createMemoryId: () => {
        throw new Error("background planning must not choose an identity");
      },
    });
    const objectId = deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_ID_2,
      contentRevision: 1,
    });
    const result = await port.planBackgroundOutput({
      action: "create",
      publicationIdempotencyId: "background.publication.1",
      descriptorHash: new Uint8Array(32).fill(0x41),
      authority: namespaceAuthority,
      memoryId: MEMORY_ID_2,
      expectedContentRevision: 0,
      expectedCryptoAccessRevision: 0,
      nextContentRevision: 1,
      cryptoObjectId: objectId,
      requiredNamespaceIds: [NAMESPACE_A],
      createdAt: CREATED_AT.getTime(),
      embedding,
      importance: 0.5,
    });

    expect(result).toMatchObject({
      status: "success",
      value: {
        operationId: "background.publication.1",
        action: "created",
        memoryId: MEMORY_ID_2,
        contentRevision: 1,
        cryptoAccessRevision: 0,
        cryptoObjectId: objectId,
        requiredNamespaceIds: [NAMESPACE_A],
        importance: 0.5,
        createdAt: CREATED_AT.getTime(),
      },
    });
    expect(connection.queries.some((query) =>
      query.statement.includes("embedding <=>")
    )).toBe(false);
    const operationInsert = connection.queries.find((query) =>
      normalizedSql(query.statement).includes(
        "insert into memory_crypto_operations",
      )
    );
    expect(operationInsert?.parameters[0]).toBe("background.publication.1");
    expect(operationInsert?.parameters[1]).toBe(MEMORY_ID_2);
    connection.assertExhausted();
  });

  test("updates and replays one exact background output, rejecting descriptor drift", async () => {
    const nextObjectId = deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_ID,
      contentRevision: 2,
    });
    const replay = operationRow({
      operation_id: "background.publication.update.1",
      expected_content_revision: 1,
      result_content_revision: 2,
    });
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      [identity],
      [],
      [candidateRow([NAMESPACE_A])],
      [{ namespace_id: NAMESPACE_A }],
      [],
      [],
      [],
      [identity],
      [replay],
      [{ memory_id: MEMORY_ID, content_revision: 1, crypto_access_revision: 0, scope_origin_namespace_id: null, importance: 0.4 }],
      [{ namespace_id: NAMESPACE_A }],
      [],
      [{
        crypto_object_id: nextObjectId,
        required_namespace_fingerprint:
          fingerprintRequiredMemoryNamespaces([NAMESPACE_A]),
      }],
      [identity],
      [replay],
    ]);
    const { port } = await createPort(connection);
    const request = {
      action: "replace" as const,
      publicationIdempotencyId: "background.publication.update.1",
      descriptorHash: new Uint8Array(32).fill(0x51),
      authority: namespaceAuthority,
      memoryId: MEMORY_ID,
      expectedContentRevision: 1,
      expectedCryptoAccessRevision: 0,
      nextContentRevision: 2,
      cryptoObjectId: nextObjectId,
      requiredNamespaceIds: [NAMESPACE_A],
      createdAt: CREATED_AT.getTime(),
      embedding,
      importance: 0.4,
    } as const;

    const first = await port.planBackgroundOutput(request);
    expect(first.status).toBe("success");
    const operationInsert = connection.queries.find((query) =>
      normalizedSql(query.statement).includes(
        "insert into memory_crypto_operations",
      )
    );
    const requestDigest = operationInsert?.parameters.find((parameter) =>
      parameter instanceof Uint8Array
    );
    expect(requestDigest).toBeInstanceOf(Uint8Array);
    replay.request_digest = Uint8Array.from(
      requestDigest as Uint8Array,
    );
    replay.created_at = operationInsert!.parameters.find((parameter) =>
      typeof parameter === "string" && parameter.endsWith("Z")
    ) as string;
    expect(await port.planBackgroundOutput(request)).toEqual(first);

    expect(await port.planBackgroundOutput({
      ...request,
      descriptorHash: new Uint8Array(32).fill(0x52),
    })).toEqual({ status: "unavailable", reason: "integrity_failure" });
    expect(connection.queries.some((query) =>
      normalizedSql(query.statement).includes("update memories")
      || normalizedSql(query.statement).includes("update memory_crypto_revisions")
    )).toBe(false);
    connection.assertExhausted();
  });

  test("snapshots mutable background coordinates before its first await", async () => {
    const mutableDescriptorHash = new Uint8Array(32).fill(0x61);
    const mutableVector = new Array<number>(1536).fill(0.01);
    const mutableRequired = [NAMESPACE_A];
    const mutableReadable = [NAMESPACE_A, NAMESPACE_B];
    const mutableMutable = [NAMESPACE_A];
    const mutableAuthority = {
      mode: "namespace" as const,
      subjectUserId: USER_ID,
      agentId: AGENT_ID,
      readableNamespaceIds: mutableReadable,
      mutableNamespaceIds: mutableMutable,
      writableNamespaceId: NAMESPACE_A,
    };
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      [identity],
      [],
      [],
      [],
      [],
    ]);
    const { port } = await createPort(connection);
    const pending = port.planBackgroundOutput({
      action: "create",
      publicationIdempotencyId: "background.publication.mutable.1",
      descriptorHash: mutableDescriptorHash,
      authority: mutableAuthority,
      memoryId: MEMORY_ID_2,
      expectedContentRevision: 0,
      expectedCryptoAccessRevision: 0,
      nextContentRevision: 1,
      cryptoObjectId: deriveMemoryCryptoObjectIdV1({
        memoryId: MEMORY_ID_2,
        contentRevision: 1,
      }),
      requiredNamespaceIds: mutableRequired,
      createdAt: CREATED_AT.getTime(),
      embedding: {
        ...embedding,
        vector: mutableVector,
      },
      importance: 0.5,
    });
    mutableDescriptorHash.fill(0x7f);
    mutableVector[0] = 99;
    mutableRequired[0] = NAMESPACE_B;
    mutableReadable[0] = NAMESPACE_B;
    mutableMutable[0] = NAMESPACE_B;

    const result = await pending;
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.value.requiredNamespaceIds).toEqual([NAMESPACE_A]);
    }
    expect(connection.queries.some((query) =>
      normalizedSql(query.statement).includes("insert into memories")
      || normalizedSql(query.statement).includes("insert into memory_namespaces")
    )).toBe(false);
    connection.assertExhausted();
  });

  test("rejects mismatched background revision, object, and authority set before SQL", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
    ]);
    const { port } = await createPort(connection);
    const base = {
      action: "create" as const,
      publicationIdempotencyId: "background.publication.invalid.1",
      descriptorHash: new Uint8Array(32),
      authority: namespaceAuthority,
      memoryId: MEMORY_ID_2,
      expectedContentRevision: 0,
      expectedCryptoAccessRevision: 0,
      nextContentRevision: 1,
      cryptoObjectId: deriveMemoryCryptoObjectIdV1({
        memoryId: MEMORY_ID_2,
        contentRevision: 1,
      }),
      requiredNamespaceIds: [NAMESPACE_A],
      createdAt: CREATED_AT.getTime(),
      embedding,
      importance: 0.5,
    } as const;
    expect(await port.planBackgroundOutput({
      ...base,
      nextContentRevision: 2,
    })).toEqual({ status: "unavailable", reason: "authorization_required" });
    expect(await port.planBackgroundOutput({
      ...base,
      cryptoObjectId: "memory.wrong",
    })).toEqual({ status: "unavailable", reason: "authorization_required" });
    expect(await port.planBackgroundOutput({
      ...base,
      requiredNamespaceIds: [NAMESPACE_B],
    })).toEqual({ status: "unavailable", reason: "authorization_required" });
    expect(connection.queries).toHaveLength(1);
    connection.assertExhausted();
  });

  test.each(["protected_only", "ordinary_and_protected"] as const)("publishes the exact prepared revision with %s and closes its receipt", async (representation) => {
    const plan: ProtectedMemoryMutationPlan = Object.freeze({
      operationId: "memory.save.1",
      action: "created",
      mutationKind: "background",
      memoryId: MEMORY_ID,
      contentRevision: 1,
      cryptoAccessRevision: 0,
      expectedPriorAccessRevision: 0,
      cryptoObjectId: deriveMemoryCryptoObjectIdV1({
        memoryId: MEMORY_ID,
        contentRevision: 1,
      }),
      requiredNamespaceIds: Object.freeze([NAMESPACE_A]),
      reservationDigest: operationRow().request_digest,
      mutationCommitment: MUTATION_COMMITMENT,
      importance: 0.7,
      createdAt: CREATED_AT.getTime(),
    });
    const prepared = Object.freeze({
      memoryId: MEMORY_ID,
      contentRevision: 1,
      cryptoAccessRevision: 0,
      objectId: plan.cryptoObjectId,
      objectType: MEMORY_OBJECT_TYPE,
      payloadVersion: MEMORY_PAYLOAD_VERSION,
      requiredNamespaceIds: Object.freeze([NAMESPACE_A]),
    }) as PreparedMemoryCryptoRevision;
    const operation = operationRow();
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      [identity],
      [operation],
      [{
        crypto_object_id: plan.cryptoObjectId,
        required_namespace_fingerprint:
          fingerprintRequiredMemoryNamespaces([NAMESPACE_A]),
        allocation_request_digest: operation.request_digest,
      }],
      [identity],
      [operation],
      [{
        crypto_object_id: plan.cryptoObjectId,
        required_namespace_fingerprint:
          fingerprintRequiredMemoryNamespaces([NAMESPACE_A]),
        allocation_request_digest: operation.request_digest,
        completion: "pending",
        disposition: "active",
      }],
      [],
      [],
      [],
      [{ id: MEMORY_ID }],
      [{ sequence: 1 }],
      [{ operation_id: plan.operationId }],
    ]);
    const deps = dependencies();
    let guards = 0;
    let payloadReads = 0;
    const beforeLocks = async () => { guards += 1; };
    const { port } = await createPort(connection, { deps, publication: representation === "protected_only"
      ? { representation, beforeLocks }
      : { representation, beforeLocks, readPreparedPayload: (revision) => {
        expect(revision).toBe(prepared);
        expect(deps.completed).toEqual([prepared]);
        payloadReads += 1;
        return { formatVersion: 1, type: "private authored type", content: "verified Shadow body" };
      } },
    });

    expect(await port.publishPrepared({
      authority: namespaceAuthority,
      plan,
      prepared,
      embedding,
    })).toBe("published");
    expect(deps.completed).toEqual([prepared]);
    expect(guards).toBe(2);
    expect(payloadReads).toBe(representation === "protected_only" ? 0 : 1);
    const insert = connection.queries.find((query) => normalizedSql(query.statement).includes("insert into memories"));
    expect(insert).toBeDefined();
    expect(insert!.parameters.includes("private authored type")).toBe(representation === "ordinary_and_protected");
    expect(insert!.parameters.includes("verified Shadow body")).toBe(representation === "ordinary_and_protected");
    expect(insert!.parameters).toContain("unmapped");
    expect(insert!.parameters).not.toContain(plan.cryptoObjectId);
    const mapping = connection.queries.find((query) =>
      normalizedSql(query.statement).includes("update memories")
      && query.parameters.includes(plan.cryptoObjectId)
    );
    expect(mapping?.parameters).toContain("verified");
    expect(connection.isolationLevels).toEqual(["serializable", "serializable"]);
    connection.assertExhausted();
  });

  test("publishes an update against its prior access revision while the new object starts at access revision zero", async () => {
    const previousObjectId = deriveMemoryCryptoObjectIdV1({ memoryId: MEMORY_ID, contentRevision: 1 });
    const nextObjectId = deriveMemoryCryptoObjectIdV1({ memoryId: MEMORY_ID, contentRevision: 2 });
    const operation = operationRow({
      operation_id: "memory.replace.access-7",
      expected_content_revision: 1,
      result_content_revision: 2,
      expected_access_revision: 7,
    });
    const plan: ProtectedMemoryMutationPlan = Object.freeze({
      operationId: operation.operation_id,
      action: "updated",
      mutationKind: "background",
      memoryId: MEMORY_ID,
      contentRevision: 2,
      cryptoAccessRevision: 0,
      expectedPriorAccessRevision: 7,
      cryptoObjectId: nextObjectId,
      requiredNamespaceIds: Object.freeze([NAMESPACE_A]),
      reservationDigest: operation.request_digest,
      mutationCommitment: MUTATION_COMMITMENT,
      importance: 0.4,
      createdAt: CREATED_AT.getTime(),
    });
    const prepared = Object.freeze({
      memoryId: MEMORY_ID,
      contentRevision: 2,
      objectId: nextObjectId,
      objectType: MEMORY_OBJECT_TYPE,
      payloadVersion: MEMORY_PAYLOAD_VERSION,
      requiredNamespaceIds: Object.freeze([NAMESPACE_A]),
    }) as PreparedMemoryCryptoRevision;
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      [identity],
      [operation],
      [{
        crypto_object_id: nextObjectId,
        required_namespace_fingerprint: fingerprintRequiredMemoryNamespaces([NAMESPACE_A]),
        allocation_request_digest: operation.request_digest,
      }],
      [identity],
      [operation],
      [{
        crypto_object_id: nextObjectId,
        required_namespace_fingerprint: fingerprintRequiredMemoryNamespaces([NAMESPACE_A]),
        allocation_request_digest: operation.request_digest,
        completion: "pending",
        disposition: "active",
      }],
      [candidateRow([NAMESPACE_A], {
        content_revision: 1,
        crypto_access_revision: 7,
        crypto_object_id: previousObjectId,
      })],
      [{ namespace_id: NAMESPACE_A }],
      [],
      [{ id: MEMORY_ID }],
      [],
      [{ sequence: 2 }],
      [{ operation_id: operation.operation_id }],
    ]);
    const { port } = await createPort(connection);
    expect(await port.publishPrepared({ authority: namespaceAuthority, plan, prepared, embedding })).toBe("published");
    connection.assertExhausted();
  });

  test("commits tier metadata once and replays the same operation ID", async () => {
    const objectId = deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_ID,
      contentRevision: 1,
    });
    const target = Object.freeze({
      memoryId: MEMORY_ID,
      contentRevision: 1,
      cryptoAccessRevision: 0,
      cryptoObjectId: objectId,
      requiredNamespaceIds: Object.freeze([NAMESPACE_A]),
    });
    const replay = operationRow({
      operation_id: "memory.tier.1",
      operation_type: "metadata",
      result_content_revision: null,
      completion: "complete",
    });
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      [identity],
      [],
      [candidateRow([NAMESPACE_A])],
      [{ namespace_id: NAMESPACE_A }],
      [],
      [{ id: MEMORY_ID }],
      [],
      [identity],
      [replay],
    ]);
    const { port } = await createPort(connection);
    const request = {
      operationId: "memory.tier.1",
      authority: namespaceAuthority,
      target,
      action: "demote" as const,
    };

    expect(await port.commitTier(request)).toBe("applied");
    const metadataInsert = connection.queries.find((query) =>
      normalizedSql(query.statement).includes(
        "insert into memory_crypto_operations",
      ) && query.parameters.includes("metadata")
    );
    expect(metadataInsert).toBeDefined();
    const requestDigest = metadataInsert!.parameters.find((parameter) =>
      parameter instanceof Uint8Array
    );
    expect(requestDigest).toBeInstanceOf(Uint8Array);
    replay.request_digest = Uint8Array.from(
      requestDigest as Uint8Array,
    );
    expect(await port.commitTier(request)).toBe("replayed");
    expect(connection.queries.filter((query) =>
      normalizedSql(query.statement).includes("update memories")
    )).toHaveLength(1);
    connection.assertExhausted();
  });

  test("binds an exact signed background tier CAS and descriptor replay", async () => {
    const objectId = deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_ID,
      contentRevision: 1,
    });
    const replay = operationRow({
      operation_id: "background.tier.1",
      operation_type: "metadata",
      expected_content_revision: 1,
      expected_access_revision: 0,
      result_content_revision: null,
      completion: "complete",
    });
    const current = candidateRow([NAMESPACE_A], { tier: 2 });
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      [identity],
      [],
      [current],
      [{ namespace_id: NAMESPACE_A }],
      [],
      [identity],
      [],
      [current],
      [{ namespace_id: NAMESPACE_A }],
      [],
      [{ id: MEMORY_ID }],
      [],
      [identity],
      [replay],
      [identity],
      [replay],
    ]);
    const { port } = await createPort(connection);
    const plan = Object.freeze({
      operationIdempotencyId: "background.tier.1",
      descriptorHash: new Uint8Array(32).fill(0x71),
      authority: namespaceAuthority,
      memoryId: MEMORY_ID,
      contentRevision: 1,
      cryptoAccessRevision: 0,
      cryptoObjectId: objectId,
      action: "promote" as const,
      expectedTier: 2 as const,
      nextTier: 1 as const,
      requiredNamespaceIds: Object.freeze([NAMESPACE_A]),
    });

    expect(await port.commitBackgroundTier({ plan })).toBe("applied");
    const metadataInsert = connection.queries.find((query) =>
      query.statement.includes("Agent background Memory tier CAS")
    );
    expect(metadataInsert).toBeUndefined();
    const receipt = connection.queries.find((query) =>
      normalizedSql(query.statement).includes(
        "insert into memory_crypto_operations",
      ) && query.parameters.includes("background.tier.1")
    );
    const requestDigest = receipt?.parameters.find((parameter) =>
      parameter instanceof Uint8Array
    );
    expect(requestDigest).toBeInstanceOf(Uint8Array);
    replay.request_digest = Uint8Array.from(
      requestDigest as Uint8Array,
    );
    expect(await port.commitBackgroundTier({ plan })).toBe("replayed");
    expect(connection.queries.filter((query) =>
      normalizedSql(query.statement).includes("crypto_access_revision")
      && normalizedSql(query.statement).includes("update memories")
    )).toHaveLength(1);
    connection.assertExhausted();
  });
});
