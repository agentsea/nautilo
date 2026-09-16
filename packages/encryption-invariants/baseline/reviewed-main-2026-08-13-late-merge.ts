import type { EncryptionCoverageEntry } from "../src/model";

const ARTIFACT_SCHEMA_EVIDENCE = [
  "packages/db/tests/unit/m261-artifact-crypto-schema.test.ts",
  "packages/db/tests/unit/migration-0164-m261-artifact-crypto.test.ts",
] as const;
const ARTIFACT_WRITER_EVIDENCE =
  "packages/lattice-bridge/tests/unit/postgres-artifact-product-publication.test.ts";
const REFLECTION_SCHEMA_EVIDENCE = [
  "packages/db/tests/unit/reflection-record-schema.test.ts",
  "packages/db/tests/unit/migration-0163-m258-reflection-authority.test.ts",
] as const;
const REFLECTION_WRITER_EVIDENCE =
  "packages/reflection-bridge/tests/unit/authority-reconciliation.test.ts";
const REFLECTION_NEGATIVE_EVIDENCE =
  "packages/reflection-bridge/tests/unit/protected-authority-republisher.test.ts";
const REFLECTION_AUTHORITY_STORE =
  "packages/reflection-bridge/src/server/postgres-authority-store.ts";

const SCHEMA_LOCATORS = [
  "public.artifact_crypto_blobs",
  "public.artifact_crypto_blobs.artifact_id",
  "public.artifact_crypto_blobs.artifact_row_id",
  "public.artifact_crypto_blobs.blob_generation",
  "public.artifact_crypto_blobs.blob_id",
  "public.artifact_crypto_blobs.ciphertext_length",
  "public.artifact_crypto_blobs.ciphertext_sha256",
  "public.artifact_crypto_blobs.created_at",
  "public.artifact_crypto_blobs.failure_code",
  "public.artifact_crypto_blobs.publication_operation_id",
  "public.artifact_crypto_blobs.published_at",
  "public.artifact_crypto_blobs.sequence",
  "public.artifact_crypto_blobs.state",
  "public.artifact_crypto_blobs.storage_ref",
  "public.artifact_crypto_blobs.terminal_at",
  "public.artifact_crypto_blobs.updated_at",
  "public.artifact_crypto_operations",
  "public.artifact_crypto_operations.anchor_namespace_id",
  "public.artifact_crypto_operations.artifact_id",
  "public.artifact_crypto_operations.artifact_row_id",
  "public.artifact_crypto_operations.attempt_count",
  "public.artifact_crypto_operations.completion",
  "public.artifact_crypto_operations.created_at",
  "public.artifact_crypto_operations.crypto_completed_at",
  "public.artifact_crypto_operations.disposition",
  "public.artifact_crypto_operations.expected_access_revision",
  "public.artifact_crypto_operations.expected_artifact_revision",
  "public.artifact_crypto_operations.expected_blob_generation",
  "public.artifact_crypto_operations.expected_blob_id",
  "public.artifact_crypto_operations.expected_required_namespace_fingerprint",
  "public.artifact_crypto_operations.failure_code",
  "public.artifact_crypto_operations.lease_expires_at",
  "public.artifact_crypto_operations.lease_token",
  "public.artifact_crypto_operations.next_attempt_at",
  "public.artifact_crypto_operations.operation_id",
  "public.artifact_crypto_operations.operation_type",
  "public.artifact_crypto_operations.request_digest",
  "public.artifact_crypto_operations.result_access_revision",
  "public.artifact_crypto_operations.result_artifact_revision",
  "public.artifact_crypto_operations.result_blob_generation",
  "public.artifact_crypto_operations.result_blob_id",
  "public.artifact_crypto_operations.sequence",
  "public.artifact_crypto_operations.target_required_namespace_fingerprint",
  "public.artifact_crypto_operations.updated_at",
  "public.artifact_crypto_revisions",
  "public.artifact_crypto_revisions.allocation_request_digest",
  "public.artifact_crypto_revisions.anchor_namespace_id",
  "public.artifact_crypto_revisions.artifact_id",
  "public.artifact_crypto_revisions.artifact_revision",
  "public.artifact_crypto_revisions.artifact_row_id",
  "public.artifact_crypto_revisions.attempt_count",
  "public.artifact_crypto_revisions.blob_generation",
  "public.artifact_crypto_revisions.blob_id",
  "public.artifact_crypto_revisions.blob_reference_state",
  "public.artifact_crypto_revisions.completion",
  "public.artifact_crypto_revisions.created_at",
  "public.artifact_crypto_revisions.crypto_completed_at",
  "public.artifact_crypto_revisions.crypto_object_id",
  "public.artifact_crypto_revisions.disposition",
  "public.artifact_crypto_revisions.failure_code",
  "public.artifact_crypto_revisions.lease_expires_at",
  "public.artifact_crypto_revisions.lease_token",
  "public.artifact_crypto_revisions.mime_class",
  "public.artifact_crypto_revisions.next_attempt_at",
  "public.artifact_crypto_revisions.payload_version",
  "public.artifact_crypto_revisions.required_namespace_fingerprint",
  "public.artifact_crypto_revisions.sequence",
  "public.artifact_crypto_revisions.size_bucket",
  "public.artifact_crypto_revisions.updated_at",
  "public.artifacts.blob_generation",
  "public.artifacts.blob_id",
  "public.artifacts.ciphertext_length",
  "public.artifacts.ciphertext_sha256",
  "public.artifacts.crypto_access_revision",
  "public.artifacts.crypto_lifecycle_state",
  "public.artifacts.crypto_object_id",
  "public.artifacts.crypto_required_namespace_fingerprint",
  "public.artifacts.mime_class",
  "public.artifacts.size_bucket",
  "public.reflection_record_authority_alternatives",
  "public.reflection_record_authority_alternatives.access_namespace_id",
  "public.reflection_record_authority_alternatives.alternative_commitment",
  "public.reflection_record_authority_alternatives.alternative_ordinal",
  "public.reflection_record_authority_alternatives.includes_public_boundary",
  "public.reflection_record_authority_alternatives.projection_generation",
  "public.reflection_record_authority_alternatives.record_id",
  "public.reflection_record_authority_blocks",
  "public.reflection_record_authority_blocks.block_id",
  "public.reflection_record_authority_blocks.created_at",
  "public.reflection_record_authority_blocks.disposition",
  "public.reflection_record_authority_blocks.record_id",
  "public.reflection_record_authority_blocks.terminal_leaf_handle",
  "public.reflection_record_authority_changes",
  "public.reflection_record_authority_changes.admitted_at",
  "public.reflection_record_authority_changes.change_id",
  "public.reflection_record_authority_changes.source_change_generation",
  "public.reflection_record_authority_changes.terminal_leaf_handle",
  "public.reflection_record_authority_closure",
  "public.reflection_record_authority_closure.closure_generation",
  "public.reflection_record_authority_closure.created_at",
  "public.reflection_record_authority_closure.record_id",
  "public.reflection_record_authority_closure.terminal_leaf_handle",
  "public.reflection_record_authority_projections",
  "public.reflection_record_authority_projections.audience_set_commitment",
  "public.reflection_record_authority_projections.computed_at",
  "public.reflection_record_authority_projections.current",
  "public.reflection_record_authority_projections.dirty_since",
  "public.reflection_record_authority_projections.processing_state",
  "public.reflection_record_authority_projections.projection_generation",
  "public.reflection_record_authority_projections.record_id",
  "public.reflection_record_authority_projections.source_change_generation",
  "public.reflection_record_authority_projections.unavailable_reason",
  "public.reflection_record_authority_projections.updated_at",
  "public.reflection_record_authority_reconciliations",
  "public.reflection_record_authority_reconciliations.attempt_count",
  "public.reflection_record_authority_reconciliations.completed_at",
  "public.reflection_record_authority_reconciliations.created_at",
  "public.reflection_record_authority_reconciliations.expected_projection_generation",
  "public.reflection_record_authority_reconciliations.failure_code",
  "public.reflection_record_authority_reconciliations.former_crypto_object_id",
  "public.reflection_record_authority_reconciliations.former_crypto_retired_at",
  "public.reflection_record_authority_reconciliations.lease_expires_at",
  "public.reflection_record_authority_reconciliations.lease_token",
  "public.reflection_record_authority_reconciliations.next_attempt_at",
  "public.reflection_record_authority_reconciliations.reconciliation_id",
  "public.reflection_record_authority_reconciliations.record_id",
  "public.reflection_record_authority_reconciliations.sealed_checkpoint",
  "public.reflection_record_authority_reconciliations.source_change_generation",
  "public.reflection_record_authority_reconciliations.state",
  "public.reflection_record_authority_reconciliations.target_crypto_object_id",
  "public.reflection_record_authority_reconciliations.target_representation_generation",
  "public.reflection_record_authority_reconciliations.updated_at",
] as const;

const WRITER_LOCATORS = [
  "packages/lattice-bridge/src/server/artifact/postgres-artifact-product-publication.ts#publish:raw_sql:insert:public.artifact_namespaces:1",
  "packages/lattice-bridge/src/server/artifact/postgres-artifact-product-publication.ts#publish:raw_sql:insert:public.artifacts:1",
  "packages/lattice-bridge/src/server/artifact/postgres-artifact-product-publication.ts#publish:raw_sql:update:public.artifact_crypto_blobs:1",
  "packages/lattice-bridge/src/server/artifact/postgres-artifact-product-publication.ts#publish:raw_sql:update:public.artifact_crypto_operations:1",
  "packages/lattice-bridge/src/server/artifact/postgres-artifact-product-publication.ts#publish:raw_sql:update:public.artifact_crypto_revisions:1",
  "packages/lattice-bridge/src/server/artifact/postgres-artifact-product-publication.ts#publish:raw_sql:update:public.artifacts:1",
  "packages/lattice-bridge/src/server/artifact/postgres-artifact-product-publication.ts#recordFailure:raw_sql:update:public.artifact_crypto_operations:1",
  "packages/lattice-bridge/src/server/artifact/postgres-artifact-product-publication.ts#recordFailure:raw_sql:update:public.artifacts:1",
  "packages/lattice-bridge/src/server/artifact/postgres-artifact-product-publication.ts#reserve:raw_sql:insert:public.artifact_crypto_blobs:1",
  "packages/lattice-bridge/src/server/artifact/postgres-artifact-product-publication.ts#reserve:raw_sql:insert:public.artifact_crypto_operations:1",
  "packages/lattice-bridge/src/server/artifact/postgres-artifact-product-publication.ts#reserve:raw_sql:insert:public.artifact_crypto_revisions:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#admitSourceChange:raw_sql:insert:public.reflection_record_authority_changes:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#admitSourceChange:raw_sql:insert:public.reflection_record_authority_reconciliations:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#admitSourceChange:raw_sql:update:public.reflection_record_authority_projections:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#admitSourceChange:raw_sql:update:public.reflection_record_authority_reconciliations:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#applyProjectionCas:raw_sql:insert:public.reflection_record_authority_alternatives:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#applyProjectionCas:raw_sql:insert:public.reflection_record_authority_closure:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#applyProjectionCas:raw_sql:insert:public.reflection_record_authority_projections:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#applyProjectionCas:raw_sql:insert:public.reflection_record_authority_reconciliations:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#applyProjectionCas:raw_sql:insert:public.reflection_record_payload_representations:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#applyProjectionCas:raw_sql:update:public.reflection_record_authority_projections:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#applyProjectionCas:raw_sql:update:public.reflection_record_payload_representation_heads:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#block:raw_sql:insert:public.reflection_record_authority_blocks:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#block:raw_sql:update:public.reflection_record_authority_blocks:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#block:raw_sql:update:public.reflection_records:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#claimDueReconciliations:raw_sql:update:public.reflection_record_authority_projections:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#claimDueReconciliations:raw_sql:update:public.reflection_record_authority_reconciliations:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#completeProtectedRetirement:raw_sql:update:public.reflection_record_authority_reconciliations:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#deferReconciliation:raw_sql:update:public.reflection_record_authority_projections:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#deferReconciliation:raw_sql:update:public.reflection_record_authority_reconciliations:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#installInitialClosure:raw_sql:insert:public.reflection_record_authority_closure:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#installInitialClosure:raw_sql:insert:public.reflection_record_authority_projections:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#recordProtectedCryptoComplete:raw_sql:insert:public.reflection_record_authority_reconciliations:1",
  "packages/reflection-bridge/src/server/postgres-authority-store.ts#recordProtectedCryptoComplete:raw_sql:update:public.reflection_record_authority_reconciliations:1",
] as const;

const PROTECTED_SCHEMA_LOCATORS = new Set<string>([
  "public.reflection_record_authority_reconciliations",
  "public.reflection_record_authority_reconciliations.sealed_checkpoint",
]);

const PROTECTED_WRITER_LOCATORS = new Set<string>([
  `${REFLECTION_AUTHORITY_STORE}#applyProjectionCas:raw_sql:insert:public.reflection_record_authority_reconciliations:1`,
  `${REFLECTION_AUTHORITY_STORE}#applyProjectionCas:raw_sql:insert:public.reflection_record_payload_representations:1`,
  `${REFLECTION_AUTHORITY_STORE}#deferReconciliation:raw_sql:update:public.reflection_record_authority_reconciliations:1`,
]);

function stableId(locator: string): string {
  return locator.replaceAll(/[^a-zA-Z0-9]+/gu, "-").toLowerCase();
}

function isArtifact(locator: string): boolean {
  return locator.includes("artifact");
}

function metadata(locator: string): EncryptionCoverageEntry {
  const artifact = isArtifact(locator);
  const owner = artifact ? "packages/lattice-bridge" : "packages/reflection-bridge";
  const writer = locator.includes("#")
    ? locator.slice(0, locator.indexOf("#"))
    : artifact
      ? "packages/db"
      : "packages/reflection-bridge";
  return {
    id: `db.main-2026-08-13-late-merge.${stableId(locator)}`,
    surface: "db",
    locator,
    owner,
    readers: [writer],
    writers: [writer],
    migrationState: "not_applicable",
    retention: artifact
      ? "Retained only as bounded Artifact ciphertext-routing, revision, namespace, digest, size-bucket, and restart-safe publication lifecycle metadata."
      : "Retained only as bounded Record authority closure, alternative, generation, commitment, retry, lease, block, and reconciliation metadata.",
    testEvidence: artifact
      ? locator.includes("#") ? [ARTIFACT_WRITER_EVIDENCE] : ARTIFACT_SCHEMA_EVIDENCE
      : locator.includes("#") ? [REFLECTION_WRITER_EVIDENCE] : REFLECTION_SCHEMA_EVIDENCE,
    classification: "bounded_metadata",
    metadataAllowlist: artifact
      ? [
        "opaque Artifact, blob, operation, crypto-object, and Namespace identifiers",
        "ciphertext digests, lengths, closed MIME and size buckets",
        "bounded revisions, generations, lifecycle enums, retries, leases, timestamps, and failure codes",
      ]
      : [
        "opaque Record, authority-leaf, Namespace, block, change, reconciliation, and crypto-object identifiers",
        "bounded commitments, generations, ordinals, lifecycle enums, retries, leases, timestamps, and failure codes",
      ],
    plaintextReason: artifact
      ? "These exact rows and writers carry ciphertext references plus bounded cryptographic control metadata; Artifact semantic bytes remain exclusively in the authenticated encrypted blob file."
      : "These exact rows and writers carry only authority coordinates and bounded control state; Record semantic payload remains in the separately protected representation boundary.",
  };
}

function protectedEntry(locator: string): EncryptionCoverageEntry {
  const writer = locator.includes("#")
    ? locator.slice(0, locator.indexOf("#"))
    : REFLECTION_AUTHORITY_STORE;
  return {
    id: `db.main-2026-08-13-late-merge.${stableId(locator)}`,
    surface: "db",
    locator,
    owner: "packages/reflection-bridge",
    readers: [REFLECTION_AUTHORITY_STORE],
    writers: [writer],
    migrationState: "ciphertext_only",
    retention:
      "Retained only as an authenticated sealed reconciliation checkpoint or an opaque protected Record representation coordinate until reconciliation or retirement completes.",
    testEvidence: [REFLECTION_WRITER_EVIDENCE, ...REFLECTION_SCHEMA_EVIDENCE],
    classification: "protected",
    keyFamily: "namespace_ai",
    bridgeRepository: REFLECTION_AUTHORITY_STORE,
    negativeTestEvidence: [
      REFLECTION_NEGATIVE_EVIDENCE,
      REFLECTION_WRITER_EVIDENCE,
    ],
  };
}

/** Reviewed combined inventory introduced by the late 2026-08-13 main merge. */
export const REVIEWED_MAIN_2026_08_13_LATE_MERGE_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
  ...SCHEMA_LOCATORS.map((locator) =>
    PROTECTED_SCHEMA_LOCATORS.has(locator) ? protectedEntry(locator) : metadata(locator)
  ),
  ...WRITER_LOCATORS.map((locator) =>
    PROTECTED_WRITER_LOCATORS.has(locator) ? protectedEntry(locator) : metadata(locator)
  ),
];
