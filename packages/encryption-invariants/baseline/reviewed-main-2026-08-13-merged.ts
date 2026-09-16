import type { EncryptionCoverageEntry } from "../src/model";
import type { ReviewedDebtLink } from "../src/registry";

const STORE =
  "packages/reflection-bridge/src/server/postgres-record-product-store.ts";
const STORE_EVIDENCE =
  "packages/reflection-bridge/tests/unit/dual-mode-record-repository.test.ts";
const CRYPTO_EVIDENCE =
  "packages/reflection-bridge/tests/unit/protected-record-crypto.test.ts";
const SCHEMA_EVIDENCE =
  "packages/db/tests/unit/reflection-record-schema.test.ts";
const MIGRATION_EVIDENCE =
  "packages/db/tests/unit/migration-0159-m257-reflection-records.test.ts";

const REFLECTION_SCHEMA_LOCATORS = [
  "public.reflection_record_dependencies",
  "public.reflection_record_dependencies.child_record_id",
  "public.reflection_record_dependencies.parent_record_id",
  "public.reflection_record_payload_representation_heads",
  "public.reflection_record_payload_representation_heads.current_representation_generation",
  "public.reflection_record_payload_representation_heads.record_id",
  "public.reflection_record_payload_representation_heads.representation",
  "public.reflection_record_payload_representation_heads.updated_at",
  "public.reflection_record_payload_representations.created_at",
  "public.reflection_record_payload_representations.crypto_object_id",
  "public.reflection_record_payload_representations.payload_version",
  "public.reflection_record_payload_representations.record_id",
  "public.reflection_record_payload_representations.representation",
  "public.reflection_record_payload_representations.representation_generation",
  "public.reflection_record_publications",
  "public.reflection_record_publications.attempt_count",
  "public.reflection_record_publications.completed_at",
  "public.reflection_record_publications.created_at",
  "public.reflection_record_publications.crypto_completed_at",
  "public.reflection_record_publications.crypto_object_id",
  "public.reflection_record_publications.crypto_retired_at",
  "public.reflection_record_publications.failure_code",
  "public.reflection_record_publications.lease_expires_at",
  "public.reflection_record_publications.lease_token",
  "public.reflection_record_publications.next_attempt_at",
  "public.reflection_record_publications.payload_version",
  "public.reflection_record_publications.product_attached_at",
  "public.reflection_record_publications.publication_binding_ref",
  "public.reflection_record_publications.publication_id",
  "public.reflection_record_publications.record_id",
  "public.reflection_record_publications.representation",
  "public.reflection_record_publications.representation_generation",
  "public.reflection_record_publications.request_commitment",
  "public.reflection_record_publications.state",
  "public.reflection_record_publications.updated_at",
  "public.reflection_record_successors",
  "public.reflection_record_successors.created_at",
  "public.reflection_record_successors.predecessor_record_id",
  "public.reflection_record_successors.relation",
  "public.reflection_record_successors.successor_record_id",
  "public.reflection_records",
  "public.reflection_records.created_at",
  "public.reflection_records.disposition",
  "public.reflection_records.lifecycle",
  "public.reflection_records.payload_version",
  "public.reflection_records.processing_generation",
  "public.reflection_records.producer_policy_version",
  "public.reflection_records.record_id",
  "public.reflection_records.structural_height",
  "public.reflection_records.updated_at",
] as const;

const METADATA_WRITERS = [
  "packages/reflection-bridge/scripts/run-postgres-integration.ts#query:raw_sql:unresolved:unresolved.dynamic_sql:1",
  `${STORE}##dispose:raw_sql:update:public.reflection_record_publications:1`,
  `${STORE}##dispose:raw_sql:update:public.reflection_records:1`,
  `${STORE}##insertGraph:raw_sql:insert:public.reflection_record_dependencies:1`,
  `${STORE}##insertGraph:raw_sql:insert:public.reflection_record_successors:1`,
  `${STORE}##insertGraph:raw_sql:insert:public.reflection_records:1`,
  `${STORE}##insertGraph:raw_sql:update:public.reflection_records:1`,
  `${STORE}#attachProtected:raw_sql:insert:public.reflection_record_payload_representation_heads:1`,
  `${STORE}#attachProtected:raw_sql:update:public.reflection_record_publications:1`,
  `${STORE}#claimDueProtected:raw_sql:update:public.reflection_record_publications:1`,
  `${STORE}#completeProtected:raw_sql:update:public.reflection_record_publications:1`,
  `${STORE}#completeProtectedRetirement:raw_sql:delete:public.reflection_record_payload_representation_heads:1`,
  `${STORE}#completeProtectedRetirement:raw_sql:update:public.reflection_record_publications:1`,
  `${STORE}#failProtected:raw_sql:update:public.reflection_record_publications:1`,
  `${STORE}#markProtectedCryptoComplete:raw_sql:update:public.reflection_record_publications:1`,
  `${STORE}#publishOrdinary:raw_sql:insert:public.reflection_record_payload_representation_heads:1`,
  `${STORE}#publishOrdinary:raw_sql:insert:public.reflection_record_publications:1`,
  `${STORE}#purge:raw_sql:delete:public.reflection_record_payload_representation_heads:1`,
  `${STORE}#readGraphPage:raw_sql:unresolved:unresolved.dynamic_sql:1`,
  `${STORE}#reserveProtected:raw_sql:insert:public.reflection_record_publications:1`,
] as const;

const PROTECTED_WRITERS = [
  `${STORE}#attachProtected:raw_sql:insert:public.reflection_record_payload_representations:1`,
  `${STORE}#completeProtectedRetirement:raw_sql:delete:public.reflection_record_payload_representations:1`,
  `${STORE}#publishOrdinary:raw_sql:insert:public.reflection_record_payload_representations:1`,
  `${STORE}#purge:raw_sql:delete:public.reflection_record_payload_representations:1`,
] as const;

function stableId(locator: string): string {
  return locator.replaceAll(/[^a-zA-Z0-9]+/gu, "-").toLowerCase();
}

const metadata = (
  locator: string,
  owner: string,
  evidence: readonly string[],
): EncryptionCoverageEntry => ({
  id: `db.main-2026-08-13-merged.${stableId(locator)}`,
  surface: "db",
  locator,
  owner,
  readers: [owner],
  writers: [owner],
  migrationState: "not_applicable",
  retention:
    "Retained only as bounded Record identity, graph, representation, lifecycle, retry, lease, commitment, and publication-coordinate state.",
  testEvidence: evidence,
  classification: "bounded_metadata",
  metadataAllowlist: [
    "opaque Record, publication, representation, and crypto-object identifiers",
    "bounded graph edges, lifecycle enums, counters, hashes, leases, timestamps, and failure codes",
  ],
  plaintextReason:
    "These exact rows carry only bounded identifiers and control state. Record semantic content is isolated in the separately classified payload-bytes field and payload writer.",
});

const protectedPayload = (
  locator: string,
  migrationState: "shadow" | "ciphertext_only",
): EncryptionCoverageEntry => ({
  id: `db.main-2026-08-13-merged.${stableId(locator)}`,
  surface: "db",
  locator,
  owner: "packages/reflection-bridge",
  readers: [STORE],
  writers: [STORE],
  migrationState,
  retention:
    "Retained as the selected immutable Record payload representation until an authorized purge retires that representation.",
  testEvidence: [STORE_EVIDENCE, SCHEMA_EVIDENCE, MIGRATION_EVIDENCE],
  classification: "protected",
  keyFamily: "namespace_ai",
  bridgeRepository: STORE,
  negativeTestEvidence: [STORE_EVIDENCE, CRYPTO_EVIDENCE],
});

export const REVIEWED_MAIN_2026_08_13_MERGED_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
  ...REFLECTION_SCHEMA_LOCATORS.map((locator) =>
    metadata(locator, "packages/db", [SCHEMA_EVIDENCE, MIGRATION_EVIDENCE])
  ),
  protectedPayload("public.reflection_record_payload_representations", "shadow"),
  protectedPayload(
    "public.reflection_record_payload_representations.plaintext_payload_bytes",
    "shadow",
  ),
  ...METADATA_WRITERS.map((locator) =>
    metadata(locator, "packages/reflection-bridge", [STORE_EVIDENCE])
  ),
  ...PROTECTED_WRITERS.map((locator) =>
    protectedPayload(
      locator,
      locator.includes("#publishOrdinary:") ? "shadow" : "ciphertext_only",
    )
  ),
  {
    id: "wire.main-2026-08-13-merged.room-catalog-changed",
    surface: "wire",
    locator: "ws:server_to_client:room.catalog.changed",
    owner: "packages/server",
    readers: ["apps/workbench", "apps/mobile"],
    writers: ["packages/server/src/realtime/ws-publisher.ts"],
    migrationState: "not_applicable",
    retention: "Ephemeral viewer-private invalidation hint; it is never persisted.",
    testEvidence: ["packages/server/tests/unit/ws-publisher.test.ts"],
    classification: "bounded_metadata",
    metadataAllowlist: ["fixed room.catalog.changed event discriminator"],
    plaintextReason:
      "The frame contains no Room, Human, Agent, message, or artifact identifier and only tells an authenticated viewer to refetch its authorized Room catalogue.",
  },
];

export const REVIEWED_MAIN_2026_08_13_MERGED_DEBT_LINKS:
  readonly ReviewedDebtLink[] = [
  {
    id: "link.wire.main-2026-08-13-merged.resolve-landing-room-detail",
    surface: "wire",
    locator: "http:request_response:POST /api/rooms/resolve-landing",
    owner: "packages/server",
    targetDebtIds: ["debt.wire.http.request.response.get.api.rooms.id.7993e"],
    reason:
      "The authenticated landing resolver returns the same already-frozen Room-detail projection; it adds selection and idempotent membership behavior but no new content class.",
    testEvidence: [
      "packages/server/tests/integration/m259-guest-landing.integration.test.ts",
    ],
  },
  ...[
    {
      endpoint: "approval-reply",
      target: "debt.wire.http.request.response.post.api.auth.approval.reply.p3nnrh",
      fields: ["capability", "code"],
    },
    {
      endpoint: "identity-verify-resume",
      target: "debt.wire.http.request.response.post.api.auth.identity.verify.resume.g7jmt3",
      fields: ["capability", "code", "error"],
    },
    {
      endpoint: "pin",
      target: "debt.wire.http.request.response.post.api.auth.pin.sj48n2",
      fields: ["capability", "code", "error"],
    },
    {
      endpoint: "prove-and-resume",
      target: "debt.wire.http.request.response.post.api.auth.prove.and.resume.1049ell",
      fields: ["capability", "code"],
    },
  ].flatMap(({ endpoint, target, fields }) => fields.map((field) => ({
    id: `link.wire.main-2026-08-13-merged.auth-${endpoint}-${field}`,
    surface: "wire" as const,
    locator: `http:request_response:POST /api/auth/${endpoint}#response.body.${field}`,
    owner: "packages/server",
    targetDebtIds: [target],
    reason:
      "The generic response helper exposes an open type for an exact field already contained by this frozen authenticated authorization endpoint; it introduces no new semantic content class.",
    testEvidence: ["packages/server/tests/unit-isolated/approval-reply.test.ts"],
  }))),
];
