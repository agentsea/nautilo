import { createHash } from "node:crypto";
import {
  and,
  alias,
  CRYPTO_DELIVERY_COLLECTION_LIMITS,
  cryptoDeliveryOperations,
  cryptoDomainTransitionNamespaces,
  cryptoDomainTransitionSteps,
  cryptoHumanMembershipTransitions,
  cryptoOperationOutbox,
  eq,
  gt,
  humanCryptoDeviceChallenges,
  humanCryptoDevices,
  isNull,
  ne,
  notInArray,
  sql,
} from "@nautilo/db";
import { DELIVERY_LEASE_TTL_MS } from "../../delivery/delivery-work-lease.ts";
import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  type CryptoPostgresHandle,
  type CryptoPostgresTransaction,
} from "../storage/postgres-lattice-storage.ts";
import type { DatabaseRow } from "../storage/postgres-record-codecs.ts";

const CLAIM_SCAN_LIMIT = 64;
const HUMAN_MEMBERSHIP_OPERATION_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const NO_LIVE_COMMITTER = "no_live_committer";

const LIVE_MEMBERSHIP_COMMITTER_SQL = `EXISTS (
  SELECT 1
    FROM crypto_human_membership_transitions membership
    JOIN crypto_domain_devices source_mapping
      ON source_mapping.domain_id = membership.old_domain_id
     AND source_mapping.human_id = ANY(membership.new_participants)
     AND source_mapping.removed_epoch IS NULL
     AND source_mapping.removed_at IS NULL
    JOIN human_crypto_devices committer
      ON committer.device_id = source_mapping.device_id
     AND committer.human_id = source_mapping.human_id
     AND committer.human_actor_id::text = source_mapping.human_id
     AND committer.state = 'active'
    JOIN human_crypto_custodies custody
      ON custody.human_id = committer.human_id
     AND custody.state = 'active'
    LEFT JOIN crypto_domain_devices target_mapping
      ON target_mapping.domain_id = membership.target_domain_id
     AND target_mapping.device_id = committer.device_id
     AND target_mapping.human_id = committer.human_id
     AND target_mapping.removed_epoch IS NULL
     AND target_mapping.removed_at IS NULL
   WHERE membership.operation_id = o.operation_id
     AND membership.activated_at IS NULL
     AND membership.released_at IS NULL
     AND (
       membership.target_domain_id IS NULL
       OR target_mapping.device_id IS NOT NULL
     )
)`;

type ReconciledOperationKind =
  | "device_add"
  | "device_recovery"
  | "device_revoke"
  | "human_add"
  | "human_remove";

export interface ClaimedDeliveryOperation {
  readonly operationId: string;
  readonly kind: ReconciledOperationKind;
  readonly workerId: string;
  readonly leaseExpiresAt: number;
}

export type ReconcileDeliveryOperationResult =
  | { readonly status: "lost_lease" | "no_action" }
  | {
    readonly status:
      | "failed"
      | "blocked_no_committer"
      | "preparing_domain"
      | "ready_to_activate"
      | "awaiting_committer"
      | "awaiting_delivery";
  };

function requiredString(row: DatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new TypeError(`Operation reconciliation column ${name} must be text`);
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
    throw new TypeError(
      `Operation reconciliation column ${name} must be a safe counter`,
    );
  }
  return normalized;
}

function nullableCounter(row: DatabaseRow, name: string): number | null {
  return row[name] === null ? null : requiredCounter(row, name);
}

function requiredBoolean(row: DatabaseRow, name: string): boolean {
  const value = row[name];
  if (typeof value !== "boolean") {
    throw new TypeError(
      `Operation reconciliation column ${name} must be boolean`,
    );
  }
  return value;
}

function isoTime(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError(
      "Operation reconciliation timestamp must be nonnegative",
    );
  }
  return new Date(milliseconds).toISOString();
}

function timestampSql(milliseconds: number) {
  return sql`${isoTime(milliseconds)}::timestamptz`;
}

function operationKind(row: DatabaseRow): ReconciledOperationKind {
  const kind = requiredString(row, "kind");
  if (
    kind !== "device_add"
    && kind !== "device_recovery"
    && kind !== "device_revoke"
    && kind !== "human_add"
    && kind !== "human_remove"
  ) {
    throw new TypeError("Operation kind is not reconciled by this worker");
  }
  return kind;
}

function failureOutboxToken(operationId: string): string {
  return createHash("sha256")
    .update("nautilo/crypto-operation-failed/v1\0")
    .update(operationId)
    .digest("hex");
}

function insertFailureOutbox(input: {
  readonly transaction: CryptoPostgresTransaction;
  readonly operationId: string;
  readonly failureCode: string;
  readonly now: string;
}): Promise<readonly DatabaseRow[]> {
  const token = failureOutboxToken(input.operationId);
  const payload = new TextEncoder().encode(JSON.stringify({
    formatVersion: 1,
    eventType: "crypto_operation_failed",
    operationId: input.operationId,
    failureCode: input.failureCode,
  }));
  const existing = alias(cryptoOperationOutbox, "existing");
  const priorFailed = sql<boolean>`bool_or(
    ${existing.deliveredAt} IS NULL AND ${existing.terminalAt} IS NOT NULL
  )`;
  return executeTypedCryptoQuery(
    input.transaction,
    cryptoTypedDb.insert(cryptoOperationOutbox).select(
      cryptoTypedDb.select({
        outboxId: sql<string>`${`outbox_failed_${token}`}`.as("outbox_id"),
        operationId: sql<string>`${input.operationId}`.as("operation_id"),
        sequence: sql<number>`coalesce(max(${existing.sequence}), 0) + 1`
          .as("sequence"),
        eventType: sql<string>`${"crypto_operation_failed"}`.as("event_type"),
        payloadBytes: sql<Uint8Array>`${payload}`.as("payload_bytes"),
        idempotencyKey: sql<string>`${`crypto-operation-failed/${token}`}`
          .as("idempotency_key"),
        claimedBy: sql<string | null>`NULL`.as("claimed_by"),
        claimExpiresAt: sql<Date | null>`NULL`.as("claim_expires_at"),
        attempts: sql<number>`0`.as("attempts"),
        maximumAttempts:
          sql<number>`${CRYPTO_DELIVERY_COLLECTION_LIMITS.maximumAttempts}`
            .as("maximum_attempts"),
        deliveredAt: sql<Date | null>`NULL`.as("delivered_at"),
        terminalAt: sql<Date | null>`CASE WHEN ${priorFailed}
          THEN ${input.now}::timestamptz ELSE NULL END`.as("terminal_at"),
        failureCode: sql<string | null>`CASE WHEN ${priorFailed}
          THEN 'prior_event_failed' ELSE NULL END`.as("failure_code"),
        createdAt: sql<Date>`${input.now}::timestamptz`.as("created_at"),
      }).from(existing).where(eq(existing.operationId, input.operationId)),
    ).onConflictDoNothing({ target: cryptoOperationOutbox.outboxId })
      .returning({ outbox_id: cryptoOperationOutbox.outboxId }),
  );
}

export class PostgresDeliveryOperationReconciler {
  constructor(private readonly handle: CryptoPostgresHandle) {
    assertVerifiedCryptoPostgresHandle(handle);
  }

  claim(input: {
    readonly workerId: string;
    readonly now: number;
  }): Promise<ClaimedDeliveryOperation | null> {
    const now = isoTime(input.now);
    const leaseExpiresAt = input.now + DELIVERY_LEASE_TTL_MS;
    return this.handle.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      const rows = await transaction.query(
        `SELECT o.operation_id, o.kind, o.lease_owner,
                CASE WHEN o.lease_expires_at IS NULL THEN NULL
                     ELSE floor(
                       extract(epoch from o.lease_expires_at) * 1000
                     )::bigint
                END AS lease_expires_at_ms
           FROM crypto_delivery_operations o
          WHERE o.kind IN (
            'device_add', 'device_recovery', 'device_revoke',
            'human_add', 'human_remove'
          )
            AND o.state NOT IN ('active', 'failed', 'cancelled')
            AND (
              o.lease_owner IS NULL
              OR o.lease_expires_at <= $1::timestamptz
            )
            AND (
              (
                o.deadline_at <= $1::timestamptz
                AND NOT (
                  o.kind IN ('human_add', 'human_remove')
                  AND o.failure_code = '${NO_LIVE_COMMITTER}'
                )
              )
              OR EXISTS (
                SELECT 1 FROM crypto_domain_transition_steps failed_step
                 WHERE failed_step.operation_id = o.operation_id
                   AND failed_step.state = 'failed'
              )
              OR EXISTS (
                SELECT 1 FROM human_crypto_devices blocked_device
                 WHERE blocked_device.delivery_blocked_operation_id
                   = o.operation_id
              )
              OR EXISTS (
                SELECT 1 FROM human_crypto_device_challenges expired_challenge
                 WHERE expired_challenge.pending_device_id = o.target_device_id
                   AND expired_challenge.idempotency_key = o.idempotency_key
                   AND expired_challenge.consumed_at IS NULL
                   AND expired_challenge.invalidated_at IS NULL
                   AND expired_challenge.expires_at <= $1::timestamptz
              )
              OR (
                o.kind IN ('human_add', 'human_remove')
                AND o.state IN ('preparing_domain', 'awaiting_committer')
                AND (
                  (
                    o.failure_code IS NULL
                    AND NOT ${LIVE_MEMBERSHIP_COMMITTER_SQL}
                  )
                  OR (
                    o.failure_code = '${NO_LIVE_COMMITTER}'
                    AND ${LIVE_MEMBERSHIP_COMMITTER_SQL}
                  )
                )
              )
            )
          ORDER BY o.updated_at, o.operation_id
          LIMIT ${CLAIM_SCAN_LIMIT}
          FOR UPDATE OF o SKIP LOCKED`,
        [now],
      );
      if (rows.length === 0) return null;
      const candidate = rows[0]!;
      const operationId = requiredString(candidate, "operation_id");
      const priorOwner = nullableString(candidate, "lease_owner");
      const priorExpiry = nullableCounter(candidate, "lease_expires_at_ms");
      const priorLeaseMatches = priorOwner === null
        ? isNull(cryptoDeliveryOperations.leaseOwner)
        : priorExpiry === null
        ? sql<boolean>`false`
        : and(
          eq(cryptoDeliveryOperations.leaseOwner, priorOwner),
          eq(
            cryptoDeliveryOperations.leaseExpiresAt,
            timestampSql(priorExpiry),
          ),
        );
      const updated = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(cryptoDeliveryOperations).set({
          leaseOwner: input.workerId,
          leaseExpiresAt: timestampSql(leaseExpiresAt),
          updatedAt: timestampSql(input.now),
        }).where(and(
          eq(cryptoDeliveryOperations.operationId, operationId),
          notInArray(
            cryptoDeliveryOperations.state,
            ["active", "failed", "cancelled"],
          ),
          priorLeaseMatches,
        )).returning({
          operation_id: cryptoDeliveryOperations.operationId,
        }),
      );
      if (updated.length !== 1) {
        throw new Error("Operation reconciliation lease claim lost its CAS");
      }
      return Object.freeze({
        operationId,
        kind: operationKind(candidate),
        workerId: input.workerId,
        leaseExpiresAt,
      });
    });
  }

  heartbeat(input: {
    readonly claim: ClaimedDeliveryOperation;
    readonly now: number;
  }): Promise<ClaimedDeliveryOperation | null> {
    const leaseExpiresAt = input.now + DELIVERY_LEASE_TTL_MS;
    return this.handle.transaction(async (transaction) => {
      const now = timestampSql(input.now);
      const updated = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(cryptoDeliveryOperations).set({
          leaseExpiresAt: timestampSql(leaseExpiresAt),
          updatedAt: now,
        }).where(and(
          eq(
            cryptoDeliveryOperations.operationId,
            input.claim.operationId,
          ),
          eq(cryptoDeliveryOperations.leaseOwner, input.claim.workerId),
          eq(
            cryptoDeliveryOperations.leaseExpiresAt,
            timestampSql(input.claim.leaseExpiresAt),
          ),
          gt(cryptoDeliveryOperations.leaseExpiresAt, now),
          notInArray(
            cryptoDeliveryOperations.state,
            ["active", "failed", "cancelled"],
          ),
        )).returning({
          operation_id: cryptoDeliveryOperations.operationId,
        }),
      );
      return updated.length === 1
        ? Object.freeze({ ...input.claim, leaseExpiresAt })
        : null;
    });
  }

  reconcile(input: {
    readonly claim: ClaimedDeliveryOperation;
    readonly now: number;
  }): Promise<ReconcileDeliveryOperationResult> {
    const now = isoTime(input.now);
    return this.handle.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      const rows = await transaction.query(
        `SELECT o.operation_id, o.kind, o.state, o.target_device_id,
                o.idempotency_key, o.failure_code,
                (
                  SELECT membership.target_domain_id
                    FROM crypto_human_membership_transitions membership
                   WHERE membership.operation_id = o.operation_id
                   LIMIT 1
                ) AS membership_target_domain_id,
                CASE
                  WHEN o.kind IN ('human_add', 'human_remove')
                  THEN ${LIVE_MEMBERSHIP_COMMITTER_SQL}
                  ELSE false
                END AS membership_live_committer,
                o.deadline_at <= $5::timestamptz AS deadline_expired,
                (
                  SELECT count(*) FROM crypto_domain_transition_steps s
                   WHERE s.operation_id = o.operation_id
                     AND s.state = 'failed'
                )::bigint AS failed_step_count,
                (
                  SELECT count(*) FROM human_crypto_devices d
                   WHERE d.delivery_blocked_operation_id = o.operation_id
                )::bigint AS blocked_device_count,
                (
                  SELECT count(*) FROM human_crypto_device_challenges c
                   WHERE c.pending_device_id = o.target_device_id
                     AND c.idempotency_key = o.idempotency_key
                     AND c.consumed_at IS NULL
                     AND c.invalidated_at IS NULL
                     AND c.expires_at <= $5::timestamptz
                )::bigint AS expired_challenge_count
           FROM crypto_delivery_operations o
          WHERE o.operation_id = $1
            AND o.kind = $2
            AND o.lease_owner = $3
            AND o.lease_expires_at = $4::timestamptz
            AND o.lease_expires_at > $5::timestamptz
            AND o.state NOT IN ('active', 'failed', 'cancelled')
          LIMIT 2
          FOR UPDATE OF o`,
        [
          input.claim.operationId,
          input.claim.kind,
          input.claim.workerId,
          isoTime(input.claim.leaseExpiresAt),
          now,
        ],
      );
      if (rows.length !== 1) return { status: "lost_lease" };
      const operation = rows[0]!;
      const deadlineExpired = requiredBoolean(operation, "deadline_expired");
      const failedStepCount = requiredCounter(operation, "failed_step_count");
      const blockedDeviceCount = requiredCounter(
        operation,
        "blocked_device_count",
      );
      const expiredChallengeCount = requiredCounter(
        operation,
        "expired_challenge_count",
      );
      if (
        input.claim.kind === "human_add"
        || input.claim.kind === "human_remove"
      ) {
        const liveCommitter = requiredBoolean(
          operation,
          "membership_live_committer",
        );
        const failureCode = nullableString(operation, "failure_code");
        if (!liveCommitter || failureCode === NO_LIVE_COMMITTER) {
          return this.#reconcileHumanMembershipCommitter({
            transaction,
            claim: input.claim,
            now,
            resumeDeadline: isoTime(
              input.now + HUMAN_MEMBERSHIP_OPERATION_TTL_MS,
            ),
            liveCommitter,
            targetDomainId: nullableString(
              operation,
              "membership_target_domain_id",
            ),
          });
        }
      }
      if (
        !deadlineExpired
        && failedStepCount === 0
        && blockedDeviceCount === 0
        && expiredChallengeCount === 0
      ) {
        await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.update(cryptoDeliveryOperations).set({
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: sql`${now}::timestamptz`,
          }).where(and(
            eq(cryptoDeliveryOperations.operationId, input.claim.operationId),
            eq(cryptoDeliveryOperations.leaseOwner, input.claim.workerId),
            eq(
              cryptoDeliveryOperations.leaseExpiresAt,
              sql`${isoTime(input.claim.leaseExpiresAt)}::timestamptz`,
            ),
          )).returning({
            operation_id: cryptoDeliveryOperations.operationId,
          }),
        );
        return { status: "no_action" };
      }

      if (input.claim.kind === "device_revoke") {
        return this.#reconcileRevocation({
          transaction,
          claim: input.claim,
          now,
          deadlineExpired,
          blockedDeviceCount,
        });
      }
      if (
        input.claim.kind === "human_add"
        || input.claim.kind === "human_remove"
      ) {
        return this.#failHumanMembership({
          transaction,
          claim: input.claim,
          now,
          failureCode: deadlineExpired
            ? "operation_deadline_expired"
            : blockedDeviceCount > 0
            ? "delivery_expired"
            : "membership_transition_failed",
        });
      }
      return this.#failDeviceAdmission({
        transaction,
        claim: input.claim,
        operation,
        now,
        failureCode: deadlineExpired
          ? "operation_deadline_expired"
          : expiredChallengeCount > 0
          ? "device_challenge_expired"
          : blockedDeviceCount > 0
          ? "delivery_expired"
          : "domain_transition_failed",
      });
    });
  }

  async #reconcileHumanMembershipCommitter(input: {
    readonly transaction: CryptoPostgresTransaction;
    readonly claim: ClaimedDeliveryOperation;
    readonly now: string;
    readonly resumeDeadline: string;
    readonly liveCommitter: boolean;
    readonly targetDomainId: string | null;
  }): Promise<ReconcileDeliveryOperationResult> {
    const resumedState = input.targetDomainId === null
      ? "preparing_domain"
      : "awaiting_committer";
    const rows = await input.transaction.query(
      input.liveCommitter
        ? `UPDATE crypto_delivery_operations
              SET state = $2, failure_code = NULL,
                  deadline_at = $3::timestamptz,
                  updated_at = $4::timestamptz,
                  lease_owner = NULL, lease_expires_at = NULL
            WHERE operation_id = $1
              AND kind = $5
              AND failure_code = '${NO_LIVE_COMMITTER}'
              AND lease_owner = $6
              AND lease_expires_at = $7::timestamptz
              AND state NOT IN ('active', 'failed', 'cancelled')
            RETURNING operation_id`
        : `UPDATE crypto_delivery_operations
              SET state = 'awaiting_committer',
                  failure_code = '${NO_LIVE_COMMITTER}',
                  updated_at = $2::timestamptz,
                  lease_owner = NULL, lease_expires_at = NULL
            WHERE operation_id = $1
              AND kind = $3
              AND failure_code IS NULL
              AND lease_owner = $4
              AND lease_expires_at = $5::timestamptz
              AND state NOT IN ('active', 'failed', 'cancelled')
            RETURNING operation_id`,
      input.liveCommitter
        ? [
          input.claim.operationId,
          resumedState,
          input.resumeDeadline,
          input.now,
          input.claim.kind,
          input.claim.workerId,
          isoTime(input.claim.leaseExpiresAt),
        ]
        : [
          input.claim.operationId,
          input.now,
          input.claim.kind,
          input.claim.workerId,
          isoTime(input.claim.leaseExpiresAt),
        ],
    );
    if (rows.length !== 1) {
      throw new Error(
        "Human membership committer reconciliation lost its CAS",
      );
    }
    return {
      status: input.liveCommitter
        ? resumedState
        : "blocked_no_committer",
    };
  }

  async #failHumanMembership(input: {
    readonly transaction: CryptoPostgresTransaction;
    readonly claim: ClaimedDeliveryOperation;
    readonly now: string;
    readonly failureCode: string;
  }): Promise<ReconcileDeliveryOperationResult> {
    const released = await executeTypedCryptoQuery(
      input.transaction,
      cryptoTypedDb.update(cryptoHumanMembershipTransitions).set({
        releasedAt: sql`${input.now}::timestamptz`,
      }).where(and(
        eq(
          cryptoHumanMembershipTransitions.operationId,
          input.claim.operationId,
        ),
        isNull(cryptoHumanMembershipTransitions.releasedAt),
      )).returning({
        operation_id: cryptoHumanMembershipTransitions.operationId,
      }),
    );
    if (released.length !== 1) {
      throw new Error(
        "Human membership reconciliation release lost its CAS",
      );
    }
    const terminal = await executeTypedCryptoQuery(
      input.transaction,
      cryptoTypedDb.update(cryptoDeliveryOperations).set({
        state: "failed",
        failureCode: input.failureCode,
        updatedAt: sql`${input.now}::timestamptz`,
        terminalAt: sql`${input.now}::timestamptz`,
        leaseOwner: null,
        leaseExpiresAt: null,
      }).where(and(
        eq(cryptoDeliveryOperations.operationId, input.claim.operationId),
        eq(cryptoDeliveryOperations.kind, input.claim.kind),
        eq(cryptoDeliveryOperations.leaseOwner, input.claim.workerId),
        eq(
          cryptoDeliveryOperations.leaseExpiresAt,
          sql`${isoTime(input.claim.leaseExpiresAt)}::timestamptz`,
        ),
        notInArray(cryptoDeliveryOperations.state, [
          "active",
          "failed",
          "cancelled",
        ]),
      )).returning({ operation_id: cryptoDeliveryOperations.operationId }),
    );
    if (terminal.length !== 1) {
      throw new Error("Human membership reconciliation terminal CAS failed");
    }
    await insertFailureOutbox({
      transaction: input.transaction,
      operationId: input.claim.operationId,
      failureCode: input.failureCode,
      now: input.now,
    });
    return { status: "failed" };
  }

  async #failDeviceAdmission(input: {
    readonly transaction: CryptoPostgresTransaction;
    readonly claim: ClaimedDeliveryOperation;
    readonly operation: DatabaseRow;
    readonly now: string;
    readonly failureCode: string;
  }): Promise<ReconcileDeliveryOperationResult> {
    const targetDeviceId = requiredString(
      input.operation,
      "target_device_id",
    );
    await executeTypedCryptoQuery(
      input.transaction,
      cryptoTypedDb.update(cryptoDomainTransitionSteps).set({
        state: "failed",
        leaseOwner: null,
        leaseExpiresAt: null,
        failureCode: "operation_aborted",
        updatedAt: sql`${input.now}::timestamptz`,
      }).where(and(
        eq(cryptoDomainTransitionSteps.operationId, input.claim.operationId),
        notInArray(cryptoDomainTransitionSteps.state, ["active", "failed"]),
      )).returning({ domain_id: cryptoDomainTransitionSteps.domainId }),
    );
    await executeTypedCryptoQuery(
      input.transaction,
      cryptoTypedDb.update(cryptoDomainTransitionNamespaces).set({
        state: "failed",
        failureCode: "operation_aborted",
        updatedAt: sql`${input.now}::timestamptz`,
      }).where(and(
        eq(
          cryptoDomainTransitionNamespaces.operationId,
          input.claim.operationId,
        ),
        ne(cryptoDomainTransitionNamespaces.state, "active"),
      )).returning({
        namespace_id: cryptoDomainTransitionNamespaces.namespaceId,
      }),
    );
    const rejected = await executeTypedCryptoQuery(
      input.transaction,
      cryptoTypedDb.update(humanCryptoDevices).set({
        state: "rejected",
        rejectedAt: sql`${input.now}::timestamptz`,
        revision: sql`${humanCryptoDevices.revision} + 1`,
      }).where(and(
        eq(humanCryptoDevices.deviceId, targetDeviceId),
        eq(humanCryptoDevices.state, "pending"),
      )).returning({ device_id: humanCryptoDevices.deviceId }),
    );
    if (rejected.length !== 1) {
      throw new Error("Operation reconciliation device rejection lost its CAS");
    }
    await executeTypedCryptoQuery(
      input.transaction,
      cryptoTypedDb.update(humanCryptoDeviceChallenges).set({
        invalidatedAt: sql`${input.now}::timestamptz`,
        terminalResultCode: input.failureCode,
        revision: sql`${humanCryptoDeviceChallenges.revision} + 1`,
      }).where(and(
        eq(humanCryptoDeviceChallenges.pendingDeviceId, targetDeviceId),
        eq(
          humanCryptoDeviceChallenges.idempotencyKey,
          requiredString(input.operation, "idempotency_key"),
        ),
        isNull(humanCryptoDeviceChallenges.consumedAt),
        isNull(humanCryptoDeviceChallenges.invalidatedAt),
      )).returning({
        challenge_id: humanCryptoDeviceChallenges.challengeId,
      }),
    );
    const terminal = await executeTypedCryptoQuery(
      input.transaction,
      cryptoTypedDb.update(cryptoDeliveryOperations).set({
        state: "failed",
        failureCode: input.failureCode,
        updatedAt: sql`${input.now}::timestamptz`,
        terminalAt: sql`${input.now}::timestamptz`,
        leaseOwner: null,
        leaseExpiresAt: null,
      }).where(and(
        eq(cryptoDeliveryOperations.operationId, input.claim.operationId),
        eq(cryptoDeliveryOperations.leaseOwner, input.claim.workerId),
        eq(
          cryptoDeliveryOperations.leaseExpiresAt,
          sql`${isoTime(input.claim.leaseExpiresAt)}::timestamptz`,
        ),
        notInArray(cryptoDeliveryOperations.state, [
          "active",
          "failed",
          "cancelled",
        ]),
      )).returning({ operation_id: cryptoDeliveryOperations.operationId }),
    );
    if (terminal.length !== 1) {
      throw new Error("Operation reconciliation terminal CAS failed");
    }
    await insertFailureOutbox({
      transaction: input.transaction,
      operationId: input.claim.operationId,
      failureCode: input.failureCode,
      now: input.now,
    });
    return { status: "failed" };
  }

  async #reconcileRevocation(input: {
    readonly transaction: CryptoPostgresTransaction;
    readonly claim: ClaimedDeliveryOperation;
    readonly now: string;
    readonly deadlineExpired: boolean;
    readonly blockedDeviceCount: number;
  }): Promise<ReconcileDeliveryOperationResult> {
    if (input.deadlineExpired) {
      await executeTypedCryptoQuery(
        input.transaction,
        cryptoTypedDb.update(cryptoDomainTransitionSteps).set({
          state: "failed",
          leaseOwner: null,
          leaseExpiresAt: null,
          failureCode: "domain_rebootstrap_required",
          updatedAt: sql`${input.now}::timestamptz`,
        }).where(and(
          eq(cryptoDomainTransitionSteps.operationId, input.claim.operationId),
          notInArray(cryptoDomainTransitionSteps.state, ["active", "failed"]),
        )).returning({ domain_id: cryptoDomainTransitionSteps.domainId }),
      );
    } else if (input.blockedDeviceCount > 0) {
      await executeTypedCryptoQuery(
        input.transaction,
        cryptoTypedDb.update(cryptoDomainTransitionSteps).set({
          state: "failed",
          leaseOwner: null,
          leaseExpiresAt: null,
          failureCode: "domain_rebootstrap_required",
          updatedAt: sql`${input.now}::timestamptz`,
        }).where(and(
          eq(cryptoDomainTransitionSteps.operationId, input.claim.operationId),
          notInArray(cryptoDomainTransitionSteps.state, ["active", "failed"]),
          sql`EXISTS (
            SELECT 1 FROM crypto_delivery_messages message
            JOIN human_crypto_devices device
              ON device.device_id = message.recipient_device_id
             AND device.delivery_blocked_operation_id = message.operation_id
             AND device.delivery_blocked_sequence = message.recipient_sequence
           WHERE message.operation_id = ${cryptoDomainTransitionSteps.operationId}
             AND message.domain_id = ${cryptoDomainTransitionSteps.domainId}
          )`,
        )).returning({ domain_id: cryptoDomainTransitionSteps.domainId }),
      );
    }
    await executeTypedCryptoQuery(
      input.transaction,
      cryptoTypedDb.update(cryptoDomainTransitionSteps).set({
        failureCode: "domain_rebootstrap_required",
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: sql`${input.now}::timestamptz`,
      }).where(and(
        eq(cryptoDomainTransitionSteps.operationId, input.claim.operationId),
        eq(cryptoDomainTransitionSteps.state, "failed"),
        ne(
          cryptoDomainTransitionSteps.failureCode,
          "domain_rebootstrap_required",
        ),
      )).returning({ domain_id: cryptoDomainTransitionSteps.domainId }),
    );
    await executeTypedCryptoQuery(
      input.transaction,
      cryptoTypedDb.update(cryptoDomainTransitionNamespaces).set({
        state: "failed",
        failureCode: "domain_rebootstrap_required",
        updatedAt: sql`${input.now}::timestamptz`,
      }).where(and(
        eq(
          cryptoDomainTransitionNamespaces.operationId,
          input.claim.operationId,
        ),
        ne(cryptoDomainTransitionNamespaces.state, "active"),
        sql`EXISTS (
          SELECT 1 FROM crypto_domain_transition_steps failed_step
           WHERE failed_step.operation_id = ${cryptoDomainTransitionNamespaces.operationId}
             AND failed_step.domain_id = ${cryptoDomainTransitionNamespaces.domainId}
             AND failed_step.state = 'failed'
        )`,
      )).returning({
        namespace_id: cryptoDomainTransitionNamespaces.namespaceId,
      }),
    );
    const states = await executeTypedCryptoQuery(
      input.transaction,
      cryptoTypedDb.select({
        remaining_count: sql<bigint>`count(*) FILTER (
          WHERE ${cryptoDomainTransitionSteps.state}
            NOT IN ('ready_to_activate', 'failed')
        )::bigint`.as("remaining_count"),
        committer_count: sql<bigint>`count(*) FILTER (
          WHERE ${cryptoDomainTransitionSteps.state}
            IN ('awaiting_committer', 'preparing')
        )::bigint`.as("committer_count"),
      }).from(cryptoDomainTransitionSteps).where(eq(
        cryptoDomainTransitionSteps.operationId,
        input.claim.operationId,
      )),
    );
    if (states.length !== 1) {
      throw new Error("Revocation reconciliation state is inconsistent");
    }
    const remainingCount = requiredCounter(states[0]!, "remaining_count");
    const committerCount = requiredCounter(states[0]!, "committer_count");
    const state = remainingCount === 0
      ? "ready_to_activate"
      : committerCount > 0
      ? "awaiting_committer"
      : "awaiting_delivery";
    const updated = await executeTypedCryptoQuery(
      input.transaction,
      cryptoTypedDb.update(cryptoDeliveryOperations).set({
        state,
        updatedAt: sql`${input.now}::timestamptz`,
        leaseOwner: null,
        leaseExpiresAt: null,
      }).where(and(
        eq(cryptoDeliveryOperations.operationId, input.claim.operationId),
        eq(cryptoDeliveryOperations.kind, "device_revoke"),
        eq(cryptoDeliveryOperations.leaseOwner, input.claim.workerId),
        eq(
          cryptoDeliveryOperations.leaseExpiresAt,
          sql`${isoTime(input.claim.leaseExpiresAt)}::timestamptz`,
        ),
        notInArray(cryptoDeliveryOperations.state, [
          "active",
          "failed",
          "cancelled",
        ]),
      )).returning({ operation_id: cryptoDeliveryOperations.operationId }),
    );
    if (updated.length !== 1) {
      throw new Error("Revocation reconciliation operation CAS failed");
    }
    return { status: state };
  }
}
