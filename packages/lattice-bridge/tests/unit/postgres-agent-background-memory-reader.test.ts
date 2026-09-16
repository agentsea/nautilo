import { describe, expect, test } from "bun:test";

import type {
  VerifiedAgentMemoryCryptoRevisionReader,
} from "../../src/memory/agent-memory-session-content.ts";
import {
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
  type MemoryCryptoRevisionReference,
} from "../../src/memory/memory-repository.ts";
import { PostgresAgentBackgroundMemoryRevisionReader } from "../../src/server/memory/postgres-agent-background-memory-reader.ts";
import {
  verifyConversationProductPostgresHandle,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresIsolationLevel,
} from "../../src/server/message/postgres-conversation-product-store.ts";

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

const USER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "10000000-0000-4000-8000-000000000002";
const MEMORY_ID = "20000000-0000-4000-8000-000000000001";
const NAMESPACE_A = "30000000-0000-4000-8000-000000000001";
const NAMESPACE_B = "30000000-0000-4000-8000-000000000002";
const SCOPE_ID = "40000000-0000-4000-8000-000000000001";
const OBJECT_ID = deriveMemoryCryptoObjectIdV1({
  memoryId: MEMORY_ID,
  contentRevision: 3,
});
const REQUIRED = Object.freeze([NAMESPACE_A, NAMESPACE_B]);

const identity = Object.freeze({
  current_user_id: USER_ID,
  current_agent_id: AGENT_ID,
});

function productRow(overrides: Record<string, unknown> = {}) {
  const fingerprint = fingerprintRequiredMemoryNamespaces(REQUIRED);
  return {
    memory_id: MEMORY_ID,
    content_revision: 3,
    crypto_access_revision: 4,
    importance: 0.7,
    tier: 2,
    created_at: new Date("2027-01-01T00:00:00.000Z"),
    embedding: JSON.stringify(new Array<number>(1536).fill(0.01)),
    embedding_revision: 3,
    embedding_provider: "openai",
    embedding_model: "text-embedding-3-small",
    embedding_dimensions: 1536,
    embedding_contract_version: 1,
    crypto_object_id: OBJECT_ID,
    crypto_required_namespace_fingerprint: fingerprint,
    scope_origin_namespace_id: null,
    lifecycle_object_id: OBJECT_ID,
    required_namespace_fingerprint: fingerprint,
    completion: "complete",
    disposition: "mapped",
    ...overrides,
  };
}

function snapshotResults(
  product = productRow(),
  namespaceIds: readonly string[] = REQUIRED,
  scopes: readonly Readonly<{ scope_id: string; origin: string }>[] = [{
    scope_id: SCOPE_ID,
    origin: "seed",
  }],
): unknown[][] {
  return [
    [identity],
    [product],
    namespaceIds.map((namespace_id) => ({ namespace_id })),
    [...scopes],
  ];
}

describe("Postgres background Memory revision reader", () => {
  test("authenticates product mapping and full M:N authority around crypto read", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      ...snapshotResults(),
      ...snapshotResults(),
    ]);
    const cryptoReferences: MemoryCryptoRevisionReference[] = [];
    const cryptoReader: VerifiedAgentMemoryCryptoRevisionReader = {
      read(reference) {
        cryptoReferences.push(reference);
        return Promise.resolve(Object.freeze({
          memoryId: MEMORY_ID,
          contentRevision: 3,
          objectId: OBJECT_ID,
          accessRevision: 4,
          accessManifestBytes: new Uint8Array([0x91]),
          accessManifestHash: new Uint8Array(32).fill(0x92),
          accessManifestSignerPublicKey: new Uint8Array(32).fill(0x93),
          requiredNamespaceIds: REQUIRED,
          payloadBytes: new Uint8Array([1, 2, 3]),
          namespaceEnvelopes: Object.freeze([
            Object.freeze({
              namespaceId: NAMESPACE_A,
              envelopeBytes: new Uint8Array([4]),
            }),
            Object.freeze({
              namespaceId: NAMESPACE_B,
              envelopeBytes: new Uint8Array([5]),
            }),
          ]),
        }));
      },
    };
    const handle = await verifyConversationProductPostgresHandle(connection);
    const reader = new PostgresAgentBackgroundMemoryRevisionReader({
      handle,
      cryptoReader,
    });

    const result = await reader.read({
      subjectUserId: USER_ID,
      agentId: AGENT_ID,
      memoryId: MEMORY_ID,
      contentRevision: 3,
      cryptoAccessRevision: 4,
      accessKind: "namespace",
      productAuthority: { mode: "namespace" },
      objectId: OBJECT_ID,
      selectedNamespaceId: NAMESPACE_B,
    });

    expect(result?.requiredNamespaceIds).toEqual(REQUIRED);
    expect(cryptoReferences[0]).toEqual({
      memoryId: MEMORY_ID,
      contentRevision: 3,
      objectId: OBJECT_ID,
      expectedAccessRevision: 4,
      expectedActiveNamespaceFingerprint:
        fingerprintRequiredMemoryNamespaces(REQUIRED),
    });
    expect(connection.isolationLevels).toEqual([
      "serializable",
      "serializable",
    ]);
    expect(connection.queries.map((query) => query.statement).join("\n"))
      .not.toMatch(/memory_row\.(content|type)\b/);
    connection.assertExhausted();
  });

  test("wipes authenticated crypto bytes when the product mapping changes", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      ...snapshotResults(),
      [identity],
      [productRow({ crypto_object_id: "memory.changed" })],
      [{ namespace_id: NAMESPACE_A }, { namespace_id: NAMESPACE_B }],
      [{ scope_id: "40000000-0000-4000-8000-000000000001", origin: "seed" }],
    ]);
    const payloadBytes = new Uint8Array([1, 2, 3]);
    const envelopeBytes = new Uint8Array([4, 5, 6]);
    const accessManifestBytes = new Uint8Array([0x91]);
    const accessManifestHash = new Uint8Array(32).fill(0x92);
    const accessManifestSignerPublicKey = new Uint8Array(32).fill(0x93);
    const handle = await verifyConversationProductPostgresHandle(connection);
    const reader = new PostgresAgentBackgroundMemoryRevisionReader({
      handle,
      cryptoReader: {
        read: () => Promise.resolve(Object.freeze({
          memoryId: MEMORY_ID,
          contentRevision: 3,
          objectId: OBJECT_ID,
          accessRevision: 4,
          accessManifestBytes,
          accessManifestHash,
          accessManifestSignerPublicKey,
          requiredNamespaceIds: REQUIRED,
          payloadBytes,
          namespaceEnvelopes: Object.freeze(REQUIRED.map((namespaceId) =>
            Object.freeze({ namespaceId, envelopeBytes })
          )),
        })),
      },
    });

    expect(await reader.read({
      subjectUserId: USER_ID,
      agentId: AGENT_ID,
      memoryId: MEMORY_ID,
      contentRevision: 3,
      cryptoAccessRevision: 4,
      accessKind: "namespace",
      productAuthority: { mode: "namespace" },
      objectId: OBJECT_ID,
      selectedNamespaceId: NAMESPACE_A,
    })).toBeNull();
    expect(payloadBytes).toEqual(new Uint8Array(3));
    expect(envelopeBytes).toEqual(new Uint8Array(3));
    connection.assertExhausted();
  });

  test("proves exact scope seed and origin access coordinates", async () => {
    const seedRequired = Object.freeze([NAMESPACE_A]);
    const seedFingerprint = fingerprintRequiredMemoryNamespaces(seedRequired);
    const seedProduct = productRow({
      crypto_required_namespace_fingerprint: seedFingerprint,
      required_namespace_fingerprint: seedFingerprint,
      scope_origin_namespace_id: null,
    });
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      ...snapshotResults(seedProduct, seedRequired, [{
        scope_id: SCOPE_ID,
        origin: "seed",
      }]),
      ...snapshotResults(seedProduct, seedRequired, [{
        scope_id: SCOPE_ID,
        origin: "seed",
      }]),
    ]);
    const handle = await verifyConversationProductPostgresHandle(connection);
    const reader = new PostgresAgentBackgroundMemoryRevisionReader({
      handle,
      cryptoReader: {
        read: () => Promise.resolve(Object.freeze({
          memoryId: MEMORY_ID,
          contentRevision: 3,
          objectId: OBJECT_ID,
          accessRevision: 4,
          accessManifestBytes: new Uint8Array([0x91]),
          accessManifestHash: new Uint8Array(32).fill(0x92),
          accessManifestSignerPublicKey: new Uint8Array(32).fill(0x93),
          requiredNamespaceIds: seedRequired,
          payloadBytes: new Uint8Array([1]),
          namespaceEnvelopes: [Object.freeze({
            namespaceId: NAMESPACE_A,
            envelopeBytes: new Uint8Array([2]),
          })],
        })),
      },
    });
    expect(await reader.read({
      subjectUserId: USER_ID,
      agentId: AGENT_ID,
      memoryId: MEMORY_ID,
      contentRevision: 3,
      cryptoAccessRevision: 4,
      accessKind: "scope_seed",
      productAuthority: {
        mode: "scope",
        scopeId: SCOPE_ID,
        originWritableNamespaceId: NAMESPACE_B,
      },
      objectId: OBJECT_ID,
      selectedNamespaceId: NAMESPACE_A,
    })).not.toBeNull();
    expect(connection.queries.some((query) =>
      query.statement.replaceAll('"', "").toLowerCase().includes(
        "scope_id",
      )
      && query.statement.replaceAll('"', "").toLowerCase().includes(
        "from memory_scopes",
      )
    )).toBe(true);
    connection.assertExhausted();
  });
});
