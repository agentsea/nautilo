import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import journal from "../../src/migrations/meta/_journal.json";
import packageJson from "../../package.json";
import {
  MEDIA_FUNDING_BINDING_IMMUTABILITY_MARKER,
  finalizeMediaFundingBindingMigration,
} from "../../scripts/finalize-media-funding-binding";

const placeholder = "-- Custom SQL migration file, put your code below! --";

describe("media generation funding binding migration", () => {
  test("keeps the SQL-only guard behind the dedicated generated-custom command", () => {
    expect(packageJson.scripts["db:generate:media-funding-binding-immutability"]).toBe(
      "NAUTILO_DRIZZLE_OFFLINE=1 drizzle-kit generate --custom --name media_generation_funding_binding_immutability && bun scripts/finalize-media-funding-binding.ts",
    );
  });

  test("finalizes only a fresh custom migration and is idempotent", () => {
    expect(() => finalizeMediaFundingBindingMigration("SELECT 1;"))
      .toThrow("fresh Drizzle-generated custom migration");
    const finalized = finalizeMediaFundingBindingMigration(placeholder);
    expect(finalized.startsWith(MEDIA_FUNDING_BINDING_IMMUTABILITY_MARKER)).toBe(true);
    expect(finalizeMediaFundingBindingMigration(finalized)).toBe(finalized);
  });

  test("checks the generated migration that actually runs in the database", () => {
    const entry = journal.entries.find((row) => row.tag.endsWith("_media_generation_funding_binding_immutability"));
    expect(entry).toBeDefined();
    const source = readFileSync(new URL(`../../src/migrations/${entry!.tag}.sql`, import.meta.url), "utf8");
    expect(source).toBe(finalizeMediaFundingBindingMigration(placeholder));
  });

  test("pins only the creating-account binding with a closed trigger function", () => {
    const finalized = finalizeMediaFundingBindingMigration(placeholder);
    expect(finalized).toContain(
      'CREATE OR REPLACE FUNCTION "public"."guard_media_generation_funding_binding"()',
    );
    expect(finalized).toContain("LANGUAGE plpgsql\nSECURITY INVOKER\nSET search_path = pg_catalog");
    expect(finalized).toContain(
      "NEW.funding_binding IS DISTINCT FROM OLD.funding_binding",
    );
    expect(finalized).toContain("USING ERRCODE = '23514'");
    expect(finalized).toContain(
      'BEFORE UPDATE OF "funding_binding" ON "media_generations"',
    );
    expect(finalized).toContain(
      'FROM PUBLIC, "nautilo_agent", "nautilo_crypto"',
    );
    expect(finalized).not.toContain("media_generation_authority_and_lifecycle_guard");
    expect(finalized).not.toMatch(/DROP|DISABLE|BYPASSRLS|GRANT ALL/u);
  });
});
