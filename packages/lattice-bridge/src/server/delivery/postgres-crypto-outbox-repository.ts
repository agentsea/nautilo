import {
  and,
  CRYPTO_DELIVERY_BYTE_LIMITS,
  CRYPTO_DELIVERY_COLLECTION_LIMITS,
  cryptoOperationOutbox,
  eq,
  gt,
  isNull,
  sql,
} from "@nautilo/db";
import {
  DELIVERY_LEASE_TTL_MS,
  deliveryRetryAtMs,
} from "../../delivery/delivery-work-lease.ts";
import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import type { DatabaseRow } from "../storage/postgres-record-codecs.ts";

const CLAIM_SCAN_LIMIT = 64;

export interface ClaimedCryptoOutboxEvent {
  readonly outboxId: string;
  readonly operationId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly payloadBytes: Uint8Array;
  readonly idempotencyKey: string;
  readonly workerId: string;
  readonly attempts: number;
  readonly maximumAttempts: number;
  readonly leaseExpiresAt: number;
}

export type FailCryptoOutboxResult =
  | {
    readonly status: "retry_scheduled";
    readonly retryAt: number;
    readonly attempts: number;
  }
  | { readonly status: "terminal_failure"; readonly attempts: number }
  | { readonly status: "lost_lease" };

function requiredString(row: DatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new TypeError(`Crypto outbox column ${name} must be text`);
  }
  return value;
}

function nullableString(row: DatabaseRow, name: string): string | null {
  return row[name] === null ? null : requiredString(row, name);
}

function requiredBytes(row: DatabaseRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Crypto outbox column ${name} must be bytea`);
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
    throw new TypeError(`Crypto outbox column ${name} must be a safe counter`);
  }
  return normalized;
}

function nullableCounter(row: DatabaseRow, name: string): number | null {
  return row[name] === null ? null : requiredCounter(row, name);
}

function portable(label: string, value: string): void {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
  ) {
    throw new TypeError(`${label} must be a portable identifier`);
  }
}

function timestamp(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be nonnegative`);
  }
}

function isoTime(milliseconds: number): string {
  timestamp("Crypto outbox timestamp", milliseconds);
  return new Date(milliseconds).toISOString();
}

function timestampSql(milliseconds: number) {
  return sql`${isoTime(milliseconds)}::timestamptz`;
}

function assertClaim(claim: ClaimedCryptoOutboxEvent): void {
  portable("Crypto outbox id", claim.outboxId);
  portable("Crypto outbox operation id", claim.operationId);
  portable("Crypto outbox event type", claim.eventType);
  portable("Crypto outbox idempotency key", claim.idempotencyKey);
  portable("Crypto outbox worker id", claim.workerId);
  timestamp("Crypto outbox sequence", claim.sequence);
  timestamp("Crypto outbox attempt count", claim.attempts);
  timestamp("Crypto outbox maximum attempts", claim.maximumAttempts);
  timestamp("Crypto outbox lease expiry", claim.leaseExpiresAt);
  if (
    claim.attempts >= claim.maximumAttempts
    || claim.maximumAttempts !== CRYPTO_DELIVERY_COLLECTION_LIMITS.maximumAttempts
    || claim.payloadBytes.length < 1
    || claim.payloadBytes.length
      > CRYPTO_DELIVERY_BYTE_LIMITS.contentFreeOutboxPayload
  ) {
    throw new TypeError("Crypto outbox claim is malformed");
  }
}

export class PostgresCryptoOutboxRepository {
  constructor(private readonly handle: CryptoPostgresHandle) {
    assertVerifiedCryptoPostgresHandle(handle);
  }

  claim(input: {
    readonly workerId: string;
    readonly now: number;
  }): Promise<ClaimedCryptoOutboxEvent | null> {
    portable("Crypto outbox worker id", input.workerId);
    timestamp("Crypto outbox claim time", input.now);
    const leaseExpiresAt = input.now + DELIVERY_LEASE_TTL_MS;
    return this.handle.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      const rows = await transaction.query(
        `SELECT outbox.outbox_id, outbox.operation_id, outbox.sequence,
                outbox.event_type, outbox.payload_bytes,
                outbox.idempotency_key, outbox.claimed_by,
                CASE WHEN outbox.claim_expires_at IS NULL THEN NULL
                     ELSE floor(
                       extract(epoch from outbox.claim_expires_at) * 1000
                     )::bigint
                END AS claim_expires_at_ms,
                outbox.attempts, outbox.maximum_attempts
           FROM crypto_operation_outbox outbox
          WHERE outbox.delivered_at IS NULL
            AND outbox.terminal_at IS NULL
            AND outbox.attempts < outbox.maximum_attempts
            AND (
              outbox.claimed_by IS NULL
              OR outbox.claim_expires_at <= $1::timestamptz
            )
            AND NOT EXISTS (
              SELECT 1
                FROM crypto_operation_outbox prior
               WHERE prior.operation_id = outbox.operation_id
                 AND prior.sequence < outbox.sequence
                 AND prior.delivered_at IS NULL
            )
          ORDER BY outbox.created_at, outbox.operation_id, outbox.sequence
          LIMIT ${CLAIM_SCAN_LIMIT}
          FOR UPDATE OF outbox SKIP LOCKED`,
        [isoTime(input.now)],
      );
      const candidate = rows[0];
      if (candidate === undefined) return null;
      const outboxId = requiredString(candidate, "outbox_id");
      const priorOwner = nullableString(candidate, "claimed_by");
      const priorExpiry = nullableCounter(
        candidate,
        "claim_expires_at_ms",
      );
      const priorAttempts = requiredCounter(candidate, "attempts");
      const maximumAttempts = requiredCounter(
        candidate,
        "maximum_attempts",
      );
      if (
        rows.length > CLAIM_SCAN_LIMIT
        || maximumAttempts
          !== CRYPTO_DELIVERY_COLLECTION_LIMITS.maximumAttempts
        || priorAttempts >= maximumAttempts
      ) {
        throw new Error("Crypto outbox claim row is inconsistent");
      }
      const payloadBytes = requiredBytes(candidate, "payload_bytes");
      if (
        payloadBytes.length < 1
        || payloadBytes.length
          > CRYPTO_DELIVERY_BYTE_LIMITS.contentFreeOutboxPayload
      ) {
        throw new Error("Crypto outbox payload is out of bounds");
      }
      const priorClaimMatches = priorOwner === null
        ? isNull(cryptoOperationOutbox.claimedBy)
        : priorExpiry === null
        ? sql<boolean>`false`
        : and(
          eq(cryptoOperationOutbox.claimedBy, priorOwner),
          eq(
            cryptoOperationOutbox.claimExpiresAt,
            timestampSql(priorExpiry),
          ),
        );
      const updated = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(cryptoOperationOutbox).set({
          claimedBy: input.workerId,
          claimExpiresAt: timestampSql(leaseExpiresAt),
        }).where(and(
          eq(cryptoOperationOutbox.outboxId, outboxId),
          isNull(cryptoOperationOutbox.deliveredAt),
          isNull(cryptoOperationOutbox.terminalAt),
          eq(cryptoOperationOutbox.attempts, priorAttempts),
          priorClaimMatches,
        )).returning({ outbox_id: cryptoOperationOutbox.outboxId }),
      );
      if (updated.length !== 1) {
        throw new Error("Crypto outbox claim lost its compare-and-swap");
      }
      return Object.freeze({
        outboxId,
        operationId: requiredString(candidate, "operation_id"),
        sequence: requiredCounter(candidate, "sequence"),
        eventType: requiredString(candidate, "event_type"),
        payloadBytes: Uint8Array.from(payloadBytes),
        idempotencyKey: requiredString(candidate, "idempotency_key"),
        workerId: input.workerId,
        attempts: priorAttempts,
        maximumAttempts,
        leaseExpiresAt,
      });
    });
  }

  heartbeat(input: {
    readonly claim: ClaimedCryptoOutboxEvent;
    readonly now: number;
  }): Promise<ClaimedCryptoOutboxEvent | null> {
    assertClaim(input.claim);
    timestamp("Crypto outbox heartbeat time", input.now);
    const leaseExpiresAt = input.now + DELIVERY_LEASE_TTL_MS;
    return this.handle.transaction(async (transaction) => {
      const updated = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(cryptoOperationOutbox).set({
          claimExpiresAt: timestampSql(leaseExpiresAt),
        }).where(and(
          eq(cryptoOperationOutbox.outboxId, input.claim.outboxId),
          eq(cryptoOperationOutbox.claimedBy, input.claim.workerId),
          eq(
            cryptoOperationOutbox.claimExpiresAt,
            timestampSql(input.claim.leaseExpiresAt),
          ),
          gt(cryptoOperationOutbox.claimExpiresAt, timestampSql(input.now)),
          eq(cryptoOperationOutbox.attempts, input.claim.attempts),
          isNull(cryptoOperationOutbox.deliveredAt),
          isNull(cryptoOperationOutbox.terminalAt),
        )).returning({ outbox_id: cryptoOperationOutbox.outboxId }),
      );
      return updated.length === 1
        ? Object.freeze({ ...input.claim, leaseExpiresAt })
        : null;
    });
  }

  delivered(input: {
    readonly claim: ClaimedCryptoOutboxEvent;
    readonly now: number;
  }): Promise<"delivered" | "lost_lease"> {
    assertClaim(input.claim);
    timestamp("Crypto outbox delivery time", input.now);
    return this.handle.transaction(async (transaction) => {
      const deliveredAt = timestampSql(input.now);
      const updated = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(cryptoOperationOutbox).set({
          deliveredAt,
          claimedBy: null,
          claimExpiresAt: null,
          failureCode: null,
        }).where(and(
          eq(cryptoOperationOutbox.outboxId, input.claim.outboxId),
          eq(cryptoOperationOutbox.claimedBy, input.claim.workerId),
          eq(
            cryptoOperationOutbox.claimExpiresAt,
            timestampSql(input.claim.leaseExpiresAt),
          ),
          gt(cryptoOperationOutbox.claimExpiresAt, deliveredAt),
          eq(cryptoOperationOutbox.attempts, input.claim.attempts),
          isNull(cryptoOperationOutbox.deliveredAt),
          isNull(cryptoOperationOutbox.terminalAt),
        )).returning({ outbox_id: cryptoOperationOutbox.outboxId }),
      );
      return updated.length === 1 ? "delivered" : "lost_lease";
    });
  }

  fail(input: {
    readonly claim: ClaimedCryptoOutboxEvent;
    readonly now: number;
    readonly failureCode: string;
    readonly transient: boolean;
  }): Promise<FailCryptoOutboxResult> {
    assertClaim(input.claim);
    timestamp("Crypto outbox failure time", input.now);
    portable("Crypto outbox failure code", input.failureCode);
    const attempts = input.claim.attempts + 1;
    const terminal = !input.transient
      || attempts >= input.claim.maximumAttempts;
    const retryAt = terminal
      ? input.now
      : deliveryRetryAtMs(
        input.claim.outboxId,
        attempts,
        input.now,
      );
    return this.handle.transaction(async (transaction) => {
      const leaseCondition = and(
        eq(cryptoOperationOutbox.outboxId, input.claim.outboxId),
        eq(cryptoOperationOutbox.claimedBy, input.claim.workerId),
        eq(
          cryptoOperationOutbox.claimExpiresAt,
          timestampSql(input.claim.leaseExpiresAt),
        ),
        gt(cryptoOperationOutbox.claimExpiresAt, timestampSql(input.now)),
        eq(cryptoOperationOutbox.attempts, input.claim.attempts),
        isNull(cryptoOperationOutbox.deliveredAt),
        isNull(cryptoOperationOutbox.terminalAt),
      );
      const updated = await executeTypedCryptoQuery(
        transaction,
        terminal
          ? cryptoTypedDb.update(cryptoOperationOutbox).set({
            claimedBy: null,
            claimExpiresAt: null,
            terminalAt: timestampSql(input.now),
            failureCode: input.transient
              ? "maximum_attempts_reached"
              : input.failureCode,
            attempts,
          }).where(leaseCondition).returning({
            outbox_id: cryptoOperationOutbox.outboxId,
          })
          : cryptoTypedDb.update(cryptoOperationOutbox).set({
            claimExpiresAt: timestampSql(retryAt),
            failureCode: input.failureCode,
            attempts,
          }).where(leaseCondition).returning({
            outbox_id: cryptoOperationOutbox.outboxId,
          }),
      );
      if (updated.length !== 1) return { status: "lost_lease" };
      if (terminal) {
        await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.update(cryptoOperationOutbox).set({
            claimedBy: null,
            claimExpiresAt: null,
            terminalAt: timestampSql(input.now),
            failureCode: "prior_event_failed",
          }).where(and(
            eq(cryptoOperationOutbox.operationId, input.claim.operationId),
            gt(cryptoOperationOutbox.sequence, input.claim.sequence),
            isNull(cryptoOperationOutbox.deliveredAt),
            isNull(cryptoOperationOutbox.terminalAt),
          )).returning({ outbox_id: cryptoOperationOutbox.outboxId }),
        );
      }
      return terminal
        ? {
          status: "terminal_failure",
          attempts,
        }
        : {
          status: "retry_scheduled",
          retryAt,
          attempts,
        };
    });
  }
}
