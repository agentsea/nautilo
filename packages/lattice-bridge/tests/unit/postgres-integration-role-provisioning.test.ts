import { describe, expect, test } from "bun:test";
import { buildEventFeedReaderRoleSql } from "../../../db/src/utils/event-feed-role";
import { provisionPrivilegedMigrationRoles } from "../../scripts/run-postgres-integration";

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
});
