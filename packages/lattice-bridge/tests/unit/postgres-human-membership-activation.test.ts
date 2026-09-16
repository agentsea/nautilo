import { describe, expect, test } from "bun:test";
import {
  PostgresHumanMembershipActivationRepository,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresHandle,
} from "../../src/server/index.ts";
import {
  COMMITTER_DEVICE,
  COMMITTER_HUMAN,
  createHumanMembershipRebindFixture,
  OPERATION,
  SOURCE_DOMAIN,
  TARGET_ADD_DOMAIN,
  TARGET_REMOVE_DOMAIN,
} from "./human-membership-rebind-fixture.ts";

type Query = Readonly<{
  statement: string;
  parameters: readonly unknown[];
}>;

class MembershipActivationConnection implements CryptoPostgresConnection {
  readonly queries: Query[] = [];

  constructor(
    private readonly respond: (
      statement: string,
      parameters: readonly unknown[],
    ) => readonly Record<string, unknown>[],
  ) {}

  query<Row>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.queries.push({ statement, parameters });
    return Promise.resolve(this.respond(statement, parameters) as Row[]);
  }

  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
  ): Promise<Result> {
    return callback(this);
  }
}

function authoritativeState(
  fixture: ReturnType<typeof createHumanMembershipRebindFixture>,
  overrides: Record<string, unknown> = {},
) {
  const kind = fixture.submission.kind;
  const targetDomainId = kind === "human_add"
    ? TARGET_ADD_DOMAIN
    : TARGET_REMOVE_DOMAIN;
  const bootstrapDeviceId = kind === "human_add"
    ? "device_charlie_browser"
    : null;
  const requiredDeviceId = bootstrapDeviceId ?? COMMITTER_DEVICE;
  const targetHumanActorId = "33333333-3333-4333-8333-333333333333";
  return {
    operation_id: OPERATION,
    kind,
    state: "ready_to_activate",
    fanout_row_count: 3,
    aggregate_payload_bytes: 192,
    failure_code: null,
    audit_ref: null,
    terminal_at: null,
    lease_owner: null,
    lease_expires_at: null,
    deadline_live: true,
    namespace_id: fixture.prepared.expectedHead.namespaceId,
    room_id: "room_1",
    target_human_actor_id: targetHumanActorId,
    bootstrap_device_id: bootstrapDeviceId,
    old_participants: [COMMITTER_HUMAN, "human_bob"],
    old_participant_digest: fixture.submission.oldParticipantDigest,
    new_participants: kind === "human_add"
      ? [COMMITTER_HUMAN, "human_bob", "human_charlie"]
      : [COMMITTER_HUMAN, "human_charlie"],
    new_participant_digest: fixture.submission.newParticipantDigest,
    old_domain_id: SOURCE_DOMAIN,
    target_domain_id: targetDomainId,
    expected_access_revision: fixture.prepared.expectedHead.accessRevision,
    expected_binding_hash: fixture.prepared.expectedHead.bindingHash,
    committer_device_id: COMMITTER_DEVICE,
    target_domain_epoch: fixture.prepared.nextHead.domainEpoch,
    candidate_binding_hash: fixture.submission.candidate.binding.bindingHash,
    candidate_digest: fixture.submission.candidateDigest,
    candidate_signed_binding_bytes:
      fixture.submission.candidate.binding.signedBindingBytes,
    candidate_human_keyring_envelope_bytes:
      fixture.submission.candidate.binding.humanKeyringEnvelopeBytes,
    candidate_ai_keyring_envelope_bytes:
      fixture.submission.candidate.binding.aiKeyringEnvelopeBytes,
    candidate_submitted_at: "1970-01-01T00:00:30.000Z",
    activated_at: null,
    released_at: null,
    head_access_revision: fixture.prepared.expectedHead.accessRevision,
    head_binding_hash: fixture.prepared.expectedHead.bindingHash,
    head_domain_id: SOURCE_DOMAIN,
    head_domain_epoch: 4,
    head_writes_paused: kind === "human_remove",
    head_pause_operation_id: kind === "human_remove" ? OPERATION : null,
    source_participants: [COMMITTER_HUMAN, "human_bob"],
    source_participant_digest: fixture.submission.oldParticipantDigest,
    source_epoch: 4,
    target_participants: kind === "human_add"
      ? [COMMITTER_HUMAN, "human_bob", "human_charlie"]
      : [COMMITTER_HUMAN, "human_charlie"],
    target_participant_digest: fixture.submission.newParticipantDigest,
    target_epoch: fixture.prepared.nextHead.domainEpoch,
    target_writes_paused: false,
    target_provider_epoch: fixture.prepared.nextHead.domainEpoch,
    committer_human_id: COMMITTER_HUMAN,
    device_state: "active",
    signing_public_key: fixture.signing.publicKey,
    source_mapping_human_id: COMMITTER_HUMAN,
    source_mapping_joined_epoch: 1,
    source_mapping_removed_epoch: null,
    source_mapping_removed_at: null,
    target_mapping_human_id: COMMITTER_HUMAN,
    target_mapping_joined_epoch: 1,
    target_mapping_removed_epoch: null,
    target_mapping_removed_at: null,
    required_device_id: requiredDeviceId,
    required_device_human_id: kind === "human_add"
      ? "human_charlie"
      : COMMITTER_HUMAN,
    required_device_human_actor_id: kind === "human_add"
      ? targetHumanActorId
      : "11111111-1111-4111-8111-111111111111",
    required_device_state: "active",
    required_mapping_human_id: kind === "human_add"
      ? "human_charlie"
      : COMMITTER_HUMAN,
    required_mapping_joined_epoch: 1,
    required_mapping_removed_epoch: null,
    required_mapping_removed_at: null,
    message_count: 3,
    message_payload_bytes: 192,
    required_message_count: 1,
    required_acknowledged_count: 1,
    next_outbox_sequence: 3,
    ...overrides,
  };
}

function canonicalBinding(
  fixture: ReturnType<typeof createHumanMembershipRebindFixture>,
  overrides: Record<string, unknown> = {},
) {
  const binding = fixture.submission.candidate.binding;
  return {
    persisted_namespace_id: binding.namespaceId,
    persisted_revision: binding.revision,
    persisted_binding_hash: binding.bindingHash,
    persisted_previous_binding_hash: binding.previousBindingHash,
    persisted_signed_binding_bytes: binding.signedBindingBytes,
    persisted_human_keyring_envelope_bytes:
      binding.humanKeyringEnvelopeBytes,
    persisted_ai_keyring_envelope_bytes: binding.aiKeyringEnvelopeBytes,
    ...overrides,
  };
}

function committedPayload(
  fixture: ReturnType<typeof createHumanMembershipRebindFixture>,
) {
  return new TextEncoder().encode(JSON.stringify({
    formatVersion: 1,
    eventType: "crypto_human_membership_committed",
    operationId: OPERATION,
    kind: fixture.submission.kind,
    roomId: "room_1",
    namespaceId: fixture.prepared.expectedHead.namespaceId,
    targetDomainId: fixture.submission.kind === "human_add"
      ? TARGET_ADD_DOMAIN
      : TARGET_REMOVE_DOMAIN,
    accessRevision: fixture.prepared.nextHead.accessRevision,
  }));
}

const input = {
  operationId: OPERATION,
  activatedAt: 40_000,
  auditRef: "audit_membership_committed",
  outboxId: "outbox_membership_committed",
} as const;

async function harness(options: {
  readonly kind?: "human_add" | "human_remove";
  readonly state?: Record<string, unknown>;
  readonly persisted?: readonly Record<string, unknown>[];
  readonly outbox?: readonly Record<string, unknown>[];
} = {}) {
  const fixture = createHumanMembershipRebindFixture(
    options.kind ?? "human_add",
  );
  const connection = new MembershipActivationConnection((statement) => {
    const normalized = statement.replaceAll('"', "").toLowerCase();
    if (statement.includes("SELECT current_user::text")) {
      return [{
        current_user: "nautilo_crypto",
        session_user: "nautilo_crypto",
      }];
    }
    if (
      normalized.trim().startsWith("select namespace_id")
      && normalized.includes("from crypto_human_membership_transitions")
    ) {
      return [{ namespace_id: fixture.prepared.expectedHead.namespaceId }];
    }
    if (statement.includes("FROM crypto_delivery_operations o")) {
      return [authoritativeState(fixture, options.state)];
    }
    if (normalized.includes("from namespace_crypto_bindings")) {
      return options.persisted ?? [];
    }
    if (
      normalized.includes("from crypto_operation_outbox")
      && normalized.includes("event_type =")
    ) {
      return options.outbox ?? [];
    }
    if (normalized.includes("returning")) return [{ applied: true }];
    return [];
  });
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    connection,
    fixture,
    repository: new PostgresHumanMembershipActivationRepository({
      handle,
      crypto: fixture.crypto,
    }),
  };
}

describe("Postgres Human membership activation", () => {
  test("rejects a database handle that did not pass the crypto-role probe", () => {
    const fixture = createHumanMembershipRebindFixture();
    expect(() =>
      new PostgresHumanMembershipActivationRepository({
        handle: {} as CryptoPostgresHandle,
        crypto: fixture.crypto,
      })
    ).toThrow("verified");
  });

  test("activates Human-add only after every bootstrap-device chunk is acknowledged", async () => {
    const setup = await harness();

    expect(await setup.repository.activate(input)).toEqual({
      status: "activated",
      kind: "human_add",
      namespaceId: setup.fixture.prepared.expectedHead.namespaceId,
      accessRevision: setup.fixture.prepared.nextHead.accessRevision,
    });

    const sql = setup.connection.queries.map(({ statement }) => statement)
      .join("\n");
    const lock = setup.connection.queries.find(({ statement }) =>
      statement.includes("pg_advisory_xact_lock")
    );
    expect(lock?.parameters).toEqual([
      String(setup.fixture.prepared.expectedHead.namespaceId),
    ]);
    expect(sql).toContain(
      "WHEN o.kind = 'human_add' THEN h.bootstrap_device_id",
    );
    expect(sql).toContain("required_acknowledged_count");
    expect(sql).toContain("INSERT INTO namespace_crypto_bindings");
    expect(sql).toContain("UPDATE namespace_crypto_heads");
    expect(sql).toContain("writes_paused = false");
    expect(sql).toContain("UPDATE crypto_human_membership_transitions");
    expect(sql).toContain("activated_at = $2::timestamptz");
    expect(sql).toContain("'crypto_human_membership_committed'");
  });

  test("uses the Human-remove committer ACK and clears only its exact pause", async () => {
    const setup = await harness({ kind: "human_remove" });

    expect(await setup.repository.activate(input)).toEqual({
      status: "activated",
      kind: "human_remove",
      namespaceId: setup.fixture.prepared.expectedHead.namespaceId,
      accessRevision: setup.fixture.prepared.nextHead.accessRevision,
    });

    const headUpdate = setup.connection.queries.find(({ statement }) =>
      statement.includes("UPDATE namespace_crypto_heads")
    );
    expect(headUpdate?.statement).toContain("writes_paused = true");
    expect(headUpdate?.statement).toContain("pause_operation_id = $9");
    expect(headUpdate?.parameters[8]).toBe(OPERATION);
    const stateQuery = setup.connection.queries.find(({ statement }) =>
      statement.includes("required_acknowledged_count")
    );
    expect(stateQuery?.statement).toContain("ELSE h.committer_device_id");
  });

  test("does not publish while a mandatory-device chunk remains unacknowledged", async () => {
    const setup = await harness({
      state: {
        required_message_count: 2,
        required_acknowledged_count: 1,
      },
    });

    expect(await setup.repository.activate(input)).toEqual({
      status: "not_ready",
    });
    expect(setup.connection.queries.some(({ statement }) =>
      statement.includes("INSERT INTO namespace_crypto_bindings")
    )).toBe(false);
  });

  test("does not activate at or after the operation deadline", async () => {
    const setup = await harness({ state: { deadline_live: false } });

    expect(await setup.repository.activate(input)).toEqual({
      status: "not_ready",
    });
    expect(setup.connection.queries.some(({ statement }) =>
      statement.includes("INSERT INTO namespace_crypto_bindings")
    )).toBe(false);
  });

  test("rejects a staged candidate whose authoritative digest no longer verifies", async () => {
    const setup = await harness({
      state: { candidate_digest: new Uint8Array(32).fill(0xff) },
    });

    expect(await setup.repository.activate(input)).toEqual({
      status: "stale_state",
    });
    expect(setup.connection.queries.some(({ statement }) =>
      statement.includes("INSERT INTO namespace_crypto_bindings")
    )).toBe(false);
  });

  test("rejects an unexpected canonical binding before the activation CAS", async () => {
    const fixture = createHumanMembershipRebindFixture();
    const setup = await harness({
      persisted: [canonicalBinding(fixture)],
    });

    expect(await setup.repository.activate(input)).toEqual({
      status: "stale_state",
    });
    expect(setup.connection.queries.some(({ statement }) =>
      statement.includes("INSERT INTO namespace_crypto_bindings")
    )).toBe(false);
  });

  test("accepts active replay only when binding, head, audit, and outbox are exact", async () => {
    const fixture = createHumanMembershipRebindFixture();
    const replayState = {
      state: "active",
      audit_ref: input.auditRef,
      terminal_at: "1970-01-01T00:00:40.000Z",
      activated_at: "1970-01-01T00:00:40.000Z",
      released_at: "1970-01-01T00:00:40.000Z",
      head_access_revision: fixture.prepared.nextHead.accessRevision,
      head_binding_hash: fixture.submission.candidate.binding.bindingHash,
      head_domain_id: TARGET_ADD_DOMAIN,
      head_domain_epoch: fixture.prepared.nextHead.domainEpoch,
      head_writes_paused: false,
      head_pause_operation_id: null,
    };
    const exactOutbox = {
      outbox_id: input.outboxId,
      event_type: "crypto_human_membership_committed",
      payload_bytes: committedPayload(fixture),
      idempotency_key: input.outboxId,
    };
    const exact = await harness({
      state: replayState,
      persisted: [canonicalBinding(fixture)],
      outbox: [exactOutbox],
    });
    expect(await exact.repository.activate(input)).toEqual({
      status: "duplicate",
      kind: "human_add",
      namespaceId: fixture.prepared.expectedHead.namespaceId,
      accessRevision: fixture.prepared.nextHead.accessRevision,
    });
    expect(exact.connection.queries.some(({ statement }) =>
      statement.includes("UPDATE namespace_crypto_heads")
    )).toBe(false);

    const corrupted = await harness({
      state: replayState,
      persisted: [canonicalBinding(fixture)],
      outbox: [{
        ...exactOutbox,
        payload_bytes: new Uint8Array([0x00]),
      }],
    });
    expect(await corrupted.repository.activate(input)).toEqual({
      status: "stale_state",
    });
  });
});
