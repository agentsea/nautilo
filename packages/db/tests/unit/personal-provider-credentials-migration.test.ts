import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const migrationPath = join(
  import.meta.dir,
  "../../src/migrations/0304_sharp_dracula.sql",
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
});
