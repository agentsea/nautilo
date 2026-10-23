import type postgres from "postgres";
import {
  readDisposableResetAuthority,
  verifyDisposablePostgresAuthority,
  type DisposableResetUrls,
} from "./disposable-postgres-reset";

const cleanupPrivileges = [
  ["agent_crypto_runtime_signers", "UPDATE"],
  ["agent_crypto_runtime_signers", "SELECT"],
  ["protected_task_wake_continuation_receipts", "UPDATE"],
  ["protected_task_wake_continuation_receipts", "SELECT"],
  ["protected_task_wake_continuation_receipts", "DELETE"],
  ["task_cancellation_crypto_staging_receipts", "SELECT"],
  ["task_cancellation_crypto_staging_receipts", "DELETE"],
  ["task_terminal_message_crypto_staging_receipts", "SELECT"],
  ["task_terminal_message_crypto_staging_receipts", "DELETE"],
  ["task_historical_content_crypto_staging_receipts", "SELECT"],
  ["task_historical_content_crypto_staging_receipts", "DELETE"],
  ["foreground_memory_crypto_publication_receipts", "SELECT"],
  ["foreground_memory_crypto_publication_receipts", "DELETE"],
] as const;

export function readDisposableCleanupUrls(
  env: NodeJS.ProcessEnv = process.env,
): DisposableResetUrls {
  const required = (key: string): string => {
    const value = env[key];
    if (!value) throw new Error(`Missing disposable cleanup environment: ${key}`);
    return value;
  };
  const urls = {
    admin: required("LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL"),
    app: required("LATTICE_BRIDGE_TEST_APP_DATABASE_URL"),
    agent: required("LATTICE_BRIDGE_TEST_AGENT_DATABASE_URL"),
    crypto: required("LATTICE_BRIDGE_TEST_DATABASE_URL"),
  };
  readDisposableResetAuthority(urls, env);
  return urls;
}

/** Administrative fixture teardown only; grants and deletion share one transaction. */
export async function withDisposableFixtureCleanup(
  admin: postgres.Sql,
  cleanup: (transaction: postgres.TransactionSql) => Promise<unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const urls = readDisposableCleanupUrls(env);
  const expected = new URL(urls.admin);
  if (
    admin.options.user !== "postgres"
    || admin.options.database !== "nautilo"
    || admin.options.host.length !== 1
    || admin.options.host[0] !== expected.hostname
    || admin.options.port.length !== 1
    || admin.options.port[0] !== Number(expected.port)
  ) {
    throw new Error("Fixture cleanup requires the exact disposable administrator connection");
  }
  verifyDisposablePostgresAuthority(urls, env);
  await admin.begin(async transaction => {
    const temporary: Array<typeof cleanupPrivileges[number]> = [];
    for (const entry of cleanupPrivileges) {
      const [table, privilege] = entry;
      const [original] = await transaction<{ allowed: boolean }[]>`
        SELECT has_table_privilege('nautilo', ${`public.${table}`}, ${privilege}) AS allowed
      `;
      if (!original) throw new Error("Fixture privilege snapshot is unavailable");
      if (!original.allowed) {
        // These identifiers come only from the fixed cleanup contract above.
        await transaction.unsafe(`GRANT ${privilege} ON TABLE public.${table} TO nautilo`);
        temporary.push(entry);
      }
    }
    // postgres-js omits options on transaction handles at runtime. Drizzle's
    // adapter needs the owned parent's parsers while retaining this connection.
    await cleanup(Object.assign(transaction, { options: admin.options }));
    for (const [table, privilege] of temporary.reverse()) {
      await transaction.unsafe(`REVOKE ${privilege} ON TABLE public.${table} FROM nautilo`);
    }
  });
}
