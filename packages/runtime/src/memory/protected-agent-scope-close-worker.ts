import { createHash } from "node:crypto";
import type { ProtectedMemoryResult } from "@nautilo/lattice-bridge";
import type {
  PostgresProtectedScopeCloseSaga,
  ProtectedScopeCloseItem,
} from "@nautilo/trust";

const MAX_BATCH = 4;
const MAX_RETRY_DELAY_MS = 60 * 60_000;

export type ProtectedAgentScopeCloseTransitionResult =
  | Readonly<{
      status: "complete";
      productReceiptRef: string;
      cryptoReceiptRef: string;
    }>
  | Readonly<{ status: "retry"; retryAfterMs: number }>
  | Readonly<{ status: "stale" | "quarantined"; failureCode: string }>;

export type ProtectedAgentScopeCloseWorkerResult = Readonly<{
  status: "closed" | "closing" | "quarantined" | "not_found";
  processed: number;
}>;

export type ProtectedAgentScopeCloseAttempt = Readonly<{
  closeOperationId: string;
  scopeId: string;
  attemptCount: number;
  item: ProtectedScopeCloseItem;
}>;

type PromotionReconcileResult =
  | Readonly<{ status: "pending"; phase: "crypto" }>
  | Readonly<{ status: "completed" }>
  | Readonly<{ status: "stale" | "denied" | "quarantined" }>;

function itemOperationId(
  attempt: ProtectedAgentScopeCloseAttempt,
  attemptCount: number,
): string {
  return `scope-item:${createHash("sha256").update(
    `nautilo/protected-scope-close-item/v1\n${attempt.closeOperationId}\n${attempt.item.ordinal}\n${attemptCount}`,
    "utf8",
  ).digest("hex")}`;
}

function receiptRefs(operationId: string) {
  return Object.freeze({
    productReceiptRef: `product:${operationId}`,
    cryptoReceiptRef: `crypto:${operationId}`,
  });
}

function unavailableTransition(
  reason: Extract<ProtectedMemoryResult<never>, { status: "unavailable" }>["reason"],
): ProtectedAgentScopeCloseTransitionResult {
  return reason === "stale_revision"
    ? Object.freeze({ status: "stale" as const, failureCode: "product_stale" })
    : reason === "integrity_failure"
    ? Object.freeze({
        status: "quarantined" as const,
        failureCode: "transition_integrity_failure",
      })
    : Object.freeze({ status: "retry" as const, retryAfterMs: 5_000 });
}

/**
 * Restart-aware per-item close transition. Seed edges are product-only.
 * Scope-origin promotion first reconciles the preceding durable exact-access
 * operation; only a pre-crypto/stale attempt is replaced with a fresh
 * foreground Grant/session operation.
 */
export function createProtectedAgentScopeCloseTransition(input: Readonly<{
  detachSeed(attempt: ProtectedAgentScopeCloseAttempt): Promise<
    ProtectedMemoryResult<Readonly<{ productReceiptRef: string }>>
  >;
  reconcilePromotion(request: Readonly<{
    operationId: string;
    attempt: ProtectedAgentScopeCloseAttempt;
  }>): Promise<PromotionReconcileResult>;
  promote(request: Readonly<{
    operationId: string;
    attempt: ProtectedAgentScopeCloseAttempt;
  }>): Promise<ProtectedMemoryResult<Readonly<{
    status: "updated" | "replayed";
    memoryId: string;
  }>>>;
}>): (attempt: ProtectedAgentScopeCloseAttempt) =>
  Promise<ProtectedAgentScopeCloseTransitionResult> {
  return async (attempt) => {
    if (attempt.item.action === "detach_seed") {
      const detached = await input.detachSeed(attempt);
      return detached.status === "unavailable"
        ? unavailableTransition(detached.reason)
        : Object.freeze({
            status: "complete" as const,
            productReceiptRef: detached.value.productReceiptRef,
            cryptoReceiptRef: "crypto:not-required",
          });
    }
    if (attempt.attemptCount > 1) {
      const previousOperationId = itemOperationId(
        attempt,
        attempt.attemptCount - 1,
      );
      const reconciled = await input.reconcilePromotion({
        operationId: previousOperationId,
        attempt,
      });
      if (reconciled.status === "completed") {
        return Object.freeze({
          status: "complete" as const,
          ...receiptRefs(previousOperationId),
        });
      }
      if (reconciled.status === "pending" || reconciled.status === "denied") {
        return Object.freeze({ status: "retry" as const, retryAfterMs: 5_000 });
      }
      if (reconciled.status === "quarantined") {
        return Object.freeze({
          status: "quarantined" as const,
          failureCode: "access_reconciliation_conflict",
        });
      }
      // A stale observation means crypto never advanced. The product
      // reservation was quarantined, so this claimed attempt may acquire a
      // fresh foreground Grant/session under a new operation id.
    }
    const operationId = itemOperationId(attempt, attempt.attemptCount);
    const promoted = await input.promote({ operationId, attempt });
    return promoted.status === "unavailable"
      ? unavailableTransition(promoted.reason)
      : Object.freeze({
          status: "complete" as const,
          ...receiptRefs(operationId),
        });
  };
}

/**
 * Explicit dormant worker for one durable AgentScope close operation. It is
 * deliberately not registered with a scheduler. Every claimed item is
 * content-free and the injected transition owns product/crypto authority.
 */
export async function runProtectedAgentScopeCloseWorker(input: Readonly<{
  saga: Pick<
    PostgresProtectedScopeCloseSaga,
    "claim" | "completeClaim" | "finalize"
  >;
  operationId: string;
  scopeId: string;
  parentAgentId: string;
  speakerUserId: string;
  workerId: string;
  now(): number;
  createClaimToken(): string;
  transition(attempt: ProtectedAgentScopeCloseAttempt):
    Promise<ProtectedAgentScopeCloseTransitionResult>;
  maximumItems?: number;
}>): Promise<ProtectedAgentScopeCloseWorkerResult> {
  const maximumItems = input.maximumItems ?? MAX_BATCH;
  if (!Number.isSafeInteger(maximumItems) || maximumItems < 1
    || maximumItems > MAX_BATCH) {
    throw new RangeError("Protected scope-close batch must be within 1..4");
  }
  let processed = 0;
  while (processed < maximumItems) {
    const now = input.now();
    const claim = await input.saga.claim({
      operationId: input.operationId,
      parentAgentId: input.parentAgentId,
      speakerUserId: input.speakerUserId,
      claimToken: input.createClaimToken(),
      claimOwner: input.workerId,
      now,
      leaseMs: 60_000,
    });
    if (claim.status === "not_found") {
      return Object.freeze({ status: "not_found", processed });
    }
    if (claim.status !== "claimed") break;
    let result: ProtectedAgentScopeCloseTransitionResult;
    try {
      result = await input.transition(Object.freeze({
        closeOperationId: input.operationId,
        scopeId: input.scopeId,
        attemptCount: claim.attemptCount,
        item: claim.item,
      }));
    } catch {
      result = Object.freeze({ status: "retry", retryAfterMs: 5_000 });
    }
    const completed = await input.saga.completeClaim({
      operationId: input.operationId,
      parentAgentId: input.parentAgentId,
      speakerUserId: input.speakerUserId,
      ordinal: claim.item.ordinal,
      claimToken: claim.claimToken,
      claimOwner: claim.claimOwner,
      now: input.now(),
      result: result.status === "complete"
        ? result
        : result.status === "retry"
        ? Object.freeze({
            status: "retry" as const,
            nextAttemptAt: input.now() + Math.min(
              Math.max(1, result.retryAfterMs),
              MAX_RETRY_DELAY_MS,
            ),
          })
        : result,
    });
    if (completed === "stale_claim") {
      return Object.freeze({ status: "closing", processed });
    }
    processed += 1;
    if (result.status === "stale" || result.status === "quarantined") break;
  }
  const finalized = await input.saga.finalize({
    operationId: input.operationId,
    parentAgentId: input.parentAgentId,
    speakerUserId: input.speakerUserId,
    now: input.now(),
  });
  return Object.freeze({
    status: finalized === "complete" || finalized === "already_complete"
      ? "closed"
      : finalized === "quarantined"
      ? "quarantined"
      : finalized === "not_found"
      ? "not_found"
      : "closing",
    processed,
  });
}
