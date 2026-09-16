import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import packageJson from "../../package.json";

const tag = "0168_dapper_spiral";
const migrations = resolve(import.meta.dir, "../../src/migrations");
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as { entries: readonly { idx: number; tag: string }[] };
const snapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0168_snapshot.json"), "utf8"),
) as { tables: Record<string, unknown>; prevId: string; id: string };

describe("M267 generated Stenographer Record cutover migration", () => {
  test("is chained before the generated lifecycle-guard correction and retains the finalizer", () => {
    const index = journal.entries.findIndex((entry) => entry.tag === tag);
    expect(journal.entries[index]).toMatchObject({ idx: 168, tag });
    expect(journal.entries[index + 1]).toMatchObject({
      idx: 169,
      tag: "0169_m267_record_lifecycle_generation_guard",
    });
    expect(snapshot.prevId).not.toBe(snapshot.id);
    expect(packageJson.scripts["db:generate"]?.split(" && ")).toContain(
      "bun scripts/finalize-m267-stenographer-record-cutover.ts",
    );
  });

  test("adds only the native projection, conversion, and cutover inventory", () => {
    expect(migration).toContain('CREATE TABLE "room_journal_record_cutover"');
    expect(migration).toContain(
      'CREATE TABLE "room_journal_record_rebuild_retirements"',
    );
    for (const column of [
      "projection_kind",
      "record_id",
      "native_attached_at",
      "observation_publication_version",
      "record_conversion_status",
      "record_conversion_cursor_sequence",
      "record_conversion_failure_count",
      "record_conversion_retry_after",
      "record_conversion_last_error_code",
    ]) expect(migration).toContain(`"${column}"`);
    expect(migration).not.toMatch(/DROP TABLE|DELETE FROM/u);
  });

  test("forbids a second semantic body on native projections", () => {
    expect(migration).toContain('"projection_kind" = \'native\'');
    expect(migration).toContain('"statement" IS NULL');
    expect(migration).toContain('"crypto_object_id" IS NULL');
    expect(migration).toContain('"record_id" = "room_events"."id"::text');
    expect(migration).toContain(
      'FOREIGN KEY ("record_id") REFERENCES "public"."reflection_records"("record_id")',
    );
  });

  test("initializes bounded conversion and a database-enforced forward fence", () => {
    expect(migration).toContain(
      'SET "record_conversion_status" = \'pending\'',
    );
    expect(migration).toContain("pg_advisory_xact_lock(267, 1)");
    expect(migration).toContain("nautilo.stenographer_writer_version");
    expect(migration).toContain(
      'NEW.observation_publication_version <> 2',
    );
    expect(migration).toContain(
      'BEFORE INSERT OR UPDATE OR DELETE ON "room_events"',
    );
    expect(migration).toContain("IF TG_OP = 'DELETE' THEN\n    RETURN OLD;");
  });

  test("keeps the cutover receipt product-only and forward-only", () => {
    expect(migration).toContain(
      'ALTER TABLE "room_journal_record_cutover" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'REVOKE ALL ON TABLE "room_journal_record_cutover" FROM PUBLIC, "nautilo_agent", "nautilo_crypto"',
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE "room_journal_record_cutover" TO "nautilo"',
    );
    expect(migration).toContain("Stenographer Record cutover is forward-only");
  });

  test("stales native observations on edit and sunsets only on rebuild completion", () => {
    expect(migration).toContain(
      'CREATE TRIGGER "room_journal_record_rebuild_lifecycle"',
    );
    expect(migration).toContain("record.lifecycle = 'current'");
    expect(migration).toContain("SET lifecycle = 'stale'");
    expect(migration).toContain("record.lifecycle = 'stale'");
    expect(migration).toContain("SET lifecycle = 'sunset'");
    expect(migration).toContain(
      "OLD.rebuild_requested_at IS NOT NULL",
    );
    expect(migration).toContain(
      "NEW.rebuild_requested_at IS NULL",
    );
  });
});
