import { describe, expect, test } from "bun:test";
import {
  backgroundCryptoAuthorizationRequests, eq, type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  assertVerifiedCryptoPostgresHandle, cryptoTypedDb, executeTypedCryptoQuery,
  type CryptoPostgresConnection, type CryptoPostgresExecutor,
  type CryptoPostgresHandle,
} from "../../src/server/storage/postgres-lattice-storage.ts";
import type { DatabaseRow, DatabaseScalar } from "../../src/server/storage/postgres-record-codecs.ts";
import {
  assertUnstagedTaskTerminalMessageAuthority,
  withUnstagedTaskTerminalMessagePublication,
  type UnstagedTaskTerminalMessageAuthority,
} from "../../src/server/task/unstaged-task-terminal-message-authority.ts";

const requestId = "task-run-delivery-message-authorization:11111111-1111-4111-8111-111111111111";
const objectId = `message:v2:${"a".repeat(64)}`;
const coordinates = { requestId, objectId };

class Connection implements CryptoPostgresConnection {
  role = "nautilo_crypto";
  sessionRole = "nautilo_crypto";
  requestExists = true;
  objectExists = false;
  receiptExists = false;
  policyRevision = 7;
  failCommit = false;
  calls: string[] = [];
  active = false;

  query<Row extends DatabaseRow = DatabaseRow>(statement: string): Promise<readonly Row[]> {
    if (!statement.includes("current_user::text")) throw new Error("Unscoped query");
    return Promise.resolve([{
      current_user: this.role, session_user: this.sessionRole,
    }] as unknown as Row[]);
  }

  async transaction<Value>(use: (executor: CryptoPostgresExecutor) => Promise<Value>): Promise<Value> {
    let policyRevision = this.policyRevision;
    this.active = true;
    const executor: CryptoPostgresExecutor = {
      query: <Row extends DatabaseRow = DatabaseRow>(statement: string,
        parameters: readonly DatabaseScalar[] = []): Promise<readonly Row[]> => {
        if (!this.active) throw new Error("Transaction ended");
        const sql = statement.replaceAll('"', "").toLowerCase();
        const rows = (value: DatabaseRow[]): Promise<readonly Row[]> =>
          Promise.resolve(value as Row[]);
        if (sql.includes("from background_crypto_authorization_requests")) {
          expect(sql).toContain("for update");
          expect(parameters).toEqual([requestId]);
          this.calls.push("request_lock");
          return rows(this.requestExists ? [{ request_id: requestId }] : []);
        }
        if (sql.includes("pg_advisory_xact_lock")) {
          expect(sql).toContain("hashtextextended($1::text, 0)");
          expect(parameters).toEqual([objectId]);
          this.calls.push("object_lock");
          return rows([]);
        }
        if (sql.includes("from task_terminal_message_crypto_staging_receipts")) {
          expect(parameters).toContain(requestId);
          expect(parameters).toContain(objectId);
          this.calls.push("receipt_read");
          return rows(this.receiptExists ? [{ request_id: requestId }] : []);
        }
        if (sql.includes("from crypto_objects")) {
          expect(sql).not.toContain("payload");
          expect(parameters).toContain(objectId);
          this.calls.push("object_read");
          return rows(this.objectExists ? [{ object_id: objectId }] : []);
        }
        if (sql.startsWith("update background_crypto_authorization_requests")) {
          expect(parameters).toEqual([8, requestId]);
          this.calls.push("callback_mutation");
          policyRevision = 8;
          return rows([]);
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    try {
      const result = await use(executor);
      if (this.failCommit) throw new Error("Commit rejected");
      this.policyRevision = policyRevision;
      return result;
    } finally { this.active = false; }
  }
}

async function mutate(handle: CryptoPostgresHandle): Promise<void> {
  await executeTypedCryptoQuery(handle, cryptoTypedDb
    .update(backgroundCryptoAuthorizationRequests).set({ expectedPolicyRevision: 8 })
    .where(eq(backgroundCryptoAuthorizationRequests.requestId, requestId)));
}

const run = <Value>(connection: Connection,
  use: (handle: CryptoPostgresHandle, authority: UnstagedTaskTerminalMessageAuthority) => Promise<Value>) =>
  withUnstagedTaskTerminalMessagePublication({
    ...coordinates,
    restricted: connection as unknown as PostgresJsBridgeConnection,
    use,
  });

async function rejection(operation: () => Promise<unknown>): Promise<unknown> {
  try { await operation(); } catch (error: unknown) { return error; }
  throw new Error("Expected rejection");
}

describe("unstaged terminal Message authority", () => {
  test.each([true, false])("lends scoped absence authority with request present=%s", async requestExists => {
    const connection = new Connection();
    connection.requestExists = requestExists;
    let escapedHandle: CryptoPostgresHandle | undefined;
    let escapedAuthority: UnstagedTaskTerminalMessageAuthority | undefined;
    const result = await run(connection, async (handle, authority) => {
      escapedHandle = handle;
      escapedAuthority = authority;
      expect(connection.active).toBe(true);
      assertVerifiedCryptoPostgresHandle(handle);
      assertUnstagedTaskTerminalMessageAuthority(authority, coordinates);
      expect(() => assertUnstagedTaskTerminalMessageAuthority(authority,
        { ...coordinates, objectId: `message:v2:${"b".repeat(64)}` })).toThrow();
      expect(() => assertUnstagedTaskTerminalMessageAuthority(authority,
        { ...coordinates, requestId: `${requestId}x` })).toThrow();
      await mutate(handle);
      return "ready";
    });
    expect(result).toEqual({ status: "unstaged", value: "ready" });
    expect(connection.calls).toEqual([
      "request_lock", "object_lock", "receipt_read", "object_read",
      "callback_mutation", "receipt_read", "object_read",
    ]);
    expect(connection.policyRevision).toBe(8);
    expect(() => assertVerifiedCryptoPostgresHandle(escapedHandle!)).toThrow();
    expect(() => assertUnstagedTaskTerminalMessageAuthority(escapedAuthority!, coordinates)).toThrow();
    expect(() => assertUnstagedTaskTerminalMessageAuthority(
      {} as UnstagedTaskTerminalMessageAuthority, coordinates)).toThrow();
  });

  test.each(["object", "receipt"] as const)("existing %s refuses callback", async kind => {
    const connection = new Connection();
    connection.objectExists = kind === "object";
    connection.receiptExists = kind === "receipt";
    const result = await run(connection, () => { throw new Error("Must not invoke callback"); });
    expect(result).toEqual({ status: "publication_exists" });
    expect(connection.calls.slice(0, 2)).toEqual(["request_lock", "object_lock"]);
    expect(connection.policyRevision).toBe(7);
  });

  test.each(["callback", "commit", "object", "receipt"] as const)("%s failure rolls back and revokes proof", async failure => {
    const connection = new Connection();
    connection.failCommit = failure === "commit";
    let proof: UnstagedTaskTerminalMessageAuthority | undefined;
    const error = await rejection(() => run(connection, async (handle, authority) => {
      proof = authority;
      await mutate(handle);
      if (failure === "callback") throw new Error("Callback failed");
      connection.objectExists = failure === "object";
      connection.receiptExists = failure === "receipt";
    }));
    expect(error).toBeInstanceOf(Error);
    expect(connection.policyRevision).toBe(7);
    expect(() => assertUnstagedTaskTerminalMessageAuthority(proof!, coordinates)).toThrow();
  });

  test.each(["nautilo", "nautilo_agent"])("rejects %s credentials and role switching", async role => {
    const connection = new Connection();
    connection.sessionRole = role;
    expect(await rejection(() => run(connection, async () => "wrong"))).toBeInstanceOf(TypeError);
    connection.role = role;
    expect(await rejection(() => run(connection, async () => "wrong"))).toBeInstanceOf(TypeError);
    expect(connection.calls).toEqual([]);
  });

  test.each([
    { requestId: "task-run-cancellation-result-authorization:11111111-1111-4111-8111-111111111111" },
    { requestId: "task-run-delivery-message-authorization:not-a-run" },
    { objectId: "message:v2:not-a-digest" },
    { objectId: `task:v2:${"a".repeat(64)}` },
  ])("rejects malformed coordinates %j", async substituted => {
    const connection = new Connection();
    expect(await rejection(() => withUnstagedTaskTerminalMessagePublication({
      ...coordinates, ...substituted,
      restricted: connection as unknown as PostgresJsBridgeConnection,
      use: async () => "wrong",
    }))).toBeInstanceOf(TypeError);
    expect(connection.calls).toEqual([]);
  });
});
