import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
  type PgPolicy,
} from "drizzle-orm/pg-core";
import { actors } from "./trust.ts";
import { users } from "./users.ts";
import { nautiloInstanceIdentity } from "./instance-identity.ts";

/**
 * Database-owned copies of the durable v2 bounds. These literals are frozen
 * here so schema generation never imports the cryptographic package. A bridge
 * parity test must fail if the public crypto limits change.
 */
export const CRYPTO_STORAGE_BYTE_LIMITS = Object.freeze({
  id: 128,
  roster: 1_048_616,
  namespaceBinding: 1_048_616,
  namespaceKeyring: 262_144,
  encryptedObject: 1_048_616,
  objectAccessManifest: 1_048_616,
  objectAccessEnvelope: 1_048_576,
  agentRuntimeDomainEnvelope: 1_048_576,
  agentRuntimeSignerPublication: 1_024,
  signingPublicKey: 32,
  wrappedDekMinimum: 40,
  wrappedDekMaximum: 4_096,
  grant: 16 * 1_024 * 1_024,
  recoveryArchive: 67_108_864,
  hash: 32,
});

export const CRYPTO_STORAGE_COLLECTION_LIMITS = Object.freeze({
  objectAccessEnvelopes: 256,
  agentRuntimeConfigObjects: 256,
  agentRuntimeDomainEnvelopes: 16_384,
  agentRuntimeChallenges: 16_384,
  maximumOrdinal: 255,
  agentGrantMaximumOrdinal: 16_383,
  maximumSafeCounter: Number.MAX_SAFE_INTEGER,
});

/**
 * Database-owned copies of the Wave-10 background wire and product-policy
 * bounds. Crypto-format maximums remain owned by @nautilo/lattice-crypto;
 * parity tests prevent these durable limits from drifting silently.
 */
export const BACKGROUND_AUTHORIZATION_BYTE_LIMITS = Object.freeze({
  hash: 32,
  legacyDescriptor: 128 * 1_024,
  legacyProcessorResponse: 196 * 1_024,
  legacySignerAuthorization: 128 * 1_024,
  // Structurally derived exact-set V2 carriers; bridge parity tests bind these
  // database copies to the public codecs. No unrelated grant bound changes.
  descriptor: 16_457_643,
  processorResponse: 35_669_931,
  agentResponse: 16 * 1_024 * 1_024 + 128 * 1_024 + 4 * 1_024,
  response: 35_669_931,
  recipientPublicKey: 65,
  signingPublicKey: 32,
  signerAuthorization: 16_458_519,
});

export const BACKGROUND_AUTHORIZATION_COLLECTION_LIMITS = Object.freeze({
  maximumAttempts: 8,
  maximumOutputObjects: 256,
  productTtlSeconds: 5 * 60,
  claimLeaseSeconds: 2 * 60,
  terminalRetentionDays: 30,
  pruningBatch: 256,
});

/**
 * Exact tables consumed by the generic LatticeStorage adapter. Wave-specific
 * coordination ledgers live beside them under the crypto role but have their
 * own bounded repositories.
 */
export const LATTICE_STORAGE_ADAPTER_TABLE_NAMES = Object.freeze([
  "crypto_domains",
  "crypto_domain_provider_heads",
  "namespace_crypto_bindings",
  "namespace_crypto_heads",
  "crypto_objects",
  "object_crypto_access_manifests",
  "object_crypto_namespace_envelopes",
  "object_crypto_access_heads",
  "agent_crypto_runtime_states",
  "agent_crypto_runtime_config_objects",
  "agent_crypto_runtime_domain_envelopes",
  "agent_crypto_runtime_challenges",
  "agent_crypto_runtime_signers",
  "crypto_grants",
  "human_crypto_recovery_archives",
] as const);

export const LATTICE_STORAGE_TABLE_NAMES = Object.freeze([
  ...LATTICE_STORAGE_ADAPTER_TABLE_NAMES,
  "background_crypto_authorization_requests",
  "background_crypto_authorization_domain_requirements",
  "background_crypto_authorization_namespace_requirements",
  "processor_crypto_signer_authorizations",
] as const);

export const CRYPTO_DELIVERY_TABLE_NAMES = Object.freeze([
  "human_crypto_custodies",
  "human_crypto_devices",
  "human_crypto_device_group_heads",
  "human_crypto_device_group_join_requests",
  "human_crypto_device_group_commits",
  "human_crypto_device_group_welcomes",
  "human_crypto_device_group_acknowledgements",
  "human_crypto_device_challenges",
  "human_crypto_device_admission_challenges",
  "human_crypto_device_admissions",
  "human_crypto_recovery_keys",
  "human_crypto_device_key_packages",
  "crypto_domain_devices",
  "crypto_delivery_operations",
  "crypto_human_membership_transitions",
  "crypto_device_epoch_operations",
  "crypto_domain_transition_steps",
  "crypto_domain_transition_namespaces",
  "crypto_delivery_messages",
  "crypto_delivery_acknowledgements",
  "crypto_operation_outbox",
] as const);

export const CRYPTO_STORAGE_TABLE_NAMES = Object.freeze([
  ...LATTICE_STORAGE_TABLE_NAMES,
  ...CRYPTO_DELIVERY_TABLE_NAMES,
] as const);

export const CRYPTO_DELIVERY_BYTE_LIMITS = Object.freeze({
  hash: 32,
  signingPublicKey: 32,
  encryptionPublicKey: 65,
  opaquePayload: 1_048_616,
  aggregateOpaquePayload: 67_108_864,
  contentFreeOutboxPayload: 4_096,
  humanDeviceGroupHead: 16 * 1_024,
  humanDeviceGroupCommit: 1_048_616,
  humanDeviceGroupTransition: 3 * 1_048_616,
  humanDeviceGroupWelcome: 1_048_616,
  humanDeviceGroupRoster: 1_048_616,
});

export const CRYPTO_DELIVERY_COLLECTION_LIMITS = Object.freeze({
  activeDevicesPerHuman: 16,
  pendingDevicesPerHuman: 4,
  keyPackagesPerDevice: 16,
  keyPackageReplenishWatermark: 4,
  keyPackageUploadBatch: 12,
  currentDeviceLeavesPerDomain: 256,
  activeDomainsPerHumanOrDevice: 256,
  namespaceStepsPerDomain: 256,
  fanoutRowsPerOperation: 4_096,
  outstandingOperationsPerHuman: 8,
  mutatingOperationsPerDomain: 1,
  mutatingOperationsPerNamespace: 1,
  challengeTtlSeconds: 300,
  leaseTtlSeconds: 30,
  leaseHeartbeatSeconds: 10,
  maximumAttempts: 8,
  pruningBatch: 256,
  humanDeviceGroupCommitPage: 64,
});

export type CryptoStorageTableName =
  (typeof CRYPTO_STORAGE_TABLE_NAMES)[number];
export type CryptoStorageTablePrivilege =
  | "SELECT"
  | "INSERT"
  | "UPDATE"
  | "DELETE";

/**
 * One canonical least-privilege table contract shared by generated-migration
 * review and every fresh/repair/restore reconciliation path.
 */
export const CRYPTO_STORAGE_TABLE_PRIVILEGES = Object.freeze({
  crypto_domains: Object.freeze(["SELECT", "INSERT", "UPDATE"]),
  crypto_domain_provider_heads: Object.freeze([
    "SELECT",
    "INSERT",
    "UPDATE",
  ]),
  namespace_crypto_bindings: Object.freeze(["SELECT", "INSERT"]),
  namespace_crypto_heads: Object.freeze(["SELECT", "INSERT", "UPDATE"]),
  crypto_objects: Object.freeze(["SELECT", "INSERT"]),
  object_crypto_access_manifests: Object.freeze(["SELECT", "INSERT"]),
  object_crypto_namespace_envelopes: Object.freeze(["SELECT", "INSERT"]),
  object_crypto_access_heads: Object.freeze(["SELECT", "INSERT", "UPDATE"]),
  agent_crypto_runtime_states: Object.freeze(["SELECT", "INSERT", "UPDATE"]),
  agent_crypto_runtime_config_objects: Object.freeze([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
  ]),
  agent_crypto_runtime_domain_envelopes: Object.freeze([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
  ]),
  agent_crypto_runtime_challenges: Object.freeze([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
  ]),
  agent_crypto_runtime_signers: Object.freeze(["SELECT", "INSERT"]),
  crypto_grants: Object.freeze(["SELECT", "INSERT", "UPDATE"]),
  human_crypto_recovery_archives: Object.freeze([
    "SELECT",
    "INSERT",
    "UPDATE",
  ]),
  background_crypto_authorization_requests: Object.freeze([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
  ]),
  background_crypto_authorization_domain_requirements: Object.freeze([
    "SELECT",
    "INSERT",
    "DELETE",
  ]),
  background_crypto_authorization_namespace_requirements: Object.freeze([
    "SELECT",
    "INSERT",
    "DELETE",
  ]),
  processor_crypto_signer_authorizations: Object.freeze([
    "SELECT",
    "INSERT",
  ]),
  human_crypto_custodies: Object.freeze(["SELECT", "INSERT", "UPDATE"]),
  human_crypto_devices: Object.freeze(["SELECT", "INSERT", "UPDATE"]),
  human_crypto_device_group_heads: Object.freeze([
    "SELECT",
    "INSERT",
    "UPDATE",
  ]),
  human_crypto_device_group_join_requests: Object.freeze([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
  ]),
  human_crypto_device_group_commits: Object.freeze([
    "SELECT",
    "INSERT",
    "DELETE",
  ]),
  human_crypto_device_group_welcomes: Object.freeze([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
  ]),
  human_crypto_device_group_acknowledgements: Object.freeze([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
  ]),
  human_crypto_device_challenges: Object.freeze([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
  ]),
  human_crypto_device_admission_challenges: Object.freeze([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
  ]),
  human_crypto_device_admissions: Object.freeze([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
  ]),
  human_crypto_recovery_keys: Object.freeze(["SELECT", "INSERT", "UPDATE"]),
  human_crypto_device_key_packages: Object.freeze([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
  ]),
  crypto_domain_devices: Object.freeze(["SELECT", "INSERT", "UPDATE"]),
  crypto_delivery_operations: Object.freeze([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
  ]),
  crypto_human_membership_transitions: Object.freeze([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
  ]),
  crypto_device_epoch_operations: Object.freeze([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
  ]),
  crypto_domain_transition_steps: Object.freeze([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
  ]),
  crypto_domain_transition_namespaces: Object.freeze([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
  ]),
  crypto_delivery_messages: Object.freeze(["SELECT", "INSERT", "DELETE"]),
  crypto_delivery_acknowledgements: Object.freeze([
    "SELECT",
    "INSERT",
    "DELETE",
  ]),
  crypto_operation_outbox: Object.freeze([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
  ]),
} satisfies Readonly<
  Record<CryptoStorageTableName, readonly CryptoStorageTablePrivilege[]>
>);

const bytea = customType<{
  data: Uint8Array;
  driverData: Uint8Array;
}>({
  dataType: () => "bytea",
});

export const nautiloCryptoRole = pgRole("nautilo_crypto").existing();

function portableId(name: string, column: AnyPgColumn) {
  return check(
    name,
    sql`octet_length(${column}) between 1
      and ${sql.raw(String(CRYPTO_STORAGE_BYTE_LIMITS.id))}
      and ${column} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'`,
  );
}

function safeCounter(name: string, column: AnyPgColumn) {
  return check(
    name,
    sql`${column} between 0 and ${
      sql.raw(String(CRYPTO_STORAGE_COLLECTION_LIMITS.maximumSafeCounter))
    }`,
  );
}

function exactBytes(name: string, column: AnyPgColumn, length: number) {
  return check(
    name,
    sql`octet_length(${column}) = ${sql.raw(String(length))}`,
  );
}

function boundedBytes(
  name: string,
  column: AnyPgColumn,
  maximum: number,
  minimum = 0,
) {
  return check(
    name,
    sql`octet_length(${column}) between ${sql.raw(String(minimum))}
      and ${sql.raw(String(maximum))}`,
  );
}

function boundedOrdinal(
  name: string,
  column: AnyPgColumn,
  maximum: number = CRYPTO_STORAGE_COLLECTION_LIMITS.maximumOrdinal,
) {
  return check(
    name,
    sql`${column} between 0
      and ${sql.raw(String(maximum))}`,
  );
}

function selectPolicy(prefix: string): PgPolicy {
  return pgPolicy(`${prefix}_crypto_sel`, {
    for: "select",
    to: nautiloCryptoRole,
    using: sql`true`,
  });
}

function insertPolicy(prefix: string): PgPolicy {
  return pgPolicy(`${prefix}_crypto_ins`, {
    for: "insert",
    to: nautiloCryptoRole,
    withCheck: sql`true`,
  });
}

function updatePolicy(prefix: string): PgPolicy {
  return pgPolicy(`${prefix}_crypto_upd`, {
    for: "update",
    to: nautiloCryptoRole,
    using: sql`true`,
    withCheck: sql`true`,
  });
}

function deletePolicy(prefix: string): PgPolicy {
  return pgPolicy(`${prefix}_crypto_del`, {
    for: "delete",
    to: nautiloCryptoRole,
    using: sql`true`,
  });
}

function appendOnlyPolicies(prefix: string): PgPolicy[] {
  return [selectPolicy(prefix), insertPolicy(prefix)];
}

function prunableAppendOnlyPolicies(prefix: string): PgPolicy[] {
  return [...appendOnlyPolicies(prefix), deletePolicy(prefix)];
}

function mutablePolicies(
  prefix: string,
  options: Readonly<{ delete?: boolean }> = {},
): PgPolicy[] {
  return [
    selectPolicy(prefix),
    insertPolicy(prefix),
    updatePolicy(prefix),
    ...(options.delete ? [deletePolicy(prefix)] : []),
  ];
}

export const cryptoDomains = pgTable(
  "crypto_domains",
  {
    id: text("id").primaryKey(),
    participantDigest: bytea("participant_digest").notNull(),
    participants: text("participants").array().notNull(),
    epoch: bigint("epoch", { mode: "number" }).notNull(),
    authorizationRevision: bigint("authorization_revision", {
      mode: "number",
    }).notNull(),
    rosterBytes: bytea("roster_bytes").notNull(),
    writesPaused: boolean("writes_paused").notNull().default(false),
    pauseOperationId: text("pause_operation_id"),
  },
  (table) => [
    portableId("crypto_domains_id_portable", table.id),
    exactBytes(
      "crypto_domains_participant_digest_size",
      table.participantDigest,
      CRYPTO_STORAGE_BYTE_LIMITS.hash,
    ),
    check(
      "crypto_domains_participants_count",
      sql`cardinality(${table.participants}) >= 1`,
    ),
    check(
      // Function contract: crypto-participant-set-authority.ts (M314).
      "crypto_domains_participants_canonical",
      sql`crypto_participants_are_canonical(${table.participants})`,
    ),
    safeCounter("crypto_domains_epoch_safe", table.epoch),
    safeCounter(
      "crypto_domains_authorization_revision_safe",
      table.authorizationRevision,
    ),
    boundedBytes(
      "crypto_domains_roster_size",
      table.rosterBytes,
      CRYPTO_STORAGE_BYTE_LIMITS.roster,
    ),
    portableId(
      "crypto_domains_pause_operation_id_portable",
      table.pauseOperationId,
    ),
    check(
      "crypto_domains_pause_coherent",
      sql`(${table.writesPaused} and ${table.pauseOperationId} is not null)
        or (not ${table.writesPaused} and ${table.pauseOperationId} is null)`,
    ),
    index("idx_crypto_domains_participant_digest").on(
      table.participantDigest,
    ),
    ...mutablePolicies("crypto_domains"),
  ],
).enableRLS();

export const cryptoDomainProviderHeads = pgTable(
  "crypto_domain_provider_heads",
  {
    domainId: text("domain_id").primaryKey(),
    providerId: text("provider_id").notNull(),
    epoch: bigint("epoch", { mode: "number" }).notNull(),
    stateHash: bytea("state_hash").notNull(),
    rosterBytes: bytea("roster_bytes").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.domainId],
      foreignColumns: [cryptoDomains.id],
      name: "crypto_domain_provider_heads_domain_fk",
    }),
    portableId("crypto_domain_provider_heads_domain_id_portable", table.domainId),
    portableId(
      "crypto_domain_provider_heads_provider_id_portable",
      table.providerId,
    ),
    safeCounter("crypto_domain_provider_heads_epoch_safe", table.epoch),
    exactBytes(
      "crypto_domain_provider_heads_state_hash_size",
      table.stateHash,
      CRYPTO_STORAGE_BYTE_LIMITS.hash,
    ),
    boundedBytes(
      "crypto_domain_provider_heads_roster_size",
      table.rosterBytes,
      CRYPTO_STORAGE_BYTE_LIMITS.roster,
    ),
    ...mutablePolicies("crypto_domain_provider_heads"),
  ],
).enableRLS();

export const namespaceCryptoBindings = pgTable(
  "namespace_crypto_bindings",
  {
    namespaceId: text("namespace_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    bindingHash: bytea("binding_hash").notNull(),
    previousBindingHash: bytea("previous_binding_hash"),
    signedBindingBytes: bytea("signed_binding_bytes").notNull(),
    humanKeyringEnvelopeBytes: bytea("human_keyring_envelope_bytes").notNull(),
    aiKeyringEnvelopeBytes: bytea("ai_keyring_envelope_bytes").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.namespaceId, table.revision] }),
    portableId(
      "namespace_crypto_bindings_namespace_id_portable",
      table.namespaceId,
    ),
    safeCounter("namespace_crypto_bindings_revision_safe", table.revision),
    exactBytes(
      "namespace_crypto_bindings_binding_hash_size",
      table.bindingHash,
      CRYPTO_STORAGE_BYTE_LIMITS.hash,
    ),
    check(
      "namespace_crypto_bindings_previous_hash_size",
      sql`${table.previousBindingHash} is null
        or octet_length(${table.previousBindingHash})
          = ${sql.raw(String(CRYPTO_STORAGE_BYTE_LIMITS.hash))}`,
    ),
    boundedBytes(
      "namespace_crypto_bindings_signed_size",
      table.signedBindingBytes,
      CRYPTO_STORAGE_BYTE_LIMITS.namespaceBinding,
      1,
    ),
    unique("uq_namespace_crypto_bindings_hash").on(
      table.namespaceId,
      table.bindingHash,
    ),
    unique("uq_namespace_crypto_bindings_head").on(
      table.namespaceId,
      table.revision,
      table.bindingHash,
    ),
    foreignKey({
      columns: [table.namespaceId, table.previousBindingHash],
      foreignColumns: [table.namespaceId, table.bindingHash],
      name: "namespace_crypto_bindings_previous_fk",
    }),
    check(
      "namespace_crypto_bindings_genesis_chain",
      sql`(
        ${table.revision} = 0 and ${table.previousBindingHash} is null
      ) or (
        ${table.revision} > 0 and ${table.previousBindingHash} is not null
      )`,
    ),
    boundedBytes(
      "namespace_crypto_bindings_human_keyring_size",
      table.humanKeyringEnvelopeBytes,
      CRYPTO_STORAGE_BYTE_LIMITS.namespaceKeyring,
      1,
    ),
    boundedBytes(
      "namespace_crypto_bindings_ai_keyring_size",
      table.aiKeyringEnvelopeBytes,
      CRYPTO_STORAGE_BYTE_LIMITS.namespaceKeyring,
      1,
    ),
    ...appendOnlyPolicies("namespace_crypto_bindings"),
  ],
).enableRLS();

export const namespaceCryptoHeads = pgTable(
  "namespace_crypto_heads",
  {
    namespaceId: text("namespace_id").primaryKey(),
    accessRevision: bigint("access_revision", { mode: "number" }).notNull(),
    bindingHash: bytea("binding_hash").notNull(),
    domainId: text("domain_id").notNull(),
    domainEpoch: bigint("domain_epoch", { mode: "number" }).notNull(),
    writesPaused: boolean("writes_paused").notNull().default(false),
    pauseOperationId: text("pause_operation_id"),
  },
  (table) => [
    foreignKey({
      columns: [
        table.namespaceId,
        table.accessRevision,
        table.bindingHash,
      ],
      foreignColumns: [
        namespaceCryptoBindings.namespaceId,
        namespaceCryptoBindings.revision,
        namespaceCryptoBindings.bindingHash,
      ],
      name: "namespace_crypto_heads_binding_fk",
    }),
    portableId(
      "namespace_crypto_heads_namespace_id_portable",
      table.namespaceId,
    ),
    safeCounter(
      "namespace_crypto_heads_access_revision_safe",
      table.accessRevision,
    ),
    exactBytes(
      "namespace_crypto_heads_binding_hash_size",
      table.bindingHash,
      CRYPTO_STORAGE_BYTE_LIMITS.hash,
    ),
    portableId("namespace_crypto_heads_domain_id_portable", table.domainId),
    safeCounter(
      "namespace_crypto_heads_domain_epoch_safe",
      table.domainEpoch,
    ),
    portableId(
      "namespace_crypto_heads_pause_operation_id_portable",
      table.pauseOperationId,
    ),
    check(
      "namespace_crypto_heads_pause_coherent",
      sql`(${table.writesPaused} and ${table.pauseOperationId} is not null)
        or (not ${table.writesPaused} and ${table.pauseOperationId} is null)`,
    ),
    ...mutablePolicies("namespace_crypto_heads"),
  ],
).enableRLS();

export const cryptoObjects = pgTable(
  "crypto_objects",
  {
    objectId: text("object_id").primaryKey(),
    payloadHash: bytea("payload_hash").notNull(),
    payloadBytes: bytea("payload_bytes").notNull(),
  },
  (table) => [
    portableId("crypto_objects_object_id_portable", table.objectId),
    exactBytes(
      "crypto_objects_payload_hash_size",
      table.payloadHash,
      CRYPTO_STORAGE_BYTE_LIMITS.hash,
    ),
    boundedBytes(
      "crypto_objects_payload_size",
      table.payloadBytes,
      CRYPTO_STORAGE_BYTE_LIMITS.encryptedObject,
      1,
    ),
    ...appendOnlyPolicies("crypto_objects"),
  ],
).enableRLS();

export const objectCryptoAccessManifests = pgTable(
  "object_crypto_access_manifests",
  {
    objectId: text("object_id").notNull(),
    accessRevision: bigint("access_revision", { mode: "number" }).notNull(),
    manifestHash: bytea("manifest_hash").notNull(),
    previousManifestHash: bytea("previous_manifest_hash"),
    payloadHash: bytea("payload_hash").notNull(),
    manifestBytes: bytea("manifest_bytes").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.objectId, table.accessRevision] }),
    unique("uq_object_crypto_access_manifests_hash").on(
      table.objectId,
      table.manifestHash,
    ),
    unique("uq_object_crypto_access_manifests_head").on(
      table.objectId,
      table.accessRevision,
      table.manifestHash,
    ),
    foreignKey({
      columns: [table.objectId],
      foreignColumns: [cryptoObjects.objectId],
      name: "object_crypto_access_manifests_object_fk",
    }),
    foreignKey({
      columns: [table.objectId, table.previousManifestHash],
      foreignColumns: [table.objectId, table.manifestHash],
      name: "object_crypto_access_manifests_previous_fk",
    }),
    portableId(
      "object_crypto_access_manifests_object_id_portable",
      table.objectId,
    ),
    safeCounter(
      "object_crypto_access_manifests_revision_safe",
      table.accessRevision,
    ),
    exactBytes(
      "object_crypto_access_manifests_hash_size",
      table.manifestHash,
      CRYPTO_STORAGE_BYTE_LIMITS.hash,
    ),
    check(
      "object_crypto_access_manifests_previous_hash_size",
      sql`${table.previousManifestHash} is null
        or octet_length(${table.previousManifestHash})
          = ${sql.raw(String(CRYPTO_STORAGE_BYTE_LIMITS.hash))}`,
    ),
    exactBytes(
      "object_crypto_access_manifests_payload_hash_size",
      table.payloadHash,
      CRYPTO_STORAGE_BYTE_LIMITS.hash,
    ),
    check(
      "object_crypto_access_manifests_genesis_chain",
      sql`(
        ${table.accessRevision} = 0
        and ${table.previousManifestHash} is null
      ) or (
        ${table.accessRevision} > 0
        and ${table.previousManifestHash} is not null
      )`,
    ),
    boundedBytes(
      "object_crypto_access_manifests_bytes_size",
      table.manifestBytes,
      CRYPTO_STORAGE_BYTE_LIMITS.objectAccessManifest,
      1,
    ),
    ...appendOnlyPolicies("object_crypto_access_manifests"),
  ],
).enableRLS();

export const objectCryptoNamespaceEnvelopes = pgTable(
  "object_crypto_namespace_envelopes",
  {
    objectId: text("object_id").notNull(),
    accessRevision: bigint("access_revision", { mode: "number" }).notNull(),
    namespaceId: text("namespace_id").notNull(),
    ordinal: smallint("ordinal").notNull(),
    envelopeHash: bytea("envelope_hash").notNull(),
    envelopeBytes: bytea("envelope_bytes").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.objectId,
        table.accessRevision,
        table.namespaceId,
      ],
    }),
    uniqueIndex("uq_object_crypto_namespace_envelopes_ordinal").on(
      table.objectId,
      table.accessRevision,
      table.ordinal,
    ),
    foreignKey({
      columns: [table.objectId, table.accessRevision],
      foreignColumns: [
        objectCryptoAccessManifests.objectId,
        objectCryptoAccessManifests.accessRevision,
      ],
      name: "object_crypto_namespace_envelopes_manifest_fk",
    }),
    portableId(
      "object_crypto_namespace_envelopes_object_id_portable",
      table.objectId,
    ),
    safeCounter(
      "object_crypto_namespace_envelopes_revision_safe",
      table.accessRevision,
    ),
    portableId(
      "object_crypto_namespace_envelopes_namespace_id_portable",
      table.namespaceId,
    ),
    boundedOrdinal(
      "object_crypto_namespace_envelopes_ordinal_range",
      table.ordinal,
    ),
    exactBytes(
      "object_crypto_namespace_envelopes_hash_size",
      table.envelopeHash,
      CRYPTO_STORAGE_BYTE_LIMITS.hash,
    ),
    boundedBytes(
      "object_crypto_namespace_envelopes_bytes_size",
      table.envelopeBytes,
      CRYPTO_STORAGE_BYTE_LIMITS.objectAccessEnvelope,
      1,
    ),
    ...appendOnlyPolicies("object_crypto_namespace_envelopes"),
  ],
).enableRLS();

export const objectCryptoAccessHeads = pgTable(
  "object_crypto_access_heads",
  {
    objectId: text("object_id").primaryKey(),
    accessRevision: bigint("access_revision", { mode: "number" }).notNull(),
    manifestHash: bytea("manifest_hash").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [
        table.objectId,
        table.accessRevision,
        table.manifestHash,
      ],
      foreignColumns: [
        objectCryptoAccessManifests.objectId,
        objectCryptoAccessManifests.accessRevision,
        objectCryptoAccessManifests.manifestHash,
      ],
      name: "object_crypto_access_heads_manifest_fk",
    }),
    portableId(
      "object_crypto_access_heads_object_id_portable",
      table.objectId,
    ),
    safeCounter(
      "object_crypto_access_heads_revision_safe",
      table.accessRevision,
    ),
    exactBytes(
      "object_crypto_access_heads_manifest_hash_size",
      table.manifestHash,
      CRYPTO_STORAGE_BYTE_LIMITS.hash,
    ),
    ...mutablePolicies("object_crypto_access_heads"),
  ],
).enableRLS();

export const agentCryptoRuntimeStates = pgTable(
  "agent_crypto_runtime_states",
  {
    agentId: text("agent_id").primaryKey(),
    authorizationRevision: bigint("authorization_revision", {
      mode: "number",
    }).notNull(),
    runtimeGeneration: bigint("runtime_generation", {
      mode: "number",
    }).notNull(),
    configObjectCount: integer("config_object_count").notNull(),
    configInventoryDigest: bytea("config_inventory_digest").notNull(),
  },
  (table) => [
    portableId(
      "agent_crypto_runtime_states_agent_id_portable",
      table.agentId,
    ),
    safeCounter(
      "agent_crypto_runtime_states_authorization_revision_safe",
      table.authorizationRevision,
    ),
    safeCounter(
      "agent_crypto_runtime_states_generation_safe",
      table.runtimeGeneration,
    ),
    check(
      "agent_crypto_runtime_states_config_count_range",
      sql`${table.configObjectCount} between 0
        and ${
          sql.raw(
            String(
              CRYPTO_STORAGE_COLLECTION_LIMITS.agentRuntimeConfigObjects,
            ),
          )
        }`,
    ),
    exactBytes(
      "agent_crypto_runtime_states_inventory_digest_size",
      table.configInventoryDigest,
      CRYPTO_STORAGE_BYTE_LIMITS.hash,
    ),
    ...mutablePolicies("agent_crypto_runtime_states"),
  ],
).enableRLS();

export const agentCryptoRuntimeConfigObjects = pgTable(
  "agent_crypto_runtime_config_objects",
  {
    agentId: text("agent_id").notNull(),
    objectId: text("object_id").notNull(),
    ordinal: smallint("ordinal").notNull(),
    configRevision: bigint("config_revision", { mode: "number" }).notNull(),
    runtimeGeneration: bigint("runtime_generation", {
      mode: "number",
    }).notNull(),
    wrappedDekHash: bytea("wrapped_dek_hash").notNull(),
    wrappedDekBytes: bytea("wrapped_dek_bytes").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.objectId] }),
    uniqueIndex("uq_agent_crypto_runtime_config_objects_ordinal").on(
      table.agentId,
      table.ordinal,
    ),
    foreignKey({
      columns: [table.agentId],
      foreignColumns: [agentCryptoRuntimeStates.agentId],
      name: "agent_crypto_runtime_config_objects_state_fk",
    }),
    portableId(
      "agent_crypto_runtime_config_objects_agent_id_portable",
      table.agentId,
    ),
    portableId(
      "agent_crypto_runtime_config_objects_object_id_portable",
      table.objectId,
    ),
    boundedOrdinal(
      "agent_crypto_runtime_config_objects_ordinal_range",
      table.ordinal,
    ),
    safeCounter(
      "agent_crypto_runtime_config_objects_config_revision_safe",
      table.configRevision,
    ),
    safeCounter(
      "agent_crypto_runtime_config_objects_generation_safe",
      table.runtimeGeneration,
    ),
    exactBytes(
      "agent_crypto_runtime_config_objects_wrapped_hash_size",
      table.wrappedDekHash,
      CRYPTO_STORAGE_BYTE_LIMITS.hash,
    ),
    boundedBytes(
      "agent_crypto_runtime_config_objects_wrapped_dek_size",
      table.wrappedDekBytes,
      CRYPTO_STORAGE_BYTE_LIMITS.wrappedDekMaximum,
      CRYPTO_STORAGE_BYTE_LIMITS.wrappedDekMinimum,
    ),
    ...mutablePolicies("agent_crypto_runtime_config_objects", {
      delete: true,
    }),
  ],
).enableRLS();

export const agentCryptoRuntimeDomainEnvelopes = pgTable(
  "agent_crypto_runtime_domain_envelopes",
  {
    agentId: text("agent_id").notNull(),
    domainId: text("domain_id").notNull(),
    ordinal: smallint("ordinal").notNull(),
    domainEpoch: bigint("domain_epoch", { mode: "number" }).notNull(),
    agentAuthorizationRevision: bigint("agent_authorization_revision", {
      mode: "number",
    }).notNull(),
    runtimeGeneration: bigint("runtime_generation", {
      mode: "number",
    }).notNull(),
    committerDeviceId: text("committer_device_id").notNull(),
    envelopeHash: bytea("envelope_hash").notNull(),
    envelopeBytes: bytea("envelope_bytes").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.domainId] }),
    uniqueIndex("uq_agent_crypto_runtime_domain_envelopes_ordinal").on(
      table.agentId,
      table.ordinal,
    ),
    foreignKey({
      columns: [table.agentId],
      foreignColumns: [agentCryptoRuntimeStates.agentId],
      name: "agent_crypto_runtime_domain_envelopes_state_fk",
    }),
    portableId(
      "agent_crypto_runtime_domain_envelopes_agent_id_portable",
      table.agentId,
    ),
    portableId(
      "agent_crypto_runtime_domain_envelopes_domain_id_portable",
      table.domainId,
    ),
    boundedOrdinal(
      "agent_crypto_runtime_domain_envelopes_ordinal_range",
      table.ordinal,
      CRYPTO_STORAGE_COLLECTION_LIMITS.agentGrantMaximumOrdinal,
    ),
    safeCounter(
      "agent_crypto_runtime_domain_envelopes_domain_epoch_safe",
      table.domainEpoch,
    ),
    safeCounter(
      "agent_crypto_runtime_domain_envelopes_authorization_revision_safe",
      table.agentAuthorizationRevision,
    ),
    safeCounter(
      "agent_crypto_runtime_domain_envelopes_generation_safe",
      table.runtimeGeneration,
    ),
    portableId(
      "agent_crypto_runtime_domain_envelopes_device_id_portable",
      table.committerDeviceId,
    ),
    exactBytes(
      "agent_crypto_runtime_domain_envelopes_hash_size",
      table.envelopeHash,
      CRYPTO_STORAGE_BYTE_LIMITS.hash,
    ),
    boundedBytes(
      "agent_crypto_runtime_domain_envelopes_bytes_size",
      table.envelopeBytes,
      CRYPTO_STORAGE_BYTE_LIMITS.agentRuntimeDomainEnvelope,
      1,
    ),
    ...mutablePolicies("agent_crypto_runtime_domain_envelopes", {
      delete: true,
    }),
  ],
).enableRLS();

export const agentCryptoRuntimeChallenges = pgTable(
  "agent_crypto_runtime_challenges",
  {
    agentId: text("agent_id").notNull(),
    challengeHash: bytea("challenge_hash").notNull(),
    ordinal: smallint("ordinal").notNull(),
    consumed: boolean("consumed").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.challengeHash] }),
    uniqueIndex("uq_agent_crypto_runtime_challenges_ordinal").on(
      table.agentId,
      table.ordinal,
    ),
    foreignKey({
      columns: [table.agentId],
      foreignColumns: [agentCryptoRuntimeStates.agentId],
      name: "agent_crypto_runtime_challenges_state_fk",
    }),
    portableId(
      "agent_crypto_runtime_challenges_agent_id_portable",
      table.agentId,
    ),
    exactBytes(
      "agent_crypto_runtime_challenges_hash_size",
      table.challengeHash,
      CRYPTO_STORAGE_BYTE_LIMITS.hash,
    ),
    boundedOrdinal(
      "agent_crypto_runtime_challenges_ordinal_range",
      table.ordinal,
      CRYPTO_STORAGE_COLLECTION_LIMITS.agentGrantMaximumOrdinal,
    ),
    ...mutablePolicies("agent_crypto_runtime_challenges", {
      delete: true,
    }),
  ],
).enableRLS();

export const agentCryptoRuntimeSigners = pgTable(
  "agent_crypto_runtime_signers",
  {
    agentId: text("agent_id").notNull(),
    runtimeGeneration: bigint("runtime_generation", {
      mode: "number",
    }).notNull(),
    authorizationRevision: bigint("authorization_revision", {
      mode: "number",
    }).notNull(),
    transitionKind: text("transition_kind").notNull(),
    operationId: text("operation_id").notNull(),
    signerKeyId: text("signer_key_id").notNull(),
    signerPublicKey: bytea("signer_public_key").notNull(),
    publicationBytes: bytea("publication_bytes").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.runtimeGeneration] }),
    unique("uq_agent_crypto_runtime_signers_key_id").on(table.signerKeyId),
    unique("uq_agent_crypto_runtime_signers_operation").on(
      table.agentId,
      table.operationId,
    ),
    foreignKey({
      columns: [table.agentId],
      foreignColumns: [agentCryptoRuntimeStates.agentId],
      name: "agent_crypto_runtime_signers_state_fk",
    }),
    portableId(
      "agent_crypto_runtime_signers_agent_id_portable",
      table.agentId,
    ),
    safeCounter(
      "agent_crypto_runtime_signers_generation_safe",
      table.runtimeGeneration,
    ),
    safeCounter(
      "agent_crypto_runtime_signers_authorization_revision_safe",
      table.authorizationRevision,
    ),
    check(
      "agent_crypto_runtime_signers_transition_kind",
      sql`${table.transitionKind} in ('initialization', 'rotation')`,
    ),
    check(
      "agent_crypto_runtime_signers_transition_generation_coherent",
      sql`(
        (${table.transitionKind} = 'initialization'
          and ${table.runtimeGeneration} = 0)
        or
        (${table.transitionKind} = 'rotation'
          and ${table.runtimeGeneration} > 0)
      )`,
    ),
    portableId(
      "agent_crypto_runtime_signers_operation_id_portable",
      table.operationId,
    ),
    portableId(
      "agent_crypto_runtime_signers_key_id_portable",
      table.signerKeyId,
    ),
    exactBytes(
      "agent_crypto_runtime_signers_public_key_size",
      table.signerPublicKey,
      CRYPTO_STORAGE_BYTE_LIMITS.signingPublicKey,
    ),
    boundedBytes(
      "agent_crypto_runtime_signers_publication_size",
      table.publicationBytes,
      CRYPTO_STORAGE_BYTE_LIMITS.agentRuntimeSignerPublication,
      1,
    ),
    ...appendOnlyPolicies("agent_crypto_runtime_signers"),
  ],
).enableRLS();

export const cryptoGrants = pgTable(
  "crypto_grants",
  {
    grantId: text("grant_id").primaryKey(),
    grantBytes: bytea("grant_bytes").notNull(),
    consumed: boolean("consumed").notNull(),
  },
  (table) => [
    portableId("crypto_grants_grant_id_portable", table.grantId),
    boundedBytes(
      "crypto_grants_bytes_size",
      table.grantBytes,
      CRYPTO_STORAGE_BYTE_LIMITS.grant,
      1,
    ),
    ...mutablePolicies("crypto_grants"),
  ],
).enableRLS();

export const humanCryptoRecoveryArchives = pgTable(
  "human_crypto_recovery_archives",
  {
    humanId: text("human_id").primaryKey(),
    recoveryKeyGeneration: bigint("recovery_key_generation", {
      mode: "number",
    }).notNull(),
    archiveHash: bytea("archive_hash").notNull(),
    archiveBytes: bytea("archive_bytes").notNull(),
  },
  (table) => [
    portableId(
      "human_crypto_recovery_archives_human_id_portable",
      table.humanId,
    ),
    safeCounter(
      "human_crypto_recovery_archives_generation_safe",
      table.recoveryKeyGeneration,
    ),
    exactBytes(
      "human_crypto_recovery_archives_hash_size",
      table.archiveHash,
      CRYPTO_STORAGE_BYTE_LIMITS.hash,
    ),
    boundedBytes(
      "human_crypto_recovery_archives_bytes_size",
      table.archiveBytes,
      CRYPTO_STORAGE_BYTE_LIMITS.recoveryArchive,
      1,
    ),
    ...mutablePolicies("human_crypto_recovery_archives"),
  ],
).enableRLS();

/**
 * M241 — one content-free, CAS-revisioned authorization lifecycle per exact
 * background work identity. Recipient and response bytes are public or
 * recipient-encrypted wire material; private recipient keys and opened
 * credentials must never reach this table.
 */
export const backgroundCryptoAuthorizationRequests = pgTable(
  "background_crypto_authorization_requests",
  {
    requestId: text("request_id").primaryKey(),
    formatVersion: smallint("format_version").notNull(),
    workIdentityHash: bytea("work_identity_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    workId: text("work_id").notNull(),
    workKind: text("work_kind").notNull(),
    purpose: text("purpose").notNull(),
    namespaceId: text("namespace_id").notNull(),
    domainId: text("domain_id").notNull(),
    credentialSubjectKind: text("credential_subject_kind").notNull(),
    processorKind: text("processor_kind"),
    processorVersion: smallint("processor_version"),
    processorAuthorizationRevision: bigint(
      "processor_authorization_revision",
      { mode: "number" },
    ),
    agentId: text("agent_id"),
    agentRuntimeGeneration: bigint("agent_runtime_generation", {
      mode: "number",
    }),
    agentAuthorizationRevision: bigint("agent_authorization_revision", {
      mode: "number",
    }),
    expectedDomainEpoch: bigint("expected_domain_epoch", {
      mode: "number",
    }),
    expectedNamespaceAccessRevision: bigint(
      "expected_namespace_access_revision",
      { mode: "number" },
    ).notNull(),
    expectedPolicyRevision: bigint("expected_policy_revision", {
      mode: "number",
    }).notNull(),
    recipientGeneration: bigint("recipient_generation", {
      mode: "number",
    }).notNull(),
    descriptorHash: bytea("descriptor_hash"),
    descriptorBytes: bytea("descriptor_bytes"),
    recipientKeyId: text("recipient_key_id"),
    recipientPublicKey: bytea("recipient_public_key"),
    recipientExpiresAt: timestamp("recipient_expires_at", {
      withTimezone: true,
    }),
    acceptedResponseKind: text("accepted_response_kind"),
    acceptedResponseHash: bytea("accepted_response_hash"),
    acceptedResponseBytes: bytea("accepted_response_bytes"),
    credentialId: text("credential_id"),
    credentialHash: bytea("credential_hash"),
    issuingHumanId: text("issuing_human_id"),
    issuingDeviceId: text("issuing_device_id"),
    /** M303 device securityRevision; never a processor permission revision. */
    issuingDeviceAuthorizationRevision: bigint(
      "issuing_device_authorization_revision",
      { mode: "number" },
    ),
    issuerSigningPublicKeyHash: bytea("issuer_signing_public_key_hash"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    authorizationExpiresAt: timestamp("authorization_expires_at", {
      withTimezone: true,
    }),
    requestRevision: bigint("request_revision", {
      mode: "number",
    }).notNull(),
    state: text("state").notNull(),
    claimId: text("claim_id"),
    claimExpiresAt: timestamp("claim_expires_at", {
      withTimezone: true,
    }),
    transformCommitClaimId: text("transform_commit_claim_id"),
    transformCommitDescriptorHash: bytea(
      "transform_commit_descriptor_hash",
    ),
    transformCommitRecipientGeneration: bigint(
      "transform_commit_recipient_generation",
      { mode: "number" },
    ),
    transformCommitOutputCount: smallint("transform_commit_output_count"),
    transformCommittedAt: timestamp("transform_committed_at", {
      withTimezone: true,
    }),
    retryCount: smallint("retry_count").notNull(),
    maximumAttempts: smallint("maximum_attempts").notNull(),
    lastRetryReason: text("last_retry_reason"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    terminalReason: text("terminal_reason"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("uq_background_crypto_authorization_requests_work_identity").on(
      table.workIdentityHash,
    ),
    unique("uq_background_crypto_authorization_requests_idempotency").on(
      table.idempotencyKey,
    ),
    unique("uq_background_crypto_authorization_requests_recipient_key").on(
      table.recipientKeyId,
    ),
    unique("uq_background_crypto_authorization_requests_response_hash").on(
      table.acceptedResponseHash,
    ),
    unique("uq_background_crypto_authorization_requests_credential_id").on(
      table.credentialId,
    ),
    unique("uq_background_crypto_authorization_requests_credential_hash").on(
      table.credentialHash,
    ),
    unique("uq_background_crypto_authorization_requests_claim").on(
      table.claimId,
    ),
    portableId(
      "background_crypto_authorization_requests_request_id_portable",
      table.requestId,
    ),
    check(
      "background_crypto_authorization_requests_format_version",
      sql`${table.formatVersion} = 1 or (
        ${table.formatVersion} = 2
        and ${table.credentialSubjectKind} in ('agent', 'processor')
      ) or (
        ${table.formatVersion} in (2, 3)
        and ${table.credentialSubjectKind} = 'processor'
      )`,
    ),
    exactBytes(
      "background_crypto_authorization_requests_work_identity_hash_size",
      table.workIdentityHash,
      BACKGROUND_AUTHORIZATION_BYTE_LIMITS.hash,
    ),
    portableId(
      "background_crypto_authorization_requests_idempotency_key_portable",
      table.idempotencyKey,
    ),
    portableId(
      "background_crypto_authorization_requests_work_id_portable",
      table.workId,
    ),
    check(
      "background_crypto_authorization_requests_work_kind",
      sql`${table.workKind} in (
        'stenographer.extraction',
        'stenographer.historical',
        'stenographer.compaction',
        'stenographer.rebuild',
        'stenographer.publication_reconcile',
        'stenographer.output_repair',
        'reflection.authority_reproject',
        'reflection.publication_reconcile',
        'reflection.search_projection',
        'reflection.organization',
        'reflection.dependency_rewrite',
        'memory.review',
        'memory.exit_flush',
        'task.dispatch',
        'task.execute',
        'task.approval_resume'
      )`,
    ),
    check(
      "background_crypto_authorization_requests_purpose",
      sql`${table.purpose} in (
        'journal.extract',
        'journal.compact',
        'journal.rebuild',
        'journal.reconcile',
        'journal.repair',
        'record.reproject',
        'record.reconcile',
        'record.search_projection',
        'record.organize',
        'record.dependency_rewrite',
        'memory.review',
        'memory.exit_flush',
        'task.dispatch',
        'task.execute',
        'task.approval_resume'
      )`,
    ),
    check(
      "background_crypto_authorization_requests_work_purpose_coherent",
      sql`(
        ${table.workKind} in (
          'stenographer.extraction',
          'stenographer.historical'
        ) and ${table.purpose} = 'journal.extract'
      ) or (
        ${table.workKind} = 'stenographer.compaction'
        and ${table.purpose} = 'journal.compact'
      ) or (
        ${table.workKind} = 'stenographer.rebuild'
        and ${table.purpose} = 'journal.rebuild'
      ) or (
        ${table.workKind} = 'stenographer.publication_reconcile'
        and ${table.formatVersion} in (2, 3)
        and ${table.purpose} = 'journal.reconcile'
      ) or (
        ${table.workKind} = 'stenographer.output_repair'
        and ${table.formatVersion} in (2, 3)
        and ${table.purpose} = 'journal.repair'
      ) or (
        ${table.workKind} = 'reflection.authority_reproject'
        and ${table.formatVersion} = 2
        and ${table.purpose} = 'record.reproject'
      ) or (
        ${table.workKind} = 'reflection.publication_reconcile'
        and ${table.formatVersion} = 2
        and ${table.purpose} = 'record.reconcile'
      ) or (
        ${table.workKind} = 'reflection.search_projection'
        and ${table.formatVersion} = 2
        and ${table.purpose} = 'record.search_projection'
      ) or (
        ${table.workKind} = 'reflection.organization'
        and ${table.formatVersion} = 2
        and ${table.purpose} = 'record.organize'
      ) or (
        ${table.workKind} = 'reflection.dependency_rewrite'
        and ${table.formatVersion} = 2
        and ${table.purpose} = 'record.dependency_rewrite'
      ) or ${table.workKind} = ${table.purpose}`,
    ),
    portableId(
      "background_crypto_authorization_requests_namespace_id_portable",
      table.namespaceId,
    ),
    portableId(
      "background_crypto_authorization_requests_domain_id_portable",
      table.domainId,
    ),
    check(
      "background_crypto_authorization_requests_subject_coherent",
      sql`(
        ${table.credentialSubjectKind} = 'processor'
        and (${table.processorKind} = 'stenographer'
          or (${table.processorKind} = 'reflection' and ${table.formatVersion} = 2))
        and ${table.processorVersion} = 1
        and (
          (${table.formatVersion} = 1
            and ${table.processorAuthorizationRevision} is not null)
          or (${table.formatVersion} in (2, 3)
            and ${table.processorAuthorizationRevision} is null)
        )
        and ${table.agentId} is null
        and ${table.agentRuntimeGeneration} is null
        and ${table.agentAuthorizationRevision} is null
      ) or (
        ${table.credentialSubjectKind} = 'agent'
        and ${table.processorKind} is null
        and ${table.processorVersion} is null
        and ${table.processorAuthorizationRevision} is null
        and ${table.agentId} is not null
        and ${table.agentRuntimeGeneration} is not null
        and ${table.agentAuthorizationRevision} is not null
      )`,
    ),
    check(
      "background_crypto_authorization_requests_work_subject_coherent",
      sql`(
        (${table.workKind} like 'stenographer.%' and ${table.processorKind} = 'stenographer'
          or ${table.workKind} like 'reflection.%' and ${table.processorKind} = 'reflection')
        and ${table.credentialSubjectKind} = 'processor'
      ) or (
        ${table.workKind} not like 'stenographer.%'
        and ${table.workKind} not like 'reflection.%'
        and ${table.credentialSubjectKind} = 'agent'
      )`,
    ),
    portableId(
      "background_crypto_authorization_requests_processor_kind_portable",
      table.processorKind,
    ),
    safeCounter(
      "background_crypto_authorization_requests_processor_revision_safe",
      table.processorAuthorizationRevision,
    ),
    portableId(
      "background_crypto_authorization_requests_agent_id_portable",
      table.agentId,
    ),
    safeCounter(
      "background_crypto_authorization_requests_agent_generation_safe",
      table.agentRuntimeGeneration,
    ),
    safeCounter(
      "background_crypto_authorization_requests_agent_revision_safe",
      table.agentAuthorizationRevision,
    ),
    safeCounter(
      "background_crypto_authorization_requests_domain_epoch_safe",
      table.expectedDomainEpoch,
    ),
    check(
      "background_crypto_authorization_requests_domain_epoch_coherent",
      sql`(
        (${table.formatVersion} = 1 or (${table.formatVersion} = 2 and ${table.credentialSubjectKind} = 'agent'))
        and ${table.expectedDomainEpoch} is not null
      ) or (
        ${table.formatVersion} in (2, 3)
        and ${table.credentialSubjectKind} = 'processor'
        and ${table.expectedDomainEpoch} is null
      )`,
    ),
    safeCounter(
      "background_crypto_authorization_requests_namespace_revision_safe",
      table.expectedNamespaceAccessRevision,
    ),
    safeCounter(
      "background_crypto_authorization_requests_policy_revision_safe",
      table.expectedPolicyRevision,
    ),
    check(
      "background_crypto_authorization_requests_recipient_generation_safe",
      sql`${table.recipientGeneration} between 0 and 4294967295`,
    ),
    check(
      "background_crypto_authorization_requests_descriptor_coherent",
      sql`(
        ${table.descriptorHash} is null
        and ${table.descriptorBytes} is null
      ) or (
        ${table.descriptorHash} is not null
        and ${table.descriptorBytes} is not null
        and octet_length(${table.descriptorHash})
          = ${sql.raw(String(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.hash))}
        and octet_length(${table.descriptorBytes}) between 1
          and ${sql.raw(String(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.descriptor))}
      )`,
    ),
    check(
      "background_crypto_authorization_requests_legacy_carrier_bounds",
      sql`${table.processorKind} is not distinct from 'reflection' or (
        (${table.descriptorBytes} is null or octet_length(${table.descriptorBytes}) <= ${sql.raw(String(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.legacyDescriptor))})
        and (${table.acceptedResponseKind} is distinct from 'processor'
          or ${table.acceptedResponseBytes} is null
          or octet_length(${table.acceptedResponseBytes}) <= ${sql.raw(String(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.legacyProcessorResponse))})
      )`,
    ),
    check(
      "background_crypto_authorization_requests_recipient_coherent",
      sql`(
        ${table.recipientKeyId} is null
        and ${table.recipientPublicKey} is null
        and ${table.recipientExpiresAt} is null
      ) or (
        ${table.recipientKeyId} is not null
        and ${table.recipientPublicKey} is not null
        and octet_length(${table.recipientPublicKey})
          = ${sql.raw(String(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.recipientPublicKey))}
        and ${table.recipientExpiresAt} is not null
        and ${table.descriptorHash} is not null
      )`,
    ),
    check(
      "background_crypto_authorization_requests_recipient_ttl",
      sql`${table.recipientExpiresAt} is null or (
        ${table.updatedAt} < ${table.recipientExpiresAt}
        and ${table.recipientExpiresAt}
          <= ${table.updatedAt} + interval '${
            sql.raw(
              String(
                BACKGROUND_AUTHORIZATION_COLLECTION_LIMITS.productTtlSeconds,
              ),
            )
          } seconds'
      )`,
    ),
    portableId(
      "background_crypto_authorization_requests_recipient_key_id_portable",
      table.recipientKeyId,
    ),
    check(
      "background_crypto_authorization_requests_response_coherent",
      sql`(
        ${table.acceptedResponseKind} is null
        and ${table.acceptedResponseHash} is null
        and ${table.acceptedResponseBytes} is null
        and ${table.credentialId} is null
        and ${table.credentialHash} is null
        and ${table.issuingHumanId} is null
        and ${table.issuingDeviceId} is null
        and ${table.issuingDeviceAuthorizationRevision} is null
        and ${table.issuerSigningPublicKeyHash} is null
        and ${table.acceptedAt} is null
        and ${table.authorizationExpiresAt} is null
      ) or (
        ${table.acceptedResponseKind} = ${table.credentialSubjectKind}
        and ${table.acceptedResponseHash} is not null
        and ${table.acceptedResponseBytes} is not null
        and octet_length(${table.acceptedResponseHash})
          = ${sql.raw(String(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.hash))}
        and (
          (
            ${table.acceptedResponseKind} = 'processor'
            and octet_length(${table.acceptedResponseBytes}) between 1
              and ${sql.raw(
                String(
                  BACKGROUND_AUTHORIZATION_BYTE_LIMITS.processorResponse,
                ),
              )}
          ) or (
            ${table.acceptedResponseKind} = 'agent'
            and octet_length(${table.acceptedResponseBytes}) between 1
              and ${sql.raw(
                String(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.agentResponse),
              )}
          )
        )
        and ${table.credentialId} is not null
        and ${table.credentialHash} is not null
        and octet_length(${table.credentialHash})
          = ${sql.raw(String(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.hash))}
        and ${table.issuingHumanId} is not null
        and ${table.issuingDeviceId} is not null
        and ${table.issuingDeviceAuthorizationRevision} is not null
        and ${table.issuerSigningPublicKeyHash} is not null
        and octet_length(${table.issuerSigningPublicKeyHash})
          = ${sql.raw(String(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.hash))}
        and ${table.acceptedAt} is not null
        and ${table.authorizationExpiresAt} is not null
      )`,
    ),
    check(
      "background_crypto_authorization_requests_authorization_ttl",
      sql`${table.authorizationExpiresAt} is null or (
        ${table.acceptedAt} < ${table.authorizationExpiresAt}
        and ${table.authorizationExpiresAt}
          <= ${table.acceptedAt} + interval '${
            sql.raw(
              String(
                BACKGROUND_AUTHORIZATION_COLLECTION_LIMITS.productTtlSeconds,
              ),
            )
          } seconds'
      )`,
    ),
    portableId(
      "background_crypto_authorization_requests_credential_id_portable",
      table.credentialId,
    ),
    portableId(
      "background_crypto_authorization_requests_issuing_human_id_portable",
      table.issuingHumanId,
    ),
    portableId(
      "background_crypto_authorization_requests_issuing_device_id_portable",
      table.issuingDeviceId,
    ),
    safeCounter(
      "background_crypto_authorization_requests_device_revision_safe",
      table.issuingDeviceAuthorizationRevision,
    ),
    safeCounter(
      "background_crypto_authorization_requests_request_revision_safe",
      table.requestRevision,
    ),
    check(
      "background_crypto_authorization_requests_state",
      sql`${table.state} in (
        'awaiting_recipient',
        'awaiting_device',
        'grant_ready',
        'claimed',
        'running',
        'publication_reconciliation',
        'completed',
        'cancelled',
        'terminal_failure'
      )`,
    ),
    check(
      "background_crypto_authorization_requests_state_material_coherent",
      sql`(
        ${table.state} = 'awaiting_recipient'
        and ${table.descriptorHash} is null
        and ${table.recipientKeyId} is null
        and ${table.acceptedResponseHash} is null
      ) or (
        ${table.state} = 'awaiting_device'
        and ${table.descriptorHash} is not null
        and ${table.recipientKeyId} is not null
        and ${table.acceptedResponseHash} is null
      ) or (
        ${table.state} in ('grant_ready', 'claimed', 'running')
        and ${table.descriptorHash} is not null
        and ${table.recipientKeyId} is not null
        and ${table.acceptedResponseHash} is not null
      ) or (
        ${table.state} in ('publication_reconciliation', 'completed')
        and ${table.descriptorHash} is not null
        and ${table.recipientKeyId} is null
        and ${table.acceptedResponseHash} is not null
      ) or ${table.state} in ('cancelled', 'terminal_failure')`,
    ),
    portableId(
      "background_crypto_authorization_requests_claim_id_portable",
      table.claimId,
    ),
    check(
      "background_crypto_authorization_requests_claim_coherent",
      sql`(
        ${table.state} in ('claimed', 'running')
        and ${table.claimId} is not null
        and ${table.claimExpiresAt} is not null
      ) or (
        ${table.state} not in ('claimed', 'running')
        and ${table.claimId} is null
        and ${table.claimExpiresAt} is null
      )`,
    ),
    portableId(
      "background_crypto_authorization_requests_transform_commit_claim_id_portable",
      table.transformCommitClaimId,
    ),
    check(
      "background_crypto_authorization_requests_transform_commit_coherent",
      sql`(
        ${table.transformCommitClaimId} is null
        and ${table.transformCommitDescriptorHash} is null
        and ${table.transformCommitRecipientGeneration} is null
        and ${table.transformCommitOutputCount} is null
        and ${table.transformCommittedAt} is null
      ) or (
        ${table.transformCommitClaimId} is not null
        and ${table.transformCommitDescriptorHash} is not null
        and octet_length(${table.transformCommitDescriptorHash})
          = ${sql.raw(String(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.hash))}
        and ${table.transformCommitRecipientGeneration}
          = ${table.recipientGeneration}
        and ${table.transformCommitDescriptorHash} = ${table.descriptorHash}
        and ${table.transformCommitOutputCount} between 0
          and ${sql.raw(
            String(
              BACKGROUND_AUTHORIZATION_COLLECTION_LIMITS.maximumOutputObjects,
            ),
          )}
        and ${table.transformCommittedAt} is not null
        and ${table.transformCommittedAt} >= ${table.acceptedAt}
        and ${table.transformCommittedAt} < ${table.authorizationExpiresAt}
        and ${table.state} in (
          'running',
          'publication_reconciliation',
          'completed',
          'cancelled',
          'terminal_failure'
        )
        and (
          ${table.state} <> 'running'
          or ${table.transformCommitClaimId} = ${table.claimId}
        )
      )`,
    ),
    check(
      "background_crypto_authorization_requests_retry_reason",
      sql`${table.lastRetryReason} is null or ${table.lastRetryReason} in (
        'attempt_expired',
        'claim_expired',
        'recipient_lost',
        'stale_authority',
        'key_unavailable',
        'provider_transient_failure',
        'publication_pending'
      )`,
    ),
    check(
      "background_crypto_authorization_requests_retry_bounds",
      sql`${table.retryCount} between 0 and ${table.maximumAttempts}
        and ${table.maximumAttempts} = ${
          sql.raw(
            String(
              BACKGROUND_AUTHORIZATION_COLLECTION_LIMITS.maximumAttempts,
            ),
          )
        }
        and (
          ${table.retryCount} = 0
          or (${table.retryCount} > 0 and ${table.lastRetryReason} is not null)
        )`,
    ),
    check(
      "background_crypto_authorization_requests_next_attempt_coherent",
      sql`${table.nextAttemptAt} is null
        or ${table.state} in (
          'awaiting_recipient',
          'publication_reconciliation'
        )`,
    ),
    check(
      "background_crypto_authorization_requests_terminal_reason",
      sql`${table.terminalReason} is null or ${table.terminalReason} in (
        'malformed_request',
        'integrity_failure',
        'policy_rejected',
        'unsupported_subject',
        'retry_limit_exhausted',
        'recipient_generation_exhausted',
        'cancelled',
        'superseded'
      )`,
    ),
    check(
      "background_crypto_authorization_requests_terminal_coherent",
      sql`(
        ${table.state} = 'cancelled'
        and ${table.terminalReason} in ('cancelled', 'superseded')
        and ${table.finishedAt} is not null
      ) or (
        ${table.state} = 'terminal_failure'
        and ${table.terminalReason} in (
          'malformed_request',
          'integrity_failure',
          'policy_rejected',
          'unsupported_subject',
          'retry_limit_exhausted',
          'recipient_generation_exhausted'
        )
        and ${table.finishedAt} is not null
      ) or (
        ${table.state} = 'completed'
        and ${table.terminalReason} is null
        and ${table.finishedAt} is not null
      ) or (
        ${table.state} not in (
          'completed',
          'cancelled',
          'terminal_failure'
        )
        and ${table.terminalReason} is null
        and ${table.finishedAt} is null
      )`,
    ),
    check(
      "background_crypto_authorization_requests_time_order",
      sql`${table.createdAt} <= ${table.updatedAt}
        and (
          ${table.acceptedAt} is null
          or (
            ${table.createdAt} <= ${table.acceptedAt}
            and ${table.acceptedAt} <= ${table.updatedAt}
            and ${table.acceptedAt} < ${table.authorizationExpiresAt}
          )
        )
        and (
          ${table.finishedAt} is null
          or ${table.updatedAt} <= ${table.finishedAt}
        )`,
    ),
    index("idx_background_crypto_authorization_requests_eligible").on(
      table.state,
      table.nextAttemptAt,
      table.createdAt,
    ),
    index(
      "idx_background_crypto_authorization_requests_recipient_expiry",
    ).on(table.state, table.recipientExpiresAt),
    index("idx_background_crypto_authorization_requests_claim_expiry").on(
      table.state,
      table.claimExpiresAt,
    ),
    index(
      "idx_background_crypto_authorization_requests_terminal_cleanup",
    ).on(table.finishedAt),
    ...mutablePolicies("background_crypto_authorization_requests", {
      delete: true,
    }),
  ],
).enableRLS();

/**
 * M244 — canonical per-Domain authority facts for Agent v2 background work.
 * Rows are immutable after prepare and are deleted only by bounded,
 * transactional parent pruning in the crypto repository.
 */
export const backgroundCryptoAuthorizationDomainRequirements = pgTable(
  "background_crypto_authorization_domain_requirements",
  {
    requestId: text("request_id").notNull(),
    domainId: text("domain_id").notNull(),
    ordinal: smallint("ordinal").notNull(),
    expectedEpoch: bigint("expected_epoch", { mode: "number" }).notNull(),
    expectedAgentAuthorizationRevision: bigint(
      "expected_agent_authorization_revision",
      { mode: "number" },
    ).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.requestId, table.domainId],
      name: "pk_bg_crypto_auth_domain_req",
    }),
    unique("uq_bg_crypto_auth_domain_req_ordinal").on(
      table.requestId,
      table.ordinal,
    ),
    portableId("bg_crypto_auth_domain_req_request_id_portable", table.requestId),
    portableId("bg_crypto_auth_domain_req_domain_id_portable", table.domainId),
    boundedOrdinal("bg_crypto_auth_domain_req_ordinal_range", table.ordinal),
    safeCounter("bg_crypto_auth_domain_req_epoch_safe", table.expectedEpoch),
    safeCounter(
      "bg_crypto_auth_domain_req_agent_revision_safe",
      table.expectedAgentAuthorizationRevision,
    ),
    ...prunableAppendOnlyPolicies("bg_crypto_auth_domain_req"),
  ],
).enableRLS();

/**
 * M244 — canonical per-Namespace authority and operation facts for Agent v2.
 * operation_mask is 1=decrypt, 2=encrypt, 3=both; no array/JSON state is used.
 */
export const backgroundCryptoAuthorizationNamespaceRequirements = pgTable(
  "background_crypto_authorization_namespace_requirements",
  {
    requestId: text("request_id").notNull(),
    namespaceId: text("namespace_id").notNull(),
    ordinal: smallint("ordinal").notNull(),
    domainId: text("domain_id").notNull(),
    operationMask: smallint("operation_mask").notNull(),
    expectedAccessRevision: bigint("expected_access_revision", {
      mode: "number",
    }).notNull(),
    expectedPolicyRevision: bigint("expected_policy_revision", {
      mode: "number",
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.requestId, table.namespaceId],
      name: "pk_bg_crypto_auth_ns_req",
    }),
    unique("uq_bg_crypto_auth_ns_req_ordinal").on(
      table.requestId,
      table.ordinal,
    ),
    portableId("bg_crypto_auth_ns_req_request_id_portable", table.requestId),
    portableId("bg_crypto_auth_ns_req_namespace_id_portable", table.namespaceId),
    boundedOrdinal("bg_crypto_auth_ns_req_ordinal_range", table.ordinal),
    portableId("bg_crypto_auth_ns_req_domain_id_portable", table.domainId),
    check(
      "bg_crypto_auth_ns_req_operation_mask",
      sql`${table.operationMask} between 1 and 3`,
    ),
    safeCounter(
      "bg_crypto_auth_ns_req_access_revision_safe",
      table.expectedAccessRevision,
    ),
    safeCounter(
      "bg_crypto_auth_ns_req_policy_revision_safe",
      table.expectedPolicyRevision,
    ),
    ...prunableAppendOnlyPolicies("bg_crypto_auth_ns_req"),
  ],
).enableRLS();

/**
 * Successful processor signing authority is append-only verification history.
 * It deliberately has no FK to the request ledger, whose terminal attempts
 * may be compacted after the bounded retention window.
 */
export const processorCryptoSignerAuthorizations = pgTable(
  "processor_crypto_signer_authorizations",
  {
    authorizationId: text("authorization_id").primaryKey(),
    formatVersion: smallint("format_version").default(1).notNull(),
    requestId: text("request_id").notNull(),
    recipientGeneration: bigint("recipient_generation", {
      mode: "number",
    }).notNull(),
    processorKind: text("processor_kind").notNull(),
    processorVersion: smallint("processor_version").notNull(),
    workId: text("work_id").notNull(),
    namespaceId: text("namespace_id").notNull(),
    domainId: text("domain_id").notNull(),
    domainEpoch: bigint("domain_epoch", { mode: "number" }),
    namespaceAccessRevision: bigint("namespace_access_revision", {
      mode: "number",
    }).notNull(),
    policyRevision: bigint("policy_revision", {
      mode: "number",
    }).notNull(),
    processorAuthorizationRevision: bigint(
      "processor_authorization_revision",
      { mode: "number" },
    ),
    issuingHumanId: text("issuing_human_id").notNull(),
    issuingDeviceId: text("issuing_device_id").notNull(),
    /** M303 device securityRevision; never a processor permission revision. */
    issuingDeviceAuthorizationRevision: bigint(
      "issuing_device_authorization_revision",
      { mode: "number" },
    ).notNull(),
    issuerSigningPublicKeyHash: bytea(
      "issuer_signing_public_key_hash",
    ).notNull(),
    signerKeyId: text("signer_key_id").notNull(),
    signerPublicKey: bytea("signer_public_key").notNull(),
    workDescriptorHash: bytea("work_descriptor_hash").notNull(),
    workDescriptorBytes: bytea("work_descriptor_bytes").notNull(),
    authorizationHash: bytea("authorization_hash").notNull(),
    credentialHash: bytea("credential_hash").notNull(),
    authorizationBytes: bytea("authorization_bytes").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique(
      "uq_processor_crypto_signer_authorizations_request_generation",
    ).on(table.requestId, table.recipientGeneration),
    unique("uq_processor_crypto_signer_authorizations_signer_key").on(
      table.signerKeyId,
    ),
    unique(
      "uq_processor_crypto_signer_authorizations_authorization_hash",
    ).on(table.authorizationHash),
    unique(
      "uq_processor_crypto_signer_authorizations_credential_hash",
    ).on(table.credentialHash),
    portableId(
      "processor_crypto_signer_authorizations_id_portable",
      table.authorizationId,
    ),
    portableId(
      "processor_crypto_signer_authorizations_request_id_portable",
      table.requestId,
    ),
    check(
      "processor_crypto_signer_authorizations_legacy_carrier_bounds",
      sql`${table.processorKind} is not distinct from 'reflection' or (
        octet_length(${table.workDescriptorBytes}) <= ${sql.raw(String(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.legacyDescriptor))}
        and octet_length(${table.authorizationBytes}) <= ${sql.raw(String(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.legacySignerAuthorization))}
      )`,
    ),
    check(
      "processor_crypto_signer_authorizations_generation_safe",
      sql`${table.recipientGeneration} between 0 and 4294967295`,
    ),
    check(
      "processor_crypto_signer_authorizations_format_version",
      sql`${table.formatVersion} in (1, 2, 3)`,
    ),
    check(
      "processor_crypto_signer_authorizations_processor",
      sql`(${table.processorKind} = 'stenographer'
        or (${table.processorKind} = 'reflection' and ${table.formatVersion} = 2))
        and ${table.processorVersion} = 1`,
    ),
    portableId(
      "processor_crypto_signer_authorizations_work_id_portable",
      table.workId,
    ),
    portableId(
      "processor_crypto_signer_authorizations_namespace_id_portable",
      table.namespaceId,
    ),
    portableId(
      "processor_crypto_signer_authorizations_domain_id_portable",
      table.domainId,
    ),
    safeCounter(
      "processor_crypto_signer_authorizations_domain_epoch_safe",
      table.domainEpoch,
    ),
    safeCounter(
      "processor_crypto_signer_authorizations_namespace_revision_safe",
      table.namespaceAccessRevision,
    ),
    safeCounter(
      "processor_crypto_signer_authorizations_policy_revision_safe",
      table.policyRevision,
    ),
    safeCounter(
      "processor_crypto_signer_authorizations_processor_revision_safe",
      table.processorAuthorizationRevision,
    ),
    check(
      "processor_crypto_signer_authorizations_legacy_authority_coherent",
      sql`(
        ${table.formatVersion} = 1
        and ${table.domainEpoch} is not null
        and ${table.processorAuthorizationRevision} is not null
      ) or (
        ${table.formatVersion} in (2, 3)
        and ${table.domainEpoch} is null
        and ${table.processorAuthorizationRevision} is null
      )`,
    ),
    portableId(
      "processor_crypto_signer_authorizations_human_id_portable",
      table.issuingHumanId,
    ),
    portableId(
      "processor_crypto_signer_authorizations_device_id_portable",
      table.issuingDeviceId,
    ),
    safeCounter(
      "processor_crypto_signer_authorizations_device_revision_safe",
      table.issuingDeviceAuthorizationRevision,
    ),
    exactBytes(
      "processor_crypto_signer_authorizations_issuer_key_hash_size",
      table.issuerSigningPublicKeyHash,
      BACKGROUND_AUTHORIZATION_BYTE_LIMITS.hash,
    ),
    portableId(
      "processor_crypto_signer_authorizations_signer_key_id_portable",
      table.signerKeyId,
    ),
    exactBytes(
      "processor_crypto_signer_authorizations_public_key_size",
      table.signerPublicKey,
      BACKGROUND_AUTHORIZATION_BYTE_LIMITS.signingPublicKey,
    ),
    exactBytes(
      "processor_crypto_signer_authorizations_descriptor_hash_size",
      table.workDescriptorHash,
      BACKGROUND_AUTHORIZATION_BYTE_LIMITS.hash,
    ),
    boundedBytes(
      "processor_crypto_signer_authorizations_descriptor_size",
      table.workDescriptorBytes,
      BACKGROUND_AUTHORIZATION_BYTE_LIMITS.descriptor,
      1,
    ),
    exactBytes(
      "processor_crypto_signer_authorizations_authorization_hash_size",
      table.authorizationHash,
      BACKGROUND_AUTHORIZATION_BYTE_LIMITS.hash,
    ),
    exactBytes(
      "processor_crypto_signer_authorizations_credential_hash_size",
      table.credentialHash,
      BACKGROUND_AUTHORIZATION_BYTE_LIMITS.hash,
    ),
    boundedBytes(
      "processor_crypto_signer_authorizations_authorization_size",
      table.authorizationBytes,
      BACKGROUND_AUTHORIZATION_BYTE_LIMITS.signerAuthorization,
      1,
    ),
    check(
      "processor_crypto_signer_authorizations_time_order",
      sql`${table.issuedAt} <= ${table.createdAt}
        and ${table.createdAt} < ${table.expiresAt}
        and ${table.expiresAt}
          <= ${table.issuedAt} + interval '${
            sql.raw(
              String(
                BACKGROUND_AUTHORIZATION_COLLECTION_LIMITS.productTtlSeconds,
              ),
            )
          } seconds'`,
    ),
    index("idx_processor_crypto_signer_authorizations_work").on(
      table.processorKind,
      table.workId,
    ),
    index("idx_processor_crypto_signer_authorizations_expiry").on(
      table.expiresAt,
    ),
    ...appendOnlyPolicies("processor_crypto_signer_authorizations"),
  ],
).enableRLS();

export const humanCryptoCustodies = pgTable(
  "human_crypto_custodies",
  {
    humanId: text("human_id").primaryKey(),
    userId: uuid("user_id").notNull(),
    humanActorId: uuid("human_actor_id").notNull(),
    initialInstallationLineageDigest: bytea(
      "initial_installation_lineage_digest",
    ).notNull(),
    state: text("state").notNull(),
    everInitializedAt: timestamp("ever_initialized_at", {
      withTimezone: true,
    }),
    firstDeviceId: text("first_device_id"),
    currentRecoveryGeneration: bigint("current_recovery_generation", {
      mode: "number",
    }),
    currentRecoveryPublicKeyDigest: bytea(
      "current_recovery_public_key_digest",
    ),
    currentInventoryRevision: bigint("current_inventory_revision", {
      mode: "number",
    }),
    currentInventoryCount: integer("current_inventory_count"),
    currentInventoryDigest: bytea("current_inventory_digest"),
    revision: bigint("revision", { mode: "number" }).notNull(),
    lastTransitionAuditRef: text("last_transition_audit_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "human_crypto_custodies_user_fk",
    }),
    foreignKey({
      columns: [table.humanActorId],
      foreignColumns: [actors.id],
      name: "human_crypto_custodies_actor_fk",
    }),
    portableId("human_crypto_custodies_human_id_portable", table.humanId),
    exactBytes(
      "human_crypto_custodies_lineage_digest_size",
      table.initialInstallationLineageDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    check(
      "human_crypto_custodies_state",
      sql`${table.state} in ('initializing', 'active', 'recovery_required')`,
    ),
    check(
      "human_crypto_custodies_initialization_coherent",
      sql`(
        ${table.everInitializedAt} is null
        and ${table.state} = 'initializing'
        and ${table.firstDeviceId} is null
        and ${table.currentRecoveryGeneration} is null
        and ${table.currentRecoveryPublicKeyDigest} is null
      ) or (
        ${table.everInitializedAt} is not null
        and ${table.state} in ('active', 'recovery_required')
        and ${table.firstDeviceId} is not null
        and ${table.currentRecoveryGeneration} >= 1
        and octet_length(${table.currentRecoveryPublicKeyDigest})
          = ${sql.raw(String(CRYPTO_DELIVERY_BYTE_LIMITS.hash))}
      )`,
    ),
    portableId(
      "human_crypto_custodies_first_device_id_portable",
      table.firstDeviceId,
    ),
    safeCounter(
      "human_crypto_custodies_recovery_generation_safe",
      table.currentRecoveryGeneration,
    ),
    exactBytes(
      "human_crypto_custodies_recovery_digest_size",
      table.currentRecoveryPublicKeyDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    check(
      "human_crypto_custodies_inventory_coherent",
      sql`(
        ${table.currentInventoryRevision} is null
        and ${table.currentInventoryCount} is null
        and ${table.currentInventoryDigest} is null
      ) or (
        ${table.currentInventoryRevision} >= 0
        and ${table.currentInventoryCount} between 1 and ${
          sql.raw(String(CRYPTO_DELIVERY_COLLECTION_LIMITS.fanoutRowsPerOperation))
        }
        and octet_length(${table.currentInventoryDigest}) = ${
          sql.raw(String(CRYPTO_DELIVERY_BYTE_LIMITS.hash))
        }
      )`,
    ),
    safeCounter(
      "human_crypto_custodies_inventory_revision_safe",
      table.currentInventoryRevision,
    ),
    exactBytes(
      "human_crypto_custodies_inventory_digest_size",
      table.currentInventoryDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    safeCounter("human_crypto_custodies_revision_safe", table.revision),
    portableId(
      "human_crypto_custodies_audit_ref_portable",
      table.lastTransitionAuditRef,
    ),
    unique("uq_human_crypto_custodies_user").on(table.userId),
    unique("uq_human_crypto_custodies_actor").on(table.humanActorId),
    ...mutablePolicies("human_crypto_custodies"),
  ],
).enableRLS();

export const humanCryptoDevices = pgTable(
  "human_crypto_devices",
  {
    deviceId: text("device_id").primaryKey(),
    humanId: text("human_id").notNull(),
    userId: uuid("user_id").notNull(),
    humanActorId: uuid("human_actor_id").notNull(),
    clientKind: text("client_kind").notNull(),
    installationLineageDigest: bytea(
      "installation_lineage_digest",
    ).notNull(),
    deviceGeneration: bigint("device_generation", {
      mode: "number",
    }).notNull(),
    signingPublicKey: bytea("signing_public_key").notNull(),
    encryptionPublicKey: bytea("encryption_public_key").notNull(),
    publicFingerprint: bytea("public_fingerprint").notNull(),
    state: text("state").notNull(),
    authorizationKind: text("authorization_kind").notNull(),
    approvalGeneration: bigint("approval_generation", { mode: "number" }),
    recoveryGeneration: bigint("recovery_generation", { mode: "number" }),
    authorizationEvidenceDigest: bytea(
      "authorization_evidence_digest",
    ).notNull(),
    membershipState: text("membership_state")
      .notNull()
      .default("unbound"),
    membershipServerInstanceId: uuid("membership_server_instance_id"),
    membershipLineageGeneration: bigint(
      "membership_lineage_generation",
      { mode: "number" },
    ),
    membershipEpoch: bigint("membership_epoch", { mode: "number" }),
    membershipSecurityRevision: bigint(
      "membership_security_revision",
      { mode: "number" },
    ),
    membershipLeafIndex: integer("membership_leaf_index"),
    membershipHeadDigest: bytea("membership_head_digest"),
    membershipAcknowledgedSequence: bigint(
      "membership_acknowledged_sequence",
      { mode: "number" },
    ),
    keyPackageGeneration: bigint("key_package_generation", {
      mode: "number",
    }).notNull(),
    keyPackageCount: integer("key_package_count").notNull(),
    deliverySequenceHighWatermark: bigint(
      "delivery_sequence_high_watermark",
      { mode: "number" },
    ).notNull().default(0),
    deliveryAcknowledgedSequence: bigint(
      "delivery_acknowledged_sequence",
      { mode: "number" },
    ).notNull().default(0),
    deliveryBlockedSequence: bigint("delivery_blocked_sequence", {
      mode: "number",
    }),
    deliveryBlockedOperationId: text("delivery_blocked_operation_id"),
    deliveryBlockedAt: timestamp("delivery_blocked_at", {
      withTimezone: true,
    }),
    deliveryBlockedReason: text("delivery_blocked_reason"),
    revision: bigint("revision", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.humanId],
      foreignColumns: [humanCryptoCustodies.humanId],
      name: "human_crypto_devices_custody_fk",
    }),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "human_crypto_devices_user_fk",
    }),
    foreignKey({
      columns: [table.humanActorId],
      foreignColumns: [actors.id],
      name: "human_crypto_devices_actor_fk",
    }),
    portableId("human_crypto_devices_device_id_portable", table.deviceId),
    portableId("human_crypto_devices_human_id_portable", table.humanId),
    check(
      "human_crypto_devices_client_kind",
      sql`${table.clientKind} in ('browser', 'electron', 'tui')`,
    ),
    exactBytes(
      "human_crypto_devices_lineage_digest_size",
      table.installationLineageDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    safeCounter(
      "human_crypto_devices_generation_safe",
      table.deviceGeneration,
    ),
    exactBytes(
      "human_crypto_devices_signing_key_size",
      table.signingPublicKey,
      CRYPTO_DELIVERY_BYTE_LIMITS.signingPublicKey,
    ),
    exactBytes(
      "human_crypto_devices_encryption_key_size",
      table.encryptionPublicKey,
      CRYPTO_DELIVERY_BYTE_LIMITS.encryptionPublicKey,
    ),
    exactBytes(
      "human_crypto_devices_fingerprint_size",
      table.publicFingerprint,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    check(
      "human_crypto_devices_state",
      sql`${table.state} in ('pending', 'active', 'revoked', 'rejected')`,
    ),
    check(
      "human_crypto_devices_authorization_kind",
      sql`${table.authorizationKind} in (
        'first_bootstrap', 'device_approval', 'recovery'
      )`,
    ),
    check(
      "human_crypto_devices_authorization_coherent",
      sql`(
        ${table.authorizationKind} = 'first_bootstrap'
        and ${table.approvalGeneration} is null
        and ${table.recoveryGeneration} = 1
      ) or (
        ${table.authorizationKind} = 'device_approval'
        and ${table.approvalGeneration} >= 1
        and ${table.recoveryGeneration} is null
      ) or (
        ${table.authorizationKind} = 'recovery'
        and ${table.approvalGeneration} is null
        and ${table.recoveryGeneration} >= 1
      )`,
    ),
    safeCounter(
      "human_crypto_devices_approval_generation_safe",
      table.approvalGeneration,
    ),
    safeCounter(
      "human_crypto_devices_recovery_generation_safe",
      table.recoveryGeneration,
    ),
    exactBytes(
      "human_crypto_devices_evidence_digest_size",
      table.authorizationEvidenceDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    foreignKey({
      columns: [table.membershipServerInstanceId],
      foreignColumns: [nautiloInstanceIdentity.serverInstanceId],
      name: "human_crypto_devices_membership_server_fk",
    }),
    check(
      "human_crypto_devices_membership_state",
      sql`${table.membershipState} in (
        'unbound', 'pending', 'welcome_pending', 'catching_up',
        'current', 'stale'
      )`,
    ),
    safeCounter(
      "human_crypto_devices_membership_lineage_safe",
      table.membershipLineageGeneration,
    ),
    safeCounter(
      "human_crypto_devices_membership_epoch_safe",
      table.membershipEpoch,
    ),
    safeCounter(
      "human_crypto_devices_membership_security_revision_safe",
      table.membershipSecurityRevision,
    ),
    safeCounter(
      "human_crypto_devices_membership_leaf_safe",
      table.membershipLeafIndex,
    ),
    exactBytes(
      "human_crypto_devices_membership_head_digest_size",
      table.membershipHeadDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    safeCounter(
      "human_crypto_devices_membership_ack_sequence_safe",
      table.membershipAcknowledgedSequence,
    ),
    check(
      "human_crypto_devices_membership_coherent",
      sql`(
        ${table.membershipState} = 'unbound'
        and ${table.membershipServerInstanceId} is null
        and ${table.membershipLineageGeneration} is null
        and ${table.membershipEpoch} is null
        and ${table.membershipSecurityRevision} is null
        and ${table.membershipLeafIndex} is null
        and ${table.membershipHeadDigest} is null
        and ${table.membershipAcknowledgedSequence} is null
      ) or (
        ${table.membershipState} in ('pending', 'welcome_pending')
        and ${table.membershipServerInstanceId} is not null
        and ${table.membershipLineageGeneration} >= 1
        and ${table.membershipEpoch} >= 0
        and ${table.membershipSecurityRevision} >= 1
        and ${table.membershipLeafIndex} is null
        and octet_length(${table.membershipHeadDigest}) = ${
          sql.raw(String(CRYPTO_DELIVERY_BYTE_LIMITS.hash))
        }
        and ${table.membershipAcknowledgedSequence} >= 0
      ) or (
        ${table.membershipState} in ('catching_up', 'current', 'stale')
        and ${table.membershipServerInstanceId} is not null
        and ${table.membershipLineageGeneration} >= 1
        and ${table.membershipEpoch} >= 0
        and ${table.membershipSecurityRevision} >= 1
        and ${table.membershipLeafIndex} >= 0
        and octet_length(${table.membershipHeadDigest}) = ${
          sql.raw(String(CRYPTO_DELIVERY_BYTE_LIMITS.hash))
        }
        and ${table.membershipAcknowledgedSequence} >= 0
      )`,
    ),
    safeCounter(
      "human_crypto_devices_key_package_generation_safe",
      table.keyPackageGeneration,
    ),
    check(
      "human_crypto_devices_key_package_count",
      sql`${table.keyPackageCount} between 0 and ${
        sql.raw(
          String(CRYPTO_DELIVERY_COLLECTION_LIMITS.keyPackagesPerDevice),
        )
      }`,
    ),
    safeCounter(
      "human_crypto_devices_delivery_high_watermark_safe",
      table.deliverySequenceHighWatermark,
    ),
    safeCounter(
      "human_crypto_devices_delivery_acknowledged_safe",
      table.deliveryAcknowledgedSequence,
    ),
    check(
      "human_crypto_devices_delivery_cursor_coherent",
      sql`${table.deliveryAcknowledgedSequence}
        <= ${table.deliverySequenceHighWatermark}`,
    ),
    safeCounter(
      "human_crypto_devices_delivery_blocked_sequence_safe",
      table.deliveryBlockedSequence,
    ),
    portableId(
      "human_crypto_devices_delivery_blocked_operation_id_portable",
      table.deliveryBlockedOperationId,
    ),
    portableId(
      "human_crypto_devices_delivery_blocked_reason_portable",
      table.deliveryBlockedReason,
    ),
    check(
      "human_crypto_devices_delivery_blocked_coherent",
      sql`(
        ${table.deliveryBlockedSequence} is null
        and ${table.deliveryBlockedOperationId} is null
        and ${table.deliveryBlockedAt} is null
        and ${table.deliveryBlockedReason} is null
      ) or (
        ${table.deliveryBlockedSequence}
          = ${table.deliveryAcknowledgedSequence} + 1
        and ${table.deliveryBlockedSequence}
          <= ${table.deliverySequenceHighWatermark}
        and ${table.deliveryBlockedOperationId} is not null
        and ${table.deliveryBlockedAt} is not null
        and ${table.deliveryBlockedAt} >= ${table.createdAt}
        and ${table.deliveryBlockedReason} = 'delivery_expired'
      )`,
    ),
    safeCounter("human_crypto_devices_revision_safe", table.revision),
    check(
      "human_crypto_devices_lifecycle_coherent",
      sql`(
        ${table.state} = 'pending'
        and ${table.activatedAt} is null
        and ${table.revokedAt} is null
        and ${table.rejectedAt} is null
      ) or (
        ${table.state} = 'active'
        and ${table.activatedAt} is not null
        and ${table.revokedAt} is null
        and ${table.rejectedAt} is null
      ) or (
        ${table.state} = 'revoked'
        and ${table.activatedAt} is not null
        and ${table.revokedAt} is not null
        and ${table.rejectedAt} is null
      ) or (
        ${table.state} = 'rejected'
        and ${table.activatedAt} is null
        and ${table.revokedAt} is null
        and ${table.rejectedAt} is not null
      )`,
    ),
    check(
      "human_crypto_devices_time_order",
      sql`(${table.activatedAt} is null or ${table.activatedAt} >= ${table.createdAt})
        and (${table.lastSeenAt} is null or ${table.lastSeenAt} >= ${table.createdAt})
        and (${table.revokedAt} is null or ${table.revokedAt} >= ${table.activatedAt})
        and (${table.rejectedAt} is null or ${table.rejectedAt} >= ${table.createdAt})`,
    ),
    unique("uq_human_crypto_devices_fingerprint").on(table.publicFingerprint),
    unique("uq_human_crypto_devices_identity_generation").on(
      table.deviceId,
      table.deviceGeneration,
    ),
    uniqueIndex("uq_human_crypto_devices_live_identity")
      .on(
        table.humanId,
        table.installationLineageDigest,
        table.deviceGeneration,
      )
      .where(sql`${table.state} in ('pending', 'active')`),
    index("idx_human_crypto_devices_human_state").on(
      table.humanId,
      table.state,
    ),
    ...mutablePolicies("human_crypto_devices"),
  ],
).enableRLS();

export const humanCryptoDeviceGroupHeads = pgTable(
  "human_crypto_device_group_heads",
  {
    humanId: text("human_id").primaryKey(),
    serverInstanceId: uuid("server_instance_id").notNull(),
    lineageGeneration: bigint("lineage_generation", {
      mode: "number",
    }).notNull(),
    providerId: text("provider_id").notNull(),
    groupId: text("group_id").notNull(),
    epoch: bigint("epoch", { mode: "number" }).notNull(),
    stateHash: bytea("state_hash").notNull(),
    rosterDigest: bytea("roster_digest").notNull(),
    rosterBytes: bytea("roster_bytes").notNull(),
    previousHeadDigest: bytea("previous_head_digest"),
    headDigest: bytea("head_digest").notNull(),
    headBytes: bytea("head_bytes").notNull(),
    securityRevision: bigint("security_revision", {
      mode: "number",
    }).notNull(),
    commitSequence: bigint("commit_sequence", {
      mode: "number",
    }).notNull(),
    committingDeviceId: text("committing_device_id").notNull(),
    committingDeviceGeneration: bigint("committing_device_generation", {
      mode: "number",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.humanId],
      foreignColumns: [humanCryptoCustodies.humanId],
      name: "human_crypto_device_group_heads_custody_fk",
    }),
    foreignKey({
      columns: [table.serverInstanceId],
      foreignColumns: [nautiloInstanceIdentity.serverInstanceId],
      name: "human_crypto_device_group_heads_server_fk",
    }),
    foreignKey({
      columns: [
        table.committingDeviceId,
        table.committingDeviceGeneration,
      ],
      foreignColumns: [
        humanCryptoDevices.deviceId,
        humanCryptoDevices.deviceGeneration,
      ],
      name: "human_crypto_device_group_heads_committer_fk",
    }),
    portableId(
      "human_crypto_device_group_heads_human_id_portable",
      table.humanId,
    ),
    portableId(
      "human_crypto_device_group_heads_provider_id_portable",
      table.providerId,
    ),
    portableId(
      "human_crypto_device_group_heads_group_id_portable",
      table.groupId,
    ),
    safeCounter(
      "human_crypto_device_group_heads_lineage_safe",
      table.lineageGeneration,
    ),
    safeCounter("human_crypto_device_group_heads_epoch_safe", table.epoch),
    safeCounter(
      "human_crypto_device_group_heads_security_revision_safe",
      table.securityRevision,
    ),
    safeCounter(
      "human_crypto_device_group_heads_commit_sequence_safe",
      table.commitSequence,
    ),
    safeCounter(
      "human_crypto_device_group_heads_committer_generation_safe",
      table.committingDeviceGeneration,
    ),
    exactBytes(
      "human_crypto_device_group_heads_state_hash_size",
      table.stateHash,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    exactBytes(
      "human_crypto_device_group_heads_roster_digest_size",
      table.rosterDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    boundedBytes(
      "human_crypto_device_group_heads_roster_size",
      table.rosterBytes,
      CRYPTO_DELIVERY_BYTE_LIMITS.humanDeviceGroupRoster,
      1,
    ),
    exactBytes(
      "human_crypto_device_group_heads_previous_digest_size",
      table.previousHeadDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    exactBytes(
      "human_crypto_device_group_heads_head_digest_size",
      table.headDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    boundedBytes(
      "human_crypto_device_group_heads_head_size",
      table.headBytes,
      CRYPTO_DELIVERY_BYTE_LIMITS.humanDeviceGroupHead,
      1,
    ),
    check(
      "human_crypto_device_group_heads_genesis_coherent",
      sql`(
        ${table.epoch} = 0
        and ${table.commitSequence} = 0
        and ${table.securityRevision} = 1
        and ${table.previousHeadDigest} is null
      ) or (
        ${table.epoch} >= 1
        and ${table.commitSequence} >= 1
        and ${table.securityRevision} >= 2
        and octet_length(${table.previousHeadDigest}) = ${
          sql.raw(String(CRYPTO_DELIVERY_BYTE_LIMITS.hash))
        }
      )`,
    ),
    check(
      "human_crypto_device_group_heads_time_order",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    unique("uq_human_crypto_device_group_heads_group_lineage").on(
      table.serverInstanceId,
      table.humanId,
      table.lineageGeneration,
    ),
    unique("uq_human_crypto_device_group_heads_digest").on(
      table.humanId,
      table.headDigest,
    ),
    index("idx_human_crypto_device_group_heads_server").on(
      table.serverInstanceId,
      table.humanId,
    ),
    ...mutablePolicies("human_crypto_device_group_heads"),
  ],
).enableRLS();

export const humanCryptoDeviceGroupCommits = pgTable(
  "human_crypto_device_group_commits",
  {
    humanId: text("human_id").notNull(),
    serverInstanceId: uuid("server_instance_id").notNull(),
    lineageGeneration: bigint("lineage_generation", {
      mode: "number",
    }).notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    operationId: text("operation_id").notNull(),
    operation: text("operation").notNull(),
    expectedHeadDigest: bytea("expected_head_digest").notNull(),
    nextHeadDigest: bytea("next_head_digest").notNull(),
    nextEpoch: bigint("next_epoch", { mode: "number" }).notNull(),
    nextSecurityRevision: bigint("next_security_revision", {
      mode: "number",
    }).notNull(),
    committerDeviceId: text("committer_device_id").notNull(),
    committerDeviceGeneration: bigint("committer_device_generation", {
      mode: "number",
    }).notNull(),
    targetDeviceId: text("target_device_id"),
    targetDeviceGeneration: bigint("target_device_generation", {
      mode: "number",
    }),
    publicTransitionBytes: bytea("public_transition_bytes").notNull(),
    commitBytes: bytea("commit_bytes").notNull(),
    welcomeDigest: bytea("welcome_digest"),
    rosterDigest: bytea("roster_digest").notNull(),
    rosterBytes: bytea("roster_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.humanId, table.lineageGeneration, table.sequence],
    }),
    foreignKey({
      columns: [table.humanId],
      foreignColumns: [humanCryptoCustodies.humanId],
      name: "human_crypto_device_group_commits_custody_fk",
    }),
    foreignKey({
      columns: [table.serverInstanceId],
      foreignColumns: [nautiloInstanceIdentity.serverInstanceId],
      name: "human_crypto_device_group_commits_server_fk",
    }),
    foreignKey({
      columns: [
        table.committerDeviceId,
        table.committerDeviceGeneration,
      ],
      foreignColumns: [
        humanCryptoDevices.deviceId,
        humanCryptoDevices.deviceGeneration,
      ],
      name: "human_crypto_device_group_commits_committer_fk",
    }),
    foreignKey({
      columns: [table.targetDeviceId, table.targetDeviceGeneration],
      foreignColumns: [
        humanCryptoDevices.deviceId,
        humanCryptoDevices.deviceGeneration,
      ],
      name: "human_crypto_device_group_commits_target_fk",
    }),
    portableId(
      "human_crypto_device_group_commits_human_id_portable",
      table.humanId,
    ),
    portableId(
      "human_crypto_device_group_commits_operation_id_portable",
      table.operationId,
    ),
    portableId(
      "human_crypto_device_group_commits_committer_id_portable",
      table.committerDeviceId,
    ),
    portableId(
      "human_crypto_device_group_commits_target_id_portable",
      table.targetDeviceId,
    ),
    safeCounter(
      "human_crypto_device_group_commits_lineage_safe",
      table.lineageGeneration,
    ),
    safeCounter(
      "human_crypto_device_group_commits_sequence_safe",
      table.sequence,
    ),
    safeCounter(
      "human_crypto_device_group_commits_next_epoch_safe",
      table.nextEpoch,
    ),
    safeCounter(
      "human_crypto_device_group_commits_next_security_revision_safe",
      table.nextSecurityRevision,
    ),
    safeCounter(
      "human_crypto_device_group_commits_committer_generation_safe",
      table.committerDeviceGeneration,
    ),
    safeCounter(
      "human_crypto_device_group_commits_target_generation_safe",
      table.targetDeviceGeneration,
    ),
    check(
      "human_crypto_device_group_commits_operation",
      sql`${table.operation} in ('add', 'update', 'remove', 'rebootstrap')`,
    ),
    check(
      "human_crypto_device_group_commits_target_coherent",
      sql`(
        ${table.operation} in ('add', 'remove')
        and ${table.targetDeviceId} is not null
        and ${table.targetDeviceGeneration} >= 1
      ) or (
        ${table.operation} in ('update', 'rebootstrap')
        and ${table.targetDeviceId} is null
        and ${table.targetDeviceGeneration} is null
      )`,
    ),
    exactBytes(
      "human_crypto_device_group_commits_expected_digest_size",
      table.expectedHeadDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    exactBytes(
      "human_crypto_device_group_commits_next_digest_size",
      table.nextHeadDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    boundedBytes(
      "human_crypto_device_group_commits_transition_size",
      table.publicTransitionBytes,
      CRYPTO_DELIVERY_BYTE_LIMITS.humanDeviceGroupTransition,
      1,
    ),
    boundedBytes(
      "human_crypto_device_group_commits_commit_size",
      table.commitBytes,
      CRYPTO_DELIVERY_BYTE_LIMITS.humanDeviceGroupCommit,
      1,
    ),
    exactBytes(
      "human_crypto_device_group_commits_welcome_digest_size",
      table.welcomeDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    exactBytes(
      "human_crypto_device_group_commits_roster_digest_size",
      table.rosterDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    boundedBytes(
      "human_crypto_device_group_commits_roster_size",
      table.rosterBytes,
      CRYPTO_DELIVERY_BYTE_LIMITS.humanDeviceGroupRoster,
      1,
    ),
    check(
      "human_crypto_device_group_commits_add_welcome",
      sql`(${table.operation} = 'add' and octet_length(${table.welcomeDigest}) = ${
        sql.raw(String(CRYPTO_DELIVERY_BYTE_LIMITS.hash))
      }) or (${table.operation} <> 'add' and ${table.welcomeDigest} is null)`,
    ),
    unique("uq_human_crypto_device_group_commits_operation").on(
      table.operationId,
    ),
    unique("uq_human_crypto_device_group_commits_next_head").on(
      table.humanId,
      table.nextHeadDigest,
    ),
    index("idx_human_crypto_device_group_commits_catch_up").on(
      table.humanId,
      table.lineageGeneration,
      table.sequence,
    ),
    ...prunableAppendOnlyPolicies("human_crypto_device_group_commits"),
  ],
).enableRLS();

export const humanCryptoDeviceGroupJoinRequests = pgTable(
  "human_crypto_device_group_join_requests",
  {
    operationId: text("operation_id").primaryKey(),
    humanId: text("human_id").notNull(),
    lineageGeneration: bigint("lineage_generation", {
      mode: "number",
    }).notNull(),
    targetDeviceId: text("target_device_id").notNull(),
    targetDeviceGeneration: bigint("target_device_generation", {
      mode: "number",
    }).notNull(),
    expectedHeadDigest: bytea("expected_head_digest").notNull(),
    requestBytes: bytea("request_bytes").notNull(),
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.humanId],
      foreignColumns: [humanCryptoCustodies.humanId],
      name: "human_crypto_device_group_join_requests_custody_fk",
    }),
    foreignKey({
      columns: [table.targetDeviceId, table.targetDeviceGeneration],
      foreignColumns: [
        humanCryptoDevices.deviceId,
        humanCryptoDevices.deviceGeneration,
      ],
      name: "human_crypto_device_group_join_requests_target_fk",
    }),
    portableId(
      "human_crypto_device_group_join_requests_operation_id_portable",
      table.operationId,
    ),
    portableId(
      "human_crypto_device_group_join_requests_human_id_portable",
      table.humanId,
    ),
    portableId(
      "human_crypto_device_group_join_requests_target_id_portable",
      table.targetDeviceId,
    ),
    safeCounter(
      "human_crypto_device_group_join_requests_lineage_safe",
      table.lineageGeneration,
    ),
    safeCounter(
      "human_crypto_device_group_join_requests_target_generation_safe",
      table.targetDeviceGeneration,
    ),
    exactBytes(
      "human_crypto_device_group_join_requests_head_digest_size",
      table.expectedHeadDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    boundedBytes(
      "human_crypto_device_group_join_requests_request_size",
      table.requestBytes,
      CRYPTO_DELIVERY_BYTE_LIMITS.humanDeviceGroupCommit,
      1,
    ),
    check(
      "human_crypto_device_group_join_requests_state",
      sql`${table.state} in ('pending', 'consumed')`,
    ),
    check(
      "human_crypto_device_group_join_requests_lifecycle",
      sql`(${table.state} = 'pending' and ${table.consumedAt} is null)
        or (${table.state} = 'consumed'
          and ${table.consumedAt} >= ${table.createdAt})`,
    ),
    index("idx_human_crypto_device_group_join_requests_pending").on(
      table.humanId,
      table.state,
      table.createdAt,
    ),
    ...mutablePolicies("human_crypto_device_group_join_requests", {
      delete: true,
    }),
  ],
).enableRLS();

export const humanCryptoDeviceGroupWelcomes = pgTable(
  "human_crypto_device_group_welcomes",
  {
    operationId: text("operation_id").primaryKey(),
    humanId: text("human_id").notNull(),
    lineageGeneration: bigint("lineage_generation", {
      mode: "number",
    }).notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    targetDeviceId: text("target_device_id").notNull(),
    targetDeviceGeneration: bigint("target_device_generation", {
      mode: "number",
    }).notNull(),
    welcomeDigest: bytea("welcome_digest").notNull(),
    welcomeBytes: bytea("welcome_bytes").notNull(),
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.operationId],
      foreignColumns: [humanCryptoDeviceGroupCommits.operationId],
      name: "human_crypto_device_group_welcomes_operation_fk",
    }),
    foreignKey({
      columns: [table.humanId, table.lineageGeneration, table.sequence],
      foreignColumns: [
        humanCryptoDeviceGroupCommits.humanId,
        humanCryptoDeviceGroupCommits.lineageGeneration,
        humanCryptoDeviceGroupCommits.sequence,
      ],
      name: "human_crypto_device_group_welcomes_commit_fk",
    }),
    foreignKey({
      columns: [table.targetDeviceId, table.targetDeviceGeneration],
      foreignColumns: [
        humanCryptoDevices.deviceId,
        humanCryptoDevices.deviceGeneration,
      ],
      name: "human_crypto_device_group_welcomes_target_fk",
    }),
    portableId(
      "human_crypto_device_group_welcomes_operation_id_portable",
      table.operationId,
    ),
    portableId(
      "human_crypto_device_group_welcomes_human_id_portable",
      table.humanId,
    ),
    portableId(
      "human_crypto_device_group_welcomes_target_id_portable",
      table.targetDeviceId,
    ),
    safeCounter(
      "human_crypto_device_group_welcomes_lineage_safe",
      table.lineageGeneration,
    ),
    safeCounter(
      "human_crypto_device_group_welcomes_sequence_safe",
      table.sequence,
    ),
    safeCounter(
      "human_crypto_device_group_welcomes_target_generation_safe",
      table.targetDeviceGeneration,
    ),
    exactBytes(
      "human_crypto_device_group_welcomes_digest_size",
      table.welcomeDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    boundedBytes(
      "human_crypto_device_group_welcomes_bytes_size",
      table.welcomeBytes,
      CRYPTO_DELIVERY_BYTE_LIMITS.humanDeviceGroupWelcome,
      1,
    ),
    check(
      "human_crypto_device_group_welcomes_state",
      sql`${table.state} in ('pending', 'delivered', 'acknowledged')`,
    ),
    check(
      "human_crypto_device_group_welcomes_lifecycle_coherent",
      sql`(
        ${table.state} = 'pending'
        and ${table.deliveredAt} is null
        and ${table.acknowledgedAt} is null
      ) or (
        ${table.state} = 'delivered'
        and ${table.deliveredAt} >= ${table.createdAt}
        and ${table.acknowledgedAt} is null
      ) or (
        ${table.state} = 'acknowledged'
        and ${table.deliveredAt} >= ${table.createdAt}
        and ${table.acknowledgedAt} >= ${table.deliveredAt}
      )`,
    ),
    index("idx_human_crypto_device_group_welcomes_target").on(
      table.targetDeviceId,
      table.state,
    ),
    ...mutablePolicies("human_crypto_device_group_welcomes", {
      delete: true,
    }),
  ],
).enableRLS();

export const humanCryptoDeviceGroupAcknowledgements = pgTable(
  "human_crypto_device_group_acknowledgements",
  {
    humanId: text("human_id").notNull(),
    lineageGeneration: bigint("lineage_generation", {
      mode: "number",
    }).notNull(),
    deviceId: text("device_id").notNull(),
    deviceGeneration: bigint("device_generation", {
      mode: "number",
    }).notNull(),
    acknowledgedSequence: bigint("acknowledged_sequence", {
      mode: "number",
    }).notNull(),
    acknowledgedHeadDigest: bytea("acknowledged_head_digest").notNull(),
    acknowledgedAt: timestamp("acknowledged_at", {
      withTimezone: true,
    }).notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.humanId,
        table.lineageGeneration,
        table.deviceId,
        table.deviceGeneration,
      ],
    }),
    foreignKey({
      columns: [table.humanId],
      foreignColumns: [humanCryptoCustodies.humanId],
      name: "human_crypto_device_group_acknowledgements_custody_fk",
    }),
    foreignKey({
      columns: [table.deviceId, table.deviceGeneration],
      foreignColumns: [
        humanCryptoDevices.deviceId,
        humanCryptoDevices.deviceGeneration,
      ],
      name: "human_crypto_device_group_acknowledgements_device_fk",
    }),
    portableId(
      "human_crypto_device_group_acknowledgements_human_id_portable",
      table.humanId,
    ),
    portableId(
      "human_crypto_device_group_acknowledgements_device_id_portable",
      table.deviceId,
    ),
    safeCounter(
      "human_crypto_device_group_acknowledgements_lineage_safe",
      table.lineageGeneration,
    ),
    safeCounter(
      "human_crypto_device_group_acknowledgements_device_generation_safe",
      table.deviceGeneration,
    ),
    safeCounter(
      "human_crypto_device_group_acknowledgements_sequence_safe",
      table.acknowledgedSequence,
    ),
    safeCounter(
      "human_crypto_device_group_acknowledgements_revision_safe",
      table.revision,
    ),
    exactBytes(
      "human_crypto_device_group_acknowledgements_head_digest_size",
      table.acknowledgedHeadDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    index("idx_human_crypto_device_group_acknowledgements_retention").on(
      table.humanId,
      table.lineageGeneration,
      table.acknowledgedSequence,
    ),
    ...mutablePolicies("human_crypto_device_group_acknowledgements", {
      delete: true,
    }),
  ],
).enableRLS();

export const humanCryptoDeviceChallenges = pgTable(
  "human_crypto_device_challenges",
  {
    challengeId: text("challenge_id").primaryKey(),
    challengeHash: bytea("challenge_hash").notNull(),
    kind: text("kind").notNull(),
    bootstrapContext: text("bootstrap_context"),
    bootstrapAuthorityId: text("bootstrap_authority_id"),
    humanId: text("human_id").notNull(),
    userId: uuid("user_id").notNull(),
    humanActorId: uuid("human_actor_id").notNull(),
    installationLineageDigest: bytea(
      "installation_lineage_digest",
    ).notNull(),
    authorizationDigest: bytea("authorization_digest").notNull(),
    pendingDeviceId: text("pending_device_id").notNull(),
    signingPublicKeyDigest: bytea("signing_public_key_digest").notNull(),
    encryptionPublicKeyDigest: bytea(
      "encryption_public_key_digest",
    ).notNull(),
    recoveryPublicKeyDigest: bytea("recovery_public_key_digest"),
    expectedResponseDigest: bytea("expected_response_digest"),
    expectedCustodyRevision: bigint("expected_custody_revision", {
      mode: "number",
    }).notNull(),
    expectedRecoveryGeneration: bigint("expected_recovery_generation", {
      mode: "number",
    }),
    idempotencyKey: text("idempotency_key").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    terminalResultCode: text("terminal_result_code"),
    receiptAuditRef: text("receipt_audit_ref"),
    revision: bigint("revision", { mode: "number" }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.humanId],
      foreignColumns: [humanCryptoCustodies.humanId],
      name: "human_crypto_device_challenges_custody_fk",
    }),
    foreignKey({
      columns: [table.pendingDeviceId],
      foreignColumns: [humanCryptoDevices.deviceId],
      name: "human_crypto_device_challenges_device_fk",
    }),
    portableId(
      "human_crypto_device_challenges_id_portable",
      table.challengeId,
    ),
    exactBytes(
      "human_crypto_device_challenges_hash_size",
      table.challengeHash,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    check(
      "human_crypto_device_challenges_kind",
      sql`${table.kind} in (
        'initial_bootstrap', 'device_approval', 'device_recovery'
      )`,
    ),
    check(
      "human_crypto_device_challenges_context",
      sql`(
        ${table.kind} = 'initial_bootstrap'
        and ${table.bootstrapContext} in (
          'preparation', 'greenfield_initial_owner',
          'pending_encrypted_invite'
        )
      ) or (
        ${table.kind} <> 'initial_bootstrap'
        and ${table.bootstrapContext} is null
      )`,
    ),
    check(
      "human_crypto_device_challenges_bootstrap_authority",
      sql`(
        ${table.bootstrapContext} = 'pending_encrypted_invite'
        and ${table.bootstrapAuthorityId} is not null
      ) or (
        ${table.bootstrapContext} <> 'pending_encrypted_invite'
        or ${table.bootstrapContext} is null
      )`,
    ),
    portableId(
      "human_crypto_device_challenges_bootstrap_authority_portable",
      table.bootstrapAuthorityId,
    ),
    portableId(
      "human_crypto_device_challenges_human_id_portable",
      table.humanId,
    ),
    exactBytes(
      "human_crypto_device_challenges_lineage_size",
      table.installationLineageDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    exactBytes(
      "human_crypto_device_challenges_authorization_size",
      table.authorizationDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    portableId(
      "human_crypto_device_challenges_device_id_portable",
      table.pendingDeviceId,
    ),
    exactBytes(
      "human_crypto_device_challenges_signing_digest_size",
      table.signingPublicKeyDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    exactBytes(
      "human_crypto_device_challenges_encryption_digest_size",
      table.encryptionPublicKeyDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    exactBytes(
      "human_crypto_device_challenges_recovery_digest_size",
      table.recoveryPublicKeyDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    check(
      "human_crypto_device_challenges_recovery_coherent",
      sql`(
        ${table.kind} = 'initial_bootstrap'
        and ${table.recoveryPublicKeyDigest} is not null
        and ${table.expectedRecoveryGeneration} is null
      ) or (
        ${table.kind} in ('device_approval', 'device_recovery')
        and ${table.recoveryPublicKeyDigest} is null
        and ${table.expectedRecoveryGeneration} >= 1
      )`,
    ),
    check(
      "human_crypto_device_challenges_response_digest_coherent",
      sql`${table.expectedResponseDigest} is null
        or ${table.kind} = 'device_recovery'`,
    ),
    exactBytes(
      "human_crypto_device_challenges_response_digest_size",
      table.expectedResponseDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    safeCounter(
      "human_crypto_device_challenges_custody_revision_safe",
      table.expectedCustodyRevision,
    ),
    safeCounter(
      "human_crypto_device_challenges_recovery_generation_safe",
      table.expectedRecoveryGeneration,
    ),
    portableId(
      "human_crypto_device_challenges_idempotency_portable",
      table.idempotencyKey,
    ),
    check(
      "human_crypto_device_challenges_expiry",
      sql`${table.expiresAt} > ${table.issuedAt}
        and ${table.expiresAt}
          <= ${table.issuedAt}
            + interval '${
              sql.raw(
                String(CRYPTO_DELIVERY_COLLECTION_LIMITS.challengeTtlSeconds),
              )
            } seconds'`,
    ),
    check(
      "human_crypto_device_challenges_terminal_coherent",
      sql`not (
        ${table.consumedAt} is not null
        and ${table.invalidatedAt} is not null
      )
      and (
        ${table.consumedAt} is null
        or ${table.consumedAt} >= ${table.issuedAt}
      )
      and (
        ${table.invalidatedAt} is null
        or ${table.invalidatedAt} >= ${table.issuedAt}
      )`,
    ),
    check(
      "human_crypto_device_challenges_terminal_result_coherent",
      sql`(
        ${table.consumedAt} is null
        and ${table.invalidatedAt} is null
        and ${table.terminalResultCode} is null
        and ${table.receiptAuditRef} is null
      ) or (
        ${table.consumedAt} is not null
        and ${table.terminalResultCode} is not null
        and ${table.receiptAuditRef} is not null
      ) or (
        ${table.invalidatedAt} is not null
        and ${table.terminalResultCode} is not null
      )`,
    ),
    portableId(
      "human_crypto_device_challenges_result_code_portable",
      table.terminalResultCode,
    ),
    portableId(
      "human_crypto_device_challenges_receipt_ref_portable",
      table.receiptAuditRef,
    ),
    safeCounter(
      "human_crypto_device_challenges_revision_safe",
      table.revision,
    ),
    unique("uq_human_crypto_device_challenges_hash").on(table.challengeHash),
    unique("uq_human_crypto_device_challenges_idempotency").on(
      table.humanId,
      table.kind,
      table.idempotencyKey,
    ),
    uniqueIndex("uq_human_crypto_device_challenges_live_initial")
      .on(table.humanId)
      .where(sql`${table.kind} = 'initial_bootstrap'
        and ${table.consumedAt} is null
        and ${table.invalidatedAt} is null`),
    index("idx_human_crypto_device_challenges_expiry").on(table.expiresAt),
    ...mutablePolicies("human_crypto_device_challenges", { delete: true }),
  ],
).enableRLS();

/**
 * Short-lived, single-use proof requests for M303 product admission.
 * Enrollment/recovery challenges remain in human_crypto_device_challenges;
 * these rows prove possession of an already-current M304 device only.
 */
export const humanCryptoDeviceAdmissionChallenges = pgTable(
  "human_crypto_device_admission_challenges",
  {
    challengeId: text("challenge_id").primaryKey(),
    challengeHash: bytea("challenge_hash").notNull(),
    credentialDigest: bytea("credential_digest").notNull(),
    userId: uuid("user_id").notNull(),
    humanActorId: uuid("human_actor_id").notNull(),
    deviceId: text("device_id").notNull(),
    deviceGeneration: bigint("device_generation", { mode: "number" }).notNull(),
    serverInstanceId: uuid("server_instance_id").notNull(),
    lineageGeneration: bigint("lineage_generation", { mode: "number" }).notNull(),
    epoch: bigint("epoch", { mode: "number" }).notNull(),
    securityRevision: bigint("security_revision", { mode: "number" }).notNull(),
    headDigest: bytea("head_digest").notNull(),
    nonce: bytea("nonce").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "human_crypto_device_admission_challenges_user_fk",
    }),
    foreignKey({
      columns: [table.humanActorId],
      foreignColumns: [actors.id],
      name: "human_crypto_device_admission_challenges_actor_fk",
    }),
    foreignKey({
      columns: [table.deviceId, table.deviceGeneration],
      foreignColumns: [
        humanCryptoDevices.deviceId,
        humanCryptoDevices.deviceGeneration,
      ],
      name: "human_crypto_device_admission_challenges_device_fk",
    }),
    foreignKey({
      columns: [table.serverInstanceId],
      foreignColumns: [nautiloInstanceIdentity.serverInstanceId],
      name: "human_crypto_device_admission_challenges_server_fk",
    }),
    portableId(
      "human_crypto_device_admission_challenges_id_portable",
      table.challengeId,
    ),
    portableId(
      "human_crypto_device_admission_challenges_device_portable",
      table.deviceId,
    ),
    exactBytes(
      "human_crypto_device_admission_challenges_hash_size",
      table.challengeHash,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    exactBytes(
      "human_crypto_device_admission_challenges_credential_size",
      table.credentialDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    exactBytes(
      "human_crypto_device_admission_challenges_head_size",
      table.headDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    exactBytes(
      "human_crypto_device_admission_challenges_nonce_size",
      table.nonce,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    safeCounter(
      "human_crypto_device_admission_challenges_device_generation_safe",
      table.deviceGeneration,
    ),
    safeCounter(
      "human_crypto_device_admission_challenges_lineage_safe",
      table.lineageGeneration,
    ),
    safeCounter(
      "human_crypto_device_admission_challenges_epoch_safe",
      table.epoch,
    ),
    safeCounter(
      "human_crypto_device_admission_challenges_security_revision_safe",
      table.securityRevision,
    ),
    check(
      "human_crypto_device_admission_challenges_positive_coordinates",
      sql`${table.deviceGeneration} >= 1
        and ${table.lineageGeneration} >= 1
        and ${table.securityRevision} >= 1`,
    ),
    check(
      "human_crypto_device_admission_challenges_expiry",
      sql`${table.expiresAt} > ${table.issuedAt}
        and ${table.expiresAt}
          <= ${table.issuedAt}
            + interval '${
              sql.raw(
                String(CRYPTO_DELIVERY_COLLECTION_LIMITS.challengeTtlSeconds),
              )
            } seconds'`,
    ),
    check(
      "human_crypto_device_admission_challenges_terminal_coherent",
      sql`not (
        ${table.consumedAt} is not null
        and ${table.invalidatedAt} is not null
      )`,
    ),
    unique("uq_human_crypto_device_admission_challenges_hash")
      .on(table.challengeHash),
    uniqueIndex("uq_human_crypto_device_admission_challenges_live_credential")
      .on(table.credentialDigest)
      .where(sql`${table.consumedAt} is null
        and ${table.invalidatedAt} is null`),
    index("idx_human_crypto_device_admission_challenges_expiry")
      .on(table.expiresAt),
    ...mutablePolicies("human_crypto_device_admission_challenges", {
      delete: true,
    }),
  ],
).enableRLS();

/**
 * Bounded server-side projection that one exact bearer credential proved one
 * exact current M304 device. Current roster/head facts remain authoritative
 * and are rechecked before this projection admits a request.
 */
export const humanCryptoDeviceAdmissions = pgTable(
  "human_crypto_device_admissions",
  {
    credentialDigest: bytea("credential_digest").primaryKey(),
    userId: uuid("user_id").notNull(),
    humanActorId: uuid("human_actor_id").notNull(),
    deviceId: text("device_id").notNull(),
    deviceGeneration: bigint("device_generation", { mode: "number" }).notNull(),
    serverInstanceId: uuid("server_instance_id").notNull(),
    lineageGeneration: bigint("lineage_generation", { mode: "number" }).notNull(),
    epoch: bigint("epoch", { mode: "number" }).notNull(),
    securityRevision: bigint("security_revision", { mode: "number" }).notNull(),
    headDigest: bytea("head_digest").notNull(),
    admittedAt: timestamp("admitted_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "human_crypto_device_admissions_user_fk",
    }),
    foreignKey({
      columns: [table.humanActorId],
      foreignColumns: [actors.id],
      name: "human_crypto_device_admissions_actor_fk",
    }),
    foreignKey({
      columns: [table.deviceId, table.deviceGeneration],
      foreignColumns: [
        humanCryptoDevices.deviceId,
        humanCryptoDevices.deviceGeneration,
      ],
      name: "human_crypto_device_admissions_device_fk",
    }),
    foreignKey({
      columns: [table.serverInstanceId],
      foreignColumns: [nautiloInstanceIdentity.serverInstanceId],
      name: "human_crypto_device_admissions_server_fk",
    }),
    portableId("human_crypto_device_admissions_device_portable", table.deviceId),
    exactBytes(
      "human_crypto_device_admissions_credential_size",
      table.credentialDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    exactBytes(
      "human_crypto_device_admissions_head_size",
      table.headDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    safeCounter(
      "human_crypto_device_admissions_device_generation_safe",
      table.deviceGeneration,
    ),
    safeCounter(
      "human_crypto_device_admissions_lineage_safe",
      table.lineageGeneration,
    ),
    safeCounter("human_crypto_device_admissions_epoch_safe", table.epoch),
    safeCounter(
      "human_crypto_device_admissions_security_revision_safe",
      table.securityRevision,
    ),
    check(
      "human_crypto_device_admissions_positive_coordinates",
      sql`${table.deviceGeneration} >= 1
        and ${table.lineageGeneration} >= 1
        and ${table.securityRevision} >= 1`,
    ),
    check(
      "human_crypto_device_admissions_expiry",
      sql`${table.expiresAt} > ${table.admittedAt}`,
    ),
    index("idx_human_crypto_device_admissions_expiry").on(table.expiresAt),
    index("idx_human_crypto_device_admissions_device").on(
      table.humanActorId,
      table.deviceId,
      table.deviceGeneration,
    ),
    ...mutablePolicies("human_crypto_device_admissions", { delete: true }),
  ],
).enableRLS();

export const humanCryptoRecoveryKeys = pgTable(
  "human_crypto_recovery_keys",
  {
    humanId: text("human_id").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    recoveryKeyId: text("recovery_key_id").notNull(),
    formatVersion: smallint("format_version").notNull(),
    publicKey: bytea("public_key").notNull(),
    publicKeyDigest: bytea("public_key_digest").notNull(),
    archiveHash: bytea("archive_hash").notNull(),
    issuerDeviceId: text("issuer_device_id").notNull(),
    state: text("state").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    revision: bigint("revision", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.humanId, table.generation] }),
    foreignKey({
      columns: [table.humanId],
      foreignColumns: [humanCryptoCustodies.humanId],
      name: "human_crypto_recovery_keys_custody_fk",
    }),
    foreignKey({
      columns: [table.issuerDeviceId],
      foreignColumns: [humanCryptoDevices.deviceId],
      name: "human_crypto_recovery_keys_issuer_fk",
    }),
    portableId(
      "human_crypto_recovery_keys_human_id_portable",
      table.humanId,
    ),
    safeCounter(
      "human_crypto_recovery_keys_generation_safe",
      table.generation,
    ),
    portableId(
      "human_crypto_recovery_keys_key_id_portable",
      table.recoveryKeyId,
    ),
    check(
      "human_crypto_recovery_keys_format_version",
      sql`${table.formatVersion} = 1`,
    ),
    exactBytes(
      "human_crypto_recovery_keys_public_key_size",
      table.publicKey,
      CRYPTO_DELIVERY_BYTE_LIMITS.encryptionPublicKey,
    ),
    exactBytes(
      "human_crypto_recovery_keys_public_digest_size",
      table.publicKeyDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    exactBytes(
      "human_crypto_recovery_keys_archive_hash_size",
      table.archiveHash,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    portableId(
      "human_crypto_recovery_keys_issuer_id_portable",
      table.issuerDeviceId,
    ),
    check(
      "human_crypto_recovery_keys_state",
      sql`${table.state} in ('current', 'retired')`,
    ),
    check(
      "human_crypto_recovery_keys_retirement_coherent",
      sql`(
        ${table.state} = 'current' and ${table.retiredAt} is null
      ) or (
        ${table.state} = 'retired' and ${table.retiredAt} is not null
      )`,
    ),
    safeCounter(
      "human_crypto_recovery_keys_revision_safe",
      table.revision,
    ),
    unique("uq_human_crypto_recovery_keys_key_id").on(table.recoveryKeyId),
    unique("uq_human_crypto_recovery_keys_digest").on(
      table.humanId,
      table.publicKeyDigest,
    ),
    uniqueIndex("uq_human_crypto_recovery_keys_current")
      .on(table.humanId)
      .where(sql`${table.state} = 'current'`),
    ...mutablePolicies("human_crypto_recovery_keys"),
  ],
).enableRLS();

export const humanCryptoDeviceKeyPackages = pgTable(
  "human_crypto_device_key_packages",
  {
    deviceId: text("device_id").notNull(),
    domainId: text("domain_id").notNull(),
    expectedProviderHeadHash: bytea(
      "expected_provider_head_hash",
    ).notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    packageId: text("package_id").notNull(),
    packageHash: bytea("package_hash").notNull(),
    formatVersion: smallint("format_version").notNull(),
    packageBytes: bytea("package_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumingOperationId: text("consuming_operation_id"),
  },
  (table) => [
    primaryKey({
      columns: [table.deviceId, table.generation, table.packageId],
    }),
    foreignKey({
      columns: [table.deviceId],
      foreignColumns: [humanCryptoDevices.deviceId],
      name: "human_crypto_device_key_packages_device_fk",
    }),
    foreignKey({
      columns: [table.domainId],
      foreignColumns: [cryptoDomains.id],
      name: "human_crypto_device_key_packages_domain_fk",
    }),
    portableId(
      "human_crypto_device_key_packages_device_id_portable",
      table.deviceId,
    ),
    portableId(
      "human_crypto_device_key_packages_domain_id_portable",
      table.domainId,
    ),
    exactBytes(
      "human_crypto_device_key_packages_provider_head_hash_size",
      table.expectedProviderHeadHash,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    safeCounter(
      "human_crypto_device_key_packages_generation_safe",
      table.generation,
    ),
    portableId(
      "human_crypto_device_key_packages_package_id_portable",
      table.packageId,
    ),
    exactBytes(
      "human_crypto_device_key_packages_hash_size",
      table.packageHash,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    check(
      "human_crypto_device_key_packages_format_version",
      sql`${table.formatVersion} = 1`,
    ),
    boundedBytes(
      "human_crypto_device_key_packages_bytes_size",
      table.packageBytes,
      CRYPTO_DELIVERY_BYTE_LIMITS.opaquePayload,
      1,
    ),
    check(
      "human_crypto_device_key_packages_expiry",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "human_crypto_device_key_packages_consumption_coherent",
      sql`(
        ${table.consumedAt} is null
        and ${table.consumingOperationId} is null
      ) or (
        ${table.consumedAt} is not null
        and ${table.consumingOperationId} is not null
      )`,
    ),
    portableId(
      "human_crypto_device_key_packages_operation_id_portable",
      table.consumingOperationId,
    ),
    unique("uq_human_crypto_device_key_packages_hash").on(table.packageHash),
    index("idx_human_crypto_device_key_packages_claimable").on(
      table.deviceId,
      table.domainId,
      table.generation,
      table.expiresAt,
    ),
    ...mutablePolicies("human_crypto_device_key_packages", { delete: true }),
  ],
).enableRLS();

export const cryptoDomainDevices = pgTable(
  "crypto_domain_devices",
  {
    domainId: text("domain_id").notNull(),
    deviceId: text("device_id").notNull(),
    humanId: text("human_id").notNull(),
    leafIndex: smallint("leaf_index").notNull(),
    joinedEpoch: bigint("joined_epoch", { mode: "number" }).notNull(),
    removedEpoch: bigint("removed_epoch", { mode: "number" }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.domainId, table.deviceId] }),
    foreignKey({
      columns: [table.domainId],
      foreignColumns: [cryptoDomains.id],
      name: "crypto_domain_devices_domain_fk",
    }),
    foreignKey({
      columns: [table.deviceId],
      foreignColumns: [humanCryptoDevices.deviceId],
      name: "crypto_domain_devices_device_fk",
    }),
    foreignKey({
      columns: [table.humanId],
      foreignColumns: [humanCryptoCustodies.humanId],
      name: "crypto_domain_devices_custody_fk",
    }),
    portableId("crypto_domain_devices_domain_id_portable", table.domainId),
    portableId("crypto_domain_devices_device_id_portable", table.deviceId),
    portableId("crypto_domain_devices_human_id_portable", table.humanId),
    check(
      "crypto_domain_devices_leaf_index",
      sql`${table.leafIndex} between 0 and ${
        sql.raw(
          String(
            CRYPTO_DELIVERY_COLLECTION_LIMITS.currentDeviceLeavesPerDomain - 1,
          ),
        )
      }`,
    ),
    safeCounter("crypto_domain_devices_joined_epoch_safe", table.joinedEpoch),
    safeCounter(
      "crypto_domain_devices_removed_epoch_safe",
      table.removedEpoch,
    ),
    check(
      "crypto_domain_devices_removal_coherent",
      sql`(
        ${table.removedEpoch} is null and ${table.removedAt} is null
      ) or (
        ${table.removedEpoch} is not null
        and ${table.removedEpoch} > ${table.joinedEpoch}
        and ${table.removedAt} is not null
      )`,
    ),
    uniqueIndex("uq_crypto_domain_devices_active_leaf")
      .on(table.domainId, table.leafIndex)
      .where(sql`${table.removedAt} is null`),
    index("idx_crypto_domain_devices_current_human").on(
      table.humanId,
      table.domainId,
    ),
    ...mutablePolicies("crypto_domain_devices"),
  ],
).enableRLS();

export const cryptoDeliveryOperations = pgTable(
  "crypto_delivery_operations",
  {
    operationId: text("operation_id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    kind: text("kind").notNull(),
    state: text("state").notNull(),
    humanId: text("human_id"),
    targetHumanId: text("target_human_id"),
    targetDeviceId: text("target_device_id"),
    expectedCustodyRevision: bigint("expected_custody_revision", {
      mode: "number",
    }),
    expectedRecoveryGeneration: bigint("expected_recovery_generation", {
      mode: "number",
    }),
    expectedDeviceRevision: bigint("expected_device_revision", {
      mode: "number",
    }),
    expectedParticipantDigest: bytea("expected_participant_digest"),
    aggregatePayloadBytes: bigint("aggregate_payload_bytes", {
      mode: "number",
    }).notNull(),
    fanoutRowCount: integer("fanout_row_count").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    retryCount: smallint("retry_count").notNull(),
    maximumAttempts: smallint("maximum_attempts").notNull(),
    failureCode: text("failure_code"),
    auditRef: text("audit_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.humanId],
      foreignColumns: [humanCryptoCustodies.humanId],
      name: "crypto_delivery_operations_human_fk",
    }),
    foreignKey({
      columns: [table.targetHumanId],
      foreignColumns: [humanCryptoCustodies.humanId],
      name: "crypto_delivery_operations_target_human_fk",
    }),
    foreignKey({
      columns: [table.targetDeviceId],
      foreignColumns: [humanCryptoDevices.deviceId],
      name: "crypto_delivery_operations_target_device_fk",
    }),
    portableId(
      "crypto_delivery_operations_id_portable",
      table.operationId,
    ),
    portableId(
      "crypto_delivery_operations_idempotency_portable",
      table.idempotencyKey,
    ),
    check(
      "crypto_delivery_operations_kind",
      sql`${table.kind} in (
        'first_device_bootstrap', 'device_add', 'device_recovery',
        'device_revoke', 'recovery_rotate', 'human_add', 'human_remove',
        'domain_rebootstrap', 'namespace_bootstrap'
      )`,
    ),
    check(
      "crypto_delivery_operations_state",
      sql`${table.state} in (
        'requested', 'awaiting_target_device', 'awaiting_committer',
        'preparing_domain', 'awaiting_delivery', 'ready_to_activate',
        'activating', 'active', 'failed', 'cancelled'
      )`,
    ),
    portableId(
      "crypto_delivery_operations_human_id_portable",
      table.humanId,
    ),
    portableId(
      "crypto_delivery_operations_target_human_id_portable",
      table.targetHumanId,
    ),
    portableId(
      "crypto_delivery_operations_target_device_id_portable",
      table.targetDeviceId,
    ),
    safeCounter(
      "crypto_delivery_operations_custody_revision_safe",
      table.expectedCustodyRevision,
    ),
    safeCounter(
      "crypto_delivery_operations_recovery_generation_safe",
      table.expectedRecoveryGeneration,
    ),
    safeCounter(
      "crypto_delivery_operations_device_revision_safe",
      table.expectedDeviceRevision,
    ),
    exactBytes(
      "crypto_delivery_operations_participant_digest_size",
      table.expectedParticipantDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    check(
      "crypto_delivery_operations_aggregate_payload_bound",
      sql`${table.aggregatePayloadBytes} between 0 and ${
        sql.raw(String(CRYPTO_DELIVERY_BYTE_LIMITS.aggregateOpaquePayload))
      }`,
    ),
    check(
      "crypto_delivery_operations_fanout_bound",
      sql`${table.fanoutRowCount} between 0 and ${
        sql.raw(
          String(CRYPTO_DELIVERY_COLLECTION_LIMITS.fanoutRowsPerOperation),
        )
      }`,
    ),
    check(
      "crypto_delivery_operations_lease_coherent",
      sql`(
        ${table.leaseOwner} is null and ${table.leaseExpiresAt} is null
      ) or (
        ${table.leaseOwner} is not null
        and ${table.leaseExpiresAt} is not null
      )`,
    ),
    portableId(
      "crypto_delivery_operations_lease_owner_portable",
      table.leaseOwner,
    ),
    check(
      "crypto_delivery_operations_retry_bound",
      sql`${table.retryCount} between 0 and ${table.maximumAttempts}
        and ${table.maximumAttempts} = ${
          sql.raw(String(CRYPTO_DELIVERY_COLLECTION_LIMITS.maximumAttempts))
        }`,
    ),
    check(
      "crypto_delivery_operations_terminal_coherent",
      sql`(
        ${table.state} in ('active', 'failed', 'cancelled')
        and ${table.terminalAt} is not null
      ) or (
        ${table.state} not in ('active', 'failed', 'cancelled')
        and ${table.terminalAt} is null
      )`,
    ),
    portableId(
      "crypto_delivery_operations_failure_code_portable",
      table.failureCode,
    ),
    portableId(
      "crypto_delivery_operations_audit_ref_portable",
      table.auditRef,
    ),
    check(
      "crypto_delivery_operations_time_order",
      sql`${table.updatedAt} >= ${table.createdAt}
        and ${table.deadlineAt} > ${table.createdAt}`,
    ),
    unique("uq_crypto_delivery_operations_idempotency").on(
      table.idempotencyKey,
    ),
    uniqueIndex("uq_crypto_delivery_operations_live_device_roster")
      .on(table.humanId)
      .where(sql`${table.humanId} is not null
        and ${table.kind} in (
          'device_add', 'device_recovery', 'device_revoke',
          'recovery_rotate'
        )
        and ${table.state} not in ('active', 'failed', 'cancelled')`),
    index("idx_crypto_delivery_operations_human_state").on(
      table.humanId,
      table.state,
    ),
    index("idx_crypto_delivery_operations_lease").on(
      table.state,
      table.leaseExpiresAt,
    ),
    ...mutablePolicies("crypto_delivery_operations", { delete: true }),
  ],
).enableRLS();

export const cryptoHumanMembershipTransitions = pgTable(
  "crypto_human_membership_transitions",
  {
    operationId: text("operation_id").primaryKey(),
    namespaceId: text("namespace_id").notNull(),
    roomId: text("room_id").notNull(),
    targetHumanActorId: uuid("target_human_actor_id").notNull(),
    admittedBootstrapDeviceId: text("admitted_bootstrap_device_id"),
    bootstrapDeviceId: text("bootstrap_device_id"),
    oldParticipants: text("old_participants").array().notNull(),
    oldParticipantDigest: bytea("old_participant_digest").notNull(),
    newParticipants: text("new_participants").array().notNull(),
    newParticipantDigest: bytea("new_participant_digest").notNull(),
    oldDomainId: text("old_domain_id").notNull(),
    admittedTargetDomainId: text("admitted_target_domain_id"),
    targetDomainId: text("target_domain_id"),
    targetRoomRole: text("target_room_role"),
    expectedAccessRevision: bigint("expected_access_revision", {
      mode: "number",
    }).notNull(),
    expectedBindingHash: bytea("expected_binding_hash").notNull(),
    committerDeviceId: text("committer_device_id"),
    targetDomainEpoch: bigint("target_domain_epoch", {
      mode: "number",
    }),
    candidateBindingHash: bytea("candidate_binding_hash"),
    candidateDigest: bytea("candidate_digest"),
    candidateSignedBindingBytes: bytea("candidate_signed_binding_bytes"),
    candidateHumanKeyringEnvelopeBytes: bytea(
      "candidate_human_keyring_envelope_bytes",
    ),
    candidateAiKeyringEnvelopeBytes: bytea(
      "candidate_ai_keyring_envelope_bytes",
    ),
    candidateSubmittedAt: timestamp("candidate_submitted_at", {
      withTimezone: true,
    }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.operationId],
      foreignColumns: [cryptoDeliveryOperations.operationId],
      name: "crypto_human_membership_transitions_operation_fk",
    }),
    foreignKey({
      columns: [table.targetHumanActorId],
      foreignColumns: [actors.id],
      name: "crypto_human_membership_transitions_target_actor_fk",
    }),
    foreignKey({
      columns: [table.admittedBootstrapDeviceId],
      foreignColumns: [humanCryptoDevices.deviceId],
      name: "crypto_human_membership_transitions_admitted_bootstrap_device_fk",
    }),
    foreignKey({
      columns: [table.bootstrapDeviceId],
      foreignColumns: [humanCryptoDevices.deviceId],
      name: "crypto_human_membership_transitions_bootstrap_device_fk",
    }),
    foreignKey({
      columns: [table.oldDomainId],
      foreignColumns: [cryptoDomains.id],
      name: "crypto_human_membership_transitions_old_domain_fk",
    }),
    foreignKey({
      columns: [table.admittedTargetDomainId],
      foreignColumns: [cryptoDomains.id],
      name: "crypto_human_membership_transitions_admitted_target_domain_fk",
    }),
    foreignKey({
      columns: [table.targetDomainId],
      foreignColumns: [cryptoDomains.id],
      name: "crypto_human_membership_transitions_target_domain_fk",
    }),
    foreignKey({
      columns: [table.committerDeviceId],
      foreignColumns: [humanCryptoDevices.deviceId],
      name: "crypto_human_membership_transitions_committer_device_fk",
    }),
    portableId(
      "crypto_human_membership_transitions_operation_id_portable",
      table.operationId,
    ),
    portableId(
      "crypto_human_membership_transitions_namespace_id_portable",
      table.namespaceId,
    ),
    portableId(
      "crypto_human_membership_transitions_room_id_portable",
      table.roomId,
    ),
    portableId(
      "crypto_human_membership_transitions_admitted_bootstrap_device_id_portable",
      table.admittedBootstrapDeviceId,
    ),
    portableId(
      "crypto_human_membership_transitions_bootstrap_device_id_portable",
      table.bootstrapDeviceId,
    ),
    check(
      "crypto_human_membership_transitions_old_count",
      sql`cardinality(${table.oldParticipants}) >= 1`,
    ),
    check(
      "crypto_human_membership_transitions_old_canonical",
      sql`crypto_participants_are_canonical(${table.oldParticipants})`,
    ),
    exactBytes(
      "crypto_human_membership_transitions_old_digest_size",
      table.oldParticipantDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    check(
      "crypto_human_membership_transitions_new_count",
      sql`cardinality(${table.newParticipants}) >= 1`,
    ),
    check(
      "crypto_human_membership_transitions_new_canonical",
      sql`crypto_participants_are_canonical(${table.newParticipants})`,
    ),
    exactBytes(
      "crypto_human_membership_transitions_new_digest_size",
      table.newParticipantDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    portableId(
      "crypto_human_membership_transitions_old_domain_id_portable",
      table.oldDomainId,
    ),
    portableId(
      "crypto_human_membership_transitions_admitted_target_domain_id_portable",
      table.admittedTargetDomainId,
    ),
    portableId(
      "crypto_human_membership_transitions_target_domain_id_portable",
      table.targetDomainId,
    ),
    check(
      "crypto_human_membership_transitions_target_room_role",
      sql`${table.targetRoomRole} is null
        or ${table.targetRoomRole} in ('admin', 'member')`,
    ),
    check(
      "crypto_human_membership_transitions_resolution_coherent",
      sql`(
        ${table.admittedBootstrapDeviceId} is null
        or ${table.bootstrapDeviceId} = ${table.admittedBootstrapDeviceId}
      ) and (
        ${table.admittedTargetDomainId} is null
        or ${table.targetDomainId} = ${table.admittedTargetDomainId}
      )`,
    ),
    safeCounter(
      "crypto_human_membership_transitions_access_revision_safe",
      table.expectedAccessRevision,
    ),
    exactBytes(
      "crypto_human_membership_transitions_binding_hash_size",
      table.expectedBindingHash,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    portableId(
      "crypto_human_membership_transitions_committer_device_id_portable",
      table.committerDeviceId,
    ),
    safeCounter(
      "crypto_human_membership_transitions_target_epoch_safe",
      table.targetDomainEpoch,
    ),
    exactBytes(
      "crypto_human_membership_transitions_candidate_binding_hash_size",
      table.candidateBindingHash,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    exactBytes(
      "crypto_human_membership_transitions_candidate_digest_size",
      table.candidateDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    boundedBytes(
      "crypto_human_membership_transitions_candidate_signed_size",
      table.candidateSignedBindingBytes,
      CRYPTO_STORAGE_BYTE_LIMITS.namespaceBinding,
      1,
    ),
    boundedBytes(
      "crypto_human_membership_transitions_candidate_human_keyring_size",
      table.candidateHumanKeyringEnvelopeBytes,
      CRYPTO_STORAGE_BYTE_LIMITS.namespaceKeyring,
      1,
    ),
    boundedBytes(
      "crypto_human_membership_transitions_candidate_ai_keyring_size",
      table.candidateAiKeyringEnvelopeBytes,
      CRYPTO_STORAGE_BYTE_LIMITS.namespaceKeyring,
      1,
    ),
    check(
      "crypto_human_membership_transitions_candidate_coherent",
      sql`(
        ${table.committerDeviceId} is null
        and ${table.targetDomainEpoch} is null
        and ${table.candidateBindingHash} is null
        and ${table.candidateDigest} is null
        and ${table.candidateSignedBindingBytes} is null
        and ${table.candidateHumanKeyringEnvelopeBytes} is null
        and ${table.candidateAiKeyringEnvelopeBytes} is null
        and ${table.candidateSubmittedAt} is null
      ) or (
        ${table.committerDeviceId} is not null
        and ${table.targetDomainId} is not null
        and ${table.targetDomainEpoch} is not null
        and ${table.candidateBindingHash} is not null
        and ${table.candidateDigest} is not null
        and ${table.candidateSignedBindingBytes} is not null
        and ${table.candidateHumanKeyringEnvelopeBytes} is not null
        and ${table.candidateAiKeyringEnvelopeBytes} is not null
        and ${table.candidateSubmittedAt} is not null
      )`,
    ),
    check(
      "crypto_human_membership_transitions_terminal_coherent",
      sql`(
        ${table.activatedAt} is null
      ) or (
        ${table.releasedAt} = ${table.activatedAt}
      )`,
    ),
    uniqueIndex("uq_crypto_human_membership_transitions_live_namespace")
      .on(table.namespaceId)
      .where(sql`${table.releasedAt} is null`),
    ...mutablePolicies("crypto_human_membership_transitions", {
      delete: true,
    }),
  ],
).enableRLS();

export const cryptoDeviceEpochOperations = pgTable(
  "crypto_device_epoch_operations",
  {
    operationId: text("operation_id").primaryKey(),
    targetDeviceId: text("target_device_id").notNull(),
    ownerHumanId: text("owner_human_id").notNull(),
    sourceDeviceId: text("source_device_id"),
    expectedDeviceRevision: bigint("expected_device_revision", {
      mode: "number",
    }).notNull(),
    expectedInventoryRevision: bigint("expected_inventory_revision", {
      mode: "number",
    }).notNull(),
    expectedInventoryCount: integer("expected_inventory_count").notNull(),
    expectedInventoryDigest: bytea("expected_inventory_digest").notNull(),
    authorizationArtifactHash: bytea(
      "authorization_artifact_hash",
    ).notNull(),
    recoveryReadinessDigest: bytea("recovery_readiness_digest"),
  },
  (table) => [
    foreignKey({
      columns: [table.operationId],
      foreignColumns: [cryptoDeliveryOperations.operationId],
      name: "crypto_device_epoch_operations_operation_fk",
    }),
    foreignKey({
      columns: [table.targetDeviceId],
      foreignColumns: [humanCryptoDevices.deviceId],
      name: "crypto_device_epoch_operations_target_device_fk",
    }),
    foreignKey({
      columns: [table.ownerHumanId],
      foreignColumns: [humanCryptoCustodies.humanId],
      name: "crypto_device_epoch_operations_custody_fk",
    }),
    foreignKey({
      columns: [table.sourceDeviceId],
      foreignColumns: [humanCryptoDevices.deviceId],
      name: "crypto_device_epoch_operations_source_device_fk",
    }),
    portableId(
      "crypto_device_epoch_operations_operation_id_portable",
      table.operationId,
    ),
    portableId(
      "crypto_device_epoch_operations_target_device_id_portable",
      table.targetDeviceId,
    ),
    portableId(
      "crypto_device_epoch_operations_owner_human_id_portable",
      table.ownerHumanId,
    ),
    portableId(
      "crypto_device_epoch_operations_source_device_id_portable",
      table.sourceDeviceId,
    ),
    safeCounter(
      "crypto_device_epoch_operations_device_revision_safe",
      table.expectedDeviceRevision,
    ),
    safeCounter(
      "crypto_device_epoch_operations_inventory_revision_safe",
      table.expectedInventoryRevision,
    ),
    check(
      "crypto_device_epoch_operations_inventory_count",
      sql`${table.expectedInventoryCount} between 0 and ${
        sql.raw(String(CRYPTO_DELIVERY_COLLECTION_LIMITS.fanoutRowsPerOperation))
      }`,
    ),
    exactBytes(
      "crypto_device_epoch_operations_inventory_digest_size",
      table.expectedInventoryDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    exactBytes(
      "crypto_device_epoch_operations_artifact_hash_size",
      table.authorizationArtifactHash,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    exactBytes(
      "crypto_device_epoch_operations_readiness_digest_size",
      table.recoveryReadinessDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    ...mutablePolicies("crypto_device_epoch_operations", { delete: true }),
  ],
).enableRLS();

export const cryptoDomainTransitionSteps = pgTable(
  "crypto_domain_transition_steps",
  {
    operationId: text("operation_id").notNull(),
    domainId: text("domain_id").notNull(),
    expectedEpoch: bigint("expected_epoch", { mode: "number" }).notNull(),
    expectedAuthorizationRevision: bigint(
      "expected_authorization_revision",
      { mode: "number" },
    ).notNull(),
    expectedParticipantDigest: bytea("expected_participant_digest").notNull(),
    targetEpoch: bigint("target_epoch", { mode: "number" }).notNull(),
    committerDeviceId: text("committer_device_id"),
    expectedProviderStateHash: bytea("expected_provider_state_hash"),
    candidateProviderId: text("candidate_provider_id"),
    candidateProviderStateHash: bytea("candidate_provider_state_hash"),
    candidateRosterBytes: bytea("candidate_roster_bytes"),
    candidateTransitionDigest: bytea("candidate_transition_digest"),
    candidateTargetLeafIndex: smallint("candidate_target_leaf_index"),
    state: text("state").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    retryCount: smallint("retry_count").notNull(),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.operationId, table.domainId] }),
    foreignKey({
      columns: [table.operationId],
      foreignColumns: [cryptoDeliveryOperations.operationId],
      name: "crypto_domain_transition_steps_operation_fk",
    }),
    foreignKey({
      columns: [table.domainId],
      foreignColumns: [cryptoDomains.id],
      name: "crypto_domain_transition_steps_domain_fk",
    }),
    foreignKey({
      columns: [table.committerDeviceId],
      foreignColumns: [humanCryptoDevices.deviceId],
      name: "crypto_domain_transition_steps_committer_fk",
    }),
    portableId(
      "crypto_domain_transition_steps_operation_id_portable",
      table.operationId,
    ),
    portableId(
      "crypto_domain_transition_steps_domain_id_portable",
      table.domainId,
    ),
    safeCounter(
      "crypto_domain_transition_steps_expected_epoch_safe",
      table.expectedEpoch,
    ),
    safeCounter(
      "crypto_domain_transition_steps_authorization_revision_safe",
      table.expectedAuthorizationRevision,
    ),
    exactBytes(
      "crypto_domain_transition_steps_participant_digest_size",
      table.expectedParticipantDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    safeCounter(
      "crypto_domain_transition_steps_target_epoch_safe",
      table.targetEpoch,
    ),
    check(
      "crypto_domain_transition_steps_epoch_advances",
      sql`${table.targetEpoch} = ${table.expectedEpoch} + 1`,
    ),
    portableId(
      "crypto_domain_transition_steps_committer_device_id_portable",
      table.committerDeviceId,
    ),
    portableId(
      "crypto_domain_transition_steps_candidate_provider_id_portable",
      table.candidateProviderId,
    ),
    exactBytes(
      "crypto_domain_transition_steps_expected_provider_state_hash_size",
      table.expectedProviderStateHash,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    exactBytes(
      "crypto_domain_transition_steps_candidate_state_hash_size",
      table.candidateProviderStateHash,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    boundedBytes(
      "crypto_domain_transition_steps_candidate_roster_size",
      table.candidateRosterBytes,
      CRYPTO_STORAGE_BYTE_LIMITS.roster,
      1,
    ),
    exactBytes(
      "crypto_domain_transition_steps_candidate_transition_digest_size",
      table.candidateTransitionDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    check(
      "crypto_domain_transition_steps_candidate_leaf_range",
      sql`${table.candidateTargetLeafIndex} between 0 and ${
        sql.raw(
          String(
            CRYPTO_DELIVERY_COLLECTION_LIMITS.currentDeviceLeavesPerDomain - 1,
          ),
        )
      }`,
    ),
    check(
      "crypto_domain_transition_steps_candidate_coherent",
      sql`(
        ${table.state} in ('awaiting_committer', 'preparing')
        and ${table.expectedProviderStateHash} is null
        and ${table.candidateProviderId} is null
        and ${table.candidateProviderStateHash} is null
        and ${table.candidateRosterBytes} is null
        and ${table.candidateTransitionDigest} is null
        and ${table.candidateTargetLeafIndex} is null
      ) or (
        ${table.state} in (
          'awaiting_delivery', 'ready_to_activate', 'active'
        )
        and ${table.expectedProviderStateHash} is not null
        and ${table.candidateProviderId} is not null
        and ${table.candidateProviderStateHash} is not null
        and ${table.candidateRosterBytes} is not null
        and ${table.candidateTransitionDigest} is not null
        and ${table.candidateTargetLeafIndex} is not null
      ) or (
        ${table.state} = 'failed'
        and (
          (
            ${table.expectedProviderStateHash} is null
            and ${table.candidateProviderId} is null
            and ${table.candidateProviderStateHash} is null
            and ${table.candidateRosterBytes} is null
            and ${table.candidateTransitionDigest} is null
            and ${table.candidateTargetLeafIndex} is null
          ) or (
            ${table.expectedProviderStateHash} is not null
            and ${table.candidateProviderId} is not null
            and ${table.candidateProviderStateHash} is not null
            and ${table.candidateRosterBytes} is not null
            and ${table.candidateTransitionDigest} is not null
            and ${table.candidateTargetLeafIndex} is not null
          )
        )
      )`,
    ),
    check(
      "crypto_domain_transition_steps_state",
      sql`${table.state} in (
        'awaiting_committer', 'preparing', 'awaiting_delivery',
        'ready_to_activate', 'active', 'failed'
      )`,
    ),
    check(
      "crypto_domain_transition_steps_lease_coherent",
      sql`(
        ${table.leaseOwner} is null and ${table.leaseExpiresAt} is null
      ) or (
        ${table.leaseOwner} is not null
        and ${table.leaseExpiresAt} is not null
      )`,
    ),
    portableId(
      "crypto_domain_transition_steps_lease_owner_portable",
      table.leaseOwner,
    ),
    check(
      "crypto_domain_transition_steps_retry_bound",
      sql`${table.retryCount} between 0 and ${
        sql.raw(String(CRYPTO_DELIVERY_COLLECTION_LIMITS.maximumAttempts))
      }`,
    ),
    portableId(
      "crypto_domain_transition_steps_failure_code_portable",
      table.failureCode,
    ),
    check(
      "crypto_domain_transition_steps_time_order",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    index("idx_crypto_domain_transition_steps_state").on(
      table.state,
      table.leaseExpiresAt,
    ),
    uniqueIndex("uq_crypto_domain_transition_steps_live_domain")
      .on(table.domainId)
      .where(sql`${table.state} not in ('active', 'failed')`),
    ...mutablePolicies("crypto_domain_transition_steps", { delete: true }),
  ],
).enableRLS();

export const cryptoDomainTransitionNamespaces = pgTable(
  "crypto_domain_transition_namespaces",
  {
    operationId: text("operation_id").notNull(),
    domainId: text("domain_id").notNull(),
    namespaceId: text("namespace_id").notNull(),
    expectedAccessRevision: bigint("expected_access_revision", {
      mode: "number",
    }).notNull(),
    expectedBindingHash: bytea("expected_binding_hash").notNull(),
    candidateBindingHash: bytea("candidate_binding_hash"),
    candidateSignedBindingBytes: bytea("candidate_signed_binding_bytes"),
    candidateHumanKeyringEnvelopeBytes: bytea(
      "candidate_human_keyring_envelope_bytes",
    ),
    candidateAiKeyringEnvelopeBytes: bytea(
      "candidate_ai_keyring_envelope_bytes",
    ),
    state: text("state").notNull(),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.operationId, table.domainId, table.namespaceId],
    }),
    foreignKey({
      columns: [table.operationId, table.domainId],
      foreignColumns: [
        cryptoDomainTransitionSteps.operationId,
        cryptoDomainTransitionSteps.domainId,
      ],
      name: "crypto_domain_transition_namespaces_domain_step_fk",
    }),
    portableId(
      "crypto_domain_transition_namespaces_operation_id_portable",
      table.operationId,
    ),
    portableId(
      "crypto_domain_transition_namespaces_domain_id_portable",
      table.domainId,
    ),
    portableId(
      "crypto_domain_transition_namespaces_namespace_id_portable",
      table.namespaceId,
    ),
    safeCounter(
      "crypto_domain_transition_namespaces_access_revision_safe",
      table.expectedAccessRevision,
    ),
    exactBytes(
      "crypto_domain_transition_namespaces_expected_hash_size",
      table.expectedBindingHash,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    exactBytes(
      "crypto_domain_transition_namespaces_candidate_hash_size",
      table.candidateBindingHash,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    boundedBytes(
      "crypto_domain_transition_namespaces_candidate_signed_size",
      table.candidateSignedBindingBytes,
      CRYPTO_STORAGE_BYTE_LIMITS.namespaceBinding,
      1,
    ),
    boundedBytes(
      "crypto_domain_transition_namespaces_candidate_human_keyring_size",
      table.candidateHumanKeyringEnvelopeBytes,
      CRYPTO_STORAGE_BYTE_LIMITS.namespaceKeyring,
      1,
    ),
    boundedBytes(
      "crypto_domain_transition_namespaces_candidate_ai_keyring_size",
      table.candidateAiKeyringEnvelopeBytes,
      CRYPTO_STORAGE_BYTE_LIMITS.namespaceKeyring,
      1,
    ),
    check(
      "crypto_domain_transition_namespaces_state",
      sql`${table.state} in ('pending', 'prepared', 'active', 'failed')`,
    ),
    check(
      "crypto_domain_transition_namespaces_candidate_coherent",
      sql`(
        ${table.state} = 'pending'
        and ${table.candidateBindingHash} is null
        and ${table.candidateSignedBindingBytes} is null
        and ${table.candidateHumanKeyringEnvelopeBytes} is null
        and ${table.candidateAiKeyringEnvelopeBytes} is null
      ) or (
        ${table.state} in ('prepared', 'active')
        and ${table.candidateBindingHash} is not null
        and ${table.candidateSignedBindingBytes} is not null
        and ${table.candidateHumanKeyringEnvelopeBytes} is not null
        and ${table.candidateAiKeyringEnvelopeBytes} is not null
      ) or (
        ${table.state} = 'failed'
        and (
          (
            ${table.candidateBindingHash} is null
            and ${table.candidateSignedBindingBytes} is null
            and ${table.candidateHumanKeyringEnvelopeBytes} is null
            and ${table.candidateAiKeyringEnvelopeBytes} is null
          ) or (
            ${table.candidateBindingHash} is not null
            and ${table.candidateSignedBindingBytes} is not null
            and ${table.candidateHumanKeyringEnvelopeBytes} is not null
            and ${table.candidateAiKeyringEnvelopeBytes} is not null
          )
        )
      )`,
    ),
    portableId(
      "crypto_domain_transition_namespaces_failure_code_portable",
      table.failureCode,
    ),
    check(
      "crypto_domain_transition_namespaces_time_order",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    index("idx_crypto_domain_transition_namespaces_state").on(
      table.state,
      table.namespaceId,
    ),
    uniqueIndex("uq_crypto_domain_transition_namespaces_live_namespace")
      .on(table.namespaceId)
      .where(sql`${table.state} not in ('active', 'failed')`),
    ...mutablePolicies("crypto_domain_transition_namespaces", {
      delete: true,
    }),
  ],
).enableRLS();

export const cryptoDeliveryMessages = pgTable(
  "crypto_delivery_messages",
  {
    messageId: text("message_id").primaryKey(),
    operationId: text("operation_id").notNull(),
    domainId: text("domain_id"),
    domainSequence: bigint("domain_sequence", { mode: "number" }),
    recipientSequence: bigint("recipient_sequence", {
      mode: "number",
    }).notNull(),
    kind: text("kind").notNull(),
    recipientDeviceId: text("recipient_device_id").notNull(),
    formatVersion: smallint("format_version").notNull(),
    payloadHash: bytea("payload_hash").notNull(),
    payloadBytes: bytea("payload_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.operationId],
      foreignColumns: [cryptoDeliveryOperations.operationId],
      name: "crypto_delivery_messages_operation_fk",
    }),
    foreignKey({
      columns: [table.domainId],
      foreignColumns: [cryptoDomains.id],
      name: "crypto_delivery_messages_domain_fk",
    }),
    foreignKey({
      columns: [table.recipientDeviceId],
      foreignColumns: [humanCryptoDevices.deviceId],
      name: "crypto_delivery_messages_recipient_fk",
    }),
    portableId("crypto_delivery_messages_id_portable", table.messageId),
    portableId(
      "crypto_delivery_messages_operation_id_portable",
      table.operationId,
    ),
    portableId(
      "crypto_delivery_messages_domain_id_portable",
      table.domainId,
    ),
    safeCounter(
      "crypto_delivery_messages_domain_sequence_safe",
      table.domainSequence,
    ),
    check(
      "crypto_delivery_messages_recipient_sequence_positive",
      sql`${table.recipientSequence} >= 1`,
    ),
    check(
      "crypto_delivery_messages_domain_sequence_coherent",
      sql`(
        ${table.domainId} is null and ${table.domainSequence} is null
      ) or (
        ${table.domainId} is not null and ${table.domainSequence} is not null
      )`,
    ),
    check(
      "crypto_delivery_messages_kind",
      sql`${table.kind} in (
        'key_package', 'proposal', 'commit', 'welcome', 'public_state',
        'binding_candidate', 'recovery_archive', 'operation_receipt',
        'device_transfer', 'recovery_challenge'
      )`,
    ),
    portableId(
      "crypto_delivery_messages_recipient_device_id_portable",
      table.recipientDeviceId,
    ),
    check(
      "crypto_delivery_messages_format_version",
      sql`${table.formatVersion} >= 1`,
    ),
    exactBytes(
      "crypto_delivery_messages_payload_hash_size",
      table.payloadHash,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    boundedBytes(
      "crypto_delivery_messages_payload_size",
      table.payloadBytes,
      CRYPTO_DELIVERY_BYTE_LIMITS.opaquePayload,
      1,
    ),
    check(
      "crypto_delivery_messages_expiry",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    unique("uq_crypto_delivery_messages_recipient").on(
      table.messageId,
      table.recipientDeviceId,
    ),
    unique("uq_crypto_delivery_messages_recipient_sequence").on(
      table.recipientDeviceId,
      table.recipientSequence,
    ),
    unique("uq_crypto_delivery_messages_payload").on(
      table.operationId,
      table.payloadHash,
      table.recipientDeviceId,
    ),
    uniqueIndex("uq_crypto_delivery_messages_domain_sequence")
      .on(table.domainId, table.domainSequence)
      .where(sql`${table.domainId} is not null`),
    index("idx_crypto_delivery_messages_recipient_expiry").on(
      table.recipientDeviceId,
      table.expiresAt,
    ),
    index("idx_crypto_delivery_messages_global_expiry").on(
      table.expiresAt,
      table.recipientDeviceId,
      table.recipientSequence,
    ),
    ...appendOnlyPolicies("crypto_delivery_messages"),
    deletePolicy("crypto_delivery_messages"),
  ],
).enableRLS();

export const cryptoDeliveryAcknowledgements = pgTable(
  "crypto_delivery_acknowledgements",
  {
    messageId: text("message_id").notNull(),
    deviceId: text("device_id").notNull(),
    processedRevision: bigint("processed_revision", {
      mode: "number",
    }).notNull(),
    acknowledgementDigest: bytea("acknowledgement_digest").notNull(),
    acknowledgedAt: timestamp("acknowledged_at", {
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.deviceId] }),
    foreignKey({
      columns: [table.messageId, table.deviceId],
      foreignColumns: [
        cryptoDeliveryMessages.messageId,
        cryptoDeliveryMessages.recipientDeviceId,
      ],
      name: "crypto_delivery_acknowledgements_recipient_fk",
    }),
    portableId(
      "crypto_delivery_acknowledgements_message_id_portable",
      table.messageId,
    ),
    portableId(
      "crypto_delivery_acknowledgements_device_id_portable",
      table.deviceId,
    ),
    safeCounter(
      "crypto_delivery_acknowledgements_revision_safe",
      table.processedRevision,
    ),
    exactBytes(
      "crypto_delivery_acknowledgements_digest_size",
      table.acknowledgementDigest,
      CRYPTO_DELIVERY_BYTE_LIMITS.hash,
    ),
    ...appendOnlyPolicies("crypto_delivery_acknowledgements"),
    deletePolicy("crypto_delivery_acknowledgements"),
  ],
).enableRLS();

export const cryptoOperationOutbox = pgTable(
  "crypto_operation_outbox",
  {
    outboxId: text("outbox_id").primaryKey(),
    operationId: text("operation_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    eventType: text("event_type").notNull(),
    payloadBytes: bytea("payload_bytes").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    claimedBy: text("claimed_by"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    attempts: smallint("attempts").notNull(),
    maximumAttempts: smallint("maximum_attempts").notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.operationId],
      foreignColumns: [cryptoDeliveryOperations.operationId],
      name: "crypto_operation_outbox_operation_fk",
    }),
    portableId("crypto_operation_outbox_id_portable", table.outboxId),
    portableId(
      "crypto_operation_outbox_operation_id_portable",
      table.operationId,
    ),
    safeCounter("crypto_operation_outbox_sequence_safe", table.sequence),
    portableId(
      "crypto_operation_outbox_event_type_portable",
      table.eventType,
    ),
    boundedBytes(
      "crypto_operation_outbox_payload_size",
      table.payloadBytes,
      CRYPTO_DELIVERY_BYTE_LIMITS.contentFreeOutboxPayload,
      1,
    ),
    portableId(
      "crypto_operation_outbox_idempotency_portable",
      table.idempotencyKey,
    ),
    check(
      "crypto_operation_outbox_claim_coherent",
      sql`(
        ${table.claimedBy} is null and ${table.claimExpiresAt} is null
      ) or (
        ${table.claimedBy} is not null
        and ${table.claimExpiresAt} is not null
      )`,
    ),
    portableId(
      "crypto_operation_outbox_claimed_by_portable",
      table.claimedBy,
    ),
    check(
      "crypto_operation_outbox_attempts_bound",
      sql`${table.attempts} between 0 and ${table.maximumAttempts}
        and ${table.maximumAttempts} = ${
          sql.raw(String(CRYPTO_DELIVERY_COLLECTION_LIMITS.maximumAttempts))
        }`,
    ),
    check(
      "crypto_operation_outbox_terminal_coherent",
      sql`not (
        ${table.deliveredAt} is not null and ${table.terminalAt} is not null
      )`,
    ),
    portableId(
      "crypto_operation_outbox_failure_code_portable",
      table.failureCode,
    ),
    unique("uq_crypto_operation_outbox_idempotency").on(
      table.idempotencyKey,
    ),
    unique("uq_crypto_operation_outbox_sequence").on(
      table.operationId,
      table.sequence,
    ),
    index("idx_crypto_operation_outbox_claimable").on(
      table.deliveredAt,
      table.terminalAt,
      table.claimExpiresAt,
    ),
    ...mutablePolicies("crypto_operation_outbox", { delete: true }),
  ],
).enableRLS();

export const LATTICE_STORAGE_TABLES = Object.freeze([
  cryptoDomains,
  cryptoDomainProviderHeads,
  namespaceCryptoBindings,
  namespaceCryptoHeads,
  cryptoObjects,
  objectCryptoAccessManifests,
  objectCryptoNamespaceEnvelopes,
  objectCryptoAccessHeads,
  agentCryptoRuntimeStates,
  agentCryptoRuntimeConfigObjects,
  agentCryptoRuntimeDomainEnvelopes,
  agentCryptoRuntimeChallenges,
  agentCryptoRuntimeSigners,
  cryptoGrants,
  humanCryptoRecoveryArchives,
  backgroundCryptoAuthorizationRequests,
  backgroundCryptoAuthorizationDomainRequirements,
  backgroundCryptoAuthorizationNamespaceRequirements,
  processorCryptoSignerAuthorizations,
] as const);

export const CRYPTO_DELIVERY_TABLES = Object.freeze([
  humanCryptoCustodies,
  humanCryptoDevices,
  humanCryptoDeviceGroupHeads,
  humanCryptoDeviceGroupJoinRequests,
  humanCryptoDeviceGroupCommits,
  humanCryptoDeviceGroupWelcomes,
  humanCryptoDeviceGroupAcknowledgements,
  humanCryptoDeviceChallenges,
  humanCryptoDeviceAdmissionChallenges,
  humanCryptoDeviceAdmissions,
  humanCryptoRecoveryKeys,
  humanCryptoDeviceKeyPackages,
  cryptoDomainDevices,
  cryptoDeliveryOperations,
  cryptoHumanMembershipTransitions,
  cryptoDeviceEpochOperations,
  cryptoDomainTransitionSteps,
  cryptoDomainTransitionNamespaces,
  cryptoDeliveryMessages,
  cryptoDeliveryAcknowledgements,
  cryptoOperationOutbox,
] as const);

export const CRYPTO_STORAGE_TABLES = Object.freeze([
  ...LATTICE_STORAGE_TABLES,
  ...CRYPTO_DELIVERY_TABLES,
] as const);
