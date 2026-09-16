/**
 * D420 — payload-free work-acceptance ledger store (Wave 2 task 2.1.2).
 *
 * One row per accepted unit of executable intent, persisted BEFORE the
 * runtime enqueues it in the coalescer. The row stores identity and
 * lifecycle only — no prompt, room, user, tool, or checkpoint payload
 * (those live on the linked `jobs` row). At dispatch time the runtime
 * links the coalesced group's acceptance ids to the single created Job;
 * at drain/shutdown time un-started acceptances are terminalized with a
 * bounded `maintenance_cancelled` reason so the ledger always tells the
 * truth about queued/buffered intent.
 *
 * This module is BEHAVIOR-FREE substrate: it owns insert / link /
 * terminalize / reads, not the ingress gate, polling loop, or timeout
 * policy (later Wave 2 tasks own those). It uses the process-wide shared pool;
 * pattern of `queries/jobs.ts`; the `*With` variants accept an explicit
 * `DirectDatabase` for integration tests.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DirectDatabase } from "../config/direct-database";
import { getSharedDirectDb } from "../config/database";
import {
  workAcceptances,
  type WorkAcceptanceRow,
  type WorkAcceptanceKind,
  type WorkAcceptanceStatus,
} from "../schema/work-acceptances";

/**
 * Bounded, payload-free cancellation reasons. These are operator-facing
 * status tokens; never prompt, room, user, tool, or checkpoint content.
 */
export const WORK_ACCEPTANCE_REASONS = {
  /** Mirrors the runtime's planned-shutdown job-cancel message for one truthful outcome. */
  plannedShutdown: "Cancelled because the server is shutting down for planned maintenance",
  maintenanceDrain: "Cancelled by maintenance drain",
  /**
   * D420 (Wave 2 task 2.2.3 correction) — a D349 user Stop dropped this
   * queued/buffered acceptance before dispatch. Distinct from
   * `maintenanceDrain`: a user stop is not a maintenance cancellation (R8).
   */
  userStop: "Cancelled by the user (Stop)",
} as const;

export type WorkAcceptanceReason =
  (typeof WORK_ACCEPTANCE_REASONS)[keyof typeof WORK_ACCEPTANCE_REASONS];

// --- shared direct pool -------------------------------------------------

function db() {
  return getSharedDirectDb();
}

// --- operations (explicit-db variants, for tests) ----------------------

/**
 * Persist one acceptance row BEFORE enqueue. Returns the new row id.
 * Payload-free: only `kind` is supplied.
 */
export async function insertAcceptanceWith(
  handle: DirectDatabase,
  kind: WorkAcceptanceKind,
): Promise<string> {
  const [row] = await handle
    .insert(workAcceptances)
    .values({ kind, status: "accepted" })
    .returning({ id: workAcceptances.id });
  if (!row) throw new Error("insertAcceptance: insert returned no row");
  return row.id;
}

/**
 * Persist N acceptance rows (one per coalesced segment) BEFORE enqueue.
 * Returns the new row ids in insertion order.
 */
export async function insertAcceptancesWith(
  handle: DirectDatabase,
  kind: WorkAcceptanceKind,
  count: number,
): Promise<string[]> {
  if (count <= 0) return [];
  const rows = await handle
    .insert(workAcceptances)
    .values(
      Array.from({ length: count }, () => ({ kind, status: "accepted" as WorkAcceptanceStatus })),
    )
    .returning({ id: workAcceptances.id });
  return rows.map((r) => r.id);
}

/**
 * Link a coalesced group of acceptances to the created Job at dispatch.
 * Transitions `accepted → dispatched`, stamps `job_id` + `dispatched_at`.
 * Only rows still in `accepted` are touched (idempotent against a double
 * link). Returns the number of rows linked.
 */
export async function linkAcceptancesToJobWith(
  handle: DirectDatabase,
  acceptanceIds: readonly string[],
  jobId: string,
  now: Date = new Date(),
): Promise<number> {
  if (acceptanceIds.length === 0) return 0;
  const updated = await handle
    .update(workAcceptances)
    .set({ status: "dispatched", jobId, dispatchedAt: now })
    .where(
      and(
        inArray(workAcceptances.id, [...acceptanceIds]),
        eq(workAcceptances.status, "accepted"),
      ),
    )
    .returning({ id: workAcceptances.id });
  return updated.length;
}

/**
 * Terminalize un-started acceptances as `maintenance_cancelled` with a
 * bounded reason. Only rows still in `accepted` are touched (dispatched
 * rows carry their outcome on the linked Job). Returns the count
 * terminalized — sufficient for later task 2.2.3 to report truthful
 * counts without implementing the timeout policy here.
 */
export async function terminalizeAcceptancesWith(
  handle: DirectDatabase,
  acceptanceIds: readonly string[],
  reason: WorkAcceptanceReason,
  now: Date = new Date(),
): Promise<number> {
  if (acceptanceIds.length === 0) return 0;
  const updated = await handle
    .update(workAcceptances)
    .set({ status: "maintenance_cancelled", cancelledAt: now, cancellationReason: reason })
    .where(
      and(
        inArray(workAcceptances.id, [...acceptanceIds]),
        eq(workAcceptances.status, "accepted"),
      ),
    )
    .returning({ id: workAcceptances.id });
  return updated.length;
}

/**
 * Terminalize ALL currently-accepted (un-dispatched) rows. The sweep
 * later task 2.2.3 calls at drain deadline; exposed now so the ledger is
 * sufficient for that policy without re-implementing the store layer.
 * Filters on `status='accepted'`, so `user_cancelled` (D349 user-Stop) and
 * `dispatched` rows are never touched — the maintenance sweep must leave a
 * user-Stop outcome distinct from a maintenance cancellation (R8).
 */
export async function terminalizeAllAcceptedWith(
  handle: DirectDatabase,
  reason: WorkAcceptanceReason,
  now: Date = new Date(),
): Promise<number> {
  const updated = await handle
    .update(workAcceptances)
    .set({ status: "maintenance_cancelled", cancelledAt: now, cancellationReason: reason })
    .where(eq(workAcceptances.status, "accepted"))
    .returning({ id: workAcceptances.id });
  return updated.length;
}

/**
 * D420 (Wave 2 task 2.2.3 correction) — terminalize an EXACT, ID-scoped set of
 * still-`accepted` acceptance rows as `user_cancelled` with a bounded user-stop
 * reason. Idempotent: only rows still in `accepted` are touched — already-
 * `dispatched` rows (linked to a real Job) and already-terminal rows
 * (`user_cancelled` / `maintenance_cancelled`) are left untouched. Returns the
 * count terminalized so the runtime can detect a dispatch-vs-Stop race (fewer
 * transitioned than expected ⇒ a concurrent dispatch or Stop claimed some).
 *
 * `maintenance_cancelled` continues to mean maintenance drain only; this op
 * records the distinct D349 user-Stop outcome (R8). The maintenance sweep
 * (`terminalizeAllAcceptedWith`) filters on `status='accepted'`, so
 * `user_cancelled` rows are never touched by it.
 */
export async function userCancelAcceptancesWith(
  handle: DirectDatabase,
  acceptanceIds: readonly string[],
  reason: WorkAcceptanceReason,
  now: Date = new Date(),
): Promise<number> {
  if (acceptanceIds.length === 0) return 0;
  const updated = await handle
    .update(workAcceptances)
    .set({ status: "user_cancelled", cancelledAt: now, cancellationReason: reason })
    .where(
      and(
        inArray(workAcceptances.id, [...acceptanceIds]),
        eq(workAcceptances.status, "accepted"),
      ),
    )
    .returning({ id: workAcceptances.id });
  return updated.length;
}


export async function getAcceptanceWith(
  handle: DirectDatabase,
  id: string,
): Promise<WorkAcceptanceRow | undefined> {
  const [row] = await handle
    .select()
    .from(workAcceptances)
    .where(eq(workAcceptances.id, id))
    .limit(1);
  return row;
}

export async function listAcceptancesByStatusWith(
  handle: DirectDatabase,
  status: WorkAcceptanceStatus,
): Promise<WorkAcceptanceRow[]> {
  return handle
    .select()
    .from(workAcceptances)
    .where(eq(workAcceptances.status, status));
}

export async function countAcceptancesByStatusWith(
  handle: DirectDatabase,
  status: WorkAcceptanceStatus,
): Promise<number> {
  const [row] = await handle
    .select({ n: sql<number>`count(*)::int` })
    .from(workAcceptances)
    .where(eq(workAcceptances.status, status));
  return row?.n ?? 0;
}

export async function listAcceptancesForJobWith(
  handle: DirectDatabase,
  jobId: string,
): Promise<WorkAcceptanceRow[]> {
  return handle
    .select()
    .from(workAcceptances)
    .where(eq(workAcceptances.jobId, jobId));
}

// --- convenience overloads (lazy internal pool) ------------------------

export function insertAcceptance(kind: WorkAcceptanceKind): Promise<string> {
  return insertAcceptanceWith(db() as unknown as DirectDatabase, kind);
}
export function insertAcceptances(
  kind: WorkAcceptanceKind,
  count: number,
): Promise<string[]> {
  return insertAcceptancesWith(db() as unknown as DirectDatabase, kind, count);
}
export function linkAcceptancesToJob(
  acceptanceIds: readonly string[],
  jobId: string,
  now?: Date,
): Promise<number> {
  return linkAcceptancesToJobWith(db() as unknown as DirectDatabase, acceptanceIds, jobId, now);
}
export function terminalizeAcceptances(
  acceptanceIds: readonly string[],
  reason: WorkAcceptanceReason,
  now?: Date,
): Promise<number> {
  return terminalizeAcceptancesWith(db() as unknown as DirectDatabase, acceptanceIds, reason, now);
}
export function terminalizeAllAccepted(
  reason: WorkAcceptanceReason,
  now?: Date,
): Promise<number> {
  return terminalizeAllAcceptedWith(db() as unknown as DirectDatabase, reason, now);
}
export function userCancelAcceptances(
  acceptanceIds: readonly string[],
  reason: WorkAcceptanceReason,
  now?: Date,
): Promise<number> {
  return userCancelAcceptancesWith(db() as unknown as DirectDatabase, acceptanceIds, reason, now);
}
export function getAcceptance(id: string): Promise<WorkAcceptanceRow | undefined> {
  return getAcceptanceWith(db() as unknown as DirectDatabase, id);
}
export function listAcceptancesByStatus(
  status: WorkAcceptanceStatus,
): Promise<WorkAcceptanceRow[]> {
  return listAcceptancesByStatusWith(db() as unknown as DirectDatabase, status);
}
export function countAcceptancesByStatus(
  status: WorkAcceptanceStatus,
): Promise<number> {
  return countAcceptancesByStatusWith(db() as unknown as DirectDatabase, status);
}
export function listAcceptancesForJob(jobId: string): Promise<WorkAcceptanceRow[]> {
  return listAcceptancesForJobWith(db() as unknown as DirectDatabase, jobId);
}
