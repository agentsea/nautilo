import { describe, expect, test } from "bun:test";
import { buildAgentRoleGrantsSql } from "@nautilo/db";
import { buildFullCryptoTablePrivilegeReconcileSql } from "../../src/utils/crypto-role-contract";
import {
  buildAppRoleOwnershipRepairSql,
  buildFullLegacyRoleRepairSql,
  buildVectorExtensionRepairSql,
  NAUTILO_APP_ROLE,
  NAUTILO_ESSENTIAL_SELECT_TABLE,
  PROBE_NAUTILO_ESSENTIAL_SELECT_SQL,
  PROBE_PUBLIC_OBJECTS_NOT_OWNED_SQL,
} from "../../src/utils/legacy-role-repair";

describe("legacy-role-repair SQL builders", () => {
  test("vector extension repair is idempotent and fails clearly without pgvector", () => {
    const sql = buildVectorExtensionRepairSql();

    expect(sql).toContain("pg_available_extensions WHERE name = 'vector'");
    expect(sql).toContain(
      "app-postgres must use the pgvector image (e.g. pgvector/pgvector:pg17)",
    );
    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(sql).not.toContain("DROP ");
  });

  test("ownership repair covers public relations and non-extension routines", () => {
    const sql = buildAppRoleOwnershipRepairSql();

    expect(sql).toContain("DO $$");
    expect(sql).toContain("'r', 'p', 'S', 'v', 'm', 'f'");
    expect(sql).toContain(
      `pg_catalog.pg_get_userbyid(c.relowner) <> '${NAUTILO_APP_ROLE}'`,
    );
    expect(sql).toContain("c.relkind <> 'S'");
    expect(sql).toContain("d.deptype = 'a'");
    expect(sql).toContain("ALTER SEQUENCE public.%I OWNER TO nautilo");
    expect(sql).toContain("ALTER TABLE public.%I OWNER TO nautilo");
    expect(sql).toContain("ALTER VIEW public.%I OWNER TO nautilo");
    expect(sql).toContain("ALTER MATERIALIZED VIEW public.%I OWNER TO nautilo");
    expect(sql).toContain("ALTER FOREIGN TABLE public.%I OWNER TO nautilo");
    expect(sql).toContain("pg_get_function_identity_arguments(p.oid)");
    expect(sql).toContain("d.classid = 'pg_proc'::regclass");
    expect(sql).toContain("d.deptype = 'e'");
    expect(sql).toContain("ALTER FUNCTION public.%I(%s) OWNER TO nautilo");
    expect(sql).toContain("ALTER PROCEDURE public.%I(%s) OWNER TO nautilo");
    expect(sql).toContain("ALTER AGGREGATE public.%I(%s) OWNER TO nautilo");
    expect(sql).toContain("GRANT USAGE ON SCHEMA public TO nautilo");
    expect(sql).toContain(
      "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO nautilo",
    );
    expect(sql).toContain(
      "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO nautilo",
    );
    expect(sql).toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public",
    );
    expect(sql).toContain("GRANT ALL ON TABLES TO nautilo");
    expect(sql).toContain("GRANT ALL ON SEQUENCES TO nautilo");
    expect(sql).not.toContain("DROP ");
    expect(sql).not.toContain("CREATE SCHEMA");
  });

  test("full legacy repair finishes broad ownership repair with exact agent and crypto grants", () => {
    const sql = buildFullLegacyRoleRepairSql();
    const vector = buildVectorExtensionRepairSql();
    const ownership = buildAppRoleOwnershipRepairSql();
    const agent = buildAgentRoleGrantsSql().trim();
    const crypto = buildFullCryptoTablePrivilegeReconcileSql();

    expect(sql.startsWith(vector)).toBe(true);
    expect(sql.indexOf("CREATE EXTENSION IF NOT EXISTS vector")).toBeLessThan(
      sql.indexOf("pg_catalog.pg_get_userbyid(c.relowner)"),
    );
    expect(sql.indexOf(ownership)).toBeGreaterThan(
      sql.indexOf("CREATE EXTENSION IF NOT EXISTS vector"),
    );
    expect(sql).toContain(agent);
    expect(sql).toContain(crypto);
    expect(sql.indexOf(ownership)).toBeLessThan(
      sql.indexOf("GRANT USAGE ON SCHEMA public TO nautilo_agent"),
    );
    expect(sql).toContain("users_public");
    expect(sql).toContain("REVOKE ALL ON TABLE public.%I FROM nautilo_agent");
    expect(sql.indexOf(crypto)).toBeGreaterThan(sql.indexOf(agent));
    expect(sql).toContain(
      "REVOKE ALL ON TABLE public.background_crypto_authorization_requests FROM PUBLIC, nautilo, nautilo_agent",
    );
    expect(sql).toContain(
      "REVOKE ALL ON TABLE public.background_crypto_authorization_namespace_requirements FROM PUBLIC, nautilo, nautilo_agent",
    );
  });

  test("probe SQL is read-only and targets ownership + essential select", () => {
    expect(PROBE_PUBLIC_OBJECTS_NOT_OWNED_SQL).toContain("count(*)::text");
    expect(PROBE_PUBLIC_OBJECTS_NOT_OWNED_SQL).toContain(
      "'r', 'p', 'S', 'v', 'm', 'f'",
    );
    expect(PROBE_PUBLIC_OBJECTS_NOT_OWNED_SQL).not.toContain("ALTER ");
    expect(PROBE_PUBLIC_OBJECTS_NOT_OWNED_SQL).not.toContain("GRANT ");

    expect(PROBE_NAUTILO_ESSENTIAL_SELECT_SQL).toContain(
      NAUTILO_ESSENTIAL_SELECT_TABLE,
    );
    expect(PROBE_NAUTILO_ESSENTIAL_SELECT_SQL).toContain(
      `'${NAUTILO_APP_ROLE}'`,
    );
    expect(PROBE_NAUTILO_ESSENTIAL_SELECT_SQL).toContain("'skip'");
    expect(PROBE_NAUTILO_ESSENTIAL_SELECT_SQL).toContain("'missing'");
    expect(PROBE_NAUTILO_ESSENTIAL_SELECT_SQL).not.toContain("ALTER ");
  });
});
