import { createHash } from "node:crypto";
import {
  and,
  CRYPTO_DELIVERY_COLLECTION_LIMITS,
  cryptoDeliveryAcknowledgements,
  cryptoDeliveryOperations,
  cryptoDeviceEpochOperations,
  cryptoDomainTransitionSteps,
  cryptoHumanMembershipTransitions,
  cryptoOperationOutbox,
  eq,
  humanCryptoDevices,
  inArray,
  sql,
} from "@nautilo/db";
import type {
  VerifiedDeliveryAcknowledgement,
} from "../../delivery/delivery-acknowledgement.ts";
import {
  assertVerifiedDeliveryAcknowledgement,
} from "../../delivery/delivery-acknowledgement.ts";
import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import type { DatabaseRow } from "../storage/postgres-record-codecs.ts";

export type PersistDeliveryAcknowledgementResult =
  | { readonly status: "acknowledged" | "duplicate" }
  | { readonly status: "conflicting_state" | "stale_state" };

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

function requiredBytes(row: DatabaseRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Crypto delivery column ${name} must be bytea`);
  }
  return value;
}

function nullableBytes(row: DatabaseRow, name: string): Uint8Array | null {
  return row[name] === null ? null : requiredBytes(row, name);
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

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
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

function outboxToken(operationId: string): string {
  return createHash("sha256")
    .update("nautilo/crypto-device-ready/v1\0")
    .update(operationId)
    .digest("hex");
}

function membershipReadyOutboxToken(operationId: string): string {
  return createHash("sha256")
    .update("nautilo/crypto-human-membership-ready/v1\0")
    .update(operationId)
    .digest("hex");
}

export class PostgresDeliveryAcknowledgementRepository {
  constructor(private readonly handle: CryptoPostgresHandle) {
    assertVerifiedCryptoPostgresHandle(handle);
  }

  acknowledge(
    acknowledgement: VerifiedDeliveryAcknowledgement,
    receivedAt: number,
  ): Promise<PersistDeliveryAcknowledgementResult> {
    assertVerifiedDeliveryAcknowledgement(acknowledgement);
    if (
      acknowledgement.processedRevision < 1
      || acknowledgement.recipientSequence < 1
      || acknowledgement.payloadHash.length !== 32
      || acknowledgement.acknowledgementDigest.length !== 32
      || !Number.isSafeInteger(receivedAt)
      || receivedAt < acknowledgement.acknowledgedAt
    ) {
      throw new TypeError("Delivery acknowledgement is malformed");
    }
    return this.handle.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`delivery-ack/${acknowledgement.deviceId}`],
      );
      const rows = await transaction.query(
        `SELECT d.device_id, d.state AS device_state,
                d.revision AS device_revision,
                d.delivery_acknowledged_sequence,
                d.delivery_blocked_sequence,
                d.delivery_blocked_operation_id,
                d.delivery_blocked_at,
                d.delivery_blocked_reason,
                m.message_id, m.operation_id AS message_operation_id,
                m.domain_id AS message_domain_id,
                m.recipient_sequence AS message_recipient_sequence,
                m.payload_hash AS message_payload_hash,
                m.recipient_device_id,
                o.kind AS operation_kind,
                o.state AS operation_state,
                o.target_device_id AS operation_target_device_id,
                membership.bootstrap_device_id
                  AS membership_bootstrap_device_id,
                membership.committer_device_id
                  AS membership_committer_device_id,
                (
                  SELECT count(*) FROM crypto_domain_transition_steps s
                   WHERE s.operation_id = o.operation_id
                )::bigint AS domain_required_count,
                a.device_id AS existing_device_id,
                a.processed_revision AS existing_processed_revision,
                a.acknowledgement_digest
                  AS existing_acknowledgement_digest
           FROM human_crypto_devices d
           JOIN crypto_delivery_messages m
             ON m.message_id = $1
            AND m.recipient_device_id = d.device_id
           JOIN crypto_delivery_operations o
             ON o.operation_id = m.operation_id
           LEFT JOIN crypto_human_membership_transitions membership
             ON membership.operation_id = o.operation_id
           LEFT JOIN crypto_delivery_acknowledgements a
             ON a.message_id = m.message_id
            AND a.device_id = d.device_id
          WHERE d.device_id = $2
            AND (
              o.lease_owner IS NULL
              OR o.lease_expires_at <= $3::timestamptz
            )
            AND (
              a.message_id IS NOT NULL
              OR m.expires_at > $3::timestamptz
            )
          LIMIT 2
          FOR UPDATE OF o, d`,
        [
          acknowledgement.messageId,
          acknowledgement.deviceId,
          isoTime(receivedAt),
        ],
      );
      if (rows.length !== 1) return { status: "stale_state" };
      const row = rows[0]!;
      if (
        requiredString(row, "device_id") !== acknowledgement.deviceId
        || requiredString(row, "message_id") !== acknowledgement.messageId
        || requiredString(row, "recipient_device_id")
          !== acknowledgement.deviceId
        || requiredCounter(row, "message_recipient_sequence")
          !== acknowledgement.recipientSequence
        || !equalBytes(
          requiredBytes(row, "message_payload_hash"),
          acknowledgement.payloadHash,
        )
      ) return { status: "stale_state" };
      const operationId = requiredString(row, "message_operation_id");
      const operationKind = requiredString(row, "operation_kind");
      const membershipRequiredAcknowledgementDeviceId =
        operationKind === "human_add"
          ? nullableString(row, "membership_bootstrap_device_id")
          : operationKind === "human_remove"
          ? nullableString(row, "membership_committer_device_id")
          : null;
      if (
        (
          operationKind === "human_add"
          || operationKind === "human_remove"
        )
        && membershipRequiredAcknowledgementDeviceId === null
      ) return { status: "stale_state" };
      const existingDeviceId = nullableString(row, "existing_device_id");
      if (existingDeviceId !== null) {
        const existingRevision = nullableCounter(
          row,
          "existing_processed_revision",
        );
        const existingDigest = nullableBytes(
          row,
          "existing_acknowledgement_digest",
        );
        return existingDeviceId === acknowledgement.deviceId
            && existingRevision === acknowledgement.processedRevision
            && existingDigest !== null
            && equalBytes(
              existingDigest,
              acknowledgement.acknowledgementDigest,
            )
          ? { status: "duplicate" }
          : { status: "conflicting_state" };
      }
      if (
        !["pending", "active"].includes(
          requiredString(row, "device_state"),
        )
        || [
          row["delivery_blocked_sequence"],
          row["delivery_blocked_operation_id"],
          row["delivery_blocked_at"],
          row["delivery_blocked_reason"],
        ].some((value) => value !== null)
        || requiredCounter(row, "delivery_acknowledged_sequence") + 1
          !== acknowledgement.recipientSequence
        || requiredCounter(row, "device_revision") + 1
          !== acknowledgement.processedRevision
        || ["failed", "cancelled"].includes(
          requiredString(row, "operation_state"),
        )
        || (
          requiredString(row, "operation_state") === "active"
          && requiredString(row, "device_state") !== "active"
        )
      ) return { status: "stale_state" };

      const inserted = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.insert(cryptoDeliveryAcknowledgements).values({
          messageId: acknowledgement.messageId,
          deviceId: acknowledgement.deviceId,
          processedRevision: acknowledgement.processedRevision,
          acknowledgementDigest: acknowledgement.acknowledgementDigest,
          acknowledgedAt: timestampSql(acknowledgement.acknowledgedAt),
        }).returning({
          message_id: cryptoDeliveryAcknowledgements.messageId,
        }),
      );
      if (inserted.length !== 1) {
        throw new Error("Delivery acknowledgement insert failed");
      }
      const updated = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(humanCryptoDevices).set({
          revision: acknowledgement.processedRevision,
          deliveryAcknowledgedSequence: acknowledgement.recipientSequence,
          lastSeenAt: timestampSql(acknowledgement.acknowledgedAt),
        }).where(and(
          eq(humanCryptoDevices.deviceId, acknowledgement.deviceId),
          eq(
            humanCryptoDevices.revision,
            acknowledgement.processedRevision - 1,
          ),
          eq(
            humanCryptoDevices.deliveryAcknowledgedSequence,
            acknowledgement.recipientSequence - 1,
          ),
          inArray(humanCryptoDevices.state, ["pending", "active"]),
        )).returning({ device_id: humanCryptoDevices.deviceId }),
      );
      if (updated.length !== 1) {
        throw new Error("Delivery acknowledgement device CAS failed");
      }
      if (requiredString(row, "operation_state") === "active") {
        return { status: "acknowledged" };
      }
      if (requiredString(row, "device_state") === "pending") {
        const gate = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.update(cryptoDeviceEpochOperations).set({
            expectedDeviceRevision: acknowledgement.processedRevision,
          }).where(and(
            eq(
              cryptoDeviceEpochOperations.operationId,
              requiredString(row, "message_operation_id"),
            ),
            eq(
              cryptoDeviceEpochOperations.targetDeviceId,
              acknowledgement.deviceId,
            ),
            eq(
              cryptoDeviceEpochOperations.expectedDeviceRevision,
              acknowledgement.processedRevision - 1,
            ),
          )).returning({
            operation_id: cryptoDeviceEpochOperations.operationId,
          }),
        );
        if (gate.length !== 1) {
          throw new Error("Delivery acknowledgement activation-gate CAS failed");
        }
      }
      if (
        operationKind === "human_add"
        || operationKind === "human_remove"
      ) {
        if (
          membershipRequiredAcknowledgementDeviceId
            !== acknowledgement.deviceId
        ) {
          return { status: "acknowledged" };
        }
        const ready = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.update(cryptoDeliveryOperations).set({
            state: "ready_to_activate",
            updatedAt: timestampSql(acknowledgement.acknowledgedAt),
          }).from(cryptoHumanMembershipTransitions).where(and(
            eq(cryptoDeliveryOperations.operationId, operationId),
            eq(cryptoDeliveryOperations.kind, operationKind),
            eq(cryptoDeliveryOperations.state, "awaiting_delivery"),
            eq(
              cryptoHumanMembershipTransitions.operationId,
              cryptoDeliveryOperations.operationId,
            ),
            sql`${cryptoHumanMembershipTransitions.releasedAt} is null`,
            sql`${cryptoHumanMembershipTransitions.activatedAt} is null`,
            sql`${cryptoHumanMembershipTransitions.candidateSubmittedAt}
              is not null`,
            sql`(
              (${cryptoDeliveryOperations.kind} = 'human_add'
                and ${cryptoHumanMembershipTransitions.bootstrapDeviceId}
                  = ${acknowledgement.deviceId})
              or (${cryptoDeliveryOperations.kind} = 'human_remove'
                and ${cryptoHumanMembershipTransitions.committerDeviceId}
                  = ${acknowledgement.deviceId})
            )`,
            sql`not exists (
              select 1
                from crypto_delivery_messages pending_message
                left join crypto_delivery_acknowledgements pending_ack
                  on pending_ack.message_id = pending_message.message_id
                 and pending_ack.device_id
                   = pending_message.recipient_device_id
               where pending_message.operation_id =
                 ${cryptoDeliveryOperations.operationId}
                 and pending_message.recipient_device_id =
                   ${acknowledgement.deviceId}
                 and pending_ack.message_id is null
            )`,
          )).returning({
            operation_id: cryptoDeliveryOperations.operationId,
          }),
        );
        if (ready.length === 1) {
          const token = membershipReadyOutboxToken(operationId);
          const payload = new TextEncoder().encode(JSON.stringify({
            formatVersion: 1,
            eventType: "crypto_human_membership_ready",
            operationId,
            kind: operationKind,
            deviceId: acknowledgement.deviceId,
          }));
          const outbox = await executeTypedCryptoQuery(
            transaction,
            cryptoTypedDb.insert(cryptoOperationOutbox).values({
              outboxId: `outbox_membership_ready_${token}`,
              operationId,
              sequence: 2,
              eventType: "crypto_human_membership_ready",
              payloadBytes: payload,
              idempotencyKey: `membership-ready/${token}`,
              claimedBy: null,
              claimExpiresAt: null,
              attempts: 0,
              maximumAttempts:
                CRYPTO_DELIVERY_COLLECTION_LIMITS.maximumAttempts,
              deliveredAt: null,
              terminalAt: null,
              failureCode: null,
              createdAt: timestampSql(acknowledgement.acknowledgedAt),
            }).returning({ outbox_id: cryptoOperationOutbox.outboxId }),
          );
          if (outbox.length !== 1) {
            throw new Error("Membership ready outbox insert failed");
          }
        }
        return { status: "acknowledged" };
      }
      if (operationKind === "device_revoke") {
        const domainId = nullableString(row, "message_domain_id");
        if (domainId === null) return { status: "stale_state" };
        await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.update(cryptoDomainTransitionSteps).set({
            state: "ready_to_activate",
            leaseOwner: null,
            leaseExpiresAt: null,
            failureCode: null,
            updatedAt: timestampSql(acknowledgement.acknowledgedAt),
          }).where(and(
            eq(cryptoDomainTransitionSteps.operationId, operationId),
            eq(cryptoDomainTransitionSteps.domainId, domainId),
            eq(cryptoDomainTransitionSteps.state, "awaiting_delivery"),
            sql`not exists (
              select 1
                from crypto_delivery_messages pending_message
                left join crypto_delivery_acknowledgements pending_ack
                  on pending_ack.message_id = pending_message.message_id
                 and pending_ack.device_id =
                   pending_message.recipient_device_id
               where pending_message.operation_id =
                 ${cryptoDomainTransitionSteps.operationId}
                 and pending_message.domain_id =
                   ${cryptoDomainTransitionSteps.domainId}
                 and pending_ack.message_id is null
            )`,
          )).returning({
            operation_id: cryptoDomainTransitionSteps.operationId,
            domain_id: cryptoDomainTransitionSteps.domainId,
          }),
        );
        await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.update(cryptoDeliveryOperations).set({
            state: "ready_to_activate",
            updatedAt: timestampSql(acknowledgement.acknowledgedAt),
          }).where(and(
            eq(cryptoDeliveryOperations.operationId, operationId),
            eq(cryptoDeliveryOperations.kind, "device_revoke"),
            inArray(cryptoDeliveryOperations.state, [
              "awaiting_committer",
              "awaiting_delivery",
            ]),
            sql`exists (
              select 1 from crypto_domain_transition_steps ready_step
               where ready_step.operation_id =
                 ${cryptoDeliveryOperations.operationId}
                 and ready_step.state = 'ready_to_activate'
            )`,
            sql`not exists (
              select 1 from crypto_domain_transition_steps s
               where s.operation_id = ${cryptoDeliveryOperations.operationId}
                 and s.state not in ('ready_to_activate', 'failed')
            )`,
            sql`not exists (
              select 1 from crypto_domain_transition_namespaces n
               where n.operation_id = ${cryptoDeliveryOperations.operationId}
                 and n.state <> 'prepared'
            )`,
            sql`not exists (
              select 1
                from crypto_delivery_messages pending_message
                left join crypto_delivery_acknowledgements pending_ack
                  on pending_ack.message_id = pending_message.message_id
                 and pending_ack.device_id =
                   pending_message.recipient_device_id
               where pending_message.operation_id =
                 ${cryptoDeliveryOperations.operationId}
                 and pending_ack.message_id is null
            )`,
          )).returning({
            operation_id: cryptoDeliveryOperations.operationId,
          }),
        );
        return { status: "acknowledged" };
      }
      if (requiredString(row, "operation_target_device_id")
        === acknowledgement.deviceId) {
        const domainId = nullableString(row, "message_domain_id");
        if (domainId !== null) {
          await executeTypedCryptoQuery(
            transaction,
            cryptoTypedDb.update(cryptoDomainTransitionSteps).set({
              state: "ready_to_activate",
              leaseOwner: null,
              leaseExpiresAt: null,
              failureCode: null,
              updatedAt: timestampSql(acknowledgement.acknowledgedAt),
            }).where(and(
              eq(
                cryptoDomainTransitionSteps.operationId,
                requiredString(row, "message_operation_id"),
              ),
              eq(cryptoDomainTransitionSteps.domainId, domainId),
              eq(cryptoDomainTransitionSteps.state, "awaiting_delivery"),
              sql`not exists (
                select 1
                  from crypto_delivery_messages pending_message
                  left join crypto_delivery_acknowledgements pending_ack
                    on pending_ack.message_id = pending_message.message_id
                   and pending_ack.device_id =
                     pending_message.recipient_device_id
                 where pending_message.operation_id =
                   ${cryptoDomainTransitionSteps.operationId}
                   and pending_message.domain_id =
                     ${cryptoDomainTransitionSteps.domainId}
                   and pending_message.recipient_device_id =
                     ${acknowledgement.deviceId}
                   and pending_ack.message_id is null
              )`,
            )).returning({
              operation_id: cryptoDomainTransitionSteps.operationId,
              domain_id: cryptoDomainTransitionSteps.domainId,
            }),
          );
        }
        const ready = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.update(cryptoDeliveryOperations).set({
            state: "ready_to_activate",
            updatedAt: timestampSql(acknowledgement.acknowledgedAt),
          }).where(and(
            eq(
              cryptoDeliveryOperations.operationId,
              requiredString(row, "message_operation_id"),
            ),
            eq(
              cryptoDeliveryOperations.targetDeviceId,
              acknowledgement.deviceId,
            ),
            eq(cryptoDeliveryOperations.state, "awaiting_delivery"),
            sql`not exists (
              select 1 from crypto_domain_transition_steps s
               where s.operation_id = ${cryptoDeliveryOperations.operationId}
                 and s.state <> 'ready_to_activate'
            )`,
            sql`not exists (
              select 1 from crypto_domain_transition_namespaces n
               where n.operation_id = ${cryptoDeliveryOperations.operationId}
                 and n.state <> 'prepared'
            )`,
            sql`not exists (
              select 1
                from crypto_delivery_messages pending_message
                left join crypto_delivery_acknowledgements pending_ack
                  on pending_ack.message_id = pending_message.message_id
                 and pending_ack.device_id =
                   pending_message.recipient_device_id
               where pending_message.operation_id =
                 ${cryptoDeliveryOperations.operationId}
                 and pending_message.recipient_device_id =
                   ${acknowledgement.deviceId}
                 and pending_ack.message_id is null
            )`,
          )).returning({
            operation_id: cryptoDeliveryOperations.operationId,
          }),
        );
        if (ready.length === 1) {
          const token = outboxToken(operationId);
          const payload = new TextEncoder().encode(JSON.stringify({
            formatVersion: 1,
            eventType: "crypto_device_ready",
            operationId,
            deviceId: acknowledgement.deviceId,
          }));
          const outbox = await executeTypedCryptoQuery(
            transaction,
            cryptoTypedDb.insert(cryptoOperationOutbox).values({
              outboxId: `outbox_ready_${token}`,
              operationId,
              sequence: requiredCounter(row, "domain_required_count") + 1,
              eventType: "crypto_device_ready",
              payloadBytes: payload,
              idempotencyKey: `crypto-device-ready/${token}`,
              claimedBy: null,
              claimExpiresAt: null,
              attempts: 0,
              maximumAttempts:
                CRYPTO_DELIVERY_COLLECTION_LIMITS.maximumAttempts,
              deliveredAt: null,
              terminalAt: null,
              failureCode: null,
              createdAt: timestampSql(acknowledgement.acknowledgedAt),
            }).returning({ outbox_id: cryptoOperationOutbox.outboxId }),
          );
          if (outbox.length !== 1) {
            throw new Error("Delivery ready outbox insert failed");
          }
        }
      }
      return { status: "acknowledged" };
    });
  }
}
