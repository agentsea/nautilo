import type { Sql, TransactionSql } from "postgres";
import type { DirectDatabase } from "./direct-database";

/**
 * Narrow adapter for repositories that need postgres-js tagged SQL and
 * transaction primitives from an already-owned Drizzle pool. It never opens
 * a connection and exposes no URL or credential.
 */
export function asPostgresJsExecutor<TExecutor>(
  db: Readonly<{ $client: TExecutor }>,
): TExecutor {
  return db.$client;
}

export type PostgresJsBridgeScalar =
  | string
  | number
  | bigint
  | boolean
  | Uint8Array
  | Date
  | readonly string[]
  | readonly number[]
  | null;

export type PostgresJsBridgeRow = Readonly<
  Record<string, PostgresJsBridgeScalar>
>;

export type PostgresJsBridgeIsolationLevel =
  | "serializable"
  | "read committed";

export interface PostgresJsBridgeExecutor {
  query<Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>(
    statement: string,
    parameters?: readonly PostgresJsBridgeScalar[],
  ): Promise<readonly Row[]>;
}

export interface PostgresJsBridgeConnection extends PostgresJsBridgeExecutor {
  /**
   * Open exactly one postgres-js transaction. Retry policy remains with the
   * verified bridge handle, which knows whether replay is safe.
   */
  transaction<Result>(
    callback: (transaction: PostgresJsBridgeExecutor) => Promise<Result>,
    options?: Readonly<{
      isolationLevel: PostgresJsBridgeIsolationLevel;
    }>,
  ): Promise<Result>;

  /**
   * Deliberately identical one-attempt primitive for restricted callbacks that
   * must never be replayed after a serialization failure.
   */
  transactionOnce<Result>(
    callback: (transaction: PostgresJsBridgeExecutor) => Promise<Result>,
    options?: Readonly<{
      isolationLevel: PostgresJsBridgeIsolationLevel;
    }>,
  ): Promise<Result>;
}

export type PostgresJsCanonicalTransaction = Parameters<
  Parameters<DirectDatabase["transaction"]>[0]
>[0];

export interface PostgresJsCanonicalBridgeConnection {
  transaction<Result>(
    callback: (
      transaction: PostgresJsCanonicalTransaction,
      executor: PostgresJsBridgeExecutor,
    ) => Promise<Result>,
    options?: Readonly<{
      isolationLevel: PostgresJsBridgeIsolationLevel;
    }>,
  ): Promise<Result>;
}

type PostgresJsTransactionClient = TransactionSql<Record<string, never>>;
type PostgresJsPoolClient = Sql<Record<string, never>>;
type PostgresJsQueryClient = Pick<PostgresJsPoolClient, "unsafe">;

function detachRows<Row extends PostgresJsBridgeRow>(
  rows: readonly PostgresJsBridgeRow[],
): readonly Row[] {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([name, value]) => [
      name,
      value instanceof Uint8Array ? new Uint8Array(value) : value,
    ]),
  ) as Row);
}

function assertPostgresJsPoolClient(value: unknown): asserts value is
  PostgresJsPoolClient {
  if (
    typeof value !== "function"
    || typeof Reflect.get(value, "unsafe") !== "function"
    || typeof Reflect.get(value, "begin") !== "function"
  ) {
    throw new TypeError(
      "Drizzle pool must expose its owned postgres-js client",
    );
  }
}

function transactionClient(
  transaction: PostgresJsCanonicalTransaction,
): PostgresJsTransactionClient {
  const session: unknown = typeof transaction === "object" && transaction !== null
    ? Reflect.get(transaction, "session")
    : undefined;
  const client: unknown = typeof session === "object" && session !== null
    ? Reflect.get(session, "client")
    : undefined;
  if (
    typeof client !== "function"
    || typeof Reflect.get(client, "unsafe") !== "function"
    || typeof Reflect.get(client, "savepoint") !== "function"
  ) {
    throw new TypeError(
      "Drizzle transaction must expose its active postgres-js TransactionSql client",
    );
  }
  return client as PostgresJsTransactionClient;
}

function bridgeExecutor(
  client: PostgresJsQueryClient,
): PostgresJsBridgeExecutor {
  return Object.freeze({
    query: async <Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>(
      statement: string,
      parameters: readonly PostgresJsBridgeScalar[] = [],
    ): Promise<readonly Row[]> => {
      // postgres-js' `unsafe` path serializes bound values as strings/bytes.
      // Passing a Date through directly reaches Buffer.byteLength(Date) and
      // throws before PostgreSQL sees the statement. Keep the public adapter
      // convenient for repositories, but make the wire value explicit and
      // canonical at this one boundary.
      const normalized = parameters.map((value) =>
        value instanceof Date ? value.toISOString() : value
      );
      const rows = await client.unsafe(
        statement,
        normalized as Parameters<PostgresJsQueryClient["unsafe"]>[1],
      );
      return detachRows<Row>(rows);
    },
  });
}

function beginOptions(
  options: Readonly<{
    isolationLevel: PostgresJsBridgeIsolationLevel;
  }> | undefined,
): string | null {
  if (!options) return null;
  return `isolation level ${options.isolationLevel}`;
}

/**
 * Adapt the postgres-js client already owned by a Drizzle pool to the narrow
 * structural connection used by product and restricted bridge repositories.
 * This function neither opens a pool nor reads, returns, or logs credentials.
 */
export function createPostgresJsBridgeConnection(
  db: Readonly<{ $client: unknown }>,
): PostgresJsBridgeConnection {
  const client = db.$client;
  assertPostgresJsPoolClient(client);

  const transact = <Result>(
    callback: (transaction: PostgresJsBridgeExecutor) => Promise<Result>,
    options?: Readonly<{
      isolationLevel: PostgresJsBridgeIsolationLevel;
    }>,
  ): Promise<Result> => {
    const run = (transaction: PostgresJsTransactionClient) =>
      callback(bridgeExecutor(transaction));
    const normalized = beginOptions(options);
    return normalized === null
      ? client.begin(run) as Promise<Result>
      : client.begin(normalized, run) as Promise<Result>;
  };

  return Object.freeze({
    ...bridgeExecutor(client),
    transaction: transact,
    transactionOnce: transact,
  });
}

/**
 * Opens one real schema-aware Drizzle transaction and exposes the narrow raw
 * bridge on that exact transaction's postgres-js TransactionSql client. It
 * neither acquires another connection nor creates a nested transaction.
 */
export function createPostgresJsCanonicalBridgeConnection(
  db: Pick<DirectDatabase, "$client" | "transaction">,
): PostgresJsCanonicalBridgeConnection {
  assertPostgresJsPoolClient(db.$client);
  return Object.freeze({
    transaction: <Result>(
      callback: (
        transaction: PostgresJsCanonicalTransaction,
        executor: PostgresJsBridgeExecutor,
      ) => Promise<Result>,
      options?: Readonly<{
        isolationLevel: PostgresJsBridgeIsolationLevel;
      }>,
    ): Promise<Result> => {
      return db.transaction(async (transaction) => callback(
        transaction,
        bridgeExecutor(transactionClient(transaction)),
      ), options);
    },
  });
}
