import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  agentPhotoSelectionRevisions,
  ownedPhotoEntries,
  photoLibraryOperations,
  profiles,
} from "../../src/schema";

const migrations = resolve(import.meta.dirname, "../../src/migrations");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as { entries: Array<{ idx: number; tag: string }> };
const tag = journal.entries.find((entry) => entry.idx === 137)?.tag;
if (!tag) throw new Error("D487 migration 0137 is missing from the journal");
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const snapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0137_snapshot.json"), "utf8"),
) as { tables: Record<string, { columns: Record<string, unknown> }> };

describe("D487 owned photo library migration", () => {
  test("records the generated snapshot and canonical tables", () => {
    expect(snapshot.tables["public.owned_photo_entries"]).toBeDefined();
    expect(snapshot.tables["public.agent_photo_selection_revisions"]).toBeDefined();
    expect(snapshot.tables["public.photo_library_operations"]).toBeDefined();
    expect(snapshot.tables["public.profiles"]?.columns["avatar_selection_revision"]).toBeDefined();
    expect(snapshot.tables["public.profiles"]?.columns["avatar_library_revision"]).toBeDefined();
  });

  test("keeps profiles as the sole current Agent pointer and bounds revisions", () => {
    const profile = getTableConfig(profiles);
    expect(profile.columns.find((column) => column.name === "avatar_ref")).toBeDefined();
    expect(profile.columns.find((column) => column.name === "avatar_selection_revision")?.notNull).toBe(true);
    expect(profile.columns.find((column) => column.name === "avatar_library_revision")?.notNull).toBe(true);
    expect(profile.checks.find((check) => check.name === "profiles_avatar_photo_revisions_nonnegative")).toBeDefined();
    expect(migration).toContain("9007199254740991");
    expect(migration).toContain("profiles_avatar_photo_revision_monotonic");
  });

  test("enforces publish provenance, exact refs, and append-only selection history", () => {
    const entries = getTableConfig(ownedPhotoEntries);
    const selections = getTableConfig(agentPhotoSelectionRevisions);
    expect(entries.columns.find((column) => column.name === "media_mime_type")?.notNull).toBe(true);
    expect(entries.columns.find((column) => column.name === "media_byte_size")?.notNull).toBe(true);
    expect(entries.columns.find((column) => column.name === "media_sha256")?.notNull).toBe(true);
    expect(entries.indexes.find((index) => index.config.name === "idx_owned_photo_entries_agent_recent")).toBeDefined();
    expect(migration).toContain('"idx_owned_photo_entries_agent_recent"');
    expect(migration).toContain('WHERE "owned_photo_entries"."deleted_at" IS NULL');
    expect(selections.columns.find((column) => column.name === "after_avatar_ref")?.notNull).toBe(false);
    expect(selections.checks.find((check) => check.name === "agent_photo_selection_revisions_revision_positive")).toBeDefined();
    expect(migration).toContain("agent_photo_selection_revisions_append_only_update");
    expect(migration).not.toContain("agent_photo_selection_revisions_append_only_delete");
    expect(migration).toContain("- ARRAY['kind', 'blobId'] = '{}'::jsonb");
  });

  test("protects immutable entry and receipt identity while permitting lifecycle transitions", () => {
    const operations = getTableConfig(photoLibraryOperations);
    expect(operations.checks.find((check) => check.name === "photo_library_operations_result_size_check")).toBeDefined();
    expect(migration).toContain("pg_column_size");
    expect(migration).toContain("65536");
    expect(operations.columns.find((column) => column.name === "expires_at")?.notNull).toBe(true);
    expect(migration).toContain("idx_photo_library_operations_expiry");
    expect(migration).toContain("expires_at");
    expect(migration).toContain("owned_photo_entries_identity_immutable");
    expect(migration).toContain("photo_library_operations_identity_immutable");
    expect(migration).toContain("NEW.media_sha256");
    expect(migration).toContain("NEW.request_fingerprint");
  });
});
