import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";

import {
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
} from "../../src/memory/memory-repository";
import {
  attachPostgresTaskScopeMemoryRepair,
  reservePostgresTaskScopeMemoryRepairSource,
} from "../../src/server/memory/postgres-foreground-memory-repair";
import { isForegroundProductChangedError } from
  "../../src/server/foreground-product-changed";
import type {
  ConversationProductDatabaseRow,
  ConversationProductPostgresScalar,
  ConversationProductPostgresTransaction,
} from "../../src/server/message/postgres-conversation-product-store";

const MEMORY_ID = "10000000-0000-4000-8000-000000000041";
const SCOPE_ID = "10000000-0000-4000-8000-000000000042";
const FOREIGN_SCOPE_ID = "10000000-0000-4000-8000-000000000043";
const ORIGIN_NAMESPACE_ID = "10000000-0000-4000-8000-000000000044";
const FOREIGN_SEED_SCOPE_ID = "10000000-0000-4000-8000-000000000045";
const FOREIGN_NAMESPACE_ID = "10000000-0000-4000-8000-000000000046";
const CREATED_AT = new Date("2027-01-16T08:00:00.000Z");

class ScriptedTransaction implements ConversationProductPostgresTransaction {
  readonly queries: string[] = [];
  readonly parameters: (readonly ConversationProductPostgresScalar[])[] = [];
  readonly #results: Array<readonly unknown[] | Error>;

  constructor(results: readonly (readonly unknown[] | Error)[]) {
    this.#results = [...results];
  }

  query<Row extends ConversationProductDatabaseRow>(
    statement: string,
    parameters: readonly ConversationProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    this.queries.push(statement);
    this.parameters.push(parameters);
    const result = this.#results.shift();
    if (result === undefined) return Promise.reject(new Error("Unexpected query"));
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result as readonly Row[]);
  }
}

function crypto(): LatticeCrypto {
  return new LatticeCrypto({
    bytes: length => new Uint8Array(length).fill(7),
  });
}

function ordinaryRow(embeddingRevision = 0): Readonly<Record<string, unknown>> {
  return {
    id: MEMORY_ID,
    type: "fact",
    content: "the retained body",
    importance: 0.8,
    tier: 1,
    created_at: CREATED_AT,
    content_revision: 0,
    crypto_object_id: null,
    crypto_mapping_state: "unmapped",
    crypto_access_revision: 0,
    crypto_required_namespace_fingerprint: null,
    embedding_revision: embeddingRevision,
    scope_origin_namespace_id: ORIGIN_NAMESPACE_ID,
  };
}

const scopeRows = Object.freeze([
  { scope_id: SCOPE_ID, origin: "scope" },
  // A foreign Scope edge still resolves through the one stored Memory origin.
  { scope_id: FOREIGN_SCOPE_ID, origin: "scope" },
  { scope_id: FOREIGN_SEED_SCOPE_ID, origin: "seed" },
]);

async function reserve() {
  const transaction = new ScriptedTransaction([
    [ordinaryRow()],
    [],
    scopeRows,
    [],
    [],
  ]);
  const source = await reservePostgresTaskScopeMemoryRepairSource({
    transaction,
    crypto: crypto(),
    selection: Object.freeze({
      representation: "structural" as const,
      id: MEMORY_ID,
      type: null,
      importance: 0.8,
      tier: 1,
      createdAt: CREATED_AT,
      score: 0.95,
    }),
    expectedContentRevision: 0,
    scopeId: SCOPE_ID,
    expectedScopeOriginNamespaceId: ORIGIN_NAMESPACE_ID,
  });
  return { source, transaction };
}

function attachResults(source: Awaited<ReturnType<typeof reserve>>["source"]) {
  return [
    [{
      crypto_object_id: deriveMemoryCryptoObjectIdV1({
        memoryId: MEMORY_ID,
        contentRevision: source.source.targetContentRevision,
      }),
      allocation_request_digest: source.source.requestCommitment,
      required_namespace_fingerprint:
        fingerprintRequiredMemoryNamespaces([ORIGIN_NAMESPACE_ID]),
      completion: "pending",
      disposition: "active",
    }],
    [ordinaryRow()],
    [],
    [scopeRows[0]!],
  ] as Array<readonly unknown[]>;
}

describe("Postgres Task Scope Memory repair", () => {
  test("reserves one exact legacy source without locking an existing lifecycle", async () => {
    const { source, transaction } = await reserve();

    expect(source).toMatchObject({
      scopeId: SCOPE_ID,
      expectedScopeOriginNamespaceId: ORIGIN_NAMESPACE_ID,
      expectedEmbeddingRevision: 0,
      source: {
        expectedContentRevision: 0,
        targetContentRevision: 1,
        existingObjectId: null,
        expectedAccessRevision: 0,
        accessNamespaceIds: [ORIGIN_NAMESPACE_ID],
      },
    });
    expect(source.source.plaintextBytes).toBeInstanceOf(Uint8Array);
    const lifecycleRead = transaction.queries.find(query =>
      query.includes('from "memory_crypto_revisions"'));
    expect(lifecycleRead).toBeDefined();
    expect(lifecycleRead!.toLowerCase()).not.toContain("for update");
    expect(transaction.queries[0]!.toLowerCase()).toContain("for update");
  });

  test("rejects changed embedding or stored origin before lifecycle allocation", async () => {
    for (const row of [
      ordinaryRow(1),
      { ...ordinaryRow(), scope_origin_namespace_id: FOREIGN_SCOPE_ID },
    ]) {
      const transaction = new ScriptedTransaction([
        [row],
        [],
        scopeRows,
      ]);
      let thrown: unknown;
      try {
        await reservePostgresTaskScopeMemoryRepairSource({
          transaction,
        crypto: crypto(),
        selection: Object.freeze({
          representation: "structural" as const,
          id: MEMORY_ID,
          type: null,
          importance: 0.8,
          tier: 1,
          createdAt: CREATED_AT,
        }),
        expectedContentRevision: 0,
        scopeId: SCOPE_ID,
          expectedScopeOriginNamespaceId: ORIGIN_NAMESPACE_ID,
        });
      } catch (error) {
        thrown = error;
      }
      expect(isForegroundProductChangedError(thrown)).toBe(true);
      expect(transaction.queries.some(query =>
        query.includes('insert into "memory_crypto_revisions"'))).toBe(false);
    }
  });

  test("requires the selected authored Scope edge and no ordinary audience", async () => {
    for (const [namespaceRows, currentScopeRows] of [
      [[], [{ scope_id: SCOPE_ID, origin: "seed" }]],
      [[{ namespace_id: FOREIGN_NAMESPACE_ID }], scopeRows],
    ] as const) {
      const transaction = new ScriptedTransaction([
        [ordinaryRow()],
        namespaceRows,
        currentScopeRows,
      ]);
      let thrown: unknown;
      try {
        await reservePostgresTaskScopeMemoryRepairSource({
          transaction,
          crypto: crypto(),
          selection: Object.freeze({
            representation: "structural" as const,
            id: MEMORY_ID,
            type: null,
            importance: 0.8,
            tier: 1,
            createdAt: CREATED_AT,
          }),
          expectedContentRevision: 0,
          scopeId: SCOPE_ID,
          expectedScopeOriginNamespaceId: ORIGIN_NAMESPACE_ID,
        });
      } catch (error) {
        thrown = error;
      }
      expect(isForegroundProductChangedError(thrown)).toBe(true);
      expect(transaction.queries.some(query =>
        query.includes('insert into "memory_crypto_revisions"'))).toBe(false);
    }
  });

  test("destroys an unreturned commitment when lifecycle allocation fails", async () => {
    const failure = new Error("allocation failed");
    const transaction = new ScriptedTransaction([
      [ordinaryRow()],
      [],
      scopeRows,
      [],
      failure,
    ]);

    let thrown: unknown;
    try {
      await reservePostgresTaskScopeMemoryRepairSource({
        transaction,
        crypto: crypto(),
        selection: Object.freeze({
          representation: "structural" as const,
          id: MEMORY_ID,
          type: null,
          importance: 0.8,
          tier: 1,
          createdAt: CREATED_AT,
        }),
        expectedContentRevision: 0,
        scopeId: SCOPE_ID,
        expectedScopeOriginNamespaceId: ORIGIN_NAMESPACE_ID,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    const insertIndex = transaction.queries.findIndex(query =>
      query.includes('insert into "memory_crypto_revisions"'));
    const byteParameters = transaction.parameters[insertIndex]!.filter(
      (value): value is Uint8Array => value instanceof Uint8Array,
    );
    expect(byteParameters.some(bytes => bytes.every(byte => byte === 0)))
      .toBe(true);
  });

  test("updates lifecycle before Memory and advances only its revision metadata", async () => {
    const { source } = await reserve();
    const objectId = deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_ID,
      contentRevision: source.source.targetContentRevision,
    });
    const results = attachResults(source);
    const transaction = new ScriptedTransaction([
      ...results,
      [{ sequence: 1 }],
      [{ id: MEMORY_ID }],
      [],
      scopeRows,
    ]);

    expect(await attachPostgresTaskScopeMemoryRepair({
      transaction,
      source,
      objectId,
      requestCommitment: source.source.requestCommitment,
    })).toBe("attached");

    expect(transaction.queries[0]).toContain('from "memory_crypto_revisions"');
    expect(transaction.queries[1]).toContain('from "memories"');
    expect(transaction.queries[2]).toContain('from "memory_namespaces"');
    expect(transaction.queries[3]).toContain('from "memory_scopes"');
    expect(transaction.queries[0]!.toLowerCase()).toContain("for update");
    expect(transaction.queries[1]!.toLowerCase()).toContain("for update");
    // Memory UPDATE fences Namespace FK inserts; leaving this empty-set read
    // unlocked avoids inverting the Namespace DELETE trigger's child→Memory
    // order. Only the authority-bearing current Scope edge is row-locked.
    expect(transaction.queries[2]!.toLowerCase()).not.toContain("for update");
    expect(transaction.queries[3]!.toLowerCase()).toContain("for update");
    expect(transaction.queries[3]).toContain('"scope_id" =');
    expect(transaction.parameters[3]).toContain(SCOPE_ID);
    const lifecycleUpdate = transaction.queries.findIndex(query =>
      query.startsWith('update "memory_crypto_revisions"'));
    const memoryUpdate = transaction.queries.findIndex(query =>
      query.startsWith('update "memories"'));
    expect(lifecycleUpdate).toBeGreaterThan(-1);
    expect(memoryUpdate).toBeGreaterThan(lifecycleUpdate);
    expect(transaction.queries[memoryUpdate]).toContain('"embedding_revision"');
    expect(transaction.queries[memoryUpdate]).toContain(
      '"scope_origin_namespace_id"',
    );
    expect(transaction.queries[memoryUpdate]!.split(" where ")[0]).not.toContain(
      '"content"',
    );
  });

  test("throws after lifecycle mutation when the Memory CAS loses", async () => {
    const { source } = await reserve();
    const objectId = deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_ID,
      contentRevision: source.source.targetContentRevision,
    });
    const results = attachResults(source);
    const transaction = new ScriptedTransaction([
      ...results,
      [{ sequence: 1 }],
      [],
    ]);

    let thrown: unknown;
    try {
      await attachPostgresTaskScopeMemoryRepair({
        transaction,
        source,
        objectId,
        requestCommitment: source.source.requestCommitment,
      });
    } catch (error) {
      thrown = error;
    }
    expect(isForegroundProductChangedError(thrown)).toBe(true);
    expect(transaction.queries.some(query =>
      query.startsWith('update "memory_crypto_revisions"'))).toBe(true);
  });

  test("throws after both mutations when the final audience recheck changes", async () => {
    const { source } = await reserve();
    const objectId = deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_ID,
      contentRevision: source.source.targetContentRevision,
    });
    const transaction = new ScriptedTransaction([
      ...attachResults(source),
      [{ sequence: 1 }],
      [{ id: MEMORY_ID }],
      [{ namespace_id: FOREIGN_NAMESPACE_ID }],
      scopeRows,
    ]);

    let thrown: unknown;
    try {
      await attachPostgresTaskScopeMemoryRepair({
        transaction,
        source,
        objectId,
        requestCommitment: source.source.requestCommitment,
      });
    } catch (error) {
      thrown = error;
    }
    expect(isForegroundProductChangedError(thrown)).toBe(true);
    expect(transaction.queries.filter(query => query.startsWith("update ")))
      .toHaveLength(2);
  });

  test("replays only the mapped target with its advanced embedding revision", async () => {
    const { source } = await reserve();
    const objectId = deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_ID,
      contentRevision: source.source.targetContentRevision,
    });
    const fingerprint = fingerprintRequiredMemoryNamespaces([
      ORIGIN_NAMESPACE_ID,
    ]);
    const transaction = new ScriptedTransaction([
      [{
        crypto_object_id: objectId,
        allocation_request_digest: source.source.requestCommitment,
        required_namespace_fingerprint: fingerprint,
        completion: "complete",
        disposition: "mapped",
      }],
      [{
        ...ordinaryRow(source.source.targetContentRevision),
        content_revision: source.source.targetContentRevision,
        crypto_object_id: objectId,
        crypto_mapping_state: "verified",
        crypto_required_namespace_fingerprint: fingerprint,
      }],
      [],
      [scopeRows[0]!],
    ]);

    expect(await attachPostgresTaskScopeMemoryRepair({
      transaction,
      source,
      objectId,
      requestCommitment: source.source.requestCommitment,
    })).toBe("replayed");
    expect(transaction.queries.some(query => query.startsWith("update ")))
      .toBe(false);
    expect(transaction.queries[0]!.toLowerCase()).toContain("for update");
    expect(transaction.queries[1]!.toLowerCase()).toContain("for update");
    expect(transaction.queries[2]!.toLowerCase()).not.toContain("for update");
    expect(transaction.queries[3]!.toLowerCase()).toContain("for update");
  });

  test("rejects a stale locked lifecycle without mutating it", async () => {
    const { source } = await reserve();
    const objectId = deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_ID,
      contentRevision: source.source.targetContentRevision,
    });
    const results = attachResults(source);
    results[0] = [{
      ...(results[0]![0] as Record<string, unknown>),
      disposition: "quarantined",
    }];
    const transaction = new ScriptedTransaction(results);

    let thrown: unknown;
    try {
      await attachPostgresTaskScopeMemoryRepair({
        transaction,
        source,
        objectId,
        requestCommitment: source.source.requestCommitment,
      });
    } catch (error) {
      thrown = error;
    }

    expect(isForegroundProductChangedError(thrown)).toBe(true);
    expect(transaction.queries[0]!.toLowerCase()).toContain("for update");
    expect(transaction.queries.some(query => query.startsWith("update ")))
      .toBe(false);
  });
});
