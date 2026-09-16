import type { EncryptionCoverageEntry } from "../src/model";

const AUTHORIZATION_REPOSITORY =
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts";
const JOURNAL_REPOSITORY = "packages/runtime/src/stenographer";
const AUTHORIZATION_SCHEMA_EVIDENCE =
  "packages/db/tests/unit/m241-background-authorization-schema.test.ts";
const MIGRATION_EVIDENCE =
  "packages/db/tests/unit/migration-0142-m241-background-authorization.test.ts";
const TRANSFORM_COMMIT_MIGRATION_EVIDENCE =
  "packages/db/tests/unit/migration-0143-m241-transform-commit-proof.test.ts";
const AUTHORIZATION_REPOSITORY_EVIDENCE =
  "packages/runtime/tests/unit/postgres-background-authorization-repository.test.ts";
const JOURNAL_SCHEMA_EVIDENCE =
  "packages/db/tests/unit/m241-background-authorization-schema.test.ts";
const JOURNAL_PUBLICATION_EVIDENCE =
  "packages/runtime/tests/unit/protected-journal-publication-repository.test.ts";
const JOURNAL_REBUILD_EVIDENCE =
  "packages/runtime/tests/unit/protected-journal-rebuild-repository.test.ts";
const STENOGRAPHER_WORK_EVIDENCE =
  "packages/runtime/tests/unit/protected-stenographer-work-repository.test.ts";
const PROCESSOR_TRANSFORM_REPOSITORY =
  "packages/lattice-bridge/src/server/storage/postgres-processor-transform-object-port.ts";
const PROCESSOR_TRANSFORM_EVIDENCE =
  "packages/lattice-bridge/tests/unit/postgres-processor-transform-object-port.test.ts";
const JOURNAL_CRYPTO_TOMBSTONE_REPOSITORY =
  "packages/lattice-bridge/src/server/journal/postgres-journal-crypto-tombstone.ts";
const JOURNAL_CRYPTO_TOMBSTONE_EVIDENCE =
  "packages/lattice-bridge/tests/unit/postgres-journal-crypto-tombstone.test.ts";

const BACKGROUND_AUTHORIZATION_COLUMNS = [
  "accepted_at",
  "accepted_response_bytes",
  "accepted_response_hash",
  "accepted_response_kind",
  "agent_authorization_revision",
  "agent_id",
  "agent_runtime_generation",
  "authorization_expires_at",
  "claim_expires_at",
  "claim_id",
  "created_at",
  "credential_hash",
  "credential_id",
  "credential_subject_kind",
  "descriptor_bytes",
  "descriptor_hash",
  "domain_id",
  "expected_domain_epoch",
  "expected_namespace_access_revision",
  "expected_policy_revision",
  "finished_at",
  "format_version",
  "idempotency_key",
  "issuer_signing_public_key_hash",
  "issuing_device_authorization_revision",
  "issuing_device_id",
  "issuing_human_id",
  "last_retry_reason",
  "maximum_attempts",
  "namespace_id",
  "next_attempt_at",
  "processor_authorization_revision",
  "processor_kind",
  "processor_version",
  "purpose",
  "recipient_expires_at",
  "recipient_generation",
  "recipient_key_id",
  "recipient_public_key",
  "request_id",
  "request_revision",
  "retry_count",
  "state",
  "terminal_reason",
  "transform_commit_claim_id",
  "transform_commit_descriptor_hash",
  "transform_commit_output_count",
  "transform_commit_recipient_generation",
  "transform_committed_at",
  "updated_at",
  "work_id",
  "work_identity_hash",
  "work_kind",
] as const;

const PROCESSOR_SIGNER_AUTHORIZATION_COLUMNS = [
  "authorization_bytes",
  "authorization_hash",
  "authorization_id",
  "created_at",
  "credential_hash",
  "domain_epoch",
  "domain_id",
  "expires_at",
  "issued_at",
  "issuer_signing_public_key_hash",
  "issuing_device_authorization_revision",
  "issuing_device_id",
  "issuing_human_id",
  "namespace_access_revision",
  "namespace_id",
  "policy_revision",
  "processor_authorization_revision",
  "processor_kind",
  "processor_version",
  "recipient_generation",
  "request_id",
  "signer_key_id",
  "signer_public_key",
  "work_descriptor_bytes",
  "work_descriptor_hash",
  "work_id",
] as const;

const JOURNAL_PUBLICATION_COLUMNS = [
  "attached_at",
  "attachment_plan_bytes",
  "attachment_plan_hash",
  "attachment_plan_version",
  "created_at",
  "crypto_committed_at",
  "descriptor_hash",
  "failure_code",
  "last_audited_at",
  "last_failure_at",
  "lease_expires_at",
  "lease_token",
  "maximum_attempts",
  "namespace_id_at_allocation",
  "output_object_count",
  "publication_id",
  "rebuild_generation",
  "request_id",
  "retry_count",
  "room_id",
  "source_batch_id",
  "state",
  "tombstone_requested_at",
  "tombstoned_at",
  "updated_at",
  "work_id",
  "work_identity_hash",
] as const;

const JOURNAL_WRITER_METADATA_COLUMNS = Object.freeze([...new Set([
  ...JOURNAL_PUBLICATION_COLUMNS,
  "batch_id",
  "compaction_due_at",
  "compaction_failure_count",
  "compaction_lease_expires_at",
  "compaction_lease_token",
  "compaction_retry_after",
  "compactor_version",
  "content",
  "created_at",
  "crypto_object_id",
  "extraction_failure_count",
  "extraction_retry_after",
  "historical_backfill_completed_at",
  "historical_backfill_status",
  "id",
  "kind",
  "last_compaction_completed_at",
  "last_compaction_error_at",
  "last_compaction_error_attempt",
  "last_compaction_error_code",
  "last_compaction_error_model_id",
  "last_extraction_completed_at",
  "last_extraction_error_at",
  "last_extraction_error_code",
  "last_processed_at",
  "last_processed_message_id",
  "lease_expires_at",
  "lease_token",
  "model_id",
  "rebuild_completed_at",
  "rebuild_generation",
  "rebuild_requested_at",
  "rebuild_target_message_id",
  "resolves_event_id",
  "room_id",
  "sequence",
  "source_event_count",
  "source_message_id",
  "statement",
  "status",
  "supersedes_event_id",
  "through_event_sequence",
  "updated_at",
])]);

function stableId(value: string): string {
  return value.replaceAll("_", "-");
}

function boundedDatabaseEntry(input: Readonly<{
  id: string;
  locator: string;
  repository: string;
  metadataAllowlist: readonly string[];
  testEvidence: readonly string[];
  retention: string;
}>): EncryptionCoverageEntry {
  return {
    id: input.id,
    surface: "db",
    locator: input.locator,
    owner: "packages/runtime",
    readers: [input.repository],
    writers: [input.repository],
    migrationState: "not_applicable",
    retention: input.retention,
    testEvidence: input.testEvidence,
    classification: "bounded_metadata",
    metadataAllowlist: input.metadataAllowlist,
    plaintextReason:
      "The closed allowlist contains only canonical identifiers, public keys and signed verification material, recipient-encrypted response bytes, hashes, bounded enums/counters, or lifecycle timestamps. It contains no protected source text, prompt, model response, private key, opened credential, or free-form error.",
  };
}

function tableEntries(input: Readonly<{
  id: string;
  table: string;
  columns: readonly string[];
  repository: string;
  testEvidence: readonly string[];
  retention: string;
}>): readonly EncryptionCoverageEntry[] {
  return [
    boundedDatabaseEntry({
      id: input.id,
      locator: `public.${input.table}`,
      repository: input.repository,
      metadataAllowlist: input.columns,
      testEvidence: input.testEvidence,
      retention: input.retention,
    }),
    ...input.columns.map((column) =>
      boundedDatabaseEntry({
        id: `${input.id}.${stableId(column)}`,
        locator: `public.${input.table}.${column}`,
        repository: input.repository,
        metadataAllowlist: [column],
        testEvidence: input.testEvidence,
        retention: input.retention,
      })
    ),
  ];
}

const AUTHORIZATION_RETENTION =
  "One bounded request row is retained per exact work identity through its active lifecycle; terminal content-free metadata is pruned after the reviewed retention window.";
const SIGNER_RETENTION =
  "Successful public signer authorization evidence is append-only and retained only while required to verify durable processor ciphertext.";
const JOURNAL_RETENTION =
  "One content-free publication receipt is retained per exact journal work identity until attachment, tombstone, quarantine, supersession, or bounded reconciliation cleanup.";

const schemaEntries: readonly EncryptionCoverageEntry[] = [
  ...tableEntries({
    id: "db.wave10.background-authorization-requests",
    table: "background_crypto_authorization_requests",
    columns: BACKGROUND_AUTHORIZATION_COLUMNS,
    repository: AUTHORIZATION_REPOSITORY,
    testEvidence: [
      AUTHORIZATION_SCHEMA_EVIDENCE,
      MIGRATION_EVIDENCE,
      TRANSFORM_COMMIT_MIGRATION_EVIDENCE,
      AUTHORIZATION_REPOSITORY_EVIDENCE,
    ],
    retention: AUTHORIZATION_RETENTION,
  }),
  ...tableEntries({
    id: "db.wave10.processor-signer-authorizations",
    table: "processor_crypto_signer_authorizations",
    columns: PROCESSOR_SIGNER_AUTHORIZATION_COLUMNS,
    repository: AUTHORIZATION_REPOSITORY,
    testEvidence: [
      AUTHORIZATION_SCHEMA_EVIDENCE,
      MIGRATION_EVIDENCE,
      AUTHORIZATION_REPOSITORY_EVIDENCE,
    ],
    retention: SIGNER_RETENTION,
  }),
  ...tableEntries({
    id: "db.wave10.room-journal-publications",
    table: "room_journal_crypto_publications",
    columns: JOURNAL_PUBLICATION_COLUMNS,
    repository: JOURNAL_REPOSITORY,
    testEvidence: [JOURNAL_SCHEMA_EVIDENCE, MIGRATION_EVIDENCE],
    retention: JOURNAL_RETENTION,
  }),
  ...[
    "public.room_event_rollups.crypto_object_id",
    "public.room_events.crypto_object_id",
  ].map((locator) =>
    boundedDatabaseEntry({
      id: `db.wave10.${stableId(locator.replace("public.", "").replaceAll(".", "-"))}`,
      locator,
      repository: JOURNAL_REPOSITORY,
      metadataAllowlist: ["crypto_object_id"],
      testEvidence: [JOURNAL_SCHEMA_EVIDENCE, MIGRATION_EVIDENCE],
      retention:
        "The nullable opaque object identity is retained with its owning journal event or rollup and removed with that product row.",
    })
  ),
];

const WRITER_LOCATORS = [
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts##appendProcessorSignerEvidence:raw_sql:insert:public.processor_crypto_signer_authorizations:1",
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts#compareAndSwapInternal:raw_sql:update:public.background_crypto_authorization_requests:1",
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts##createParsed:raw_sql:insert:public.background_crypto_authorization_requests:1",
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts#pruneTerminal:raw_sql:delete:public.background_crypto_authorization_requests:1",
] as const;

const PROCESSOR_TRANSFORM_WRITER_LOCATORS = [
  "packages/lattice-bridge/src/server/storage/postgres-processor-transform-object-port.ts#insertExactOutput:raw_sql:insert:public.crypto_objects:1",
  "packages/lattice-bridge/src/server/storage/postgres-processor-transform-object-port.ts#insertExactOutput:raw_sql:insert:public.object_crypto_access_heads:1",
  "packages/lattice-bridge/src/server/storage/postgres-processor-transform-object-port.ts#insertExactOutput:raw_sql:insert:public.object_crypto_access_manifests:1",
  "packages/lattice-bridge/src/server/storage/postgres-processor-transform-object-port.ts#insertExactOutput:raw_sql:insert:public.object_crypto_access_manifests:2",
  "packages/lattice-bridge/src/server/storage/postgres-processor-transform-object-port.ts#insertExactOutput:raw_sql:insert:public.object_crypto_namespace_envelopes:1",
] as const;

const PROCESSOR_TRANSFORM_COMMIT_WRITER_LOCATORS = [
  "packages/lattice-bridge/src/server/storage/postgres-processor-transform-object-port.ts#publishOutputs:raw_sql:update:public.background_crypto_authorization_requests:1",
] as const;

const JOURNAL_CRYPTO_TOMBSTONE_WRITER_LOCATORS = [
  "packages/lattice-bridge/src/server/journal/postgres-journal-crypto-tombstone.ts#tombstoneObjects:raw_sql:update:public.object_crypto_access_heads:1",
] as const;

const JOURNAL_WRITER_LOCATORS = [
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

const writerEntries: readonly EncryptionCoverageEntry[] = WRITER_LOCATORS.map(
  (locator, index) =>
    boundedDatabaseEntry({
      id: `db.wave10.runtime-writer-${String(index + 1).padStart(2, "0")}`,
      locator,
      repository: AUTHORIZATION_REPOSITORY,
      metadataAllowlist: locator.includes(
          "processor_crypto_signer_authorizations",
        )
        ? PROCESSOR_SIGNER_AUTHORIZATION_COLUMNS
        : BACKGROUND_AUTHORIZATION_COLUMNS,
      testEvidence: [AUTHORIZATION_REPOSITORY_EVIDENCE],
      retention: locator.includes("processor_crypto_signer_authorizations")
        ? SIGNER_RETENTION
        : AUTHORIZATION_RETENTION,
    }),
);

const processorTransformWriterEntries: readonly EncryptionCoverageEntry[] =
  PROCESSOR_TRANSFORM_WRITER_LOCATORS.map((locator, index) => ({
    id: `db.wave10.processor-transform-writer-${
      String(index + 1).padStart(2, "0")
    }`,
    surface: "db",
    locator,
    owner: "packages/lattice-bridge",
    readers: [PROCESSOR_TRANSFORM_REPOSITORY],
    writers: [PROCESSOR_TRANSFORM_REPOSITORY],
    migrationState: "ciphertext_only",
    retention:
      "The atomic transform retains only canonical encrypted payload, access-manifest, and Namespace-envelope material for the exact authorized output object.",
    testEvidence: [PROCESSOR_TRANSFORM_EVIDENCE],
    classification: "protected",
    keyFamily: "namespace_ai",
    bridgeRepository: PROCESSOR_TRANSFORM_REPOSITORY,
    negativeTestEvidence: [PROCESSOR_TRANSFORM_EVIDENCE],
  }));

const processorTransformCommitWriterEntries:
  readonly EncryptionCoverageEntry[] =
  PROCESSOR_TRANSFORM_COMMIT_WRITER_LOCATORS.map((locator, index) =>
    boundedDatabaseEntry({
      id: `db.wave10.processor-transform-commit-writer-${
        String(index + 1).padStart(2, "0")
      }`,
      locator,
      repository: PROCESSOR_TRANSFORM_REPOSITORY,
      metadataAllowlist: BACKGROUND_AUTHORIZATION_COLUMNS,
      testEvidence: [
        PROCESSOR_TRANSFORM_EVIDENCE,
        TRANSFORM_COMMIT_MIGRATION_EVIDENCE,
      ],
      retention: AUTHORIZATION_RETENTION,
    })
  );

const journalCryptoTombstoneWriterEntries:
  readonly EncryptionCoverageEntry[] =
    JOURNAL_CRYPTO_TOMBSTONE_WRITER_LOCATORS.map((locator, index) => ({
      id: `db.wave10.journal-crypto-tombstone-writer-${
        String(index + 1).padStart(2, "0")
      }`,
      surface: "db",
      locator,
      owner: "packages/lattice-bridge",
      readers: [JOURNAL_CRYPTO_TOMBSTONE_REPOSITORY],
      writers: [JOURNAL_CRYPTO_TOMBSTONE_REPOSITORY],
      migrationState: "ciphertext_only",
      retention:
        "The tombstone CAS advances only the access revision and signed manifest hash; encrypted payload and append-only verification history remain retained.",
      testEvidence: [JOURNAL_CRYPTO_TOMBSTONE_EVIDENCE],
      classification: "protected",
      keyFamily: "namespace_ai",
      bridgeRepository: JOURNAL_CRYPTO_TOMBSTONE_REPOSITORY,
      negativeTestEvidence: [JOURNAL_CRYPTO_TOMBSTONE_EVIDENCE],
    }));

const journalWriterEntries: readonly EncryptionCoverageEntry[] =
  JOURNAL_WRITER_LOCATORS.map((locator, index) =>
    boundedDatabaseEntry({
      id: `db.wave10.journal-writer-${
        String(index + 1).padStart(2, "0")
      }`,
      locator,
      repository: JOURNAL_REPOSITORY,
      metadataAllowlist: JOURNAL_WRITER_METADATA_COLUMNS,
      testEvidence: [
        locator.includes("protected-journal-rebuild-repository")
          ? JOURNAL_REBUILD_EVIDENCE
          : locator.includes("protected-stenographer-work-repository")
          ? STENOGRAPHER_WORK_EVIDENCE
          : JOURNAL_PUBLICATION_EVIDENCE,
      ],
      retention: JOURNAL_RETENTION,
    })
  );

/** Exact content-free durable surfaces and raw writers introduced by Wave 10. */
export const REVIEWED_WAVE_10_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
    ...schemaEntries,
    ...writerEntries,
    ...processorTransformWriterEntries,
    ...processorTransformCommitWriterEntries,
    ...journalCryptoTombstoneWriterEntries,
    ...journalWriterEntries,
  ];
