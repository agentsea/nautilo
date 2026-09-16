/**
 * D087 Phase 3 §3.10 — revision-event sink.
 *
 * The backup subsystem (record-revision.ts, gc.ts) needs to broadcast
 * `revisions.state_changed` events whenever the revision-store state
 * for a given path changes — row inserted, row evicted by GC, etc.
 *
 * The broadcaster lives in `@nautilo/server` (ws-publisher.ts's
 * `broadcast()`), but the backup subsystem can't import from the
 * server package (it's a consumer of the agent package, not the
 * other way around). So we use a module-scoped sink variable that
 * the server wires at boot via `setRevisionEventSink(broadcast)`.
 *
 * If no sink is registered (test fixtures, standalone agent usage,
 * the brief window between process start and setBackupStorage),
 * emissions are silent no-ops. This is intentional — revision
 * events are observability signal, not load-bearing state; a
 * missed event is never a correctness bug.
 *
 * Mirror of the `storage-registry.ts` pattern used for the blob
 * StorageProvider — same registration lifetime, same test-reset
 * helper, same "module-scoped singleton with an explicit setter"
 * shape. One convention for all backup-subsystem external hooks.
 */

import type { RevisionsStateChangedEvent } from "@nautilo/types";
import { warn } from "@nautilo/logger";
import {
  agentDb as db,
  fileRevisions,
  and,
  eq,
  desc,
  count,
  type FileRevision,
} from "@nautilo/db";

export type RevisionEventSink = (event: RevisionsStateChangedEvent) => void;

let _sink: RevisionEventSink | null = null;

/**
 * Register the sink the backup subsystem calls to broadcast
 * revision-state-changed events. Called once at server boot from
 * `createApp` in `packages/server/src/app.ts`, right after
 * `setBackupStorage`.
 *
 * Passing `null` clears the sink (intended for test teardown;
 * production only calls this once at startup).
 */
export function setRevisionEventSink(sink: RevisionEventSink | null): void {
  _sink = sink;
}

/**
 * Internal emit — silently no-op if no sink is registered.
 * Consumed only by `emitRevisionStateSnapshot` in this file; not
 * exported because callers should always go through the snapshot
 * helper (which handles the DB lookup + error swallowing).
 */
function emitRevisionEvent(event: RevisionsStateChangedEvent): void {
  if (_sink) _sink(event);
}

/**
 * Test-only teardown. Matches `resetBackupStorage`'s shape.
 */
export function resetRevisionEventSink(): void {
  _sink = null;
}

/**
 * D087 Phase 3 §3.10 — emit `revisions.state_changed` for a given
 * `(agent, path)` pair. Called from the record-revision lane-runner
 * success paths and from the per-file GC sweep.
 *
 * Best-effort by design — any throw here is caught + logged but
 * never bubbled, so an observability-path failure can't poison the
 * apply flow. Silent no-op when no sink is registered.
 *
 * Lives in events-sink.ts (not record-revision.ts) to avoid a
 * circular import between record-revision.ts ↔ gc.ts — both need
 * to call this function.
 */
export async function emitRevisionStateSnapshot(
  agentId: string,
  absolutePath: string,
): Promise<void> {
  if (!_sink) return;
  try {
    const [countRow] = await db
      .select({ n: count() })
      .from(fileRevisions)
      .where(
        and(
          eq(fileRevisions.agentId, agentId),
          eq(fileRevisions.absolutePath, absolutePath),
        ),
      );
    const availableRevisions = Number(countRow?.n ?? 0);

    let latest: FileRevision | null = null;
    if (availableRevisions > 0) {
      const rows = await db
        .select()
        .from(fileRevisions)
        .where(
          and(
            eq(fileRevisions.agentId, agentId),
            eq(fileRevisions.absolutePath, absolutePath),
          ),
        )
        .orderBy(desc(fileRevisions.createdAt))
        .limit(1);
      latest = rows[0] ?? null;
    }

    emitRevisionEvent({
      type: "revisions.state_changed",
      agentId,
      path: absolutePath,
      availableRevisions,
      latest: latest
        ? {
            revisionId: latest.id,
            turnId: latest.turnId,
            createdAt: latest.createdAt.toISOString(),
            operation: latest.operation,
            summary: `${latest.operation} at ${latest.createdAt.toISOString()} (${latest.kind})`,
            pinned: latest.pinned,
            redoEligible: latest.restoreFromRevisionId !== null,
          }
        : null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(
      `[backups] emitRevisionStateSnapshot failed for ${absolutePath}: ${msg} ` +
        `(observability-only; apply path unaffected)`,
    );
  }
}
