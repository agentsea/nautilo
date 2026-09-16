import type { EncryptionCoverageEntry } from "../src/model";
import type { ReviewedDebtLink } from "../src/registry";

const ARTIFACT_ROUTE =
  "packages/server/src/routes/protected-artifact-routes.ts";
const ARTIFACT_CRYPTO_EVIDENCE =
  "packages/lattice-bridge/tests/unit/postgres-human-artifact-exact-access-crypto.test.ts";
const ARTIFACT_PRODUCT_EVIDENCE =
  "packages/lattice-bridge/tests/unit/postgres-human-artifact-exact-access-product.test.ts";
const ARTIFACT_ROUTE_EVIDENCE =
  "packages/server/tests/unit-isolated/protected-artifact-routes.test.ts";
const ARTIFACT_CLIENT_EVIDENCE =
  "packages/api-client/tests/unit/protected-artifact-methods-contract.test.ts";
const REFLECTION_PROJECTION_EVIDENCE =
  "packages/reflection-bridge/tests/unit/postgres-record-search-projection-store.test.ts";
const REFLECTION_PURGE_EVIDENCE =
  "packages/reflection-bridge/tests/unit/postgres-record-product-store.test.ts";
const REFLECTION_SCHEMA_EVIDENCE =
  "packages/db/tests/unit/reflection-record-schema.test.ts";
const REFLECTION_MIGRATION_EVIDENCE =
  "packages/db/tests/unit/migration-0166-m264-reflection-search.test.ts";
const D513_WS_EVIDENCE = "packages/server/tests/unit/ws-route.test.ts";
const D513_BINDING_EVIDENCE =
  "packages/server/tests/unit/client-action-binding-registry.test.ts";
const MODEL_EVIDENCE = "packages/server/tests/unit/config-model-controls.test.ts";

const ARTIFACT_PROTECTED_WRITERS = [
  "packages/lattice-bridge/src/server/artifact/postgres-human-artifact-crypto-completion.ts#insertExact:raw_sql:insert:public.crypto_objects:1",
  "packages/lattice-bridge/src/server/artifact/postgres-human-artifact-crypto-completion.ts#insertExact:raw_sql:insert:public.object_crypto_access_heads:1",
  "packages/lattice-bridge/src/server/artifact/postgres-human-artifact-crypto-completion.ts#insertExact:raw_sql:insert:public.object_crypto_access_manifests:1",
  "packages/lattice-bridge/src/server/artifact/postgres-human-artifact-crypto-completion.ts#insertExact:raw_sql:insert:public.object_crypto_namespace_envelopes:1",
  "packages/lattice-bridge/src/server/artifact/postgres-human-artifact-exact-access-crypto.ts#complete:raw_sql:insert:public.object_crypto_access_manifests:1",
  "packages/lattice-bridge/src/server/artifact/postgres-human-artifact-exact-access-crypto.ts#complete:raw_sql:insert:public.object_crypto_namespace_envelopes:1",
  "packages/lattice-bridge/src/server/artifact/postgres-human-artifact-exact-access-crypto.ts#complete:raw_sql:update:public.object_crypto_access_heads:1",
] as const;

const ARTIFACT_PRODUCT_WRITERS = [
  "packages/lattice-bridge/src/server/artifact/postgres-artifact-product-publication.ts##insertReservation:raw_sql:insert:public.artifact_crypto_operations:1",
  "packages/lattice-bridge/src/server/artifact/postgres-human-artifact-exact-access-product.ts#commit:raw_sql:delete:public.artifact_namespaces:1",
  "packages/lattice-bridge/src/server/artifact/postgres-human-artifact-exact-access-product.ts#commit:raw_sql:insert:public.artifact_namespaces:1",
  "packages/lattice-bridge/src/server/artifact/postgres-human-artifact-exact-access-product.ts#commit:raw_sql:update:public.artifact_crypto_operations:1",
  "packages/lattice-bridge/src/server/artifact/postgres-human-artifact-exact-access-product.ts#commit:raw_sql:update:public.artifacts:1",
  "packages/lattice-bridge/src/server/artifact/postgres-human-artifact-exact-access-product.ts#reserve:raw_sql:insert:public.artifact_crypto_operations:1",
] as const;

const ARTIFACT_PROTECTED_ROUTES = [
  "http:request_response:GET /api/protected/artifacts",
  "http:request_response:GET /api/protected/artifacts/:artifactId",
  "http:request_response:GET /api/protected/artifacts/:artifactId/ciphertext",
  "http:request_response:POST /api/protected/artifacts/:artifactId/access",
  "http:request_response:POST /api/protected/artifacts/:artifactId/publication",
  "http:request_response:PUT /api/protected/artifacts/:artifactId/ciphertext/:operationId",
] as const;

const ARTIFACT_METADATA_ROUTES = [
  "http:request_response:GET /api/protected/artifacts#request.query",
  "http:request_response:POST /api/protected/artifacts/:artifactId/access-plan",
  "http:request_response:POST /api/protected/artifacts/publication-plan",
] as const;

const REFLECTION_METADATA_SCHEMA = [
  "public.reflection_record_search_projections.created_at",
  "public.reflection_record_search_projections.embedding_canonical_model",
  "public.reflection_record_search_projections.embedding_contract_version",
  "public.reflection_record_search_projections.embedding_dimensions",
  "public.reflection_record_search_projections.embedding_provider",
  "public.reflection_record_search_projections.projection_generation",
  "public.reflection_record_search_projections.projection_version",
  "public.reflection_record_search_projections.record_id",
  "public.reflection_record_search_projections.record_processing_generation",
  "public.reflection_record_search_projections.updated_at",
] as const;

const REFLECTION_FIXTURE_WRITERS = [
  "packages/reflection-bridge/scripts/run-postgres-integration.ts#<module>:raw_sql:insert:public.namespaces:1",
  "packages/reflection-bridge/scripts/run-postgres-integration.ts#<module>:raw_sql:insert:public.rooms:1",
  "packages/reflection-bridge/scripts/run-postgres-integration.ts#createAccessMapping:raw_sql:insert:public.namespaces:1",
  "packages/reflection-bridge/scripts/run-postgres-integration.ts#createAccessMapping:raw_sql:insert:public.rooms:1",
  "packages/reflection-bridge/scripts/run-postgres-integration.ts#publishConformanceFixture:raw_sql:insert:public.reflection_record_payload_representation_heads:1",
  "packages/reflection-bridge/scripts/run-postgres-integration.ts#publishConformanceFixture:raw_sql:insert:public.reflection_record_payload_representations:1",
  "packages/reflection-bridge/scripts/run-postgres-integration.ts#publishConformanceFixture:raw_sql:update:public.reflection_record_authority_projections:1",
  "packages/reflection-bridge/scripts/run-postgres-integration.ts#settleSyntheticIntegrationReceipts:raw_sql:update:public.reflection_record_authority_reconciliations:1",
] as const;

const REFLECTION_VECTOR_LOCATORS = [
  "public.reflection_record_search_projections",
  "public.reflection_record_search_projections.embedding",
  "packages/reflection-bridge/src/server/postgres-record-product-store.ts##dispose:raw_sql:delete:public.reflection_record_search_projections:1",
  "packages/reflection-bridge/src/server/postgres-record-search-projection-store.ts#publish:raw_sql:insert:public.reflection_record_search_projections:1",
  "packages/reflection-bridge/src/server/postgres-record-search-projection-store.ts#remove:raw_sql:delete:public.reflection_record_search_projections:1",
  "packages/reflection-bridge/src/server/postgres-record-search-projection-store.ts#replace:raw_sql:update:public.reflection_record_search_projections:1",
] as const;

function stableId(locator: string): string {
  return locator.replaceAll(/[^a-zA-Z0-9]+/gu, "-").toLowerCase();
}

function repository(locator: string): string {
  const marker = locator.indexOf("#");
  return marker < 0 ? locator : locator.slice(0, marker);
}

const artifactProtectedWriterEntries: readonly EncryptionCoverageEntry[] =
  ARTIFACT_PROTECTED_WRITERS.map((locator) => {
    const bridgeRepository = repository(locator);
    return {
      id: `db.main-2026-08-14.artifact-protected-${stableId(locator)}`,
      surface: "db",
      locator,
      owner: "packages/lattice-bridge",
      readers: [bridgeRepository],
      writers: [bridgeRepository],
      migrationState: "ciphertext_only",
      retention:
        "Retained only as authenticated encrypted Artifact object state, signed access state, and exact wrapped Human Namespace envelopes.",
      testEvidence: [ARTIFACT_CRYPTO_EVIDENCE],
      classification: "protected",
      keyFamily: "namespace_human",
      bridgeRepository,
      negativeTestEvidence: [ARTIFACT_CRYPTO_EVIDENCE],
    };
  });

const artifactProductWriterEntries: readonly EncryptionCoverageEntry[] =
  ARTIFACT_PRODUCT_WRITERS.map((locator) => {
    const writer = repository(locator);
    return {
      id: `db.main-2026-08-14.artifact-product-${stableId(locator)}`,
      surface: "db",
      locator,
      owner: "packages/lattice-bridge",
      readers: [writer],
      writers: [writer],
      migrationState: "not_applicable",
      retention:
        "Retained only for the bounded Artifact publication or exact-access lifecycle and its idempotent replay receipt.",
      testEvidence: [ARTIFACT_PRODUCT_EVIDENCE],
      classification: "bounded_metadata",
      metadataAllowlist: [
        "Artifact, blob, operation, object, and Namespace identifiers",
        "artifact, blob, access, binding, and policy revision counters",
        "canonical Namespace fingerprints and authenticated request digests",
        "bounded lifecycle, lease, deadline, failure, and terminal state",
      ],
      plaintextReason:
        "These writers change only product attachment edges, counters, fingerprints, and content-free lifecycle receipts; encrypted Artifact bytes, controls, manifests, envelopes, roots, and keys are excluded.",
    };
  });

const artifactProtectedRouteEntries: readonly EncryptionCoverageEntry[] =
  ARTIFACT_PROTECTED_ROUTES.map((locator) => ({
    id: `wire.main-2026-08-14.artifact-protected-${stableId(locator)}`,
    surface: "wire",
    locator,
    owner: "packages/server",
    readers: ["packages/api-client/src/client.ts"],
    writers: [ARTIFACT_ROUTE],
    migrationState: "ciphertext_only",
    retention:
      "The authenticated request is transient; retained state is limited to encrypted Artifact bytes, signed access material, wrapped Namespace envelopes, digests, and bounded replay coordinates.",
    testEvidence: [ARTIFACT_ROUTE_EVIDENCE, ARTIFACT_CLIENT_EVIDENCE],
    classification: "protected",
    keyFamily: "namespace_human",
    bridgeRepository: ARTIFACT_ROUTE,
    negativeTestEvidence: [ARTIFACT_ROUTE_EVIDENCE],
  }));

const artifactMetadataRouteEntries: readonly EncryptionCoverageEntry[] =
  ARTIFACT_METADATA_ROUTES.map((locator) => ({
    id: `wire.main-2026-08-14.artifact-metadata-${stableId(locator)}`,
    surface: "wire",
    locator,
    owner: "packages/server",
    readers: ["packages/api-client/src/client.ts"],
    writers: [ARTIFACT_ROUTE],
    migrationState: "not_applicable",
    retention:
      "The bounded listing or access/publication plan exists only for the authenticated request and expires at its declared deadline.",
    testEvidence: [ARTIFACT_ROUTE_EVIDENCE, ARTIFACT_CLIENT_EVIDENCE],
    classification: "bounded_metadata",
    metadataAllowlist: [
      "cursor, limit, and archive-selection controls",
      "Artifact, operation, object, blob, Namespace, and Domain identifiers",
      "revision counters, binding hashes, size buckets, lifecycle enums, and deadline",
    ],
    plaintextReason:
      "The route carries only authenticated identifiers, counters, hashes, closed lifecycle values, and authorization-plan coordinates; it carries no Artifact plaintext, key, root, or decrypted payload.",
  }));

const reflectionMetadataEntries: readonly EncryptionCoverageEntry[] = [
  ...REFLECTION_METADATA_SCHEMA,
  ...REFLECTION_FIXTURE_WRITERS,
].map((locator) => ({
  id: `db.main-2026-08-14.reflection-metadata-${stableId(locator)}`,
  surface: "db",
  locator,
  owner: locator.includes("scripts/") ? "packages/reflection-bridge" : "packages/db",
  readers: ["packages/reflection-bridge"],
  writers: [repository(locator)],
  migrationState: "not_applicable",
  retention:
    "Retained only as bounded synthetic-conformance or search-projection identity, generation, provenance, lifecycle, and timestamp state.",
  testEvidence: [
    REFLECTION_SCHEMA_EVIDENCE,
    REFLECTION_MIGRATION_EVIDENCE,
    REFLECTION_PROJECTION_EVIDENCE,
  ],
  classification: "bounded_metadata",
  metadataAllowlist: [
    "opaque Record, Namespace, Room, Human, representation, and reconciliation identifiers",
    "projection, processing, representation, and authority generations",
    "fixed vector dimension and contract versions plus portable provider/model provenance",
    "bounded lifecycle, timestamp, and synthetic conformance state",
  ],
  plaintextReason:
    "These exact fields and fixture statements contain only bounded coordinates or deterministic synthetic conformance values. The separately linked embedding vector remains explicit plaintext debt and no Record statement, query, source coordinate, key, Grant, or protected payload is classified here.",
}));

const clientSessionEntries: readonly EncryptionCoverageEntry[] = [
  "ws:server_to_client:client.session.v1",
  "http:accepted_arbitrary:packages/server/src/messaging/dispatch.ts#RoomPostMessageBody#clientActionSessionId",
  "http:request_response:POST /api/rooms/:roomId/messages#request.body.clientActionSessionId",
].map((locator) => ({
  id: `wire.main-2026-08-14.client-session-${stableId(locator)}`,
  surface: "wire",
  locator,
  owner: "packages/server",
  readers: ["apps/workbench", "apps/mobile", "packages/server"],
  writers: ["packages/server/src/routes/ws.ts"],
  migrationState: "not_applicable",
  retention:
    "The random socket-session identifier is memory-only and is deleted on consumption, expiry, failed acceptance, disconnect, or reconnect.",
  testEvidence: [D513_WS_EVIDENCE, D513_BINDING_EVIDENCE],
  classification: "bounded_metadata",
  metadataAllowlist: ["22-character server-minted client action session identifier"],
  plaintextReason:
    "The identifier selects one live exact-client presentation path but is not a credential, capability, Device identity, Room fact, durable transcript field, or source of mutation authority.",
}));

const modelResolveEntry: EncryptionCoverageEntry = {
  id: "wire.main-2026-08-14.config-models-resolve",
  surface: "wire",
  locator: "http:request_response:POST /api/config/models/resolve",
  owner: "packages/server",
  readers: ["packages/api-client/src/client.ts"],
  writers: ["packages/server/src/routes/config.ts"],
  migrationState: "not_applicable",
  retention:
    "The bounded retained-model resolution request and response exist only for the current configuration request and are not persisted.",
  testEvidence: [MODEL_EVIDENCE],
  classification: "bounded_metadata",
  metadataAllowlist: [
    "bounded model identifiers and purpose enum",
    "provider, capability, availability, routing, pricing, and serving-profile metadata",
    "allow-China-upstream selection boolean",
  ],
  plaintextReason:
    "The endpoint carries only model catalogue and routing metadata; it contains no prompt, message, credential, provider key, Human profile, or Artifact content.",
};

export const REVIEWED_MAIN_2026_08_14_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
  ...artifactProtectedWriterEntries,
  ...artifactProductWriterEntries,
  ...artifactProtectedRouteEntries,
  ...artifactMetadataRouteEntries,
  ...reflectionMetadataEntries,
  ...clientSessionEntries,
  modelResolveEntry,
];

/**
 * M264 deliberately retains the same rebuildable plaintext semantic vector
 * class already frozen for Memory embeddings. It is not protected and must
 * never be hidden inside a metadata classification.
 */
export const REVIEWED_MAIN_2026_08_14_DEBT_LINKS:
  readonly ReviewedDebtLink[] = REFLECTION_VECTOR_LOCATORS.map(
  (locator, index) => ({
    id: `link.db.main-2026-08-14.reflection-plaintext-vector-${index + 1}`,
    surface: "db",
    locator,
    owner: locator.includes("#") ? "packages/reflection-bridge" : "packages/db",
    targetDebtIds: ["debt.db.public.memories.embedding"],
    reason:
      "M264's rebuildable Record search vector is another representation of the exact plaintext semantic-embedding content class already frozen for Memory embeddings; it is not encrypted or bounded metadata.",
    testEvidence: [REFLECTION_PROJECTION_EVIDENCE, REFLECTION_PURGE_EVIDENCE],
    crossBoundaryProjection: {
      fields: ["embedding"],
      rationale:
        "The approved M264 projection copies only the versioned 1,536-dimensional semantic vector into this cross-table search representation and retains no Record statement, query, source coordinate, key, or Grant.",
    },
  }),
);

export const SUPERSEDED_MAIN_2026_08_14_COVERAGE_LOCATORS = new Set<string>([
  "packages/lattice-bridge/src/server/artifact/postgres-artifact-product-publication.ts#reserve:raw_sql:insert:public.artifact_crypto_operations:1",
]);
