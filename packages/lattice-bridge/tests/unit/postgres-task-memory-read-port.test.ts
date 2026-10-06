import { describe, expect, test } from "bun:test";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

import type {
  AgentMemoryEmbedding,
  AgentMemorySearchCandidate,
} from "../../src/memory/active-memory-composition.ts";
import type { ProtectedMemoryAuthority } from
  "../../src/memory/active-memory-repository.ts";
import {
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
} from "../../src/memory/memory-repository.ts";
import {
  bindConversationProductCanonicalTransactionRunner,
  verifyConversationProductPostgresHandle,
  type ConversationProductCanonicalTransactionConnection,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresIsolationLevel,
} from "../../src/server/message/postgres-conversation-product-store.ts";
import { PostgresTaskMemoryReadPort } from
  "../../src/server/memory/postgres-task-memory-read-port.ts";
import type { TaskMemoryReadBinding } from
  "../../src/server/memory/postgres-task-memory-read-port.ts";
import type { TaskMemoryReadBoundary } from
  "../../src/server/memory/postgres-task-memory-read-port.ts";

type Query = Readonly<{
  statement: string;
  parameters: readonly unknown[];
}>;

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
    options: Readonly<{ isolationLevel: ConversationProductPostgresIsolationLevel }>,
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
          current_user: "nautilo",
          session_user: "nautilo",
        }]),
      } as unknown as CanonicalTranscriptTx, connection);
    },
  };
}

const USER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "10000000-0000-4000-8000-000000000002";
const TASK_ID = "10000000-0000-4000-8000-000000000003";
const ROOM_ID = "10000000-0000-4000-8000-000000000004";
const SCOPE_ID = "10000000-0000-4000-8000-000000000005";
const FOREIGN_SCOPE_ID = "10000000-0000-4000-8000-000000000006";
const MEMORY_A = "20000000-0000-4000-8000-000000000001";
const MEMORY_B = "20000000-0000-4000-8000-000000000002";
const MEMORY_C = "20000000-0000-4000-8000-000000000003";
const NAMESPACE_A = "30000000-0000-4000-8000-000000000001";
const NAMESPACE_B = "30000000-0000-4000-8000-000000000002";
const NAMESPACE_C = "30000000-0000-4000-8000-000000000003";
const CREATED_AT = new Date("2027-01-15T08:00:00.123Z");

const embedding: AgentMemoryEmbedding = Object.freeze({
  vector: Object.freeze(new Array<number>(1536).fill(0.01)),
  provider: "openai",
  canonicalModel: "text-embedding-3-small",
  dimensions: 1536,
  contractVersion: 1,
});

const namespaceAuthority: Extract<
  ProtectedMemoryAuthority,
  { mode: "namespace" }
> = Object.freeze({
  mode: "namespace",
  subjectUserId: USER_ID,
  agentId: AGENT_ID,
  readableNamespaceIds: Object.freeze([NAMESPACE_A]),
  mutableNamespaceIds: Object.freeze([NAMESPACE_A]),
  writableNamespaceId: NAMESPACE_A,
});

const scopeAuthority: Extract<
  ProtectedMemoryAuthority,
  { mode: "scope" }
> = Object.freeze({
  mode: "scope",
  subjectUserId: USER_ID,
  agentId: AGENT_ID,
  scopeId: SCOPE_ID,
  originWritableNamespaceId: NAMESPACE_A,
});

const identity = Object.freeze({
  current_user: "nautilo",
  session_user: "nautilo",
  current_user_id: USER_ID,
  current_agent_id: AGENT_ID,
});

function verifiedRow(input: Readonly<{
  memoryId: string;
  requiredNamespaceIds: readonly string[];
  ordinary: boolean;
  distance: number;
}>) {
  return Object.freeze({
    memory_id: input.memoryId,
    content_revision: 1,
    crypto_access_revision: 0,
    crypto_mapping_state: "verified",
    importance: 0.7,
    tier: 1,
    created_at: CREATED_AT,
    ordinary_type_present: input.ordinary,
    ordinary_content_present: input.ordinary,
    distance: input.distance,
    similarity: 1 - input.distance,
    crypto_object_id: deriveMemoryCryptoObjectIdV1({
      memoryId: input.memoryId,
      contentRevision: 1,
    }),
    crypto_required_namespace_fingerprint:
      fingerprintRequiredMemoryNamespaces(input.requiredNamespaceIds),
    scope_origin_namespace_id: null,
    scope_origin_count: 0,
  });
}

function unmappedRow(memoryId: string, distance: number) {
  return Object.freeze({
    memory_id: memoryId,
    content_revision: 1,
    crypto_access_revision: 0,
    crypto_mapping_state: "unmapped",
    importance: 0.6,
    tier: 1,
    created_at: CREATED_AT,
    ordinary_type_present: true,
    ordinary_content_present: true,
    distance,
    similarity: 1 - distance,
    crypto_object_id: null,
    crypto_required_namespace_fingerprint: null,
    scope_origin_namespace_id: null,
    scope_origin_count: 0,
  });
}

async function createPort(
  connection: ScriptedConnection,
  binding: TaskMemoryReadBinding,
  boundaries: ProtectedMemoryAuthority[] = [],
  boundary?: TaskMemoryReadBoundary,
) {
  const handle = await verifyConversationProductPostgresHandle(connection);
  const canonicalRunner = bindConversationProductCanonicalTransactionRunner(
    handle,
    canonicalConnection(connection),
  );
  return new PostgresTaskMemoryReadPort({
    handle,
    canonicalRunner,
    binding,
    boundary: boundary ?? {
      withCurrentRead: ({ authority, use }) => {
        boundaries.push(authority);
        return use();
      },
    },
  });
}

describe("PostgresTaskMemoryReadPort", () => {
  test("lends the exact canonical transaction and executor to the held boundary", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      [identity],
      [],
    ]);
    const handle = await verifyConversationProductPostgresHandle(connection);
    const canonical = {
      execute: () => Promise.resolve([{
        current_user: "nautilo",
        session_user: "nautilo",
      }]),
    } as unknown as CanonicalTranscriptTx;
    const canonicalRunner = bindConversationProductCanonicalTransactionRunner(
      handle,
      {
        transaction: (callback, options) => {
          connection.isolationLevels.push(options.isolationLevel);
          return callback(canonical, connection);
        },
      },
    );
    let boundaryCalls = 0;
    const port = new PostgresTaskMemoryReadPort({
      handle,
      canonicalRunner,
      binding: { mode: "namespace", authority: namespaceAuthority },
      boundary: {
        withCurrentRead: ({ transaction, executor, use }) => {
          boundaryCalls += 1;
          expect(transaction).toBe(canonical);
          expect(executor).toBe(connection);
          return use();
        },
      },
    });

    expect(await port.searchCandidates({
      authority: namespaceAuthority,
      embedding,
      limit: 1,
      includeArchive: false,
    })).toEqual({ status: "success", value: [] });
    expect(boundaryCalls).toBe(1);
    expect(connection.isolationLevels).toEqual(["serializable"]);
    connection.assertExhausted();
  });

  test("keeps one ranked mixed list and preserves a hidden complete audience", async () => {
    const dual = verifiedRow({
      memoryId: MEMORY_A,
      requiredNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      ordinary: true,
      distance: 0.1,
    });
    const ordinary = unmappedRow(MEMORY_B, 0.2);
    const protectedOnly = verifiedRow({
      memoryId: MEMORY_C,
      requiredNamespaceIds: [NAMESPACE_A],
      ordinary: false,
      distance: 0.3,
    });
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      [identity],
      [dual, ordinary, protectedOnly],
      [dual, ordinary, protectedOnly],
      [
        { memory_id: MEMORY_A, namespace_id: NAMESPACE_A },
        { memory_id: MEMORY_A, namespace_id: NAMESPACE_B },
        { memory_id: MEMORY_B, namespace_id: NAMESPACE_A },
        { memory_id: MEMORY_C, namespace_id: NAMESPACE_A },
      ],
    ]);
    const boundaries: ProtectedMemoryAuthority[] = [];
    const port = await createPort(connection, {
      mode: "namespace",
      authority: namespaceAuthority,
    }, boundaries);

    const result = await port.searchCandidates({
      authority: namespaceAuthority,
      embedding,
      limit: 3,
      includeArchive: false,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error(result.reason);
    expect(result.value.map(candidate => [
      candidate.memoryId,
      candidate.representation,
      candidate.requiredNamespaceIds,
    ])).toEqual([
      [MEMORY_A, "dual", [NAMESPACE_A, NAMESPACE_B]],
      [MEMORY_B, "ordinary_only", [NAMESPACE_A]],
      [MEMORY_C, "protected_only", [NAMESPACE_A]],
    ]);
    expect(boundaries).toEqual([namespaceAuthority]);
    expect(connection.isolationLevels).toEqual(["serializable"]);
    connection.assertExhausted();
  });

  test("revalidates exact ordinary currentness before exposing source plaintext", async () => {
    const selected = Object.freeze({
      ...verifiedRow({
        memoryId: MEMORY_A,
        requiredNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
        ordinary: true,
        distance: 0.1,
      }),
      representation: "dual" as const,
    });
    const candidate: AgentMemorySearchCandidate = Object.freeze({
      representation: "dual",
      memoryId: MEMORY_A,
      contentRevision: 1,
      cryptoAccessRevision: 0,
      cryptoObjectId: selected.crypto_object_id,
      readNamespaceId: NAMESPACE_A,
      requiredNamespaceIds: Object.freeze([NAMESPACE_A, NAMESPACE_B]),
      importance: 0.7,
      tier: 1,
      score: 0.9,
      createdAt: CREATED_AT,
    });
    const drifted = Object.freeze({ ...selected, content_revision: 2 });
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      [identity],
      [drifted],
      [
        { memory_id: MEMORY_A, namespace_id: NAMESPACE_A },
        { memory_id: MEMORY_A, namespace_id: NAMESPACE_B },
      ],
    ]);
    const port = await createPort(connection, {
      mode: "namespace",
      authority: namespaceAuthority,
    });

    expect(await port.loadExactOrdinary({
      authority: namespaceAuthority,
      candidates: [candidate],
    })).toEqual({ status: "unavailable", reason: "stale_revision" });
    expect(connection.queries.some(query =>
      /select.+\bcontent\b.+from.+memories/isu.test(query.statement)
    )).toBe(false);
    connection.assertExhausted();
  });

  test("keeps ordinary bodies inside held authority and exposes no result after a late failure", async () => {
    const selected = verifiedRow({
      memoryId: MEMORY_A,
      requiredNamespaceIds: [NAMESPACE_A],
      ordinary: true,
      distance: 0.1,
    });
    const candidate: AgentMemorySearchCandidate = Object.freeze({
      representation: "dual",
      memoryId: MEMORY_A,
      contentRevision: 1,
      cryptoAccessRevision: 0,
      cryptoObjectId: selected.crypto_object_id,
      readNamespaceId: NAMESPACE_A,
      requiredNamespaceIds: Object.freeze([NAMESPACE_A]),
      importance: 0.7,
      tier: 1,
      score: 0.9,
      createdAt: CREATED_AT,
    });
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      [identity],
      [selected],
      [{ memory_id: MEMORY_A, namespace_id: NAMESPACE_A }],
      [selected],
      [{
        memory_id: MEMORY_A,
        content_revision: 1,
        type: "fact",
        content: "held plaintext",
      }],
    ]);
    let bodyLoadedWhileHeld = false;
    const port = await createPort(
      connection,
      { mode: "namespace", authority: namespaceAuthority },
      [],
      {
        withCurrentRead: async ({ use }) => {
          const receipt = await use();
          bodyLoadedWhileHeld = connection.queries.some(query =>
            query.parameters.includes("held plaintext")
            || /select.+\bcontent\b.+from.+memories/isu.test(query.statement)
          );
          expect(receipt).toBeDefined();
          throw new Error("read authority expired");
        },
      },
    );

    expect(port.loadExactOrdinary({
      authority: namespaceAuthority,
      candidates: [candidate],
    })).rejects.toThrow("read authority expired");
    expect(bodyLoadedWhileHeld).toBe(true);
    connection.assertExhausted();
  });

  test("rejects manufactured, duplicate, and escaped held-read callback use", async () => {
    let escaped: (() => Promise<unknown>) | null = null;
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
    ]);
    const port = await createPort(
      connection,
      { mode: "namespace", authority: namespaceAuthority },
      [],
      {
        withCurrentRead: async ({ use }) => {
          escaped = use;
          return Object.freeze({ value: { status: "success", value: [] } }) as never;
        },
      },
    );
    expect(port.searchCandidates({
      authority: namespaceAuthority,
      embedding,
      limit: 1,
      includeArchive: false,
    })).rejects.toThrow("manufactured result");
    expect(escaped).not.toBeNull();
    expect(escaped!()).rejects.toThrow("one-use");
    connection.assertExhausted();

    const duplicateConnection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      [identity],
      [],
    ]);
    const duplicatePort = await createPort(
      duplicateConnection,
      { mode: "namespace", authority: namespaceAuthority },
      [],
      {
        withCurrentRead: async ({ use }) => {
          const receipt = await use();
          const duplicate = use();
          expect(duplicate).rejects.toThrow("one-use");
          await duplicate.catch(() => undefined);
          return receipt;
        },
      },
    );
    expect(duplicatePort.searchCandidates({
      authority: namespaceAuthority,
      embedding,
      limit: 1,
      includeArchive: false,
    })).rejects.toThrow("manufactured result");
    duplicateConnection.assertExhausted();
  });

  test("Scope reads retain foreign audience edges under the current Task binding", async () => {
    const required = [NAMESPACE_A, NAMESPACE_B, NAMESPACE_C];
    const ranked = verifiedRow({
      memoryId: MEMORY_A,
      requiredNamespaceIds: required,
      ordinary: true,
      distance: 0.1,
    });
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      [identity],
      [identity],
      [{
        id: TASK_ID,
        requestor_id: USER_ID,
        agent_id: AGENT_ID,
        use_scope: true,
        scope_id: SCOPE_ID,
      }],
      [{
        id: SCOPE_ID,
        parent_agent_id: AGENT_ID,
        speaker_user_id: USER_ID,
        lifecycle_state: "open",
        revision: 0,
      }],
      [{ id: ROOM_ID, namespace_id: NAMESPACE_A }],
      [{
        id: MEMORY_A,
        origin: "seed",
        content_revision: 1,
        crypto_object_id: ranked.crypto_object_id,
        crypto_access_revision: 0,
        crypto_mapping_state: "verified",
        crypto_required_namespace_fingerprint:
          fingerprintRequiredMemoryNamespaces(required),
        scope_origin_namespace_id: NAMESPACE_C,
      }],
      [
        { memory_id: MEMORY_A, namespace_id: NAMESPACE_A },
        { memory_id: MEMORY_A, namespace_id: NAMESPACE_B },
      ],
      [
        { memory_id: MEMORY_A, scope_id: SCOPE_ID, origin: "seed" },
        { memory_id: MEMORY_A, scope_id: FOREIGN_SCOPE_ID, origin: "scope" },
      ],
      [ranked],
    ]);
    const port = await createPort(connection, {
      mode: "scope",
      authority: scopeAuthority,
      coordinates: {
        taskId: TASK_ID,
        requesterUserId: USER_ID,
        agentId: AGENT_ID,
        scopeId: SCOPE_ID,
        memoryRoomId: ROOM_ID,
        originWritableNamespaceId: NAMESPACE_A,
      },
      readableNamespaceIds: [NAMESPACE_A],
    });

    const result = await port.searchCandidates({
      authority: scopeAuthority,
      embedding,
      limit: 4,
      includeArchive: false,
    });
    if (result.status !== "success") throw new Error(result.reason);
    expect(result.status).toBe("success");
    expect(result.value).toHaveLength(1);
    expect(result.value[0]).toMatchObject({
      memoryId: MEMORY_A,
      representation: "dual",
      readNamespaceId: NAMESPACE_A,
      requiredNamespaceIds: required,
    });
    connection.assertExhausted();
  });

  test("rejects Agent-role construction so reads cannot inherit truncated RLS rows", async () => {
    const connection = new ScriptedConnection([[
      { current_user: "nautilo_agent", session_user: "nautilo_agent" },
    ]]);
    const handle = await verifyConversationProductPostgresHandle(connection);
    const canonicalRunner = bindConversationProductCanonicalTransactionRunner(
      handle,
      canonicalConnection(connection),
    );
    expect(() => new PostgresTaskMemoryReadPort({
      handle,
      canonicalRunner,
      binding: { mode: "namespace", authority: namespaceAuthority },
      boundary: { withCurrentRead: ({ use }) => use() },
    })).toThrow("requires a direct nautilo handle");
  });
});
