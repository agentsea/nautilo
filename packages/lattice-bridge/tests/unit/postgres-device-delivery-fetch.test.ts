import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  createDeviceDeliveryFetchProof,
  type DeviceDeliveryFetchProof,
} from "../../src/index.ts";
import {
  PostgresDeviceDeliveryFetchRepository,
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

const crypto = new LatticeCrypto();
const signing = crypto.generateSigningKeyPair();

function proof(
  overrides: Partial<DeviceDeliveryFetchProof> = {},
): DeviceDeliveryFetchProof {
  return createDeviceDeliveryFetchProof({
    crypto,
    requestId: "request_delivery_1",
    humanId: "human_alice",
    deviceId: "device_alice",
    expectedDeviceRevision: 4,
    minimumHighWatermark: 0,
    maximumMessages: 4,
    maximumPayloadBytes: 1_048_616,
    issuedAt: 10_000,
    expiresAt: 20_000,
    signingPrivateKey: signing.privateKey,
    ...overrides,
  });
}

function device(overrides: Record<string, unknown> = {}) {
  return {
    device_id: "device_alice",
    human_id: "human_alice",
    state: "active",
    revision: 4,
    signing_public_key: signing.publicKey,
    delivery_sequence_high_watermark: 2,
    delivery_acknowledged_sequence: 0,
    delivery_blocked_sequence: null,
    delivery_blocked_operation_id: null,
    delivery_blocked_at_ms: null,
    delivery_blocked_reason: null,
    ...overrides,
  };
}

function message(
  sequence: number,
  overrides: Record<string, unknown> = {},
) {
  const payloadBytes = new Uint8Array([sequence, 2, 3]);
  return {
    message_id: `delivery_message_${sequence}`,
    operation_id: "operation_device_add",
    domain_id: "domain_alice_bob",
    domain_sequence: 100 + sequence,
    recipient_sequence: sequence,
    kind: "public_state",
    format_version: 1,
    payload_hash: crypto.hash(payloadBytes),
    payload_bytes: payloadBytes,
    created_at_ms: 10_000,
    expires_at_ms: 30_000,
    operation_kind: "device_add",
    operation_state: "awaiting_delivery",
    operation_target_device_id: "device_alice",
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
    repository: new PostgresDeviceDeliveryFetchRepository(handle, crypto),
  };
}

describe("Postgres device delivery fetch", () => {
  test("returns only the exact signed recipient queue in gap-free order", async () => {
    const setup = await repository([
      [],
      [device()],
      [message(1), message(2)],
    ]);
    expect(await setup.repository.fetch({
      proof: proof(),
      now: 11_000,
    })).toMatchObject({
      status: "messages",
      acknowledgedThrough: 0,
      highWatermark: 2,
      hasMore: false,
      messages: [
        { recipientSequence: 1, messageId: "delivery_message_1" },
        { recipientSequence: 2, messageId: "delivery_message_2" },
      ],
    });
    const sql = setup.connection.statements.join("\n");
    const normalizedSql = sql.replaceAll('"', "").replaceAll(/\s+/g, " ");
    expect(sql).toContain("REPEATABLE READ READ ONLY");
    expect(normalizedSql).toContain(
      "crypto_delivery_messages.recipient_device_id = $1",
    );
    expect(normalizedSql).toContain(
      "order by crypto_delivery_messages.recipient_sequence asc",
    );
  });

  test("denies altered signatures, revoked devices, and foreign pending operations", async () => {
    const altered = await repository([
      [],
      [device()],
    ]);
    expect(await altered.repository.fetch({
      proof: {
        ...proof(),
        minimumHighWatermark: 1,
      },
      now: 11_000,
    })).toEqual({ status: "denied" });

    const revoked = await repository([
      [],
      [device({ state: "revoked" })],
    ]);
    expect(await revoked.repository.fetch({
      proof: proof(),
      now: 11_000,
    })).toEqual({ status: "denied" });

    const pending = await repository([
      [],
      [device({ state: "pending", delivery_sequence_high_watermark: 1 })],
      [message(1, {
        operation_kind: "human_add",
        operation_target_device_id: "device_other",
      })],
    ]);
    expect(await pending.repository.fetch({
      proof: proof(),
      now: 11_000,
    })).toEqual({ status: "denied" });
  });

  test("returns a gap without exposing any later payload", async () => {
    const setup = await repository([
      [],
      [device()],
      [message(2)],
    ]);
    expect(await setup.repository.fetch({
      proof: proof(),
      now: 11_000,
    })).toEqual({
      status: "gap",
      expectedSequence: 1,
      highWatermark: 2,
    });
  });

  test("blocks on the first expired row instead of returning later messages", async () => {
    const setup = await repository([
      [],
      [device()],
      [
        message(1, { expires_at_ms: 11_000 }),
        message(2),
      ],
    ]);
    expect(await setup.repository.fetch({
      proof: proof(),
      now: 11_000,
    })).toEqual({
      status: "expired",
      sequence: 1,
      operationId: "operation_device_add",
    });
  });

  test("returns the durable resync block without reading or exposing queue payloads", async () => {
    const setup = await repository([
      [],
      [device({
        delivery_blocked_sequence: 1,
        delivery_blocked_operation_id: "operation_device_add",
        delivery_blocked_at_ms: 11_000,
        delivery_blocked_reason: "delivery_expired",
      })],
    ]);
    expect(await setup.repository.fetch({
      proof: proof(),
      now: 11_000,
    })).toEqual({
      status: "expired",
      sequence: 1,
      operationId: "operation_device_add",
    });
    expect(setup.connection.statements.join("\n")).not.toContain(
      "FROM crypto_delivery_messages message",
    );
  });

  test("uses a retained client high-water mark to detect database rollback", async () => {
    const setup = await repository([
      [],
      [device({ delivery_sequence_high_watermark: 4 })],
    ]);
    expect(await setup.repository.fetch({
      proof: proof({ minimumHighWatermark: 5 }),
      now: 11_000,
    })).toEqual({ status: "rollback_detected" });
  });

  test("makes no rollback-detection claim after every client anchor is lost", async () => {
    const restoredSnapshot = await repository([
      [],
      [device({ delivery_sequence_high_watermark: 4 })],
      [],
    ]);
    expect(await restoredSnapshot.repository.fetch({
      proof: proof({ minimumHighWatermark: 0 }),
      now: 11_000,
    })).toEqual({
      status: "gap",
      expectedSequence: 1,
      highWatermark: 4,
    });
  });

  test("returns empty only when the durable acknowledgement cursor reaches the high-water mark", async () => {
    const setup = await repository([
      [],
      [device({
        delivery_sequence_high_watermark: 2,
        delivery_acknowledged_sequence: 2,
      })],
    ]);
    expect(await setup.repository.fetch({
      proof: proof(),
      now: 11_000,
    })).toEqual({
      status: "empty",
      acknowledgedThrough: 2,
      highWatermark: 2,
    });
  });

  test("bounds aggregate payload without dropping the next queue position", async () => {
    const firstBytes = new Uint8Array(700_000).fill(0x31);
    const secondBytes = new Uint8Array(700_000).fill(0x41);
    const setup = await repository([
      [],
      [device()],
      [
        message(1, {
          payload_bytes: firstBytes,
          payload_hash: crypto.hash(firstBytes),
        }),
        message(2, {
          payload_bytes: secondBytes,
          payload_hash: crypto.hash(secondBytes),
        }),
      ],
    ]);
    expect(await setup.repository.fetch({
      proof: proof(),
      now: 11_000,
    })).toMatchObject({
      status: "messages",
      hasMore: true,
      messages: [{ recipientSequence: 1 }],
    });
  });
});
