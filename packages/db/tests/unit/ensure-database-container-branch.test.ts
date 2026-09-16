// M114: unit test for the NAUTILO_DB_BOOTSTRAP=container guard branch in
// `packages/db/src/utils/ensure-database.ts`. Real Postgres + migrations
// are covered by the existing integration test; this unit test only
// verifies the input-validation guards so we don't need a live DB.
//
// Specifically: when NAUTILO_DB_BOOTSTRAP=container and
// DB_DIRECT_CONNECTION is missing, ensureDatabase() must throw a clear
// error BEFORE attempting any postgres connection.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  ensureDatabase,
  runtimeRoleContractSql,
} from "../../src/utils/ensure-database";

const ENSURE_DATABASE_SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../src/utils/ensure-database.ts"),
  "utf8",
);

const SAVED = new Map<string, string | undefined>();
const KEYS = [
  "NAUTILO_DB_BOOTSTRAP",
  "DB_DIRECT_CONNECTION",
  "DB_CONNECTION_STRING",
  "NAUTILO_MIGRATIONS_DIR",
];

function saveEnv() {
  for (const k of KEYS) SAVED.set(k, process.env[k]);
}
function restoreEnv() {
  for (const k of KEYS) {
    const v = SAVED.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("ensureDatabase() container branch (M114)", () => {
  beforeEach(() => {
    saveEnv();
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    restoreEnv();
  });

  test("throws if NAUTILO_DB_BOOTSTRAP=container and DB_DIRECT_CONNECTION is unset", async () => {
    process.env["NAUTILO_DB_BOOTSTRAP"] = "container";
    let caught: unknown;
    try {
      await ensureDatabase();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(
      /NAUTILO_DB_BOOTSTRAP=container requires DB_DIRECT_CONNECTION/
    );
  });

  test("container readiness uses direct postgres.js SELECT 1 (no Neon proxy)", () => {
    expect(ENSURE_DATABASE_SOURCE).toMatch(/sql`SELECT 1`/);
    expect(ENSURE_DATABASE_SOURCE).not.toContain("Neon-Pool-Opt-In");
    expect(ENSURE_DATABASE_SOURCE).not.toMatch(/@neondatabase\/serverless/);
    expect(ENSURE_DATABASE_SOURCE).not.toMatch(/neon-local-proxy/);
  });

  test("container role reconciliation never attempts postgres-owned default privileges", () => {
    const containerSql = runtimeRoleContractSql("container");
    expect(containerSql).toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE nautilo IN SCHEMA public",
    );
    expect(containerSql).not.toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public",
    );

    const hostSql = runtimeRoleContractSql("host");
    expect(hostSql).toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public",
    );
  });
});
