import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PERSONAL_PROVIDER_IDS } from "../../src";

const migrationPath = join(
  import.meta.dir,
  "../../src/migrations/0305_personal_provider_credentials.sql",
);
const providerExpansionMigrationPath = join(
  import.meta.dir,
  "../../src/migrations/0312_salty_robin_chapel.sql",
);

describe("personal provider credential migration", () => {
  test("creates one encrypted current record per Human and provider", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain('CREATE TABLE "personal_provider_credentials"');
    expect(migration).toContain('"id" uuid PRIMARY KEY NOT NULL');
    expect(migration).toContain('"user_id" uuid NOT NULL');
    expect(migration).toContain('"revision" integer NOT NULL');
    expect(migration).toContain('"format_version" integer NOT NULL');
    expect(migration).toContain('"key_id" uuid NOT NULL');
    expect(migration).toContain('"nonce_base64" text NOT NULL');
    expect(migration).toContain('"ciphertext_base64" text NOT NULL');
    expect(migration).toContain('"auth_tag_base64" text NOT NULL');
    expect(migration).toContain("ON DELETE cascade");
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "uq_personal_provider_credentials_user_provider"',
    );
    expect(migration).not.toMatch(/plaintext|api_key|secret_value/i);
  });

  test("denies untrusted roles and grants only product DML", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE "personal_provider_credentials"',
    );
    expect(migration).toContain(
      'FROM PUBLIC, "nautilo_agent", "nautilo_crypto"',
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "personal_provider_credentials"',
    );
    expect(migration).toContain('TO "nautilo"');
    expect(migration).not.toMatch(/GRANT[^;]+TO\s+(?:PUBLIC|"nautilo_agent"|"nautilo_crypto")/i);
  });

  test("expands the provider check for every canonical server key and retained chat provider", async () => {
    const migration = await readFile(providerExpansionMigrationPath, "utf8");
    expect(migration).toContain(
      'DROP CONSTRAINT "personal_provider_credentials_provider_check"',
    );
    // Applied migrations retain their original provider set.
    for (const provider of PERSONAL_PROVIDER_IDS.filter((id) => id !== "surplus")) {
      expect(migration).toContain(`'${provider}'`);
    }
  });

  test("adds marketplace credentials and endpoint binding without rewriting encrypted history", async () => {
    const migration = await readFile(join(import.meta.dir, "../../src/migrations/0318_wakeful_energizer.sql"), "utf8");
    for (const provider of PERSONAL_PROVIDER_IDS) expect(migration).toContain(`'${provider}'`);
    expect(migration).toContain('ADD COLUMN "destination" text');
    expect(migration).toContain('ADD COLUMN "receipt_read_status" varchar(16) DEFAULT \'unknown\' NOT NULL');
    expect(migration).not.toMatch(/UPDATE\s+"personal_provider_credentials"|DROP TABLE/i);
  });
});
