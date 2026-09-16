/**
 * Opt-in, isolated PostgreSQL regression; never uses a configured Nautilo DB.
 * NAUTILO_TEST_OLD_SCHEMA_GRANTS=1 bun test --timeout 60000 packages/db/tests/integration/legacy-role-repair-old-schema.integration.test.ts
 * Requires the pinned pgvector image locally; Docker cannot pull or publish ports.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildFullLegacyRoleRepairSql } from "../../src/utils/legacy-role-repair";
import { buildMemoryCryptoLifecycleRoleGrantsSql } from "../../src/utils/agent-role-grants";

const image = "pgvector/pgvector@sha256:494dff7e67e7bc2c826b94c331364978d145ebb86fd338154138b084223b7f67";
const owner = crypto.randomUUID();
const label = "ai.nautilo.test.old-schema-grants";
let container = "";
function docker(args: string[], input?: string) {
  return Bun.spawnSync(["docker", ...args], {
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe", stderr: "pipe",
  });
}
function sql(query: string, succeeds = true): string {
  const result = docker(["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "nautilo"], query);
  if (succeeds && result.exitCode !== 0) throw new Error(result.stderr.toString());
  if (!succeeds) {
    expect(result.exitCode).not.toBe(0);
    return result.stderr.toString();
  }
  return result.stdout.toString().trim();
}
function generatedStatements(file: string, select: (statement: string) => boolean) {
  return readFileSync(new URL(`../../src/migrations/${file}`, import.meta.url), "utf8")
    .split("--> statement-breakpoint").map((statement) => statement.trim()).filter(select).join("\n");
}
function columns() {
  return sql("SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_name LIKE 'memory_crypto_%' ORDER BY table_name, ordinal_position");
}
function updateGrants(table: string) {
  return sql(`SELECT attname FROM pg_attribute WHERE attrelid = 'public.${table}'::regclass AND attnum > 0 AND NOT attisdropped AND has_column_privilege('nautilo_agent', attrelid, attname, 'UPDATE') ORDER BY attname`).split("\n").filter(Boolean);
}
const commonColumns = ["attempt_count", "completion", "crypto_completed_at", "disposition", "failure_code", "lease_expires_at", "lease_token", "next_attempt_at", "updated_at"];

// This suite owns its sole container. It cannot contact a caller-supplied DB.
describe.skipIf(process.env["NAUTILO_TEST_OLD_SCHEMA_GRANTS"] !== "1")("legacy repair against installed PostgreSQL schemas", () => {
  beforeAll(async () => {
    const created = docker(["run", "-d", "--pull=never", "--network=none", "--name", `nautilo-old-grants-${owner}`, "--label", `${label}=${owner}`, "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=nautilo", image]);
    if (created.exitCode !== 0) throw new Error(created.stderr.toString());
    container = created.stdout.toString().trim();
    const deadline = Date.now() + 30_000;
    while (docker(["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "nautilo"]).exitCode !== 0) {
      if (Date.now() > deadline) throw new Error("Owned PostgreSQL fixture did not become ready");
      await Bun.sleep(100);
    }
    sql("CREATE ROLE nautilo; CREATE ROLE nautilo_agent; CREATE ROLE nautilo_crypto;");
    for (const [file, table] of [
      ["0000_lonely_whirlwind.sql", "users"],
      ["0003_plain_metal_master.sql", "actors"],
      ["0094_d374_db_identity_marker.sql", "nautilo_instance_identity"],
      ["0153_rare_piledriver.sql", "memory_crypto_revisions"],
      ["0153_rare_piledriver.sql", "memory_crypto_operations"],
    ] as const) {
      const ddl = generatedStatements(file, (statement) => statement.startsWith(`CREATE TABLE "${table}" (`));
      expect(ddl).not.toBe("");
      sql(ddl.slice(0, ddl.indexOf("\n);") + 3));
    }
    // Identity columns already existed before the 0153 Memory tables. Use their
    // canonical generated additions, not current-only synthetic projections.
    for (const [file, prefix] of [
      ["0010_rich_richard_fisk.sql", 'ALTER TABLE "actors" ADD COLUMN "kind"'],
      ["0011_lame_kulan_gath.sql", 'ALTER TABLE "users" ADD COLUMN "handle"'],
      ["0020_m047_users_server_column.sql", 'ALTER TABLE "users" ADD COLUMN "server"'],
      ["0128_d458_pairing_and_rejected_transport_cleanup.sql", 'ALTER TABLE "nautilo_instance_identity" ADD COLUMN IF NOT EXISTS "server_instance_id"'],
    ] as const) {
      const ddl = generatedStatements(file, (statement) => statement.startsWith(prefix));
      expect(ddl).not.toBe("");
      sql(ddl.split(";")[0] + ";");
    }
  });
  afterAll(() => {
    if (!container) return;
    const inspected = docker(["inspect", "--format", `{{index .Config.Labels "${label}"}}`, container]);
    expect(inspected.exitCode).toBe(0);
    expect(inspected.stdout.toString().trim()).toBe(owner);
    expect(docker(["rm", "-f", "-v", container]).exitCode).toBe(0);
  });

  test("repairs pre-0250 schemas without adding columns or retaining broad privileges, then preserves the current contract", () => {
    sql(`INSERT INTO memory_crypto_operations (operation_id, memory_id, anchor_namespace_id, operation_type, expected_content_revision, expected_access_revision, request_digest) VALUES ('preserved-operation', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'delete', 0, 0, decode(repeat('00', 32), 'hex'))`);
    const originalRow = sql("SELECT row_to_json(t) FROM memory_crypto_operations t");
    const oldColumns = columns();
    expect(oldColumns).not.toContain("semantic_change_kind");
    expect(sql("GRANT UPDATE (semantic_change_kind) ON memory_crypto_operations TO nautilo_agent", false)).toContain('column "semantic_change_kind"');
    // Historical broad and column-specific grants must both be removed.
    sql("GRANT ALL ON ALL TABLES IN SCHEMA public TO nautilo_agent; GRANT UPDATE (operation_id) ON memory_crypto_operations TO nautilo_agent;");
    sql(buildFullLegacyRoleRepairSql());
    sql(buildFullLegacyRoleRepairSql());
    expect(columns()).toBe(oldColumns);
    expect(sql("SELECT row_to_json(t) FROM memory_crypto_operations t")).toBe(originalRow);
    for (const table of ["memory_crypto_revisions", "memory_crypto_operations"]) {
      expect(updateGrants(table)).toEqual(commonColumns);
      expect(sql(`SELECT has_table_privilege('nautilo_agent', '${table}', 'SELECT'), has_table_privilege('nautilo_agent', '${table}', 'INSERT'), has_table_privilege('nautilo_agent', '${table}', 'UPDATE'), has_table_privilege('nautilo_agent', '${table}', 'DELETE')`)).toBe("t|t|f|f");
      expect(sql(`SELECT has_sequence_privilege('nautilo_agent', '${table}_sequence_seq', 'USAGE'), has_sequence_privilege('nautilo_agent', '${table}_sequence_seq', 'SELECT'), has_sequence_privilege('nautilo_agent', '${table}_sequence_seq', 'UPDATE')`)).toBe("t|f|f");
      sql(`SET ROLE nautilo_agent; SELECT * FROM ${table}; UPDATE ${table} SET completion = completion WHERE false;`);
      expect(sql(`SET ROLE nautilo_agent; DELETE FROM ${table} WHERE false`, false)).toContain("permission denied");
    }
    sql("SET ROLE nautilo_agent; INSERT INTO memory_crypto_operations (operation_id) SELECT 'no-row' WHERE false;");
    expect(sql("SET ROLE nautilo_agent; UPDATE memory_crypto_operations SET operation_id = operation_id WHERE false", false)).toContain("permission denied");
    // Advance only the affected generated DDL, then compare all column ACLs.
    const added = generatedStatements("0250_damp_wrecking_crew.sql", (statement) => statement.startsWith('ALTER TABLE "memory_crypto_operations" ADD COLUMN'));
    expect(added).toContain('"semantic_change_kind"');
    sql(added);
    for (const file of ["0251_chief_starbolt.sql", "0253_open_starfox.sql", "0254_salty_tenebrous.sql"]) {
      const ddl = generatedStatements(file, (statement) => statement.startsWith('ALTER TABLE "memory_crypto_operations" ADD COLUMN'));
      expect(ddl).not.toBe("");
      sql(ddl);
    }
    const currentColumns = columns();
    sql(buildFullLegacyRoleRepairSql());
    expect(columns()).toBe(currentColumns);
    expect(updateGrants("memory_crypto_operations")).toEqual([...commonColumns, "semantic_change_kind"].sort());
    expect(updateGrants("memory_crypto_revisions")).toEqual(commonColumns);
    sql("SET ROLE nautilo_agent; UPDATE memory_crypto_operations SET semantic_change_kind = 'ordinary_fallback' WHERE false");
    expect(sql("SET ROLE nautilo_agent; UPDATE memory_crypto_operations SET semantic_change_acknowledged_at = NULL WHERE false", false)).toContain("permission denied");
    const currentGrants = updateGrants("memory_crypto_operations");
    // The old fixed grant is valid on the current schema: prove exact parity.
    const allOperationColumns = sql("SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'memory_crypto_operations'::regclass AND attnum > 0 AND NOT attisdropped");
    sql(`REVOKE ALL ON memory_crypto_operations FROM nautilo_agent; REVOKE UPDATE (${allOperationColumns}) ON memory_crypto_operations FROM nautilo_agent;`);
    expect(updateGrants("memory_crypto_operations")).toEqual([]);
    sql(`GRANT UPDATE (${[...commonColumns, "semantic_change_kind"].join(", ")}) ON memory_crypto_operations TO nautilo_agent;`);
    expect(updateGrants("memory_crypto_operations")).toEqual(currentGrants);
    sql(buildFullLegacyRoleRepairSql());
  });

  test("never grants a similarly named revision or unrelated column, skips dropped columns and absent tables", () => {
    sql("ALTER TABLE memory_crypto_revisions ADD COLUMN semantic_change_kind text; ALTER TABLE memory_crypto_operations ADD COLUMN unrelated_future_column text; GRANT UPDATE (semantic_change_kind) ON memory_crypto_revisions TO nautilo_agent; GRANT UPDATE (unrelated_future_column) ON memory_crypto_operations TO nautilo_agent;");
    sql(buildFullLegacyRoleRepairSql());
    expect(updateGrants("memory_crypto_revisions")).toEqual(commonColumns);
    expect(updateGrants("memory_crypto_operations")).toEqual([...commonColumns, "semantic_change_kind"].sort());
    sql("ALTER TABLE memory_crypto_operations DROP COLUMN semantic_change_kind;");
    sql(buildMemoryCryptoLifecycleRoleGrantsSql());
    expect(updateGrants("memory_crypto_operations")).toEqual(commonColumns);
    sql("DROP TABLE memory_crypto_operations; DROP TABLE memory_crypto_revisions;");
    sql(buildFullLegacyRoleRepairSql());
  });
});
