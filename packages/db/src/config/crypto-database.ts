import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

import { registerPoolForShutdown } from "./pool-shutdown-registry";
import { createRuntimeStatementDebugHandler } from "./runtime-statement-observer";
import * as schema from "../schema/index";

const CRYPTO_ROLE = "nautilo_crypto";
const SHARED_CRYPTO_POOL_NAME = "direct:nautilo-crypto";
const SHARED_CRYPTO_APP_NAME = "nautilo.crypto-direct";
const TEST_POOL_CLOSE_TIMEOUT_SECONDS = 1;

export class CryptoDatabaseConnectionUnavailableError extends Error {
  constructor(message = "DB_CRYPTO_CONNECTION_STRING is unavailable") {
    super(message);
    this.name = "CryptoDatabaseConnectionUnavailableError";
  }
}

/**
 * Resolve the dedicated restricted-role URL. There is deliberately no app
 * URL/password derivation here: startup owns secret propagation and the DB
 * package must never silently collapse the product and crypto roles.
 */
export function resolveCryptoDatabaseConnectionString(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env["DB_CRYPTO_CONNECTION_STRING"]?.trim();
  if (!raw) throw new CryptoDatabaseConnectionUnavailableError();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CryptoDatabaseConnectionUnavailableError(
      "DB_CRYPTO_CONNECTION_STRING is not a valid URL",
    );
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new CryptoDatabaseConnectionUnavailableError(
      "DB_CRYPTO_CONNECTION_STRING must use PostgreSQL",
    );
  }
  if (url.username !== CRYPTO_ROLE || url.password.length === 0) {
    throw new CryptoDatabaseConnectionUnavailableError(
      "DB_CRYPTO_CONNECTION_STRING must authenticate as nautilo_crypto",
    );
  }
  if (url.pathname !== "/nautilo") {
    throw new CryptoDatabaseConnectionUnavailableError(
      "DB_CRYPTO_CONNECTION_STRING must target the nautilo database",
    );
  }
  return raw;
}

function withApplicationName(connectionString: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("application_name", SHARED_CRYPTO_APP_NAME);
  return url.toString();
}

function createRuntimeCryptoDb() {
  const sql = postgres(withApplicationName(
    resolveCryptoDatabaseConnectionString(),
  ), {
    max: 5,
    debug: createRuntimeStatementDebugHandler("crypto"),
  });
  const db = drizzle(sql, { schema });
  return Object.assign(db, {
    end: (options?: { timeout?: number }) => sql.end(options),
  });
}

export type CryptoDatabase = ReturnType<typeof createRuntimeCryptoDb>;

let runtimeCryptoDb: CryptoDatabase | null = null;
let unregisterRuntimeCrypto: (() => void) | null = null;

function getRuntimeCryptoDb(): CryptoDatabase {
  if (!runtimeCryptoDb) {
    runtimeCryptoDb = createRuntimeCryptoDb();
    unregisterRuntimeCrypto = registerPoolForShutdown({
      name: SHARED_CRYPTO_POOL_NAME,
      close: async (timeoutMs) => {
        const active = runtimeCryptoDb;
        if (!active) return;
        await active.end({ timeout: Math.max(1, Math.ceil(timeoutMs / 1_000)) });
        runtimeCryptoDb = null;
      },
    });
  }
  return runtimeCryptoDb;
}

/** Restricted same-process runtime pool for injection into bridge adapters. */
export function createCryptoDatabase(): CryptoDatabase {
  return getRuntimeCryptoDb();
}

/** Alias documenting that callers receive the one process-owned direct pool. */
export function getSharedDirectCryptoDb(): CryptoDatabase {
  return getRuntimeCryptoDb();
}

/** @internal test seam; never discards a live handle without closing it. */
export async function __resetSharedDirectCryptoDbForTests(): Promise<void> {
  if (runtimeCryptoDb) {
    await runtimeCryptoDb.end({ timeout: TEST_POOL_CLOSE_TIMEOUT_SECONDS });
    runtimeCryptoDb = null;
  }
  unregisterRuntimeCrypto?.();
  unregisterRuntimeCrypto = null;
}
