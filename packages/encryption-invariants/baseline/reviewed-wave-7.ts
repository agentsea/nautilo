import type {
  EncryptionCoverageEntry,
  KeyFamily,
} from "../src/model";

const SCHEMA_EVIDENCE =
  "packages/db/tests/unit/crypto-delivery-schema.test.ts";
const STORAGE_EVIDENCE =
  "packages/lattice-bridge/tests/integration/postgres-lattice-storage.integration.test.ts";

type CryptoTableDeclaration = Readonly<{
  columns: readonly string[];
  protectedColumns: readonly string[];
  repository: string;
  includeTable?: boolean;
}>;

/**
 * Wave 7 adds only public cryptographic coordinates, bounded operational
 * metadata, and opaque end-to-end encrypted delivery material. Existing
 * Wave 6 tables list only their newly added pause columns here.
 */
const CRYPTO_TABLES = {
  crypto_delivery_acknowledgements: {
    columns: [
      "acknowledged_at",
      "acknowledgement_digest",
      "device_id",
      "message_id",
      "processed_revision",
    ],
    protectedColumns: [],
    repository:
      "packages/lattice-bridge/src/server/delivery/postgres-delivery-acknowledgement-repository.ts",
    includeTable: true,
  },
  crypto_delivery_messages: {
    columns: [
      "created_at",
      "domain_id",
      "domain_sequence",
      "expires_at",
      "format_version",
      "kind",
      "message_id",
      "operation_id",
      "payload_bytes",
      "payload_hash",
      "recipient_device_id",
      "recipient_sequence",
    ],
    protectedColumns: ["payload_bytes"],
    repository:
      "packages/lattice-bridge/src/server/device/postgres-device-fanout-admission-repository.ts",
    includeTable: true,
  },
  crypto_delivery_operations: {
    columns: [
      "aggregate_payload_bytes",
      "audit_ref",
      "created_at",
      "deadline_at",
      "expected_custody_revision",
      "expected_device_revision",
      "expected_participant_digest",
      "expected_recovery_generation",
      "failure_code",
      "fanout_row_count",
      "human_id",
      "idempotency_key",
      "kind",
      "lease_expires_at",
      "lease_owner",
      "maximum_attempts",
      "operation_id",
      "retry_count",
      "state",
      "target_device_id",
      "target_human_id",
      "terminal_at",
      "updated_at",
    ],
    protectedColumns: [],
    repository:
      "packages/lattice-bridge/src/server/delivery/postgres-delivery-operation-reconciler.ts",
    includeTable: true,
  },
  crypto_device_epoch_operations: {
    columns: [
      "authorization_artifact_hash",
      "expected_device_revision",
      "expected_inventory_count",
      "expected_inventory_digest",
      "expected_inventory_revision",
      "operation_id",
      "owner_human_id",
      "recovery_readiness_digest",
      "source_device_id",
      "target_device_id",
    ],
    protectedColumns: [],
    repository:
      "packages/lattice-bridge/src/server/device/postgres-device-fanout-admission-repository.ts",
    includeTable: true,
  },
  crypto_domain_devices: {
    columns: [
      "device_id",
      "domain_id",
      "human_id",
      "joined_epoch",
      "leaf_index",
      "removed_at",
      "removed_epoch",
    ],
    protectedColumns: [],
    repository:
      "packages/lattice-bridge/src/server/device/postgres-device-revocation-finalization-repository.ts",
    includeTable: true,
  },
  crypto_domain_transition_namespaces: {
    columns: [
      "candidate_ai_keyring_envelope_bytes",
      "candidate_binding_hash",
      "candidate_human_keyring_envelope_bytes",
      "candidate_signed_binding_bytes",
      "created_at",
      "domain_id",
      "expected_access_revision",
      "expected_binding_hash",
      "failure_code",
      "namespace_id",
      "operation_id",
      "state",
      "updated_at",
    ],
    protectedColumns: [
      "candidate_ai_keyring_envelope_bytes",
      "candidate_human_keyring_envelope_bytes",
      "candidate_signed_binding_bytes",
    ],
    repository:
      "packages/lattice-bridge/src/server/delivery/postgres-domain-transition-submission-repository.ts",
    includeTable: true,
  },
  crypto_domain_transition_steps: {
    columns: [
      "candidate_provider_id",
      "candidate_provider_state_hash",
      "candidate_roster_bytes",
      "candidate_target_leaf_index",
      "candidate_transition_digest",
      "committer_device_id",
      "created_at",
      "domain_id",
      "expected_authorization_revision",
      "expected_epoch",
      "expected_participant_digest",
      "expected_provider_state_hash",
      "failure_code",
      "lease_expires_at",
      "lease_owner",
      "operation_id",
      "retry_count",
      "state",
      "target_epoch",
      "updated_at",
    ],
    protectedColumns: [],
    repository:
      "packages/lattice-bridge/src/server/delivery/postgres-domain-transition-submission-repository.ts",
    includeTable: true,
  },
  crypto_domains: {
    columns: ["pause_operation_id", "writes_paused"],
    protectedColumns: [],
    repository:
      "packages/lattice-bridge/src/server/device/postgres-device-revocation-finalization-repository.ts",
  },
  crypto_human_membership_transitions: {
    columns: [
      "activated_at",
      "admitted_bootstrap_device_id",
      "admitted_target_domain_id",
      "bootstrap_device_id",
      "candidate_ai_keyring_envelope_bytes",
      "candidate_binding_hash",
      "candidate_digest",
      "candidate_human_keyring_envelope_bytes",
      "candidate_signed_binding_bytes",
      "candidate_submitted_at",
      "committer_device_id",
      "expected_access_revision",
      "expected_binding_hash",
      "namespace_id",
      "new_participant_digest",
      "new_participants",
      "old_domain_id",
      "old_participant_digest",
      "old_participants",
      "operation_id",
      "released_at",
      "room_id",
      "target_domain_epoch",
      "target_domain_id",
      "target_human_actor_id",
      "target_room_role",
    ],
    protectedColumns: [
      "candidate_ai_keyring_envelope_bytes",
      "candidate_human_keyring_envelope_bytes",
      "candidate_signed_binding_bytes",
    ],
    repository:
      "packages/lattice-bridge/src/server/delivery/postgres-human-membership-rebind-repository.ts",
    includeTable: true,
  },
  crypto_operation_outbox: {
    columns: [
      "attempts",
      "claim_expires_at",
      "claimed_by",
      "created_at",
      "delivered_at",
      "event_type",
      "failure_code",
      "idempotency_key",
      "maximum_attempts",
      "operation_id",
      "outbox_id",
      "payload_bytes",
      "sequence",
      "terminal_at",
    ],
    protectedColumns: [],
    repository:
      "packages/lattice-bridge/src/server/delivery/postgres-crypto-outbox-repository.ts",
    includeTable: true,
  },
  human_crypto_custodies: {
    columns: [
      "created_at",
      "current_inventory_count",
      "current_inventory_digest",
      "current_inventory_revision",
      "current_recovery_generation",
      "current_recovery_public_key_digest",
      "ever_initialized_at",
      "first_device_id",
      "human_actor_id",
      "human_id",
      "initial_installation_lineage_digest",
      "last_transition_audit_ref",
      "revision",
      "state",
      "updated_at",
      "user_id",
    ],
    protectedColumns: [],
    repository:
      "packages/lattice-bridge/src/server/device/postgres-initial-bootstrap-repository.ts",
    includeTable: true,
  },
  human_crypto_device_challenges: {
    columns: [
      "authorization_digest",
      "bootstrap_authority_id",
      "bootstrap_context",
      "challenge_hash",
      "challenge_id",
      "consumed_at",
      "encryption_public_key_digest",
      "expected_custody_revision",
      "expected_recovery_generation",
      "expected_response_digest",
      "expires_at",
      "human_actor_id",
      "human_id",
      "idempotency_key",
      "installation_lineage_digest",
      "invalidated_at",
      "issued_at",
      "kind",
      "pending_device_id",
      "receipt_audit_ref",
      "recovery_public_key_digest",
      "revision",
      "signing_public_key_digest",
      "terminal_result_code",
      "user_id",
    ],
    protectedColumns: [],
    repository:
      "packages/lattice-bridge/src/server/device/postgres-initial-bootstrap-repository.ts",
    includeTable: true,
  },
  human_crypto_device_key_packages: {
    columns: [
      "consumed_at",
      "consuming_operation_id",
      "created_at",
      "device_id",
      "domain_id",
      "expected_provider_head_hash",
      "expires_at",
      "format_version",
      "generation",
      "package_bytes",
      "package_hash",
      "package_id",
    ],
    protectedColumns: [],
    repository:
      "packages/lattice-bridge/src/server/device/postgres-device-join-package-repository.ts",
    includeTable: true,
  },
  human_crypto_devices: {
    columns: [
      "activated_at",
      "approval_generation",
      "authorization_evidence_digest",
      "authorization_kind",
      "client_kind",
      "created_at",
      "delivery_acknowledged_sequence",
      "delivery_blocked_at",
      "delivery_blocked_operation_id",
      "delivery_blocked_reason",
      "delivery_blocked_sequence",
      "delivery_sequence_high_watermark",
      "device_generation",
      "device_id",
      "encryption_public_key",
      "human_actor_id",
      "human_id",
      "installation_lineage_digest",
      "key_package_count",
      "key_package_generation",
      "last_seen_at",
      "public_fingerprint",
      "recovery_generation",
      "rejected_at",
      "revision",
      "revoked_at",
      "signing_public_key",
      "state",
      "user_id",
    ],
    protectedColumns: [],
    repository:
      "packages/lattice-bridge/src/server/device/postgres-initial-bootstrap-repository.ts",
    includeTable: true,
  },
  human_crypto_recovery_keys: {
    columns: [
      "activated_at",
      "archive_hash",
      "format_version",
      "generation",
      "human_id",
      "issuer_device_id",
      "public_key",
      "public_key_digest",
      "recovery_key_id",
      "retired_at",
      "revision",
      "state",
    ],
    protectedColumns: [],
    repository:
      "packages/lattice-bridge/src/server/recovery/postgres-recovery-rotation-repository.ts",
    includeTable: true,
  },
  namespace_crypto_heads: {
    columns: ["pause_operation_id", "writes_paused"],
    protectedColumns: [],
    repository:
      "packages/lattice-bridge/src/server/device/postgres-device-revocation-finalization-repository.ts",
  },
} as const satisfies Readonly<Record<string, CryptoTableDeclaration>>;

function stableId(locator: string): string {
  return locator
    .replaceAll("/", "-")
    .replaceAll("#", "-")
    .replaceAll(":", "-")
    .replaceAll(".", "-")
    .replaceAll("_", "-");
}

function boundedEntry(input: {
  readonly locator: string;
  readonly repository: string;
  readonly metadataAllowlist: readonly string[];
}): EncryptionCoverageEntry {
  return {
    id: `db.wave7.${stableId(input.locator)}`,
    surface: "db",
    locator: input.locator,
    owner: "packages/lattice-bridge",
    readers: [input.repository],
    writers: [input.repository],
    migrationState: "not_applicable",
    retention:
      "Retained only for the explicit bounded Wave 7 custody, device, transition, delivery, or audit lifecycle.",
    testEvidence: [SCHEMA_EVIDENCE, STORAGE_EVIDENCE],
    classification: "bounded_metadata",
    metadataAllowlist: input.metadataAllowlist,
    plaintextReason:
      "The exact field set contains only bounded identifiers, public keys, hashes, counters, status, timestamps, canonical participants, or signed public cryptographic state; it contains no user-authored content or secret key bytes.",
  };
}

function protectedEntry(input: {
  readonly locator: string;
  readonly repository: string;
  readonly keyFamily?: KeyFamily;
}): EncryptionCoverageEntry {
  return {
    id: `db.wave7.${stableId(input.locator)}`,
    surface: "db",
    locator: input.locator,
    owner: "packages/lattice-bridge",
    readers: [input.repository],
    writers: [input.repository],
    migrationState: "ciphertext_only",
    retention:
      "Retained only as validated opaque ciphertext or wrapped key material for the owning bounded Wave 7 operation.",
    testEvidence: [SCHEMA_EVIDENCE, STORAGE_EVIDENCE],
    classification: "protected",
    keyFamily: input.keyFamily ?? "namespace_human",
    bridgeRepository: input.repository,
    negativeTestEvidence: [STORAGE_EVIDENCE],
  };
}

export const REVIEWED_WAVE_7_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = Object.entries(CRYPTO_TABLES).flatMap(
    ([table, declaration]) => {
      const tableLocator = `public.${table}`;
      const protectedColumns = new Set<string>(declaration.protectedColumns);
      const entries: EncryptionCoverageEntry[] = [];
      if ("includeTable" in declaration && declaration.includeTable === true) {
        entries.push(
          protectedColumns.size > 0
            ? protectedEntry({
              locator: tableLocator,
              repository: declaration.repository,
            })
            : boundedEntry({
              locator: tableLocator,
              repository: declaration.repository,
              metadataAllowlist: declaration.columns,
            }),
        );
      }
      entries.push(...declaration.columns.map((column) => {
        const locator = `${tableLocator}.${column}`;
        return protectedColumns.has(column)
          ? protectedEntry({
            locator,
            repository: declaration.repository,
          })
          : boundedEntry({
            locator,
            repository: declaration.repository,
            metadataAllowlist: [column],
          });
      }));
      return entries;
    },
  );

const WAVE_7_DATABASE_WRITER_LOCATORS = [
  "packages/lattice-bridge/src/server/delivery/postgres-crypto-outbox-repository.ts#claim:raw_sql:update:public.crypto_operation_outbox:1",
  "packages/lattice-bridge/src/server/delivery/postgres-crypto-outbox-repository.ts#delivered:raw_sql:update:public.crypto_operation_outbox:1",
  "packages/lattice-bridge/src/server/delivery/postgres-crypto-outbox-repository.ts#fail:raw_sql:update:public.crypto_operation_outbox:1",
  "packages/lattice-bridge/src/server/delivery/postgres-crypto-outbox-repository.ts#heartbeat:raw_sql:update:public.crypto_operation_outbox:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-acknowledgement-repository.ts#acknowledge:raw_sql:insert:public.crypto_delivery_acknowledgements:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-acknowledgement-repository.ts#acknowledge:raw_sql:insert:public.crypto_operation_outbox:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-acknowledgement-repository.ts#acknowledge:raw_sql:insert:public.crypto_operation_outbox:2",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-acknowledgement-repository.ts#acknowledge:raw_sql:update:public.crypto_delivery_operations:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-acknowledgement-repository.ts#acknowledge:raw_sql:update:public.crypto_delivery_operations:2",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-acknowledgement-repository.ts#acknowledge:raw_sql:update:public.crypto_delivery_operations:3",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-acknowledgement-repository.ts#acknowledge:raw_sql:update:public.crypto_device_epoch_operations:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-acknowledgement-repository.ts#acknowledge:raw_sql:update:public.crypto_domain_transition_steps:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-acknowledgement-repository.ts#acknowledge:raw_sql:update:public.crypto_domain_transition_steps:2",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-acknowledgement-repository.ts#acknowledge:raw_sql:update:public.human_crypto_devices:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-maintenance-repository.ts#blockExpiredDeliveries:raw_sql:update:public.human_crypto_devices:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-maintenance-repository.ts#pruneRetainedState:raw_sql:delete:public.crypto_delivery_acknowledgements:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-maintenance-repository.ts#pruneRetainedState:raw_sql:delete:public.crypto_delivery_messages:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-maintenance-repository.ts#pruneRetainedState:raw_sql:delete:public.crypto_delivery_operations:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-maintenance-repository.ts#pruneRetainedState:raw_sql:delete:public.crypto_device_epoch_operations:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-maintenance-repository.ts#pruneRetainedState:raw_sql:delete:public.crypto_domain_transition_namespaces:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-maintenance-repository.ts#pruneRetainedState:raw_sql:delete:public.crypto_domain_transition_steps:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-maintenance-repository.ts#pruneRetainedState:raw_sql:delete:public.crypto_human_membership_transitions:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-maintenance-repository.ts#pruneRetainedState:raw_sql:delete:public.crypto_operation_outbox:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-maintenance-repository.ts#pruneRetainedState:raw_sql:delete:public.human_crypto_device_challenges:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-maintenance-repository.ts#pruneRetainedState:raw_sql:delete:public.human_crypto_device_key_packages:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-maintenance-repository.ts#terminalizeBlockedOutboxTails:raw_sql:update:public.crypto_operation_outbox:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-operation-reconciler.ts##failDeviceAdmission:raw_sql:insert:public.crypto_operation_outbox:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-operation-reconciler.ts##failDeviceAdmission:raw_sql:update:public.crypto_delivery_operations:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-operation-reconciler.ts##failDeviceAdmission:raw_sql:update:public.crypto_domain_transition_namespaces:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-operation-reconciler.ts##failDeviceAdmission:raw_sql:update:public.crypto_domain_transition_steps:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-operation-reconciler.ts##failDeviceAdmission:raw_sql:update:public.human_crypto_device_challenges:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-operation-reconciler.ts##failDeviceAdmission:raw_sql:update:public.human_crypto_devices:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-operation-reconciler.ts##failHumanMembership:raw_sql:insert:public.crypto_operation_outbox:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-operation-reconciler.ts##failHumanMembership:raw_sql:update:public.crypto_delivery_operations:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-operation-reconciler.ts##failHumanMembership:raw_sql:update:public.crypto_human_membership_transitions:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-operation-reconciler.ts##reconcileRevocation:raw_sql:update:public.crypto_delivery_operations:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-operation-reconciler.ts##reconcileRevocation:raw_sql:update:public.crypto_domain_transition_namespaces:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-operation-reconciler.ts##reconcileRevocation:raw_sql:update:public.crypto_domain_transition_steps:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-operation-reconciler.ts##reconcileRevocation:raw_sql:update:public.crypto_domain_transition_steps:2",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-operation-reconciler.ts##reconcileRevocation:raw_sql:update:public.crypto_domain_transition_steps:3",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-operation-reconciler.ts#claim:raw_sql:update:public.crypto_delivery_operations:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-operation-reconciler.ts#heartbeat:raw_sql:update:public.crypto_delivery_operations:1",
  "packages/lattice-bridge/src/server/delivery/postgres-delivery-operation-reconciler.ts#reconcile:raw_sql:update:public.crypto_delivery_operations:1",
  "packages/lattice-bridge/src/server/delivery/postgres-domain-transition-lease-repository.ts#claim:raw_sql:update:public.crypto_domain_transition_steps:1",
  "packages/lattice-bridge/src/server/delivery/postgres-domain-transition-lease-repository.ts#fail:raw_sql:update:public.crypto_domain_transition_steps:1",
  "packages/lattice-bridge/src/server/delivery/postgres-domain-transition-lease-repository.ts#heartbeat:raw_sql:update:public.crypto_domain_transition_steps:1",
  "packages/lattice-bridge/src/server/device/postgres-device-activation-repository.ts#activate:raw_sql:update:public.crypto_domain_transition_namespaces:1",
  "packages/lattice-bridge/src/server/device/postgres-device-activation-repository.ts#activate:raw_sql:update:public.crypto_domain_transition_steps:1",
  "packages/lattice-bridge/src/server/device/postgres-device-join-package-repository.ts#claim:raw_sql:update:public.crypto_device_epoch_operations:1",
  "packages/lattice-bridge/src/server/device/postgres-device-join-package-repository.ts#claim:raw_sql:update:public.human_crypto_device_key_packages:1",
  "packages/lattice-bridge/src/server/device/postgres-device-join-package-repository.ts#claim:raw_sql:update:public.human_crypto_devices:1",
  "packages/lattice-bridge/src/server/device/postgres-device-join-package-repository.ts#publish:raw_sql:insert:public.human_crypto_device_key_packages:1",
  "packages/lattice-bridge/src/server/device/postgres-device-join-package-repository.ts#publish:raw_sql:update:public.crypto_device_epoch_operations:1",
  "packages/lattice-bridge/src/server/device/postgres-device-join-package-repository.ts#publish:raw_sql:update:public.human_crypto_devices:1",
  "packages/lattice-bridge/src/server/device/postgres-device-revocation-finalization-repository.ts#finalize:raw_sql:update:public.crypto_domains:1",
  "packages/lattice-bridge/src/server/device/postgres-device-revocation-finalization-repository.ts#finalize:raw_sql:update:public.namespace_crypto_heads:1",
  "packages/lattice-bridge/src/server/device/postgres-initial-bootstrap-repository.ts#begin:raw_sql:insert:public.crypto_delivery_operations:1",
  "packages/lattice-bridge/src/server/device/postgres-initial-bootstrap-repository.ts#begin:raw_sql:insert:public.human_crypto_custodies:1",
  "packages/lattice-bridge/src/server/device/postgres-initial-bootstrap-repository.ts#begin:raw_sql:insert:public.human_crypto_device_challenges:1",
  "packages/lattice-bridge/src/server/device/postgres-initial-bootstrap-repository.ts#begin:raw_sql:insert:public.human_crypto_devices:1",
  "packages/lattice-bridge/src/server/device/postgres-initial-bootstrap-repository.ts#complete:raw_sql:insert:public.crypto_operation_outbox:1",
  "packages/lattice-bridge/src/server/device/postgres-initial-bootstrap-repository.ts#complete:raw_sql:insert:public.human_crypto_recovery_archives:1",
  "packages/lattice-bridge/src/server/device/postgres-initial-bootstrap-repository.ts#complete:raw_sql:insert:public.human_crypto_recovery_keys:1",
] as const;

/**
 * These raw-SQL callsites are the reviewed, role-isolated implementation of
 * the Wave 7 state machines. They are classified explicitly rather than
 * grandfathered as new database-writer debt.
 */
export const REVIEWED_WAVE_7_DATABASE_WRITER_ENTRIES:
  readonly EncryptionCoverageEntry[] =
  WAVE_7_DATABASE_WRITER_LOCATORS.map((locator) => {
    const repository = locator.split("#")[0]!;
    return protectedEntry({
      locator,
      repository,
      keyFamily: "namespace_human",
    }) satisfies EncryptionCoverageEntry;
  }).map((entry, index) => ({
    ...entry,
    id: `db.wave7.lattice-writer-${String(index + 1).padStart(2, "0")}`,
  }));
