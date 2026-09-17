import { describe, expect, test } from "bun:test";
import { buildEventFeedReaderRoleSql } from "../../../db/src/utils/event-feed-role";
import {
  buildDisposableTemplateSql,
  buildDisposableInstanceIdentitySql,
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
