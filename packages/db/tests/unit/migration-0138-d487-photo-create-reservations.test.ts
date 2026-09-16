import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { photoLibraryOperations } from "../../src/schema";

const migrations = resolve(import.meta.dirname, "../../src/migrations");
const journal = JSON.parse(readFileSync(resolve(migrations, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ idx: number; tag: string }>;
};
const tag = journal.entries.find((entry) => entry.idx === 138)?.tag;
if (!tag) throw new Error("D487 reservation migration 0138 is missing from the journal");
const snapshot = JSON.parse(readFileSync(resolve(migrations, "meta/0138_snapshot.json"), "utf8")) as {
  tables: Record<string, { columns: Record<string, unknown> }>;
};
const followupTag = journal.entries.find((entry) => entry.idx === 139)?.tag;
if (!followupTag) throw new Error("D487 reservation hardening migration 0139 is missing from the journal");
const followup = readFileSync(resolve(migrations, `${followupTag}.sql`), "utf8");

describe("D487 create reservation migration", () => {
  test("records its missing snapshot and reservation schema", () => {
    const operations = getTableConfig(photoLibraryOperations);
    expect(snapshot.tables["public.photo_library_operations"]?.columns["reserved_slots"]).toBeDefined();
    expect(snapshot.tables["public.photo_library_operations"]?.columns["reservation_expires_at"]).toBeDefined();
    expect(snapshot.tables["public.photo_library_operations"]?.columns["reservation_lease_token"]).toBeDefined();
    expect(operations.columns.find((column) => column.name === "reserved_slots")?.notNull).toBe(true);
    expect(operations.checks.find((check) => check.name === "photo_library_operations_reservation_check")).toBeDefined();
  });

  test("makes the reservation fingerprint and lease immutable while retaining terminal receipt transitions", () => {
    expect(followup).toContain("CREATE OR REPLACE FUNCTION \"public\".\"reject_photo_library_operation_identity_update\"");
    expect(followup).toContain("NEW.reserved_slots");
    expect(followup).toContain("NEW.reservation_expires_at");
    expect(followup).toContain("NEW.reservation_lease_token");
    expect(followup).toContain("NEW.request_fingerprint");
  });
});
