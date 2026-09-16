import type { EncryptionCoverageEntry } from "../src/model";

const ACCESS_CRYPTO_REPOSITORY =
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-exact-access-crypto.ts";
const ACCESS_PRODUCT_REPOSITORY =
  "packages/lattice-bridge/src/server/memory/postgres-human-memory-exact-access-product.ts";
const BOOTSTRAP_REPOSITORY =
  "packages/lattice-bridge/src/server/delivery/postgres-namespace-bootstrap-repository.ts";
const POSTGRES_EVIDENCE =
  "packages/lattice-bridge/tests/integration/postgres-memory-product-crypto.integration.test.ts";

const PROTECTED_WRITERS = [
  `${BOOTSTRAP_REPOSITORY}#compareAndSwapNamespaceBindingAndHead:raw_sql:insert:public.namespace_crypto_bindings:1`,
  `${BOOTSTRAP_REPOSITORY}#compareAndSwapNamespaceBindingAndHead:raw_sql:insert:public.namespace_crypto_heads:1`,
  `${BOOTSTRAP_REPOSITORY}#expectOne:raw_sql:unresolved:unresolved.dynamic_sql:1`,
  `${ACCESS_CRYPTO_REPOSITORY}#complete:raw_sql:insert:public.object_crypto_access_manifests:1`,
  `${ACCESS_CRYPTO_REPOSITORY}#complete:raw_sql:insert:public.object_crypto_namespace_envelopes:1`,
  `${ACCESS_CRYPTO_REPOSITORY}#complete:raw_sql:update:public.object_crypto_access_heads:1`,
] as const;

const METADATA_WRITERS = [
  `${BOOTSTRAP_REPOSITORY}#cancelAbandoned:raw_sql:update:public.crypto_delivery_operations:1`,
  `${ACCESS_PRODUCT_REPOSITORY}#commit:raw_sql:delete:public.memory_namespaces:1`,
  `${ACCESS_PRODUCT_REPOSITORY}#commit:raw_sql:insert:public.memory_namespaces:1`,
  `${ACCESS_PRODUCT_REPOSITORY}#commit:raw_sql:update:public.memories:1`,
  `${ACCESS_PRODUCT_REPOSITORY}#commit:raw_sql:update:public.memory_crypto_operations:1`,
  `${ACCESS_PRODUCT_REPOSITORY}#reserve:raw_sql:insert:public.memory_crypto_operations:1`,
] as const;

function pathFromLocator(locator: string): string {
  return locator.slice(0, locator.indexOf("#"));
}

function stableId(locator: string): string {
  return locator.replaceAll(/[^a-zA-Z0-9]+/gu, "-").toLowerCase();
}

const protectedWriterEntries: readonly EncryptionCoverageEntry[] =
  PROTECTED_WRITERS.map((locator) => {
    const repository = pathFromLocator(locator);
    const bootstrap = repository === BOOTSTRAP_REPOSITORY;
    const evidence = bootstrap
      ? "packages/lattice-bridge/tests/unit/postgres-namespace-bootstrap-stage.test.ts"
      : "packages/lattice-bridge/tests/unit/postgres-human-memory-exact-access-crypto.test.ts";
    return {
      id: `db.wave14.${stableId(locator)}`,
      surface: "db",
      locator,
      owner: "packages/lattice-bridge",
      readers: [repository],
      writers: [repository],
      migrationState: "ciphertext_only",
      retention:
        "Retained only as authenticated signed access state, wrapped Namespace keyring material, or opaque delivery ciphertext for the exact access operation.",
      testEvidence: [evidence, POSTGRES_EVIDENCE],
      classification: "protected",
      keyFamily: "namespace_human",
      bridgeRepository: repository,
      negativeTestEvidence: [evidence, POSTGRES_EVIDENCE],
    };
  });

const metadataWriterEntries: readonly EncryptionCoverageEntry[] =
  METADATA_WRITERS.map((locator) => {
    const repository = pathFromLocator(locator);
    const bootstrap = repository === BOOTSTRAP_REPOSITORY;
    return {
      id: `db.wave14.${stableId(locator)}`,
      surface: "db",
      locator,
      owner: "packages/lattice-bridge",
      readers: [repository],
      writers: [repository],
      migrationState: "not_applicable",
      retention:
        "Retained only for the bounded access or Namespace-bootstrap lifecycle and its exact idempotent replay receipt.",
      testEvidence: [
        bootstrap
          ? "packages/lattice-bridge/tests/unit/postgres-namespace-bootstrap-replay.test.ts"
          : "packages/lattice-bridge/tests/unit/postgres-human-memory-exact-access-product.test.ts",
        POSTGRES_EVIDENCE,
      ],
      classification: "bounded_metadata",
      metadataAllowlist: [
        "Memory, Namespace, Human, device, Domain, and operation identifiers",
        "access, content, device, delivery, and binding revision counters",
        "canonical Namespace fingerprints and authenticated request digests",
        "bounded lifecycle, deadline, acknowledgement, and terminal status",
      ],
      plaintextReason:
        "The writer changes only exact product attachment edges, counters, fingerprints, or content-free lifecycle receipts; it receives no Memory content, search query, decrypted payload, root, or key bytes.",
    };
  });

const wireEntries: readonly EncryptionCoverageEntry[] = [
  {
    id: "wire.wave14.human-memory-access-plan",
    surface: "wire",
    locator: "http:request_response:POST /api/protected/memories/:id/access-plan",
    owner: "packages/server",
    readers: ["packages/api-client/src/client.ts"],
    writers: ["packages/server/src/routes/protected-memory-routes.ts"],
    migrationState: "not_applicable",
    retention:
      "The exact access plan is transient and expires at its bounded deadline unless an authenticated prepared access update is committed.",
    testEvidence: [
      "packages/server/tests/unit-isolated/protected-memory-routes.test.ts",
      "packages/api-client/tests/unit/protected-memory-methods-contract.test.ts",
    ],
    classification: "bounded_metadata",
    metadataAllowlist: [
      "operation and Memory identifiers",
      "object, content, access, Namespace, Domain, and binding coordinates",
      "canonical current, added, removed, and target Namespace inventories",
      "authorization literals and deadline",
    ],
    plaintextReason:
      "The plan carries only authenticated identifiers, revisions, hashes, binding coordinates, authority results, and a deadline; it carries no Memory content, query, embedding, root, key, or decrypted payload.",
  },
  {
    id: "wire.wave14.human-memory-access-commit",
    surface: "wire",
    locator: "http:request_response:POST /api/protected/memories/:id/access",
    owner: "packages/server",
    readers: ["packages/api-client/src/client.ts"],
    writers: ["packages/server/src/routes/protected-memory-routes.ts"],
    migrationState: "ciphertext_only",
    retention:
      "The prepared request is transient; only its digest, signed manifest, exact wrapped Namespace envelopes, and bounded replay receipt are retained.",
    testEvidence: [
      "packages/server/tests/unit-isolated/protected-memory-routes.test.ts",
      "packages/lattice-bridge/tests/unit/human-memory-protected-route-ports.test.ts",
    ],
    classification: "protected",
    keyFamily: "namespace_human",
    bridgeRepository: ACCESS_CRYPTO_REPOSITORY,
    negativeTestEvidence: [
      "packages/lattice-bridge/tests/unit/postgres-human-memory-exact-access-crypto.test.ts",
      "packages/server/tests/unit-isolated/protected-memory-routes.test.ts",
    ],
  },
];

/** Exact Human Memory access and Namespace-bootstrap surfaces added by Wave 14. */
export const REVIEWED_WAVE_14_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
    ...protectedWriterEntries,
    ...metadataWriterEntries,
    ...wireEntries,
  ];

/** Wave 13's separate deletion transport was retired by exact access updates. */
export const SUPERSEDED_WAVE_14_COVERAGE_LOCATORS = new Set<string>([
  "http:request_response:DELETE /api/protected/memories/:id/connection",
]);
