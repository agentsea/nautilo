import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { buildFullLegacyRoleRepairSql } from "@nautilo/db";
import { buildRestoreOwnershipAndGrantsSql } from "../../src/lib/docker-db";

const DOCKER_DB_SOURCE = join(import.meta.dir, "../../src/lib/docker-db.ts");

describe("docker-db legacy repair integration", () => {
  test("restore repair uses canonical full legacy role repair SQL", () => {
    const source = readFileSync(DOCKER_DB_SOURCE, "utf8");
    expect(source).toContain('import { buildFullLegacyRoleRepairSql } from "@nautilo/db"');
    expect(source).not.toContain("buildAgentRoleGrantsSql");
    expect(source).toContain("buildRestoreOwnershipAndGrantsSql()");
    expect(source).toContain("Repairing DB ownership and app-role grants");
  });

  test("restore repair adopts an imported Drizzle migration ledger for the migration role", () => {
    const sql = buildRestoreOwnershipAndGrantsSql();
    expect(sql).toContain(buildFullLegacyRoleRepairSql());
    expect(sql).toContain("ALTER SCHEMA drizzle OWNER TO nautilo");
    expect(sql).toContain("GRANT USAGE, CREATE ON SCHEMA drizzle TO nautilo");
    expect(sql).toContain("ALTER TABLE drizzle.__drizzle_migrations OWNER TO nautilo");
    expect(sql).toContain(
      "GRANT ALL PRIVILEGES ON TABLE drizzle.__drizzle_migrations TO nautilo",
    );
    expect(sql).toContain("to_regclass('drizzle.__drizzle_migrations')");
    expect(sql).not.toMatch(/\bDROP\b/i);
  });

  test("post-restore integrity covers the Drizzle schema and migration ledger owners", () => {
    const source = readFileSync(DOCKER_DB_SOURCE, "utf8");
    expect(source).toContain("'drizzle_schema_owner'");
    expect(source).toContain("'drizzle_migrations_owner'");
  });

  test("canonical repair SQL is a single idempotent block suitable for restore", () => {
    const sql = buildFullLegacyRoleRepairSql();
    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(sql).toContain("ALTER TABLE public.%I OWNER TO nautilo");
    expect(sql).toContain("GRANT USAGE ON SCHEMA public TO nautilo_agent");
    expect(sql).not.toMatch(/\bDROP\b/i);
  });
});
