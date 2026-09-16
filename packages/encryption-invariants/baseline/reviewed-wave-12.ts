import type { EncryptionCoverageEntry } from "../src/model";
import type { ReviewedDebtLink } from "../src/registry";

const SCHEMA_EVIDENCE = [
  "packages/db/tests/unit/memory-crypto-schema.test.ts",
  "packages/db/tests/unit/migration-0153-m243-memory-crypto.test.ts",
  "packages/db/tests/unit/migration-0155-m243-memory-metadata-operation.test.ts",
] as const;
const PRODUCT_EVIDENCE =
  "packages/lattice-bridge/tests/unit/postgres-agent-memory-product-port.test.ts";
const HUMAN_PRODUCT_EVIDENCE =
  "packages/lattice-bridge/tests/unit/postgres-human-memory-protected-product-route.test.ts";
const CRYPTO_EVIDENCE =
  "packages/lattice-bridge/tests/unit/postgres-memory-crypto-completion.test.ts";
const POSTGRES_EVIDENCE =
  "packages/lattice-bridge/tests/integration/postgres-memory-product-crypto.integration.test.ts";
const ROUTE_EVIDENCE =
  "packages/server/tests/unit-isolated/memory-routes.test.ts";

const SCHEMA_LOCATORS = [
  "public.memories.content_revision",
  "public.memories.crypto_access_revision",
  "public.memories.crypto_object_id",
  "public.memories.crypto_required_namespace_fingerprint",
  "public.memories.embedding_contract_version",
  "public.memories.embedding_dimensions",
  "public.memories.embedding_model",
  "public.memories.embedding_provider",
  "public.memories.embedding_revision",
  "public.memories.scope_origin_namespace_id",
  "public.memory_crypto_operations",
  "public.memory_crypto_operations.anchor_namespace_id",
  "public.memory_crypto_operations.attempt_count",
  "public.memory_crypto_operations.completion",
  "public.memory_crypto_operations.created_at",
  "public.memory_crypto_operations.crypto_completed_at",
  "public.memory_crypto_operations.disposition",
  "public.memory_crypto_operations.expected_access_revision",
  "public.memory_crypto_operations.expected_content_revision",
  "public.memory_crypto_operations.failure_code",
  "public.memory_crypto_operations.lease_expires_at",
  "public.memory_crypto_operations.lease_token",
  "public.memory_crypto_operations.memory_id",
  "public.memory_crypto_operations.next_attempt_at",
  "public.memory_crypto_operations.operation_id",
  "public.memory_crypto_operations.operation_type",
  "public.memory_crypto_operations.request_digest",
  "public.memory_crypto_operations.result_access_revision",
  "public.memory_crypto_operations.result_content_revision",
  "public.memory_crypto_operations.sequence",
  "public.memory_crypto_operations.target_required_namespace_fingerprint",
  "public.memory_crypto_operations.updated_at",
  "public.memory_crypto_revisions",
  "public.memory_crypto_revisions.allocation_request_digest",
  "public.memory_crypto_revisions.anchor_namespace_id",
  "public.memory_crypto_revisions.attempt_count",
  "public.memory_crypto_revisions.completion",
  "public.memory_crypto_revisions.content_revision",
  "public.memory_crypto_revisions.created_at",
  "public.memory_crypto_revisions.crypto_completed_at",
  "public.memory_crypto_revisions.crypto_object_id",
  "public.memory_crypto_revisions.disposition",
  "public.memory_crypto_revisions.failure_code",
  "public.memory_crypto_revisions.lease_expires_at",
  "public.memory_crypto_revisions.lease_token",
  "public.memory_crypto_revisions.memory_id",
  "public.memory_crypto_revisions.next_attempt_at",
  "public.memory_crypto_revisions.payload_version",
  "public.memory_crypto_revisions.required_namespace_fingerprint",
  "public.memory_crypto_revisions.sequence",
  "public.memory_crypto_revisions.updated_at",
] as const;

const RAW_WRITER_LOCATORS = [
  "packages/lattice-bridge/src/server/memory/postgres-agent-memory-product-port.ts##insertPlan:raw_sql:insert:public.memories:1",
  "packages/lattice-bridge/src/server/memory/postgres-agent-memory-product-port.ts##insertPlan:raw_sql:insert:public.memory_crypto_operations:1",
  "packages/lattice-bridge/src/server/memory/postgres-agent-memory-product-port.ts##insertPlan:raw_sql:insert:public.memory_crypto_revisions:1",
  "packages/lattice-bridge/src/server/memory/postgres-agent-memory-product-port.ts##insertPlan:raw_sql:insert:public.memory_namespaces:1",
  "packages/lattice-bridge/src/server/memory/postgres-agent-memory-product-port.ts##insertPlan:raw_sql:insert:public.memory_scopes:1",
  "packages/lattice-bridge/src/server/memory/postgres-agent-memory-product-port.ts##insertPlan:raw_sql:update:public.memories:1",
  "packages/lattice-bridge/src/server/memory/postgres-agent-memory-product-port.ts##insertPlan:raw_sql:update:public.memory_crypto_revisions:1",
  "packages/lattice-bridge/src/server/memory/postgres-agent-memory-product-port.ts#commitBackgroundTier:raw_sql:insert:public.memory_crypto_operations:1",
  "packages/lattice-bridge/src/server/memory/postgres-agent-memory-product-port.ts#commitBackgroundTier:raw_sql:update:public.memories:1",
  "packages/lattice-bridge/src/server/memory/postgres-agent-memory-product-port.ts#commitTier:raw_sql:insert:public.memory_crypto_operations:1",
  "packages/lattice-bridge/src/server/memory/postgres-agent-memory-product-port.ts#publishPrepared:raw_sql:update:public.memory_crypto_operations:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-crypto-completion.ts#insertExact:raw_sql:insert:public.crypto_objects:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-crypto-completion.ts#insertExact:raw_sql:insert:public.object_crypto_access_heads:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-crypto-completion.ts#insertExact:raw_sql:insert:public.object_crypto_access_manifests:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-crypto-completion.ts#insertExact:raw_sql:insert:public.object_crypto_namespace_envelopes:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts#allocate:raw_sql:insert:public.memory_crypto_operations:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts#allocate:raw_sql:insert:public.memory_crypto_revisions:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts#allocate:raw_sql:update:public.memories:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts#allocate:raw_sql:update:public.memory_crypto_revisions:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts#allocateCreate:raw_sql:insert:public.memories:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts#allocateCreate:raw_sql:insert:public.memory_crypto_revisions:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts#allocateCreate:raw_sql:insert:public.memory_namespaces:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts#allocateCreate:raw_sql:insert:public.memory_scopes:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts#allocateCreate:raw_sql:update:public.memory_crypto_operations:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts#publish:raw_sql:update:public.memories:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts#publish:raw_sql:update:public.memory_crypto_operations:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts#publish:raw_sql:update:public.memory_crypto_revisions:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts#reserveCreatePlan:raw_sql:insert:public.memory_crypto_operations:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-protected-product-route.ts#transitionTier:raw_sql:insert:public.memory_crypto_operations:1",
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-protected-product-route.ts#transitionTier:raw_sql:update:public.memories:1",
  "packages/lattice-bridge/src/server/memory/postgres-memory-crypto-completion.ts#insertExactPublication:raw_sql:insert:public.crypto_objects:1",
  "packages/lattice-bridge/src/server/memory/postgres-memory-crypto-completion.ts#insertExactPublication:raw_sql:insert:public.object_crypto_access_heads:1",
  "packages/lattice-bridge/src/server/memory/postgres-memory-crypto-completion.ts#insertExactPublication:raw_sql:insert:public.object_crypto_access_manifests:1",
  "packages/lattice-bridge/src/server/memory/postgres-memory-crypto-completion.ts#insertExactPublication:raw_sql:insert:public.object_crypto_namespace_envelopes:1",
  "packages/lattice-bridge/src/server/memory/postgres-memory-product-store.ts##persistStaleMapping:raw_sql:update:public.memory_crypto_revisions:1",
  "packages/lattice-bridge/src/server/memory/postgres-memory-product-store.ts#claimReconciliationCandidates:raw_sql:update:public.memory_crypto_revisions:1",
  "packages/lattice-bridge/src/server/memory/postgres-memory-product-store.ts#compareAndSwapCryptoMapping:raw_sql:update:public.memories:1",
  "packages/lattice-bridge/src/server/memory/postgres-memory-product-store.ts#compareAndSwapCryptoMapping:raw_sql:update:public.memory_crypto_revisions:1",
  "packages/lattice-bridge/src/server/memory/postgres-memory-product-store.ts#failReconciliationClaim:raw_sql:update:public.memory_crypto_revisions:1",
  "packages/lattice-bridge/src/server/memory/postgres-memory-product-store.ts#markCryptoComplete:raw_sql:update:public.memory_crypto_revisions:1",
  "packages/lattice-bridge/src/server/memory/postgres-memory-product-store.ts#quarantineRevision:raw_sql:update:public.memory_crypto_revisions:1",
] as const;

const PROTECTED_CRYPTO_TABLES = new Set([
  "crypto_objects",
  "object_crypto_access_heads",
  "object_crypto_access_manifests",
  "object_crypto_namespace_envelopes",
]);

function repositoryFromWriter(locator: string): string {
  return locator.slice(0, locator.indexOf("#"));
}

function tableFromWriter(locator: string): string {
  const match = /:public[.]([^:]+):1$/u.exec(locator);
  if (!match?.[1]) throw new Error(`M243 writer has no exact table: ${locator}`);
  return match[1];
}

function boundedEntry(input: Readonly<{
  id: string;
  locator: string;
  readers: readonly string[];
  writers: readonly string[];
  metadataAllowlist: readonly string[];
  evidence: readonly string[];
}>): EncryptionCoverageEntry {
  return {
    id: input.id,
    surface: "db",
    locator: input.locator,
    owner: input.writers[0] ?? "packages/db",
    readers: input.readers,
    writers: input.writers,
    migrationState: "not_applicable",
    retention:
      "Retained only with the bounded Memory product mapping, publication receipt, or reconciliation lifecycle and removed by its explicit terminal cleanup.",
    testEvidence: input.evidence,
    classification: "bounded_metadata",
    metadataAllowlist: input.metadataAllowlist,
    plaintextReason:
      "The exact field or writer carries only typed Memory, Namespace, object, revision, digest, embedding-provenance, lifecycle, lease, enum, counter, or timestamp metadata; it contains no Memory content, query text, private key, root, or decrypted payload.",
  };
}

const schemaEntries: readonly EncryptionCoverageEntry[] = SCHEMA_LOCATORS.map(
  (locator, index) => {
    const column = locator.split(".").at(-1)!;
    const isTable = locator.split(".").length === 2;
    return boundedEntry({
      id: `db.wave12.schema-${String(index + 1).padStart(2, "0")}`,
      locator,
      readers: [
        "packages/lattice-bridge/src/server/memory/postgres-agent-memory-product-port.ts",
        "packages/lattice-bridge/src/server/memory/postgres-memory-product-store.ts",
      ],
      writers: [
        "packages/lattice-bridge/src/server/memory/postgres-agent-memory-product-port.ts",
        "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts",
      ],
      metadataAllowlist: isTable
        ? SCHEMA_LOCATORS
          .filter((candidate) => candidate.startsWith(`${locator}.`))
          .map((candidate) => candidate.slice(locator.length + 1))
        : [column],
      evidence: SCHEMA_EVIDENCE,
    });
  },
);

const writerEntries: readonly EncryptionCoverageEntry[] =
  RAW_WRITER_LOCATORS.map((locator, index) => {
    const repository = repositoryFromWriter(locator);
    const table = tableFromWriter(locator);
    if (PROTECTED_CRYPTO_TABLES.has(table)) {
      return {
        id: `db.wave12.crypto-writer-${String(index + 1).padStart(2, "0")}`,
        surface: "db",
        locator,
        owner: "packages/lattice-bridge",
        readers: [repository],
        writers: [repository],
        migrationState: "ciphertext_only",
        retention:
          "Retained only as authenticated opaque Memory ciphertext, signed access state, or wrapped Namespace envelope for the exact published object revision.",
        testEvidence: [CRYPTO_EVIDENCE, POSTGRES_EVIDENCE],
        classification: "protected",
        keyFamily: "namespace_ai",
        bridgeRepository: repository,
        negativeTestEvidence: [CRYPTO_EVIDENCE, POSTGRES_EVIDENCE],
      };
    }
    return boundedEntry({
      id: `db.wave12.product-writer-${String(index + 1).padStart(2, "0")}`,
      locator,
      readers: [repository],
      writers: [repository],
      metadataAllowlist: [
        "Memory and Namespace identifiers",
        "object and revision coordinates",
        "request and allocation digests",
        "bounded embedding provenance",
        "lifecycle, lease, retry, and terminal receipt metadata",
      ],
      evidence: [
        repository.endsWith("postgres-human-memory-protected-product-route.ts")
          ? HUMAN_PRODUCT_EVIDENCE
          : PRODUCT_EVIDENCE,
        POSTGRES_EVIDENCE,
      ],
    });
  });

const wireEntries: readonly EncryptionCoverageEntry[] = [
  {
    id: "wire.wave12.protected-memory-create",
    surface: "wire",
    locator: "http:request_response:POST /api/memory/protected-create",
    owner: "packages/server",
    readers: ["packages/api-client/src/client.ts"],
    writers: ["packages/server/src/routes/memory.ts"],
    migrationState: "ciphertext_only",
    retention:
      "The authenticated response is transient and carries only the published protected Memory projection plus opaque ciphertext and exact Namespace envelopes.",
    testEvidence: [
      ROUTE_EVIDENCE,
      "packages/api-client/tests/unit/protected-memory-methods-contract.test.ts",
    ],
    classification: "protected",
    keyFamily: "namespace_human",
    bridgeRepository:
      "packages/lattice-bridge/src/server/memory/human-memory-prepared-create-composition.ts",
    negativeTestEvidence: [
      ROUTE_EVIDENCE,
      "packages/lattice-bridge/tests/unit/human-memory-prepared-update.test.ts",
    ],
  },
  {
    id: "wire.wave12.protected-memory-create-plan",
    surface: "wire",
    locator: "http:request_response:POST /api/memory/protected-create-plan",
    owner: "packages/server",
    readers: ["packages/api-client/src/client.ts"],
    writers: ["packages/server/src/routes/memory.ts"],
    migrationState: "not_applicable",
    retention:
      "The authenticated response is transient and its bounded reservation expires at the signed deadline if no prepared encrypted publication arrives.",
    testEvidence: [
      ROUTE_EVIDENCE,
      "packages/api-client/tests/unit/protected-memory-methods-contract.test.ts",
    ],
    classification: "bounded_metadata",
    metadataAllowlist: [
      "operationId",
      "memoryId",
      "expectedContentRevision",
      "nextContentRevision",
      "requiredNamespaceIds",
      "productAuthority",
      "deadlineAt",
    ],
    plaintextReason:
      "The create plan contains only random identifiers, revision counters, canonical Namespace authority, and a deadline; it contains no Memory content, query, embedding vector, key, root, or ciphertext plaintext.",
  },
];

/** Exact Memory encryption storage, writer, and protected transport surfaces introduced by Wave 12. */
export const REVIEWED_WAVE_12_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
    ...schemaEntries,
    ...writerEntries,
    ...wireEntries,
  ];

/**
 * Semantic protected search intentionally discloses the bounded query to the
 * configured foreground embedding provider. The encrypted result DTO does not
 * add a second plaintext Memory-result boundary.
 */
export const REVIEWED_WAVE_12_DEBT_LINKS: readonly ReviewedDebtLink[] = [
  {
    id: "debt-link.wire.wave12-protected-memory-search",
    surface: "wire",
    locator: "http:request_response:POST /api/memory/search",
    owner: "packages/server",
    targetDebtIds: [
      "debt.wire.http.request.response.get.api.memory.search.18jkqwa",
    ],
    reason:
      "The POST route repeats only the existing frozen user-authored Memory search-query disclosure for foreground embedding; its result records are application-encrypted DTOs rather than plaintext Memory content.",
    testEvidence: [
      ROUTE_EVIDENCE,
      "packages/lattice-bridge/tests/unit/protected-memory-search-policy.test.ts",
    ],
  },
];
