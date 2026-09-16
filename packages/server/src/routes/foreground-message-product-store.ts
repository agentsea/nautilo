import {
  createPostgresJsBridgeConnection,
  createPostgresJsCanonicalBridgeConnection,
  getSharedDirectAgentDb,
  setTrustContextOnTx,
  sql,
  type PostgresJsBridgeConnection,
  type PostgresJsBridgeScalar,
  type TrustContext,
} from "@nautilo/db";
import {
  bindConversationProductCanonicalTransactionRunner,
  PostgresConversationProductStore,
  verifyConversationProductPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import { PgDialect } from "drizzle-orm/pg-core";

/** Existing Message repair runs as its actual Agent, never as the server role. */
export async function createForegroundMessageProductStore(
  context: Required<TrustContext>,
  database = getSharedDirectAgentDb(),
): Promise<PostgresConversationProductStore> {
  const { handle, canonicalRunner } = await createForegroundProductTransactionContext(context, database);
  return new PostgresConversationProductStore(handle, canonicalRunner);
}

/** Shared current-subject transaction owner for foreground product mutations. */
export async function createForegroundProductTransactionContext(
  context: Required<TrustContext>,
  database = getSharedDirectAgentDb(),
) {
  const connection = createPostgresJsBridgeConnection(database);
  const scope = new PgDialect().sqlToQuery(sql`
    SELECT set_config('app.current_user_id', ${context.userId}, true),
           set_config('app.current_agent_id', ${context.agentId}, true)
  `);
  const transaction: PostgresJsBridgeConnection["transaction"] = (
    callback,
    options,
  ) => connection.transaction(async (executor) => {
    await executor.query(scope.sql, scope.params as PostgresJsBridgeScalar[]);
    return callback(executor);
  }, options);
  const scoped: PostgresJsBridgeConnection = {
    query: (statement, parameters) => transaction((executor) =>
      executor.query(statement, parameters)
    ),
    transaction,
    transactionOnce: transaction,
  };
  const handle = await verifyConversationProductPostgresHandle(scoped);
  const canonical = createPostgresJsCanonicalBridgeConnection(database);
  return Object.freeze({
    handle,
    canonicalRunner: bindConversationProductCanonicalTransactionRunner(handle, {
      transaction: (callback, options) => canonical.transaction(async (tx, executor) => {
        await setTrustContextOnTx(tx, context);
        return callback(tx, executor);
      }, options),
    }),
  });
}
