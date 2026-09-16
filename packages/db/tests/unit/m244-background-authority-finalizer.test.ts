import { describe, expect, test } from "bun:test";

import {
  M244_BACKGROUND_AUTHORITY_SETS_MARKER,
  finalizeM244BackgroundAuthoritySetsMigration,
} from "../../scripts/finalize-m244-background-authority-sets";

describe("M244 generated migration authority finalizer", () => {
  test("adds exact forced-RLS and least-privilege authority once", () => {
    const generated = [
      'CREATE TABLE "background_crypto_authorization_domain_requirements" ("request_id" text);',
      'CREATE TABLE "background_crypto_authorization_namespace_requirements" ("request_id" text);',
      "",
    ].join("\n");
    const once = finalizeM244BackgroundAuthoritySetsMigration(generated);

    expect(finalizeM244BackgroundAuthoritySetsMigration(once)).toBe(once);
    expect(once.match(
      new RegExp(M244_BACKGROUND_AUTHORITY_SETS_MARKER, "g"),
    )).toHaveLength(1);
    for (const table of [
      "background_crypto_authorization_domain_requirements",
      "background_crypto_authorization_namespace_requirements",
    ]) {
      expect(once).toMatch(
        new RegExp(`ALTER TABLE "${table}"\\s+FORCE ROW LEVEL SECURITY`),
      );
      expect(once).toContain(`"${table}"`);
    }
    expect(once).toContain(
      'FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto"',
    );
    expect(once).toMatch(
      /GRANT SELECT, INSERT, DELETE ON TABLE[\s\S]+TO "nautilo_crypto"/,
    );
    expect(once).not.toMatch(/GRANT [^;]*UPDATE/);
  });

  test("refuses a partial authority-set generation", () => {
    expect(() =>
      finalizeM244BackgroundAuthoritySetsMigration(
        'CREATE TABLE "background_crypto_authorization_domain_requirements" ("request_id" text);',
      )
    ).toThrow("partial M244 authority-set finalization");
  });
});
