import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { replacePersonalCapabilityPreferences } from "../../src";

const migrationPath = join(import.meta.dir, "../../src/migrations/0320_uneven_juggernaut.sql");
const grantsMigrationPath = join(import.meta.dir, "../../src/migrations/0321_personal_capability_preferences_grants.sql");

describe("personal capability preference database contract", () => {
  test("creates one sparse revisioned row per Human without embedding or copied defaults", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain('CREATE TABLE "personal_capability_preferences"');
    expect(migration).toContain('"user_id" uuid PRIMARY KEY NOT NULL');
    expect(migration).toContain('"revision" integer NOT NULL');
    expect(migration).toContain('"overrides" jsonb DEFAULT \'{}\'::jsonb NOT NULL');
    expect(migration).toContain("ON DELETE cascade");
    expect(migration).not.toMatch(/embedding|default_model|genie|room/i);
  });

  test("rejects invalid revisions and overrides before opening a transaction", async () => {
    let transactions = 0;
    const db = {
      transaction: async () => { transactions += 1; throw new Error("unreachable"); },
    } as unknown as Parameters<typeof replacePersonalCapabilityPreferences>[0];
    expect(replacePersonalCapabilityPreferences(db, {
      humanId: "human-a", expectedRevision: -1, overrides: {},
    })).rejects.toThrow("non-negative safe integer");
    expect(replacePersonalCapabilityPreferences(db, {
      humanId: "human-a", expectedRevision: 0, overrides: { decision: " " },
    })).rejects.toThrow("overrides are invalid");
    expect(transactions).toBe(0);
  });

  test("keeps Human preferences behind the product role", async () => {
    const migration = await readFile(grantsMigrationPath, "utf8");
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE "personal_capability_preferences"');
    expect(migration).toContain('FROM PUBLIC, "nautilo_agent", "nautilo_crypto"');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "personal_capability_preferences"');
    expect(migration).toContain('TO "nautilo"');
  });
});
