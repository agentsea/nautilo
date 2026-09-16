import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("infra/postgres-init.sh shape (M116)", () => {
  const path = resolve(__dirname, "../../../../infra/postgres-init.sh");
  const content = readFileSync(path, "utf8");

  test("has ALTER ROLE nautilo BYPASSRLS (M116 §2)", () => {
    expect(content).toContain("ALTER ROLE nautilo BYPASSRLS");
  });

  test("pre-installs vector extension when available, gated by pg_available_extensions (M116 §1)", () => {
    // Plain CREATE EXTENSION must NOT appear unguarded — the same script is
    // mounted on the Logto cluster (postgres:16, no pgvector) and would
    // exit non-zero. Availability check + conditional install is required.
    expect(content).toMatch(
      /pg_available_extensions[\s\S]+CREATE EXTENSION IF NOT EXISTS vector/,
    );
  });

  test("ALTER DEFAULT PRIVILEGES for nautilo on TABLES + SEQUENCES", () => {
    expect(content).toMatch(
      /ALTER DEFAULT PRIVILEGES FOR ROLE nautilo IN SCHEMA public[\s\S]+ON TABLES TO nautilo_agent/,
    );
    expect(content).toMatch(
      /ALTER DEFAULT PRIVILEGES FOR ROLE nautilo IN SCHEMA public[\s\S]+ON SEQUENCES TO nautilo_agent/,
    );
  });

  test("requires NAUTILO_DB_PASSWORD / LOGTO_DB_PASSWORD / NAUTILO_AGENT_DB_PASSWORD with no defaults", () => {
    expect(content).toContain("${NAUTILO_DB_PASSWORD:?");
    expect(content).toContain("${LOGTO_DB_PASSWORD:?");
    expect(content).toContain("${NAUTILO_AGENT_DB_PASSWORD:?");
  });

  test("provisions nautilo_crypto only for an explicitly selected app cluster", () => {
    expect(content).toContain("${NAUTILO_POSTGRES_CLUSTER_KIND:?");
    expect(content).toContain('if [[ "$NAUTILO_POSTGRES_CLUSTER_KIND" == "app" ]]');
    expect(content).toMatch(
      /CREATE ROLE nautilo_crypto LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/,
    );
    expect(content).toContain("\\getenv crypto_password NAUTILO_CRYPTO_DB_PASSWORD");
    expect(content).toContain(
      "SELECT set_config('nautilo.crypto_role_password', $1, true)",
    );
    expect(content).toContain("\\bind :crypto_password");
    expect(content).not.toContain("\\bind :'crypto_password'");
    expect(content).not.toContain(
      "PASSWORD '${NAUTILO_CRYPTO_DB_PASSWORD",
    );
  });
});
