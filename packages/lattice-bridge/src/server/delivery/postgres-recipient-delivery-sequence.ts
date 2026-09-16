import type {
  CryptoPostgresExecutor,
} from "../storage/postgres-lattice-storage.ts";
import type {
  DatabaseRow,
  DatabaseScalar,
} from "../storage/postgres-record-codecs.ts";

function requiredString(row: DatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new TypeError(`Recipient delivery column ${name} must be text`);
  }
  return value;
}

function requiredCounter(row: DatabaseRow, name: string): number {
  const value = row[name];
  const normalized = typeof value === "bigint"
    ? Number(value)
    : typeof value === "string"
    ? Number(value)
    : value;
  if (
    typeof normalized !== "number"
    || !Number.isSafeInteger(normalized)
    || normalized < 0
  ) {
    throw new TypeError(
      `Recipient delivery column ${name} must be a safe counter`,
    );
  }
  return normalized;
}

async function expectSingleMutation(
  executor: CryptoPostgresExecutor,
  statement: string,
  parameters: readonly DatabaseScalar[],
): Promise<void> {
  const rows = await executor.query(statement, parameters);
  if (rows.length !== 1) {
    throw new Error("Recipient delivery sequence lost its compare-and-swap");
  }
}

/**
 * Reserve gap-free per-device queue positions inside the caller's transaction.
 * Returned values align exactly with recipientDeviceIds.
 */
export async function reserveRecipientDeliverySequences(
  executor: CryptoPostgresExecutor,
  recipientDeviceIds: readonly string[],
  reservationAt: number,
): Promise<readonly number[]> {
  if (recipientDeviceIds.length < 1) {
    throw new RangeError("Recipient delivery reservation cannot be empty");
  }
  if (!Number.isSafeInteger(reservationAt) || reservationAt < 0) {
    throw new RangeError("Recipient delivery reservation time is invalid");
  }
  const counts = new Map<string, number>();
  for (const deviceId of recipientDeviceIds) {
    counts.set(deviceId, (counts.get(deviceId) ?? 0) + 1);
  }
  const deviceIds = [...counts.keys()].sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right))
  );
  const rows = await executor.query(
    `SELECT d.device_id, d.state, d.delivery_sequence_high_watermark,
            d.delivery_acknowledged_sequence,
            d.delivery_blocked_sequence, d.delivery_blocked_operation_id,
            d.delivery_blocked_at, d.delivery_blocked_reason,
            CASE WHEN first_unresolved.expires_at IS NULL THEN NULL
                 ELSE floor(
                   extract(epoch from first_unresolved.expires_at) * 1000
                 )::bigint
            END AS first_unresolved_expires_at_ms
       FROM human_crypto_devices d
       LEFT JOIN LATERAL (
         SELECT m.expires_at
           FROM crypto_delivery_messages m
           LEFT JOIN crypto_delivery_acknowledgements a
             ON a.message_id = m.message_id
            AND a.device_id = m.recipient_device_id
          WHERE m.recipient_device_id = d.device_id
            AND m.recipient_sequence
              = d.delivery_acknowledged_sequence + 1
            AND a.message_id IS NULL
          LIMIT 1
       ) first_unresolved ON true
      WHERE d.device_id = ANY($1::text[])
      ORDER BY convert_to(d.device_id, 'UTF8')
      FOR UPDATE OF d`,
    [deviceIds],
  );
  if (rows.length !== deviceIds.length) {
    throw new Error("Recipient delivery device inventory is stale");
  }
  const nextByDevice = new Map<string, number>();
  for (const [index, row] of rows.entries()) {
    const deviceId = requiredString(row, "device_id");
    if (deviceId !== deviceIds[index]) {
      throw new Error("Recipient delivery device inventory is noncanonical");
    }
    const previous = requiredCounter(
      row,
      "delivery_sequence_high_watermark",
    );
    const blockValues = [
      row["delivery_blocked_sequence"],
      row["delivery_blocked_operation_id"],
      row["delivery_blocked_at"],
      row["delivery_blocked_reason"],
    ];
    const nullBlockValues = blockValues.filter((value) => value === null)
      .length;
    if (nullBlockValues !== 0 && nullBlockValues !== blockValues.length) {
      throw new Error("Recipient delivery device block is incoherent");
    }
    if (!["pending", "active"].includes(requiredString(row, "state"))) {
      throw new Error("Recipient delivery device is not authorized");
    }
    if (nullBlockValues === 0) {
      requiredCounter(row, "delivery_blocked_sequence");
      throw new Error("Recipient delivery device requires resync");
    }
    const acknowledged = requiredCounter(
      row,
      "delivery_acknowledged_sequence",
    );
    const firstUnresolvedExpiry = row["first_unresolved_expires_at_ms"] === null
      ? null
      : requiredCounter(row, "first_unresolved_expires_at_ms");
    if (previous > acknowledged && firstUnresolvedExpiry === null) {
      throw new Error("Recipient delivery queue head is missing");
    }
    if (
      firstUnresolvedExpiry !== null
      && firstUnresolvedExpiry <= reservationAt
    ) {
      throw new Error("Recipient delivery queue has an expired delivery");
    }
    const count = counts.get(deviceId);
    if (
      count === undefined
      || !Number.isSafeInteger(previous + count)
    ) {
      throw new RangeError("Recipient delivery sequence is unsafe");
    }
    await expectSingleMutation(
      executor,
      `UPDATE human_crypto_devices
          SET delivery_sequence_high_watermark = $2
        WHERE device_id = $1
          AND delivery_sequence_high_watermark = $3
        RETURNING device_id`,
      [deviceId, previous + count, previous],
    );
    nextByDevice.set(deviceId, previous + 1);
  }
  return Object.freeze(recipientDeviceIds.map((deviceId) => {
    const next = nextByDevice.get(deviceId);
    if (next === undefined) {
      throw new Error("Recipient delivery sequence reservation was lost");
    }
    nextByDevice.set(deviceId, next + 1);
    return next;
  }));
}
