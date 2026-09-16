import {
  and,
  asc,
  CRYPTO_DELIVERY_COLLECTION_LIMITS,
  cryptoDeliveryAcknowledgements,
  cryptoDeliveryMessages,
  cryptoDeliveryOperations,
  eq,
  exists,
  humanCryptoDevices,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "@nautilo/db";
import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import type { DatabaseRow } from "../storage/postgres-record-codecs.ts";

function requiredString(row: DatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new TypeError(`Delivery maintenance column ${name} must be text`);
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
      `Delivery maintenance column ${name} must be a safe counter`,
    );
  }
  return normalized;
}

function requiredBoolean(row: DatabaseRow, name: string): boolean {
  const value = row[name];
  if (typeof value !== "boolean") {
    throw new TypeError(`Delivery maintenance column ${name} must be boolean`);
  }
  return value;
}

function isoTime(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError("Delivery maintenance timestamp must be nonnegative");
  }
  return new Date(milliseconds).toISOString();
}

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface PrunedDeliveryState {
  readonly challenges: number;
  readonly keyPackages: number;
  readonly acknowledgements: number;
  readonly messages: number;
  readonly outbox: number;
  readonly namespaceSteps: number;
  readonly domainSteps: number;
  readonly deviceOperations: number;
  readonly membershipTransitions: number;
  readonly operations: number;
}

export class PostgresDeliveryMaintenanceRepository {
  constructor(private readonly handle: CryptoPostgresHandle) {
    assertVerifiedCryptoPostgresHandle(handle);
  }

  async blockExpiredDeliveries(input: {
    readonly now: number;
  }): Promise<{ readonly scanned: number; readonly blocked: number }> {
    const now = isoTime(input.now);
    const candidates = await this.handle.transaction(async (transaction) => {
      await transaction.query(
        "SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ ONLY",
      );
      return executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          recipient_device_id: cryptoDeliveryMessages.recipientDeviceId,
          recipient_sequence: cryptoDeliveryMessages.recipientSequence,
          operation_id: cryptoDeliveryMessages.operationId,
        }).from(humanCryptoDevices).innerJoin(
          cryptoDeliveryMessages,
          and(
            eq(
              cryptoDeliveryMessages.recipientDeviceId,
              humanCryptoDevices.deviceId,
            ),
            eq(
              cryptoDeliveryMessages.recipientSequence,
              sql`${humanCryptoDevices.deliveryAcknowledgedSequence} + 1`,
            ),
          ),
        ).leftJoin(cryptoDeliveryAcknowledgements, and(
          eq(
            cryptoDeliveryAcknowledgements.messageId,
            cryptoDeliveryMessages.messageId,
          ),
          eq(
            cryptoDeliveryAcknowledgements.deviceId,
            cryptoDeliveryMessages.recipientDeviceId,
          ),
        )).where(and(
          inArray(humanCryptoDevices.state, ["pending", "active"]),
          isNull(humanCryptoDevices.deliveryBlockedSequence),
          lte(cryptoDeliveryMessages.expiresAt, sql`${now}::timestamptz`),
          isNull(cryptoDeliveryAcknowledgements.messageId),
        )).orderBy(
          asc(cryptoDeliveryMessages.expiresAt),
          asc(cryptoDeliveryMessages.recipientDeviceId),
          asc(cryptoDeliveryMessages.recipientSequence),
        ).limit(CRYPTO_DELIVERY_COLLECTION_LIMITS.pruningBatch),
      );
    });

    let blocked = 0;
    for (const candidate of candidates) {
      const deviceId = requiredString(candidate, "recipient_device_id");
      const sequence = requiredCounter(candidate, "recipient_sequence");
      const operationId = requiredString(candidate, "operation_id");
      blocked += await this.handle.transaction(async (transaction) => {
        await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
        const locks = await transaction.query(
          `SELECT pg_try_advisory_xact_lock(
             hashtextextended($1, 0)
           ) AS lock_acquired`,
          [`delivery-ack/${deviceId}`],
        );
        if (
          locks.length !== 1
          || !requiredBoolean(locks[0]!, "lock_acquired")
        ) return 0;

        const rows = await transaction.query(
          `SELECT d.device_id, d.state AS device_state,
                  d.delivery_acknowledged_sequence,
                  d.delivery_sequence_high_watermark,
                  d.delivery_blocked_sequence,
                  m.message_id,
                  m.operation_id AS message_operation_id,
                  m.recipient_sequence AS message_recipient_sequence,
                  o.operation_id
             FROM human_crypto_devices d
             JOIN crypto_delivery_messages m
               ON m.recipient_device_id = d.device_id
              AND m.recipient_sequence
                = d.delivery_acknowledged_sequence + 1
             JOIN crypto_delivery_operations o
               ON o.operation_id = m.operation_id
             LEFT JOIN crypto_delivery_acknowledgements a
               ON a.message_id = m.message_id
              AND a.device_id = m.recipient_device_id
            WHERE d.device_id = $1
              AND d.state IN ('pending', 'active')
              AND d.delivery_blocked_sequence IS NULL
              AND m.recipient_sequence = $2
              AND m.operation_id = $3
              AND m.expires_at <= $4::timestamptz
              AND a.message_id IS NULL
            LIMIT 2
            FOR UPDATE OF d, o`,
          [deviceId, sequence, operationId, now],
        );
        if (rows.length === 0) return 0;
        if (rows.length !== 1) {
          throw new Error("Expired delivery queue head is noncanonical");
        }
        const row = rows[0]!;
        if (
          requiredString(row, "device_id") !== deviceId
          || requiredString(row, "device_state") !== "active"
            && requiredString(row, "device_state") !== "pending"
          || requiredCounter(row, "delivery_acknowledged_sequence") + 1
            !== sequence
          || requiredCounter(row, "delivery_sequence_high_watermark")
            < sequence
          || row["delivery_blocked_sequence"] !== null
          || requiredString(row, "message_operation_id") !== operationId
          || requiredCounter(row, "message_recipient_sequence") !== sequence
          || requiredString(row, "operation_id") !== operationId
        ) {
          throw new Error("Expired delivery queue head is inconsistent");
        }
        const updated = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.update(humanCryptoDevices).set({
            deliveryBlockedSequence: sequence,
            deliveryBlockedOperationId: operationId,
            deliveryBlockedAt: sql`${now}::timestamptz`,
            deliveryBlockedReason: "delivery_expired",
          }).where(and(
            eq(humanCryptoDevices.deviceId, deviceId),
            inArray(humanCryptoDevices.state, ["pending", "active"]),
            eq(humanCryptoDevices.deliveryAcknowledgedSequence, sequence - 1),
            sql`${humanCryptoDevices.deliverySequenceHighWatermark}
              >= ${sequence}`,
            isNull(humanCryptoDevices.deliveryBlockedSequence),
          )).returning({ device_id: humanCryptoDevices.deviceId }),
        );
        if (updated.length !== 1) {
          throw new Error("Expired delivery block lost its compare-and-swap");
        }
        return 1;
      });
    }
    return Object.freeze({ scanned: candidates.length, blocked });
  }

  terminalizeBlockedOutboxTails(input: {
    readonly now: number;
  }): Promise<number> {
    const now = isoTime(input.now);
    return this.handle.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      const rows = await transaction.query(
        `WITH blocked_tail AS (
           SELECT current.outbox_id
             FROM crypto_operation_outbox current
            WHERE current.delivered_at IS NULL
              AND current.terminal_at IS NULL
              AND EXISTS (
                SELECT 1 FROM crypto_operation_outbox poison
                 WHERE poison.operation_id = current.operation_id
                   AND poison.sequence < current.sequence
                   AND poison.delivered_at IS NULL
                   AND poison.terminal_at IS NOT NULL
              )
            ORDER BY current.created_at, current.outbox_id
            LIMIT ${CRYPTO_DELIVERY_COLLECTION_LIMITS.pruningBatch}
            FOR UPDATE OF current SKIP LOCKED
         )
         UPDATE crypto_operation_outbox current
            SET terminal_at = $1::timestamptz,
                failure_code = 'prior_event_failed',
                claimed_by = NULL,
                claim_expires_at = NULL
           FROM blocked_tail
          WHERE current.outbox_id = blocked_tail.outbox_id
          RETURNING current.outbox_id`,
        [now],
      );
      return rows.length;
    });
  }

  pruneRetainedState(input: {
    readonly now: number;
  }): Promise<PrunedDeliveryState> {
    const now = isoTime(input.now);
    const rejectedChallengeCutoff = isoTime(
      Math.max(0, input.now - 7 * DAY_MS),
    );
    const consumedCutoff = isoTime(Math.max(0, input.now - 30 * DAY_MS));
    const terminalOperationCutoff = isoTime(
      Math.max(0, input.now - 90 * DAY_MS),
    );
    return this.handle.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      const challenges = await transaction.query(
        `WITH candidates AS (
           SELECT challenge_id
             FROM human_crypto_device_challenges
            WHERE kind <> 'initial_bootstrap'
              AND (
                (
                  invalidated_at IS NOT NULL
                  AND invalidated_at <= $1::timestamptz
                )
                OR (
                  consumed_at IS NOT NULL
                  AND consumed_at <= $2::timestamptz
                )
              )
            ORDER BY COALESCE(consumed_at, invalidated_at), challenge_id
            LIMIT ${CRYPTO_DELIVERY_COLLECTION_LIMITS.pruningBatch}
            FOR UPDATE SKIP LOCKED
         )
         DELETE FROM human_crypto_device_challenges current
          USING candidates
          WHERE current.challenge_id = candidates.challenge_id
          RETURNING current.challenge_id`,
        [rejectedChallengeCutoff, consumedCutoff],
      );
      const keyPackages = await transaction.query(
        `WITH candidates AS (
           SELECT device_id, generation, package_id
             FROM human_crypto_device_key_packages
            WHERE (
                consumed_at IS NOT NULL
                AND consumed_at <= $1::timestamptz
              ) OR (
                consumed_at IS NULL
                AND expires_at <= $2::timestamptz
              )
            ORDER BY COALESCE(consumed_at, expires_at),
                     device_id, generation, package_id
            LIMIT ${CRYPTO_DELIVERY_COLLECTION_LIMITS.pruningBatch}
            FOR UPDATE SKIP LOCKED
         )
         DELETE FROM human_crypto_device_key_packages current
          USING candidates
          WHERE current.device_id = candidates.device_id
            AND current.generation = candidates.generation
            AND current.package_id = candidates.package_id
          RETURNING current.package_id`,
        [consumedCutoff, rejectedChallengeCutoff],
      );
      const messageCandidates = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          message_id: cryptoDeliveryMessages.messageId,
        }).from(cryptoDeliveryMessages).innerJoin(
          cryptoDeliveryOperations,
          eq(
            cryptoDeliveryOperations.operationId,
            cryptoDeliveryMessages.operationId,
          ),
        ).innerJoin(humanCryptoDevices, eq(
          humanCryptoDevices.deviceId,
          cryptoDeliveryMessages.recipientDeviceId,
        )).where(and(
          ne(cryptoDeliveryOperations.kind, "first_device_bootstrap"),
          or(
            and(
              isNotNull(cryptoDeliveryOperations.terminalAt),
              lte(
                cryptoDeliveryOperations.terminalAt,
                sql`${consumedCutoff}::timestamptz`,
              ),
              exists(cryptoTypedDb.select({
                one: sql<number>`1`,
              }).from(cryptoDeliveryAcknowledgements).where(and(
                eq(
                  cryptoDeliveryAcknowledgements.messageId,
                  cryptoDeliveryMessages.messageId,
                ),
                eq(
                  cryptoDeliveryAcknowledgements.deviceId,
                  cryptoDeliveryMessages.recipientDeviceId,
                ),
              ))),
            ),
            and(
              eq(
                humanCryptoDevices.deliveryBlockedSequence,
                cryptoDeliveryMessages.recipientSequence,
              ),
              eq(
                humanCryptoDevices.deliveryBlockedOperationId,
                cryptoDeliveryMessages.operationId,
              ),
              lte(cryptoDeliveryMessages.expiresAt, sql`${now}::timestamptz`),
            ),
          ),
        )).orderBy(
          asc(cryptoDeliveryMessages.expiresAt),
          asc(cryptoDeliveryMessages.messageId),
        ).limit(CRYPTO_DELIVERY_COLLECTION_LIMITS.pruningBatch),
      );
      const messageIds = messageCandidates.map((row) =>
        requiredString(row, "message_id")
      );
      const acknowledgements = messageIds.length === 0
        ? []
        : await transaction.query(
          `DELETE FROM crypto_delivery_acknowledgements
            WHERE message_id = ANY($1::text[])
            RETURNING message_id`,
          [messageIds],
        );
      const messages = messageIds.length === 0
        ? []
        : await transaction.query(
          `DELETE FROM crypto_delivery_messages
            WHERE message_id = ANY($1::text[])
              AND NOT EXISTS (
                SELECT 1 FROM crypto_delivery_acknowledgements retained_ack
                 WHERE retained_ack.message_id
                   = crypto_delivery_messages.message_id
              )
            RETURNING message_id`,
          [messageIds],
        );
      const outbox = await transaction.query(
        `WITH candidates AS (
           SELECT current.outbox_id
             FROM crypto_operation_outbox current
             JOIN crypto_delivery_operations o
               ON o.operation_id = current.operation_id
            WHERE o.kind <> 'first_device_bootstrap'
              AND (
                current.delivered_at <= $1::timestamptz
                OR current.terminal_at <= $1::timestamptz
              )
            ORDER BY COALESCE(current.delivered_at, current.terminal_at),
                     current.outbox_id
            LIMIT ${CRYPTO_DELIVERY_COLLECTION_LIMITS.pruningBatch}
            FOR UPDATE OF current SKIP LOCKED
         )
         DELETE FROM crypto_operation_outbox current
          USING candidates
          WHERE current.outbox_id = candidates.outbox_id
          RETURNING current.outbox_id`,
        [rejectedChallengeCutoff],
      );
      const namespaceSteps = await transaction.query(
        `WITH candidates AS (
           SELECT n.operation_id, n.domain_id, n.namespace_id
             FROM crypto_domain_transition_namespaces n
             JOIN crypto_delivery_operations o
               ON o.operation_id = n.operation_id
            WHERE o.kind <> 'first_device_bootstrap'
              AND o.terminal_at <= $1::timestamptz
            ORDER BY o.terminal_at, n.operation_id, n.domain_id, n.namespace_id
            LIMIT ${CRYPTO_DELIVERY_COLLECTION_LIMITS.pruningBatch}
            FOR UPDATE OF n SKIP LOCKED
         )
         DELETE FROM crypto_domain_transition_namespaces current
          USING candidates
          WHERE current.operation_id = candidates.operation_id
            AND current.domain_id = candidates.domain_id
            AND current.namespace_id = candidates.namespace_id
          RETURNING current.namespace_id`,
        [terminalOperationCutoff],
      );
      const domainSteps = await transaction.query(
        `WITH candidates AS (
           SELECT s.operation_id, s.domain_id
             FROM crypto_domain_transition_steps s
             JOIN crypto_delivery_operations o
               ON o.operation_id = s.operation_id
            WHERE o.kind <> 'first_device_bootstrap'
              AND o.terminal_at <= $1::timestamptz
              AND NOT EXISTS (
                SELECT 1 FROM crypto_domain_transition_namespaces n
                 WHERE n.operation_id = s.operation_id
                   AND n.domain_id = s.domain_id
              )
            ORDER BY o.terminal_at, s.operation_id, s.domain_id
            LIMIT ${CRYPTO_DELIVERY_COLLECTION_LIMITS.pruningBatch}
            FOR UPDATE OF s SKIP LOCKED
         )
         DELETE FROM crypto_domain_transition_steps current
          USING candidates
          WHERE current.operation_id = candidates.operation_id
            AND current.domain_id = candidates.domain_id
          RETURNING current.domain_id`,
        [terminalOperationCutoff],
      );
      const deviceOperations = await transaction.query(
        `WITH candidates AS (
           SELECT e.operation_id
             FROM crypto_device_epoch_operations e
             JOIN crypto_delivery_operations o
               ON o.operation_id = e.operation_id
            WHERE o.kind <> 'first_device_bootstrap'
              AND o.terminal_at <= $1::timestamptz
            ORDER BY o.terminal_at, e.operation_id
            LIMIT ${CRYPTO_DELIVERY_COLLECTION_LIMITS.pruningBatch}
            FOR UPDATE OF e SKIP LOCKED
         )
         DELETE FROM crypto_device_epoch_operations current
          USING candidates
          WHERE current.operation_id = candidates.operation_id
          RETURNING current.operation_id`,
        [terminalOperationCutoff],
      );
      const membershipTransitions = await transaction.query(
        `WITH candidates AS (
           SELECT h.operation_id
             FROM crypto_human_membership_transitions h
             JOIN crypto_delivery_operations o
               ON o.operation_id = h.operation_id
            WHERE o.terminal_at <= $1::timestamptz
            ORDER BY o.terminal_at, h.operation_id
            LIMIT ${CRYPTO_DELIVERY_COLLECTION_LIMITS.pruningBatch}
            FOR UPDATE OF h SKIP LOCKED
         )
         DELETE FROM crypto_human_membership_transitions current
          USING candidates
          WHERE current.operation_id = candidates.operation_id
          RETURNING current.operation_id`,
        [terminalOperationCutoff],
      );
      const operations = await transaction.query(
        `WITH candidates AS (
           SELECT o.operation_id
             FROM crypto_delivery_operations o
            WHERE o.kind <> 'first_device_bootstrap'
              AND o.terminal_at <= $1::timestamptz
              AND NOT EXISTS (
                SELECT 1 FROM crypto_domain_transition_steps s
                 WHERE s.operation_id = o.operation_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM crypto_device_epoch_operations e
                 WHERE e.operation_id = o.operation_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM crypto_human_membership_transitions h
                 WHERE h.operation_id = o.operation_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM crypto_delivery_messages m
                 WHERE m.operation_id = o.operation_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM crypto_operation_outbox outbox
                 WHERE outbox.operation_id = o.operation_id
              )
            ORDER BY o.terminal_at, o.operation_id
            LIMIT ${CRYPTO_DELIVERY_COLLECTION_LIMITS.pruningBatch}
            FOR UPDATE OF o SKIP LOCKED
         )
         DELETE FROM crypto_delivery_operations current
          USING candidates
          WHERE current.operation_id = candidates.operation_id
          RETURNING current.operation_id`,
        [terminalOperationCutoff],
      );
      return Object.freeze({
        challenges: challenges.length,
        keyPackages: keyPackages.length,
        acknowledgements: acknowledgements.length,
        messages: messages.length,
        outbox: outbox.length,
        namespaceSteps: namespaceSteps.length,
        domainSteps: domainSteps.length,
        deviceOperations: deviceOperations.length,
        membershipTransitions: membershipTransitions.length,
        operations: operations.length,
      });
    });
  }
}
