/**
 * Opt-in PostgreSQL upgrade regression, with no configured DB or published port.
 * NAUTILO_TEST_BOLTER_MIGRATIONS=1 bun test --timeout 60000 packages/db/tests/integration/bolter-migration-privileges.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildFullLegacyRoleRepairSql } from "../../src/utils/legacy-role-repair";
import { buildAgentRoleGrantsSql } from "../../src/utils/agent-role-grants";
import { withMigrationPrivilegeCompat } from "../../src/utils/migration-privilege-compat";

const image = "pgvector/pgvector@sha256:494dff7e67e7bc2c826b94c331364978d145ebb86fd338154138b084223b7f67";
const owner = crypto.randomUUID();
const label = "ai.nautilo.test.bolter-migrations";
const directory = new URL("../../src/migrations/", import.meta.url);
const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", directory), "utf8")) as { entries: { idx: number; tag: string }[] };
let container = "";
function docker(args: string[], input?: string) {
  return Bun.spawnSync(["docker", ...args], { stdin: input === undefined ? "ignore" : Buffer.from(input), stdout: "pipe", stderr: "pipe" });
}
function sql(query: string, succeeds = true): string {
  const result = docker(["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "nautilo", "--single-transaction"], query);
  if (succeeds && result.exitCode !== 0) throw new Error(result.stderr.toString());
  if (!succeeds) {
    expect(result.exitCode).not.toBe(0);
    return result.stderr.toString();
  }
  return result.stdout.toString().trim();
}

describe.skipIf(process.env["NAUTILO_TEST_BOLTER_MIGRATIONS"] !== "1")("packaged Bolter migration privileges", () => {
  beforeAll(async () => {
    const created = docker(["run", "-d", "--pull=never", "--network=none", "--name", `nautilo-bolter-migrations-${owner}`, "--label", `${label}=${owner}`, "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=nautilo", image]);
    if (created.exitCode !== 0) throw new Error(created.stderr.toString());
    container = created.stdout.toString().trim();
    // Same isolated-fixture readiness bound as the existing legacy-grants suite.
    const deadline = Date.now() + 30_000;
    while (docker(["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "nautilo"]).exitCode !== 0) {
      if (Date.now() > deadline) throw new Error("Owned PostgreSQL fixture did not become ready");
      await Bun.sleep(100);
    }
    sql("CREATE ROLE nautilo BYPASSRLS; CREATE ROLE nautilo_agent; CREATE ROLE nautilo_crypto; ALTER DATABASE nautilo OWNER TO nautilo; CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;");
    await withMigrationPrivilegeCompat(directory.pathname, async (folder) => {
      const baseline = journal.entries.filter(entry => entry.idx < 341)
        .map(entry => readFileSync(`${folder}/${entry.tag}.sql`, "utf8")).join("\n");
      sql(baseline);
    });
    sql(buildFullLegacyRoleRepairSql());
  });

  afterAll(() => {
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
    await withMigrationPrivilegeCompat(directory.pathname, async (folder) => {
      const tail = journal.entries.filter(entry => entry.idx >= 341)
        .map(entry => readFileSync(`${folder}/${entry.tag}.sql`, "utf8")).join("\n");
      sql(`SET ROLE nautilo; ${tail}\n${buildAgentRoleGrantsSql()}`);
    });
    expect(sql("SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = 'nautilo'")).toBe("f|f");
    for (const table of ["bolter_connections", "bolter_room_bindings", "bolter_inbox_receipts", "bolter_outbox", "bolter_explicit_shares"]) {
      expect(sql(`SELECT has_table_privilege('nautilo', 'public.${table}', 'TRIGGER'), has_table_privilege('nautilo_agent', 'public.${table}', 'TRIGGER'), has_table_privilege('nautilo_crypto', 'public.${table}', 'TRIGGER')`)).toBe("f|f|f");
      expect(sql(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.${table}'::regclass`)).toBe("t|t");
    }
    expect(sql("SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('bolter_connection_lifecycle','bolter_binding_lifecycle','bolter_inbox_lifecycle','bolter_outbox_lifecycle','bolter_final_reply_authority','bolter_reviewed_share_authority')")).toBe("6");
    expect(sql("SELECT has_function_privilege('nautilo', 'public.bolter_assert_current_binding(uuid,uuid,integer,integer)', 'EXECUTE'), has_function_privilege('nautilo_agent', 'public.bolter_assert_current_binding(uuid,uuid,integer,integer)', 'EXECUTE'), has_function_privilege('nautilo_crypto', 'public.bolter_assert_current_binding(uuid,uuid,integer,integer)', 'EXECUTE')")).toBe("f|t|f");
    expect(sql("SELECT has_column_privilege('nautilo', 'public.bolter_room_bindings', 'user_id', 'REFERENCES'), has_column_privilege('nautilo', 'public.bolter_room_bindings', 'id', 'REFERENCES')")).toBe("f|f");
    expect(sql("SELECT has_table_privilege('nautilo_agent', 'public.bolter_connections', 'SELECT'), has_table_privilege('nautilo_agent', 'public.bolter_connections', 'INSERT'), has_table_privilege('nautilo_agent', 'public.bolter_connections', 'UPDATE'), has_table_privilege('nautilo_agent', 'public.bolter_connections', 'DELETE')")).toBe("t|t|t|f");
  });
});
