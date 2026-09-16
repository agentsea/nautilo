import { describe, expect, test } from "bun:test";
import {
  createHumanMembershipTransition,
  type HumanMembershipTransition,
} from "../../src/index.ts";
import {
  PostgresHumanMembershipAdmissionRepository,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresHandle,
} from "../../src/server/index.ts";

type Query = Readonly<{
  statement: string;
  parameters: readonly unknown[];
}>;

class ScriptedCryptoConnection implements CryptoPostgresConnection {
  readonly queries: Query[] = [];
  transactionCount = 0;
  readonly #results: unknown[][];

  constructor(results: unknown[][]) {
    this.#results = [...results];
  }

  query<Row>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.queries.push({ statement, parameters });
    if (
      parameters.some(
        (value) =>
          typeof value === "string"
          && value.startsWith("crypto-human-operation-capacity/"),
      )
      || statement.includes(
        "LEFT JOIN crypto_human_membership_transitions membership",
      )
    ) {
      return Promise.resolve([]);
    }
    return Promise.resolve((this.#results.shift() ?? []) as Row[]);
  }

  async transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
  ): Promise<Result> {
    this.transactionCount += 1;
    return callback(this);
  }
}

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CHARLIE = "33333333-3333-4333-8333-333333333333";
const ROOM = "44444444-4444-4444-8444-444444444444";
const NAMESPACE = "55555555-5555-4555-8555-555555555555";

function transition(
  overrides: Partial<Parameters<typeof createHumanMembershipTransition>[0]> =
    {},
): HumanMembershipTransition {
  return createHumanMembershipTransition({
    operationId: "membership_operation_1",
    idempotencyKey: "membership/request-1",
    kind: "human_add",
    roomId: ROOM,
    namespaceId: NAMESPACE,
    targetHumanActorId: CHARLIE,
    oldParticipants: [ALICE, BOB],
    newParticipants: [ALICE, BOB, CHARLIE],
    oldDomainId: "domain_alice_bob",
    targetDomainId: "domain_alice_bob_charlie",
    targetRoomRole: "member",
    expectedAccessRevision: 7,
    expectedBindingHash: new Uint8Array(32).fill(0x31),
    bootstrapDeviceId: "device_charlie_browser",
    ...overrides,
  });
}

function authoritativeState(
  value: HumanMembershipTransition,
  overrides: Record<string, unknown> = {},
) {
  return {
    actor_kind: "user",
    head_namespace_id: value.namespaceId,
    head_access_revision: value.expectedAccessRevision,
    head_binding_hash: value.expectedBindingHash,
    head_domain_id: value.oldDomainId,
    head_domain_epoch: 4,
    head_writes_paused: false,
    head_pause_operation_id: null,
    old_participants: value.oldParticipants,
    old_participant_digest: value.oldParticipantDigest,
    old_writes_paused: false,
    bootstrap_device_id: value.bootstrapDeviceId,
    bootstrap_device_state: value.bootstrapDeviceId === null ? null : "active",
    bootstrap_human_id: value.bootstrapDeviceId === null
      ? null
      : "human_charlie",
    bootstrap_human_actor_id: value.bootstrapDeviceId === null
      ? null
      : value.targetHumanActorId,
    custody_human_id: value.kind === "human_remove"
      ? "human_removed"
      : value.bootstrapDeviceId === null
      ? null
      : "human_charlie",
    custody_state: value.bootstrapDeviceId === null ? null : "active",
    current_recovery_generation: value.bootstrapDeviceId === null ? null : 1,
    recovery_key_state: value.bootstrapDeviceId === null ? null : "current",
    ...overrides,
  };
}

function targetState(value: HumanMembershipTransition) {
  return {
    id: value.targetDomainId,
    participants: value.newParticipants,
    participant_digest: value.newParticipantDigest,
    epoch: 9,
    writes_paused: false,
  };
}

function priorState(
  value: HumanMembershipTransition,
  state: string,
) {
  return {
    operation_id: value.operationId,
    idempotency_key: value.idempotencyKey,
    kind: value.kind,
    state,
    namespace_id: value.namespaceId,
    room_id: value.roomId,
    target_human_actor_id: value.targetHumanActorId,
    admitted_bootstrap_device_id: value.bootstrapDeviceId,
    old_participants: value.oldParticipants,
    old_participant_digest: value.oldParticipantDigest,
    new_participants: value.newParticipants,
    new_participant_digest: value.newParticipantDigest,
    old_domain_id: value.oldDomainId,
    admitted_target_domain_id: value.targetDomainId,
    target_room_role: value.targetRoomRole,
    expected_access_revision: value.expectedAccessRevision,
    expected_binding_hash: value.expectedBindingHash,
  };
}

async function repositoryWithResults(results: unknown[][]) {
  const connection = new ScriptedCryptoConnection([
    [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
    ...results,
  ]);
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    connection,
    repository: new PostgresHumanMembershipAdmissionRepository(handle),
  };
}

describe("Postgres Human membership admission", () => {
  test("rejects unverified transitions and database handles before mutation", async () => {
    const forgedHandle = new ScriptedCryptoConnection(
      [],
    ) as unknown as CryptoPostgresHandle;
    expect(() => new PostgresHumanMembershipAdmissionRepository(forgedHandle))
      .toThrow("verified nautilo_crypto handle");

    const setup = await repositoryWithResults([]);
    expect(() =>
      setup.repository.admit(structuredClone(transition()), 1_000)
    ).toThrow("not verified");
    expect(setup.connection.transactionCount).toBe(0);
  });

  test("admits a ready Human add without pausing current writes", async () => {
    const value = transition();
    const setup = await repositoryWithResults([
      [],
      [],
      [],
      [],
      [authoritativeState(value)],
      [targetState(value)],
      [{ operation_id: value.operationId }],
      [{ operation_id: value.operationId }],
      [{ outbox_id: "outbox" }],
    ]);

    expect(await setup.repository.admit(value, 1_000)).toEqual({
      status: "admitted",
      state: "awaiting_committer",
    });
    const sql = setup.connection.queries.map((query) => query.statement)
      .join("\n");
    expect(sql).toContain("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(sql).toContain("INSERT INTO crypto_delivery_operations");
    expect(sql).toContain("INSERT INTO crypto_human_membership_transitions");
    expect(sql).toContain("INSERT INTO crypto_operation_outbox");
    expect(sql).not.toContain("SET writes_paused = TRUE");
    const lock = setup.connection.queries.find(({ statement }) =>
      statement.includes("pg_advisory_xact_lock")
    );
    expect(lock?.parameters).toEqual([
      `initial-bootstrap/${value.targetHumanActorId}`,
    ]);
    expect(setup.connection.queries.some(({ statement, parameters }) =>
      statement.includes("pg_advisory_xact_lock")
      && parameters[0] === value.namespaceId
    )).toBe(true);
    expect(
      setup.connection.queries
        .filter(({ statement, parameters }) =>
          statement.includes("pg_advisory_xact_lock")
          && typeof parameters[0] === "string"
          && parameters[0].startsWith(
            "crypto-human-operation-capacity/",
          )
        )
        .map(({ parameters }) => parameters[0]),
    ).toEqual([
      `crypto-human-operation-capacity/${ALICE}`,
      `crypto-human-operation-capacity/${BOB}`,
      `crypto-human-operation-capacity/${CHARLIE}`,
    ]);
  });

  test("keeps an uninitialized invite pending and a removal durably paused", async () => {
    const pending = transition({
      targetDomainId: null,
      bootstrapDeviceId: null,
    });
    const pendingSetup = await repositoryWithResults([
      [],
      [],
      [],
      [],
      [authoritativeState(pending)],
      [{ operation_id: pending.operationId }],
      [{ operation_id: pending.operationId }],
      [{ outbox_id: "outbox" }],
    ]);
    expect(await pendingSetup.repository.admit(pending, 1_000)).toEqual({
      status: "admitted",
      state: "awaiting_target_device",
    });

    const preparing = transition({
      operationId: "membership_operation_preparing",
      idempotencyKey: "membership/request-preparing",
      targetDomainId: null,
    });
    const preparingSetup = await repositoryWithResults([
      [],
      [],
      [],
      [],
      [authoritativeState(preparing)],
      [{ operation_id: preparing.operationId }],
      [{ operation_id: preparing.operationId }],
      [{ outbox_id: "outbox" }],
    ]);
    expect(await preparingSetup.repository.admit(preparing, 1_500)).toEqual({
      status: "admitted",
      state: "preparing_domain",
    });

    const removal = transition({
      operationId: "membership_operation_2",
      idempotencyKey: "membership/request-2",
      kind: "human_remove",
      targetHumanActorId: BOB,
      oldParticipants: [ALICE, BOB, CHARLIE],
      newParticipants: [ALICE, CHARLIE],
      oldDomainId: "domain_alice_bob_charlie",
      targetDomainId: "domain_alice_charlie",
      targetRoomRole: null,
      bootstrapDeviceId: null,
    });
    const removalSetup = await repositoryWithResults([
      [],
      [],
      [],
      [],
      [authoritativeState(removal)],
      [targetState(removal)],
      [{ operation_id: removal.operationId }],
      [{ operation_id: removal.operationId }],
      [{ namespace_id: removal.namespaceId }],
      [{ outbox_id: "outbox" }],
    ]);
    expect(await removalSetup.repository.admit(removal, 2_000)).toEqual({
      status: "admitted",
      state: "awaiting_committer",
    });
    const sql = removalSetup.connection.queries
      .map((query) => query.statement).join("\n");
    expect(sql).toContain("SET writes_paused = TRUE");
    expect(sql).toContain("pause_operation_id = $2");
  });

  test("requires an initialized invited Human to select an active device", async () => {
    const pending = transition({
      targetDomainId: null,
      bootstrapDeviceId: null,
    });
    const setup = await repositoryWithResults([
      [],
      [],
      [],
      [],
      [authoritativeState(pending, {
        custody_human_id: CHARLIE,
        custody_state: "active",
        current_recovery_generation: 1,
        recovery_key_state: "current",
      })],
    ]);

    expect(await setup.repository.admit(pending, 1_000)).toEqual({
      status: "stale_state",
    });
    expect(setup.connection.queries.some(({ statement }) =>
      statement.includes("INSERT INTO crypto_delivery_operations")
    )).toBe(false);
  });

  test("rejects stale Human sets and head coordinates before inserting", async () => {
    const value = transition();
    const setup = await repositoryWithResults([
      [],
      [],
      [],
      [],
      [authoritativeState(value, {
        head_access_revision: value.expectedAccessRevision + 1,
      })],
    ]);
    expect(await setup.repository.admit(value, 1_000)).toEqual({
      status: "stale_state",
    });
    expect(setup.connection.queries.some((query) =>
      query.statement.includes("INSERT INTO")
    )).toBe(false);
  });

  test("recognizes an exact idempotent replay after the operation progresses", async () => {
    const value = transition();
    const setup = await repositoryWithResults([
      [],
      [],
      [],
      [priorState(value, "active")],
    ]);

    expect(await setup.repository.admit(value, 1_000)).toEqual({
      status: "duplicate",
      state: "active",
    });
    expect(setup.connection.queries.some((query) =>
      query.statement.includes("INSERT INTO")
    )).toBe(false);

    const mismatchedSetup = await repositoryWithResults([
      [],
      [],
      [],
      [{
        ...priorState(value, "active"),
        target_room_role: "admin",
      }],
    ]);
    expect(await mismatchedSetup.repository.admit(value, 1_000)).toEqual({
      status: "conflicting_state",
    });
  });
});
