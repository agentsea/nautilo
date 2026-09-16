/**
 * D448 Phase 8.2 — whole-batch publisher for committed Workspace mutations.
 *
 * This is intentionally separate from legacy/bounded artifact notification
 * queues. A receipt's ordered committed-event batch is durable truth and is
 * claimed, published, released, and finalized as one unit.
 */

import {
  claimNextWorkspaceDocumentMutationOutboxBatch,
  listStaleWorkspaceDocumentMutationOutboxBatchKeys,
  markWorkspaceDocumentMutationOutboxDispatched,
  markWorkspaceDocumentMutationOutboxFailed,
  releaseStaleWorkspaceDocumentMutationOutboxClaims,
  type DirectDatabase,
  type WorkspaceDocumentMutationOutboxRow,
  type WorkspaceDocumentMutationTx,
} from "@nautilo/db";
import {
  deriveAtomicDocumentMutationBatchIdempotencyKey,
  type AtomicDocumentMutationEventBatch,
  type DocumentMutationEventPublisher,
} from "@nautilo/document-mutations";
import { parseDocumentMutationCommittedEvent } from "@nautilo/types";
import { getServerDirectDb } from "../lib/server-direct-db";

export type WorkspaceDocumentMutationOutboxPublisher = DocumentMutationEventPublisher;

type WorkspaceOutboxHelpers = {
  readonly claim: typeof claimNextWorkspaceDocumentMutationOutboxBatch;
  readonly listStaleBatchKeys:
    typeof listStaleWorkspaceDocumentMutationOutboxBatchKeys;
  readonly markDispatched: typeof markWorkspaceDocumentMutationOutboxDispatched;
  readonly markFailed: typeof markWorkspaceDocumentMutationOutboxFailed;
  readonly releaseStale: typeof releaseStaleWorkspaceDocumentMutationOutboxClaims;
};

export type WorkspaceDocumentMutationOutboxRunnerDependencies = {
  readonly publisher: WorkspaceDocumentMutationOutboxPublisher;
  readonly workerId: string;
  readonly db?: DirectDatabase;
  readonly now?: () => Date;
  /** No retry cap: callers can supply their normal unbounded backoff policy. */
  readonly nextAttemptAt?: (input: {
    readonly now: Date;
    readonly error: unknown;
    readonly rows: readonly WorkspaceDocumentMutationOutboxRow[];
  }) => Date;
  readonly helpers?: Partial<WorkspaceOutboxHelpers>;
};

export type WorkspaceDocumentMutationOutboxRunOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "dispatched"; readonly batchIdempotencyKey: string; readonly count: number }
  | { readonly kind: "retry_scheduled"; readonly batchIdempotencyKey: string; readonly count: number }
  | {
      /** Events were already published; do not reinterpret this as a failed save. */
      readonly kind: "published_finalization_unknown";
      readonly batchIdempotencyKey: string;
    }
  | { readonly kind: "invalid_batch_released"; readonly batchIdempotencyKey: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Workspace outbox publish failed";
}

/** Parses and proves one exact ordered batch before it reaches a publisher. */
export function workspaceOutboxRowsToAtomicBatch(
  rows: readonly WorkspaceDocumentMutationOutboxRow[],
): AtomicDocumentMutationEventBatch {
  if (rows.length === 0) throw new Error("Workspace outbox cannot publish an empty batch");
  const batchIdempotencyKey = rows[0]!.batchIdempotencyKey;
  const events = rows.map((row, sequence) => {
    if (
      row.batchIdempotencyKey !== batchIdempotencyKey ||
      row.sequence !== sequence ||
      row.eventType !== "document.mutation.committed"
    ) {
      throw new Error("Workspace outbox batch is not complete, ordered, and contiguous");
    }
    const event = parseDocumentMutationCommittedEvent(row.payload);
    if (event.sequence !== sequence) {
      throw new Error("Workspace outbox payload sequence does not match its durable row");
    }
    return event;
  });
  const first = events[0]!;
  if (events.some((event) =>
    event.operationId !== first.operationId || event.revisionGroupId !== first.revisionGroupId,
  )) {
    throw new Error("Workspace outbox batch contains mixed operation or revision-group evidence");
  }
  const expectedKey = deriveAtomicDocumentMutationBatchIdempotencyKey(
    first.operationId,
    first.revisionGroupId,
  );
  if (batchIdempotencyKey !== expectedKey) {
    throw new Error("Workspace outbox batch idempotency key is not the shared canonical key");
  }
  return {
    operationId: first.operationId,
    revisionGroupId: first.revisionGroupId,
    idempotencyKey: batchIdempotencyKey,
    events,
  };
}

export class WorkspaceDocumentMutationOutboxRunner {
  private readonly db: DirectDatabase;
  private readonly now: () => Date;
  private readonly helpers: WorkspaceOutboxHelpers;

  constructor(private readonly dependencies: WorkspaceDocumentMutationOutboxRunnerDependencies) {
    if (dependencies.workerId.trim().length === 0) {
      throw new Error("Workspace outbox worker ID must be nonempty");
    }
    this.db = dependencies.db ?? getServerDirectDb();
    this.now = dependencies.now ?? (() => new Date());
    this.helpers = {
      claim: dependencies.helpers?.claim ?? claimNextWorkspaceDocumentMutationOutboxBatch,
      listStaleBatchKeys:
        dependencies.helpers?.listStaleBatchKeys ??
        listStaleWorkspaceDocumentMutationOutboxBatchKeys,
      markDispatched: dependencies.helpers?.markDispatched ?? markWorkspaceDocumentMutationOutboxDispatched,
      markFailed: dependencies.helpers?.markFailed ?? markWorkspaceDocumentMutationOutboxFailed,
      releaseStale: dependencies.helpers?.releaseStale ?? releaseStaleWorkspaceDocumentMutationOutboxClaims,
    };
  }

  /**
   * Explicit restart-recovery seam. A scheduler that knows the abandoned batch
   * key invokes this; the DB helper rejects a mixed fresh/stale batch rather
   * than silently splitting it.
   */
  async releaseStaleClaim(input: {
    readonly batchIdempotencyKey: string;
    readonly claimedBefore: Date;
  }): Promise<number> {
    const now = this.now();
    return this.db.transaction((tx) => this.helpers.releaseStale(tx, {
      batchIdempotencyKey: input.batchIdempotencyKey,
      claimedBefore: input.claimedBefore,
      now,
    }));
  }

  /**
   * Restart recovery discovers abandoned batches itself, then re-locks and
   * revalidates each exact batch before release. Discovery is intentionally
   * unbounded; durable events cannot be stranded behind a result ceiling.
   */
  async recoverAllStaleClaims(claimedBefore: Date): Promise<number> {
    if (!Number.isFinite(claimedBefore.getTime())) {
      throw new Error("Workspace outbox stale-claim cutoff must be a valid date");
    }
    const keys = await this.db.transaction((tx) =>
      this.helpers.listStaleBatchKeys(tx, claimedBefore)
    );
    let released = 0;
    for (const batchIdempotencyKey of keys) {
      released += await this.releaseStaleClaim({
        batchIdempotencyKey,
        claimedBefore,
      });
    }
    return released;
  }

  async runOnce(): Promise<WorkspaceDocumentMutationOutboxRunOutcome> {
    const claimedAt = this.now();
    const rows = await this.db.transaction((tx) => this.helpers.claim(tx, {
      workerId: this.dependencies.workerId,
      now: claimedAt,
    }));
    if (rows.length === 0) return { kind: "idle" };
    const batchIdempotencyKey = rows[0]!.batchIdempotencyKey;

    let batch: AtomicDocumentMutationEventBatch;
    try {
      batch = workspaceOutboxRowsToAtomicBatch(rows);
    } catch (error) {
      // Corrupt durable evidence must never be partially emitted. Releasing it
      // preserves complete-batch recovery/diagnostics without a retry ceiling.
      await this.releaseBatch(rows, error);
      return { kind: "invalid_batch_released", batchIdempotencyKey };
    }

    try {
      const publication = await this.dependencies.publisher.publishAtomic(batch);
      if (publication.kind !== "published") {
        await this.releaseBatch(rows, new Error(`Publisher returned ${publication.kind}`));
        return { kind: "retry_scheduled", batchIdempotencyKey, count: rows.length };
      }
    } catch (error) {
      await this.releaseBatch(rows, error);
      return { kind: "retry_scheduled", batchIdempotencyKey, count: rows.length };
    }

    try {
      const marked = await this.db.transaction((tx) => this.helpers.markDispatched(tx, {
        workerId: this.dependencies.workerId,
        batchIdempotencyKey,
        now: this.now(),
      }));
      if (marked !== rows.length) {
        return { kind: "published_finalization_unknown", batchIdempotencyKey };
      }
      return { kind: "dispatched", batchIdempotencyKey, count: marked };
    } catch {
      // Publication succeeded. At-least-once retry is acceptable, but reporting
      // this as a failed mutation would contradict the durable commit receipt.
      return { kind: "published_finalization_unknown", batchIdempotencyKey };
    }
  }

  private async releaseBatch(
    rows: readonly WorkspaceDocumentMutationOutboxRow[],
    error: unknown,
  ): Promise<void> {
    const now = this.now();
    // This is a floor, not a retry-count or lifetime ceiling. It prevents a
    // corrupt/temporarily unavailable batch from becoming a zero-delay hot loop
    // when the host has not installed its normal unbounded backoff policy.
    const retryFloorMs = now.getTime() + 1_000;
    const proposed = this.dependencies.nextAttemptAt?.({ now, error, rows });
    const proposedMs = proposed?.getTime();
    const nextAttemptAt = new Date(
      proposedMs !== undefined && Number.isFinite(proposedMs)
        ? Math.max(proposedMs, retryFloorMs)
        : retryFloorMs,
    );
    await this.db.transaction((tx: WorkspaceDocumentMutationTx) => this.helpers.markFailed(tx, {
      workerId: this.dependencies.workerId,
      batchIdempotencyKey: rows[0]!.batchIdempotencyKey,
      now,
      nextAttemptAt,
      error: errorMessage(error),
    }));
  }
}

export function createWorkspaceDocumentMutationOutboxRunner(
  dependencies: WorkspaceDocumentMutationOutboxRunnerDependencies,
): WorkspaceDocumentMutationOutboxRunner {
  return new WorkspaceDocumentMutationOutboxRunner(dependencies);
}
