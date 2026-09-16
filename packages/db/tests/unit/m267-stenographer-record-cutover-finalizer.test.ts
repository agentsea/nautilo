import { describe, expect, test } from "bun:test";

import packageJson from "../../package.json";
import {
  finalizeM267StenographerRecordCutoverMigration,
  M267_STENOGRAPHER_RECORD_CUTOVER_MARKER,
} from "../../scripts/finalize-m267-stenographer-record-cutover";

describe("M267 Stenographer Record cutover finalizer", () => {
  test("is idempotent and runs only for the generated cutover table", () => {
    const generated = 'CREATE TABLE "room_journal_record_cutover" ();\n';
    const once = finalizeM267StenographerRecordCutoverMigration(generated);
    expect(once).toContain(M267_STENOGRAPHER_RECORD_CUTOVER_MARKER);
    expect(finalizeM267StenographerRecordCutoverMigration(once)).toBe(once);
    expect(finalizeM267StenographerRecordCutoverMigration("SELECT 1;"))
      .toBe("SELECT 1;");
  });

  test("serializes first native publication and rejects old writers afterward", () => {
    const finalized = finalizeM267StenographerRecordCutoverMigration(
      'CREATE TABLE "room_journal_record_cutover" ();\n',
    );
    expect(finalized).toContain("pg_advisory_xact_lock(267, 1)");
    expect(finalized).toContain("nautilo.stenographer_writer_version");
    expect(finalized).toContain("Legacy Stenographer writer rejected");
    expect(finalized).toContain("Legacy Stenographer event mutation rejected");
    expect(finalized).toContain("Stenographer Record cutover is forward-only");
    expect(finalized).toContain("IF TG_OP = 'DELETE' THEN\n    RETURN OLD;");
    expect(finalized).toContain(
      'BEFORE UPDATE OF "status", "observation_publication_version"',
    );
  });

  test("keeps security and conversion initialization in the canonical generator", () => {
    const finalized = finalizeM267StenographerRecordCutoverMigration(
      'CREATE TABLE "room_journal_record_cutover" ();\n',
    );
    expect(finalized).toContain(
      'ALTER TABLE "room_journal_record_cutover" FORCE ROW LEVEL SECURITY',
    );
    expect(finalized).toContain(
      'REVOKE ALL ON TABLE "room_journal_record_cutover" FROM PUBLIC, "nautilo_agent", "nautilo_crypto"',
    );
    expect(finalized).toContain(
      'SET "record_conversion_status" = \'pending\'',
    );
    expect(finalized).toContain(
      'ALTER TABLE "room_journal_record_rebuild_retirements" FORCE ROW LEVEL SECURITY',
    );
    expect(finalized).toContain(
      'CREATE TRIGGER "room_journal_record_rebuild_lifecycle"',
    );
    expect(finalized).toContain("SET lifecycle = 'stale'");
    expect(finalized).toContain("SET lifecycle = 'sunset'");
    expect(packageJson.scripts["db:generate"]?.split(" && ")).toContain(
      "bun scripts/finalize-m267-stenographer-record-cutover.ts",
    );
  });
});
