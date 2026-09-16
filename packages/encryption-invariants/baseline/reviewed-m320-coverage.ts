import type { EncryptionCoverageEntry } from "../src/model";

const MEMORY_SCHEMA = "packages/db/src/schema/memory-crypto-operations.ts";
const MEMORY_PRODUCT = "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts";
const MEMORY_PRODUCT_TEST = "packages/lattice-bridge/tests/unit/postgres-human-memory-product-update.test.ts";
const MEMORY_ROUTE_TEST = "packages/server/tests/unit-isolated/memory-routes.test.ts";
const OBSERVATION_TEST = "packages/lattice-bridge/tests/unit/human-memory-read-observation.test.ts";
const OBSERVATION_SCHEMA = "packages/db/src/schema/encryption-transition.ts";
const OBSERVATION_STORE = "packages/db/src/utils/encryption-transition-observations.ts";
const OBSERVATION_ROUTE = "packages/server/src/routes/human-memory-read-observations.ts";

export const RETIRED_M320_RAW_DATABASE_WRITER_LOCATORS = new Set<string>([
  "packages/lattice-bridge/src/server/memory/postgres-agent-memory-product-port.ts##insertPlan:raw_sql:insert:public.memories:1",
  "packages/lattice-bridge/src/server/memory/postgres-agent-memory-product-port.ts##insertPlan:raw_sql:insert:public.memory_namespaces:1",
  "packages/lattice-bridge/src/server/memory/postgres-agent-memory-product-port.ts##insertPlan:raw_sql:insert:public.memory_scopes:1",
  "packages/lattice-bridge/src/server/memory/postgres-agent-memory-product-port.ts##insertPlan:raw_sql:update:public.memories:1",
  "packages/lattice-bridge/src/server/memory/postgres-agent-memory-product-port.ts##insertPlan:raw_sql:update:public.memory_crypto_revisions:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts#allocate:raw_sql:update:public.memories:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts#allocate:raw_sql:update:public.memory_crypto_revisions:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts#allocateCreate:raw_sql:insert:public.memories:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts#allocateCreate:raw_sql:insert:public.memory_namespaces:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts#allocateCreate:raw_sql:insert:public.memory_scopes:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts#publish:raw_sql:update:public.memories:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts#publish:raw_sql:update:public.memory_crypto_operations:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts#publish:raw_sql:update:public.memory_crypto_revisions:1",
]);

const operationFields = [
  "foreground_mutation_kind",
  "foreground_required_namespace_ids",
  "foreground_save_similarity",
  "foreground_stable_request_digest",
  "human_product_outcome",
  "ordinary_fallback_completed_at",
  "ordinary_fallback_reason",
  "semantic_change_acknowledged_at",
  "semantic_change_kind",
] as const;

const observationFields = [
  "content_revision",
  "crypto_access_revision",
  "crypto_object_id",
  "memory_id",
  "subject_human_id",
] as const;

function operationMetadataColumn(field: string, index: number): EncryptionCoverageEntry {
  return {
    id: `db.m320.memory-metadata.${index + 1}`,
    surface: "db",
    locator: `public.memory_crypto_operations.${field}`,
    owner: "packages/db",
    readers: [MEMORY_PRODUCT],
    writers: [MEMORY_PRODUCT],
    migrationState: "not_applicable",
    retention: "Memory operation, replay, effect-delivery, or authenticated-read receipt lifetime.",
    testEvidence: [MEMORY_PRODUCT_TEST, OBSERVATION_TEST],
    classification: "bounded_metadata",
    metadataAllowlist: [field],
    plaintextReason: `The Drizzle schema at ${MEMORY_SCHEMA} restricts this field to content-free operation identity, revision, Namespace, closed outcome/reason, timestamp, similarity, or fixed digest metadata; Memory type/content, embeddings, keys, envelopes, and ciphertext are excluded.`,
  };
}

function observationMetadataColumn(field: string, index: number): EncryptionCoverageEntry {
  return {
    id: `db.m320.memory-read-observation.${index + 1}`,
    surface: "db",
    locator: `public.encryption_transition_observation_admissions.${field}`,
    owner: "packages/db",
    readers: [OBSERVATION_STORE, OBSERVATION_ROUTE],
    writers: [OBSERVATION_STORE],
    migrationState: "not_applicable",
    retention: "Bounded, expiring authenticated Memory read-observation admission lifetime.",
    testEvidence: [OBSERVATION_TEST],
    classification: "bounded_metadata",
    metadataAllowlist: [field],
    plaintextReason: `The Drizzle schema at ${OBSERVATION_SCHEMA} restricts this field to content-free subject, Memory, object, or revision coordinates; Memory type/content, embeddings, keys, envelopes, and ciphertext are excluded.`,
  };
}

const boundedRoutes = [
  "http:request_response:GET /api/memory/processor-recipient",
  "http:request_response:POST /api/protected/memories/read-observation",
] as const;

export const REVIEWED_M320_COVERAGE_ENTRIES: readonly EncryptionCoverageEntry[] = [
  ...operationFields.map((field, index) =>
    operationMetadataColumn(field, index)),
  ...observationFields.map((field, index) =>
    observationMetadataColumn(field, index)),
  ...boundedRoutes.map((locator, index): EncryptionCoverageEntry => ({
    id: `wire.m320.memory-authority-metadata.${index + 1}`,
    surface: "wire",
    locator,
    owner: "packages/server",
    readers: ["packages/lattice-bridge/src/client/memory/vault-human-memory-device-content.ts"],
    writers: ["packages/server/src/routes/memory.ts"],
    migrationState: "not_applicable",
    retention: "Authenticated request/response lifetime; durable observations retain only the classified metadata columns.",
    testEvidence: [MEMORY_ROUTE_TEST, OBSERVATION_TEST],
    classification: "bounded_metadata",
    metadataAllowlist: ["recipient", "provider", "model", "publicKey", "memoryId", "cryptoObjectId", "revision", "digest", "signature", "status", "reason"],
    plaintextReason: "Carries only public processor-recipient coordinates or signed, content-free Memory read-observation identity and digest metadata; it carries no Memory body, embedding, secret key, or plaintext representation.",
  })),
  ...[
    "http:request_response:POST /api/protected/memories/:id/repair-plan",
    "http:request_response:POST /api/protected/memories/:id/repair",
  ].map((locator, index): EncryptionCoverageEntry => ({
    id: `wire.m320.memory-repair.${index + 1}`,
    surface: "wire",
    locator,
    owner: "packages/server",
    readers: ["packages/lattice-bridge/src/client/memory/vault-human-memory-device-content.ts"],
    writers: ["packages/server/src/routes/memory.ts"],
    migrationState: "shadow",
    retention: "Request-scoped authenticated Memory representation repair plan or publication.",
    testEvidence: [MEMORY_ROUTE_TEST],
    classification: "protected",
    keyFamily: "namespace_ai_or_human",
    bridgeRepository: "packages/lattice-bridge/src/server/memory/postgres-human-memory-representation-repair.ts",
    negativeTestEvidence: [MEMORY_ROUTE_TEST],
  })),
];
