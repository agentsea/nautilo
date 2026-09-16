import { describe, expect, test } from "bun:test";
import {
  CRYPTO_IDENTITY_READ_COLUMNS,
  buildCryptoRoleReconcilePsqlScript,
  buildCryptoTablePrivilegeReconcileSql,
  CRYPTO_DB_PASSWORD_ENV_KEY,
  CRYPTO_DB_ROLE,
  CRYPTO_DB_ROLE_ATTRIBUTES,
} from "../../src/utils/crypto-role-contract";
import { CRYPTO_STORAGE_TABLE_PRIVILEGES } from "../../src/schema/crypto-storage";

describe("M231 nautilo_crypto role contract", () => {
  test("freezes the canonical role, secret, and least-privilege attributes", () => {
    expect(CRYPTO_DB_ROLE).toBe("nautilo_crypto");
    expect(CRYPTO_DB_PASSWORD_ENV_KEY).toBe("NAUTILO_CRYPTO_DB_PASSWORD");
    expect(CRYPTO_DB_ROLE_ATTRIBUTES).toEqual([
      "NOSUPERUSER",
      "NOCREATEDB",
      "NOCREATEROLE",
      "NOINHERIT",
      "NOREPLICATION",
      "NOBYPASSRLS",
    ]);
  });

  test("creates or repairs the role with exact attributes and app-database CONNECT only", () => {
    const script = buildCryptoRoleReconcilePsqlScript();

    for (const attribute of CRYPTO_DB_ROLE_ATTRIBUTES) {
      expect(script).toContain(attribute);
    }
    expect(script).toContain("CREATE ROLE nautilo_crypto");
    expect(script).toContain("ALTER ROLE nautilo_crypto");
    expect(script).toContain("REVOKE ALL ON DATABASE nautilo FROM nautilo_crypto");
    expect(script).toContain("GRANT CONNECT ON DATABASE nautilo TO nautilo_crypto");
    expect(script).toContain("REVOKE ALL ON DATABASE logto_nautilo FROM nautilo_crypto");
  });

  test("reads the credential inside psql and binds it instead of embedding it in SQL or argv", () => {
    const script = buildCryptoRoleReconcilePsqlScript();

    expect(script).toContain("\\getenv crypto_password NAUTILO_CRYPTO_DB_PASSWORD");
    expect(script).toContain("SELECT set_config('nautilo.crypto_role_password', $1, true)");
    expect(script).toContain("\\bind :crypto_password");
    expect(script).not.toContain("\\bind :'crypto_password'");
    expect(script).not.toMatch(/PASSWORD ['"][^%]/);
  });

  test("fails closed for a missing credential and verifies the repaired attributes", () => {
    const script = buildCryptoRoleReconcilePsqlScript();

    expect(script).toContain("\\if :{?crypto_password}");
    expect(script).toContain("\\quit");
    expect(script).toContain("rolsuper");
    expect(script).toContain("rolcreatedb");
    expect(script).toContain("rolcreaterole");
    expect(script).toContain("rolinherit");
    expect(script).toContain("rolreplication");
    expect(script).toContain("rolbypassrls");
    expect(script).toContain("has_database_privilege");
    expect(script).toContain("pg_auth_members");
    expect(script).toContain("REVOKE %I FROM nautilo_crypto");
    expect(script).toContain("RAISE EXCEPTION");
  });

  test("supports stdin-only repair from a restored host credential", () => {
    const script = buildCryptoRoleReconcilePsqlScript({
      password: "restore-'credential",
    });
    expect(script).toContain("\\set crypto_password 'restore-''credential'");
    expect(script).not.toContain("\\getenv crypto_password");
  });

  test("builds exact table grants plus agent/PUBLIC denial without broad wildcards", () => {
    const sql = buildCryptoTablePrivilegeReconcileSql({
      tablePrivileges: {
        crypto_domains: ["SELECT", "INSERT"],
        namespace_crypto_heads: ["SELECT", "INSERT", "UPDATE"],
        agent_crypto_runtime_challenges: [
          "SELECT",
          "INSERT",
          "UPDATE",
          "DELETE",
        ],
      },
      readColumns: {
        users: ["id"],
        actors: ["id", "owner_id", "kind"],
      },
      sequences: ["crypto_domains_id_seq"],
    });
    expect(sql).toContain("GRANT USAGE ON SCHEMA public TO nautilo_crypto");
    expect(sql).toContain(
      "REVOKE ALL ON TABLE public.crypto_domains FROM PUBLIC, nautilo_agent",
    );
    expect(sql).toContain(
      "GRANT SELECT, INSERT ON TABLE public.crypto_domains TO nautilo_crypto",
    );
    expect(sql).toContain(
      "GRANT SELECT, INSERT, UPDATE ON TABLE public.namespace_crypto_heads TO nautilo_crypto",
    );
    expect(sql).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_crypto_runtime_challenges TO nautilo_crypto",
    );
    expect(sql).not.toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crypto_domains",
    );
    expect(sql).toContain(
      "REVOKE ALL ON SEQUENCE public.crypto_domains_id_seq FROM PUBLIC, nautilo_agent",
    );
    expect(sql).not.toContain("ALL TABLES IN SCHEMA");
    expect(sql).not.toContain("ALL SEQUENCES IN SCHEMA");
    expect(sql).toContain(
      "GRANT SELECT (id) ON TABLE public.users TO nautilo_crypto",
    );
    expect(sql).toContain(
      "GRANT SELECT (id, owner_id, kind) ON TABLE public.actors TO nautilo_crypto",
    );
    expect(sql).toContain("information_schema.role_column_grants");
    expect(sql).toContain("REVOKE %s (%I) ON TABLE %I.%I FROM nautilo_crypto");
    expect(sql).toContain(
      "IF to_regclass('public.crypto_domains') IS NOT NULL THEN",
    );
    expect(sql).toContain(
      "IF to_regclass('public.crypto_domains_id_seq') IS NOT NULL THEN",
    );
  });

  test("refuses implicit, empty, duplicate, or readless table privilege maps", () => {
    expect(() =>
      buildCryptoTablePrivilegeReconcileSql({ tablePrivileges: {} }),
    ).toThrow("must not be empty");
    expect(() =>
      buildCryptoTablePrivilegeReconcileSql({
        tablePrivileges: { crypto_domains: [] },
      }),
    ).toThrow("list must not be empty");
    expect(() =>
      buildCryptoTablePrivilegeReconcileSql({
        tablePrivileges: { crypto_domains: ["SELECT", "SELECT"] },
      }),
    ).toThrow("duplicate");
    expect(() =>
      buildCryptoTablePrivilegeReconcileSql({
        tablePrivileges: { crypto_domains: ["INSERT"] },
      }),
    ).toThrow("must grant SELECT");
    expect(() =>
      buildCryptoTablePrivilegeReconcileSql({
        tablePrivileges: { crypto_domains: ["SELECT"] },
        readColumns: { users: [] },
      }),
    ).toThrow("column read list must not be empty");
    expect(() =>
      buildCryptoTablePrivilegeReconcileSql({
        tablePrivileges: { crypto_domains: ["SELECT"] },
        readColumns: { actors: ["id", "id"] },
      }),
    ).toThrow("duplicate crypto column read");
  });

  test("canonical grant repair enumerates every crypto table and preserves exact product denials", () => {
    const sql = buildCryptoTablePrivilegeReconcileSql({
      tablePrivileges: CRYPTO_STORAGE_TABLE_PRIVILEGES,
      readColumns: CRYPTO_IDENTITY_READ_COLUMNS,
    });
    for (const [table, privileges] of Object.entries(
      CRYPTO_STORAGE_TABLE_PRIVILEGES,
    )) {
      const deniedRoles = [
        "background_crypto_authorization_requests",
        "background_crypto_authorization_domain_requirements",
        "background_crypto_authorization_namespace_requirements",
        "processor_crypto_signer_authorizations",
      ].includes(table)
        ? "PUBLIC, nautilo, nautilo_agent"
        : "PUBLIC, nautilo_agent";
      expect(sql).toContain(
        `REVOKE ALL ON TABLE public.${table} FROM ${deniedRoles}`,
      );
      expect(sql).toContain(
        `GRANT ${privileges.join(", ")} ON TABLE public.${table} TO nautilo_crypto`,
      );
    }
    expect(sql).toContain("information_schema.role_table_grants");
    expect(sql).toContain("unexpected direct table privilege");
    expect(sql).toContain("REVOKE ALL ON SCHEMA public FROM nautilo_crypto");
    expect(sql).toContain(
      "GRANT SELECT (id) ON TABLE public.users TO nautilo_crypto",
    );
    expect(sql).toContain(
      "GRANT SELECT (id, owner_id, kind) ON TABLE public.actors TO nautilo_crypto",
    );
    expect(sql).toContain(
      "GRANT SELECT (id, server_instance_id) ON TABLE public.nautilo_instance_identity TO nautilo_crypto",
    );
  });
});
