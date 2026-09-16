import type {
  EncryptionCoverageEntry,
  KeyFamily,
} from "../src/model";

const SCHEMA_EVIDENCE =
  "packages/db/tests/unit/crypto-storage-schema.test.ts";
const STORAGE_EVIDENCE =
  "packages/lattice-bridge/tests/integration/postgres-lattice-storage.integration.test.ts";
const BRIDGE_REPOSITORY =
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts";

type CryptoTableDeclaration = Readonly<{
  keyFamily: KeyFamily;
  columns: readonly string[];
  protectedColumns: readonly string[];
}>;

/**
 * Wave 6's additive tables deliberately contain only bounded public crypto
 * coordinates and opaque encrypted/wrapped bytes. Keeping this declaration
 * exact makes every added or renamed column fail the repository inventory.
 */
const CRYPTO_TABLES = {
  agent_crypto_runtime_challenges: {
    keyFamily: "agent_runtime",
    columns: ["agent_id", "challenge_hash", "consumed", "ordinal"],
    protectedColumns: [],
  },
  agent_crypto_runtime_config_objects: {
    keyFamily: "agent_runtime",
    columns: [
      "agent_id",
      "config_revision",
      "object_id",
      "ordinal",
      "runtime_generation",
      "wrapped_dek_bytes",
      "wrapped_dek_hash",
    ],
    protectedColumns: ["wrapped_dek_bytes"],
  },
  agent_crypto_runtime_domain_envelopes: {
    keyFamily: "agent_runtime",
    columns: [
      "agent_authorization_revision",
      "agent_id",
      "committer_device_id",
      "domain_epoch",
      "domain_id",
      "envelope_bytes",
      "envelope_hash",
      "ordinal",
      "runtime_generation",
    ],
    protectedColumns: ["envelope_bytes"],
  },
  agent_crypto_runtime_states: {
    keyFamily: "agent_runtime",
    columns: [
      "agent_id",
      "authorization_revision",
      "config_inventory_digest",
      "config_object_count",
      "runtime_generation",
    ],
    protectedColumns: [],
  },
  crypto_domain_provider_heads: {
    keyFamily: "namespace_human",
    columns: ["domain_id", "epoch", "provider_id", "roster_bytes", "state_hash"],
    protectedColumns: [],
  },
  crypto_domains: {
    keyFamily: "namespace_human",
    columns: [
      "authorization_revision",
      "epoch",
      "id",
      "participant_digest",
      "participants",
      "roster_bytes",
    ],
    protectedColumns: [],
  },
  crypto_grants: {
    keyFamily: "namespace_ai",
    columns: ["consumed", "grant_bytes", "grant_id"],
    protectedColumns: ["grant_bytes"],
  },
  crypto_objects: {
    keyFamily: "namespace_ai",
    columns: ["object_id", "payload_bytes", "payload_hash"],
    protectedColumns: ["payload_bytes"],
  },
  human_crypto_recovery_archives: {
    keyFamily: "namespace_human",
    columns: [
      "archive_bytes",
      "archive_hash",
      "human_id",
      "recovery_key_generation",
    ],
    protectedColumns: ["archive_bytes"],
  },
  namespace_crypto_bindings: {
    keyFamily: "namespace_human",
    columns: [
      "ai_keyring_envelope_bytes",
      "binding_hash",
      "human_keyring_envelope_bytes",
      "namespace_id",
      "previous_binding_hash",
      "revision",
      "signed_binding_bytes",
    ],
    protectedColumns: [
      "ai_keyring_envelope_bytes",
      "human_keyring_envelope_bytes",
    ],
  },
  namespace_crypto_heads: {
    keyFamily: "namespace_human",
    columns: [
      "access_revision",
      "binding_hash",
      "domain_epoch",
      "domain_id",
      "namespace_id",
    ],
    protectedColumns: [],
  },
  object_crypto_access_heads: {
    keyFamily: "namespace_ai",
    columns: ["access_revision", "manifest_hash", "object_id"],
    protectedColumns: [],
  },
  object_crypto_access_manifests: {
    keyFamily: "namespace_ai",
    columns: [
      "access_revision",
      "manifest_bytes",
      "manifest_hash",
      "object_id",
      "payload_hash",
      "previous_manifest_hash",
    ],
    protectedColumns: [],
  },
  object_crypto_namespace_envelopes: {
    keyFamily: "namespace_ai",
    columns: [
      "access_revision",
      "envelope_bytes",
      "envelope_hash",
      "namespace_id",
      "object_id",
      "ordinal",
    ],
    protectedColumns: ["envelope_bytes"],
  },
} as const satisfies Readonly<Record<string, CryptoTableDeclaration>>;

function boundedEntry(
  table: string,
  locator: string,
  metadataAllowlist: readonly string[],
): EncryptionCoverageEntry {
  return {
    id: `db.public.${table.replaceAll("_", "-")}.${locator.split(".").at(-1)!.replaceAll("_", "-")}`,
    surface: "db",
    locator,
    owner: "packages/lattice-bridge",
    readers: [BRIDGE_REPOSITORY],
    writers: [BRIDGE_REPOSITORY],
    migrationState: "not_applicable",
    retention:
      "Retained with the dormant public crypto record and removed only by a later explicit lifecycle operation.",
    testEvidence: [SCHEMA_EVIDENCE, STORAGE_EVIDENCE],
    classification: "bounded_metadata",
    metadataAllowlist,
    plaintextReason:
      "The exact field set contains only bounded identifiers, hashes, counters, booleans, canonical participants, or signed public crypto state; it contains no user-authored content or secret key bytes.",
  };
}

function protectedEntry(
  table: string,
  locator: string,
  keyFamily: KeyFamily,
): EncryptionCoverageEntry {
  return {
    id: `db.public.${table.replaceAll("_", "-")}.${locator.split(".").at(-1)!.replaceAll("_", "-")}`,
    surface: "db",
    locator,
    owner: "packages/lattice-bridge",
    readers: [BRIDGE_REPOSITORY],
    writers: [BRIDGE_REPOSITORY],
    migrationState: "ciphertext_only",
    retention:
      "Retained only as validated opaque ciphertext or wrapped key material for the owning durable crypto record.",
    testEvidence: [SCHEMA_EVIDENCE, STORAGE_EVIDENCE],
    classification: "protected",
    keyFamily,
    bridgeRepository: BRIDGE_REPOSITORY,
    negativeTestEvidence: [STORAGE_EVIDENCE],
  };
}

export const REVIEWED_WAVE_6_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = Object.entries(CRYPTO_TABLES).flatMap(
    ([table, declaration]) => {
      const protectedColumns = new Set<string>(declaration.protectedColumns);
      const tableLocator = `public.${table}`;
      const tableEntry = protectedColumns.size > 0
        ? protectedEntry(table, tableLocator, declaration.keyFamily)
        : boundedEntry(table, tableLocator, declaration.columns);
      return [
        tableEntry,
        ...declaration.columns.map((column) => {
          const locator = `${tableLocator}.${column}`;
          return protectedColumns.has(column)
            ? protectedEntry(table, locator, declaration.keyFamily)
            : boundedEntry(table, locator, [column]);
        }),
      ];
    },
  );

const WAVE_6_DATABASE_WRITER_LOCATORS = [
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#compareAndSwapAgentRuntimeChallengeReservations:raw_sql:delete:public.agent_crypto_runtime_challenges:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#compareAndSwapAgentRuntimeChallengeReservations:raw_sql:insert:public.agent_crypto_runtime_challenges:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#compareAndSwapAgentRuntimeRotation:raw_sql:update:public.agent_crypto_runtime_states:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#compareAndSwapDomainProviderHead:raw_sql:update:public.crypto_domain_provider_heads:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#compareAndSwapDomainProviderHead:raw_sql:update:public.crypto_domains:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#compareAndSwapNamespaceBindingAndHead:raw_sql:insert:public.namespace_crypto_bindings:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#compareAndSwapNamespaceBindingAndHead:raw_sql:insert:public.namespace_crypto_heads:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#compareAndSwapNamespaceBindingAndHead:raw_sql:update:public.namespace_crypto_heads:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#compareAndSwapObjectAccessState:raw_sql:insert:public.object_crypto_access_heads:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#compareAndSwapObjectAccessState:raw_sql:insert:public.object_crypto_access_manifests:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#compareAndSwapObjectAccessState:raw_sql:insert:public.object_crypto_namespace_envelopes:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#compareAndSwapObjectAccessState:raw_sql:update:public.object_crypto_access_heads:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#compareAndSwapRecoveryArchive:raw_sql:insert:public.human_crypto_recovery_archives:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#compareAndSwapRecoveryArchive:raw_sql:update:public.human_crypto_recovery_archives:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#consumeGrant:raw_sql:update:public.crypto_grants:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#createDomainIfAbsent:raw_sql:insert:public.crypto_domains:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#insertRuntime:raw_sql:insert:public.agent_crypto_runtime_states:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#putDomainProviderHeadIfAbsent:raw_sql:insert:public.crypto_domain_provider_heads:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#putGrant:raw_sql:insert:public.crypto_grants:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#putObject:raw_sql:insert:public.crypto_objects:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#replaceRuntimeChildren:raw_sql:delete:public.agent_crypto_runtime_challenges:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#replaceRuntimeChildren:raw_sql:delete:public.agent_crypto_runtime_config_objects:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#replaceRuntimeChildren:raw_sql:delete:public.agent_crypto_runtime_domain_envelopes:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#replaceRuntimeChildren:raw_sql:insert:public.agent_crypto_runtime_challenges:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#replaceRuntimeChildren:raw_sql:insert:public.agent_crypto_runtime_config_objects:1",
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#replaceRuntimeChildren:raw_sql:insert:public.agent_crypto_runtime_domain_envelopes:1",
] as const;

function writerKeyFamily(locator: string): KeyFamily {
  const table = locator.split(":").at(-2);
  if (table === undefined || !table.startsWith("public.")) {
    throw new Error(`Wave 6 writer locator has no exact table: ${locator}`);
  }
  const declaration = CRYPTO_TABLES[
    table.slice("public.".length) as keyof typeof CRYPTO_TABLES
  ];
  if (declaration === undefined) {
    throw new Error(`Wave 6 writer locator names an unknown table: ${locator}`);
  }
  return declaration.keyFamily;
}

/**
 * Raw SQL is intentional inside this one reviewed adapter. These exact
 * callsites are classified as implemented protected persistence rather than
 * being grandfathered as new baseline debt.
 */
export const REVIEWED_WAVE_6_DATABASE_WRITER_ENTRIES:
  readonly EncryptionCoverageEntry[] =
  WAVE_6_DATABASE_WRITER_LOCATORS.map((locator, index) => ({
    id: `db.wave6.lattice-writer-${String(index + 1).padStart(2, "0")}`,
    surface: "db",
    locator,
    owner: "packages/lattice-bridge",
    readers: [BRIDGE_REPOSITORY],
    writers: [BRIDGE_REPOSITORY],
    migrationState: "ciphertext_only",
    retention:
      "The exact write participates in the bounded dormant lattice record lifecycle and is governed by the adapter transaction or immutable insert contract.",
    testEvidence: [STORAGE_EVIDENCE],
    classification: "protected",
    keyFamily: writerKeyFamily(locator),
    bridgeRepository: BRIDGE_REPOSITORY,
    negativeTestEvidence: [STORAGE_EVIDENCE],
  }));
