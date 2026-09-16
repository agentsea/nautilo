import { describe, expect, test } from "bun:test";
import {
  reserveRecipientDeliverySequences,
} from "../../src/server/delivery/postgres-recipient-delivery-sequence.ts";
import type {
  CryptoPostgresExecutor,
} from "../../src/server/index.ts";

class SequenceExecutor implements CryptoPostgresExecutor {
  readonly statements: string[] = [];
  readonly parameters: readonly unknown[][] = [];

  constructor(
    private readonly watermarks: Readonly<Record<string, number>>,
    private readonly failDeviceId: string | null = null,
    private readonly blockedDeviceId: string | null = null,
    private readonly expiredDeviceId: string | null = null,
  ) {}

  query<Row>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    (this.parameters as unknown[][]).push([...parameters]);
    if (statement.startsWith("SELECT d.device_id")) {
      return Promise.resolve(
        (parameters[0] as string[])
          .filter((deviceId) => this.watermarks[deviceId] !== undefined)
          .map((deviceId) => ({
            device_id: deviceId,
            state: "active",
            delivery_sequence_high_watermark:
              this.watermarks[deviceId],
            delivery_acknowledged_sequence:
              deviceId === this.blockedDeviceId
                || deviceId === this.expiredDeviceId
                ? 0
                : this.watermarks[deviceId],
            delivery_blocked_sequence:
              deviceId === this.blockedDeviceId ? 1 : null,
            delivery_blocked_operation_id:
              deviceId === this.blockedDeviceId ? "operation_blocked" : null,
            delivery_blocked_at:
              deviceId === this.blockedDeviceId ? "2026-08-02T00:00:00Z" : null,
            delivery_blocked_reason:
              deviceId === this.blockedDeviceId ? "delivery_expired" : null,
            first_unresolved_expires_at_ms:
              deviceId === this.expiredDeviceId ? 9_000 : null,
          })) as Row[],
      );
    }
    if (
      statement.startsWith("UPDATE human_crypto_devices")
      && parameters[0] !== this.failDeviceId
    ) {
      return Promise.resolve([{ device_id: parameters[0] }] as Row[]);
    }
    return Promise.resolve([]);
  }
}

describe("recipient delivery sequence reservation", () => {
  test("locks devices canonically and reserves one contiguous range per recipient", async () => {
    const executor = new SequenceExecutor({
      device_a: 3,
      device_b: 7,
    });
    expect(await reserveRecipientDeliverySequences(
      executor,
      ["device_b", "device_a", "device_a"],
      10_000,
    )).toEqual([8, 4, 5]);
    expect(executor.parameters[0]?.[0]).toEqual([
      "device_a",
      "device_b",
    ]);
    const updates = executor.parameters.slice(1);
    expect(updates).toEqual([
      ["device_a", 5, 3],
      ["device_b", 8, 7],
    ]);
  });

  test("fails closed for an incomplete device inventory", async () => {
    const executor = new SequenceExecutor({ device_a: 0 });
    expect(
      reserveRecipientDeliverySequences(
        executor,
        ["device_a", "device_missing"],
        10_000,
      ),
    ).rejects.toThrow("inventory is stale");
  });

  test("treats a lost watermark compare-and-swap as transaction failure", async () => {
    const executor = new SequenceExecutor(
      { device_a: 0 },
      "device_a",
    );
    expect(
      reserveRecipientDeliverySequences(executor, ["device_a"], 10_000),
    ).rejects.toThrow("compare-and-swap");
  });

  test("never wraps the durable high-water mark", async () => {
    const executor = new SequenceExecutor({
      device_a: Number.MAX_SAFE_INTEGER,
    });
    expect(
      reserveRecipientDeliverySequences(executor, ["device_a"], 10_000),
    ).rejects.toThrow("unsafe");
  });

  test("refuses to extend a queue whose first expired position requires resync", async () => {
    const executor = new SequenceExecutor(
      { device_a: 3 },
      null,
      "device_a",
    );
    expect(
      reserveRecipientDeliverySequences(executor, ["device_a"], 10_000),
    ).rejects.toThrow("requires resync");
    expect(executor.statements).toHaveLength(1);
  });

  test("refuses to append behind an expired head before cleanup marks it", async () => {
    const executor = new SequenceExecutor(
      { device_a: 3 },
      null,
      null,
      "device_a",
    );
    expect(
      reserveRecipientDeliverySequences(executor, ["device_a"], 10_000),
    ).rejects.toThrow("expired delivery");
    expect(executor.statements).toHaveLength(1);
  });
});
