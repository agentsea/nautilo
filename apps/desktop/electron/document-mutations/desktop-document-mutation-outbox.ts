/**
 * D448 Phase 8.2 — whole-batch publisher for committed Desktop mutations.
 */

import {
  deriveAtomicDocumentMutationBatchIdempotencyKey,
  type AtomicDocumentMutationEventBatch,
  type DocumentMutationEventPublisher,
} from "@nautilo/document-mutations";
import { parseDocumentMutationCommittedEvent } from "@nautilo/types";

import { LocalDurableMutationJournal } from "../local-file-history/durable-mutations.ts";
import type {
  LocalMutationOutboxBatch,
  LocalMutationRecoveryResult,
} from "../local-file-history/types.ts";

export type DesktopDocumentMutationOutboxRunnerDependencies = {
  readonly journal: LocalDurableMutationJournal;
  readonly publisher: DocumentMutationEventPublisher;
  readonly workerId: string;
  readonly now?: () => Date;
  /** Caller-owned unbounded retry policy. */
  readonly nextAttemptAt?: (input: {
    readonly now: Date;
    readonly error: unknown;
    readonly batch: LocalMutationOutboxBatch;
  }) => Date;
  /** Optional abandoned-claim policy used after process restart. */
  readonly staleClaimBefore?: (now: Date) => Date;
};

/** A crashed publisher claim is reclaimable after this bounded default age. */
export const DEFAULT_DESKTOP_OUTBOX_STALE_CLAIM_MS = 60_000;

export type DesktopDocumentMutationOutboxRunOutcome =
  | { readonly kind: "idle"; readonly nextWakeAt?: string }
  | {
      readonly kind: "dispatched";
      readonly batchIdempotencyKey: string;
      readonly count: number;
    }
  | {
      readonly kind: "retry_scheduled";
      readonly batchIdempotencyKey: string;
      readonly count: number;
      readonly nextWakeAt: string;
    }
  | {
      readonly kind: "published_finalization_unknown";
      readonly batchIdempotencyKey: string;
      readonly nextWakeAt: string;
    }
  | {
      readonly kind: "invalid_batch_released";
      readonly batchIdempotencyKey: string;
      readonly nextWakeAt: string;
    };

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Desktop outbox publication failed";
}

/** Independently proves the exact atomic batch before publication. */
export function desktopOutboxRecordToAtomicBatch(
  record: LocalMutationOutboxBatch,
): AtomicDocumentMutationEventBatch {
  const batch = record.batch;
  if (
    record.id !== batch.idempotencyKey ||
    record.operationId !== batch.operationId ||
    record.revisionGroupId !== batch.revisionGroupId ||
    batch.events.length === 0 ||
    batch.idempotencyKey !==
      deriveAtomicDocumentMutationBatchIdempotencyKey(
        batch.operationId,
        batch.revisionGroupId,
      )
  ) {
    throw new Error("Desktop outbox record correlation is invalid");
  }
  const events = batch.events.map((raw, sequence) => {
    const event = parseDocumentMutationCommittedEvent(raw);
    if (
      event.operationId !== batch.operationId ||
      event.revisionGroupId !== batch.revisionGroupId ||
      event.sequence !== sequence
    ) {
      throw new Error("Desktop outbox event order or correlation is invalid");
    }
    return event;
  });
  return {
    operationId: batch.operationId,
    revisionGroupId: batch.revisionGroupId,
    idempotencyKey: batch.idempotencyKey,
    events,
  };
}

export class DesktopDocumentMutationOutboxRunner {
  private readonly now: () => Date;

  constructor(
    private readonly dependencies: DesktopDocumentMutationOutboxRunnerDependencies,
  ) {
    if (dependencies.workerId.trim().length === 0) {
      throw new Error("Desktop outbox worker ID must be nonempty");
    }
    this.now = dependencies.now ?? (() => new Date());
  }

  /**
   * Resolve pending byte/journal truth, then immediately reclaim and publish
   * every currently due batch. A retry or unknown publication result stops the
   * startup drain so caller scheduling remains authoritative.
   */
  async recoverAtStartup(): Promise<LocalMutationRecoveryResult[]> {
    const recovered = await this.dependencies.journal.recover();
    for (;;) {
      const outcome = await this.runOnce();
      if (outcome.kind !== "dispatched") break;
    }
    return recovered;
  }

  async runOnce(): Promise<DesktopDocumentMutationOutboxRunOutcome> {
    const claimedAt = finiteDate("Desktop outbox current time", this.now());
    const staleClaimBefore = safeStaleClaimBefore(
      claimedAt,
      this.dependencies.staleClaimBefore?.(claimedAt) ??
        new Date(
          claimedAt.getTime() - DEFAULT_DESKTOP_OUTBOX_STALE_CLAIM_MS,
        ),
    ).toISOString();
    const staleClaimAfterMs = claimedAt.getTime() -
      new Date(staleClaimBefore).getTime();
    const claimed = await this.dependencies.journal.claimOutbox({
      claimantId: this.dependencies.workerId,
      now: claimedAt.toISOString(),
      ...(staleClaimBefore === undefined ? {} : { staleClaimBefore }),
    });
    if (!claimed) {
      const nextWakeAt = await this.dependencies.journal.nextOutboxWakeAt({
        now: claimedAt.toISOString(),
        staleClaimAfterMs,
      });
      return {
        kind: "idle",
        ...(nextWakeAt === undefined ? {} : { nextWakeAt }),
      };
    }

    let batch: AtomicDocumentMutationEventBatch;
    try {
      batch = desktopOutboxRecordToAtomicBatch(claimed);
    } catch (error) {
      const nextWakeAt = await this.release(claimed, error);
      return {
        kind: "invalid_batch_released",
        batchIdempotencyKey: claimed.id,
        nextWakeAt,
      };
    }

    try {
      const publication = await this.dependencies.publisher.publishAtomic(batch);
      if (publication.kind !== "published") {
        const nextWakeAt = await this.release(
          claimed,
          new Error(`publisher returned ${publication.kind}`),
        );
        return {
          kind: "retry_scheduled",
          batchIdempotencyKey: claimed.id,
          count: batch.events.length,
          nextWakeAt,
        };
      }
    } catch (error) {
      const nextWakeAt = await this.release(claimed, error);
      return {
        kind: "retry_scheduled",
        batchIdempotencyKey: claimed.id,
        count: batch.events.length,
        nextWakeAt,
      };
    }

    try {
      await this.dependencies.journal.ackOutbox(
        claimed.id,
        this.dependencies.workerId,
        this.now().toISOString(),
      );
      return {
        kind: "dispatched",
        batchIdempotencyKey: claimed.id,
        count: batch.events.length,
      };
    } catch {
      // The batch was published. Durable commit truth is independent of live
      // publication/finalization and an idempotent publisher may see it again.
      return {
        kind: "published_finalization_unknown",
        batchIdempotencyKey: claimed.id,
        nextWakeAt: new Date(
          Date.parse(claimed.claimedAt ?? claimedAt.toISOString()) +
            staleClaimAfterMs,
        ).toISOString(),
      };
    }
  }

  private async release(
    claimed: LocalMutationOutboxBatch,
    error: unknown,
  ): Promise<string> {
    const now = finiteDate("Desktop outbox retry time", this.now());
    const nextAttemptAt = safeNextAttemptAt(
      now,
      this.dependencies.nextAttemptAt?.({ now, error, batch: claimed }),
    );
    await this.dependencies.journal.retryOutbox(
      claimed.id,
      this.dependencies.workerId,
      errorMessage(error),
      nextAttemptAt.toISOString(),
    );
    return nextAttemptAt.toISOString();
  }
}

const SAFE_TIME_FLOOR_MS = 1_000;

function finiteDate(name: string, value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${name} must be a finite Date`);
  }
  return value;
}

function safeNextAttemptAt(now: Date, candidate: Date | undefined): Date {
  const floor = now.getTime() + SAFE_TIME_FLOOR_MS;
  const candidateMs = candidate?.getTime();
  return new Date(
    candidateMs !== undefined &&
      Number.isFinite(candidateMs) &&
      candidateMs >= floor
      ? candidateMs
      : floor,
  );
}

function safeStaleClaimBefore(
  now: Date,
  candidate: Date,
): Date {
  const candidateMs = candidate.getTime();
  if (!Number.isFinite(candidateMs)) {
    return new Date(
      now.getTime() - DEFAULT_DESKTOP_OUTBOX_STALE_CLAIM_MS,
    );
  }
  return new Date(
    Math.min(candidateMs, now.getTime() - SAFE_TIME_FLOOR_MS),
  );
}

export function createDesktopDocumentMutationOutboxRunner(
  dependencies: DesktopDocumentMutationOutboxRunnerDependencies,
): DesktopDocumentMutationOutboxRunner {
  return new DesktopDocumentMutationOutboxRunner(dependencies);
}
