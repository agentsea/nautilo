import { describe, expect, test } from "bun:test";
import {
  createDomainTransitionDelivery,
  MAX_FANOUT_PAYLOAD_BYTES,
  MAX_FANOUT_ROWS_PER_OPERATION,
  verifyNamespaceTransitionSubmission,
  verifyProviderTransitionSubmission,
} from "../../src/index.ts";
import {
  PostgresDomainTransitionSubmissionRepository,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
} from "../../src/server/index.ts";
import { createDomainTransitionFixture } from "./domain-transition-fixture.ts";

class ScriptedConnection implements CryptoPostgresConnection {
  readonly statements: { statement: string; parameters: readonly unknown[] }[] =
    [];

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
    this.statements.push({ statement, parameters });
    return Promise.resolve(this.respond(statement, parameters) as Row[]);
  }

  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
  ): Promise<Result> {
    return callback(this);
  }
}

function stateRows(
  setup: ReturnType<typeof createDomainTransitionFixture>,
  overrides: Record<string, unknown> = {},
) {
  const revocation = setup.operationKind === "device_revoke";
  return [{
    operation_id: setup.operationId,
    operation_kind: setup.operationKind,
    operation_state: "awaiting_committer",
    target_human_id: setup.targetHumanId,
    target_device_id: setup.targetDeviceId,
    operation_fanout_row_count: 1,
    operation_aggregate_payload_bytes: 128,
    step_domain_id: setup.domainId,
    step_state: "awaiting_committer",
    expected_epoch: 7,
    target_epoch: 8,
    expected_authorization_revision: 11,
    expected_participant_digest: setup.expectedParticipantDigest,
    committer_device_id: setup.committerDeviceId,
    expected_provider_state_hash: null,
    candidate_provider_id: null,
    candidate_provider_state_hash: null,
    candidate_roster_bytes: null,
    candidate_transition_digest: null,
    candidate_target_leaf_index: null,
    lease_owner: "worker_a",
    lease_expires_at_ms: 80_000,
    retry_count: 0,
    domain_epoch: 7,
    domain_authorization_revision: 11,
    domain_participant_digest: setup.expectedParticipantDigest,
    domain_participants: ["human_alice", "human_bob"],
    domain_roster_bytes: setup.currentRosterBytes,
    domain_writes_paused: revocation,
    domain_pause_operation_id: revocation ? setup.operationId : null,
    provider_id: setup.currentProviderHead.providerId,
    provider_epoch: setup.currentProviderHead.epoch,
    provider_state_hash: setup.currentProviderHead.stateHash,
    provider_roster_bytes: setup.currentRosterBytes,
    committer_human_id: "human_bob",
    committer_state: "active",
    committer_signing_public_key: setup.committer.publicKey,
    target_state: revocation ? "revoked" : "pending",
    target_human_owner_id: setup.targetHumanId,
    mapped_device_id: revocation ? setup.targetDeviceId : null,
    mapped_human_id: revocation ? setup.targetHumanId : null,
    mapped_leaf_index: revocation ? 0 : null,
    mapped_joined_epoch: revocation ? 1 : null,
    mapped_removed_epoch: null,
    mapped_removed_at_ms: null,
    ...overrides,
  }];
}

function namespaceRows(
  setup: ReturnType<typeof createDomainTransitionFixture>,
  replay = false,
) {
  const revocation = setup.operationKind === "device_revoke";
  const candidate = setup.namespaceSubmission.candidates[0]!;
  return [{
    namespace_id: candidate.expectedHead.namespaceId,
    expected_access_revision: candidate.expectedHead.accessRevision,
    expected_binding_hash: candidate.expectedHead.bindingHash,
    candidate_binding_hash: replay ? candidate.nextHead.bindingHash : null,
    candidate_signed_binding_bytes: replay
      ? candidate.binding.signedBindingBytes
      : null,
    candidate_human_keyring_envelope_bytes: replay
      ? candidate.binding.humanKeyringEnvelopeBytes
      : null,
    candidate_ai_keyring_envelope_bytes: replay
      ? candidate.binding.aiKeyringEnvelopeBytes
      : null,
    namespace_state: replay ? "prepared" : "pending",
    head_access_revision: candidate.expectedHead.accessRevision,
    head_binding_hash: candidate.expectedHead.bindingHash,
    head_domain_id: setup.domainId,
    head_domain_epoch: 7,
    head_writes_paused: revocation,
    head_pause_operation_id: revocation ? setup.operationId : null,
  }];
}

function verifiedDelivery(
  setup: ReturnType<typeof createDomainTransitionFixture>,
) {
  const resolveActiveCommitter = (deviceId: string) =>
    deviceId === setup.committerDeviceId
      ? {
        state: "active" as const,
        humanId: "human_bob",
        signingPublicKey: setup.committer.publicKey,
      }
      : null;
  const provider = verifyProviderTransitionSubmission({
    crypto: setup.crypto,
    submission: setup.providerSubmission,
    expectation: {
      operationId: setup.operationId,
      operationKind: setup.operationKind,
      domainId: setup.domainId,
      targetHumanId: setup.targetHumanId,
      targetDeviceId: setup.targetDeviceId,
      expectedEpoch: 7,
      targetEpoch: 8,
      expectedAuthorizationRevision: 11,
      expectedParticipantDigest: setup.expectedParticipantDigest,
      committerDeviceId: setup.committerDeviceId,
    },
    currentProviderState: {
      head: setup.currentProviderHead,
      rosterBytes: setup.currentRosterBytes,
    },
    resolveActiveCommitter,
  });
  const namespaces = verifyNamespaceTransitionSubmission({
    crypto: setup.crypto,
    submission: setup.namespaceSubmission,
    operationId: setup.operationId,
    domainPlan: setup.domainPlan,
    providerTransitionDigest: provider.transitionDigest,
    resolveActiveCommitter,
  });
  return createDomainTransitionDelivery({
    crypto: setup.crypto,
    providerSubmission: setup.providerSubmission,
    verifiedProvider: provider,
    namespaceSubmission: setup.namespaceSubmission,
    verifiedNamespaces: namespaces,
    now: 40_000,
  });
}

async function repository(
  setup: ReturnType<typeof createDomainTransitionFixture>,
  overrides: {
    readonly state?: Record<string, unknown>;
    readonly operationRows?: number;
    readonly operationBytes?: number;
    readonly replay?: boolean;
    readonly invalidRosterMapping?: boolean;
    readonly namespaceState?: Record<string, unknown>;
  } = {},
) {
  const delivery = verifiedDelivery(setup);
  const connection = new ScriptedConnection((statement) => {
    if (statement.includes("SELECT current_user::text")) {
      return [{
        current_user: "nautilo_crypto",
        session_user: "nautilo_crypto",
      }];
    }
    if (statement.includes("FROM crypto_delivery_operations o")) {
      return stateRows(setup, {
        operation_fanout_row_count: overrides.operationRows ?? 1,
        operation_aggregate_payload_bytes: overrides.operationBytes ?? 128,
        ...(overrides.replay
          ? {
            operation_state: "awaiting_delivery",
            step_state: "awaiting_delivery",
            expected_provider_state_hash:
              setup.providerSubmission.transition.expectedHead.stateHash,
            candidate_provider_id:
              setup.providerSubmission.transition.providerId,
            candidate_provider_state_hash:
              setup.providerSubmission.transition.nextHead.stateHash,
            candidate_roster_bytes: setup.nextRosterBytes,
            candidate_transition_digest:
              setup.providerSubmission.transitionDigest,
            candidate_target_leaf_index:
              setup.operationKind === "device_revoke" ? 0 : 2,
          }
          : {}),
        ...overrides.state,
      });
    }
    if (statement.includes("FROM crypto_domain_transition_namespaces n")) {
      return namespaceRows(setup, overrides.replay).map((row) => ({
        ...row,
        ...overrides.namespaceState,
      }));
    }
    if (statement.includes("FROM crypto_domain_devices dd")) {
      return [
        {
          device_id: "device_alice_desktop",
          human_id: overrides.invalidRosterMapping
            ? "human_wrong"
            : "human_alice",
          leaf_index: 0,
          device_state: setup.operationKind === "device_revoke"
            ? "revoked"
            : "active",
          device_human_id: "human_alice",
          removed_epoch: null,
          removed_at_ms: null,
        },
        {
          device_id: setup.committerDeviceId,
          human_id: "human_bob",
          leaf_index: 1,
          device_state: "active",
          device_human_id: "human_bob",
          removed_epoch: null,
          removed_at_ms: null,
        },
      ];
    }
    if (
      statement.includes(
        "SELECT d.device_id, d.state, d.delivery_sequence_high_watermark",
      )
    ) {
      return [...new Set(
        delivery.messages.map((message) => message.recipientDeviceId),
      )].sort().map((deviceId) => ({
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
    const normalized = statement.replaceAll('"', "").toLowerCase();
    if (
      normalized.includes("from crypto_delivery_messages")
      && normalized.includes("payload_bytes")
      && normalized.includes("delivery_sequence_high_watermark")
    ) {
      return overrides.replay
        ? [...delivery.messages].map((message, domainSequence) => ({
          message_id: message.messageId,
          domain_sequence:
            7 * MAX_FANOUT_ROWS_PER_OPERATION + domainSequence,
          recipient_sequence: domainSequence + 1,
          recipient_device_id: message.recipientDeviceId,
          delivery_sequence_high_watermark: delivery.messages.length,
          format_version: message.formatVersion,
          payload_hash: message.payloadHash,
          payload_bytes: message.payloadBytes,
        })).sort((left, right) =>
          left.recipient_device_id.localeCompare(right.recipient_device_id)
          || left.message_id.localeCompare(right.message_id)
        )
        : [];
    }
    if (statement.includes("RETURNING")) return [{ applied: "yes" }];
    return [];
  });
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    connection,
    repository: new PostgresDomainTransitionSubmissionRepository(
      handle,
      setup.crypto,
    ),
  };
}

function claim(setup: ReturnType<typeof createDomainTransitionFixture>) {
  return {
    operationId: setup.operationId,
    domainId: setup.domainId,
    state: "awaiting_committer" as const,
    workerId: "worker_a",
    retryCount: 0,
    leaseExpiresAt: 80_000,
  };
}

describe("Postgres Domain transition submission", () => {
  test("authenticates and stages one Domain transition atomically", async () => {
    const setup = createDomainTransitionFixture();
    const harness = await repository(setup);

    const result = await harness.repository.submit({
      claim: claim(setup),
      providerSubmission: setup.providerSubmission,
      namespaceSubmission: setup.namespaceSubmission,
      submittedAt: 40_000,
    });

    expect(result.status).toBe("submitted");
    if (result.status !== "submitted") return;
    expect(result.messageCount).toBe(3);
    expect(result.aggregatePayloadBytes).toBeGreaterThan(0);
    const sql = harness.connection.statements
      .map(({ statement }) => statement)
      .join("\n");
    expect(sql).toContain("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(sql).toContain("FOR UPDATE OF o, s, d, p, committer, target");
    expect(sql).not.toContain("INSERT INTO namespace_crypto_bindings");
    expect(sql).toContain("candidate_signed_binding_bytes = $5");
    expect(sql).not.toContain("UPDATE namespace_crypto_heads");
    expect(sql).not.toContain("UPDATE crypto_domain_provider_heads");
    expect(sql).not.toContain("UPDATE crypto_domains");
    expect(sql).not.toContain("INSERT INTO crypto_domain_devices");
    expect(sql).not.toContain("UPDATE crypto_domain_devices");
    expect(sql).toContain("INSERT INTO crypto_delivery_messages");
    expect(sql).not.toContain("SELECT domain_sequence");
    expect(sql).toContain("state = 'prepared'");
    expect(sql).toContain("state = 'awaiting_delivery'");
    expect(sql).toContain("candidate_provider_state_hash = $8");
    const messageInserts = harness.connection.statements.filter(
      ({ statement }) =>
        statement.trim().startsWith("INSERT INTO crypto_delivery_messages"),
    );
    expect(messageInserts.map(({ parameters }) => parameters[3])).toEqual([
      7 * MAX_FANOUT_ROWS_PER_OPERATION,
      7 * MAX_FANOUT_ROWS_PER_OPERATION + 1,
      7 * MAX_FANOUT_ROWS_PER_OPERATION + 2,
    ]);
    expect(messageInserts.map(({ parameters }) => parameters[4])).toEqual([
      1,
      1,
      1,
    ]);
  });

  test("does not mutate after a lost lease", async () => {
    const setup = createDomainTransitionFixture();
    const harness = await repository(setup, {
      state: { lease_owner: "worker_b" },
    });
    expect(await harness.repository.submit({
      claim: claim(setup),
      providerSubmission: setup.providerSubmission,
      namespaceSubmission: setup.namespaceSubmission,
      submittedAt: 40_000,
    })).toEqual({ status: "lost_lease" });
    expect(
      harness.connection.statements.some(({ statement }) =>
        /^(?:INSERT|UPDATE|DELETE)\s/.test(statement.trim())
      ),
    ).toBe(false);
  });

  test("rejects aggregate overflow before any durable transition", async () => {
    const setup = createDomainTransitionFixture();
    const harness = await repository(setup, {
      operationRows: MAX_FANOUT_ROWS_PER_OPERATION,
      operationBytes: MAX_FANOUT_PAYLOAD_BYTES,
    });
    expect(harness.repository.submit({
      claim: claim(setup),
      providerSubmission: setup.providerSubmission,
      namespaceSubmission: setup.namespaceSubmission,
      submittedAt: 40_000,
    })).rejects.toThrow("fanout bounds");
    const stateChangingSql = harness.connection.statements
      .map(({ statement }) => statement)
      .filter((statement) =>
        /^(?:INSERT|UPDATE|DELETE)\s/.test(statement.trim())
      );
    expect(stateChangingSql).toEqual([]);
  });

  test("rejects a Domain-device mapping that differs from the provider roster", async () => {
    const setup = createDomainTransitionFixture();
    const harness = await repository(setup, {
      invalidRosterMapping: true,
    });
    expect(await harness.repository.submit({
      claim: claim(setup),
      providerSubmission: setup.providerSubmission,
      namespaceSubmission: setup.namespaceSubmission,
      submittedAt: 40_000,
    })).toEqual({ status: "stale_state" });
    expect(
      harness.connection.statements.some(({ statement }) =>
        /^(?:INSERT|UPDATE|DELETE)\s/.test(statement.trim())
      ),
    ).toBe(false);
  });

  test("accepts the original exact request after its durable state advanced", async () => {
    const setup = createDomainTransitionFixture();
    const harness = await repository(setup, { replay: true });
    expect(await harness.repository.submit({
      claim: claim(setup),
      providerSubmission: setup.providerSubmission,
      namespaceSubmission: setup.namespaceSubmission,
      submittedAt: 50_000,
    })).toEqual({
      status: "duplicate",
      messageCount: 3,
      aggregatePayloadBytes: verifiedDelivery(setup).aggregatePayloadBytes,
    });
    expect(
      harness.connection.statements.some(({ statement }) =>
        /^(?:INSERT|UPDATE|DELETE)\s/.test(statement.trim())
      ),
    ).toBe(false);
  });

  test("accepts the original exact request after target acknowledgement", async () => {
    const setup = createDomainTransitionFixture();
    const harness = await repository(setup, {
      replay: true,
      state: {
        operation_state: "ready_to_activate",
        step_state: "ready_to_activate",
      },
    });
    expect(await harness.repository.submit({
      claim: claim(setup),
      providerSubmission: setup.providerSubmission,
      namespaceSubmission: setup.namespaceSubmission,
      submittedAt: 50_000,
    })).toEqual({
      status: "duplicate",
      messageCount: 3,
      aggregatePayloadBytes: verifiedDelivery(setup).aggregatePayloadBytes,
    });
  });

  test("stages a revocation under its admission-owned write pause", async () => {
    const setup = createDomainTransitionFixture({
      operationKind: "device_revoke",
    });
    const harness = await repository(setup);

    const result = await harness.repository.submit({
      claim: claim(setup),
      providerSubmission: setup.providerSubmission,
      namespaceSubmission: setup.namespaceSubmission,
      submittedAt: 40_000,
    });

    expect(result.status).toBe("submitted");
    expect(result.status === "submitted" && result.messageCount).toBe(1);
    const statements = harness.connection.statements;
    const sql = statements.map(({ statement }) => statement).join("\n");
    expect(sql).toContain("head_pause_operation_id");
    expect(sql).toContain("remaining.state IN");
    expect(sql).not.toContain("SET removed_epoch");
    expect(sql).not.toContain(
      "INSERT INTO crypto_domain_devices (\n           domain_id",
    );
    const recipients = statements
      .filter(({ statement }) =>
        statement.trim().startsWith("INSERT INTO crypto_delivery_messages")
      )
      .map(({ parameters }) => parameters[5]);
    expect(recipients).toEqual([setup.committerDeviceId]);
    expect(recipients).not.toContain(setup.targetDeviceId);
    const recipientSequences = statements
      .filter(({ statement }) =>
        statement.trim().startsWith("INSERT INTO crypto_delivery_messages")
      )
      .map(({ parameters }) => parameters[4]);
    expect(recipientSequences).toEqual([1]);
    expect(
      statements.some(({ statement }) =>
        statement.trim().startsWith("UPDATE crypto_domains")
      ),
    ).toBe(false);
  });

  test("rejects revocation when the admission pause belongs to another operation", async () => {
    const setup = createDomainTransitionFixture({
      operationKind: "device_revoke",
    });
    const harness = await repository(setup, {
      state: { domain_pause_operation_id: "operation_other" },
    });

    expect(await harness.repository.submit({
      claim: claim(setup),
      providerSubmission: setup.providerSubmission,
      namespaceSubmission: setup.namespaceSubmission,
      submittedAt: 40_000,
    })).toEqual({ status: "stale_state" });
    expect(
      harness.connection.statements.some(({ statement }) =>
        /^(?:INSERT|UPDATE|DELETE)\s/.test(statement.trim())
      ),
    ).toBe(false);
  });

  test("rejects revocation when a Namespace pause belongs to another operation", async () => {
    const setup = createDomainTransitionFixture({
      operationKind: "device_revoke",
    });
    const harness = await repository(setup, {
      namespaceState: { head_pause_operation_id: "operation_other" },
    });

    expect(await harness.repository.submit({
      claim: claim(setup),
      providerSubmission: setup.providerSubmission,
      namespaceSubmission: setup.namespaceSubmission,
      submittedAt: 40_000,
    })).toEqual({ status: "stale_state" });
    expect(
      harness.connection.statements.some(({ statement }) =>
        /^(?:INSERT|UPDATE|DELETE)\s/.test(statement.trim())
      ),
    ).toBe(false);
  });

  test("rejects a revocation whose target mapping is already stale", async () => {
    const setup = createDomainTransitionFixture({
      operationKind: "device_revoke",
    });
    const harness = await repository(setup, {
      state: { mapped_leaf_index: 7 },
    });

    expect(await harness.repository.submit({
      claim: claim(setup),
      providerSubmission: setup.providerSubmission,
      namespaceSubmission: setup.namespaceSubmission,
      submittedAt: 40_000,
    })).toEqual({ status: "stale_state" });
  });

  test("accepts the original revocation request while the target mapping stays staged", async () => {
    const setup = createDomainTransitionFixture({
      operationKind: "device_revoke",
    });
    const harness = await repository(setup, { replay: true });

    expect(await harness.repository.submit({
      claim: claim(setup),
      providerSubmission: setup.providerSubmission,
      namespaceSubmission: setup.namespaceSubmission,
      submittedAt: 50_000,
    })).toEqual({
      status: "duplicate",
      messageCount: 1,
      aggregatePayloadBytes: verifiedDelivery(setup).aggregatePayloadBytes,
    });
    expect(
      harness.connection.statements.some(({ statement }) =>
        /^(?:INSERT|UPDATE|DELETE)\s/.test(statement.trim())
      ),
    ).toBe(false);
  });

  test("rejects revocation replay whose staged target leaf is not exact", async () => {
    const setup = createDomainTransitionFixture({
      operationKind: "device_revoke",
    });
    const harness = await repository(setup, {
      replay: true,
      state: { candidate_target_leaf_index: 9 },
    });

    expect(await harness.repository.submit({
      claim: {
        ...claim(setup),
        state: "awaiting_delivery",
        workerId: "obsolete_worker",
        leaseExpiresAt: 1,
      },
      providerSubmission: setup.providerSubmission,
      namespaceSubmission: setup.namespaceSubmission,
      submittedAt: 50_000,
    })).toEqual({ status: "stale_state" });
  });
});
