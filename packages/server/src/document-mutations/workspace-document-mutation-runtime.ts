/**
 * Process-wide delivery lifecycle for the durable Workspace mutation outbox.
 *
 * Save requests only enlist events; they never publish directly. This runtime
 * is the one live-delivery owner, so a post-commit transport failure cannot
 * roll back a real save or produce a coordinator/outbox duplicate.
 */

import { randomUUID } from "node:crypto";
import { warn } from "@nautilo/logger";
import { eventBus } from "@nautilo/runtime";
import type { AtomicDocumentMutationEventBatch } from "@nautilo/document-mutations";
import {
  createWorkspaceDocumentMutationOutboxRunner,
  type WorkspaceDocumentMutationOutboxRunner,
} from "./workspace-document-mutation-outbox";

const STALE_CLAIM_MS = 60_000;
const RETRY_TICK_MS = 1_000;

let runner: WorkspaceDocumentMutationOutboxRunner | undefined;
let pumpQueued = false;
let staleRecoveryQueued = false;
let retryTimer: ReturnType<typeof setInterval> | undefined;

function getRunner(): WorkspaceDocumentMutationOutboxRunner {
  runner ??= createWorkspaceDocumentMutationOutboxRunner({
    workerId: `workspace-document-mutations:${randomUUID()}`,
    publisher: {
      publishAtomic: (batch: AtomicDocumentMutationEventBatch) => {
        for (const event of batch.events) eventBus.emit(event);
        return Promise.resolve({ kind: "published" as const });
      },
    },
  });
  return runner;
}

async function pump(): Promise<void> {
  // No result-count cap: all currently claimable complete batches are pumped.
  // A retry-scheduled batch is no longer claimable until its durable next
  // attempt time, so continuing cannot hot-loop that one failed batch.
  for (;;) {
    const outcome = await getRunner().runOnce();
    if (outcome.kind === "idle") return;
  }
}

/** Queue non-blocking delivery after a durable commit. */
export function requestWorkspaceDocumentMutationOutboxPump(): void {
  if (pumpQueued) return;
  pumpQueued = true;
  queueMicrotask(() => {
    void pump()
      .catch((error: unknown) => {
        warn(`[workspace-document-mutations] outbox pump: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        pumpQueued = false;
      });
  });
}

/**
 * Reclaim abandoned same-process claims before draining due batches. A live
 * server can lose a worker promise just as easily as it can restart, so
 * startup-only recovery would strand a claimed receipt forever. Recovery is
 * serialized separately from pumping; the runner's transactional helpers
 * re-check complete batches and therefore never split a fresh claim.
 */
function requestWorkspaceDocumentMutationStaleRecovery(): void {
  if (staleRecoveryQueued) return;
  staleRecoveryQueued = true;
  queueMicrotask(() => {
    void getRunner()
      .recoverAllStaleClaims(new Date(Date.now() - STALE_CLAIM_MS))
      .catch((error: unknown) => {
        warn(`[workspace-document-mutations] stale-claim recovery: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        staleRecoveryQueued = false;
        // This is intentionally after recovery. `pump` drains every due
        // complete batch; failed publication gets a durable floor so it cannot
        // spin while disconnected clients recover through authorized history.
        requestWorkspaceDocumentMutationOutboxPump();
      });
  });
}

/**
 * Server-start lifecycle. Recovery is asynchronous and fail-closed for
 * delivery only: a missing migration/temporary DB failure cannot prevent the
 * server from booting, and the normal retry tick retries durable work later.
 */
export function startWorkspaceDocumentMutationOutboxRuntime(): void {
  if (retryTimer !== undefined) return;
  retryTimer = setInterval(requestWorkspaceDocumentMutationStaleRecovery, RETRY_TICK_MS);
  retryTimer.unref?.();
  requestWorkspaceDocumentMutationStaleRecovery();
}

/** Test/shutdown seam; normal production shutdown simply tears down process timers. */
export function stopWorkspaceDocumentMutationOutboxRuntime(): void {
  if (retryTimer !== undefined) clearInterval(retryTimer);
  retryTimer = undefined;
  pumpQueued = false;
  staleRecoveryQueued = false;
}
