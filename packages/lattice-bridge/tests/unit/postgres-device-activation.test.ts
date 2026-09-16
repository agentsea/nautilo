import { describe, expect, test } from "bun:test";
import {
  PostgresDeviceActivationRepository,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
} from "../../src/server/index.ts";

class ScriptedConnection implements CryptoPostgresConnection {
  readonly statements: string[] = [];
  readonly #results: unknown[][];
  constructor(results: unknown[][]) {
    this.#results = [...results];
  }
  query<Row>(
    statement: string,
    _parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    return Promise.resolve((this.#results.shift() ?? []) as Row[]);
  }
  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
  ): Promise<Result> {
    return callback(this);
  }
}

function readyState(overrides: Record<string, unknown> = {}) {
  return {
    operation_id: "operation_device_add",
    operation_kind: "device_add",
    operation_state: "ready_to_activate",
    human_id: "human_alice",
    target_device_id: "device_alice_pending",
    expected_custody_revision: 4,
    expected_recovery_generation: 2,
    expected_device_revision: 3,
    expected_inventory_revision: 8,
    expected_inventory_count: 1,
    expected_inventory_digest: new Uint8Array(32).fill(0x31),
    device_state: "pending",
    device_revision: 3,
    custody_state: "active",
    custody_revision: 4,
    custody_recovery_generation: 2,
    custody_inventory_revision: 8,
    custody_inventory_count: 1,
    custody_inventory_digest: new Uint8Array(32).fill(0x31),
    challenge_id: "challenge_device_add",
    challenge_consumed_at: null,
    challenge_invalidated_at: null,
    audit_ref: null,
    receipt_audit_ref: null,
    challenge_expires_at_ms: 10_000,
    domain_required_count: 1,
    domain_ready_count: 1,
    namespace_required_count: 2,
    namespace_prepared_count: 2,
    existing_target_mapping_count: 0,
    delivery_required_count: 2,
    delivery_acknowledged_count: 2,
    active_device_count: 1,
    ...overrides,
  };
}

function readyDomain(overrides: Record<string, unknown> = {}) {
  return {
    domain_id: "domain_alice_bob",
    step_state: "ready_to_activate",
    expected_epoch: 7,
    target_epoch: 8,
    expected_authorization_revision: 11,
    expected_participant_digest: new Uint8Array(32).fill(0x21),
    expected_provider_state_hash: new Uint8Array(32).fill(0x41),
    candidate_provider_id: "openmls-v2",
    candidate_provider_state_hash: new Uint8Array(32).fill(0x42),
    candidate_roster_bytes: new Uint8Array([0x51]),
    candidate_transition_digest: new Uint8Array(32).fill(0x43),
    candidate_target_leaf_index: 2,
    domain_epoch: 7,
    domain_authorization_revision: 11,
    domain_participant_digest: new Uint8Array(32).fill(0x21),
    domain_roster_bytes: new Uint8Array([0x31]),
    domain_writes_paused: false,
    domain_pause_operation_id: null,
    provider_id: "openmls-v2",
    provider_epoch: 7,
    provider_state_hash: new Uint8Array(32).fill(0x41),
    provider_roster_bytes: new Uint8Array([0x31]),
    mapped_device_id: null,
    mapped_human_id: null,
    mapped_leaf_index: null,
    mapped_joined_epoch: null,
    mapped_removed_epoch: null,
    mapped_removed_at_ms: null,
    ...overrides,
  };
}

function preparedNamespace(
  namespaceId: string,
  fill: number,
  overrides: Record<string, unknown> = {},
) {
  const expected = new Uint8Array(32).fill(fill);
  const candidate = new Uint8Array(32).fill(fill + 1);
  return {
    domain_id: "domain_alice_bob",
    namespace_id: namespaceId,
    namespace_state: "prepared",
    expected_access_revision: 3,
    expected_binding_hash: expected,
    candidate_binding_hash: candidate,
    candidate_signed_binding_bytes: new Uint8Array([fill, 0x01]),
    candidate_human_keyring_envelope_bytes: new Uint8Array([fill, 0x02]),
    candidate_ai_keyring_envelope_bytes: new Uint8Array([fill, 0x03]),
    expected_epoch: 7,
    target_epoch: 8,
    head_access_revision: 3,
    head_binding_hash: expected,
    head_domain_id: "domain_alice_bob",
    head_domain_epoch: 7,
    head_writes_paused: false,
    head_pause_operation_id: null,
    candidate_revision: null,
    persisted_candidate_binding_hash: null,
    persisted_candidate_previous_hash: null,
    persisted_candidate_signed_bytes: null,
    persisted_candidate_human_keyring_bytes: null,
    persisted_candidate_ai_keyring_bytes: null,
    ...overrides,
  };
}

function activeDomain(overrides: Record<string, unknown> = {}) {
  return readyDomain({
    step_state: "active",
    domain_epoch: 8,
    domain_roster_bytes: new Uint8Array([0x51]),
    provider_epoch: 8,
    provider_state_hash: new Uint8Array(32).fill(0x42),
    provider_roster_bytes: new Uint8Array([0x51]),
    mapped_device_id: "device_alice_pending",
    mapped_human_id: "human_alice",
    mapped_leaf_index: 2,
    mapped_joined_epoch: 8,
    ...overrides,
  });
}

function activeNamespace(
  namespaceId: string,
  fill: number,
  overrides: Record<string, unknown> = {},
) {
  const candidate = new Uint8Array(32).fill(fill + 1);
  return preparedNamespace(namespaceId, fill, {
    namespace_state: "active",
    candidate_revision: 4,
    head_access_revision: 4,
    head_binding_hash: candidate,
    head_domain_epoch: 8,
    persisted_candidate_binding_hash: candidate,
    persisted_candidate_previous_hash: new Uint8Array(32).fill(fill),
    persisted_candidate_signed_bytes: new Uint8Array([fill, 0x01]),
    persisted_candidate_human_keyring_bytes: new Uint8Array([fill, 0x02]),
    persisted_candidate_ai_keyring_bytes: new Uint8Array([fill, 0x03]),
    ...overrides,
  });
}

async function repository(results: unknown[][]) {
  const connection = new ScriptedConnection([
    [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
    ...results,
  ]);
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    connection,
    repository: new PostgresDeviceActivationRepository(handle),
  };
}

describe("Postgres additional-device activation", () => {
  test("commits a durably approved device after its comparison challenge expires", async () => {
    const setup = await repository([
      [],
      [],
      [readyState()],
      [readyDomain()],
      [
        preparedNamespace("namespace_room_1", 0x61),
        preparedNamespace("namespace_room_2", 0x71),
      ],
      [{ namespace_id: "namespace_room_1" }],
      [{ namespace_id: "namespace_room_2" }],
      [{ namespace_id: "namespace_room_1" }],
      [{ namespace_id: "namespace_room_2" }],
      [{ domain_id: "domain_alice_bob" }],
      [{ id: "domain_alice_bob" }],
      [{ device_id: "device_alice_pending" }],
      [{ namespace_id: "namespace_room_1" }, {
        namespace_id: "namespace_room_2",
      }],
      [{ domain_id: "domain_alice_bob" }],
      [{ device_id: "device_alice_pending" }],
      [{ challenge_id: "challenge_device_add" }],
      [{ operation_id: "operation_device_add" }],
      [{ human_id: "human_alice" }],
      [{ outbox_id: "outbox_device_activation_1" }],
    ]);
    expect(await setup.repository.activate({
      operationId: "operation_device_add",
      activatedAt: 20_000,
      auditRef: "audit_device_activation_1",
      outboxId: "outbox_device_activation_1",
    })).toEqual({
      status: "activated",
      deviceId: "device_alice_pending",
      deviceRevision: 4,
      custodyRevision: 5,
    });
    const sql = setup.connection.statements.join("\n");
    const normalizedSql = sql.replaceAll('"', "").toLowerCase();
    expect(sql).toContain("domain_ready_count");
    expect(sql).toContain("namespace_prepared_count");
    expect(sql).toContain("existing_target_mapping_count");
    expect(sql).toContain("delivery_acknowledged_count");
    expect(sql).toContain("m.kind <> 'recovery_challenge'");
    expect(normalizedSql).toContain(
      "update crypto_domain_transition_namespaces",
    );
    expect(sql).toContain("UPDATE namespace_crypto_heads");
    expect(sql).toContain("UPDATE crypto_domain_provider_heads");
    expect(sql).toContain("UPDATE crypto_domains");
    expect(sql).toContain("INSERT INTO crypto_domain_devices");
    expect(normalizedSql).toContain("update crypto_domain_transition_steps");
    expect(sql).toContain("UPDATE human_crypto_devices");
    expect(sql).toContain("UPDATE human_crypto_device_challenges");
    expect(sql).not.toContain("AND expires_at > $3::timestamptz");
    expect(sql).toContain("UPDATE crypto_delivery_operations");
    expect(sql).toContain("UPDATE human_crypto_custodies");
    expect(sql).toContain("INSERT INTO crypto_operation_outbox");
    expect(sql).toContain("$2 + 2");
  });

  test("activates against the canonical all-null empty Namespace inventory", async () => {
    const setup = await repository([
      [],
      [],
      [readyState({
        expected_inventory_revision: 0,
        expected_inventory_count: 0,
        custody_inventory_revision: null,
        custody_inventory_count: null,
        custody_inventory_digest: null,
      })],
      [readyDomain()],
      [
        preparedNamespace("namespace_room_1", 0x61),
        preparedNamespace("namespace_room_2", 0x71),
      ],
      [{ namespace_id: "namespace_room_1" }],
      [{ namespace_id: "namespace_room_2" }],
      [{ namespace_id: "namespace_room_1" }],
      [{ namespace_id: "namespace_room_2" }],
      [{ domain_id: "domain_alice_bob" }],
      [{ id: "domain_alice_bob" }],
      [{ device_id: "device_alice_pending" }],
      [{ namespace_id: "namespace_room_1" }, {
        namespace_id: "namespace_room_2",
      }],
      [{ domain_id: "domain_alice_bob" }],
      [{ device_id: "device_alice_pending" }],
      [{ challenge_id: "challenge_device_add" }],
      [{ operation_id: "operation_device_add" }],
      [{ human_id: "human_alice" }],
      [{ outbox_id: "outbox_device_activation_empty" }],
    ]);
    expect(await setup.repository.activate({
      operationId: "operation_device_add",
      activatedAt: 20_000,
      auditRef: "audit_device_activation_empty",
      outboxId: "outbox_device_activation_empty",
    })).toEqual({
      status: "activated",
      deviceId: "device_alice_pending",
      deviceRevision: 4,
      custodyRevision: 5,
    });
  });

  test("does not mutate anything when even one delivery is missing", async () => {
    const setup = await repository([
      [],
      [],
      [readyState({ delivery_acknowledged_count: 1 })],
      [readyDomain()],
      [
        preparedNamespace("namespace_room_1", 0x61),
        preparedNamespace("namespace_room_2", 0x71),
      ],
    ]);
    expect(await setup.repository.activate({
      operationId: "operation_device_add",
      activatedAt: 20_000,
      auditRef: "audit_device_activation_1",
      outboxId: "outbox_device_activation_1",
    })).toEqual({ status: "not_ready" });
    expect(
      setup.connection.statements.some((statement) =>
        statement.trimStart().startsWith("UPDATE ")
      ),
    ).toBe(false);
  });

  test("fails closed when a staged provider head was substituted", async () => {
    const setup = await repository([
      [],
      [],
      [readyState()],
      [readyDomain({
        provider_state_hash: new Uint8Array(32).fill(0xff),
      })],
      [
        preparedNamespace("namespace_room_1", 0x61),
        preparedNamespace("namespace_room_2", 0x71),
      ],
    ]);
    expect(await setup.repository.activate({
      operationId: "operation_device_add",
      activatedAt: 20_000,
      auditRef: "audit_device_activation_1",
      outboxId: "outbox_device_activation_1",
    })).toEqual({ status: "stale_state" });
    expect(
      setup.connection.statements.some((statement) =>
        statement.trimStart().startsWith("UPDATE ")
      ),
    ).toBe(false);
  });

  test("surfaces a lost authoritative-head compare-and-swap", async () => {
    const setup = await repository([
      [],
      [],
      [readyState()],
      [readyDomain()],
      [
        preparedNamespace("namespace_room_1", 0x61),
        preparedNamespace("namespace_room_2", 0x71),
      ],
      [],
    ]);
    expect(setup.repository.activate({
      operationId: "operation_device_add",
      activatedAt: 20_000,
      auditRef: "audit_device_activation_1",
      outboxId: "outbox_device_activation_1",
    })).rejects.toThrow("canonical Namespace binding append lost");
  });

  test("accepts only an exact terminal activation replay", async () => {
    const setup = await repository([
      [],
      [],
      [readyState({
        operation_state: "active",
        device_state: "active",
        device_revision: 4,
        custody_revision: 5,
        challenge_consumed_at: "2026-01-01T00:00:00.000Z",
        audit_ref: "audit_device_activation_1",
        receipt_audit_ref: "audit_device_activation_1",
        domain_ready_count: 0,
        namespace_prepared_count: 0,
        existing_target_mapping_count: 1,
      })],
      [activeDomain()],
      [
        activeNamespace("namespace_room_1", 0x61),
        activeNamespace("namespace_room_2", 0x71),
      ],
    ]);
    expect(await setup.repository.activate({
      operationId: "operation_device_add",
      activatedAt: 20_000,
      auditRef: "audit_device_activation_1",
      outboxId: "outbox_device_activation_1",
    })).toEqual({
      status: "duplicate",
      deviceId: "device_alice_pending",
      deviceRevision: 4,
      custodyRevision: 5,
    });
    expect(
      setup.connection.statements.some((statement) =>
        statement.trimStart().startsWith("UPDATE ")
      ),
    ).toBe(false);
  });

  test("recovery activation restores an initialized recovery-required custody to active", async () => {
    const setup = await repository([
      [],
      [],
      [readyState({
        operation_id: "operation_device_recovery",
        operation_kind: "device_recovery",
        custody_state: "recovery_required",
        challenge_id: "challenge_device_recovery",
      })],
      [readyDomain()],
      [
        preparedNamespace("namespace_room_1", 0x61),
        preparedNamespace("namespace_room_2", 0x71),
      ],
      [{ namespace_id: "namespace_room_1" }],
      [{ namespace_id: "namespace_room_2" }],
      [{ namespace_id: "namespace_room_1" }],
      [{ namespace_id: "namespace_room_2" }],
      [{ domain_id: "domain_alice_bob" }],
      [{ id: "domain_alice_bob" }],
      [{ device_id: "device_alice_pending" }],
      [{ namespace_id: "namespace_room_1" }, {
        namespace_id: "namespace_room_2",
      }],
      [{ domain_id: "domain_alice_bob" }],
      [{ device_id: "device_alice_pending" }],
      [{ challenge_id: "challenge_device_recovery" }],
      [{ operation_id: "operation_device_recovery" }],
      [{ human_id: "human_alice" }],
      [{ outbox_id: "outbox_device_recovery_activation_1" }],
    ]);
    expect(await setup.repository.activate({
      operationId: "operation_device_recovery",
      activatedAt: 20_000,
      auditRef: "audit_device_recovery_activation_1",
      outboxId: "outbox_device_recovery_activation_1",
    })).toEqual({
      status: "activated",
      deviceId: "device_alice_pending",
      deviceRevision: 4,
      custodyRevision: 5,
    });
    const custodyUpdate = setup.connection.statements.find((statement) =>
      statement.includes("UPDATE human_crypto_custodies")
    );
    expect(custodyUpdate).toContain("SET state = 'active'");
  });
});
