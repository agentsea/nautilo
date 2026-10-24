/**
 * Opt-in PostgreSQL upgrade regression, with no configured DB and an ephemeral port.
 * NAUTILO_TEST_BOLTER_MIGRATIONS=1 bun test --timeout 60000 packages/db/tests/integration/bolter-migration-privileges.integration.test.ts
 * For a fresh UTF-8 native PostgreSQL 17 cluster with pgvector, additionally set
 * NAUTILO_BOLTER_MIGRATION_TEST_PORT to its loopback port (trust-auth postgres).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { verifyMagentLifecycle } from "./helpers/magent-lifecycle";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { buildFullLegacyRoleRepairSql } from "../../src/utils/legacy-role-repair";
import { buildAgentRoleGrantsSql } from "../../src/utils/agent-role-grants";
import { migrateWithMigrationPrivilegeCompat } from "../../src/utils/migration-privilege-compat";

const image = "pgvector/pgvector@sha256:494dff7e67e7bc2c826b94c331364978d145ebb86fd338154138b084223b7f67";
const owner = crypto.randomUUID();
const label = "ai.nautilo.test.bolter-migrations";
const directory = new URL("../../src/migrations/", import.meta.url);
const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", directory), "utf8")) as {
  version: string;
  dialect: string;
  entries: { idx: number; when: number; tag: string; breakpoints: boolean }[];
};
let container = "";
let port = "";
const nativePort = process.env["NAUTILO_BOLTER_MIGRATION_TEST_PORT"];
let nativeDatabaseCreated = false;
function docker(args: string[], input?: string) {
  return Bun.spawnSync(["docker", ...args], { stdin: input === undefined ? "ignore" : Buffer.from(input), stdout: "pipe", stderr: "pipe" });
}
function sql(query: string, succeeds = true): string {
  const args = ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "nautilo", "--single-transaction"];
  const result = nativePort
    ? Bun.spawnSync(["psql", "-h", "127.0.0.1", "-p", port, ...args], { stdin: Buffer.from(query), stdout: "pipe", stderr: "pipe" })
    : docker(["exec", "-i", container, "psql", ...args], query);
  if (succeeds && result.exitCode !== 0) throw new Error(result.stderr.toString());
  if (!succeeds) {
    expect(result.exitCode).not.toBe(0);
    return result.stderr.toString();
  }
  return result.stdout.toString().trim();
}

function createBaselineMigrations(): string {
  const folder = mkdtempSync(join(tmpdir(), "nautilo-migration-baseline-"));
  mkdirSync(join(folder, "meta"));
  const entries = journal.entries.filter(entry => entry.idx < 341);
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({
    version: journal.version,
    dialect: journal.dialect,
    entries,
  }));
  for (const entry of entries) {
    symlinkSync(fileURLToPath(new URL(`${entry.tag}.sql`, directory)), join(folder, `${entry.tag}.sql`));
  }
  return folder;
}

describe.skipIf(process.env["NAUTILO_TEST_BOLTER_MIGRATIONS"] !== "1")("packaged Bolter migration privileges", () => {
  beforeAll(async () => {
    if (nativePort !== undefined) {
      if (!/^\d+$/u.test(nativePort)) throw new Error("Invalid isolated native PostgreSQL fixture port");
      port = nativePort;
      const admin = postgres(`postgres://postgres@127.0.0.1:${port}/postgres`, { max: 1, onnotice: () => {} });
      try {
        const existing = await admin`SELECT 1 FROM pg_roles WHERE rolname IN ('nautilo', 'nautilo_agent', 'nautilo_crypto')
          UNION ALL SELECT 1 FROM pg_database WHERE datname = 'nautilo'`;
        if (existing.length) throw new Error("Dedicated empty migration cluster required; refusing existing Nautilo database or roles");
        await admin`CREATE DATABASE nautilo`;
        nativeDatabaseCreated = true;
      } finally { await admin.end(); }
    } else {
      const created = docker(["run", "-d", "--pull=never", "--tmpfs", "/var/lib/postgresql/data", "-p", "127.0.0.1::5432", "--name", `nautilo-bolter-migrations-${owner}`, "--label", `${label}=${owner}`, "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=nautilo", image]);
      if (created.exitCode !== 0) throw new Error(created.stderr.toString());
      container = created.stdout.toString().trim();
      // Same isolated-fixture readiness bound as the existing legacy-grants suite.
      const deadline = Date.now() + 30_000;
      while (docker(["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "nautilo"]).exitCode !== 0) {
        if (Date.now() > deadline) throw new Error("Owned PostgreSQL fixture did not become ready");
        await Bun.sleep(100);
      }
      const published = docker(["port", container, "5432/tcp"]);
      if (published.exitCode !== 0) throw new Error(published.stderr.toString());
      port = published.stdout.toString().trim().split(":").at(-1) ?? "";
      if (!/^\d+$/.test(port)) throw new Error(`Unexpected PostgreSQL fixture port: ${port}`);
    }
    sql("CREATE ROLE nautilo LOGIN BYPASSRLS; CREATE ROLE nautilo_agent; CREATE ROLE nautilo_crypto; ALTER DATABASE nautilo OWNER TO nautilo; CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;");
    const baseline = createBaselineMigrations();
    const client = postgres(`postgres://postgres@127.0.0.1:${port}/nautilo`, {
      max: 1,
      onnotice: () => {},
    });
    try {
      await migrate(drizzle(client), { migrationsFolder: baseline });
    } finally {
      await client.end();
      rmSync(baseline, { recursive: true, force: true });
    }
    sql(buildFullLegacyRoleRepairSql());
    sql("ALTER SCHEMA drizzle OWNER TO nautilo; ALTER TABLE drizzle.__drizzle_migrations OWNER TO nautilo; ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNER TO nautilo;");
  });

  afterAll(async () => {
    if (nativePort !== undefined) {
      if (!nativeDatabaseCreated) return;
      const admin = postgres(`postgres://postgres@127.0.0.1:${port}/postgres`, { max: 1, onnotice: () => {} });
      try {
        await admin`DROP DATABASE nautilo WITH (FORCE)`;
        for (const role of ["nautilo_agent", "nautilo_crypto", "nautilo"]) await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
      } finally { await admin.end(); }
      return;
    }
    if (!container) return;
    const inspected = docker(["inspect", "--format", `{{index .Config.Labels "${label}"}}`, container]);
    expect(inspected.exitCode).toBe(0);
    expect(inspected.stdout.toString().trim()).toBe(owner);
    expect(docker(["rm", "-f", "-v", container]).exitCode).toBe(0);
  });

  test("reproduces the original denial, applies the complete new tail as its non-superuser owner and retains restricted ACLs", async () => {
    const original = readFileSync(new URL("0341_bent_dust.sql", directory), "utf8");
    expect(sql(`SET ROLE nautilo; ${original}`, false)).toContain("permission denied for table bolter_connections");
    expect(sql("SELECT to_regclass('public.bolter_connections') IS NULL")).toBe("t");
    const client = postgres(`postgres://nautilo@127.0.0.1:${port}/nautilo`, {
      max: 1,
      onnotice: () => {},
    });
    try {
      await migrateWithMigrationPrivilegeCompat(drizzle(client), {
        migrationsFolder: fileURLToPath(directory),
      });
    } finally {
      await client.end();
    }
    sql(`SET ROLE nautilo; ${buildAgentRoleGrantsSql()}`);
    const canonical = readMigrationFiles({ migrationsFolder: fileURLToPath(directory) });
    const expectedLedger = canonical
      .map(({ hash, folderMillis }) => `${hash}|${folderMillis}`)
      .sort()
      .join("\n");
    expect(sql("SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY hash, created_at"))
      .toBe(expectedLedger);
    expect(sql("SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = 'nautilo'")).toBe("f|f");
    for (const table of ["bolter_connections", "bolter_room_bindings", "bolter_inbox_receipts", "bolter_outbox", "bolter_explicit_shares"]) {
      expect(sql(`SELECT has_table_privilege('nautilo', 'public.${table}', 'TRIGGER'), has_table_privilege('nautilo_agent', 'public.${table}', 'TRIGGER'), has_table_privilege('nautilo_crypto', 'public.${table}', 'TRIGGER')`)).toBe("f|f|f");
      expect(sql(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.${table}'::regclass`)).toBe("t|t");
    }
    expect(sql("SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('bolter_connection_lifecycle','bolter_binding_lifecycle','bolter_inbox_lifecycle','bolter_outbox_lifecycle','bolter_final_reply_authority','bolter_reviewed_share_authority')")).toBe("6");
    expect(sql("SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'task_wake_continuation_immutable' AND tgrelid = 'public.protected_task_wake_continuation_receipts'::regclass")).toBe("1");
    expect(sql("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.protected_task_wake_continuation_receipts'::regclass")).toBe("t|t");
    expect(sql("SELECT has_table_privilege('nautilo', 'public.protected_task_wake_continuation_receipts', 'TRIGGER'), has_table_privilege('nautilo_agent', 'public.protected_task_wake_continuation_receipts', 'TRIGGER'), has_table_privilege('nautilo_crypto', 'public.protected_task_wake_continuation_receipts', 'TRIGGER')")).toBe("f|f|f");
    expect(sql("SELECT has_table_privilege('nautilo', 'public.protected_task_wake_continuation_receipts', 'SELECT'), has_table_privilege('nautilo', 'public.protected_task_wake_continuation_receipts', 'INSERT'), has_table_privilege('nautilo', 'public.protected_task_wake_continuation_receipts', 'UPDATE'), has_table_privilege('nautilo', 'public.protected_task_wake_continuation_receipts', 'DELETE')")).toBe("t|t|f|f");
    expect(sql("SELECT has_table_privilege('nautilo_agent', 'public.protected_task_wake_continuation_receipts', 'SELECT'), has_table_privilege('nautilo_agent', 'public.protected_task_wake_continuation_receipts', 'INSERT'), has_table_privilege('nautilo_agent', 'public.protected_task_wake_continuation_receipts', 'UPDATE'), has_table_privilege('nautilo_agent', 'public.protected_task_wake_continuation_receipts', 'DELETE'), has_table_privilege('nautilo_crypto', 'public.protected_task_wake_continuation_receipts', 'SELECT'), has_table_privilege('nautilo_crypto', 'public.protected_task_wake_continuation_receipts', 'INSERT'), has_table_privilege('nautilo_crypto', 'public.protected_task_wake_continuation_receipts', 'UPDATE'), has_table_privilege('nautilo_crypto', 'public.protected_task_wake_continuation_receipts', 'DELETE')")).toBe("f|f|f|f|f|f|f|f");
    expect(sql("SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'foreground_memory_publication_immutable' AND tgrelid = 'public.foreground_memory_crypto_publication_receipts'::regclass")).toBe("1");
    expect(sql("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.foreground_memory_crypto_publication_receipts'::regclass")).toBe("t|t");
    expect(sql("SELECT has_table_privilege('nautilo', 'public.foreground_memory_crypto_publication_receipts', 'TRIGGER'), has_table_privilege('nautilo_agent', 'public.foreground_memory_crypto_publication_receipts', 'TRIGGER'), has_table_privilege('nautilo_crypto', 'public.foreground_memory_crypto_publication_receipts', 'TRIGGER')")).toBe("f|f|f");
    expect(sql("SELECT has_table_privilege('nautilo_crypto', 'public.foreground_memory_crypto_publication_receipts', 'SELECT'), has_table_privilege('nautilo_crypto', 'public.foreground_memory_crypto_publication_receipts', 'INSERT'), has_table_privilege('nautilo_crypto', 'public.foreground_memory_crypto_publication_receipts', 'UPDATE'), has_table_privilege('nautilo_crypto', 'public.foreground_memory_crypto_publication_receipts', 'DELETE')")).toBe("t|t|f|f");
    expect(sql("SELECT has_table_privilege('nautilo', 'public.foreground_memory_crypto_publication_receipts', 'SELECT'), has_table_privilege('nautilo', 'public.foreground_memory_crypto_publication_receipts', 'INSERT'), has_table_privilege('nautilo', 'public.foreground_memory_crypto_publication_receipts', 'UPDATE'), has_table_privilege('nautilo', 'public.foreground_memory_crypto_publication_receipts', 'DELETE'), has_table_privilege('nautilo_agent', 'public.foreground_memory_crypto_publication_receipts', 'SELECT'), has_table_privilege('nautilo_agent', 'public.foreground_memory_crypto_publication_receipts', 'INSERT'), has_table_privilege('nautilo_agent', 'public.foreground_memory_crypto_publication_receipts', 'UPDATE'), has_table_privilege('nautilo_agent', 'public.foreground_memory_crypto_publication_receipts', 'DELETE')")).toBe("f|f|f|f|f|f|f|f");
    expect(sql("SELECT has_function_privilege('nautilo', 'public.reject_foreground_memory_publication_update()', 'EXECUTE'), has_function_privilege('nautilo_agent', 'public.reject_foreground_memory_publication_update()', 'EXECUTE'), has_function_privilege('nautilo_crypto', 'public.reject_foreground_memory_publication_update()', 'EXECUTE')")).toBe("f|f|f");
    expect(sql("SELECT has_function_privilege('nautilo', 'public.bolter_assert_current_binding(uuid,uuid,integer,integer)', 'EXECUTE'), has_function_privilege('nautilo_agent', 'public.bolter_assert_current_binding(uuid,uuid,integer,integer)', 'EXECUTE'), has_function_privilege('nautilo_crypto', 'public.bolter_assert_current_binding(uuid,uuid,integer,integer)', 'EXECUTE')")).toBe("f|t|f");
    expect(sql("SELECT has_column_privilege('nautilo', 'public.bolter_room_bindings', 'user_id', 'REFERENCES'), has_column_privilege('nautilo', 'public.bolter_room_bindings', 'id', 'REFERENCES')")).toBe("f|f");
    expect(sql("SELECT has_table_privilege('nautilo_agent', 'public.bolter_connections', 'SELECT'), has_table_privilege('nautilo_agent', 'public.bolter_connections', 'INSERT'), has_table_privilege('nautilo_agent', 'public.bolter_connections', 'UPDATE'), has_table_privilege('nautilo_agent', 'public.bolter_connections', 'DELETE')")).toBe("t|t|t|f");
  });
  test("mAgent control receipts and results survive restart without conversation rows and preserve cancellation authority", async () => {
    await verifyMagentLifecycle(port);
  });

});
