import {
  and,
  compileOfflineDirectQuery,
  createOfflineDirectDb,
  eq,
  memoryCryptoOperations,
  memoryCryptoRevisions,
  type AgentDatabase,
} from "@nautilo/db";
import type { PendingQuery, Sql, TransactionSql } from "postgres";

const PORTABLE_OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MEMORY_REVISION_UPDATE = /^\s*update\s+(?:(?:"public"|public)\.)?(?:"memory_crypto_revisions"|memory_crypto_revisions)\s+set\b/iu;

type Installation = Readonly<{
  observed(): boolean;
  restore(): void;
}>;

type AllocationRow = Readonly<{
  memory_id: string;
  result_content_revision: number | string;
}>;

type CompiledParameter = string | number;
type UnsafeParameters = NonNullable<Parameters<Sql["unsafe"]>[1]>;

type TransactionWithSession = Readonly<{
  session: Readonly<{ client: TransactionSql }>;
}>;

function transactionClient(transaction: unknown): TransactionSql {
  if (typeof transaction !== "object" || transaction === null) {
    throw new TypeError("Foreground projection rollback transaction is unavailable");
  }
  const session: unknown = Reflect.get(transaction, "session");
  if (typeof session !== "object" || session === null) {
    throw new TypeError("Foreground projection rollback session is unavailable");
  }
  const client: unknown = Reflect.get(session, "client");
  if ((typeof client !== "function" && (typeof client !== "object" || client === null))
    || typeof Reflect.get(client, "unsafe") !== "function") {
    throw new TypeError("Foreground projection rollback client is unavailable");
  }
  return client as TransactionWithSession["session"]["client"];
}

function mappedMemoryRevisionUpdate(statement: string, parameters: readonly unknown[]): boolean {
  if (!MEMORY_REVISION_UPDATE.test(statement)
    || !/\b"?completion"?\s*=/iu.test(statement)
    || !/\b"?disposition"?\s*=/iu.test(statement)) return false;
  return parameters.includes("complete") && parameters.includes("mapped");
}

function compiledParameters(values: readonly unknown[]): CompiledParameter[] {
  return values.map(value => {
    if (typeof value !== "string" && typeof value !== "number") {
      throw new TypeError("Foreground projection rollback query parameter is invalid");
    }
    return value;
  });
}

async function exactPendingAllocation(
  client: Pick<Sql, "unsafe">,
  operationId: string,
): Promise<AllocationRow | null> {
  const offline = createOfflineDirectDb();
  const compiled = compileOfflineDirectQuery(offline.select({
    memory_id: memoryCryptoOperations.memoryId,
    result_content_revision: memoryCryptoOperations.resultContentRevision,
  }).from(memoryCryptoOperations).innerJoin(memoryCryptoRevisions, and(
    eq(memoryCryptoRevisions.memoryId, memoryCryptoOperations.memoryId),
    eq(
      memoryCryptoRevisions.contentRevision,
      memoryCryptoOperations.resultContentRevision,
    ),
  )).where(and(
    eq(memoryCryptoOperations.operationId, operationId),
    eq(memoryCryptoOperations.operationType, "update"),
    eq(memoryCryptoOperations.completion, "pending"),
    eq(memoryCryptoOperations.disposition, "active"),
    eq(memoryCryptoRevisions.completion, "pending"),
    eq(memoryCryptoRevisions.disposition, "active"),
  )).limit(2));
  const rows = await client.unsafe<AllocationRow[]>(
    compiled.sql,
    compiledParameters(compiled.params),
  );
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (row === undefined || typeof row.memory_id !== "string" || !UUID.test(row.memory_id)) {
    return null;
  }
  const revision = typeof row.result_content_revision === "string"
    ? Number(row.result_content_revision)
    : row.result_content_revision;
  return Number.isSafeInteger(revision) && revision > 0
    ? Object.freeze({ memory_id: row.memory_id, result_content_revision: revision })
    : null;
}

function delayedQuery<RowType extends (object | undefined)[]>(
  query: PendingQuery<RowType>,
  before: () => Promise<void>,
): PendingQuery<RowType> {
  let checked: Promise<void> | null = null;
  const check = () => checked ??= before();
  return new Proxy(query, {
    get(target, property, receiver) {
      if (property === "then") {
        return (fulfilled: unknown, rejected: unknown) =>
          check().then(() => target).then(
            fulfilled as Parameters<PendingQuery<RowType>["then"]>[0],
            rejected as Parameters<PendingQuery<RowType>["then"]>[1],
          );
      }
      if (property === "catch") {
        return (rejected: unknown) => check().then(() => target).catch(
          rejected as Parameters<Promise<typeof target>["catch"]>[0],
        );
      }
      if (property === "finally") {
        return (settled: unknown) => check().then(() => target).finally(
          settled as Parameters<Promise<typeof target>["finally"]>[0],
        );
      }
      if (property === "values") {
        return () => check().then(() => target.values());
      }
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(value, target, args);
        return result;
      };
    },
  });
}

/**
 * Installs a one-shot genuine-product fault immediately before the exact
 * foreground projection's final Memory revision mapping statement executes.
 */
export function installForegroundProjectionProductRollback(input: Readonly<{
  database: AgentDatabase;
  operationId: string;
}>): Installation {
  if (!PORTABLE_OPERATION_ID.test(input.operationId)) {
    throw new TypeError("Foreground projection rollback operation ID is invalid");
  }
  const database = input.database;
  const priorTransactionDescriptor = Object.getOwnPropertyDescriptor(database, "transaction");
  const originalTransaction = database.transaction.bind(database);
  let restored = false;
  let didObserve = false;

  const wrappedTransaction: AgentDatabase["transaction"] = (operation, config) =>
    originalTransaction(async transaction => {
      const client = transactionClient(transaction);
      const priorUnsafeDescriptor = Object.getOwnPropertyDescriptor(client, "unsafe");
      const originalUnsafe = client.unsafe.bind(client);
      const interceptedUnsafe: Sql["unsafe"] = (<RowType extends (object | undefined)[]>(
        statement: string,
        parameters: UnsafeParameters = [],
        options?: Parameters<Sql["unsafe"]>[2],
      ) => {
        const query = originalUnsafe<RowType>(statement, parameters, options);
        if (didObserve || !mappedMemoryRevisionUpdate(statement, parameters)) return query;
        return delayedQuery(query, async () => {
          if (didObserve) return;
          const allocation = await exactPendingAllocation(
            { unsafe: originalUnsafe },
            input.operationId,
          );
          if (allocation === null
            || !parameters.includes(allocation.memory_id)
            || !parameters.includes(allocation.result_content_revision)) return;
          didObserve = true;
          throw new Error("Injected foreground projection product rollback");
        });
      }) as Sql["unsafe"];
      Object.defineProperty(client, "unsafe", {
        configurable: true,
        enumerable: priorUnsafeDescriptor?.enumerable ?? true,
        writable: true,
        value: interceptedUnsafe,
      });
      try {
        return await operation(transaction);
      } finally {
        if (priorUnsafeDescriptor === undefined) delete (client as Partial<Sql>).unsafe;
        else Object.defineProperty(client, "unsafe", priorUnsafeDescriptor);
      }
    }, config);

  Object.defineProperty(database, "transaction", {
    configurable: true,
    enumerable: priorTransactionDescriptor?.enumerable ?? false,
    writable: true,
    value: wrappedTransaction,
  });

  return Object.freeze({
    observed: () => didObserve,
    restore() {
      if (restored) return;
      restored = true;
      if (priorTransactionDescriptor === undefined) {
        delete (database as Partial<AgentDatabase>).transaction;
      } else {
        Object.defineProperty(database, "transaction", priorTransactionDescriptor);
      }
    },
  });
}
