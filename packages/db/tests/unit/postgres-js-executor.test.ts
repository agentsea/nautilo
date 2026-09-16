import { describe, expect, test } from "bun:test";
import {
  createPostgresJsBridgeConnection,
  createPostgresJsCanonicalBridgeConnection,
  type PostgresJsBridgeScalar,
} from "../../src/config/postgres-js-executor";

type UnsafeCall = Readonly<{
  statement: string;
  parameters: readonly unknown[];
}>;

function mockClient() {
  const calls: UnsafeCall[] = [];
  const transaction = Object.assign(() => undefined, {
    unsafe: (statement: string, parameters: readonly unknown[] = []) => {
      calls.push({ statement, parameters });
      return Promise.resolve([]);
    },
  });
  const client = Object.assign(() => undefined, {
    unsafe: transaction.unsafe,
    begin: (
      optionsOrCallback: string | ((tx: typeof transaction) => Promise<unknown>),
      maybeCallback?: (tx: typeof transaction) => Promise<unknown>,
    ) => (typeof optionsOrCallback === "function"
      ? optionsOrCallback(transaction)
      : maybeCallback!(transaction)),
  });
  return { calls, client, transaction };
}

describe("postgres-js bridge executor", () => {
  test("normalizes Date parameters at the postgres-js wire boundary", async () => {
    const fixture = mockClient();
    const connection = createPostgresJsBridgeConnection({
      $client: fixture.client,
    });
    const instant = new Date("2027-01-15T08:00:00.123Z");
    await connection.query("select $1::timestamptz", [instant]);
    expect(fixture.calls).toEqual([{
      statement: "select $1::timestamptz",
      parameters: [instant.toISOString()],
    }]);
  });

  test("runs bridge queries on the transaction client supplied by postgres-js", async () => {
    const fixture = mockClient();
    const connection = createPostgresJsBridgeConnection({
      $client: fixture.client,
    });
    await connection.transaction(
      (executor) => executor.query("select $1::text", ["same-client"]),
      { isolationLevel: "serializable" },
    );
    expect(fixture.calls).toEqual([{
      statement: "select $1::text",
      parameters: ["same-client" satisfies PostgresJsBridgeScalar],
    }]);
  });

  test("canonical bridge uses the exact Drizzle transaction client, not the pool", async () => {
    const fixture = mockClient();
    const calls: UnsafeCall[] = [];
    const client = Object.assign(() => undefined, {
      unsafe: async (statement: string, parameters: readonly unknown[]) => {
        calls.push({ statement, parameters });
        return [];
      },
      savepoint: () => { throw new Error("Unexpected nested transaction"); },
    });
    const tx = { session: { client } };
    let observedOptions: unknown;
    const db = {
      $client: fixture.client,
      transaction: async (callback: (value: typeof tx) => Promise<unknown>, options: unknown) => {
        observedOptions = options;
        return callback(tx);
      },
    } as unknown as Parameters<typeof createPostgresJsCanonicalBridgeConnection>[0];
    const bridge = createPostgresJsCanonicalBridgeConnection(db);
    const result = await bridge.transaction(async (transaction, executor) => {
      expect<unknown>(transaction).toBe(tx);
      await executor.query("select $1::text", ["same-canonical-client"]);
      return "committed";
    }, { isolationLevel: "serializable" });
    expect(result).toBe("committed");
    expect(observedOptions).toEqual({ isolationLevel: "serializable" });
    expect(fixture.calls).toEqual([]);
    expect(calls).toEqual([{
      statement: "select $1::text", parameters: ["same-canonical-client"],
    }]);
  });

  test("canonical bridge rejects a pool masquerading as a transaction client", async () => {
    const fixture = mockClient();
    const db = {
      $client: fixture.client,
      transaction: async (callback: (value: unknown) => Promise<unknown>) =>
        callback({ session: { client: fixture.client } }),
    } as unknown as Parameters<typeof createPostgresJsCanonicalBridgeConnection>[0];
    const bridge = createPostgresJsCanonicalBridgeConnection(db);
    let entered = false;
    let rejection: unknown;
    try {
      await bridge.transaction(async () => { entered = true; });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(TypeError);
    expect((rejection as TypeError).message).toContain("active postgres-js TransactionSql client");
    expect(entered).toBe(false);
    expect(fixture.calls).toEqual([]);
  });
});
