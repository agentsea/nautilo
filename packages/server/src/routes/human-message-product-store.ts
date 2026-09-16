import {
  createPostgresJsBridgeConnection,
  createPostgresJsCanonicalBridgeConnection,
  setTrustContextOnTx,
  sql,
  type PostgresJsBridgeConnection,
  type DirectDatabase,
  type PostgresJsBridgeScalar,
} from "@nautilo/db";
import {
  bindConversationProductCanonicalTransactionRunner,
  PostgresConversationProductStore,
  verifyConversationProductPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import { PgDialect } from "drizzle-orm/pg-core";
import { getServerDirectDb } from "../lib/server-direct-db";

/** One Human's product-role handle and the matching canonical transaction owner.
 * Message and Memory publication share the same RLS/rollback boundary. */
export async function createHumanProductTransactionContext(userId: string, database: DirectDatabase = getServerDirectDb()) {
  const connection = createPostgresJsBridgeConnection(database);
  const scope = new PgDialect().sqlToQuery(sql`
    SELECT set_config('app.current_user_id', ${userId}, true)
  `);
  const transaction: PostgresJsBridgeConnection["transaction"] =
    (callback, options) => connection.transaction(async (executor) => {
      await executor.query(scope.sql, scope.params as PostgresJsBridgeScalar[]);
      return callback(executor);
    }, options);
  const scoped: PostgresJsBridgeConnection = {
    query: (statement, parameters) => transaction((executor) =>
      executor.query(statement, parameters)),
    transaction,
    transactionOnce: transaction,
  };
  const handle = await verifyConversationProductPostgresHandle(scoped);
  const canonical = createPostgresJsCanonicalBridgeConnection(database);
  return Object.freeze({
    handle,
    canonicalRunner: bindConversationProductCanonicalTransactionRunner(handle, {
      transaction: (callback, options) => canonical.transaction(async (tx, executor) => {
        await setTrustContextOnTx(tx, { userId });
        return callback(tx, executor);
      }, options),
    }),
  });
}

/** Product-role store scoped to one authenticated Human request. */
export async function createHumanMessageProductStore(userId: string) {
  const { handle, canonicalRunner } = await createHumanProductTransactionContext(userId);
  return new PostgresConversationProductStore(handle, canonicalRunner);
}
