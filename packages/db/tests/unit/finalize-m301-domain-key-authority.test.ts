import { describe, expect, test } from "bun:test";

import {
  M301_DOMAIN_KEY_AUTHORITY_MARKER,
  finalizeM301DomainKeyAuthorityMigration,
} from "../../scripts/finalize-m301-domain-key-authority.ts";
import { DOMAIN_KEY_AUTHORITY_TABLE_NAMES } from "../../src/schema/domain-key-authority.ts";

function generatedTables(): string {
  return DOMAIN_KEY_AUTHORITY_TABLE_NAMES
    .map((table) => `CREATE TABLE "${table}" ();`)
    .join("\n");
}

describe("M301 migration finalizer", () => {
  test("adds the exact authority block once", () => {
    const finalized = finalizeM301DomainKeyAuthorityMigration(generatedTables());
    expect(finalized).toContain(M301_DOMAIN_KEY_AUTHORITY_MARKER);
    expect(finalizeM301DomainKeyAuthorityMigration(finalized)).toBe(finalized);
    expect(finalized).toContain("FORCE ROW LEVEL SECURITY");
    expect(finalized).toContain("protect_domain_key_request");
    expect(finalized).toContain("validate_domain_key_envelope");
  });

  test("refuses a partial generated family", () => {
    expect(() => finalizeM301DomainKeyAuthorityMigration(
      'CREATE TABLE "domain_key_heads" ();',
    )).toThrow("generation is incomplete");
  });

  test("ignores unrelated migrations", () => {
    const migration = 'CREATE TABLE "unrelated" ();\n';
    expect(finalizeM301DomainKeyAuthorityMigration(migration)).toBe(migration);
  });
});
