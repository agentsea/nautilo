import { describe, expect, test } from "bun:test";

import { deriveMemoryCryptoObjectIdV1 } from
  "../../src/memory/memory-repository.ts";
import type {
  ConversationProductDatabaseRow,
  ConversationProductPostgresScalar,
  ConversationProductPostgresTransaction,
} from "../../src/server/message/postgres-conversation-product-store.ts";
import {
  adoptLegacyTaskScopeMemoryOrigin,
} from "../../src/server/task/task-scope-memory-origin-adoption.ts";

type Query = Readonly<{
  statement: string;
  parameters: readonly ConversationProductPostgresScalar[];
}>;

class ScriptedTransaction implements ConversationProductPostgresTransaction {
  readonly queries: Query[] = [];
  readonly #results: Array<readonly unknown[]>;

  constructor(results: readonly (readonly unknown[])[]) {
    this.#results = [...results];
  }

  query<Row extends ConversationProductDatabaseRow>(
    statement: string,
    parameters: readonly ConversationProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    this.queries.push({ statement, parameters });
    const result = this.#results.shift();
    if (result === undefined) {
      return Promise.reject(new Error(`Unexpected SQL: ${statement}`));
    }
    return Promise.resolve(result as readonly Row[]);
  }

  assertExhausted(): void {
    expect(this.#results).toEqual([]);
  }
}

const USER = "10000000-0000-4000-8000-000000000001";
const AGENT = "10000000-0000-4000-8000-000000000002";
const TASK = "10000000-0000-4000-8000-000000000003";
const ROOM = "10000000-0000-4000-8000-000000000004";
const SCOPE = "10000000-0000-4000-8000-000000000005";
const FOREIGN_SCOPE = "10000000-0000-4000-8000-000000000006";
const MEMORY = "20000000-0000-4000-8000-000000000001";
const ORIGIN = "30000000-0000-4000-8000-000000000001";
const OTHER_ORIGIN = "30000000-0000-4000-8000-000000000002";
const ORDINARY = "30000000-0000-4000-8000-000000000003";

const coordinates = Object.freeze({
  taskId: TASK,
  requesterUserId: USER,
  agentId: AGENT,
  scopeId: SCOPE,
  memoryRoomId: ROOM,
  originWritableNamespaceId: ORIGIN,
});

const identity = Object.freeze({
  current_user: "nautilo",
  session_user: "nautilo",
  current_user_id: USER,
  current_agent_id: AGENT,
});

const scope = Object.freeze({
  id: SCOPE,
  parent_agent_id: AGENT,
  speaker_user_id: USER,
  lifecycle_state: "open",
  revision: "7",
});

const task = Object.freeze({
  id: TASK,
  requestor_id: USER,
  agent_id: AGENT,
  use_scope: true,
  scope_id: SCOPE,
});

const room = Object.freeze({
  id: ROOM,
  namespace_id: ORIGIN,
});

function memory(overrides: Readonly<Record<string, unknown>> = {}) {
  return Object.freeze({
    id: MEMORY,
    origin: "scope",
    ordinary_type_present: true,
    ordinary_content_present: true,
    content_revision: "0",
    crypto_access_revision: "0",
    crypto_object_id: null,
    crypto_mapping_state: "unmapped",
    crypto_required_namespace_fingerprint: null,
    scope_origin_namespace_id: null,
    ...overrides,
  });
}

function audienceScript(
  selected = memory(),
  scopeEdges: readonly Readonly<Record<string, unknown>>[] = [
    { scope_id: SCOPE, origin: "scope" },
  ],
  ordinaryEdges: readonly Readonly<Record<string, unknown>>[] = [],
) {
  return [
    [identity],
    [task],
    [scope],
    [room],
    [selected],
    ordinaryEdges.map(edge => ({ memory_id: MEMORY, ...edge })),
    scopeEdges.map(edge => ({ memory_id: MEMORY, ...edge })),
  ] as const;
}

describe("Task Scope Memory origin adoption", () => {
  test("adopts one selected ordinary row without changing content or access revisions", async () => {
    const transaction = new ScriptedTransaction([
      ...audienceScript(memory(), [
        { scope_id: SCOPE, origin: "scope" },
        { scope_id: FOREIGN_SCOPE, origin: "scope" },
      ]),
      [],
      [{ id: MEMORY }],
    ]);

    expect(await adoptLegacyTaskScopeMemoryOrigin({
      transaction,
      coordinates,
      memoryId: MEMORY,
    })).toBe("adopted");
    transaction.assertExhausted();

    const update = transaction.queries.at(-1)?.statement ?? "";
    expect(update).toContain("update \"memories\"");
    expect(update).toContain("\"scope_origin_namespace_id\"");
    expect(update.split(" where ")[0]).not.toContain("content_revision");
    expect(update.split(" where ")[0]).not.toContain("crypto_access_revision");
    expect(update).toContain("\"scope_origin_namespace_id\" is null");
    const mappedLookup = transaction.queries.at(-2);
    expect(mappedLookup?.statement).toContain("\"disposition\" =");
    expect(mappedLookup?.statement).toContain("limit");
    expect(mappedLookup?.parameters).toContain("mapped");
  });

  test("does not let an active pending allocation block adoption", async () => {
    const transaction = new ScriptedTransaction([
      ...audienceScript(),
      [],
      [{ id: MEMORY }],
    ]);
    expect(await adoptLegacyTaskScopeMemoryOrigin({
      transaction,
      coordinates,
      memoryId: MEMORY,
    })).toBe("adopted");
    transaction.assertExhausted();
    const mappedLookup = transaction.queries.at(-2);
    expect(mappedLookup?.parameters).toContain(MEMORY);
    expect(mappedLookup?.parameters).toContain("mapped");
  });

  test("replays the same origin and preserves a different first winner", async () => {
    const same = new ScriptedTransaction(audienceScript(memory({
      scope_origin_namespace_id: ORIGIN,
    })));
    expect(await adoptLegacyTaskScopeMemoryOrigin({
      transaction: same,
      coordinates,
      memoryId: MEMORY,
    })).toBe("replayed");
    same.assertExhausted();
    expect(same.queries.some(query =>
      query.statement.startsWith("update \"memories\""))).toBe(false);

    const other = new ScriptedTransaction(audienceScript(memory({
      scope_origin_namespace_id: OTHER_ORIGIN,
    })));
    expect(await adoptLegacyTaskScopeMemoryOrigin({
      transaction: other,
      coordinates,
      memoryId: MEMORY,
    })).toBe("stale");
    other.assertExhausted();
    expect(other.queries.some(query =>
      query.statement.startsWith("update \"memories\""))).toBe(false);
  });

  test("does not adopt seed edges or rows without an ordinary body", async () => {
    const seed = new ScriptedTransaction([
      ...audienceScript(memory({ origin: "seed" }), [
        { scope_id: SCOPE, origin: "seed" },
      ]),
    ]);
    expect(await adoptLegacyTaskScopeMemoryOrigin({
      transaction: seed,
      coordinates,
      memoryId: MEMORY,
    })).toBe("stale");
    seed.assertExhausted();

    const missingBody = new ScriptedTransaction([
      ...audienceScript(memory({ ordinary_content_present: false })),
    ]);
    expect(await adoptLegacyTaskScopeMemoryOrigin({
      transaction: missingBody,
      coordinates,
      memoryId: MEMORY,
    })).toBe("stale");
    missingBody.assertExhausted();

    const unknownAudience = new ScriptedTransaction([
      ...audienceScript(memory(), [
        { scope_id: SCOPE, origin: "scope" },
      ], [{ namespace_id: ORDINARY }]),
    ]);
    expect(await adoptLegacyTaskScopeMemoryOrigin({
      transaction: unknownAudience,
      coordinates,
      memoryId: MEMORY,
    })).toBe("stale");
    unknownAudience.assertExhausted();
  });

  test("rejects mapped-null product state and an existing mapped revision", async () => {
    const mappedProduct = new ScriptedTransaction(audienceScript(memory({
      content_revision: 1,
      crypto_object_id: deriveMemoryCryptoObjectIdV1({
        memoryId: MEMORY,
        contentRevision: 1,
      }),
      crypto_mapping_state: "verified",
      crypto_required_namespace_fingerprint: new Uint8Array(32),
    })));
    expect(await adoptLegacyTaskScopeMemoryOrigin({
      transaction: mappedProduct,
      coordinates,
      memoryId: MEMORY,
    })).toBe("stale");
    mappedProduct.assertExhausted();

    const mappedLedger = new ScriptedTransaction([
      ...audienceScript(),
      [{
        memory_id: MEMORY,
        content_revision: 1,
      }],
    ]);
    expect(await adoptLegacyTaskScopeMemoryOrigin({
      transaction: mappedLedger,
      coordinates,
      memoryId: MEMORY,
    })).toBe("stale");
    mappedLedger.assertExhausted();
  });

  test("returns stale when the origin CAS does not update the selected row", async () => {
    const transaction = new ScriptedTransaction([
      ...audienceScript(),
      [],
      [],
    ]);
    expect(await adoptLegacyTaskScopeMemoryOrigin({
      transaction,
      coordinates,
      memoryId: MEMORY,
    })).toBe("stale");
    transaction.assertExhausted();
  });
});
