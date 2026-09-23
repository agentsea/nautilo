import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrations = resolve(import.meta.dir, "../../src/migrations");
const sql = readFileSync(resolve(migrations, "0299_mushy_jasper_sitwell.sql"), "utf8");

describe("generated protected Task persistence migration", () => {
  test("is additive for existing Plain rows and installs exact mappings", () => {
    expect(sql).not.toContain('ALTER COLUMN "prompt" DROP NOT NULL');
    expect(sql).toContain('"content_representation" text DEFAULT \'ordinary\' NOT NULL');
    expect(sql).toContain('"result_representation" text DEFAULT \'ordinary\' NOT NULL');
    expect(sql.match(/"representation" text NOT NULL/g)).toHaveLength(2);
    expect(sql).not.toContain('"representation" text DEFAULT \'ordinary\'');
    expect(sql).toContain('CONSTRAINT "tasks_current_crypto_revision_fk"');
    expect(sql).toContain('CONSTRAINT "task_runs_current_crypto_result_revision_fk"');
    expect(sql).toContain("crypto_access_revision\" = 0");
    expect(sql).toContain('"operational_metadata" jsonb DEFAULT \'{}\'::jsonb NOT NULL');
    expect(sql).toContain('and "tasks"."last_error" is null');
    expect(sql).toContain("NEW.operational_metadata");
    expect(sql).toContain("OLD.operational_metadata");
    expect(sql).toContain('ALTER TABLE "task_definition_crypto_revisions" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "task_run_result_crypto_revisions" FORCE ROW LEVEL SECURITY');
    expect(sql).not.toMatch(/CREATE TABLE "task_crypto_operations"/);
  });
});
