import { describe, expect, test } from "bun:test";
import {
  PostgresHumanMembershipRebindRepository,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
} from "../../src/server/index.ts";
import {
  COMMITTER_DEVICE,
  COMMITTER_HUMAN,
  createHumanMembershipRebindFixture,
  OPERATION,
  SOURCE_DOMAIN,
  TARGET_ADD_DOMAIN,
} from "./human-membership-rebind-fixture.ts";

type Query = Readonly<{
  statement: string;
  parameters: readonly unknown[];
}>;

class MembershipConnection implements CryptoPostgresConnection {
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
  setup: ReturnType<typeof createHumanMembershipRebindFixture>,
  overrides: Record<string, unknown> = {},
) {
  return {
    operation_id: OPERATION,
    kind: "human_add",
    state: "awaiting_committer",
    fanout_row_count: 0,
    aggregate_payload_bytes: 0,
    lease_owner: null,
    lease_expires_at_ms: null,
    deadline_live: true,
    namespace_id: setup.prepared.expectedHead.namespaceId,
    target_human_actor_id: "33333333-3333-4333-8333-333333333333",
    bootstrap_device_id: "device_charlie_browser",
    old_participants: [COMMITTER_HUMAN, "human_bob"],
    old_participant_digest: setup.submission.oldParticipantDigest,
    new_participants: [COMMITTER_HUMAN, "human_bob", "human_charlie"],
    new_participant_digest: setup.submission.newParticipantDigest,
    old_domain_id: SOURCE_DOMAIN,
    target_domain_id: TARGET_ADD_DOMAIN,
    expected_access_revision:
      setup.prepared.expectedHead.accessRevision,
    expected_binding_hash: setup.prepared.expectedHead.bindingHash,
    committer_device_id: null,
    target_domain_epoch: null,
    candidate_binding_hash: null,
    candidate_digest: null,
    candidate_signed_binding_bytes: null,
    candidate_human_keyring_envelope_bytes: null,
    candidate_ai_keyring_envelope_bytes: null,
    candidate_submitted_at: null,
    activated_at: null,
    released_at: null,
    head_access_revision: setup.prepared.expectedHead.accessRevision,
    head_binding_hash: setup.prepared.expectedHead.bindingHash,
    head_domain_id: SOURCE_DOMAIN,
    head_domain_epoch: 4,
    head_writes_paused: false,
    head_pause_operation_id: null,
    source_participants: [COMMITTER_HUMAN, "human_bob"],
    source_participant_digest: setup.submission.oldParticipantDigest,
    source_epoch: 4,
    target_participants: [COMMITTER_HUMAN, "human_bob", "human_charlie"],
    target_participant_digest: setup.submission.newParticipantDigest,
    target_epoch: setup.prepared.nextHead.domainEpoch,
    target_writes_paused: false,
    target_provider_epoch: setup.prepared.nextHead.domainEpoch,
    device_id: COMMITTER_DEVICE,
    human_id: COMMITTER_HUMAN,
    device_state: "active",
    signing_public_key: setup.signing.publicKey,
    source_mapping_human_id: COMMITTER_HUMAN,
    source_mapping_removed_at: null,
    target_mapping_human_id: COMMITTER_HUMAN,
    target_mapping_removed_at: null,
    ...overrides,
  };
}

async function harness(
  overrides: {
    readonly state?: Record<string, unknown>;
    readonly bootstrapRecoveryState?: string | null;
  } = {},
) {
  const setup = createHumanMembershipRebindFixture();
  const recipients = [
    [COMMITTER_DEVICE, COMMITTER_HUMAN],
    ["device_bob_mobile", "human_bob"],
    ["device_charlie_browser", "human_charlie"],
  ] as const;
  const connection = new MembershipConnection((statement, parameters) => {
    if (statement.includes("SELECT current_user::text")) {
      return [{
        current_user: "nautilo_crypto",
        session_user: "nautilo_crypto",
      }];
    }
    if (statement.includes("FROM crypto_delivery_operations o")) {
      return [authoritativeState(setup, overrides.state)];
    }
    if (statement.includes("FROM crypto_domain_devices map")) {
      return recipients.map(([deviceId, humanId]) => ({
        device_id: deviceId,
        human_id: humanId,
        human_actor_id: humanId === "human_charlie"
          ? "33333333-3333-4333-8333-333333333333"
          : "11111111-1111-4111-8111-111111111111",
        state: "active",
        joined_epoch: 1,
        custody_state: "active",
        current_recovery_generation: 1,
        recovery_key_state: deviceId === "device_charlie_browser"
          ? (overrides.bootstrapRecoveryState ?? "current")
          : "current",
      }));
    }
    if (
      statement.includes(
        "SELECT d.device_id, d.state, d.delivery_sequence_high_watermark",
      )
    ) {
      const deviceIds = parameters[0] as readonly string[];
      return deviceIds.map((deviceId) => ({
        device_id: deviceId,
        state: "active",
        delivery_sequence_high_watermark: 0,
        delivery_acknowledged_sequence: 0,
        delivery_blocked_sequence: null,
        delivery_blocked_operation_id: null,
        delivery_blocked_at: null,
        delivery_blocked_reason: null,
        first_unresolved_expires_at_ms: null,
      }));
    }
    if (statement.includes("RETURNING")) return [{ applied: true }];
    return [];
  });
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    connection,
    repository: new PostgresHumanMembershipRebindRepository({
      handle,
      crypto: setup.crypto,
    }),
    setup,
  };
}

describe("Postgres Human membership rebind staging", () => {
  test("stages a verified candidate without publishing a canonical binding", async () => {
    const setup = await harness();

    expect(await setup.repository.stage({
      submission: setup.setup.submission,
      submittedAt: 40_000,
    })).toEqual({
      status: "staged",
      recipientCount: 3,
      messageCount: 3,
      requiredAcknowledgementDeviceId: "device_charlie_browser",
    });

    const sql = setup.connection.queries.map(({ statement }) => statement)
      .join("\n");
    expect(sql).toContain("deadline_at > $3::timestamptz");
    expect(sql).toContain("candidate_submitted_at = $9::timestamptz");
    expect(sql).toContain("INSERT INTO crypto_delivery_messages");
    expect(sql).not.toContain("INSERT INTO namespace_crypto_bindings");
    expect(sql).not.toContain("UPDATE namespace_crypto_heads");
    const lock = setup.connection.queries.find(({ statement }) =>
      statement.includes("pg_advisory_xact_lock")
    );
    expect(lock?.parameters).toEqual([
      String(setup.setup.prepared.expectedHead.namespaceId),
    ]);
    const messages = setup.connection.queries.filter(({ statement }) =>
      statement.trim().startsWith("INSERT INTO crypto_delivery_messages")
    );
    expect(messages.every(({ parameters }) =>
      parameters[2] === 1 && parameters[3] !== null
    )).toBe(true);
    expect(messages.every(({ statement }) =>
      statement.includes("NULL, NULL, $3")
    )).toBe(true);
  });

  test("rejects an expired operation and a bootstrap without current recovery", async () => {
    const expired = await harness({ state: { deadline_live: false } });
    expect(await expired.repository.stage({
      submission: expired.setup.submission,
      submittedAt: 40_000,
    })).toEqual({ status: "stale_state" });
    expect(expired.connection.queries.some(({ statement }) =>
      statement.includes("INSERT INTO crypto_delivery_messages")
    )).toBe(false);

    const retired = await harness({ bootstrapRecoveryState: "retired" });
    expect(await retired.repository.stage({
      submission: retired.setup.submission,
      submittedAt: 40_000,
    })).toEqual({ status: "stale_state" });
    expect(retired.connection.queries.some(({ statement }) =>
      statement.includes("INSERT INTO crypto_delivery_messages")
    )).toBe(false);
  });
});
