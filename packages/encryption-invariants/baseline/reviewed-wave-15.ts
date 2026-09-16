import type { EncryptionCoverageEntry } from "../src/model";

const AGENT_ACCESS_CRYPTO =
  "packages/lattice-bridge/src/server/memory/postgres-memory-crypto-completion.ts";
const AGENT_ACCESS_PRODUCT =
  "packages/lattice-bridge/src/server/memory/postgres-agent-memory-exact-access-product.ts";
const SCOPE_CLOSE_SAGA = "packages/trust/src/scope-close-saga.ts";
const AGENT_ACCESS_EVIDENCE =
  "packages/lattice-bridge/tests/unit/agent-memory-session-content.test.ts";
const CRYPTO_PERSISTENCE_EVIDENCE =
  "packages/lattice-bridge/tests/unit/postgres-memory-crypto-completion.test.ts";
const AGENT_ACCESS_PRODUCT_EVIDENCE =
  "packages/lattice-bridge/tests/unit/postgres-agent-memory-exact-access-product.test.ts";
const SCOPE_CLOSE_EVIDENCE =
  "packages/trust/tests/unit-isolated/scope-close-saga.test.ts";
const SCHEMA_EVIDENCE =
  "packages/db/tests/unit/m251-agent-scope-close-schema.test.ts";
const MIGRATION_EVIDENCE =
  "packages/db/tests/unit/migration-0160-m251-agent-scope-close.test.ts";

const PROTECTED_WRITERS = [
  `${AGENT_ACCESS_CRYPTO}#complete:raw_sql:insert:public.object_crypto_access_manifests:1`,
  `${AGENT_ACCESS_CRYPTO}#complete:raw_sql:insert:public.object_crypto_namespace_envelopes:1`,
  `${AGENT_ACCESS_CRYPTO}#complete:raw_sql:update:public.object_crypto_access_heads:1`,
] as const;

const METADATA_WRITERS = [
  `${AGENT_ACCESS_PRODUCT}##commitProduct:raw_sql:delete:public.memory_scopes:1`,
  `${AGENT_ACCESS_PRODUCT}#commitPrepared:raw_sql:insert:public.memory_crypto_operations:1`,
  `${AGENT_ACCESS_PRODUCT}##commitProduct:raw_sql:insert:public.memory_namespaces:1`,
  `${AGENT_ACCESS_PRODUCT}##commitProduct:raw_sql:unresolved:unresolved.dynamic_sql:1`,
  `${AGENT_ACCESS_PRODUCT}##commitProduct:raw_sql:update:public.memory_crypto_operations:1`,
  `${AGENT_ACCESS_PRODUCT}#detachScopeSeed:raw_sql:delete:public.memory_scopes:1`,
  `${AGENT_ACCESS_PRODUCT}#reconcileAfterProcessLoss:raw_sql:update:public.memory_crypto_operations:1`,
  `${SCOPE_CLOSE_SAGA}#begin:raw_sql:insert:public.agent_scope_close_items:1`,
  `${SCOPE_CLOSE_SAGA}#begin:raw_sql:insert:public.agent_scope_close_operations:1`,
  `${SCOPE_CLOSE_SAGA}#begin:raw_sql:update:public.agent_scopes:1`,
  `${SCOPE_CLOSE_SAGA}#claim:raw_sql:update:public.agent_scope_close_items:1`,
  `${SCOPE_CLOSE_SAGA}#claim:raw_sql:update:public.agent_scope_close_items:2`,
  `${SCOPE_CLOSE_SAGA}#completeClaim:raw_sql:update:public.agent_scope_close_items:1`,
  `${SCOPE_CLOSE_SAGA}#completeClaim:raw_sql:update:public.agent_scope_close_items:2`,
  `${SCOPE_CLOSE_SAGA}#completeClaim:raw_sql:update:public.agent_scope_close_items:3`,
  `${SCOPE_CLOSE_SAGA}#finalize:raw_sql:delete:public.agent_scopes:1`,
  `${SCOPE_CLOSE_SAGA}#finalize:raw_sql:update:public.agent_scope_close_operations:1`,
  `${SCOPE_CLOSE_SAGA}#quarantine:raw_sql:update:public.agent_scope_close_operations:1`,
] as const;

const SCOPE_CLOSE_SCHEMA_LOCATORS = [
  "public.agent_scope_close_items",
  "public.agent_scope_close_items.action",
  "public.agent_scope_close_items.attempt_count",
  "public.agent_scope_close_items.claim_expires_at",
  "public.agent_scope_close_items.claim_owner",
  "public.agent_scope_close_items.claim_token",
  "public.agent_scope_close_items.created_at",
  "public.agent_scope_close_items.crypto_object_id",
  "public.agent_scope_close_items.crypto_receipt_ref",
  "public.agent_scope_close_items.expected_access_revision",
  "public.agent_scope_close_items.expected_content_revision",
  "public.agent_scope_close_items.expected_required_namespace_fingerprint",
  "public.agent_scope_close_items.failure_code",
  "public.agent_scope_close_items.memory_id",
  "public.agent_scope_close_items.next_attempt_at",
  "public.agent_scope_close_items.operation_id",
  "public.agent_scope_close_items.ordinal",
  "public.agent_scope_close_items.origin",
  "public.agent_scope_close_items.product_receipt_ref",
  "public.agent_scope_close_items.source_origin_namespace_id",
  "public.agent_scope_close_items.state",
  "public.agent_scope_close_items.target_namespace_id",
  "public.agent_scope_close_items.terminal_at",
  "public.agent_scope_close_items.updated_at",
  "public.agent_scope_close_operations",
  "public.agent_scope_close_operations.captured_item_count",
  "public.agent_scope_close_operations.created_at",
  "public.agent_scope_close_operations.failure_code",
  "public.agent_scope_close_operations.inventory_digest",
  "public.agent_scope_close_operations.operation_id",
  "public.agent_scope_close_operations.parent_agent_id",
  "public.agent_scope_close_operations.scope_id",
  "public.agent_scope_close_operations.sequence",
  "public.agent_scope_close_operations.source_scope_revision",
  "public.agent_scope_close_operations.speaker_user_id",
  "public.agent_scope_close_operations.state",
  "public.agent_scope_close_operations.terminal_at",
  "public.agent_scope_close_operations.updated_at",
  "public.agent_scopes.close_operation_id",
  "public.agent_scopes.lifecycle_state",
  "public.agent_scopes.revision",
] as const;

function stableId(locator: string): string {
  return locator.replaceAll(/[^a-zA-Z0-9]+/gu, "-").toLowerCase();
}

function repository(locator: string): string {
  return locator.slice(0, locator.indexOf("#"));
}

const protectedWriterEntries: readonly EncryptionCoverageEntry[] =
  PROTECTED_WRITERS.map((locator) => ({
    id: `db.wave15.${stableId(locator)}`,
    surface: "db",
    locator,
    owner: "packages/lattice-bridge",
    readers: [AGENT_ACCESS_CRYPTO],
    writers: [AGENT_ACCESS_CRYPTO],
    migrationState: "ciphertext_only",
    retention:
      "Retained as the authenticated Agent Runtime-signed access manifest and exact wrapped AI Namespace envelope inventory for the current Memory object.",
    testEvidence: [AGENT_ACCESS_EVIDENCE, CRYPTO_PERSISTENCE_EVIDENCE],
    classification: "protected",
    keyFamily: "namespace_ai",
    bridgeRepository: AGENT_ACCESS_CRYPTO,
    negativeTestEvidence: [
      AGENT_ACCESS_EVIDENCE,
      CRYPTO_PERSISTENCE_EVIDENCE,
    ],
  }));

const metadataWriterEntries: readonly EncryptionCoverageEntry[] =
  METADATA_WRITERS.map((locator) => {
    const writer = repository(locator);
    const scopeClose = writer === SCOPE_CLOSE_SAGA;
    return {
      id: `db.wave15.${stableId(locator)}`,
      surface: "db",
      locator,
      owner: scopeClose ? "packages/trust" : "packages/lattice-bridge",
      readers: [writer],
      writers: [writer],
      migrationState: "not_applicable",
      retention:
        "Retained only as bounded exact-access or AgentScope-close coordinates, lifecycle state, retry ownership, canonical fingerprints, and content-free replay receipts.",
      testEvidence: scopeClose
        ? [SCOPE_CLOSE_EVIDENCE, MIGRATION_EVIDENCE]
        : [AGENT_ACCESS_EVIDENCE, AGENT_ACCESS_PRODUCT_EVIDENCE],
      classification: "bounded_metadata",
      metadataAllowlist: [
        "Memory, Namespace, scope, Human, Agent, operation, and worker identifiers",
        "content, access, scope, retry, ordinal, and attempt counters",
        "canonical Namespace and captured-inventory fingerprints",
        "bounded lifecycle, claim, deadline, failure-code, and receipt state",
      ],
      plaintextReason:
        "The writer receives only authenticated identifiers, revision counters, hashes, bounded lifecycle enums, and portable receipt references; it receives no Memory content, embedding, query, key, root, DEK, Grant, or capability.",
    } satisfies EncryptionCoverageEntry;
  });

const schemaEntries: readonly EncryptionCoverageEntry[] =
  SCOPE_CLOSE_SCHEMA_LOCATORS.map((locator) => ({
    id: `db.wave15.${stableId(locator)}`,
    surface: "db",
    locator,
    owner: "packages/trust",
    readers: [SCOPE_CLOSE_SAGA],
    writers: [SCOPE_CLOSE_SAGA],
    migrationState: "not_applicable",
    retention:
      "Retained only for the bounded restart-safe AgentScope-close inventory, claim, retry, terminal status, and content-free replay receipt lifecycle.",
    testEvidence: [SCHEMA_EVIDENCE, MIGRATION_EVIDENCE, SCOPE_CLOSE_EVIDENCE],
    classification: "bounded_metadata",
    metadataAllowlist: [
      "Memory, Namespace, scope, Human, Agent, operation, and worker identifiers",
      "content, access, scope, retry, ordinal, and attempt counters",
      "canonical Namespace and captured-inventory fingerprints",
      "bounded lifecycle, claim, deadline, failure-code, and receipt state",
    ],
    plaintextReason:
      "The schema permits only bounded identifiers, counters, hashes, lifecycle enums, timestamps, and portable receipt references. It has no column for Memory content, embeddings, prompts, keys, roots, DEKs, Grants, capabilities, or signed request bodies.",
  }));

/** Reviewed dormant Agent exact-access and restart-safe AgentScope close state. */
export const REVIEWED_WAVE_15_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
    ...protectedWriterEntries,
    ...metadataWriterEntries,
    ...schemaEntries,
  ];
