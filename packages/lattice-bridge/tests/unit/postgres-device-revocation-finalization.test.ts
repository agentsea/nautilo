import { describe, expect, test } from "bun:test";
import {
  PostgresDeviceRevocationFinalizationRepository,
} from "../../src/server/device/postgres-device-revocation-finalization-repository.ts";
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresHandle,
} from "../../src/server/index.ts";

class ScriptedConnection implements CryptoPostgresConnection {
  readonly statements: string[] = [];
  readonly parameters: readonly unknown[][] = [];
  readonly #results: unknown[][];

  constructor(results: unknown[][]) {
    this.#results = [...results];
  }

  query<Row>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    (this.parameters as unknown[][]).push([...parameters]);
    return Promise.resolve((this.#results.shift() ?? []) as Row[]);
  }

  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
  ): Promise<Result> {
    return callback(this);
  }
}

const digest = (fill: number) => new Uint8Array(32).fill(fill);

function normalizedSql(statement: string): string {
  return statement.replaceAll('"', "").replace(/\s+/g, " ").trim()
    .toUpperCase();
}

function operation(overrides: Record<string, unknown> = {}) {
  return {
    operation_id: "operation_revoke_alice_phone",
    operation_kind: "device_revoke",
    operation_state: "ready_to_activate",
    operation_human_id: "human_alice",
    operation_target_device_id: "device_alice_phone",
    operation_expected_device_revision: 7,
    operation_fanout_row_count: 2,
    operation_aggregate_payload_bytes: 128,
    operation_failure_code: null,
    operation_audit_ref: null,
    operation_terminal_at: null,
    operation_lease_owner: null,
    operation_lease_expires_at: null,
    epoch_target_device_id: "device_alice_phone",
    epoch_owner_human_id: "human_alice",
    epoch_expected_device_revision: 7,
    target_human_id: "human_alice",
    target_state: "revoked",
    target_revision: 8,
    target_revoked_at: "1970-01-01T00:00:10.000Z",
    next_outbox_sequence: 1,
    ...overrides,
  };
}

function readyDomain(overrides: Record<string, unknown> = {}) {
  return {
    domain_id: "domain_alice_bob",
    step_state: "ready_to_activate",
    failure_code: null,
    expected_epoch: 3,
    target_epoch: 4,
    expected_authorization_revision: 5,
    expected_participant_digest: digest(0x21),
    expected_provider_state_hash: digest(0x31),
    candidate_provider_id: "openmls-v2",
    candidate_provider_state_hash: digest(0x32),
    candidate_roster_bytes: new Uint8Array([0x61]),
    candidate_transition_digest: digest(0x33),
    candidate_target_leaf_index: 2,
    step_lease_owner: null,
    step_lease_expires_at: null,
    current_epoch: 3,
    current_authorization_revision: 5,
    current_participant_digest: digest(0x21),
    current_roster_bytes: new Uint8Array([0x51]),
    provider_id: "openmls-v2",
    provider_epoch: 3,
    provider_state_hash: digest(0x31),
    provider_roster_bytes: new Uint8Array([0x51]),
    domain_writes_paused: true,
    domain_pause_operation_id: "operation_revoke_alice_phone",
    target_mapping_device_id: "device_alice_phone",
    target_mapping_human_id: "human_alice",
    target_mapping_leaf_index: 2,
    target_mapping_joined_epoch: 1,
    target_mapping_removed_epoch: null,
    target_mapping_removed_at: null,
    ...overrides,
  };
}

function failedDomain(overrides: Record<string, unknown> = {}) {
  return {
    domain_id: "domain_alice_charlie",
    step_state: "failed",
    failure_code: "domain_rebootstrap_required",
    expected_epoch: 9,
    target_epoch: 10,
    expected_authorization_revision: 2,
    expected_participant_digest: digest(0x31),
    expected_provider_state_hash: null,
    candidate_provider_id: null,
    candidate_provider_state_hash: null,
    candidate_roster_bytes: null,
    candidate_transition_digest: null,
    candidate_target_leaf_index: null,
    step_lease_owner: null,
    step_lease_expires_at: null,
    current_epoch: 9,
    current_authorization_revision: 2,
    current_participant_digest: digest(0x31),
    current_roster_bytes: new Uint8Array([0x62]),
    provider_id: "openmls-v2",
    provider_epoch: 9,
    provider_state_hash: digest(0x39),
    provider_roster_bytes: new Uint8Array([0x62]),
    domain_writes_paused: true,
    domain_pause_operation_id: "operation_revoke_alice_phone",
    target_mapping_device_id: "device_alice_phone",
    target_mapping_human_id: "human_alice",
    target_mapping_leaf_index: 4,
    target_mapping_joined_epoch: 2,
    target_mapping_removed_epoch: null,
    target_mapping_removed_at: null,
    ...overrides,
  };
}

function preparedNamespace(overrides: Record<string, unknown> = {}) {
  return {
    domain_id: "domain_alice_bob",
    namespace_id: "namespace_room_1",
    namespace_state: "prepared",
    namespace_failure_code: null,
    expected_access_revision: 12,
    expected_binding_hash: digest(0x41),
    candidate_binding_hash: digest(0x42),
    candidate_signed_binding_bytes: new Uint8Array([0x71]),
    candidate_human_keyring_envelope_bytes: new Uint8Array([0x72]),
    candidate_ai_keyring_envelope_bytes: new Uint8Array([0x73]),
    candidate_revision: null,
    persisted_candidate_binding_hash: null,
    candidate_previous_binding_hash: null,
    persisted_candidate_signed_bytes: null,
    persisted_candidate_human_keyring_bytes: null,
    persisted_candidate_ai_keyring_bytes: null,
    ...overrides,
  };
}

function blockedNamespace(overrides: Record<string, unknown> = {}) {
  return {
    domain_id: "domain_alice_charlie",
    namespace_id: "namespace_room_2",
    namespace_state: "pending",
    namespace_failure_code: null,
    expected_access_revision: 17,
    expected_binding_hash: digest(0x51),
    candidate_binding_hash: null,
    candidate_signed_binding_bytes: null,
    candidate_human_keyring_envelope_bytes: null,
    candidate_ai_keyring_envelope_bytes: null,
    candidate_revision: null,
    persisted_candidate_binding_hash: null,
    candidate_previous_binding_hash: null,
    ...overrides,
  };
}

function successfulHead(overrides: Record<string, unknown> = {}) {
  return {
    namespace_id: "namespace_room_1",
    domain_id: "domain_alice_bob",
    domain_epoch: 3,
    access_revision: 12,
    binding_hash: digest(0x41),
    writes_paused: true,
    pause_operation_id: "operation_revoke_alice_phone",
    ...overrides,
  };
}

function blockedHead(overrides: Record<string, unknown> = {}) {
  return {
    namespace_id: "namespace_room_2",
    domain_id: "domain_alice_charlie",
    domain_epoch: 9,
    access_revision: 17,
    binding_hash: digest(0x51),
    writes_paused: true,
    pause_operation_id: "operation_revoke_alice_phone",
    ...overrides,
  };
}

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    message_count: 2,
    acknowledged_count: 2,
    successful_message_count: 2,
    successful_acknowledged_count: 2,
    invalid_message_count: 0,
    aggregate_payload_bytes: 128,
    ...overrides,
  };
}

async function repository(results: unknown[][]) {
  const connection = new ScriptedConnection([
    [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
    ...results,
  ]);
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    connection,
    repository: new PostgresDeviceRevocationFinalizationRepository(handle),
  };
}

const input = {
  operationId: "operation_revoke_alice_phone",
  finalizedAt: 20_000,
  auditRef: "audit_revoke_alice_phone_final",
  outboxId: "outbox_revoke_alice_phone_final",
};

describe("Postgres device-revocation finalization", () => {
  test("rejects a database handle that did not pass the crypto-role probe", () => {
    expect(() =>
      new PostgresDeviceRevocationFinalizationRepository(
        {} as CryptoPostgresHandle,
      )
    ).toThrow("verified");
  });

  test("activates submitted Domains and clears only their exact operation-owned pauses", async () => {
    const setup = await repository([
      [],
      [],
      [operation()],
      [readyDomain()],
      [preparedNamespace()],
      [successfulHead()],
      [delivery()],
      [{ namespace_id: "namespace_room_1" }],
      [{ namespace_id: "namespace_room_1" }],
      [{ namespace_id: "namespace_room_1" }],
      [{ domain_id: "domain_alice_bob" }],
      [{ id: "domain_alice_bob" }],
      [{ device_id: "device_alice_phone" }],
      [{ domain_id: "domain_alice_bob" }],
      [{ namespace_id: "namespace_room_1" }],
      [{ domain_id: "domain_alice_bob" }],
      [{ operation_id: input.operationId }],
      [{ outbox_id: input.outboxId }],
    ]);

    expect(await setup.repository.finalize(input)).toEqual({
      status: "finalized",
      operationState: "active",
      activatedDomainCount: 1,
      blockedDomainCount: 0,
    });

    const sql = normalizedSql(setup.connection.statements.join("\n"));
    expect(sql).toContain("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(sql).toContain("PG_ADVISORY_XACT_LOCK");
    expect(sql).toContain("UPDATE CRYPTO_DOMAIN_TRANSITION_NAMESPACES");
    expect(sql).toContain("UPDATE CRYPTO_DOMAIN_TRANSITION_STEPS");
    expect(sql).toContain("UPDATE NAMESPACE_CRYPTO_HEADS");
    expect(sql).toContain("EXPECTED_ACCESS_REVISION + 1");
    expect(sql).toContain("CANDIDATE_BINDING_HASH");
    expect(sql).toContain("NAMESPACE_CRYPTO_HEADS.PAUSE_OPERATION_ID");
    expect(sql).toContain("UPDATE CRYPTO_DOMAINS");
    expect(sql).toContain("CRYPTO_DOMAIN_TRANSITION_STEPS.TARGET_EPOCH");
    expect(sql).toContain("CRYPTO_DOMAINS.PAUSE_OPERATION_ID");
    expect(sql).toContain("INSERT INTO CRYPTO_OPERATION_OUTBOX");
    expect(sql).toContain("'CRYPTO_DEVICE_REVOCATION_FINALIZED'");
  });

  test("finishes mixed work as failed while retaining every blocked Domain and Namespace pause", async () => {
    const setup = await repository([
      [],
      [],
      [operation()],
      [readyDomain(), failedDomain()],
      [preparedNamespace(), blockedNamespace()],
      [successfulHead(), blockedHead()],
      [delivery({
        acknowledged_count: 1,
        successful_message_count: 1,
        successful_acknowledged_count: 1,
      })],
      [{ namespace_id: "namespace_room_1" }],
      [{ namespace_id: "namespace_room_1" }],
      [{ namespace_id: "namespace_room_1" }],
      [{ namespace_id: "namespace_room_2" }],
      [{ domain_id: "domain_alice_bob" }],
      [{ id: "domain_alice_bob" }],
      [{ device_id: "device_alice_phone" }],
      [{ domain_id: "domain_alice_bob" }],
      [{ namespace_id: "namespace_room_1" }],
      [{ domain_id: "domain_alice_bob" }],
      [{ operation_id: input.operationId }],
      [{ outbox_id: input.outboxId }],
    ]);

    expect(await setup.repository.finalize(input)).toEqual({
      status: "finalized",
      operationState: "failed",
      activatedDomainCount: 1,
      blockedDomainCount: 1,
    });
    const operationUpdate = setup.connection.statements.find((statement) =>
      statement.includes("UPDATE crypto_delivery_operations")
    );
    expect(operationUpdate).toContain("failure_code = $3");
    expect(
      setup.connection.statements.join("\n"),
    ).toContain("'crypto_device_revocation_blocked'");
    const clearingIndexes = setup.connection.statements.flatMap(
      (statement, index) => normalizedSql(statement).startsWith(
        "UPDATE NAMESPACE_CRYPTO_HEADS",
      ) || normalizedSql(statement).startsWith("UPDATE CRYPTO_DOMAINS SET")
        ? [index] : [],
    );
    const clearingParameters = clearingIndexes.flatMap(
      (index) => setup.connection.parameters[index] ?? [],
    );
    expect(clearingParameters).toContain("active");
    expect(clearingParameters).not.toContain("failed");
  });

  test("terminalizes an entirely blocked revocation without advancing any head", async () => {
    const setup = await repository([
      [],
      [],
      [operation({
        operation_fanout_row_count: 0,
        operation_aggregate_payload_bytes: 0,
      })],
      [failedDomain()],
      [blockedNamespace()],
      [blockedHead()],
      [delivery({
        message_count: 0,
        acknowledged_count: 0,
        successful_message_count: 0,
        successful_acknowledged_count: 0,
        aggregate_payload_bytes: 0,
      })],
      [{ namespace_id: "namespace_room_2" }],
      [],
      [],
      [{ operation_id: input.operationId }],
      [{ outbox_id: input.outboxId }],
    ]);

    expect(await setup.repository.finalize(input)).toEqual({
      status: "finalized",
      operationState: "failed",
      activatedDomainCount: 0,
      blockedDomainCount: 1,
    });
    const sql = setup.connection.statements.join("\n");
    expect(sql).not.toContain("UPDATE crypto_domain_provider_heads");
    expect(sql).not.toContain("SET removed_epoch");
    expect(sql).toContain("state = 'failed'");
  });

  test("does not mutate when an exact delivery acknowledgement is missing", async () => {
    const setup = await repository([
      [],
      [],
      [operation()],
      [readyDomain()],
      [preparedNamespace()],
      [successfulHead()],
      [delivery({
        acknowledged_count: 1,
        successful_acknowledged_count: 1,
      })],
    ]);

    expect(await setup.repository.finalize(input)).toEqual({
      status: "not_ready",
    });
    expect(
      setup.connection.statements.some((statement) =>
        statement.trimStart().startsWith("UPDATE ")
        || statement.trimStart().startsWith("INSERT ")
      ),
    ).toBe(false);
  });

  test("rejects a wrong pause owner before changing any terminal state", async () => {
    const setup = await repository([
      [],
      [],
      [operation()],
      [readyDomain()],
      [preparedNamespace()],
      [successfulHead({ pause_operation_id: "operation_someone_else" })],
      [delivery()],
    ]);

    expect(await setup.repository.finalize(input)).toEqual({
      status: "stale_state",
    });
    expect(
      setup.connection.statements.some((statement) =>
        statement.trimStart().startsWith("UPDATE ")
        || statement.trimStart().startsWith("INSERT ")
      ),
    ).toBe(false);
  });

  test("rejects a staged Domain whose leaf mapping was tombstoned early", async () => {
    const setup = await repository([
      [],
      [],
      [operation()],
      [readyDomain({
        target_mapping_removed_epoch: 4,
        target_mapping_removed_at: "1970-01-01T00:00:10.000Z",
      })],
      [preparedNamespace()],
      [successfulHead()],
      [delivery()],
    ]);

    expect(await setup.repository.finalize(input)).toEqual({
      status: "stale_state",
    });
    expect(
      setup.connection.statements.some((statement) =>
        statement.trimStart().startsWith("UPDATE ")
        || statement.trimStart().startsWith("INSERT ")
      ),
    ).toBe(false);
  });

  test("validates an exact terminal replay after delivery pruning while checking a retained outbox", async () => {
    const payload = new TextEncoder().encode(JSON.stringify({
      formatVersion: 1,
      eventType: "crypto_device_revocation_blocked",
      operationId: input.operationId,
      targetDeviceId: "device_alice_phone",
      activatedDomainCount: 1,
      blockedDomainCount: 1,
    }));
    const setup = await repository([
      [],
      [],
      [operation({
        operation_state: "failed",
        operation_failure_code: "domain_rebootstrap_required",
        operation_audit_ref: input.auditRef,
        operation_terminal_at: "1970-01-01T00:00:20.000Z",
      })],
      [
        readyDomain({
          step_state: "active",
          current_epoch: 4,
          current_roster_bytes: new Uint8Array([0x61]),
          provider_epoch: 4,
          provider_state_hash: digest(0x32),
          provider_roster_bytes: new Uint8Array([0x61]),
          domain_writes_paused: false,
          domain_pause_operation_id: null,
          target_mapping_removed_epoch: 4,
          target_mapping_removed_at: "1970-01-01T00:00:20.000Z",
        }),
        failedDomain(),
      ],
      [
        preparedNamespace({
          namespace_state: "active",
          candidate_revision: 13,
          persisted_candidate_binding_hash: digest(0x42),
          candidate_previous_binding_hash: digest(0x41),
          persisted_candidate_signed_bytes: new Uint8Array([0x71]),
          persisted_candidate_human_keyring_bytes: new Uint8Array([0x72]),
          persisted_candidate_ai_keyring_bytes: new Uint8Array([0x73]),
        }),
        blockedNamespace({
          namespace_state: "failed",
          namespace_failure_code: "domain_rebootstrap_required",
        }),
      ],
      [
        successfulHead({
          domain_epoch: 4,
          access_revision: 13,
          binding_hash: digest(0x42),
          writes_paused: false,
          pause_operation_id: null,
        }),
        blockedHead(),
      ],
      [delivery({
        message_count: 0,
        acknowledged_count: 0,
        successful_message_count: 0,
        successful_acknowledged_count: 0,
        aggregate_payload_bytes: 0,
      })],
      [{
        outbox_id: input.outboxId,
        event_type: "crypto_device_revocation_blocked",
        payload_bytes: payload,
        idempotency_key: input.outboxId,
      }],
    ]);

    expect(await setup.repository.finalize(input)).toEqual({
      status: "duplicate",
      operationState: "failed",
      activatedDomainCount: 1,
      blockedDomainCount: 1,
    });
    expect(
      setup.connection.statements.some((statement) =>
        statement.trimStart().startsWith("UPDATE ")
        || statement.trimStart().startsWith("INSERT ")
      ),
    ).toBe(false);
  });
});
