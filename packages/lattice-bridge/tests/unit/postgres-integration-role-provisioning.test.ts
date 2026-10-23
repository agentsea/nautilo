import { describe, expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { resolveCryptoDatabaseConnectionString } from "@nautilo/db";
import { buildEventFeedReaderRoleSql } from "../../../db/src/utils/event-feed-role";
import { readMigrationFilesWithPrivilegeCompat } from "../../../db/src/utils/migration-privilege-compat";
import {
  buildDisposableTemplateSql,
  buildDisposablePostgresTestEnv,
  buildDisposableInstanceIdentitySql,
  migrateDisposablePostgres,
  provisionDisposableInstanceIdentity,
  provisionPrivilegedMigrationRoles,
} from "../../scripts/run-postgres-integration";
import {
  DISPOSABLE_RESET_CONTAINER_ENV,
  DISPOSABLE_RESET_PORT_ENV,
  DISPOSABLE_RESET_TOKEN_ENV,
  DISPOSABLE_TEMPLATE_DATABASE,
  readDisposableResetAuthority,
} from "../../scripts/disposable-postgres-reset";

const disposableUrls = Object.freeze({
  admin: "postgres://postgres:admin@127.0.0.1:55432/nautilo",
  app: "postgres://nautilo:app@127.0.0.1:55432/nautilo",
  agent: "postgres://nautilo_agent:agent@127.0.0.1:55432/nautilo",
  crypto: "postgres://nautilo_crypto:crypto@127.0.0.1:55432/nautilo",
});
const disposableAuthority = Object.freeze({
  [DISPOSABLE_RESET_CONTAINER_ENV]: "nautilo-lattice-bridge-test-123-456",
  [DISPOSABLE_RESET_TOKEN_ENV]: "a".repeat(64),
  [DISPOSABLE_RESET_PORT_ENV]: "55432",
});

describe("disposable Postgres migration role provisioning", () => {
  test("binds the runtime crypto connection to the exact fixture instead of inherited state", () => {
    const inherited = {
      ...disposableAuthority,
      DB_CRYPTO_CONNECTION_STRING: "postgres://nautilo_crypto:outside@qa.example.com:55433/nautilo",
    };
    const env = buildDisposablePostgresTestEnv(disposableUrls, inherited);

    expect(resolveCryptoDatabaseConnectionString(env)).toBe(disposableUrls.crypto);
    expect(env["LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL"]).toBe(disposableUrls.admin);
    expect(env["LATTICE_BRIDGE_TEST_APP_DATABASE_URL"]).toBe(disposableUrls.app);
    expect(env["LATTICE_BRIDGE_TEST_AGENT_DATABASE_URL"]).toBe(disposableUrls.agent);
    expect(env["LATTICE_BRIDGE_TEST_DATABASE_URL"]).toBe(disposableUrls.crypto);
    expect(env[DISPOSABLE_RESET_TOKEN_ENV]).toBe(disposableAuthority[DISPOSABLE_RESET_TOKEN_ENV]);
    expect(inherited["DB_CRYPTO_CONNECTION_STRING"]).toContain("qa.example.com");
  });

  test("supplies the runtime crypto connection when none was inherited", () => {
    const env = buildDisposablePostgresTestEnv(disposableUrls, disposableAuthority);
    expect(resolveCryptoDatabaseConnectionString(env)).toBe(disposableUrls.crypto);
  });

  test("refuses to build a child environment outside the disposable fixture authority", () => {
    expect(() => buildDisposablePostgresTestEnv(disposableUrls, {}))
      .toThrow("container authority is missing");
    expect(() => buildDisposablePostgresTestEnv({
      ...disposableUrls,
      crypto: disposableUrls.app,
    }, disposableAuthority)).toThrow("crypto database URL is outside");
  });

  test("routes canonical privilege-compatible migrations through the Drizzle session", async () => {
    // Intercept only the SQL execution boundary; read and repair real migrations.
    const migrate = spyOn(PgDialect.prototype, "migrate").mockResolvedValue();
    const config = {
      migrationsFolder: resolve(import.meta.dir, "../../../db/src/migrations"),
    };
    try {
      await migrateDisposablePostgres(disposableUrls.app);

      expect(migrate).toHaveBeenCalledTimes(1);
      const [migrations, , actualConfig] = migrate.mock.calls[0]!;
      expect(actualConfig).toEqual(config);
      expect(migrations).toEqual(readMigrationFilesWithPrivilegeCompat(config));
    } finally {
      migrate.mockRestore();
    }
  });

  test("uses the explicit app connection and awaits its close after migration", async () => {
    const events: string[] = [];
    await migrateDisposablePostgres(disposableUrls.app, async (db) => {
      expect(db.$client.options.user).toBe("nautilo");
      expect(db.$client.options.database).toBe("nautilo");
      expect(db.$client.options.host).toEqual(["127.0.0.1"]);
      expect(db.$client.options.port).toEqual([55432]);
      expect(db.$client.options.max).toBe(1);
      const close = db.$client.end.bind(db.$client);
      spyOn(db.$client, "end").mockImplementation(async () => {
        events.push("close");
        await close();
        events.push("closed");
      });
      events.push("migrated");
    });
    events.push("complete");
    expect(events).toEqual(["migrated", "close", "closed", "complete"]);
  });

  test("closes its connection before propagating a migration failure", async () => {
    const failure = new Error("migration failed");
    const events: string[] = [];
    const migration = migrateDisposablePostgres(disposableUrls.app, async (db) => {
      const close = db.$client.end.bind(db.$client);
      spyOn(db.$client, "end").mockImplementation(async () => {
        await close();
        events.push("closed");
      });
      throw failure;
    });

    expect(await migration.catch((error: unknown) => error)).toBe(failure);
    expect(events).toEqual(["closed"]);
  });

  test("uses the canonical cluster-admin role contract before app migrations", () => {
    const calls: Array<{ database: string; script: string }> = [];

    provisionPrivilegedMigrationRoles((database, script) => {
      calls.push({ database, script });
    });

    expect(calls).toEqual([{
      database: "postgres",
      script: buildEventFeedReaderRoleSql(),
    }]);
    expect(calls[0]!.script).toContain(
      "CREATE ROLE nautilo_feed_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS",
    );
    expect(calls[0]!.script).toContain(
      "GRANT nautilo_feed_reader TO nautilo WITH INHERIT FALSE",
    );
    expect(calls[0]!.script).not.toContain("ALTER ROLE nautilo CREATEROLE");
  });

  test("seeds one disposable deployment identity without rewriting it", () => {
    const calls: Array<{ database: string; script: string }> = [];

    provisionDisposableInstanceIdentity((database, script) => {
      calls.push({ database, script });
    });

    expect(calls).toEqual([{
      database: "nautilo",
      script: buildDisposableInstanceIdentitySql(),
    }]);
    expect(calls[0]!.script).toContain(
      "INSERT INTO public.nautilo_instance_identity (id, instance_id)",
    );
    expect(calls[0]!.script).toContain(
      "VALUES ('self', 'lattice-bridge-integration')",
    );
    expect(calls[0]!.script).toContain("ON CONFLICT (id) DO NOTHING");
    expect(calls[0]!.script).not.toContain("DO UPDATE");
  });

  test("freezes the migrated database as an unconnectable reset template", () => {
    const setup = buildDisposableTemplateSql();

    expect(setup).toContain(
      `CREATE DATABASE ${DISPOSABLE_TEMPLATE_DATABASE}`,
    );
    expect(setup).toContain("WITH TEMPLATE nautilo OWNER nautilo");
    expect(setup).toContain(
      `ALTER DATABASE ${DISPOSABLE_TEMPLATE_DATABASE} ALLOW_CONNECTIONS false`,
    );
    expect(setup).not.toContain("TRUNCATE");
    expect(setup).not.toContain("DISABLE TRIGGER");
  });

  test("accepts only the exact disposable container, port, database, and roles", () => {
    expect(readDisposableResetAuthority(
      disposableUrls,
      disposableAuthority,
    )).toEqual({
      container: "nautilo-lattice-bridge-test-123-456",
      token: "a".repeat(64),
      port: "55432",
    });

    expect(() => readDisposableResetAuthority(disposableUrls, {})).toThrow(
      "container authority is missing",
    );
    expect(() => readDisposableResetAuthority(disposableUrls, {
      ...disposableAuthority,
      [DISPOSABLE_RESET_TOKEN_ENV]: "not-a-token",
    })).toThrow("token authority is missing");
    expect(() => readDisposableResetAuthority({
      ...disposableUrls,
      app: "postgres://nautilo:app@qa.example.com:55432/nautilo",
    }, disposableAuthority)).toThrow("app database URL is outside");
    expect(() => readDisposableResetAuthority({
      ...disposableUrls,
      crypto: "postgres://nautilo:crypto@127.0.0.1:55432/nautilo",
    }, disposableAuthority)).toThrow("crypto database URL is outside");
    expect(() => readDisposableResetAuthority({
      ...disposableUrls,
      admin: "postgres://postgres:admin@127.0.0.1:55433/nautilo",
    }, disposableAuthority)).toThrow("admin database URL is outside");
    expect(() => readDisposableResetAuthority({
      ...disposableUrls,
      agent: "postgres://nautilo_agent:agent@127.0.0.1:55432/postgres",
    }, disposableAuthority)).toThrow("agent database URL is outside");
  });
});
