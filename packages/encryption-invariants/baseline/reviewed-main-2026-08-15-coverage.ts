import type { EncryptionCoverageEntry } from "../src/model";
import type { ReviewedDebtLink } from "../src/registry";

const REVIEW_EVIDENCE =
  "packages/encryption-invariants/tests/integration/reviewed-main-2026-08-15-security.test.ts";
const REFLECTION_SCHEMA_EVIDENCE =
  "packages/db/tests/unit/reflection-record-schema.test.ts";
const REFLECTION_MIGRATION_EVIDENCE =
  "packages/db/tests/unit/migration-0172-m271-reflection-semantic-work.test.ts";
const REFLECTION_DEPENDENCY_REPAIR_MIGRATION_EVIDENCE =
  "packages/db/tests/unit/migration-0188-m287-record-dependency-repair.test.ts";
const REFLECTION_STORE_EVIDENCE =
  "packages/reflection-bridge/tests/unit/postgres-semantic-work-store.test.ts";
const REFLECTION_ROUTE_EVIDENCE =
  "packages/server/tests/unit/reflection-status-route.test.ts";
const MEDIA_SCHEMA_EVIDENCE =
  "packages/db/tests/unit/d525-media-generations-schema.test.ts";
const MEDIA_REPOSITORY_EVIDENCE =
  "packages/db/tests/unit/d525-media-generations-repository.test.ts";
const MEDIA_ROUTE_EVIDENCE =
  "packages/server/tests/unit-isolated/media-generations-route.test.ts";

const REFLECTION_SCHEMA_LOCATORS = [
  "public.reflection_record_semantic_work",
  "public.reflection_record_semantic_work.attempt_count",
  "public.reflection_record_semantic_work.change_reason",
  "public.reflection_record_semantic_work.claim_generation",
  "public.reflection_record_semantic_work.completed_at",
  "public.reflection_record_semantic_work.completed_generation",
  "public.reflection_record_semantic_work.created_at",
  "public.reflection_record_semantic_work.due_since",
  "public.reflection_record_semantic_work.failure_code",
  "public.reflection_record_semantic_work.generation",
  "public.reflection_record_semantic_work.lease_expires_at",
  "public.reflection_record_semantic_work.lease_token",
  "public.reflection_record_semantic_work.next_attempt_at",
  "public.reflection_record_semantic_work.quarantine_round",
  "public.reflection_record_semantic_work.record_id",
  "public.reflection_record_semantic_work.recover_after",
  "public.reflection_record_semantic_work.stage",
  "public.reflection_record_semantic_work.started_at",
  "public.reflection_record_semantic_work.state",
  "public.reflection_record_semantic_work.updated_at",
  "public.reflection_record_semantic_work_admissions",
  "public.reflection_record_semantic_work_admissions.admission_commitment",
  "public.reflection_record_semantic_work_admissions.assigned_generation",
  "public.reflection_record_semantic_work_admissions.created_at",
  "public.reflection_record_semantic_work_admissions.record_id",
  "public.reflection_record_dependency_change_repairs",
  "public.reflection_record_dependency_change_repairs.change_commitment",
  "public.reflection_record_dependency_change_repairs.changed_record_id",
  "public.reflection_record_dependency_change_repairs.completed_at",
  "public.reflection_record_dependency_change_repairs.continuation",
  "public.reflection_record_dependency_change_repairs.created_at",
  "public.reflection_record_dependency_change_repairs.updated_at",
  "public.reflection_record_source_change_repairs",
  "public.reflection_record_source_change_repairs.completed_at",
  "public.reflection_record_source_change_repairs.continuation",
  "public.reflection_record_source_change_repairs.created_at",
  "public.reflection_record_source_change_repairs.source_change_commitment",
  "public.reflection_record_source_change_repairs.source_dependency_commitment",
  "public.reflection_record_source_change_repairs.updated_at",
  "public.reflection_record_source_dependency_index",
  "public.reflection_record_source_dependency_index.created_at",
  "public.reflection_record_source_dependency_index.record_id",
  "public.reflection_record_source_dependency_index.source_dependency_commitment",
] as const;

const REFLECTION_WRITER_LOCATORS = [
  "packages/reflection-bridge/scripts/run-postgres-integration.ts#settleSyntheticSemanticWork:raw_sql:update:public.reflection_record_semantic_work:1",
  "packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#admitSemanticWorkWithinTransaction:raw_sql:insert:public.reflection_record_semantic_work:1",
  "packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#admitSemanticWorkWithinTransaction:raw_sql:insert:public.reflection_record_semantic_work_admissions:1",
  "packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#admitSemanticWorkWithinTransaction:raw_sql:update:public.reflection_record_semantic_work:1",
  "packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#checkpoint:raw_sql:update:public.reflection_record_semantic_work:1",
  "packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#claimNext:raw_sql:update:public.reflection_record_semantic_work:1",
  "packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#claimNext:raw_sql:update:public.reflection_record_semantic_work:2",
  "packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#complete:raw_sql:update:public.reflection_record_semantic_work:1",
  "packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#defer:raw_sql:update:public.reflection_record_semantic_work:1",
  "packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#indexSemanticSourceDependenciesWithinTransaction:raw_sql:insert:public.reflection_record_source_dependency_index:1",
  "packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#pause:raw_sql:update:public.reflection_record_semantic_work:1",
  "packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#repairSourceDependentsPage:raw_sql:update:public.reflection_record_source_change_repairs:1",
  "packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#repairSourceDependentsPage:raw_sql:update:public.reflection_record_source_change_repairs:2",
  "packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#reserveSourceRepair:raw_sql:insert:public.reflection_record_source_change_repairs:1",
] as const;

const MEDIA_METADATA_FIELDS = [
  "accepted_at",
  "admission_started_at",
  "admission_token",
  "approval_digest",
  "artifact_internal_id",
  "claim_expires_at",
  "claim_owner",
  "cleanup_completed_at",
  "cleanup_state",
  "created_at",
  "id",
  "kind",
  "namespace_id",
  "next_attempt_at",
  "owner_id",
  "provider",
  "provider_account_fingerprint",
  "provider_model",
  "provider_queue_id",
  "quote_digest",
  "quoted_usd_micros",
  "ready_at",
  "receipt_id",
  "retain_until",
  "revision",
  "room_id",
  "safe_failure",
  "safe_snapshot",
  "state",
  "terminal_at",
  "updated_at",
] as const;

function stableId(locator: string): string {
  return locator.replaceAll(/[^a-zA-Z0-9]+/gu, "-").toLowerCase();
}

function repository(locator: string): string {
  return locator.split("#", 1)[0]!;
}

const reflectionEntries: readonly EncryptionCoverageEntry[] = [
  ...REFLECTION_SCHEMA_LOCATORS,
  ...REFLECTION_WRITER_LOCATORS,
].map((locator) => ({
  id: `db.main-2026-08-15.reflection-work-${stableId(locator)}`,
  surface: "db",
  locator,
  owner: locator.includes("#") ? "packages/reflection-bridge" : "packages/db",
  readers: ["packages/reflection-bridge", "packages/runtime"],
  writers: [repository(locator)],
  migrationState: "not_applicable",
  retention:
    "Retained only as bounded Reflection work, admission, dependency, retry, lease, generation, commitment, and lifecycle coordination state.",
  testEvidence: [
    REVIEW_EVIDENCE,
    REFLECTION_SCHEMA_EVIDENCE,
    REFLECTION_MIGRATION_EVIDENCE,
    REFLECTION_DEPENDENCY_REPAIR_MIGRATION_EVIDENCE,
    REFLECTION_STORE_EVIDENCE,
  ],
  classification: "bounded_metadata",
  metadataAllowlist: [
    "opaque Record identity and fixed source-change commitments",
    "bounded generation, attempt, recovery-round, and checkpoint coordinates",
    "closed work stage, state, change-reason, and failure-code enums",
    "lease, retry, completion, creation, and update timestamps",
  ],
  plaintextReason:
    "M271/M287 explicitly forbid statements, Message or Memory bodies, embeddings, prompts, model responses, keys, and audience lists in these tables and writers; they contain only content-free durable work coordination.",
}));

const mediaMetadataEntries: readonly EncryptionCoverageEntry[] =
  MEDIA_METADATA_FIELDS.map((field) => ({
    id: `db.main-2026-08-15.media-generation-${field.replaceAll("_", "-")}`,
    surface: "db",
    locator: `public.media_generations.${field}`,
    owner: "packages/db",
    readers: ["packages/db/src/queries/media-generations.ts"],
    writers: ["packages/db/src/queries/media-generations.ts"],
    migrationState: "not_applicable",
    retention:
      "Retained only for the bounded paid-media generation, reconciliation, Artifact-publication, failure-recovery, and cleanup lifecycle.",
    testEvidence: [
      REVIEW_EVIDENCE,
      MEDIA_SCHEMA_EVIDENCE,
      MEDIA_REPOSITORY_EVIDENCE,
    ],
    classification: "bounded_metadata",
    metadataAllowlist: [field],
    plaintextReason:
      "This exact field is limited to an opaque identity, digest, provider/model coordinate, closed lifecycle or safe-failure value, normalized setting/count summary, price, revision, or timestamp. Creative prompt and lyrics remain separately linked plaintext debt.",
  }));

const wireEntries: readonly EncryptionCoverageEntry[] = [
  {
    id: "wire.main-2026-08-15.reflection-status",
    surface: "wire",
    locator: "http:request_response:GET /api/admin/reflection-status",
    owner: "packages/server",
    readers: ["packages/api-client/src/client.ts"],
    writers: ["packages/server/src/routes/reflection-status.ts"],
    migrationState: "not_applicable",
    retention: "The capability-gated status projection exists only for the current request.",
    testEvidence: [REVIEW_EVIDENCE, REFLECTION_ROUTE_EVIDENCE],
    classification: "bounded_metadata",
    metadataAllowlist: [
      "content-free work, projection, stage, health, attempt, and failure-code counts",
      "bounded health-window and recovery timestamps",
    ],
    plaintextReason:
      "The route intentionally emits aggregate counts, ages, closed failure codes, and timestamps only; it excludes Record IDs, statements, queries, prompts, source excerpts, keys, audiences, and evidence content.",
  },
  {
    id: "wire.main-2026-08-15.media-generation-status",
    surface: "wire",
    locator: "http:request_response:GET /api/media-generations/:receiptId",
    owner: "packages/server",
    readers: ["packages/api-client/src/client.ts"],
    writers: ["packages/server/src/routes/media-generations.ts"],
    migrationState: "not_applicable",
    retention: "The authorized receipt projection exists only for the current request.",
    testEvidence: [REVIEW_EVIDENCE, MEDIA_ROUTE_EVIDENCE],
    classification: "bounded_metadata",
    metadataAllowlist: [
      "opaque receipt and Artifact identity",
      "closed lifecycle, recovery, failure, cleanup, kind, and progress values",
      "model identifier, normalized settings, byte count, MIME type, path, revision, and price-free status",
    ],
    plaintextReason:
      "The route explicitly projects a presentation-safe receipt and never returns the durable creative prompt, lyrics, provider queue identity, admission token, provider response, delivery URL, credential, or generated media bytes.",
  },
  {
    id: "db.main-2026-08-15.reflection-model",
    surface: "db",
    locator: "public.server_model_config.reflection_model",
    owner: "packages/db",
    readers: ["packages/db/src/utils/server-model-config-queries.ts"],
    writers: ["packages/db/src/utils/server-model-config-queries.ts"],
    migrationState: "not_applicable",
    retention: "Retained as the operator-selected Reflection model identifier.",
    testEvidence: [REVIEW_EVIDENCE, "packages/db/tests/unit/server-model-config-defaults.test.ts"],
    classification: "bounded_metadata",
    metadataAllowlist: ["reflection_model"],
    plaintextReason:
      "This field contains only a model catalogue identifier and no prompt, response, provider credential, Record content, Human identity, or cryptographic material.",
  },
];

export const REVIEWED_MAIN_2026_08_15_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
  ...reflectionEntries,
  ...mediaMetadataEntries,
  ...wireEntries,
];

export const REVIEWED_MAIN_2026_08_15_DEBT_LINKS:
  readonly ReviewedDebtLink[] = [
  "public.media_generations",
  "public.media_generations.request_payload",
].map((locator, index) => ({
  id: `link.db.main-2026-08-15.media-generation-request-${index + 1}`,
  surface: "db",
  locator,
  owner: "packages/db",
  targetDebtIds: ["debt.db.public.tasks.prompt"],
  reason:
    "The durable media-generation request repeats the same Human-directed creative prompt content class already frozen for durable Task prompts; optional lyrics are additional Human-authored creative text and are not bounded metadata.",
  testEvidence: [REVIEW_EVIDENCE, MEDIA_SCHEMA_EVIDENCE, MEDIA_REPOSITORY_EVIDENCE],
  crossBoundaryProjection: {
    fields: ["request_payload.prompt", "request_payload.lyrics"],
    rationale:
      "Only the exact prompt and optional lyrics fields inherit content debt; the remaining receipt columns are independently allowlisted lifecycle metadata.",
  },
}));
