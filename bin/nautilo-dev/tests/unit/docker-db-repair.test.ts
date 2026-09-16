import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { buildFullLegacyRoleRepairSql } from "@nautilo/db";

const DOCKER_DB_SOURCE = join(import.meta.dir, "../../src/lib/docker-db.ts");

describe("docker-db legacy repair integration", () => {
  test("restore repair uses canonical full legacy role repair SQL", () => {
    const source = readFileSync(DOCKER_DB_SOURCE, "utf8");
    expect(source).toContain('import { buildFullLegacyRoleRepairSql } from "@nautilo/db"');
    expect(source).not.toContain("buildAgentRoleGrantsSql");
    expect(source).toContain("buildFullLegacyRoleRepairSql()");
    expect(source).toContain("Repairing DB ownership and app-role grants");
  });

  test("canonical repair SQL is a single idempotent block suitable for restore", () => {
    const sql = buildFullLegacyRoleRepairSql();
    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(sql).toContain("ALTER TABLE public.%I OWNER TO nautilo");
    expect(sql).toContain("GRANT USAGE ON SCHEMA public TO nautilo_agent");
    expect(sql).not.toMatch(/\bDROP\b/i);
  });
});
