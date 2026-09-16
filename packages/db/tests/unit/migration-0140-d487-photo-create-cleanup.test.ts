import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { photoLibraryOperations } from "../../src/schema";

const migrations = resolve(import.meta.dirname, "../../src/migrations");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as { entries: Array<{ idx: number; tag: string }> };
const tag = journal.entries.find((entry) => entry.idx === 140)?.tag;
if (!tag) throw new Error("D487 cleanup migration 0140 is missing from the journal");
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const snapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0140_snapshot.json"), "utf8"),
) as { tables: Record<string, { columns: Record<string, unknown> }> };

describe("D487 expired-create artifact cleanup migration", () => {
  test("adds an explicit durable cleanup receipt marker", () => {
    const operations = getTableConfig(photoLibraryOperations);
    expect(operations.columns.find((column) => column.name === "artifact_cleanup_completed_at")?.notNull).toBe(false);
    expect(snapshot.tables["public.photo_library_operations"]?.columns["artifact_cleanup_completed_at"]).toBeDefined();
    expect(migration).toContain('ADD COLUMN "artifact_cleanup_completed_at"');
  });

  test("permits only the failed-create cleanup marker transition after terminalization", () => {
    expect(migration).toContain("OLD.state = 'failed'");
    expect(migration).toContain("OLD.operation_kind = 'create'");
    expect(migration).toContain("OLD.artifact_cleanup_completed_at IS NULL");
    expect(migration).toContain("NEW.artifact_cleanup_completed_at IS NOT NULL");
    expect(migration).toContain("NEW.reservation_lease_token");
    expect(migration).toContain("NEW.request_fingerprint");
    expect(migration).toContain("completed photo library operation is immutable");
  });
});
