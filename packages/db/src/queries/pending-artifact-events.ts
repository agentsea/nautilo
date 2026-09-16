/**
 * D261 P6b — `pending_artifact_events` ring-buffer helpers.
 *
 * Append enforces cap N=50 per `(namespaceId, agentId, artifactId)` by
 * dropping oldest rows after insert. Drain returns oldest→newest and
 * deletes drained rows (at-most-once / best-effort semantics).
 *
 * These helpers use ordered sequential statements rather than an explicit
 * transaction, matching the existing artifact-state query style. The
 * queue is best-effort, not audit history.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, type Database } from "../config/database";
import {
  pendingArtifactEvents,
  type PendingArtifactEventRow,
} from "../schema/pending-artifact-events";

type Db = Database;

export const PENDING_ARTIFACT_EVENTS_CAP = 50;

export type AppendPendingArtifactEventResult = PendingArtifactEventRow & {
  droppedCount: number;
};

/**
 * Append one event and trim the scope queue to {@link PENDING_ARTIFACT_EVENTS_CAP}.
 * `droppedCount` reports how many oldest rows were deleted due to overflow.
 */
export async function appendPendingArtifactEvent(
  params: {
    namespaceId: string;
    agentId: string;
    artifactId: string;
    topic: string;
    payload: unknown;
  },
  conn: Db = db,
): Promise<AppendPendingArtifactEventResult> {
  // Drizzle/Postgres bind JS `null` as SQL NULL. This column stores JSON
  // and is NOT NULL, so persist JS null as JSON null (`'null'::jsonb`).
  const jsonbPayload = params.payload === null ? sql`'null'::jsonb` : params.payload;

  const [inserted] = await conn
    .insert(pendingArtifactEvents)
    .values({
      namespaceId: params.namespaceId,
      agentId: params.agentId,
      artifactId: params.artifactId,
      topic: params.topic,
      payload: jsonbPayload,
    })
    .returning();
  if (!inserted) throw new Error("appendPendingArtifactEvent returned no row");

  const scopeWhere = and(
    eq(pendingArtifactEvents.namespaceId, params.namespaceId),
    eq(pendingArtifactEvents.agentId, params.agentId),
    eq(pendingArtifactEvents.artifactId, params.artifactId),
  );

  const [countRow] = await conn
    .select({ total: sql<number>`count(*)::int` })
    .from(pendingArtifactEvents)
    .where(scopeWhere);
  const count = countRow?.total ?? 0;
  let droppedCount = 0;

  if (count > PENDING_ARTIFACT_EVENTS_CAP) {
    droppedCount = count - PENDING_ARTIFACT_EVENTS_CAP;
    const oldest = await conn
      .select({ id: pendingArtifactEvents.id })
      .from(pendingArtifactEvents)
      .where(scopeWhere)
      .orderBy(asc(pendingArtifactEvents.createdAt))
      .limit(droppedCount);
    const dropIds = oldest.map((r) => r.id);
    if (dropIds.length > 0) {
      await conn.delete(pendingArtifactEvents).where(inArray(pendingArtifactEvents.id, dropIds));
    }
  }

  return { ...inserted, droppedCount };
}

/**
 * Drain every visible event for `(agentId, artifactId)` across the
 * caller's readable namespaces, oldest first. Deletes drained rows
 * after selecting them (best-effort at-most-once).
 */
export async function drainPendingArtifactEventsForNamespaces(
  params: {
    readableNamespaceIds: string[];
    agentId: string;
    artifactId: string;
  },
  conn: Db = db,
): Promise<PendingArtifactEventRow[]> {
  if (params.readableNamespaceIds.length === 0) return [];

  const rows = await conn
    .select()
    .from(pendingArtifactEvents)
    .where(
      and(
        eq(pendingArtifactEvents.agentId, params.agentId),
        eq(pendingArtifactEvents.artifactId, params.artifactId),
        inArray(pendingArtifactEvents.namespaceId, params.readableNamespaceIds),
      ),
    )
    .orderBy(asc(pendingArtifactEvents.createdAt));

  if (rows.length === 0) return [];

  await conn
    .delete(pendingArtifactEvents)
    .where(inArray(pendingArtifactEvents.id, rows.map((r) => r.id)));

  return rows;
}

/**
 * Test-only — wipe pending events for a specific artifact scope.
 */
export async function _deletePendingArtifactEventsForArtifact(
  params: { agentId: string; artifactId: string },
  conn: Db = db,
): Promise<void> {
  await conn
    .delete(pendingArtifactEvents)
    .where(
      and(
        eq(pendingArtifactEvents.agentId, params.agentId),
        eq(pendingArtifactEvents.artifactId, params.artifactId),
      ),
    );
}
