import { describe, expect, test } from "bun:test";
import * as nautiloSchema from "@nautilo/db/schema";

import {
  REVIEWED_WAVE_10_COVERAGE_ENTRIES,
} from "../../baseline/reviewed-wave-10";
import {
  REVIEWED_MAIN_2026_09_12_DATABASE_METADATA_ENTRIES,
} from "../../baseline/reviewed-main-2026-09-12-database";
import {
  inventoryDrizzleSchema,
} from "../../src/node/schema-inventory";

const WAVE_10_TABLES = new Set([
  "background_crypto_authorization_requests",
  "processor_crypto_signer_authorizations",
  "room_journal_crypto_publications",
]);

const MAPPING_COLUMNS = [
  "public.room_event_rollups.crypto_object_id",
  "public.room_events.crypto_object_id",
] as const;

const WRITER_LOCATORS = [
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts##appendProcessorSignerEvidence:raw_sql:insert:public.processor_crypto_signer_authorizations:1",
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts#compareAndSwapInternal:raw_sql:update:public.background_crypto_authorization_requests:1",
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts##createParsed:raw_sql:insert:public.background_crypto_authorization_requests:1",
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts#pruneTerminal:raw_sql:delete:public.background_crypto_authorization_requests:1",
  "packages/lattice-bridge/src/server/storage/postgres-processor-transform-object-port.ts#insertExactOutput:raw_sql:insert:public.crypto_objects:1",
  "packages/lattice-bridge/src/server/storage/postgres-processor-transform-object-port.ts#insertExactOutput:raw_sql:insert:public.object_crypto_access_heads:1",
  "packages/lattice-bridge/src/server/storage/postgres-processor-transform-object-port.ts#insertExactOutput:raw_sql:insert:public.object_crypto_access_manifests:1",
  "packages/lattice-bridge/src/server/storage/postgres-processor-transform-object-port.ts#insertExactOutput:raw_sql:insert:public.object_crypto_access_manifests:2",
  "packages/lattice-bridge/src/server/storage/postgres-processor-transform-object-port.ts#insertExactOutput:raw_sql:insert:public.object_crypto_namespace_envelopes:1",
  "packages/lattice-bridge/src/server/storage/postgres-processor-transform-object-port.ts#publishOutputs:raw_sql:update:public.background_crypto_authorization_requests:1",
  "packages/lattice-bridge/src/server/journal/postgres-journal-crypto-tombstone.ts#tombstoneObjects:raw_sql:update:public.object_crypto_access_heads:1",
  "packages/runtime/src/stenographer/protected-journal-rebuild-repository.ts#finalize:raw_sql:delete:public.room_event_rollups:1",
  "packages/runtime/src/stenographer/protected-journal-rebuild-repository.ts#finalize:raw_sql:delete:public.room_events:1",
  "packages/runtime/src/stenographer/protected-journal-rebuild-repository.ts#finalize:raw_sql:delete:public.room_journal_batches:1",
  "packages/runtime/src/stenographer/protected-journal-rebuild-repository.ts#finalize:raw_sql:delete:public.room_journal_crypto_publications:1",
  "packages/runtime/src/stenographer/protected-journal-rebuild-repository.ts#finalize:raw_sql:update:public.room_journal_state:1",
  "packages/runtime/src/stenographer/protected-journal-rebuild-repository.ts#prepare:raw_sql:update:public.room_journal_crypto_publications:1",
  "packages/runtime/src/stenographer/protected-publication-repository.ts#attachExtraction:raw_sql:insert:public.room_events:1",
  "packages/runtime/src/stenographer/protected-publication-repository.ts#attachExtraction:raw_sql:update:public.room_events:1",
  "packages/runtime/src/stenographer/protected-publication-repository.ts#attachExtraction:raw_sql:update:public.room_journal_batches:1",
  "packages/runtime/src/stenographer/protected-publication-repository.ts#attachExtraction:raw_sql:update:public.room_journal_state:1",
  "packages/runtime/src/stenographer/protected-publication-repository.ts#attachExtraction:raw_sql:update:public.room_journal_state:2",
  "packages/runtime/src/stenographer/protected-publication-repository.ts#attachRollup:raw_sql:insert:public.room_event_rollups:1",
  "packages/runtime/src/stenographer/protected-publication-repository.ts#attachRollup:raw_sql:update:public.room_journal_state:1",
  "packages/runtime/src/stenographer/protected-publication-repository.ts#abandonReserved:raw_sql:update:public.room_journal_crypto_publications:1",
  "packages/runtime/src/stenographer/protected-publication-repository.ts#claim:raw_sql:update:public.room_journal_crypto_publications:1",
  "packages/runtime/src/stenographer/protected-publication-repository.ts#fail:raw_sql:update:public.room_journal_crypto_publications:1",
  "packages/runtime/src/stenographer/protected-publication-repository.ts#markCryptoCommitted:raw_sql:update:public.room_journal_crypto_publications:1",
  "packages/runtime/src/stenographer/protected-publication-repository.ts#markTombstoned:raw_sql:update:public.room_journal_crypto_publications:1",
  "packages/runtime/src/stenographer/protected-publication-repository.ts#quarantineMappingConflict:raw_sql:update:public.room_journal_crypto_publications:1",
  "packages/runtime/src/stenographer/protected-publication-repository.ts#requestTombstone:raw_sql:update:public.room_journal_crypto_publications:1",
  "packages/runtime/src/stenographer/protected-publication-repository.ts#reserve:raw_sql:insert:public.room_journal_crypto_publications:1",
  "packages/runtime/src/stenographer/protected-publication-repository.ts#reserveCurrentSourceAndClaim:raw_sql:insert:public.room_journal_crypto_publications:1",
  "packages/runtime/src/stenographer/protected-publication-repository.ts#reserveCurrentSourceAndClaim:raw_sql:update:public.room_journal_crypto_publications:1",
  "packages/runtime/src/stenographer/protected-publication-repository.ts#reserveCurrentSourceAndClaim:raw_sql:update:public.room_journal_crypto_publications:2",
  "packages/runtime/src/stenographer/protected-stenographer-work-repository.ts##claimCompactionInTransaction:raw_sql:update:public.room_journal_state:1",
  "packages/runtime/src/stenographer/protected-stenographer-work-repository.ts##claimExtractionInTransaction:raw_sql:insert:public.room_journal_batches:1",
  "packages/runtime/src/stenographer/protected-stenographer-work-repository.ts##claimExtractionInTransaction:raw_sql:update:public.room_journal_batches:1",
  "packages/runtime/src/stenographer/protected-stenographer-work-repository.ts##claimExtractionInTransaction:raw_sql:update:public.room_journal_state:1",
] as const;

describe("Wave 10 reviewed coverage registry", () => {
  test("classifies all three new tables, their columns, and both mapping columns", () => {
    const inventory = inventoryDrizzleSchema(nautiloSchema);
    const observed = [
      ...inventory.objects
        .filter((item) =>
          item.kind === "table" && WAVE_10_TABLES.has(item.name)
        )
        .map((item) => item.locator),
      ...inventory.columns
        .filter((item) => WAVE_10_TABLES.has(item.objectName))
        .map((item) => item.locator),
      ...MAPPING_COLUMNS,
    ].sort();
    const formatVersionEntries = REVIEWED_MAIN_2026_09_12_DATABASE_METADATA_ENTRIES
      .filter((entry) =>
        entry.locator === "public.processor_crypto_signer_authorizations.format_version"
      );
    expect(formatVersionEntries).toHaveLength(1);
    expect(formatVersionEntries[0]?.classification).toBe("bounded_metadata");
    const declared = [
      ...REVIEWED_WAVE_10_COVERAGE_ENTRIES,
      ...formatVersionEntries,
    ]
      .filter((entry) => !entry.locator.includes(":raw_sql:"))
      .map((entry) => entry.locator)
      .sort();

    expect(declared).toEqual(observed);
    expect(new Set(declared).size).toBe(declared.length);
    expect(declared).toHaveLength(112);
  });

  test("classifies only closed content-free durable material", () => {
    expect(REVIEWED_WAVE_10_COVERAGE_ENTRIES).toHaveLength(150);
    expect(REVIEWED_WAVE_10_COVERAGE_ENTRIES.filter(
      (entry) => entry.classification === "protected",
    )).toHaveLength(6);
    expect(REVIEWED_WAVE_10_COVERAGE_ENTRIES.every(
      (entry) =>
        entry.classification === "bounded_metadata"
        || entry.classification === "protected",
    )).toBeTrue();
    expect(JSON.stringify(REVIEWED_WAVE_10_COVERAGE_ENTRIES))
      .not.toContain("private_key");
    expect(JSON.stringify(REVIEWED_WAVE_10_COVERAGE_ENTRIES))
      .not.toContain("plaintext_prompt");
  });

  test("pins the exact current raw repository writers after private-helper rename", () => {
    expect(
      REVIEWED_WAVE_10_COVERAGE_ENTRIES
        .filter((entry) => entry.locator.includes(":raw_sql:"))
        .map((entry) => entry.locator),
    ).toEqual([...WRITER_LOCATORS]);
  });
});
