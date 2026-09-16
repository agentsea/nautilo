/**
 * D468 — durable, restart-safe delivery of Mobile notifications.
 *
 * This worker is deliberately downstream of canonical message persistence:
 * `push_message_candidates` is the sole important-message admission marker,
 * `getImportantMessageArrivals` is the sole eligibility reader, and the Expo
 * adapter is the sole external transport. No realtime event is a delivery
 * authority and no message text is persisted or passed to the provider;
 * important-message presentation uses only bounded sender and Room labels.
 */
import { randomUUID } from "node:crypto";

import {
  EXPO_PUSH_GENERIC_PRESENTATIONS,
  EXPO_PUSH_MAX_MESSAGES_PER_REQUEST,
  ExpoPushProvider,
  type ExpoPushDelivery,
  type ExpoPushPresentation,
  type ExpoPushProviderOutcome,
} from "./expo-push-provider";
import {
  PUSH_CLEANUP_BATCH_LIMIT,
  PUSH_TERMINAL_RETENTION_MS,
  claimNextPushMessageCandidate,
  claimNextPushNotificationDelivery,
  claimNextPushNotificationTestIntent,
  enqueuePushNotificationDeliveriesForActiveBindings,
  getClaimedPushDeliveryWithBinding,
  markClaimedPushDeliveryDelivered,
  markClaimedPushDeliveryTicketAccepted,
  purgeTerminalPushMessageCandidates,
  rescheduleClaimedPushDelivery,
  retirePushBindingGenerationForUser,
  runPushDeliveryMaintenance,
  terminalizeClaimedPushDelivery,
  terminalizeClaimedPushMessageCandidate,
  terminalizeClaimedPushNotificationTestIntent,
  withTrustContext,
  type ClaimedPushNotificationDelivery,
  type DirectDatabase,
  type PushInstallationBinding,
  type PushNotificationDelivery,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";
import { getImportantMessageArrivals, getNotificationUnreadCount } from "@nautilo/trust";
import type { ImportantMessageArrivedEvent, MobilePushEnvelopeV1 } from "@nautilo/types";

import { getServerDirectDb } from "../lib/server-direct-db";
import {
  decryptPushToken,
  requirePushTokenEncryptionKey,
  type EncryptedPushTokenV1,
  type PushTokenEncryptionContext,
  PushTokenCryptoConfigurationError,
} from "./push-token-crypto";

const PUSH_DELIVERY_RECEIPT_DELAY_MS = 15 * 60 * 1_000;
const PUSH_DELIVERY_RETRY_BASE_MS = 5_000;
const PUSH_DELIVERY_RETRY_MAX_MS = 15 * 60 * 1_000;
const PUSH_DELIVERY_MAINTENANCE_INTERVAL_MS = 60_000;

type ImportantArrivalReader = (
  messageId: number,
  database: DirectDatabase,
) => Promise<ImportantMessageArrivedEvent[]>;

type NotificationUnreadCountReader = (
  userId: string,
  database: DirectDatabase,
) => Promise<number>;

export interface PushDeliveryWorkerDeps {
  readonly db?: DirectDatabase;
  readonly workerId?: string;
  readonly provider?: ExpoPushProvider;
  readonly now?: () => Date;
  readonly getEncryptionKey?: () => Uint8Array;
  readonly getImportantMessageArrivals?: ImportantArrivalReader;
  readonly getNotificationUnreadCount?: NotificationUnreadCountReader;
  readonly newDeliveryId?: () => string;
}

export interface PushDeliveryWorkerRunResult {
  readonly didWork: boolean;
  readonly candidatesProcessed: number;
  readonly testsProcessed: number;
  readonly sendsClaimed: number;
  readonly receiptsClaimed: number;
}

type PreparedSend = {
  readonly claim: ClaimedPushNotificationDelivery;
  readonly delivery: PushNotificationDelivery;
  readonly binding: PushInstallationBinding;
  readonly expo: ExpoPushDelivery;
};

/**
 * A single server can author its exact unread total for iOS while the app is
 * suspended. Mobile disables this server-side projection when more than one
 * server is registered so no partial count can overwrite the local aggregate.
 */
export function backgroundBadgeForPushDelivery(input: {
  readonly platform: PushInstallationBinding["platform"];
  readonly badgeEnabled: boolean;
  readonly kind: MobilePushEnvelopeV1["kind"];
  readonly unreadCount: number;
}): number | undefined {
  return input.platform === "ios"
    && input.badgeEnabled
    && input.kind === "important_message"
    && Number.isSafeInteger(input.unreadCount)
    && input.unreadCount > 0
    ? input.unreadCount
    : undefined;
}

function validNow(now: Date): Date {
  if (!Number.isFinite(now.getTime())) throw new Error("push worker clock returned an invalid time");
  return now;
}

function boundedRetryDelay(attempt: number, providerRetryAfterMs?: number): number {
  const exponential = Math.min(
    PUSH_DELIVERY_RETRY_MAX_MS,
    PUSH_DELIVERY_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1),
  );
  if (
    providerRetryAfterMs !== undefined &&
    Number.isFinite(providerRetryAfterMs) &&
    providerRetryAfterMs > 0
  ) {
    return Math.min(PUSH_DELIVERY_RETRY_MAX_MS, Math.max(exponential, providerRetryAfterMs));
  }
  return exponential;
}

function encryptionContext(binding: PushInstallationBinding): PushTokenEncryptionContext {
  return {
    userId: binding.userId,
    installationId: binding.installationId,
    bindingId: binding.bindingId,
    tokenGeneration: binding.tokenGeneration,
  };
}

function encryptedToken(binding: PushInstallationBinding): EncryptedPushTokenV1 {
  return {
    keyVersion: binding.tokenKeyVersion as 1,
    nonceBase64: binding.tokenNonceBase64,
    ciphertextBase64: binding.tokenCiphertextBase64,
    authTagBase64: binding.tokenAuthTagBase64,
  };
}

/** Build only a validated opaque navigation payload from durable IDs. */
function envelopeForPushDelivery(
  delivery: PushNotificationDelivery,
): MobilePushEnvelopeV1 | null {
  const occurredAt = delivery.occurredAt;
  if (!Number.isFinite(occurredAt.getTime())) return null;
  const base = {
    version: 1 as const,
    notificationId: delivery.id,
    bindingId: delivery.bindingId,
    occurredAt: occurredAt.toISOString(),
  };
  if (
    delivery.kind === "important_message" &&
    delivery.roomId !== null &&
    delivery.topLevelRoomId !== null &&
    delivery.messageId !== null &&
    Number.isSafeInteger(delivery.messageId) &&
    delivery.messageId > 0
  ) {
    return { ...base, kind: "important_message", roomId: delivery.roomId, topLevelRoomId: delivery.topLevelRoomId, messageId: delivery.messageId };
  }
  if (
    delivery.kind === "needs_you" &&
    delivery.roomId !== null &&
    delivery.topLevelRoomId !== null &&
    delivery.attentionRequestId !== null
  ) {
    return { ...base, kind: "needs_you", roomId: delivery.roomId, topLevelRoomId: delivery.topLevelRoomId, attentionRequestId: delivery.attentionRequestId };
  }
  if (delivery.kind === "test") return { ...base, kind: "test" };
  return null;
}

/**
 * One bounded pump turn. Claims are durable and leased: an interruption after
 * a provider call can duplicate a generic notification, but can neither lose
 * an eligible event nor treat a response as delivered without its receipt.
 */
export class PushDeliveryWorker {
  private readonly db: DirectDatabase;
  private readonly workerId: string;
  private readonly provider: ExpoPushProvider;
  private readonly now: () => Date;
  private readonly getEncryptionKey: () => Uint8Array;
  private readonly readImportantArrivals: ImportantArrivalReader;
  private readonly readNotificationUnreadCount: NotificationUnreadCountReader;
  private readonly newDeliveryId: () => string;
  private lastMaintenanceAt = 0;

  constructor(deps: PushDeliveryWorkerDeps = {}) {
    this.db = deps.db ?? getServerDirectDb();
    this.workerId = deps.workerId ?? `push-delivery:${randomUUID()}`;
    this.provider = deps.provider ?? new ExpoPushProvider();
    this.now = deps.now ?? (() => new Date());
    this.getEncryptionKey = deps.getEncryptionKey ?? requirePushTokenEncryptionKey;
    this.readImportantArrivals = deps.getImportantMessageArrivals ?? getImportantMessageArrivals;
    this.readNotificationUnreadCount = deps.getNotificationUnreadCount ?? getNotificationUnreadCount;
    this.newDeliveryId = deps.newDeliveryId ?? randomUUID;
    if (this.workerId.trim().length === 0 || this.workerId.length > 128) {
      throw new Error("push worker ID must be nonempty and at most 128 characters");
    }
  }

  async runOnce(options: { readonly signal?: AbortSignal } = {}): Promise<PushDeliveryWorkerRunResult> {
    const now = validNow(this.now());
    const candidatesProcessed = await this.processOneMessageCandidate(now);
    const testsProcessed = await this.processOneTestIntent(now);
    const sendsClaimed = await this.processSendBatch(now, options.signal);
    const receiptsClaimed = await this.processReceiptBatch(now, options.signal);
    if (now.getTime() - this.lastMaintenanceAt >= PUSH_DELIVERY_MAINTENANCE_INTERVAL_MS) {
      await this.runMaintenance(now);
      this.lastMaintenanceAt = now.getTime();
    }
    return {
      didWork: candidatesProcessed + testsProcessed + sendsClaimed + receiptsClaimed > 0,
      candidatesProcessed,
      testsProcessed,
      sendsClaimed,
      receiptsClaimed,
    };
  }

  private async processOneMessageCandidate(now: Date): Promise<number> {
    const candidate = await this.db.transaction((tx) =>
      claimNextPushMessageCandidate(tx, { workerId: this.workerId, now }),
    );
    if (candidate === null) return 0;

    // The canonical shared classifier is read after the message commit. It
    // reads only structural facts and the admission marker; arbitrary chat
    // content never reaches this delivery worker.
    const arrivals = await this.readImportantArrivals(candidate.messageId, this.db);
    for (const arrival of arrivals) {
      await withTrustContext({ userId: arrival.userId }, (tx) =>
        enqueuePushNotificationDeliveriesForActiveBindings(tx, {
          userId: arrival.userId,
          target: {
            kind: "important_message",
            eventId: String(candidate.messageId),
            roomId: arrival.roomId,
            topLevelRoomId: arrival.topLevelRoomId,
            // The candidate is keyed by the canonical integer ID. The shared
            // realtime event stringifies it for transport, so do not round-
            // trip that representation into the durable delivery row.
            messageId: candidate.messageId,
            occurredAt: new Date(arrival.occurredAt),
          },
          now,
          newDeliveryId: this.newDeliveryId,
        }), this.db);
    }
    await this.db.transaction((tx) =>
      terminalizeClaimedPushMessageCandidate(tx, {
        workerId: this.workerId,
        messageId: candidate.messageId,
        now,
      }),
    );
    return 1;
  }

  private async processOneTestIntent(now: Date): Promise<number> {
    const intent = await this.db.transaction((tx) =>
      claimNextPushNotificationTestIntent(tx, { workerId: this.workerId, now }),
    );
    if (intent === null) return 0;
    await withTrustContext({ userId: intent.userId }, async (tx) => {
      await enqueuePushNotificationDeliveriesForActiveBindings(tx, {
        userId: intent.userId,
        target: {
          kind: "test",
          eventId: intent.notificationId,
          occurredAt: intent.occurredAt,
        },
        exactBinding: {
          bindingId: intent.bindingId,
          tokenGeneration: intent.tokenGeneration,
        },
        now,
        newDeliveryId: this.newDeliveryId,
      });
      await terminalizeClaimedPushNotificationTestIntent(tx, {
        workerId: this.workerId,
        notificationId: intent.notificationId,
        now,
      });
    }, this.db);
    return 1;
  }

  private async processSendBatch(now: Date, signal?: AbortSignal): Promise<number> {
    const claims = await this.claimBatch("send", now, EXPO_PUSH_MAX_MESSAGES_PER_REQUEST);
    if (claims.length === 0) return 0;
    const prepared: PreparedSend[] = [];
    const arrivalsByMessageId = new Map<number, Promise<ImportantMessageArrivedEvent[]>>();
    const unreadCountByUserId = new Map<string, Promise<number>>();
    for (const claim of claims) {
      const loaded = await this.loadClaimed(claim);
      if (loaded === null || loaded.binding === null) {
        await this.terminalizeMissingBinding(claim, now);
        continue;
      }
      const envelope = envelopeForPushDelivery(loaded.delivery);
      if (envelope === null) {
        await this.terminalize(claim, "invalid_delivery_target", now);
        continue;
      }
      let presentation: ExpoPushPresentation;
      let unreadCount = 0;
      if (envelope.kind === "important_message") {
        try {
          let arrivals = arrivalsByMessageId.get(envelope.messageId);
          if (!arrivals) {
            arrivals = this.readImportantArrivals(envelope.messageId, this.db);
            arrivalsByMessageId.set(envelope.messageId, arrivals);
          }
          const arrival = (await arrivals).find((candidate) => candidate.userId === claim.userId);
          if (!arrival) {
            await this.terminalize(claim, "important_message_no_longer_eligible", now);
            continue;
          }
          presentation = {
            kind: "important_message",
            senderDisplayName: arrival.senderDisplayName,
            roomLabel: arrival.roomLabel,
            ...(arrival.parentRoomLabel === undefined
              ? {}
              : { parentRoomLabel: arrival.parentRoomLabel }),
          };
          if (loaded.binding.platform === "ios" && loaded.binding.badgeEnabled) {
            let count = unreadCountByUserId.get(claim.userId);
            if (!count) {
              count = this.readNotificationUnreadCount(claim.userId, this.db);
              unreadCountByUserId.set(claim.userId, count);
            }
            unreadCount = await count;
          }
        } catch {
          await this.reschedule(
            claim,
            "send",
            "notification_state_unavailable",
            loaded.delivery.attemptCount,
            now,
          );
          continue;
        }
      } else {
        presentation = EXPO_PUSH_GENERIC_PRESENTATIONS[envelope.kind];
      }
      let expoPushToken: string;
      try {
        // Plaintext capability exists only while constructing this immediate
        // provider batch; it is never persisted or logged.
        expoPushToken = decryptPushToken(
          this.getEncryptionKey(),
          encryptedToken(loaded.binding),
          encryptionContext(loaded.binding),
        );
      } catch (error) {
        // Deployment configuration is recoverable: never silently discard a
        // valid durable notification merely because this process booted before
        // its secret was mounted. An authenticated-envelope failure is not.
        if (error instanceof PushTokenCryptoConfigurationError) {
          await this.reschedule(
            claim,
            "send",
            "push_crypto_unavailable",
            loaded.delivery.attemptCount,
            now,
          );
        } else {
          await this.terminalize(claim, "push_token_unreadable", now);
        }
        continue;
      }
      const badge = backgroundBadgeForPushDelivery({
        platform: loaded.binding.platform,
        badgeEnabled: loaded.binding.badgeEnabled,
        kind: envelope.kind,
        unreadCount,
      });
      prepared.push({
        claim,
        delivery: loaded.delivery,
        binding: loaded.binding,
        expo: {
          deliveryId: loaded.delivery.id,
          expoPushToken,
          envelope,
          presentation,
          ...(badge === undefined ? {} : { badge }),
        },
      });
    }
    if (prepared.length === 0) return claims.length;
    let outcomes: readonly ExpoPushProviderOutcome[];
    try {
      outcomes = await this.provider.send(
        prepared.map((item) => item.expo),
        signal === undefined ? {} : { signal },
      );
    } catch {
      outcomes = prepared.map((item) => ({
        kind: "retryable_provider_failure" as const,
        deliveryId: item.delivery.id,
        code: "network_error" as const,
      }));
    }
    const byDelivery = new Map(outcomes.map((outcome) => [outcome.deliveryId, outcome]));
    for (const item of prepared) {
      await this.settleSend(item, byDelivery.get(item.delivery.id), now);
    }
    return claims.length;
  }

  private async processReceiptBatch(now: Date, signal?: AbortSignal): Promise<number> {
    const claims = await this.claimBatch("receipt", now, 1_000);
    if (claims.length === 0) return 0;
    const lookups: { claim: ClaimedPushNotificationDelivery; delivery: PushNotificationDelivery; binding: PushInstallationBinding }[] = [];
    for (const claim of claims) {
      const loaded = await this.loadClaimed(claim);
      if (loaded === null || loaded.binding === null || loaded.delivery.ticketId === null) {
        await this.terminalizeMissingBinding(claim, now);
        continue;
      }
      lookups.push({ claim, delivery: loaded.delivery, binding: loaded.binding });
    }
    if (lookups.length === 0) return claims.length;
    let outcomes: readonly ExpoPushProviderOutcome[];
    try {
      outcomes = await this.provider.getReceipts(
        lookups.map((item) => ({ deliveryId: item.delivery.id, ticketId: item.delivery.ticketId! })),
        signal === undefined ? {} : { signal },
      );
    } catch {
      outcomes = lookups.map((item) => ({
        kind: "retryable_provider_failure" as const,
        deliveryId: item.delivery.id,
        code: "network_error" as const,
      }));
    }
    const byDelivery = new Map(outcomes.map((outcome) => [outcome.deliveryId, outcome]));
    for (const item of lookups) {
      await this.settleReceipt(item.claim, item.delivery, item.binding, byDelivery.get(item.delivery.id), now);
    }
    return claims.length;
  }

  private async claimBatch(
    purpose: "send" | "receipt",
    now: Date,
    maximum: number,
  ): Promise<readonly ClaimedPushNotificationDelivery[]> {
    const claims: ClaimedPushNotificationDelivery[] = [];
    for (let index = 0; index < maximum; index += 1) {
      const claim = await this.db.transaction((tx) =>
        claimNextPushNotificationDelivery(tx, { workerId: this.workerId, purpose, now }),
      );
      if (claim === null) break;
      claims.push(claim);
    }
    return claims;
  }

  private async loadClaimed(claim: ClaimedPushNotificationDelivery) {
    return withTrustContext({ userId: claim.userId }, (tx) =>
      getClaimedPushDeliveryWithBinding(tx, {
        userId: claim.userId,
        deliveryId: claim.deliveryId,
        workerId: this.workerId,
      }), this.db);
  }

  private async terminalizeMissingBinding(claim: ClaimedPushNotificationDelivery, now: Date): Promise<void> {
    await this.terminalize(claim, "binding_inactive_or_rotated", now);
  }

  private async terminalize(
    claim: ClaimedPushNotificationDelivery,
    failureCode: string,
    now: Date,
  ): Promise<void> {
    await withTrustContext({ userId: claim.userId }, (tx) =>
      terminalizeClaimedPushDelivery(tx, {
        userId: claim.userId,
        deliveryId: claim.deliveryId,
        workerId: this.workerId,
        failureCode,
        now,
      }), this.db);
  }

  private async settleSend(
    item: PreparedSend,
    outcome: ExpoPushProviderOutcome | undefined,
    now: Date,
  ): Promise<void> {
    const resolved = outcome ?? {
      kind: "retryable_provider_failure" as const,
      deliveryId: item.delivery.id,
      code: "malformed_response" as const,
    };
    await withTrustContext({ userId: item.claim.userId }, async (tx) => {
      if (resolved.kind === "accepted_ticket") {
        await markClaimedPushDeliveryTicketAccepted(tx, {
          userId: item.claim.userId,
          deliveryId: item.delivery.id,
          workerId: this.workerId,
          ticketId: resolved.ticketId,
          now,
          receiptNotBefore: new Date(now.getTime() + PUSH_DELIVERY_RECEIPT_DELAY_MS),
        });
      } else if (resolved.kind === "device_not_registered") {
        await retirePushBindingGenerationForUser(tx, {
          userId: item.claim.userId,
          bindingId: item.binding.bindingId,
          tokenGeneration: item.binding.tokenGeneration,
          now,
        });
      } else if (resolved.kind === "permanent_provider_failure") {
        await terminalizeClaimedPushDelivery(tx, {
          userId: item.claim.userId,
          deliveryId: item.delivery.id,
          workerId: this.workerId,
          failureCode: resolved.code,
          now,
        });
      } else if (resolved.kind === "retryable_provider_failure") {
        await rescheduleClaimedPushDelivery(tx, {
          userId: item.claim.userId,
          deliveryId: item.delivery.id,
          workerId: this.workerId,
          purpose: "send",
          failureCode: resolved.code,
          nextAttemptAt: new Date(now.getTime() + boundedRetryDelay(item.delivery.attemptCount, resolved.retryAfterMs)),
          now,
        });
      } else {
        await terminalizeClaimedPushDelivery(tx, {
          userId: item.claim.userId,
          deliveryId: item.delivery.id,
          workerId: this.workerId,
          failureCode: "unexpected_send_receipt_outcome",
          now,
        });
      }
    }, this.db);
  }

  private async reschedule(
    claim: ClaimedPushNotificationDelivery,
    purpose: "send" | "receipt",
    failureCode: string,
    attempt: number,
    now: Date,
  ): Promise<void> {
    await withTrustContext({ userId: claim.userId }, (tx) =>
      rescheduleClaimedPushDelivery(tx, {
        userId: claim.userId,
        deliveryId: claim.deliveryId,
        workerId: this.workerId,
        purpose,
        failureCode,
        nextAttemptAt: new Date(now.getTime() + boundedRetryDelay(attempt)),
        now,
      }), this.db);
  }

  private async settleReceipt(
    claim: ClaimedPushNotificationDelivery,
    delivery: PushNotificationDelivery,
    binding: PushInstallationBinding,
    outcome: ExpoPushProviderOutcome | undefined,
    now: Date,
  ): Promise<void> {
    const resolved = outcome ?? {
      kind: "retryable_provider_failure" as const,
      deliveryId: delivery.id,
      code: "malformed_response" as const,
    };
    await withTrustContext({ userId: claim.userId }, async (tx) => {
      if (resolved.kind === "delivered" && delivery.ticketId !== null) {
        await markClaimedPushDeliveryDelivered(tx, {
          userId: claim.userId,
          deliveryId: delivery.id,
          workerId: this.workerId,
          ticketId: delivery.ticketId,
          now,
        });
      } else if (resolved.kind === "device_not_registered") {
        await retirePushBindingGenerationForUser(tx, {
          userId: claim.userId,
          bindingId: binding.bindingId,
          tokenGeneration: binding.tokenGeneration,
          now,
        });
      } else if (resolved.kind === "permanent_provider_failure") {
        await terminalizeClaimedPushDelivery(tx, {
          userId: claim.userId,
          deliveryId: delivery.id,
          workerId: this.workerId,
          failureCode: resolved.code,
          now,
        });
      } else if (resolved.kind === "retryable_provider_failure") {
        await rescheduleClaimedPushDelivery(tx, {
          userId: claim.userId,
          deliveryId: delivery.id,
          workerId: this.workerId,
          purpose: "receipt",
          failureCode: resolved.code,
          nextAttemptAt: new Date(now.getTime() + boundedRetryDelay(delivery.receiptAttemptCount, resolved.retryAfterMs)),
          now,
        });
      } else {
        await terminalizeClaimedPushDelivery(tx, {
          userId: claim.userId,
          deliveryId: delivery.id,
          workerId: this.workerId,
          failureCode: "unexpected_receipt_outcome",
          now,
        });
      }
    }, this.db);
  }

  private async runMaintenance(now: Date): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        await runPushDeliveryMaintenance(tx, { now, limit: PUSH_CLEANUP_BATCH_LIMIT });
        await purgeTerminalPushMessageCandidates(tx, {
          before: new Date(now.getTime() - PUSH_TERMINAL_RETENTION_MS),
          limit: PUSH_CLEANUP_BATCH_LIMIT,
        });
      });
    } catch (error) {
      // Maintenance is isolated from delivery progress. Keep only the error
      // category, never an SQL statement, token, payload, or user data.
      warn(`[push-delivery] bounded maintenance deferred: ${error instanceof Error ? error.name : "unknown"}`);
    }
  }
}

export function createPushDeliveryWorker(deps: PushDeliveryWorkerDeps = {}): PushDeliveryWorker {
  return new PushDeliveryWorker(deps);
}
