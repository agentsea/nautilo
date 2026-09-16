import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  finalizeM275HistoryReadObservationsMigration,
  M275_HISTORY_READ_OBSERVATIONS_MARKER,
} from "../../scripts/finalize-m275-history-read-observations";

const GENERATED = `CREATE TABLE "encryption_transition_history_read_admissions" ();
`;

describe("M275 generated history-read observation finalizer", () => {
  test("is present in the canonical generated migration", () => {
    const migration = readFileSync(
      resolve(import.meta.dir, "../../src/migrations/0201_productive_wonder_man.sql"),
      "utf8",
    );
    expect(migration).toContain(
      'CREATE TABLE "encryption_transition_history_read_admissions"',
    );
    expect(migration).toContain(M275_HISTORY_READ_OBSERVATIONS_MARKER);
    expect(migration).toContain(
      'ALTER TABLE "encryption_transition_history_read_admissions" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'CREATE TRIGGER "encryption_transition_history_read_admissions_monotonic"',
    );
    expect(migration).toContain(
      '"encryption_transition_outcome_totals"."operation" <> \'read\'',
    );
    expect(migration).toContain("'current_read_authority_unavailable'");
    expect(migration).toContain("'live_shadow_lifecycle_unavailable'");
  });

  test("forces product-only access and is idempotent", () => {
    const once = finalizeM275HistoryReadObservationsMigration(GENERATED);
    expect(finalizeM275HistoryReadObservationsMigration(once)).toBe(once);
    expect(once).toContain(M275_HISTORY_READ_OBSERVATIONS_MARKER);
    expect(once).toContain(
      'ALTER TABLE "encryption_transition_history_read_admissions" FORCE ROW LEVEL SECURITY',
    );
    expect(once).toContain('FROM PUBLIC, "nautilo_agent", "nautilo_crypto"');
    expect(once).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "encryption_transition_history_read_admissions"',
    );
    expect(once).not.toMatch(/GRANT [^;]+TO "nautilo_agent"/u);
    expect(once).not.toMatch(/GRANT [^;]+TO "nautilo_crypto"/u);
  });

  test("permits only token rotation while planned and one terminal transition", () => {
    const finalized = finalizeM275HistoryReadObservationsMigration(GENERATED);
    expect(finalized).toContain(
      "planned history-read admission may rotate only its token",
    );
    expect(finalized).toContain("OLD.state IN ('consumed', 'expired')");
    expect(finalized).toContain("terminal history-read admission is immutable");
    expect(finalized).toContain("NEW.state NOT IN ('consumed', 'expired')");
    expect(finalized).toContain(
      'CREATE TRIGGER "encryption_transition_history_read_admissions_monotonic"',
    );
    expect(finalized).toContain(
      'REVOKE ALL ON FUNCTION "public"."protect_encryption_transition_history_read_admission"()',
    );
  });

  test("ignores unrelated generation", () => {
    const unrelated = 'CREATE TABLE "some_other_table" ();\n';
    expect(finalizeM275HistoryReadObservationsMigration(unrelated))
      .toBe(unrelated);
  });
});
