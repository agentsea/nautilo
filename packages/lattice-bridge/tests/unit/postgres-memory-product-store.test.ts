import { describe, expect, test } from "bun:test";
import {
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
} from "../../src/memory/memory-repository.ts";
import { PostgresMemoryProductStore } from "../../src/server/memory/postgres-memory-product-store.ts";
import {
  verifyConversationProductPostgresHandle,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresHandle,
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

const MEMORY_ID = "10000000-0000-4000-8000-000000000001";
const MEMORY_ID_2 = "10000000-0000-4000-8000-000000000002";
const NAMESPACE_A = "20000000-0000-4000-8000-000000000001";
const NAMESPACE_B = "20000000-0000-4000-8000-000000000002";
const NAMESPACE_C = "20000000-0000-4000-8000-000000000003";
const LEASE_ID = "30000000-0000-4000-8000-000000000001";
const NOW = new Date("2027-01-15T08:00:00.000Z");
const LATER = new Date("2027-01-15T08:01:00.000Z");

function digest(fill = 0x31): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function objectId(memoryId = MEMORY_ID, contentRevision = 1): string {
  return deriveMemoryCryptoObjectIdV1({ memoryId, contentRevision });
}

function lifecycleRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sequence: 1,
    memory_id: MEMORY_ID,
    content_revision: 1,
    anchor_namespace_id: NAMESPACE_A,
    crypto_object_id: objectId(),
    payload_version: 1,
    allocation_request_digest: digest(),
    required_namespace_fingerprint:
      fingerprintRequiredMemoryNamespaces([NAMESPACE_A, NAMESPACE_B]),
    completion: "pending",
    disposition: "active",
    attempt_count: 0,
    next_attempt_at: NOW,
    lease_token: null,
    lease_expires_at: null,
    failure_code: null,
    crypto_completed_at: null,
    lease_is_live: true,
    ...overrides,
  };
}

function productRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    memory_id: MEMORY_ID,
    content_revision: 1,
    crypto_object_id: null,
    crypto_access_revision: 0,
    crypto_required_namespace_fingerprint: null,
    scope_origin_namespace_id: null,
    ...overrides,
  };
}

async function harness(
  results: unknown[][],
  role: "nautilo" | "nautilo_agent" = "nautilo",
): Promise<Readonly<{
  connection: ScriptedConnection;
  handle: ConversationProductPostgresHandle;
  store: PostgresMemoryProductStore;
}>> {
  const connection = new ScriptedConnection([
    [{ current_user: role, session_user: role }],
    ...results,
  ]);
  const handle = await verifyConversationProductPostgresHandle(connection);
  return Object.freeze({
    connection,
    handle,
    store: new PostgresMemoryProductStore(handle),
  });
}

describe("Postgres Memory product store", () => {
  test("requires a verified direct product-role handle", async () => {
    const forged = Object.freeze({ role: "nautilo" }) as unknown as
      ConversationProductPostgresHandle;
    expect(() => new PostgresMemoryProductStore(forged)).toThrow(
      "verified ordinary product Postgres handle",
    );

    const connection = new ScriptedConnection([[{
      current_user: "nautilo_agent",
      session_user: "nautilo_agent",
    }]]);
    const agentHandle = await verifyConversationProductPostgresHandle(
      connection,
    );
    expect(() => new PostgresMemoryProductStore(agentHandle)).toThrow(
      "direct nautilo product-role handle",
    );
  });

  test("loads the exact Namespace union and adds one retained scope origin", async () => {
    const required = [NAMESPACE_A, NAMESPACE_B, NAMESPACE_C];
    const { connection, store } = await harness([
      [lifecycleRow({
        required_namespace_fingerprint:
          fingerprintRequiredMemoryNamespaces(required),
      })],
      [productRow({ scope_origin_namespace_id: NAMESPACE_C })],
      [{ namespace_id: NAMESPACE_A }, { namespace_id: NAMESPACE_B }],
      [{ origin: "scope" }, { origin: "scope" }, { origin: "seed" }],
    ]);

    const state = await store.getRevision({
      memoryId: MEMORY_ID,
      contentRevision: 1,
    });

    expect(state?.requiredNamespaceIds).toEqual(required);
    expect(state?.product).toEqual({
      memoryId: MEMORY_ID,
      contentRevision: 1,
      cryptoObjectId: null,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: null,
    });
    expect(connection.isolationLevels).toEqual(["serializable"]);
    expect(connection.queries.map((query) => query.statement).join("\n"))
      .not.toMatch(/crypto_objects|wrapped_keys|object_access/i);
    connection.assertExhausted();
  });

  test("rejects a stale singular scope origin when no retained edge is scope-authored", async () => {
    const { store } = await harness([
      [lifecycleRow()],
      [productRow({ scope_origin_namespace_id: NAMESPACE_C })],
      [{ namespace_id: NAMESPACE_A }],
      [{ origin: "seed" }],
    ]);

    expect(store.getRevision({
      memoryId: MEMORY_ID,
      contentRevision: 1,
    })).rejects.toThrow("stale scope-origin Namespace");
  });

  test("marks exact completion once and classifies the replay", async () => {
    const applied = await harness([
      [lifecycleRow()],
      [{ sequence: 1 }],
    ]);
    expect(await applied.store.markCryptoComplete({
      memoryId: MEMORY_ID,
      contentRevision: 1,
      cryptoObjectId: objectId(),
      leaseToken: null,
    })).toBe("applied");
    expect(applied.connection.queries.at(-1)?.parameters).toEqual([
      "complete",
      MEMORY_ID,
      1,
      objectId(),
      null,
    ]);
    applied.connection.assertExhausted();

    const duplicate = await harness([
      [lifecycleRow({ completion: "complete", crypto_completed_at: NOW })],
    ]);
    expect(await duplicate.store.markCryptoComplete({
      memoryId: MEMORY_ID,
      contentRevision: 1,
      cryptoObjectId: objectId(),
      leaseToken: null,
    })).toBe("duplicate");
    duplicate.connection.assertExhausted();
  });

  test("publishes with an exact authority fingerprint and atomically closes the lease", async () => {
    const expected = fingerprintRequiredMemoryNamespaces([
      NAMESPACE_A,
      NAMESPACE_B,
    ]);
    const { connection, store } = await harness([
      [lifecycleRow({
        completion: "complete",
        crypto_completed_at: NOW,
        lease_token: LEASE_ID,
        lease_expires_at: LATER,
      })],
      [productRow()],
      [{ namespace_id: NAMESPACE_B }, { namespace_id: NAMESPACE_A }],
      [{ origin: "seed" }],
      [{ memory_id: MEMORY_ID }],
      [{ sequence: 1 }],
    ]);

    expect(await store.compareAndSwapCryptoMapping({
      memoryId: MEMORY_ID,
      contentRevision: 1,
      cryptoObjectId: objectId(),
      expectedRequiredNamespaceFingerprint: expected,
      leaseToken: LEASE_ID,
    })).toBe("applied");
    expect(connection.isolationLevels).toEqual(["serializable"]);
    expect(connection.queries.at(-2)?.statement).toContain(
      '"crypto_required_namespace_fingerprint" = $',
    );
    expect(connection.queries.at(-2)?.statement).toContain(
      '"crypto_mapping_state" = $',
    );
    expect(connection.queries.at(-2)?.parameters).toContain("verified");
    expect(connection.queries.at(-2)?.statement).not.toContain("content =");
    expect(connection.queries.at(-2)?.statement).not.toContain("type =");
    expect(connection.queries.at(-1)?.statement).toContain(
      '"lease_token" = $',
    );
    expect(connection.queries.at(-1)?.parameters).toContain(null);
    connection.assertExhausted();
  });

  test("fails closed and receipts stale mapping when current authority changed", async () => {
    const allocated = fingerprintRequiredMemoryNamespaces([NAMESPACE_A]);
    const { connection, store } = await harness([
      [lifecycleRow({
        completion: "complete",
        crypto_completed_at: NOW,
        required_namespace_fingerprint: allocated,
      })],
      [productRow()],
      [{ namespace_id: NAMESPACE_A }, { namespace_id: NAMESPACE_B }],
      [],
      [{ sequence: 1 }],
    ]);

    expect(await store.compareAndSwapCryptoMapping({
      memoryId: MEMORY_ID,
      contentRevision: 1,
      cryptoObjectId: objectId(),
      expectedRequiredNamespaceFingerprint: allocated,
      leaseToken: null,
    })).toBe("wrong_authority");
    expect(connection.queries.at(-1)?.statement).toContain(
      'set "disposition" = $',
    );
    expect(connection.queries.at(-1)?.parameters).toContain("stale_mapping");
    connection.assertExhausted();
  });

  test("quarantines under the exact live lease and replays the same closed reason", async () => {
    const applied = await harness([
      [lifecycleRow({ lease_token: LEASE_ID, lease_expires_at: LATER })],
      [{ sequence: 1 }],
    ]);
    expect(await applied.store.quarantineRevision({
      memoryId: MEMORY_ID,
      contentRevision: 1,
      leaseToken: LEASE_ID,
      failureCode: "crypto_mismatch",
    })).toBe("applied");
    applied.connection.assertExhausted();

    const duplicate = await harness([
      [lifecycleRow({
        disposition: "quarantined",
        next_attempt_at: null,
        failure_code: "crypto_mismatch",
      })],
    ]);
    expect(await duplicate.store.quarantineRevision({
      memoryId: MEMORY_ID,
      contentRevision: 1,
      leaseToken: LEASE_ID,
      failureCode: "crypto_mismatch",
    })).toBe("duplicate");
    duplicate.connection.assertExhausted();
  });

  test("claims a bounded batch with one stable lease and returns due rows in stable order", async () => {
    const firstDue = new Date("2027-01-15T07:58:00.000Z");
    const secondDue = new Date("2027-01-15T07:59:00.000Z");
    const firstLifecycle = lifecycleRow({
      memory_id: MEMORY_ID_2,
      sequence: 3,
      crypto_object_id: objectId(MEMORY_ID_2),
      required_namespace_fingerprint:
        fingerprintRequiredMemoryNamespaces([NAMESPACE_A]),
      next_attempt_at: firstDue,
      lease_token: LEASE_ID,
      lease_expires_at: LATER,
    });
    const secondLifecycle = lifecycleRow({
      sequence: 4,
      required_namespace_fingerprint:
        fingerprintRequiredMemoryNamespaces([NAMESPACE_B]),
      next_attempt_at: secondDue,
      lease_token: LEASE_ID,
      lease_expires_at: LATER,
      anchor_namespace_id: NAMESPACE_B,
    });
    const { connection, store } = await harness([
      [
        {
          sequence: 4,
          memory_id: MEMORY_ID,
          content_revision: 1,
          next_attempt_at: secondDue,
        },
        {
          sequence: 3,
          memory_id: MEMORY_ID_2,
          content_revision: 1,
          next_attempt_at: firstDue,
        },
      ],
      [firstLifecycle],
      [productRow({ memory_id: MEMORY_ID_2 })],
      [{ namespace_id: NAMESPACE_A }],
      [],
      [secondLifecycle],
      [productRow()],
      [{ namespace_id: NAMESPACE_B }],
      [],
    ]);

    const states = await store.claimReconciliationCandidates({
      leaseToken: LEASE_ID,
      limit: 2,
    });

    expect(states.map((state) => state.lifecycle.sequence)).toEqual([3, 4]);
    expect(states.every((state) => state.lifecycle.leaseToken === LEASE_ID))
      .toBe(true);
    expect(connection.isolationLevels).toEqual(["read committed"]);
    expect(connection.queries[1]?.statement).toContain("SKIP LOCKED");
    expect(connection.queries[1]?.parameters).toEqual([LEASE_ID, 60, 2]);
    connection.assertExhausted();
  });

  test("quarantines the eighth failed live claim with retry_exhausted", async () => {
    const exhausted = lifecycleRow({
      attempt_count: 8,
      disposition: "quarantined",
      next_attempt_at: null,
      failure_code: "retry_exhausted",
    });
    const { connection, store } = await harness([[exhausted]]);

    const lifecycle = await store.failReconciliationClaim({
      memoryId: MEMORY_ID,
      contentRevision: 1,
      leaseToken: LEASE_ID,
      failureCode: "storage_transient",
    });

    expect(lifecycle?.attemptCount).toBe(8);
    expect(lifecycle?.disposition).toBe("quarantined");
    expect(lifecycle?.failureCode).toBe("retry_exhausted");
    expect(connection.queries.at(-1)?.statement).toContain(
      '"attempt_count" + 1',
    );
    expect(connection.queries.at(-1)?.parameters).toContain(8);
    expect(connection.queries.at(-1)?.statement).toContain(
      '"lease_expires_at" > CURRENT_TIMESTAMP',
    );
    connection.assertExhausted();
  });

  test("rejects oversized claims before opening a transaction", async () => {
    const { connection, store } = await harness([]);
    expect(store.claimReconciliationCandidates({
      leaseToken: LEASE_ID,
      limit: 257,
    })).rejects.toThrow("out of bounds");
    expect(connection.isolationLevels).toEqual([]);
    connection.assertExhausted();
  });
});
