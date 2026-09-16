import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { fingerprintRequiredMemoryNamespaces } from
  "../../src/memory/memory-repository";

import {
  loadPostgresForegroundMemoryRepairSources,
  verifyConversationProductPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresIsolationLevel,
  type ConversationProductPostgresScalar,
} from "@nautilo/lattice-bridge/server";

const MEMORY_ID = "10000000-0000-4000-8000-000000000031";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000032";

class ScriptedConnection implements ConversationProductPostgresConnection {
  readonly queries: string[] = [];
  readonly isolationLevels: ConversationProductPostgresIsolationLevel[] = [];
  readonly #results: Array<readonly unknown[]>;

  constructor(results: readonly (readonly unknown[])[]) {
    this.#results = [...results];
  }

  query<Row extends ConversationProductDatabaseRow>(
    statement: string,
    _parameters: readonly ConversationProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    this.queries.push(statement);
    const result = this.#results.shift();
    if (result === undefined) return Promise.reject(new Error("Unexpected query"));
    return Promise.resolve(result as readonly Row[]);
  }

  async transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
    options: Readonly<{
      isolationLevel: ConversationProductPostgresIsolationLevel;
    }>,
  ): Promise<Result> {
    this.isolationLevels.push(options.isolationLevel);
    return callback(this);
  }
}

describe("Postgres foreground Memory repair source", () => {
  test("protected-only selection excludes authored type and content", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      [{
        id: MEMORY_ID,
        importance: 0.8,
        tier: 1,
        created_at: new Date("2027-01-15T08:00:00.000Z"),
        content_revision: 3,
        crypto_object_id: "memory-content-v1:protected-only",
        crypto_mapping_state: "verified",
        crypto_access_revision: 0,
        crypto_required_namespace_fingerprint:
          fingerprintRequiredMemoryNamespaces([NAMESPACE_ID]),
        scope_origin_namespace_id: null,
      }],
      [{ namespace_id: NAMESPACE_ID }],
      [],
      [{
        allocation_request_digest: new Uint8Array(32).fill(4),
        completion: "complete",
        disposition: "mapped",
      }],
    ]);
    const product = await verifyConversationProductPostgresHandle(connection);

    const [source] = await loadPostgresForegroundMemoryRepairSources({
      product,
      crypto: new LatticeCrypto({ bytes: (length) => new Uint8Array(length) }),
      memories: [Object.freeze({
        representation: "structural" as const,
        id: MEMORY_ID,
        type: null,
        importance: 0.8,
        tier: 1,
        createdAt: new Date("2027-01-15T08:00:00.000Z"),
      })],
      representationMode: "protected-only",
    });

    expect(source?.memory).toMatchObject({ type: null, content: null });
    expect(source?.plaintextBytes).toBeNull();
    expect(source?.completedRepairReceipt).toBe(true);
    const selection = connection.queries[1]!.split(" from ")[0]!;
    expect(selection).not.toContain('"type"');
    expect(selection).not.toContain('"content"');
    expect(connection.isolationLevels).toEqual(["serializable"]);
  });
});
