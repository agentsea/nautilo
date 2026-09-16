/**
 * D468 durable push-delivery persistence primitives.
 *
 * The worker deliberately owns only bounded, content-free operational state.
 * Message eligibility remains in `@nautilo/trust`; Expo capability plaintext
 * is never returned here (the binding carries an AES-GCM envelope only).
 */
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import type { DirectDatabase } from "../config/direct-database";
import {
  pushInstallationBindings,
  pushMessageCandidates,
  pushNotificationDeliveries,
  pushNotificationTestIntents,
  type PushInstallationBinding,
  type PushNotificationDelivery,
  type PushNotificationDeliveryClaimPurpose,
} from "../schema/push-notifications";

export const PUSH_CLAIM_LEASE_MS = 60_000;
export const PUSH_DELIVERY_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const PUSH_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const PUSH_CLEANUP_BATCH_LIMIT = 256;

export type PushNotificationTx = Parameters<
  Parameters<DirectDatabase["transaction"]>[0]
>[0];

export interface ClaimedPushMessageCandidate {
  readonly messageId: number;
}

export interface ClaimedPushNotificationTestIntent {
  readonly notificationId: string;
  readonly userId: string;
  readonly bindingId: string;
  readonly tokenGeneration: number;
  /** The persisted request time, not worker processing time. */
  readonly occurredAt: Date;
}

export interface ClaimedPushNotificationDelivery {
  readonly deliveryId: string;
  readonly userId: string;
  readonly claimPurpose: PushNotificationDeliveryClaimPurpose;
}

export type PushDeliveryTarget =
  | {
      readonly kind: "important_message";
      readonly eventId: string;
      readonly roomId: string;
      readonly topLevelRoomId: string;
      readonly messageId: number;
      readonly occurredAt: Date;
    }
  | {
      readonly kind: "needs_you";
      readonly eventId: string;
      readonly roomId: string;
      readonly topLevelRoomId: string;
      readonly attentionRequestId: string;
      readonly occurredAt: Date;
    }
  | {
      readonly kind: "test";
      readonly eventId: string;
      readonly occurredAt: Date;
    };

export interface ClaimedPushDeliveryWithBinding {
  readonly delivery: PushNotificationDelivery;
  readonly binding: PushInstallationBinding | null;
}

function safeTimestamp(value: Date, label: string): Date {
  if (!Number.isFinite(value.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return value;
}

function assertWorkerId(workerId: string): void {
  if (workerId.trim().length === 0 || workerId.length > 128) {
    throw new Error("push worker ID must be nonempty and at most 128 characters");
  }
}

function resultRows<T>(result: unknown): readonly T[] {
  if (Array.isArray(result)) return result as readonly T[];
  if (
    result !== null &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: readonly T[] }).rows;
  }
  throw new Error("invalid push-delivery database result");
}

function claimExpiry(now: Date): Date {
  return new Date(safeTimestamp(now, "push claim time").getTime() + PUSH_CLAIM_LEASE_MS);
}

/**
 * Raw SQL function calls have no column codec to teach postgres-js how to
 * serialize Date. Bind an explicit ISO value and cast at the SQL boundary;
 * ordinary Drizzle column writes retain their normal timestamp codec.
 */
function timestampParameter(value: Date, label: string): string {
  return safeTimestamp(value, label).toISOString();
}

/** Atomically claim one durable candidate, reclaiming only an expired lease. */
export async function claimNextPushMessageCandidate(
  tx: PushNotificationTx,
  input: { readonly workerId: string; readonly now: Date },
): Promise<ClaimedPushMessageCandidate | null> {
  assertWorkerId(input.workerId);
  const now = safeTimestamp(input.now, "push claim time");
  const nowParameter = timestampParameter(now, "push claim time");
  const expiryParameter = timestampParameter(claimExpiry(now), "push claim expiry time");
  const rows = resultRows<{ message_id: number }>(await tx.execute(sql`
    WITH selected AS (
      SELECT candidate.message_id
      FROM push_message_candidates candidate
      WHERE candidate.state = 'pending'
         OR (candidate.state = 'claimed' AND candidate.claim_expires_at <= ${nowParameter}::timestamptz)
      ORDER BY candidate.created_at, candidate.message_id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE push_message_candidates candidate
       SET state = 'claimed',
           claim_owner = ${input.workerId},
           claim_expires_at = ${expiryParameter}::timestamptz
      FROM selected
     WHERE candidate.message_id = selected.message_id
    RETURNING candidate.message_id
  `));
  const row = rows[0];
  return row === undefined ? null : { messageId: Number(row.message_id) };
}

/** Finalize one claimed candidate only after every per-owner enqueue attempt completed. */
export async function terminalizeClaimedPushMessageCandidate(
  tx: PushNotificationTx,
  input: { readonly workerId: string; readonly messageId: number; readonly now: Date },
): Promise<boolean> {
  assertWorkerId(input.workerId);
  if (!Number.isSafeInteger(input.messageId) || input.messageId <= 0) {
    throw new Error("push candidate message ID must be a positive safe integer");
  }
  const now = safeTimestamp(input.now, "push terminal time");
  const rows = await tx
    .update(pushMessageCandidates)
    .set({
      state: "terminal",
      claimOwner: null,
      claimExpiresAt: null,
      terminalAt: now,
    })
    .where(and(
      eq(pushMessageCandidates.messageId, input.messageId),
      eq(pushMessageCandidates.state, "claimed"),
      eq(pushMessageCandidates.claimOwner, input.workerId),
    ))
    .returning({ messageId: pushMessageCandidates.messageId });
  return rows.length === 1;
}

/**
 * Claims one user-requested generic test through a narrow cross-owner SQL
 * capability. The returned identifiers remain opaque; caller-side owner RLS
 * rechecks the exact binding before enqueuing delivery.
 */
export async function claimNextPushNotificationTestIntent(
  tx: PushNotificationTx,
  input: { readonly workerId: string; readonly now: Date },
): Promise<ClaimedPushNotificationTestIntent | null> {
  assertWorkerId(input.workerId);
  const now = safeTimestamp(input.now, "push test claim time");
  const nowParameter = timestampParameter(now, "push test claim time");
  const expiryParameter = timestampParameter(claimExpiry(now), "push test claim expiry time");
  const rows = resultRows<{
    notification_id: string;
    user_id: string;
    binding_id: string;
    token_generation: number;
    created_at: Date | string;
  }>(await tx.execute(sql`
    SELECT * FROM public.app_claim_next_push_notification_test_intent(
      ${input.workerId}::text,
      ${nowParameter}::timestamptz,
      ${expiryParameter}::timestamptz
    )
  `));
  const row = rows[0];
  return row === undefined
    ? null
    : {
        notificationId: row.notification_id,
        userId: row.user_id,
        bindingId: row.binding_id,
        tokenGeneration: Number(row.token_generation),
        occurredAt: safeTimestamp(new Date(row.created_at), "push test occurrence time"),
      };
}

export async function terminalizeClaimedPushNotificationTestIntent(
  tx: PushNotificationTx,
  input: {
    readonly workerId: string;
    readonly notificationId: string;
    readonly now: Date;
  },
): Promise<boolean> {
  assertWorkerId(input.workerId);
  const rows = await tx
    .update(pushNotificationTestIntents)
    .set({
      state: "terminal",
      claimOwner: null,
      claimExpiresAt: null,
      terminalAt: safeTimestamp(input.now, "push test terminal time"),
    })
    .where(and(
      eq(pushNotificationTestIntents.notificationId, input.notificationId),
      eq(pushNotificationTestIntents.state, "claimed"),
      eq(pushNotificationTestIntents.claimOwner, input.workerId),
    ))
    .returning({ notificationId: pushNotificationTestIntents.notificationId });
  return rows.length === 1;
}

/**
 * Materialize one logical delivery for every currently active owned binding.
 * The caller must already hold `withTrustContext({ userId })`; that context is
 * the ownership boundary for both the binding read and delivery write.
 */
export async function enqueuePushNotificationDeliveriesForActiveBindings(
  tx: PushNotificationTx,
  input: {
    readonly userId: string;
    readonly target: PushDeliveryTarget;
    readonly now: Date;
    readonly newDeliveryId?: () => string;
    /**
     * A test intent is addressed to one exact installation generation. Event
     * fan-out intentionally omits this field so it still reaches all active
     * installations for its Human.
     */
    readonly exactBinding?: {
      readonly bindingId: string;
      readonly tokenGeneration: number;
    };
  },
): Promise<number> {
  const now = safeTimestamp(input.now, "push enqueue time");
  const occurredAt = safeTimestamp(input.target.occurredAt, "push occurrence time");
  if (input.userId.length === 0 || input.target.eventId.length === 0 || input.target.eventId.length > 128) {
    throw new Error("push delivery identity is invalid");
  }
  const bindings = await tx
    .select()
    .from(pushInstallationBindings)
    .where(and(
      eq(pushInstallationBindings.userId, input.userId),
      eq(pushInstallationBindings.state, "active"),
      eq(pushInstallationBindings.enabled, true),
      eq(pushInstallationBindings.permission, "granted"),
      ...(input.exactBinding === undefined
        ? []
        : [
            eq(pushInstallationBindings.bindingId, input.exactBinding.bindingId),
            eq(pushInstallationBindings.tokenGeneration, input.exactBinding.tokenGeneration),
          ]),
    ));
  const newDeliveryId = input.newDeliveryId ?? randomUUID;
  const expiresAt = new Date(now.getTime() + PUSH_DELIVERY_MAX_AGE_MS);
  let inserted = 0;
  for (const binding of bindings) {
    const target = input.target;
    const rows = await tx
      .insert(pushNotificationDeliveries)
      .values({
        id: newDeliveryId(),
        userId: input.userId,
        bindingId: binding.bindingId,
        tokenGeneration: binding.tokenGeneration,
        kind: target.kind,
        eventId: target.eventId,
        ...(target.kind === "important_message"
          ? {
              roomId: target.roomId,
              topLevelRoomId: target.topLevelRoomId,
              messageId: target.messageId,
              attentionRequestId: null,
            }
          : target.kind === "needs_you"
            ? {
                roomId: target.roomId,
                topLevelRoomId: target.topLevelRoomId,
                messageId: null,
                attentionRequestId: target.attentionRequestId,
              }
            : {
                roomId: null,
                topLevelRoomId: null,
                messageId: null,
                attentionRequestId: null,
              }),
        occurredAt,
        state: "pending",
        attemptCount: 0,
        receiptAttemptCount: 0,
        nextAttemptAt: now,
        ticketId: null,
        ticketAcceptedAt: null,
        claimOwner: null,
        claimPurpose: null,
        claimExpiresAt: null,
        lastFailureCode: null,
        terminalAt: null,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: pushNotificationDeliveries.id });
    inserted += rows.length;
  }
  return inserted;
}

/** Claims one due send or receipt operation without exposing capability material. */
export async function claimNextPushNotificationDelivery(
  tx: PushNotificationTx,
  input: {
    readonly workerId: string;
    readonly purpose: PushNotificationDeliveryClaimPurpose;
    readonly now: Date;
  },
): Promise<ClaimedPushNotificationDelivery | null> {
  assertWorkerId(input.workerId);
  const now = safeTimestamp(input.now, "push delivery claim time");
  const nowParameter = timestampParameter(now, "push delivery claim time");
  const expiryParameter = timestampParameter(claimExpiry(now), "push delivery claim expiry time");
  const rows = resultRows<{
    delivery_id: string;
    user_id: string;
    claim_purpose: PushNotificationDeliveryClaimPurpose;
  }>(await tx.execute(sql`
    SELECT * FROM public.app_claim_next_push_notification_delivery(
      ${input.purpose}::text,
      ${input.workerId}::text,
      ${nowParameter}::timestamptz,
      ${expiryParameter}::timestamptz
    )
  `));
  const row = rows[0];
  return row === undefined
    ? null
    : {
        deliveryId: row.delivery_id,
        userId: row.user_id,
        claimPurpose: row.claim_purpose,
      };
}

/** Loads the exact claimed delivery and the same-generation encrypted binding. */
export async function getClaimedPushDeliveryWithBinding(
  tx: PushNotificationTx,
  input: {
    readonly userId: string;
    readonly deliveryId: string;
    readonly workerId: string;
  },
): Promise<ClaimedPushDeliveryWithBinding | null> {
  assertWorkerId(input.workerId);
  const rows = await tx
    .select({ delivery: pushNotificationDeliveries, binding: pushInstallationBindings })
    .from(pushNotificationDeliveries)
    .leftJoin(pushInstallationBindings, and(
      eq(pushInstallationBindings.bindingId, pushNotificationDeliveries.bindingId),
      eq(pushInstallationBindings.userId, pushNotificationDeliveries.userId),
      eq(pushInstallationBindings.tokenGeneration, pushNotificationDeliveries.tokenGeneration),
      eq(pushInstallationBindings.state, "active"),
      eq(pushInstallationBindings.enabled, true),
      eq(pushInstallationBindings.permission, "granted"),
    ))
    .where(and(
      eq(pushNotificationDeliveries.id, input.deliveryId),
      eq(pushNotificationDeliveries.userId, input.userId),
      eq(pushNotificationDeliveries.state, "claimed"),
      eq(pushNotificationDeliveries.claimOwner, input.workerId),
    ))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : row;
}

export async function markClaimedPushDeliveryTicketAccepted(
  tx: PushNotificationTx,
  input: {
    readonly userId: string;
    readonly deliveryId: string;
    readonly workerId: string;
    readonly ticketId: string;
    readonly now: Date;
    readonly receiptNotBefore: Date;
  },
): Promise<boolean> {
  assertWorkerId(input.workerId);
  if (input.ticketId.length === 0 || input.ticketId.length > 256) {
    throw new Error("push ticket ID is invalid");
  }
  const now = safeTimestamp(input.now, "push ticket time");
  const rows = await tx
    .update(pushNotificationDeliveries)
    .set({
      state: "receipt_pending",
      ticketId: input.ticketId,
      ticketAcceptedAt: now,
      claimOwner: null,
      claimPurpose: null,
      claimExpiresAt: null,
      lastFailureCode: null,
      nextAttemptAt: safeTimestamp(input.receiptNotBefore, "push receipt retry time"),
      updatedAt: now,
    })
    .where(and(
      eq(pushNotificationDeliveries.id, input.deliveryId),
      eq(pushNotificationDeliveries.userId, input.userId),
      eq(pushNotificationDeliveries.state, "claimed"),
      eq(pushNotificationDeliveries.claimOwner, input.workerId),
      eq(pushNotificationDeliveries.claimPurpose, "send"),
    ))
    .returning({ id: pushNotificationDeliveries.id });
  return rows.length === 1;
}

export async function markClaimedPushDeliveryDelivered(
  tx: PushNotificationTx,
  input: {
    readonly userId: string;
    readonly deliveryId: string;
    readonly workerId: string;
    readonly ticketId: string;
    readonly now: Date;
  },
): Promise<boolean> {
  assertWorkerId(input.workerId);
  const now = safeTimestamp(input.now, "push receipt delivery time");
  const rows = await tx
    .update(pushNotificationDeliveries)
    .set({
      state: "delivered",
      claimOwner: null,
      claimPurpose: null,
      claimExpiresAt: null,
      terminalAt: now,
      lastFailureCode: null,
      updatedAt: now,
    })
    .where(and(
      eq(pushNotificationDeliveries.id, input.deliveryId),
      eq(pushNotificationDeliveries.userId, input.userId),
      eq(pushNotificationDeliveries.state, "claimed"),
      eq(pushNotificationDeliveries.claimOwner, input.workerId),
      eq(pushNotificationDeliveries.claimPurpose, "receipt"),
      eq(pushNotificationDeliveries.ticketId, input.ticketId),
    ))
    .returning({ id: pushNotificationDeliveries.id });
  return rows.length === 1;
}

export async function terminalizeClaimedPushDelivery(
  tx: PushNotificationTx,
  input: {
    readonly userId: string;
    readonly deliveryId: string;
    readonly workerId: string;
    readonly failureCode: string;
    readonly now: Date;
  },
): Promise<boolean> {
  assertWorkerId(input.workerId);
  if (input.failureCode.length === 0 || input.failureCode.length > 64) {
    throw new Error("push terminal failure code is invalid");
  }
  const now = safeTimestamp(input.now, "push terminal time");
  const rows = await tx
    .update(pushNotificationDeliveries)
    .set({
      state: "terminal",
      claimOwner: null,
      claimPurpose: null,
      claimExpiresAt: null,
      lastFailureCode: input.failureCode,
      terminalAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(pushNotificationDeliveries.id, input.deliveryId),
      eq(pushNotificationDeliveries.userId, input.userId),
      eq(pushNotificationDeliveries.state, "claimed"),
      eq(pushNotificationDeliveries.claimOwner, input.workerId),
    ))
    .returning({ id: pushNotificationDeliveries.id });
  return rows.length === 1;
}

/** Retry a claimed send/receipt with a fixed bounded attempt budget. */
export async function rescheduleClaimedPushDelivery(
  tx: PushNotificationTx,
  input: {
    readonly userId: string;
    readonly deliveryId: string;
    readonly workerId: string;
    readonly purpose: PushNotificationDeliveryClaimPurpose;
    readonly failureCode: string;
    readonly nextAttemptAt: Date;
    readonly now: Date;
  },
): Promise<"rescheduled" | "terminal" | "lost_claim"> {
  assertWorkerId(input.workerId);
  if (input.failureCode.length === 0 || input.failureCode.length > 64) {
    throw new Error("push retry failure code is invalid");
  }
  const now = safeTimestamp(input.now, "push retry time");
  const rows = await tx
    .select({
      attemptCount: pushNotificationDeliveries.attemptCount,
      receiptAttemptCount: pushNotificationDeliveries.receiptAttemptCount,
    })
    .from(pushNotificationDeliveries)
    .where(and(
      eq(pushNotificationDeliveries.id, input.deliveryId),
      eq(pushNotificationDeliveries.userId, input.userId),
      eq(pushNotificationDeliveries.state, "claimed"),
      eq(pushNotificationDeliveries.claimOwner, input.workerId),
      eq(pushNotificationDeliveries.claimPurpose, input.purpose),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) return "lost_claim";
  const exhausted = input.purpose === "send"
    ? row.attemptCount >= 8
    : row.receiptAttemptCount >= 24;
  const updated = await tx
    .update(pushNotificationDeliveries)
    .set(exhausted
      ? {
          state: "terminal",
          claimOwner: null,
          claimPurpose: null,
          claimExpiresAt: null,
          lastFailureCode: "attempts_exhausted",
          terminalAt: now,
          updatedAt: now,
        }
      : {
          state: input.purpose === "send" ? "retry" : "receipt_pending",
          claimOwner: null,
          claimPurpose: null,
          claimExpiresAt: null,
          lastFailureCode: input.failureCode,
          nextAttemptAt: safeTimestamp(input.nextAttemptAt, "push next retry time"),
          updatedAt: now,
        })
    .where(and(
      eq(pushNotificationDeliveries.id, input.deliveryId),
      eq(pushNotificationDeliveries.userId, input.userId),
      eq(pushNotificationDeliveries.state, "claimed"),
      eq(pushNotificationDeliveries.claimOwner, input.workerId),
      eq(pushNotificationDeliveries.claimPurpose, input.purpose),
    ))
    .returning({ id: pushNotificationDeliveries.id });
  return updated.length === 1 ? (exhausted ? "terminal" : "rescheduled") : "lost_claim";
}

/** DeviceNotRegistered retires exactly the acknowledged binding generation. */
export async function retirePushBindingGenerationForUser(
  tx: PushNotificationTx,
  input: {
    readonly userId: string;
    readonly bindingId: string;
    readonly tokenGeneration: number;
    readonly now: Date;
  },
): Promise<number> {
  if (!Number.isSafeInteger(input.tokenGeneration) || input.tokenGeneration <= 0) {
    throw new Error("push binding generation must be a positive safe integer");
  }
  const now = safeTimestamp(input.now, "push token retirement time");
  await tx
    .update(pushInstallationBindings)
    .set({
      enabled: false,
      state: "disabled",
      disabledAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(pushInstallationBindings.bindingId, input.bindingId),
      eq(pushInstallationBindings.userId, input.userId),
      eq(pushInstallationBindings.tokenGeneration, input.tokenGeneration),
      eq(pushInstallationBindings.state, "active"),
    ));
  const rows = await tx
    .update(pushNotificationDeliveries)
    .set({
      state: "terminal",
      claimOwner: null,
      claimPurpose: null,
      claimExpiresAt: null,
      lastFailureCode: "device_not_registered",
      terminalAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(pushNotificationDeliveries.userId, input.userId),
      eq(pushNotificationDeliveries.bindingId, input.bindingId),
      eq(pushNotificationDeliveries.tokenGeneration, input.tokenGeneration),
      sql`${pushNotificationDeliveries.state} NOT IN ('delivered', 'terminal')`,
    ))
    .returning({ id: pushNotificationDeliveries.id });
  return rows.length;
}

/** Cross-owner maintenance is narrow, bounded, and server-runtime-only. */
export async function runPushDeliveryMaintenance(
  tx: PushNotificationTx,
  input: { readonly now: Date; readonly limit?: number },
): Promise<{
  readonly expired: number;
  readonly staleBinding: number;
  readonly purgedDeliveries: number;
  readonly purgedTests: number;
}> {
  const now = safeTimestamp(input.now, "push maintenance time");
  const nowParameter = timestampParameter(now, "push maintenance time");
  const limit = input.limit ?? PUSH_CLEANUP_BATCH_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PUSH_CLEANUP_BATCH_LIMIT) {
    throw new Error("push maintenance limit is invalid");
  }
  const before = new Date(now.getTime() - PUSH_TERMINAL_RETENTION_MS);
  const beforeParameter = timestampParameter(before, "push maintenance retention time");
  const one = async (statement: ReturnType<typeof sql>): Promise<number> => {
    const rows = resultRows<{ count: number | string }>(await tx.execute(statement));
    return Number(rows[0]?.count ?? 0);
  };
  return {
    expired: await one(sql`SELECT public.app_terminalize_expired_push_notification_deliveries(${nowParameter}::timestamptz, ${limit}::integer) AS count`),
    staleBinding: await one(sql`SELECT public.app_terminalize_stale_push_notification_deliveries(${nowParameter}::timestamptz, ${limit}::integer) AS count`),
    purgedDeliveries: await one(sql`SELECT public.app_purge_terminal_push_notification_delivery_history(${beforeParameter}::timestamptz, ${limit}::integer) AS count`),
    purgedTests: await one(sql`SELECT public.app_purge_terminal_push_notification_test_intents(${beforeParameter}::timestamptz, ${limit}::integer) AS count`),
  };
}

/** Candidate history is content-free and not RLS-protected; clean it locally. */
export async function purgeTerminalPushMessageCandidates(
  tx: PushNotificationTx,
  input: { readonly before: Date; readonly limit?: number },
): Promise<number> {
  const before = safeTimestamp(input.before, "push candidate retention time");
  const beforeParameter = timestampParameter(before, "push candidate retention time");
  const limit = input.limit ?? PUSH_CLEANUP_BATCH_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PUSH_CLEANUP_BATCH_LIMIT) {
    throw new Error("push candidate maintenance limit is invalid");
  }
  const rows = resultRows<{ message_id: number }>(await tx.execute(sql`
    WITH selected AS (
      SELECT candidate.message_id
      FROM push_message_candidates candidate
      WHERE candidate.terminal_at IS NOT NULL
        AND candidate.terminal_at < ${beforeParameter}::timestamptz
      ORDER BY candidate.terminal_at, candidate.message_id
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    DELETE FROM push_message_candidates candidate
    USING selected
    WHERE candidate.message_id = selected.message_id
    RETURNING candidate.message_id
  `));
  return rows.length;
}
