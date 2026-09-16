import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("Namespace bootstrap delivery storage", () => {
  test("generated migration admits only the new operation kind and reuses binding-candidate messages", () => {
    const schema = readFileSync(new URL("../../src/schema/crypto-storage.ts", import.meta.url), "utf8");
    const migration = readFileSync(new URL(
      "../../src/migrations/0158_daily_thunderbolt_ross.sql", import.meta.url,
    ), "utf8");
    expect(schema).toContain("'domain_rebootstrap', 'namespace_bootstrap'");
    expect(schema).toContain("'binding_candidate', 'recovery_archive'");
    expect(migration).toContain('DROP CONSTRAINT "crypto_delivery_operations_kind"');
    expect(migration).toContain("'domain_rebootstrap', 'namespace_bootstrap'");
    expect(migration).not.toContain("crypto_delivery_messages");
    expect(migration).not.toContain("provider_state");
  });
});
