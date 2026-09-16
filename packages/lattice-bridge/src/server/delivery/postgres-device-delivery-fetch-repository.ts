import {
  and,
  asc,
  CRYPTO_DELIVERY_BYTE_LIMITS,
  cryptoDeliveryMessages,
  cryptoDeliveryOperations,
  eq,
  gte,
  humanCryptoDevices,
  sql,
} from "@nautilo/db";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  assertDeviceDeliveryFetchProof,
  deviceDeliveryFetchSigningBytes,
  type DeviceDeliveryFetchProof,
} from "../../delivery/device-delivery-fetch.ts";
import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import type { DatabaseRow } from "../storage/postgres-record-codecs.ts";

export interface DeviceDeliveryMessage {
  readonly messageId: string;
  readonly operationId: string;
  readonly domainId: string | null;
  readonly domainSequence: number | null;
  readonly recipientSequence: number;
  readonly kind: string;
  readonly formatVersion: number;
  readonly payloadHash: Uint8Array;
  readonly payloadBytes: Uint8Array;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type FetchDeviceDeliveriesResult =
  | {
    readonly status: "messages";
    readonly acknowledgedThrough: number;
    readonly highWatermark: number;
    readonly messages: readonly DeviceDeliveryMessage[];
    readonly hasMore: boolean;
  }
  | {
    readonly status: "empty";
    readonly acknowledgedThrough: number;
    readonly highWatermark: number;
  }
  | {
    readonly status: "gap";
    readonly expectedSequence: number;
    readonly highWatermark: number;
  }
  | {
    readonly status: "expired";
    readonly sequence: number;
    readonly operationId: string;
  }
  | { readonly status: "rollback_detected" }
  | { readonly status: "denied" | "stale_state" };

function requiredString(row: DatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new TypeError(`Device delivery column ${name} must be text`);
  }
  return value;
}

function nullableString(row: DatabaseRow, name: string): string | null {
  return row[name] === null ? null : requiredString(row, name);
}

function requiredBytes(row: DatabaseRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Device delivery column ${name} must be bytea`);
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
      `Device delivery column ${name} must be a safe counter`,
    );
  }
  return normalized;
}

function nullableCounter(row: DatabaseRow, name: string): number | null {
  return row[name] === null ? null : requiredCounter(row, name);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function isoTime(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError("Device delivery fetch time must be nonnegative");
  }
  return new Date(milliseconds).toISOString();
}

export class PostgresDeviceDeliveryFetchRepository {
  readonly #crypto: LatticeCrypto;

  constructor(
    private readonly handle: CryptoPostgresHandle,
    crypto: LatticeCrypto,
  ) {
    assertVerifiedCryptoPostgresHandle(handle);
    this.#crypto = crypto;
  }

  fetch(input: {
    readonly proof: DeviceDeliveryFetchProof;
    readonly now: number;
  }): Promise<FetchDeviceDeliveriesResult> {
    assertDeviceDeliveryFetchProof(input.proof);
    isoTime(input.now);
    if (
      input.now < input.proof.issuedAt
      || input.now >= input.proof.expiresAt
    ) {
      return Promise.resolve({ status: "denied" });
    }
    return this.handle.transaction(async (transaction) => {
      await transaction.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const devices = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          device_id: humanCryptoDevices.deviceId,
          human_id: humanCryptoDevices.humanId,
          state: humanCryptoDevices.state,
          revision: humanCryptoDevices.revision,
          signing_public_key: humanCryptoDevices.signingPublicKey,
          delivery_sequence_high_watermark:
            humanCryptoDevices.deliverySequenceHighWatermark,
          delivery_acknowledged_sequence:
            humanCryptoDevices.deliveryAcknowledgedSequence,
          delivery_blocked_sequence: humanCryptoDevices.deliveryBlockedSequence,
          delivery_blocked_operation_id:
            humanCryptoDevices.deliveryBlockedOperationId,
          delivery_blocked_at_ms: sql<number | null>`case when
            ${humanCryptoDevices.deliveryBlockedAt} is null then null else
            floor(extract(epoch from ${humanCryptoDevices.deliveryBlockedAt})
              * 1000)::bigint end`.as("delivery_blocked_at_ms"),
          delivery_blocked_reason: humanCryptoDevices.deliveryBlockedReason,
        }).from(humanCryptoDevices).where(eq(
          humanCryptoDevices.deviceId,
          input.proof.deviceId,
        )).limit(2),
      );
      if (devices.length !== 1) return { status: "denied" };
      const device = devices[0]!;
      if (
        requiredString(device, "device_id") !== input.proof.deviceId
        || requiredString(device, "human_id") !== input.proof.humanId
        || requiredCounter(device, "revision")
          !== input.proof.expectedDeviceRevision
      ) return { status: "denied" };
      const state = requiredString(device, "state");
      if (state !== "pending" && state !== "active") {
        return { status: "denied" };
      }
      const signingPublicKey = requiredBytes(device, "signing_public_key");
      if (
        signingPublicKey.length !== 32
        || !this.#crypto.verify(
          signingPublicKey,
          deviceDeliveryFetchSigningBytes(input.proof),
          input.proof.signature,
        )
      ) return { status: "denied" };
      const highWatermark = requiredCounter(
        device,
        "delivery_sequence_high_watermark",
      );
      const acknowledgedThrough = requiredCounter(
        device,
        "delivery_acknowledged_sequence",
      );
      if (highWatermark < input.proof.minimumHighWatermark) {
        return { status: "rollback_detected" };
      }
      if (acknowledgedThrough > highWatermark) {
        return { status: "stale_state" };
      }
      const blockedSequence = nullableCounter(
        device,
        "delivery_blocked_sequence",
      );
      const blockedOperationId = nullableString(
        device,
        "delivery_blocked_operation_id",
      );
      const blockedReason = nullableString(
        device,
        "delivery_blocked_reason",
      );
      const blockedAt = nullableCounter(device, "delivery_blocked_at_ms");
      const nullBlockValues = [
        blockedSequence,
        blockedOperationId,
        blockedAt,
        blockedReason,
      ].filter((value) => value === null).length;
      if (nullBlockValues !== 0 && nullBlockValues !== 4) {
        return { status: "stale_state" };
      }
      if (blockedSequence !== null) {
        if (
          blockedSequence !== acknowledgedThrough + 1
          || blockedSequence > highWatermark
          || blockedOperationId === null
          || blockedAt === null
          || blockedReason !== "delivery_expired"
        ) return { status: "stale_state" };
        return {
          status: "expired",
          sequence: blockedSequence,
          operationId: blockedOperationId,
        };
      }
      const expectedSequence = acknowledgedThrough + 1;
      if (expectedSequence > highWatermark) {
        return {
          status: "empty",
          acknowledgedThrough,
          highWatermark,
        };
      }
      const rows = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          message_id: cryptoDeliveryMessages.messageId,
          operation_id: cryptoDeliveryMessages.operationId,
          domain_id: cryptoDeliveryMessages.domainId,
          domain_sequence: cryptoDeliveryMessages.domainSequence,
          recipient_sequence: cryptoDeliveryMessages.recipientSequence,
          kind: cryptoDeliveryMessages.kind,
          format_version: cryptoDeliveryMessages.formatVersion,
          payload_hash: cryptoDeliveryMessages.payloadHash,
          payload_bytes: cryptoDeliveryMessages.payloadBytes,
          created_at_ms: sql<number>`floor(extract(epoch from
            ${cryptoDeliveryMessages.createdAt}) * 1000)::bigint`
            .as("created_at_ms"),
          expires_at_ms: sql<number>`floor(extract(epoch from
            ${cryptoDeliveryMessages.expiresAt}) * 1000)::bigint`
            .as("expires_at_ms"),
          operation_kind: sql`${cryptoDeliveryOperations.kind}`
            .as("operation_kind"),
          operation_state: sql`${cryptoDeliveryOperations.state}`
            .as("operation_state"),
          operation_target_device_id:
            sql`${cryptoDeliveryOperations.targetDeviceId}`
              .as("operation_target_device_id"),
        }).from(cryptoDeliveryMessages).innerJoin(
          cryptoDeliveryOperations,
          eq(
            cryptoDeliveryOperations.operationId,
            cryptoDeliveryMessages.operationId,
          ),
        ).where(and(
          eq(cryptoDeliveryMessages.recipientDeviceId, input.proof.deviceId),
          gte(cryptoDeliveryMessages.recipientSequence, expectedSequence),
        )).orderBy(asc(cryptoDeliveryMessages.recipientSequence)).limit(
          input.proof.maximumMessages + 1,
        ),
      );
      if (rows.length === 0) {
        return { status: "gap", expectedSequence, highWatermark };
      }

      const messages: DeviceDeliveryMessage[] = [];
      let aggregatePayloadBytes = 0;
      let nextSequence = expectedSequence;
      let stoppedAtPayloadBound = false;
      for (const [index, row] of rows.entries()) {
        const recipientSequence = requiredCounter(
          row,
          "recipient_sequence",
        );
        if (recipientSequence !== nextSequence) {
          return {
            status: "gap",
            expectedSequence: nextSequence,
            highWatermark,
          };
        }
        nextSequence += 1;
        const operationId = requiredString(row, "operation_id");
        const operationState = requiredString(row, "operation_state");
        if (
          operationState === "failed"
          || operationState === "cancelled"
        ) return { status: "stale_state" };
        if (
          state === "pending"
          && (
            !["device_add", "device_recovery"].includes(
              requiredString(row, "operation_kind"),
            )
            || requiredString(row, "operation_target_device_id")
              !== input.proof.deviceId
          )
        ) return { status: "denied" };
        const expiresAt = requiredCounter(row, "expires_at_ms");
        if (input.now >= expiresAt) {
          return {
            status: "expired",
            sequence: recipientSequence,
            operationId,
          };
        }
        const payloadBytes = requiredBytes(row, "payload_bytes");
        const payloadHash = requiredBytes(row, "payload_hash");
        if (
          payloadBytes.length < 1
          || payloadBytes.length
            > CRYPTO_DELIVERY_BYTE_LIMITS.opaquePayload
          || payloadHash.length !== CRYPTO_DELIVERY_BYTE_LIMITS.hash
          || !equalBytes(this.#crypto.hash(payloadBytes), payloadHash)
        ) return { status: "stale_state" };
        if (
          index >= input.proof.maximumMessages
          || aggregatePayloadBytes + payloadBytes.length
            > input.proof.maximumPayloadBytes
        ) {
          stoppedAtPayloadBound = true;
          break;
        }
        aggregatePayloadBytes += payloadBytes.length;
        const domainId = nullableString(row, "domain_id");
        const domainSequence = nullableCounter(row, "domain_sequence");
        if ((domainId === null) !== (domainSequence === null)) {
          return { status: "stale_state" };
        }
        messages.push(Object.freeze({
          messageId: requiredString(row, "message_id"),
          operationId,
          domainId,
          domainSequence,
          recipientSequence,
          kind: requiredString(row, "kind"),
          formatVersion: requiredCounter(row, "format_version"),
          payloadHash: Uint8Array.from(payloadHash),
          payloadBytes: Uint8Array.from(payloadBytes),
          createdAt: requiredCounter(row, "created_at_ms"),
          expiresAt,
        }));
      }
      if (messages.length === 0) return { status: "stale_state" };
      const lastSequence = messages.at(-1)!.recipientSequence;
      if (
        !stoppedAtPayloadBound
        && rows.length <= input.proof.maximumMessages
        && lastSequence < highWatermark
      ) {
        return {
          status: "gap",
          expectedSequence: lastSequence + 1,
          highWatermark,
        };
      }
      return {
        status: "messages",
        acknowledgedThrough,
        highWatermark,
        messages: Object.freeze(messages),
        hasMore: lastSequence < highWatermark,
      };
    });
  }
}
