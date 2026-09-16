import {
  and,
  cryptoDomainTransitionSteps,
  eq,
  gt,
  isNull,
  sql,
} from "@nautilo/db";
import {
  DELIVERY_LEASE_TTL_MS,
  DELIVERY_MAXIMUM_ATTEMPTS,
  deliveryRetryAtMs,
  failDeliveryWorkLease,
  type DeliveryWorkState,
} from "../../delivery/delivery-work-lease.ts";
import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import type { DatabaseRow } from "../storage/postgres-record-codecs.ts";

const CLAIM_SCAN_LIMIT = 64;

export interface ClaimedDomainTransition {
  readonly operationId: string;
  readonly domainId: string;
  readonly state: Exclude<DeliveryWorkState, "active" | "failed">;
  readonly workerId: string;
  readonly retryCount: number;
  readonly leaseExpiresAt: number;
}

function requiredString(row: DatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new TypeError(`Crypto delivery column ${name} must be text`);
  }
  return value;
}

function nullableString(row: DatabaseRow, name: string): string | null {
  return row[name] === null ? null : requiredString(row, name);
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
    throw new TypeError(`Crypto delivery column ${name} must be a safe counter`);
  }
  return normalized;
}

function nullableCounter(row: DatabaseRow, name: string): number | null {
  return row[name] === null ? null : requiredCounter(row, name);
}

function isoTime(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError("Crypto delivery timestamp must be nonnegative");
  }
  return new Date(milliseconds).toISOString();
}

function timestampSql(milliseconds: number) {
  return sql`${isoTime(milliseconds)}::timestamptz`;
}

function workState(row: DatabaseRow): ClaimedDomainTransition["state"] {
  const state = requiredString(row, "state");
  if (
    state !== "awaiting_committer"
    && state !== "preparing"
    && state !== "awaiting_delivery"
    && state !== "ready_to_activate"
  ) {
    throw new TypeError("Domain transition state is not claimable");
  }
  return state;
}

export class PostgresDomainTransitionLeaseRepository {
  constructor(private readonly handle: CryptoPostgresHandle) {
    assertVerifiedCryptoPostgresHandle(handle);
  }

  claim(input: {
    readonly workerId: string;
    readonly now: number;
  }): Promise<ClaimedDomainTransition | null> {
    return this.handle.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      const candidates = await transaction.query(
        `SELECT s.operation_id, s.domain_id, s.state, s.lease_owner,
                CASE WHEN s.lease_expires_at IS NULL THEN NULL
                     ELSE floor(extract(epoch from s.lease_expires_at) * 1000)::bigint
                END AS lease_expires_at_ms,
                s.retry_count, s.failure_code,
                floor(extract(epoch from s.updated_at) * 1000)::bigint
                  AS updated_at_ms
           FROM crypto_domain_transition_steps s
           JOIN crypto_delivery_operations o
             ON o.operation_id = s.operation_id
          WHERE s.state IN (
                  'awaiting_committer', 'preparing'
                )
            AND s.committer_device_id IS NOT NULL
            AND s.retry_count < ${DELIVERY_MAXIMUM_ATTEMPTS}
            AND (
              s.lease_owner IS NULL
              OR s.lease_expires_at <= $1::timestamptz
            )
            AND o.state NOT IN ('active', 'failed', 'cancelled')
            AND (
              o.lease_owner IS NULL
              OR o.lease_expires_at <= $1::timestamptz
            )
          ORDER BY s.updated_at, s.operation_id, s.domain_id
          LIMIT ${CLAIM_SCAN_LIMIT}
          FOR UPDATE OF s SKIP LOCKED`,
        [isoTime(input.now)],
      );
      const candidate = candidates.find((row) => {
        const retryCount = requiredCounter(row, "retry_count");
        const updatedAt = requiredCounter(row, "updated_at_ms");
        return input.now >= deliveryRetryAtMs(
          `${requiredString(row, "operation_id")}/${
            requiredString(row, "domain_id")
          }`,
          retryCount,
          updatedAt,
        );
      });
      if (candidate === undefined) return null;
      const operationId = requiredString(candidate, "operation_id");
      const domainId = requiredString(candidate, "domain_id");
      const state = workState(candidate);
      const retryCount = requiredCounter(candidate, "retry_count");
      const priorOwner = nullableString(candidate, "lease_owner");
      const priorExpiry = nullableCounter(candidate, "lease_expires_at_ms");
      const leaseExpiresAt = input.now + DELIVERY_LEASE_TTL_MS;
      const priorLeaseMatches = priorOwner === null
        ? isNull(cryptoDomainTransitionSteps.leaseOwner)
        : priorExpiry === null
        ? sql<boolean>`false`
        : and(
          eq(cryptoDomainTransitionSteps.leaseOwner, priorOwner),
          eq(
            cryptoDomainTransitionSteps.leaseExpiresAt,
            timestampSql(priorExpiry),
          ),
        );
      const updated = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(cryptoDomainTransitionSteps).set({
          leaseOwner: input.workerId,
          leaseExpiresAt: timestampSql(leaseExpiresAt),
          updatedAt: timestampSql(input.now),
        }).where(and(
          eq(cryptoDomainTransitionSteps.operationId, operationId),
          eq(cryptoDomainTransitionSteps.domainId, domainId),
          eq(cryptoDomainTransitionSteps.state, state),
          eq(cryptoDomainTransitionSteps.retryCount, retryCount),
          priorLeaseMatches,
        )).returning({
          operation_id: cryptoDomainTransitionSteps.operationId,
          domain_id: cryptoDomainTransitionSteps.domainId,
        }),
      );
      if (updated.length !== 1) {
        throw new Error("Domain transition lease claim lost its CAS");
      }
      return Object.freeze({
        operationId,
        domainId,
        state,
        workerId: input.workerId,
        retryCount,
        leaseExpiresAt,
      });
    });
  }

  /**
   * Claims one exact client-authorized transition instead of scanning the
   * global worker queue. Production additional-device approval uses this to
   * ensure an HTTP request can never lease another Human's operation.
   */
  claimExact(input: {
    readonly operationId: string;
    readonly domainId: string;
    readonly workerId: string;
    readonly now: number;
  }): Promise<ClaimedDomainTransition | null> {
    const leaseExpiresAt = input.now + DELIVERY_LEASE_TTL_MS;
    return this.handle.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      const rows = await transaction.query(
        `SELECT s.operation_id, s.domain_id, s.state,
                s.lease_owner,
                CASE WHEN s.lease_expires_at IS NULL THEN NULL
                     ELSE floor(extract(epoch from s.lease_expires_at) * 1000)::bigint
                END AS lease_expires_at_ms,
                s.retry_count,
                floor(extract(epoch from s.updated_at) * 1000)::bigint
                  AS updated_at_ms
           FROM crypto_domain_transition_steps s
           JOIN crypto_delivery_operations o
             ON o.operation_id = s.operation_id
          WHERE s.operation_id = $1
            AND s.domain_id = $2
            AND s.state IN ('awaiting_committer', 'preparing')
            AND s.committer_device_id IS NOT NULL
            AND s.retry_count < ${DELIVERY_MAXIMUM_ATTEMPTS}
            AND (
              s.lease_owner IS NULL
              OR s.lease_expires_at <= $3::timestamptz
              OR (
                s.lease_owner = $4
                AND s.lease_expires_at > $3::timestamptz
              )
            )
            AND o.state NOT IN ('active', 'failed', 'cancelled')
            AND (
              o.lease_owner IS NULL
              OR o.lease_expires_at <= $3::timestamptz
            )
          LIMIT 2
          FOR UPDATE OF s`,
        [input.operationId, input.domainId, isoTime(input.now), input.workerId],
      );
      if (rows.length !== 1) return null;
      const row = rows[0]!;
      const retryCount = requiredCounter(row, "retry_count");
      const updatedAt = requiredCounter(row, "updated_at_ms");
      if (input.now < deliveryRetryAtMs(
        `${input.operationId}/${input.domainId}`,
        retryCount,
        updatedAt,
      )) return null;
      const state = workState(row);
      const priorOwner = nullableString(row, "lease_owner");
      const priorExpiry = nullableCounter(row, "lease_expires_at_ms");
      if (
        priorOwner === input.workerId
        && priorExpiry !== null
        && priorExpiry > input.now
      ) {
        return Object.freeze({
          operationId: input.operationId,
          domainId: input.domainId,
          state,
          workerId: input.workerId,
          retryCount,
          leaseExpiresAt: priorExpiry,
        });
      }
      const updated = await transaction.query(
        `UPDATE crypto_domain_transition_steps
            SET lease_owner = $3,
                lease_expires_at = $4::timestamptz,
                updated_at = $5::timestamptz
          WHERE operation_id = $1
            AND domain_id = $2
            AND state = $6
            AND retry_count = $7
            AND (
              ($8::text IS NULL AND lease_owner IS NULL)
              OR (lease_owner = $8 AND lease_expires_at = $9::timestamptz)
            )
          RETURNING operation_id`,
        [
          input.operationId,
          input.domainId,
          input.workerId,
          isoTime(leaseExpiresAt),
          isoTime(input.now),
          state,
          retryCount,
          priorOwner,
          priorExpiry === null ? null : isoTime(priorExpiry),
        ],
      );
      if (updated.length !== 1) return null;
      return Object.freeze({
        operationId: input.operationId,
        domainId: input.domainId,
        state,
        workerId: input.workerId,
        retryCount,
        leaseExpiresAt,
      });
    });
  }

  heartbeat(input: {
    readonly claim: ClaimedDomainTransition;
    readonly now: number;
  }): Promise<ClaimedDomainTransition | null> {
    const leaseExpiresAt = input.now + DELIVERY_LEASE_TTL_MS;
    return this.handle.transaction(async (transaction) => {
      const now = timestampSql(input.now);
      const updated = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(cryptoDomainTransitionSteps).set({
          leaseExpiresAt: timestampSql(leaseExpiresAt),
          updatedAt: now,
        }).where(and(
          eq(
            cryptoDomainTransitionSteps.operationId,
            input.claim.operationId,
          ),
          eq(cryptoDomainTransitionSteps.domainId, input.claim.domainId),
          eq(cryptoDomainTransitionSteps.leaseOwner, input.claim.workerId),
          eq(
            cryptoDomainTransitionSteps.leaseExpiresAt,
            timestampSql(input.claim.leaseExpiresAt),
          ),
          gt(cryptoDomainTransitionSteps.leaseExpiresAt, now),
        )).returning({
          operation_id: cryptoDomainTransitionSteps.operationId,
        }),
      );
      return updated.length === 1
        ? Object.freeze({ ...input.claim, leaseExpiresAt })
        : null;
    });
  }

  fail(input: {
    readonly claim: ClaimedDomainTransition;
    readonly now: number;
    readonly failureCode: string;
    readonly transient: boolean;
  }): Promise<{
    readonly status: "retry_scheduled" | "terminal_failure";
    readonly retryCount: number;
  } | { readonly status: "lost_lease" }> {
    const failed = failDeliveryWorkLease({
      work: {
        workId: `${input.claim.operationId}/${input.claim.domainId}`,
        state: input.claim.state,
        leaseOwner: input.claim.workerId,
        leaseExpiresAt: input.claim.leaseExpiresAt,
        retryCount: input.claim.retryCount,
        retryAt: 0,
        failureCode: null,
      },
      workerId: input.claim.workerId,
      now: input.now,
      failureCode: input.failureCode,
      transient: input.transient,
    });
    return this.handle.transaction(async (transaction) => {
      const updated = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(cryptoDomainTransitionSteps).set({
          state: failed.state,
          leaseOwner: null,
          leaseExpiresAt: null,
          failureCode: failed.failureCode,
          retryCount: failed.retryCount,
          updatedAt: timestampSql(input.now),
        }).where(and(
          eq(
            cryptoDomainTransitionSteps.operationId,
            input.claim.operationId,
          ),
          eq(cryptoDomainTransitionSteps.domainId, input.claim.domainId),
          eq(cryptoDomainTransitionSteps.leaseOwner, input.claim.workerId),
          eq(
            cryptoDomainTransitionSteps.leaseExpiresAt,
            timestampSql(input.claim.leaseExpiresAt),
          ),
          eq(
            cryptoDomainTransitionSteps.retryCount,
            input.claim.retryCount,
          ),
        )).returning({
          operation_id: cryptoDomainTransitionSteps.operationId,
          domain_id: cryptoDomainTransitionSteps.domainId,
        }),
      );
      if (updated.length !== 1) return { status: "lost_lease" };
      return {
        status: failed.state === "failed"
          ? "terminal_failure"
          : "retry_scheduled",
        retryCount: failed.retryCount,
      };
    });
  }
}
