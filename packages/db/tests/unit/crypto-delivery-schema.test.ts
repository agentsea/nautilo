import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  CRYPTO_DELIVERY_BYTE_LIMITS,
  CRYPTO_DELIVERY_COLLECTION_LIMITS,
  CRYPTO_DELIVERY_TABLE_NAMES,
  CRYPTO_DELIVERY_TABLES,
  CRYPTO_STORAGE_TABLE_NAMES,
  CRYPTO_STORAGE_TABLE_PRIVILEGES,
  CRYPTO_STORAGE_TABLES,
  LATTICE_STORAGE_TABLE_NAMES,
  LATTICE_STORAGE_TABLES,
  cryptoDomains,
  cryptoDeliveryOperations,
  cryptoDeliveryMessages,
  cryptoDeviceEpochOperations,
  cryptoDomainTransitionNamespaces,
  cryptoDomainTransitionSteps,
  cryptoHumanMembershipTransitions,
  humanCryptoCustodies,
  humanCryptoDeviceGroupAcknowledgements,
  humanCryptoDeviceGroupCommits,
  humanCryptoDeviceGroupHeads,
  humanCryptoDeviceGroupJoinRequests,
  humanCryptoDeviceGroupWelcomes,
  humanCryptoDeviceChallenges,
  humanCryptoDeviceKeyPackages,
  humanCryptoDevices,
  namespaceCryptoHeads,
} from "../../src/schema/crypto-storage.ts";

const WAVE_7_TABLE_NAMES = [
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
] as const;

function columnNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function checkNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).checks.map((constraint) => constraint.name);
}

function foreignKeyNames(
  table: Parameters<typeof getTableConfig>[0],
): string[] {
  return getTableConfig(table).foreignKeys.map((constraint) =>
    constraint.getName()
  );
}

function indexNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).indexes
    .map((index) => index.config.name)
    .filter((name): name is string => typeof name === "string");
}

function uniqueNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).uniqueConstraints
    .map((constraint) => constraint.name)
    .filter((name): name is string => typeof name === "string");
}

function expectIncludes(actual: string[], expected: readonly string[]): void {
  for (const value of expected) {
    expect(actual).toContain(value);
  }
}

describe("Wave 7 crypto delivery schema", () => {
  test("preserves the LatticeStorage subset and adds delivery tables", () => {
    expect(LATTICE_STORAGE_TABLE_NAMES).toHaveLength(19);
    expect(LATTICE_STORAGE_TABLES.map(getTableName)).toEqual([
      ...LATTICE_STORAGE_TABLE_NAMES,
    ]);
    expect(CRYPTO_DELIVERY_TABLE_NAMES).toEqual([...WAVE_7_TABLE_NAMES]);
    expect(CRYPTO_DELIVERY_TABLES.map(getTableName)).toEqual(
      [...WAVE_7_TABLE_NAMES],
    );
    expect(CRYPTO_STORAGE_TABLE_NAMES).toEqual([
      ...LATTICE_STORAGE_TABLE_NAMES,
      ...WAVE_7_TABLE_NAMES,
    ]);
    expect(CRYPTO_STORAGE_TABLES).toHaveLength(40);
  });

  test("places write pauses on the canonical Domain and Namespace heads", () => {
    expectIncludes(columnNames(cryptoDomains), [
      "writes_paused",
      "pause_operation_id",
    ]);
    expectIncludes(columnNames(namespaceCryptoHeads), [
      "writes_paused",
      "pause_operation_id",
    ]);
  });

  test("freezes finite admission, payload, lease, retry, and pruning bounds", () => {
    expect(CRYPTO_DELIVERY_BYTE_LIMITS).toEqual({
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
    expect(CRYPTO_DELIVERY_COLLECTION_LIMITS).toEqual({
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
  });

  test("makes custody and device identity durable and monotonic", () => {
    expect(columnNames(humanCryptoCustodies)).toEqual([
      "human_id",
      "user_id",
      "human_actor_id",
      "initial_installation_lineage_digest",
      "state",
      "ever_initialized_at",
      "first_device_id",
      "current_recovery_generation",
      "current_recovery_public_key_digest",
      "current_inventory_revision",
      "current_inventory_count",
      "current_inventory_digest",
      "revision",
      "last_transition_audit_ref",
      "created_at",
      "updated_at",
    ]);
    expectIncludes(columnNames(humanCryptoDevices), [
      "installation_lineage_digest",
      "signing_public_key",
      "encryption_public_key",
      "public_fingerprint",
      "authorization_evidence_digest",
      "membership_state",
      "membership_server_instance_id",
      "membership_lineage_generation",
      "membership_epoch",
      "membership_security_revision",
      "membership_leaf_index",
      "membership_head_digest",
      "membership_acknowledged_sequence",
      "state",
      "delivery_sequence_high_watermark",
      "delivery_acknowledged_sequence",
      "revision",
      "revoked_at",
    ]);
    expectIncludes(checkNames(humanCryptoDevices), [
      "human_crypto_devices_authorization_coherent",
      "human_crypto_devices_lifecycle_coherent",
      "human_crypto_devices_delivery_high_watermark_safe",
      "human_crypto_devices_delivery_acknowledged_safe",
      "human_crypto_devices_delivery_cursor_coherent",
      "human_crypto_devices_delivery_blocked_sequence_safe",
      "human_crypto_devices_delivery_blocked_operation_id_portable",
      "human_crypto_devices_delivery_blocked_reason_portable",
      "human_crypto_devices_delivery_blocked_coherent",
      "human_crypto_devices_membership_state",
      "human_crypto_devices_membership_coherent",
      "human_crypto_devices_time_order",
    ]);
    expectIncludes(checkNames(humanCryptoCustodies), [
      "human_crypto_custodies_inventory_coherent",
      "human_crypto_custodies_inventory_revision_safe",
      "human_crypto_custodies_inventory_digest_size",
    ]);
  });

  test("orders one Human-device MLS head, commit chain, Welcome, and ack", () => {
    expectIncludes(columnNames(humanCryptoDeviceGroupHeads), [
      "server_instance_id",
      "lineage_generation",
      "group_id",
      "epoch",
      "roster_digest",
      "previous_head_digest",
      "head_digest",
      "security_revision",
      "commit_sequence",
      "committing_device_id",
    ]);
    expectIncludes(checkNames(humanCryptoDeviceGroupHeads), [
      "human_crypto_device_group_heads_genesis_coherent",
      "human_crypto_device_group_heads_roster_size",
    ]);
    expectIncludes(columnNames(humanCryptoDeviceGroupCommits), [
      "sequence",
      "operation_id",
      "expected_head_digest",
      "next_head_digest",
      "public_transition_bytes",
      "commit_bytes",
      "welcome_digest",
      "roster_bytes",
    ]);
    expectIncludes(columnNames(humanCryptoDeviceGroupJoinRequests), [
      "operation_id",
      "target_device_id",
      "expected_head_digest",
      "request_bytes",
      "state",
    ]);
    expectIncludes(indexNames(humanCryptoDeviceGroupCommits), [
      "idx_human_crypto_device_group_commits_catch_up",
    ]);
    expectIncludes(columnNames(humanCryptoDeviceGroupWelcomes), [
      "target_device_id",
      "target_device_generation",
      "welcome_digest",
      "welcome_bytes",
      "state",
    ]);
    expectIncludes(columnNames(humanCryptoDeviceGroupAcknowledgements), [
      "device_id",
      "device_generation",
      "acknowledged_sequence",
      "acknowledged_head_digest",
    ]);
    expect(
      CRYPTO_STORAGE_TABLE_PRIVILEGES.human_crypto_device_group_commits,
    ).toEqual(["SELECT", "INSERT", "DELETE"]);
  });

  test("maintains one gap-free durable delivery queue per device", () => {
    expectIncludes(columnNames(humanCryptoDevices), [
      "delivery_blocked_sequence",
      "delivery_blocked_operation_id",
      "delivery_blocked_at",
      "delivery_blocked_reason",
    ]);
    expectIncludes(columnNames(cryptoDeliveryMessages), [
      "domain_sequence",
      "recipient_sequence",
      "recipient_device_id",
    ]);
    expectIncludes(checkNames(cryptoDeliveryMessages), [
      "crypto_delivery_messages_recipient_sequence_positive",
    ]);
    expectIncludes(indexNames(cryptoDeliveryMessages), [
      "idx_crypto_delivery_messages_recipient_expiry",
      "idx_crypto_delivery_messages_global_expiry",
    ]);
    expectIncludes(uniqueNames(cryptoDeliveryMessages), [
      "uq_crypto_delivery_messages_recipient_sequence",
    ]);
    expectIncludes(indexNames(cryptoDeliveryMessages), [
      "uq_crypto_delivery_messages_domain_sequence",
    ]);
  });

  test("binds every challenge value and stores only its hash", () => {
    const columns = columnNames(humanCryptoDeviceChallenges);
    expectIncludes(columns, [
      "challenge_hash",
      "bootstrap_authority_id",
      "authorization_digest",
      "signing_public_key_digest",
      "encryption_public_key_digest",
      "recovery_public_key_digest",
      "expected_response_digest",
      "idempotency_key",
      "issued_at",
      "expires_at",
      "consumed_at",
      "invalidated_at",
    ]);
    expect(columns).not.toContain("challenge");
    expect(columns).not.toContain("challenge_bytes");
    expectIncludes(checkNames(humanCryptoDeviceChallenges), [
      "human_crypto_device_challenges_recovery_coherent",
      "human_crypto_device_challenges_terminal_coherent",
      "human_crypto_device_challenges_terminal_result_coherent",
      "human_crypto_device_challenges_response_digest_coherent",
      "human_crypto_device_challenges_response_digest_size",
      "human_crypto_device_challenges_bootstrap_authority",
      "human_crypto_device_challenges_bootstrap_authority_portable",
    ]);
  });

  test("binds every join request package to one Domain provider head", () => {
    expectIncludes(columnNames(humanCryptoDeviceKeyPackages), [
      "device_id",
      "domain_id",
      "expected_provider_head_hash",
      "generation",
      "package_bytes",
      "consuming_operation_id",
    ]);
    expectIncludes(
      foreignKeyNames(humanCryptoDeviceKeyPackages),
      ["human_crypto_device_key_packages_domain_fk"],
    );
    expectIncludes(checkNames(humanCryptoDeviceKeyPackages), [
      "human_crypto_device_key_packages_provider_head_hash_size",
    ]);
  });

  test("anchors operations and membership transitions to canonical rows", () => {
    expectIncludes(foreignKeyNames(cryptoDeliveryOperations), [
      "crypto_delivery_operations_human_fk",
      "crypto_delivery_operations_target_human_fk",
      "crypto_delivery_operations_target_device_fk",
    ]);
    expectIncludes(foreignKeyNames(cryptoHumanMembershipTransitions), [
      "crypto_human_membership_transitions_target_actor_fk",
      "crypto_human_membership_transitions_admitted_bootstrap_device_fk",
      "crypto_human_membership_transitions_bootstrap_device_fk",
      "crypto_human_membership_transitions_old_domain_fk",
      "crypto_human_membership_transitions_admitted_target_domain_fk",
      "crypto_human_membership_transitions_target_domain_fk",
      "crypto_human_membership_transitions_committer_device_fk",
    ]);
    expectIncludes(columnNames(cryptoHumanMembershipTransitions), [
      "committer_device_id",
      "admitted_bootstrap_device_id",
      "admitted_target_domain_id",
      "target_room_role",
      "target_domain_epoch",
      "candidate_binding_hash",
      "candidate_digest",
      "candidate_signed_binding_bytes",
      "candidate_human_keyring_envelope_bytes",
      "candidate_ai_keyring_envelope_bytes",
      "candidate_submitted_at",
      "activated_at",
      "released_at",
    ]);
    expectIncludes(checkNames(cryptoHumanMembershipTransitions), [
      "crypto_human_membership_transitions_target_epoch_safe",
      "crypto_human_membership_transitions_resolution_coherent",
      "crypto_human_membership_transitions_target_room_role",
      "crypto_human_membership_transitions_candidate_binding_hash_size",
      "crypto_human_membership_transitions_candidate_digest_size",
      "crypto_human_membership_transitions_candidate_signed_size",
      "crypto_human_membership_transitions_candidate_human_keyring_size",
      "crypto_human_membership_transitions_candidate_ai_keyring_size",
      "crypto_human_membership_transitions_candidate_coherent",
      "crypto_human_membership_transitions_terminal_coherent",
    ]);
    expectIncludes(indexNames(cryptoHumanMembershipTransitions), [
      "uq_crypto_human_membership_transitions_live_namespace",
    ]);
  });

  test("persists the exact device activation gate and serializes live work", () => {
    expectIncludes(columnNames(cryptoDeviceEpochOperations), [
      "expected_inventory_revision",
      "expected_inventory_count",
      "expected_inventory_digest",
      "authorization_artifact_hash",
      "recovery_readiness_digest",
    ]);
    expectIncludes(checkNames(cryptoDeviceEpochOperations), [
      "crypto_device_epoch_operations_inventory_revision_safe",
      "crypto_device_epoch_operations_inventory_count",
      "crypto_device_epoch_operations_inventory_digest_size",
      "crypto_device_epoch_operations_artifact_hash_size",
      "crypto_device_epoch_operations_readiness_digest_size",
    ]);
    expectIncludes(indexNames(cryptoDeliveryOperations), [
      "uq_crypto_delivery_operations_live_device_roster",
    ]);
    expectIncludes(indexNames(cryptoDomainTransitionSteps), [
      "uq_crypto_domain_transition_steps_live_domain",
    ]);
    expectIncludes(columnNames(cryptoDomainTransitionSteps), [
      "expected_provider_state_hash",
      "candidate_provider_id",
      "candidate_provider_state_hash",
      "candidate_roster_bytes",
      "candidate_transition_digest",
      "candidate_target_leaf_index",
    ]);
    expectIncludes(checkNames(cryptoDomainTransitionSteps), [
      "crypto_domain_transition_steps_expected_provider_state_hash_size",
      "crypto_domain_transition_steps_candidate_state_hash_size",
      "crypto_domain_transition_steps_candidate_roster_size",
      "crypto_domain_transition_steps_candidate_transition_digest_size",
      "crypto_domain_transition_steps_candidate_leaf_range",
      "crypto_domain_transition_steps_candidate_coherent",
    ]);
    expectIncludes(indexNames(cryptoDomainTransitionNamespaces), [
      "uq_crypto_domain_transition_namespaces_live_namespace",
    ]);
    expectIncludes(columnNames(cryptoDomainTransitionNamespaces), [
      "candidate_binding_hash",
      "candidate_signed_binding_bytes",
      "candidate_human_keyring_envelope_bytes",
      "candidate_ai_keyring_envelope_bytes",
    ]);
    expectIncludes(checkNames(cryptoDomainTransitionNamespaces), [
      "crypto_domain_transition_namespaces_candidate_signed_size",
      "crypto_domain_transition_namespaces_candidate_human_keyring_size",
      "crypto_domain_transition_namespaces_candidate_ai_keyring_size",
      "crypto_domain_transition_namespaces_candidate_coherent",
    ]);
  });

  test("allows terminal Namespace work to fail before a candidate exists", () => {
    const namespaceChecks = checkNames(cryptoDomainTransitionNamespaces);
    expect(namespaceChecks).toContain(
      "crypto_domain_transition_namespaces_candidate_coherent",
    );
  });

  test("keeps immutable history append-only and limits delete to pruning state", () => {
    expect(CRYPTO_STORAGE_TABLE_PRIVILEGES.crypto_delivery_messages).toEqual([
      "SELECT",
      "INSERT",
      "DELETE",
    ]);
    expect(
      CRYPTO_STORAGE_TABLE_PRIVILEGES.crypto_delivery_acknowledgements,
    ).toEqual(["SELECT", "INSERT", "DELETE"]);
    expect(CRYPTO_STORAGE_TABLE_PRIVILEGES.crypto_delivery_operations)
      .toContain("DELETE");
    expect(CRYPTO_STORAGE_TABLE_PRIVILEGES.crypto_domain_transition_steps)
      .toContain("DELETE");
    expect(
      CRYPTO_STORAGE_TABLE_PRIVILEGES.crypto_domain_transition_namespaces,
    ).toContain("DELETE");
    expect(CRYPTO_STORAGE_TABLE_PRIVILEGES.human_crypto_custodies).not
      .toContain("DELETE");
    expect(CRYPTO_STORAGE_TABLE_PRIVILEGES.human_crypto_devices).not
      .toContain("DELETE");
    expect(CRYPTO_STORAGE_TABLE_PRIVILEGES.human_crypto_recovery_keys).not
      .toContain("DELETE");
  });

  test("enables role-scoped RLS on every Wave 7 table", () => {
    for (const table of CRYPTO_DELIVERY_TABLES) {
      const config = getTableConfig(table);
      expect(config.enableRLS, config.name).toBe(true);
      expect(config.policies.length, config.name).toBeGreaterThan(0);
      for (const policy of config.policies) {
        expect(policy.to, `${config.name}.${policy.name}`).toBeDefined();
      }
    }
  });
});
