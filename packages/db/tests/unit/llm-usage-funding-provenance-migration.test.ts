import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const migrationPath = join(
  import.meta.dir,
  "../../src/migrations/0307_goofy_puck.sql",
);

describe("LLM usage funding provenance migration", () => {
  test("adds forward-only non-secret provenance without classifying legacy rows", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain('ADD COLUMN "funding_kind" varchar(16)');
    expect(migration).toContain('ADD COLUMN "payer_human_id" uuid');
    expect(migration).toContain('ADD COLUMN "provider_route" text');
    expect(migration).toContain('ADD COLUMN "credential_id" uuid');
    expect(migration).toContain('ADD COLUMN "credential_revision" integer');
    expect(migration).toContain("funding_kind\" = 'personal'");
    expect(migration).toContain("funding_kind\" IN ('server', 'service')");
    expect(migration).not.toMatch(/UPDATE\s+"llm_usage_events"/i);
    expect(migration).not.toMatch(/api[_ -]?key|ciphertext|secret/i);
  });
});
