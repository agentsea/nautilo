import { describe, expect, test } from "bun:test";

import packageJson from "../../package.json";
import {
  M241_BACKGROUND_AUTHORITY_MARKER,
  M241_JOURNAL_PUBLICATION_AUTHORITY_MARKER,
  finalizeM241BackgroundAuthorizationMigration,
} from "../../scripts/finalize-m241-background-authorization";

describe("M241 generated migration authority finalizer", () => {
  test("appends exact crypto and product-receipt authority once", () => {
    const generated = [
      'CREATE TABLE "background_crypto_authorization_requests" ("request_id" text PRIMARY KEY);',
      'CREATE TABLE "processor_crypto_signer_authorizations" ("authorization_id" text PRIMARY KEY);',
      'CREATE TABLE "room_journal_crypto_publications" ("publication_id" text PRIMARY KEY);',
      "",
    ].join("\n");
    const once = finalizeM241BackgroundAuthorizationMigration(generated);

    expect(finalizeM241BackgroundAuthorizationMigration(once)).toBe(once);
    expect(once.match(
      new RegExp(M241_BACKGROUND_AUTHORITY_MARKER, "g"),
    )).toHaveLength(1);
    expect(once.match(
      new RegExp(M241_JOURNAL_PUBLICATION_AUTHORITY_MARKER, "g"),
    )).toHaveLength(1);
    for (const table of [
      "background_crypto_authorization_requests",
      "processor_crypto_signer_authorizations",
    ]) {
      expect(once).toMatch(
        new RegExp(
          `ALTER TABLE "${table}"\\s+FORCE ROW LEVEL SECURITY`,
        ),
      );
    }
    expect(once).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE\s+"background_crypto_authorization_requests"/,
    );
    expect(once).toMatch(
      /GRANT SELECT, INSERT ON TABLE\s+"processor_crypto_signer_authorizations"/,
    );
    expect(once).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE "room_journal_crypto_publications"',
    );
    expect(once).toContain('FROM PUBLIC, "nautilo_agent", "nautilo_crypto"');
    expect(once).not.toContain(
      'GRANT SELECT ON TABLE "room_journal_crypto_publications"',
    );
  });

  test("refuses partial generation of the paired crypto authority tables", () => {
    expect(() =>
      finalizeM241BackgroundAuthorizationMigration(
        'CREATE TABLE "background_crypto_authorization_requests" ("request_id" text);',
      )
    ).toThrow("partial M241 crypto authority");
  });

  test("keeps the finalizer in the canonical generate-only command", () => {
    expect(packageJson.scripts["db:generate"]?.split(" && ")).toEqual([
      "NAUTILO_DRIZZLE_OFFLINE=1 drizzle-kit generate",
      "bun scripts/finalize-task-crypto-lifecycle.ts",
      "bun scripts/finalize-crypto-delivery-migration.ts",
      "bun scripts/finalize-m237-message-crypto-lifecycle.ts",
      "bun scripts/finalize-m241-background-authorization.ts",
      "bun scripts/finalize-m244-background-authority-sets.ts",
      "bun scripts/finalize-m243-memory-crypto-lifecycle.ts",
      "bun scripts/finalize-m257-reflection-records.ts",
      "bun scripts/finalize-m258-reflection-authority.ts",
      "bun scripts/finalize-m327-reflection-replay-authority.ts",
      "bun scripts/finalize-m261-artifact-crypto-lifecycle.ts",
      "bun scripts/finalize-m264-reflection-search.ts",
      "bun scripts/finalize-m267-stenographer-record-cutover.ts",
      "bun scripts/finalize-m271-reflection-semantic-work.ts",
      "bun scripts/finalize-m274-encryption-transition.ts",
      "bun scripts/finalize-m279-reflection-convergence.ts",
      "bun scripts/finalize-m282-live-shadow-encryption.ts",
      "bun scripts/finalize-m301-domain-key-authority.ts",
      "bun scripts/finalize-m304-human-device-membership.ts",
      "bun scripts/finalize-m275-history-read-observations.ts",
      "bun scripts/finalize-m295-human-peer-shadow-encryption.ts",
      "bun scripts/finalize-m296-shared-agent-shadow-encryption.ts",
      "bun scripts/finalize-m298-runtime-foreground-authority.ts",
      "bun scripts/finalize-m299-runtime-conductor.ts",
      "bun scripts/finalize-m313-message-backfill.ts",
      "bun scripts/finalize-m313-message-reservation.ts",
      "bun scripts/finalize-m313-tool-context.ts",
      "bun scripts/finalize-m313-repair-source.ts",
      "bun scripts/finalize-m314-public-room-message-authority.ts",
      "bun scripts/finalize-event-feed.ts",
      "bun scripts/finalize-content-access-operations.ts",
    ]);
  });
});
