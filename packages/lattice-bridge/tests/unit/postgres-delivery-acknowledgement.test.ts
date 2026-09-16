import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  createDeliveryAcknowledgementProof,
  verifyDeliveryAcknowledgementProof,
} from "../../src/index.ts";
import {
  PostgresDeliveryAcknowledgementRepository,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
} from "../../src/server/index.ts";

class ScriptedConnection implements CryptoPostgresConnection {
  readonly statements: string[] = [];
  readonly parameters: (readonly unknown[])[] = [];
  readonly #results: unknown[][];
  constructor(results: unknown[][]) {
    this.#results = [...results];
  }
  query<Row>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    this.parameters.push(parameters);
    const rows = this.#results.shift() ?? [];
    return Promise.resolve(rows.map((row) => (
      typeof row === "object" && row !== null
        ? {
          delivery_blocked_sequence: null,
          delivery_blocked_operation_id: null,
          delivery_blocked_at: null,
          delivery_blocked_reason: null,
          ...row,
        }
        : row
    )) as Row[]);
  }
  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
  ): Promise<Result> {
    return callback(this);
  }
}

function normalizedSql(connection: ScriptedConnection): string {
  return connection.statements.join("\n")
    .replaceAll('"', "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function queryParameters(connection: ScriptedConnection): readonly unknown[] {
  return connection.parameters.flat();
}

const crypto = new LatticeCrypto();
const signing = crypto.generateSigningKeyPair();
const MESSAGE_PAYLOAD_HASH = new Uint8Array(32).fill(0x31);

function verifiedAcknowledgement(input: {
  readonly messageId?: string;
  readonly deviceId?: string;
  readonly processedRevision?: number;
}) {
  const message = {
    messageId: input.messageId ?? "delivery_message_1",
    recipientDeviceId: input.deviceId ?? "device_alice_pending",
    recipientSequence: 1,
    payloadHash: MESSAGE_PAYLOAD_HASH,
  };
  const processedRevision = input.processedRevision ?? 1;
  const proof = createDeliveryAcknowledgementProof({
    crypto,
    message,
    processedRevision,
    acknowledgedAt: 20_000,
    signingPrivateKey: signing.privateKey,
  });
  return verifyDeliveryAcknowledgementProof({
    crypto,
    proof,
    message,
    resolveDevice: () => ({
      state: "active",
      revision: processedRevision - 1,
      signingPublicKey: signing.publicKey,
    }),
  });
}

const acknowledgement = verifiedAcknowledgement({});

function membershipMessageRow(input: {
  readonly kind: "human_add" | "human_remove";
  readonly operationId: string;
  readonly deviceId: string;
  readonly deviceRevision: number;
  readonly bootstrapDeviceId: string | null;
  readonly committerDeviceId: string;
  readonly operationState?: "awaiting_delivery" | "ready_to_activate";
  readonly existingAcknowledgementDigest?: Uint8Array | null;
}) {
  const existingDigest = input.existingAcknowledgementDigest ?? null;
  return {
    device_id: input.deviceId,
    device_state: "active",
    device_revision: input.deviceRevision,
    delivery_acknowledged_sequence: 0,
    message_id: "delivery_membership_chunk",
    message_operation_id: input.operationId,
    message_domain_id: null,
    message_recipient_sequence: 1,
    message_payload_hash: MESSAGE_PAYLOAD_HASH,
    recipient_device_id: input.deviceId,
    operation_kind: input.kind,
    operation_state: input.operationState ?? "awaiting_delivery",
    operation_target_device_id: input.bootstrapDeviceId,
    membership_bootstrap_device_id: input.bootstrapDeviceId,
    membership_committer_device_id: input.committerDeviceId,
    domain_required_count: 0,
    existing_device_id: existingDigest === null ? null : input.deviceId,
    existing_processed_revision: existingDigest === null
      ? null
      : input.deviceRevision,
    existing_acknowledgement_digest: existingDigest,
  };
}

describe("Postgres delivery acknowledgement repository", () => {
  test("rejects structural and mutated verification look-alikes before a transaction", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
    ]);
    const handle = await verifyCryptoPostgresHandle(connection);
    const repository = new PostgresDeliveryAcknowledgementRepository(handle);
    const statementsBefore = connection.statements.length;
    expect(() =>
      repository.acknowledge(structuredClone(acknowledgement), 20_000)
    )
      .toThrow("not cryptographically verified");
    const mutable = verifiedAcknowledgement({});
    mutable.payloadHash[0] = mutable.payloadHash[0]! ^ 1;
    expect(() => repository.acknowledge(mutable, 20_000))
      .toThrow("not cryptographically verified");
    expect(connection.statements).toHaveLength(statementsBefore);
  });

  test("rejects a signed proof for a payload other than the durable message", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
      [],
      [],
      [{
        device_id: "device_alice_pending",
        device_state: "pending",
        device_revision: 0,
        delivery_acknowledged_sequence: 0,
        message_id: "delivery_message_1",
        message_operation_id: "operation_device_add",
        message_domain_id: "domain_alice_bob",
        message_recipient_sequence: 1,
        message_payload_hash: new Uint8Array(32).fill(0x99),
        recipient_device_id: "device_alice_pending",
        operation_kind: "device_add",
        operation_state: "awaiting_delivery",
        operation_target_device_id: "device_alice_pending",
        domain_required_count: 1,
        existing_device_id: null,
        existing_processed_revision: null,
        existing_acknowledgement_digest: null,
      }],
    ]);
    const handle = await verifyCryptoPostgresHandle(connection);
    const repository = new PostgresDeliveryAcknowledgementRepository(handle);
    expect(await repository.acknowledge(acknowledgement, 20_000)).toEqual({
      status: "stale_state",
    });
    expect(
      connection.statements.some((statement) =>
        /^(?:INSERT|UPDATE|DELETE)\s/.test(statement.trim())
      ),
    ).toBeFalse();
  });

  test("uses trusted server receipt time and rejects the exact expiry cutoff", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
      [],
      [],
      [],
    ]);
    const handle = await verifyCryptoPostgresHandle(connection);
    const repository = new PostgresDeliveryAcknowledgementRepository(handle);

    expect(await repository.acknowledge(acknowledgement, 30_000)).toEqual({
      status: "stale_state",
    });
    expect(connection.statements.join("\n")).toContain(
      "m.expires_at > $3::timestamptz",
    );
    expect(() => repository.acknowledge(acknowledgement, 19_999)).toThrow(
      "malformed",
    );
  });

  test("persists one exact recipient acknowledgement and advances its revision atomically", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
      [],
      [],
      [{
        device_id: "device_alice_pending",
        device_state: "pending",
        device_revision: 0,
        delivery_acknowledged_sequence: 0,
        message_id: "delivery_message_1",
        message_operation_id: "operation_device_add",
        message_domain_id: "domain_alice_bob",
        message_recipient_sequence: 1,
        message_payload_hash: MESSAGE_PAYLOAD_HASH,
        message_kind: "public_state",
        recipient_device_id: "device_alice_pending",
        operation_kind: "device_add",
        operation_state: "awaiting_delivery",
        operation_target_device_id: "device_alice_pending",
        domain_required_count: 1,
        existing_device_id: null,
        existing_processed_revision: null,
        existing_acknowledgement_digest: null,
      }],
      [{ message_id: "delivery_message_1" }],
      [{ device_id: "device_alice_pending" }],
      [{ operation_id: "operation_device_add" }],
      [{ operation_id: "operation_device_add", domain_id: "domain_alice_bob" }],
      [{ operation_id: "operation_device_add" }],
      [{ outbox_id: "outbox_ready" }],
    ]);
    const handle = await verifyCryptoPostgresHandle(connection);
    const repository = new PostgresDeliveryAcknowledgementRepository(handle);
    expect(await repository.acknowledge(acknowledgement, 20_000)).toEqual({
      status: "acknowledged",
    });
    const sql = normalizedSql(connection);
    expect(sql).toContain("insert into crypto_delivery_acknowledgements");
    expect(sql).toContain("update human_crypto_devices");
    expect(sql).toContain("for update of o, d");
    expect(sql).not.toContain("for update of o, d, m");
    expect(queryParameters(connection)).toContain("ready_to_activate");
    expect(sql).toContain("s.state <> 'ready_to_activate'");
    expect(sql).toContain("n.state <> 'prepared'");
    expect(sql).toContain("insert into crypto_operation_outbox");
  });

  test("does not let an existing recipient advance target activation", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
      [],
      [],
      [{
        device_id: "device_bob_active",
        device_state: "active",
        device_revision: 5,
        delivery_acknowledged_sequence: 0,
        message_id: "delivery_message_1",
        message_operation_id: "operation_device_add",
        message_domain_id: "domain_alice_bob",
        message_recipient_sequence: 1,
        message_payload_hash: MESSAGE_PAYLOAD_HASH,
        message_kind: "public_state",
        recipient_device_id: "device_bob_active",
        operation_kind: "device_add",
        operation_state: "awaiting_delivery",
        operation_target_device_id: "device_alice_pending",
        domain_required_count: 1,
        existing_device_id: null,
        existing_processed_revision: null,
        existing_acknowledgement_digest: null,
      }],
      [{ message_id: "delivery_message_1" }],
      [{ device_id: "device_bob_active" }],
    ]);
    const handle = await verifyCryptoPostgresHandle(connection);
    const repository = new PostgresDeliveryAcknowledgementRepository(handle);
    expect(await repository.acknowledge(verifiedAcknowledgement({
      deviceId: "device_bob_active",
      processedRevision: 6,
    }), 20_000)).toEqual({ status: "acknowledged" });
    const sql = normalizedSql(connection);
    expect(sql).not.toContain("update crypto_domain_transition_steps");
    expect(queryParameters(connection)).not.toContain("ready_to_activate");
    expect(sql).not.toContain("insert into crypto_operation_outbox");
  });

  test("lets only the Human-add bootstrap device complete the membership ACK gate", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
      [],
      [],
      [membershipMessageRow({
        kind: "human_add",
        operationId: "operation_human_add",
        deviceId: "device_charlie_bootstrap",
        deviceRevision: 4,
        bootstrapDeviceId: "device_charlie_bootstrap",
        committerDeviceId: "device_alice_active",
      })],
      [{ message_id: "delivery_membership_chunk" }],
      [{ device_id: "device_charlie_bootstrap" }],
      [{ operation_id: "operation_human_add" }],
      [{ outbox_id: "outbox_membership_ready" }],
    ]);
    const handle = await verifyCryptoPostgresHandle(connection);
    const repository = new PostgresDeliveryAcknowledgementRepository(handle);

    expect(await repository.acknowledge(verifiedAcknowledgement({
      messageId: "delivery_membership_chunk",
      deviceId: "device_charlie_bootstrap",
      processedRevision: 5,
    }), 20_000)).toEqual({ status: "acknowledged" });

    const sql = normalizedSql(connection);
    expect(sql).toContain(
      "left join crypto_human_membership_transitions membership",
    );
    expect(sql).toContain(
      "crypto_human_membership_transitions.bootstrap_device_id",
    );
    expect(sql).toContain(
      "crypto_human_membership_transitions.committer_device_id",
    );
    expect(sql).toContain("pending_message.recipient_device_id");
    expect(queryParameters(connection)).toContain(
      "crypto_human_membership_ready",
    );
    expect(queryParameters(connection)).not.toContain("crypto_device_ready");
  });

  test("acknowledges a nonmandatory membership recipient without satisfying readiness", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
      [],
      [],
      [membershipMessageRow({
        kind: "human_add",
        operationId: "operation_human_add",
        deviceId: "device_bob_active",
        deviceRevision: 7,
        bootstrapDeviceId: "device_charlie_bootstrap",
        committerDeviceId: "device_alice_active",
      })],
      [{ message_id: "delivery_membership_chunk" }],
      [{ device_id: "device_bob_active" }],
    ]);
    const handle = await verifyCryptoPostgresHandle(connection);
    const repository = new PostgresDeliveryAcknowledgementRepository(handle);

    expect(await repository.acknowledge(verifiedAcknowledgement({
      messageId: "delivery_membership_chunk",
      deviceId: "device_bob_active",
      processedRevision: 8,
    }), 20_000)).toEqual({ status: "acknowledged" });

    const sql = normalizedSql(connection);
    expect(sql).toContain("insert into crypto_delivery_acknowledgements");
    expect(sql).toContain("update human_crypto_devices");
    expect(sql).not.toContain("update crypto_delivery_operations");
    expect(sql).not.toContain("insert into crypto_operation_outbox");
  });

  test("keeps membership awaiting delivery until every mandatory-device chunk is acknowledged", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
      [],
      [],
      [membershipMessageRow({
        kind: "human_add",
        operationId: "operation_human_add",
        deviceId: "device_charlie_bootstrap",
        deviceRevision: 4,
        bootstrapDeviceId: "device_charlie_bootstrap",
        committerDeviceId: "device_alice_active",
      })],
      [{ message_id: "delivery_membership_chunk" }],
      [{ device_id: "device_charlie_bootstrap" }],
      [],
    ]);
    const handle = await verifyCryptoPostgresHandle(connection);
    const repository = new PostgresDeliveryAcknowledgementRepository(handle);

    expect(await repository.acknowledge(verifiedAcknowledgement({
      messageId: "delivery_membership_chunk",
      deviceId: "device_charlie_bootstrap",
      processedRevision: 5,
    }), 20_000)).toEqual({ status: "acknowledged" });

    const sql = normalizedSql(connection);
    expect(sql).toContain("pending_ack.message_id is null");
    expect(sql).toContain("update crypto_delivery_operations");
    expect(sql).not.toContain("insert into crypto_operation_outbox");
  });

  test("uses the Human-remove committer as the mandatory acknowledgement device", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
      [],
      [],
      [membershipMessageRow({
        kind: "human_remove",
        operationId: "operation_human_remove",
        deviceId: "device_alice_active",
        deviceRevision: 10,
        bootstrapDeviceId: null,
        committerDeviceId: "device_alice_active",
      })],
      [{ message_id: "delivery_membership_chunk" }],
      [{ device_id: "device_alice_active" }],
      [{ operation_id: "operation_human_remove" }],
      [{ outbox_id: "outbox_membership_ready" }],
    ]);
    const handle = await verifyCryptoPostgresHandle(connection);
    const repository = new PostgresDeliveryAcknowledgementRepository(handle);

    expect(await repository.acknowledge(verifiedAcknowledgement({
      messageId: "delivery_membership_chunk",
      deviceId: "device_alice_active",
      processedRevision: 11,
    }), 20_000)).toEqual({ status: "acknowledged" });

    const sql = normalizedSql(connection);
    expect(sql).toContain("crypto_delivery_operations.kind = 'human_remove'");
    expect(sql).toContain(
      "crypto_human_membership_transitions.committer_device_id",
    );
    expect(queryParameters(connection)).toContain(
      "crypto_human_membership_ready",
    );
    expect(queryParameters(connection)).not.toContain("crypto_device_ready");
  });

  test("does not emit membership readiness again for an exact duplicate acknowledgement", async () => {
    const duplicate = verifiedAcknowledgement({
      messageId: "delivery_membership_chunk",
      deviceId: "device_charlie_bootstrap",
      processedRevision: 5,
    });
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
      [],
      [],
      [membershipMessageRow({
        kind: "human_add",
        operationId: "operation_human_add",
        deviceId: "device_charlie_bootstrap",
        deviceRevision: 5,
        bootstrapDeviceId: "device_charlie_bootstrap",
        committerDeviceId: "device_alice_active",
        operationState: "ready_to_activate",
        existingAcknowledgementDigest: duplicate.acknowledgementDigest,
      })],
    ]);
    const handle = await verifyCryptoPostgresHandle(connection);
    const repository = new PostgresDeliveryAcknowledgementRepository(handle);

    expect(await repository.acknowledge(duplicate, 20_000)).toEqual({
      status: "duplicate",
    });
    const sql = normalizedSql(connection);
    expect(sql).not.toContain("update crypto_delivery_operations");
    expect(sql).not.toContain("insert into crypto_operation_outbox");
  });

  test("lets every remaining recipient drive revocation readiness but never emits device-ready", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
      [],
      [],
      [{
        device_id: "device_bob_active",
        device_state: "active",
        device_revision: 5,
        delivery_acknowledged_sequence: 0,
        message_id: "delivery_message_1",
        message_operation_id: "operation_device_revoke",
        message_domain_id: "domain_alice_bob",
        message_recipient_sequence: 1,
        message_payload_hash: MESSAGE_PAYLOAD_HASH,
        recipient_device_id: "device_bob_active",
        operation_kind: "device_revoke",
        operation_state: "awaiting_delivery",
        operation_target_device_id: "device_alice_revoked",
        domain_required_count: 2,
        existing_device_id: null,
        existing_processed_revision: null,
        existing_acknowledgement_digest: null,
      }],
      [{ message_id: "delivery_message_1" }],
      [{ device_id: "device_bob_active" }],
      [{
        operation_id: "operation_device_revoke",
        domain_id: "domain_alice_bob",
      }],
      [{ operation_id: "operation_device_revoke" }],
    ]);
    const handle = await verifyCryptoPostgresHandle(connection);
    const repository = new PostgresDeliveryAcknowledgementRepository(handle);

    expect(await repository.acknowledge(verifiedAcknowledgement({
      deviceId: "device_bob_active",
      processedRevision: 6,
    }), 20_000)).toEqual({ status: "acknowledged" });

    const sql = normalizedSql(connection);
    expect(sql).toContain("o.kind as operation_kind");
    expect(sql).toContain(
      "s.state not in ('ready_to_activate', 'failed')",
    );
    expect(sql).toContain(
      "pending_message.domain_id = crypto_domain_transition_steps.domain_id",
    );
    expect(sql).not.toContain(
      "pending_message.recipient_device_id = $4",
    );
    expect(sql).not.toContain("insert into crypto_operation_outbox");
  });

  test("rejects a revoked target before it can acknowledge revocation delivery", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
      [],
      [],
      [{
        device_id: "device_alice_revoked",
        device_state: "revoked",
        device_revision: 8,
        delivery_acknowledged_sequence: 0,
        message_id: "delivery_message_target",
        message_operation_id: "operation_device_revoke",
        message_domain_id: "domain_alice_bob",
        message_recipient_sequence: 1,
        message_payload_hash: MESSAGE_PAYLOAD_HASH,
        recipient_device_id: "device_alice_revoked",
        operation_kind: "device_revoke",
        operation_state: "awaiting_delivery",
        operation_target_device_id: "device_alice_revoked",
        domain_required_count: 1,
        existing_device_id: null,
        existing_processed_revision: null,
        existing_acknowledgement_digest: null,
      }],
    ]);
    const handle = await verifyCryptoPostgresHandle(connection);
    const repository = new PostgresDeliveryAcknowledgementRepository(handle);

    expect(await repository.acknowledge(verifiedAcknowledgement({
      messageId: "delivery_message_target",
      deviceId: "device_alice_revoked",
      processedRevision: 9,
    }), 20_000)).toEqual({ status: "stale_state" });
    expect(
      connection.statements.some((statement) =>
        /^(?:INSERT|UPDATE|DELETE)\s/.test(statement.trim())
      ),
    ).toBeFalse();
  });

  test("does not accept new acknowledgements after an operation is terminal", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
      [],
      [],
      [{
        device_id: "device_bob_active",
        device_state: "active",
        device_revision: 5,
        delivery_acknowledged_sequence: 0,
        message_id: "delivery_message_late",
        message_operation_id: "operation_device_revoke",
        message_domain_id: "domain_alice_bob",
        message_recipient_sequence: 1,
        message_payload_hash: MESSAGE_PAYLOAD_HASH,
        recipient_device_id: "device_bob_active",
        operation_kind: "device_revoke",
        operation_state: "failed",
        operation_target_device_id: "device_alice_revoked",
        domain_required_count: 1,
        existing_device_id: null,
        existing_processed_revision: null,
        existing_acknowledgement_digest: null,
      }],
    ]);
    const handle = await verifyCryptoPostgresHandle(connection);
    const repository = new PostgresDeliveryAcknowledgementRepository(handle);

    expect(await repository.acknowledge(verifiedAcknowledgement({
      messageId: "delivery_message_late",
      deviceId: "device_bob_active",
      processedRevision: 6,
    }), 20_000)).toEqual({ status: "stale_state" });
    expect(
      connection.statements.some((statement) =>
        /^(?:INSERT|UPDATE|DELETE)\s/.test(statement.trim())
      ),
    ).toBeFalse();
  });

  test("acknowledges an active device's ordered envelope after operation activation without reopening it", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
      [],
      [],
      [{
        device_id: "device_bob_active",
        device_state: "active",
        device_revision: 5,
        delivery_acknowledged_sequence: 0,
        message_id: "delivery_message_late",
        message_operation_id: "operation_device_add",
        message_domain_id: "domain_alice_bob",
        message_recipient_sequence: 1,
        message_payload_hash: MESSAGE_PAYLOAD_HASH,
        recipient_device_id: "device_bob_active",
        operation_kind: "device_add",
        operation_state: "active",
        operation_target_device_id: "device_alice_active",
        domain_required_count: 1,
        existing_device_id: null,
        existing_processed_revision: null,
        existing_acknowledgement_digest: null,
      }],
      [{ message_id: "delivery_message_late" }],
      [{ device_id: "device_bob_active" }],
    ]);
    const handle = await verifyCryptoPostgresHandle(connection);
    const repository = new PostgresDeliveryAcknowledgementRepository(handle);

    expect(await repository.acknowledge(verifiedAcknowledgement({
      messageId: "delivery_message_late",
      deviceId: "device_bob_active",
      processedRevision: 6,
    }), 20_000)).toEqual({ status: "acknowledged" });
    const sql = normalizedSql(connection);
    expect(sql).toContain("insert into crypto_delivery_acknowledgements");
    expect(sql).toContain("update human_crypto_devices");
    expect(sql).not.toContain("update crypto_domain_transition_steps");
    expect(sql).not.toContain("update crypto_delivery_operations");
    expect(sql).not.toContain("insert into crypto_operation_outbox");
  });

  test("rejects an out-of-order acknowledgement before mutation", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
      [],
      [],
      [{
        device_id: "device_alice_pending",
        device_state: "pending",
        device_revision: 0,
        delivery_acknowledged_sequence: 0,
        message_id: "delivery_message_1",
        message_operation_id: "operation_device_add",
        message_domain_id: "domain_alice_bob",
        message_recipient_sequence: 2,
        message_payload_hash: MESSAGE_PAYLOAD_HASH,
        recipient_device_id: "device_alice_pending",
        operation_kind: "device_add",
        operation_state: "awaiting_delivery",
        operation_target_device_id: "device_alice_pending",
        domain_required_count: 1,
        existing_device_id: null,
        existing_processed_revision: null,
        existing_acknowledgement_digest: null,
      }],
    ]);
    const handle = await verifyCryptoPostgresHandle(connection);
    const repository = new PostgresDeliveryAcknowledgementRepository(handle);

    const sequenceTwo = createDeliveryAcknowledgementProof({
      crypto,
      message: {
        messageId: "delivery_message_1",
        recipientDeviceId: "device_alice_pending",
        recipientSequence: 2,
        payloadHash: MESSAGE_PAYLOAD_HASH,
      },
      processedRevision: 1,
      acknowledgedAt: 20_000,
      signingPrivateKey: signing.privateKey,
    });
    const verifiedSequenceTwo = verifyDeliveryAcknowledgementProof({
      crypto,
      proof: sequenceTwo,
      message: {
        messageId: "delivery_message_1",
        recipientDeviceId: "device_alice_pending",
        recipientSequence: 2,
        payloadHash: MESSAGE_PAYLOAD_HASH,
      },
      resolveDevice: () => ({
        state: "pending",
        revision: 0,
        signingPublicKey: signing.publicKey,
      }),
    });
    expect(await repository.acknowledge(verifiedSequenceTwo, 20_000)).toEqual({
      status: "stale_state",
    });
    expect(
      connection.statements.some((statement) =>
        /^(?:INSERT|UPDATE|DELETE)\s/.test(statement.trim())
      ),
    ).toBeFalse();
  });

  test("rejects a late acknowledgement after expiry has durably blocked the device", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
      [],
      [],
      [{
        device_id: "device_alice_pending",
        device_state: "pending",
        device_revision: 0,
        delivery_acknowledged_sequence: 0,
        delivery_blocked_sequence: 1,
        message_id: "delivery_message_1",
        message_operation_id: "operation_device_add",
        message_domain_id: "domain_alice_bob",
        message_recipient_sequence: 1,
        message_payload_hash: MESSAGE_PAYLOAD_HASH,
        recipient_device_id: "device_alice_pending",
        operation_kind: "device_add",
        operation_state: "failed",
        operation_target_device_id: "device_alice_pending",
        domain_required_count: 1,
        existing_device_id: null,
        existing_processed_revision: null,
        existing_acknowledgement_digest: null,
      }],
    ]);
    const handle = await verifyCryptoPostgresHandle(connection);
    const repository = new PostgresDeliveryAcknowledgementRepository(handle);

    expect(await repository.acknowledge(acknowledgement, 20_000)).toEqual({
      status: "stale_state",
    });
    expect(connection.statements.join("\n")).toContain("FOR UPDATE OF o, d");
    expect(
      connection.statements.some((statement) =>
        /^(?:INSERT|UPDATE|DELETE)\s/.test(statement.trim())
      ),
    ).toBeFalse();
  });
});
