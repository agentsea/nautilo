import type { EncryptionCoverageEntry } from "../src/model";

const ORDINARY_PUBLISHER =
  "packages/reflection-bridge/src/server/postgres-ordinary-stenographer-publisher.ts";
const PROTECTED_CONVERTER =
  "packages/reflection-bridge/src/server/postgres-protected-stenographer-converter.ts";
const RECORD_STORE =
  "packages/reflection-bridge/src/server/postgres-record-product-store.ts";
const PROTECTED_ATTACHMENT =
  "packages/reflection-bridge/src/server/protected-stenographer-record-attachment.ts";
const MIGRATION_EVIDENCE =
  "packages/db/tests/unit/migration-0168-m267-stenographer-record-cutover.test.ts";
const ORDINARY_EVIDENCE =
  "packages/reflection-bridge/tests/unit/postgres-ordinary-stenographer-publisher.test.ts";
const PROTECTED_EVIDENCE =
  "packages/reflection-bridge/tests/unit/protected-stenographer-record-attachment.test.ts";
const CONVERTER_EVIDENCE =
  "packages/reflection-bridge/tests/unit/postgres-protected-stenographer-converter.test.ts";

const SCHEMA_LOCATORS = [
  "public.room_events.native_attached_at",
  "public.room_events.projection_kind",
  "public.room_events.record_id",
  "public.room_journal_batches.observation_publication_version",
  "public.room_journal_record_cutover",
  "public.room_journal_record_cutover.activated_at",
  "public.room_journal_record_cutover.created_at",
  "public.room_journal_record_cutover.cutover_version",
  "public.room_journal_record_cutover.first_native_record_id",
  "public.room_journal_record_cutover.singleton_key",
  "public.room_journal_record_rebuild_retirements",
  "public.room_journal_record_rebuild_retirements.completed_at",
  "public.room_journal_record_rebuild_retirements.created_at",
  "public.room_journal_record_rebuild_retirements.rebuild_generation",
  "public.room_journal_record_rebuild_retirements.record_id",
  "public.room_journal_record_rebuild_retirements.room_id",
  "public.room_journal_record_rebuild_retirements.state",
  "public.room_journal_state.record_conversion_cursor_sequence",
  "public.room_journal_state.record_conversion_failure_count",
  "public.room_journal_state.record_conversion_last_error_code",
  "public.room_journal_state.record_conversion_lease_expires_at",
  "public.room_journal_state.record_conversion_lease_token",
  "public.room_journal_state.record_conversion_retry_after",
  "public.room_journal_state.record_conversion_status",
] as const;

const METADATA_WRITERS = [
  `${ORDINARY_PUBLISHER}##completeBatchAndCursor:raw_sql:update:public.room_journal_batches:1`,
  `${ORDINARY_PUBLISHER}##completeBatchAndCursor:raw_sql:update:public.room_journal_state:1`,
  `${ORDINARY_PUBLISHER}##ensureLegacyPredecessorNative:raw_sql:insert:public.room_journal_record_cutover:1`,
  `${ORDINARY_PUBLISHER}##ensureLegacyPredecessorNative:raw_sql:update:public.room_events:1`,
  `${ORDINARY_PUBLISHER}##publishExtraction:raw_sql:insert:public.room_events:1`,
  `${ORDINARY_PUBLISHER}##publishExtraction:raw_sql:insert:public.room_journal_record_cutover:1`,
  `${ORDINARY_PUBLISHER}##publishExtraction:raw_sql:update:public.room_events:1`,
  `${ORDINARY_PUBLISHER}#convertNextLegacyPage:raw_sql:update:public.room_journal_state:1`,
  `${ORDINARY_PUBLISHER}#convertNextLegacyPage:raw_sql:update:public.room_journal_state:2`,
  `${PROTECTED_CONVERTER}##attach:raw_sql:insert:public.room_journal_record_cutover:1`,
  `${PROTECTED_CONVERTER}##attach:raw_sql:update:public.room_events:1`,
  `${PROTECTED_CONVERTER}##attach:raw_sql:update:public.room_journal_state:1`,
  `${PROTECTED_CONVERTER}##claim:raw_sql:update:public.room_journal_state:1`,
  `${PROTECTED_CONVERTER}##releaseFailure:raw_sql:update:public.room_journal_state:1`,
  `${RECORD_STORE}#publishOrdinaryWithinTransaction:raw_sql:insert:public.reflection_record_payload_representation_heads:1`,
  `${RECORD_STORE}#publishOrdinaryWithinTransaction:raw_sql:insert:public.reflection_record_publications:1`,
  `${RECORD_STORE}#transitionLifecycle:raw_sql:update:public.reflection_records:1`,
  `${PROTECTED_ATTACHMENT}#attachProtectedStenographerRecordsWithinTransaction:raw_sql:insert:public.reflection_record_payload_representation_heads:1`,
  `${PROTECTED_ATTACHMENT}#attachProtectedStenographerRecordsWithinTransaction:raw_sql:insert:public.reflection_record_publications:1`,
  `${PROTECTED_ATTACHMENT}#attachProtectedStenographerRecordsWithinTransaction:raw_sql:insert:public.reflection_record_successors:1`,
  `${PROTECTED_ATTACHMENT}#attachProtectedStenographerRecordsWithinTransaction:raw_sql:insert:public.reflection_records:1`,
  `${PROTECTED_ATTACHMENT}#attachProtectedStenographerRecordsWithinTransaction:raw_sql:insert:public.room_events:1`,
  `${PROTECTED_ATTACHMENT}#attachProtectedStenographerRecordsWithinTransaction:raw_sql:insert:public.room_journal_record_cutover:1`,
  `${PROTECTED_ATTACHMENT}#attachProtectedStenographerRecordsWithinTransaction:raw_sql:update:public.reflection_records:1`,
  `${PROTECTED_ATTACHMENT}#attachProtectedStenographerRecordsWithinTransaction:raw_sql:update:public.room_events:1`,
] as const;

const PROTECTED_PAYLOAD_WRITERS = [
  {
    locator: `${RECORD_STORE}#publishOrdinaryWithinTransaction:raw_sql:insert:public.reflection_record_payload_representations:1`,
    repository: RECORD_STORE,
    migrationState: "shadow" as const,
    evidence: ORDINARY_EVIDENCE,
  },
  {
    locator: `${PROTECTED_ATTACHMENT}#attachProtectedStenographerRecordsWithinTransaction:raw_sql:insert:public.reflection_record_payload_representations:1`,
    repository: PROTECTED_ATTACHMENT,
    migrationState: "ciphertext_only" as const,
    evidence: PROTECTED_EVIDENCE,
  },
] as const;

export const SUPERSEDED_MAIN_2026_08_14_M267_COVERAGE_LOCATORS =
  new Set<string>([
    `${RECORD_STORE}#publishOrdinary:raw_sql:insert:public.reflection_record_payload_representation_heads:1`,
    `${RECORD_STORE}#publishOrdinary:raw_sql:insert:public.reflection_record_payload_representations:1`,
    `${RECORD_STORE}#publishOrdinary:raw_sql:insert:public.reflection_record_publications:1`,
    "packages/runtime/src/stenographer/protected-publication-repository.ts#attachExtraction:raw_sql:insert:public.room_events:1",
    "packages/runtime/src/stenographer/protected-publication-repository.ts#attachExtraction:raw_sql:update:public.room_events:1",
  ]);

function stableId(locator: string): string {
  return locator.replaceAll(/[^a-zA-Z0-9]+/gu, "-").toLowerCase();
}

function repository(locator: string): string {
  return locator.slice(0, locator.indexOf("#"));
}

function metadataEntry(
  locator: string,
  owner: string,
  evidence: readonly string[],
  repositoryPath = owner,
): EncryptionCoverageEntry {
  return {
    id: `db.main-2026-08-14-m267.${stableId(locator)}`,
    surface: "db",
    locator,
    owner,
    readers: [repositoryPath],
    writers: [repositoryPath],
    migrationState: "not_applicable",
    retention:
      "Retained only for bounded Stenographer Record identity, lifecycle, projection, conversion, cutover, retry, lease, and rebuild coordination.",
    testEvidence: evidence,
    classification: "bounded_metadata",
    metadataAllowlist: [
      "opaque Room, Record, batch, publication, representation, and lease identifiers",
      "fixed projection, lifecycle, conversion, failure, and rebuild states",
      "bounded versions, generations, sequences, counters, and timestamps",
    ],
    plaintextReason:
      "These exact fields and writers carry only content-free identifiers and closed lifecycle coordinates. Stenographer statements remain isolated in the separately classified ordinary or encrypted Record payload representation.",
  };
}

export const REVIEWED_MAIN_2026_08_14_M267_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
    ...SCHEMA_LOCATORS.map((locator) =>
      metadataEntry(locator, "packages/db", [MIGRATION_EVIDENCE])
    ),
    ...METADATA_WRITERS.map((locator) => {
      const owner = repository(locator);
      const evidence = owner === ORDINARY_PUBLISHER
        ? ORDINARY_EVIDENCE
        : owner === PROTECTED_CONVERTER
          ? CONVERTER_EVIDENCE
          : owner === PROTECTED_ATTACHMENT
            ? PROTECTED_EVIDENCE
            : ORDINARY_EVIDENCE;
      return metadataEntry(
        locator,
        owner.split("/").slice(0, 2).join("/"),
        [evidence],
        owner,
      );
    }),
    ...PROTECTED_PAYLOAD_WRITERS.map((writer) => ({
      id: `db.main-2026-08-14-m267.${stableId(writer.locator)}`,
      surface: "db" as const,
      locator: writer.locator,
      owner: "packages/reflection-bridge",
      readers: [writer.repository],
      writers: [writer.repository],
      migrationState: writer.migrationState,
      retention:
        "Retained as the selected immutable Stenographer Record payload representation until authorized Record retirement or purge.",
      testEvidence: [writer.evidence, MIGRATION_EVIDENCE],
      classification: "protected" as const,
      keyFamily: "namespace_ai" as const,
      bridgeRepository: writer.repository,
      negativeTestEvidence: [writer.evidence],
    })),
  ];
