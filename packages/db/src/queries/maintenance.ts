/**
 * D420 — durable maintenance ownership store (Wave 2 task 2.1.1).
 *
 * The permanent `server_maintenance` singleton row carries operation
 * ownership, a renewable lease, and a hard expiry. Every mutation runs
 * inside a transaction that locks the singleton row with
 * `SELECT ... FOR UPDATE`, so two operator CLIs (or a CLI racing an
 * expiry-recovery sweep) cannot both believe they own the drain.
 *
 * Transitions fail closed: an invalid state transition, a cross-owner
 * mutation (wrong `operationId`), or an expired lease all throw
 * {@link MaintenanceTransitionError} rather than silently corrupt the
 * lease. The single escape hatch is {@link recoverExpiredMaintenance},
 * which reclaims an abandoned / restored `applying` row once its hard
 * expiry has passed — recovering a dead CLI or a restored snapshot
 * without operator intervention.
 *
 * This module is BEHAVIOR-FREE substrate: it owns the state machine and
 * lease bookkeeping, not the operator API, polling loop, or timeout
 * policy (later Wave 2 tasks own those). It uses the process-wide shared pool;
 * pattern of `queries/jobs.ts`; callers may also pass an explicit
 * `DirectDatabase` (e.g. integration tests) to the `*With` variants.
 */
import { eq, sql } from "drizzle-orm";
import type { DirectDatabase } from "../config/direct-database";
import { getSharedDirectDb } from "../config/database";
import {
  serverMaintenance,
  type ServerMaintenanceRow,
  type MaintenanceState,
} from "../schema/server-maintenance";
import { workAcceptances } from "../schema/work-acceptances";

/** Singleton key for the upgrade/drain lease; today the only one. */
export const MAINTENANCE_SINGLETON_KEY = "upgrade";

/**
 * Bounded, payload-free cancellation / transition reasons carried on the
 * ledger. These are operator-facing status tokens, never prompt or room
 * content.
 */
export const MAINTENANCE_REASONS = {
  leaseExpired: "maintenance lease expired",
  hardExpiryRecovery: "maintenance hard expiry recovered",
} as const;

export class MaintenanceTransitionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "in_progress"
      | "not_owner"
      | "invalid_transition"
      | "lease_expired"
      | "hard_expired"
      | "not_found",
  ) {
    super(message);
    this.name = "MaintenanceTransitionError";
  }
}

export interface MaintenanceLeaseDurations {
  /** Renewable soft-deadline window in milliseconds. */
  leaseMs: number;
  /** Absolute recovery ceiling in milliseconds. */
  hardMs: number;
}

export interface MaintenanceSnapshot {
  singletonKey: string;
  state: MaintenanceState;
  operationId: string | null;
  leaseExpiresAt: Date | null;
  hardExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toSnapshot(row: ServerMaintenanceRow): MaintenanceSnapshot {
  return {
    singletonKey: row.singletonKey,
    state: row.state as MaintenanceState,
    operationId: row.operationId,
    leaseExpiresAt: row.leaseExpiresAt,
    hardExpiresAt: row.hardExpiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// --- shared direct pool -------------------------------------------------

function db() {
  return getSharedDirectDb();
}

/**
 * Ensure the singleton row exists. Post-migration 0099 it is seeded, but
 * a restored/partial DB may lack it; this is idempotent and safe to call
 * on every read. Runs inside the caller's tx when given a handle.
 */
async function ensureSingletonRow(
  handle: Pick<DirectDatabase, "insert"> &
    Pick<DirectDatabase, "select"> &
    Pick<DirectDatabase, "update">,
  now: Date,
): Promise<ServerMaintenanceRow> {
  // ON CONFLICT do nothing, then read — avoids a race between two booting
  // processes both inserting.
  await handle
    .insert(serverMaintenance)
    .values({ singletonKey: MAINTENANCE_SINGLETON_KEY, state: "normal", updatedAt: now })
    .onConflictDoNothing();
  const [row] = await handle
    .select()
    .from(serverMaintenance)
    .where(eq(serverMaintenance.singletonKey, MAINTENANCE_SINGLETON_KEY))
    .limit(1);
  if (!row) {
    throw new MaintenanceTransitionError(
      "server_maintenance singleton row missing after ensure",
      "not_found",
    );
  }
  return row;
}

// --- operations (explicit-db variants, for tests) ----------------------

/**
 * Read the current maintenance snapshot (no lock). Ensures the singleton
 * row exists. Safe for unauthenticated status reads; returns counts only
 * via separate helpers.
 */
export async function getMaintenanceStateWith(
  handle: DirectDatabase,
): Promise<MaintenanceSnapshot> {
  const row = await ensureSingletonRow(handle, new Date());
  return toSnapshot(row);
}

/**
 * Claim the drain lease: `normal → draining`. Fails closed if a live
 * lease is held by another operation. If the existing lease is past its
 * hard expiry, reclaims it first (abandoned CLI / restored snapshot).
 */
export async function enterDrainingWith(
  handle: DirectDatabase,
  operationId: string,
  durations: MaintenanceLeaseDurations,
  now: Date = new Date(),
): Promise<MaintenanceSnapshot> {
  if (!operationId) throw new MaintenanceTransitionError("operationId required", "not_owner");
  if (durations.leaseMs <= 0 || durations.hardMs < durations.leaseMs) {
    throw new MaintenanceTransitionError("invalid lease/hard durations", "invalid_transition");
  }
  return handle.transaction(async (tx) => {
    const row = await ensureSingletonRow(tx, now);
    // Lock the singleton row for the whole transition.
    const [locked] = await tx
      .select()
      .from(serverMaintenance)
      .where(eq(serverMaintenance.singletonKey, row.singletonKey))
      .for("update");
    if (!locked) throw new MaintenanceTransitionError("singleton row vanished mid-tx", "not_found");

    const hardExpired =
      locked.hardExpiresAt !== null && locked.hardExpiresAt.getTime() <= now.getTime();

    if (locked.state !== "normal" && !hardExpired) {
      throw new MaintenanceTransitionError(
        `maintenance already in progress (state=${locked.state})`,
        "in_progress",
      );
    }
    // Reclaim an abandoned / restored lease past its hard expiry.
    if (locked.state !== "normal" && hardExpired) {
      await tx
        .update(serverMaintenance)
        .set({
          state: "normal",
          operationId: null,
          leaseExpiresAt: null,
          hardExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(serverMaintenance.singletonKey, row.singletonKey));
    }

    const leaseExpiresAt = new Date(now.getTime() + durations.leaseMs);
    const hardExpiresAt = new Date(now.getTime() + durations.hardMs);
    const [updated] = await tx
      .update(serverMaintenance)
      .set({
        state: "draining",
        operationId,
        leaseExpiresAt,
        hardExpiresAt,
        updatedAt: now,
      })
      .where(eq(serverMaintenance.singletonKey, row.singletonKey))
      .returning();
    if (!updated) throw new MaintenanceTransitionError("enterDraining update returned no row", "not_found");
    return toSnapshot(updated);
  });
}

/**
 * `draining → applying`. Requires the owning operation and a live lease.
 * Cross-owner or expired-lease transitions fail closed.
 */
export async function transitionApplyingWith(
  handle: DirectDatabase,
  operationId: string,
  now: Date = new Date(),
): Promise<MaintenanceSnapshot> {
  if (!operationId) throw new MaintenanceTransitionError("operationId required", "not_owner");
  return handle.transaction(async (tx) => {
    const row = await ensureSingletonRow(tx, now);
    const [locked] = await tx
      .select()
      .from(serverMaintenance)
      .where(eq(serverMaintenance.singletonKey, row.singletonKey))
      .for("update");
    if (!locked) throw new MaintenanceTransitionError("singleton row vanished mid-tx", "not_found");

    if (locked.state !== "draining") {
      throw new MaintenanceTransitionError(
        `transitionApplying refused: state=${locked.state} (expected draining)`,
        "invalid_transition",
      );
    }
    if (locked.operationId !== operationId) {
      throw new MaintenanceTransitionError(
        "transitionApplying refused: not the owning operation",
        "not_owner",
      );
    }
    const leaseExpired =
      locked.leaseExpiresAt === null || locked.leaseExpiresAt.getTime() <= now.getTime();
    if (leaseExpired) {
      throw new MaintenanceTransitionError(
        "transitionApplying refused: lease expired",
        "lease_expired",
      );
    }
    const [updated] = await tx
      .update(serverMaintenance)
      .set({ state: "applying", updatedAt: now })
      .where(eq(serverMaintenance.singletonKey, row.singletonKey))
      .returning();
    if (!updated) throw new MaintenanceTransitionError("transitionApplying update returned no row", "not_found");
    return toSnapshot(updated);
  });
}

/**
 * Renew the soft lease. Capped at the hard expiry. Requires the owning
 * operation and an unpassed hard ceiling. Renewal past hard expiry is
 * refused (the lease must be recovered instead).
 */
export async function renewLeaseWith(
  handle: DirectDatabase,
  operationId: string,
  leaseMs: number,
  now: Date = new Date(),
): Promise<MaintenanceSnapshot> {
  if (!operationId) throw new MaintenanceTransitionError("operationId required", "not_owner");
  if (leaseMs <= 0) {
    throw new MaintenanceTransitionError("invalid lease duration", "invalid_transition");
  }
  return handle.transaction(async (tx) => {
    const row = await ensureSingletonRow(tx, now);
    const [locked] = await tx
      .select()
      .from(serverMaintenance)
      .where(eq(serverMaintenance.singletonKey, row.singletonKey))
      .for("update");
    if (!locked) throw new MaintenanceTransitionError("singleton row vanished mid-tx", "not_found");

    if (locked.operationId !== operationId) {
      throw new MaintenanceTransitionError("renewLease refused: not the owning operation", "not_owner");
    }
    if (locked.state === "normal") {
      throw new MaintenanceTransitionError("renewLease refused: not in maintenance", "invalid_transition");
    }
    if (locked.hardExpiresAt === null || locked.hardExpiresAt.getTime() <= now.getTime()) {
      throw new MaintenanceTransitionError("renewLease refused: hard expiry reached", "hard_expired");
    }
    const proposed = new Date(now.getTime() + leaseMs);
    const hard = locked.hardExpiresAt;
    const leaseExpiresAt = proposed.getTime() > hard.getTime() ? hard : proposed;
    const [updated] = await tx
      .update(serverMaintenance)
      .set({ leaseExpiresAt, updatedAt: now })
      .where(eq(serverMaintenance.singletonKey, row.singletonKey))
      .returning();
    if (!updated) throw new MaintenanceTransitionError("renewLease update returned no row", "not_found");
    return toSnapshot(updated);
  });
}

/**
 * Release the lease back to `normal`. Used by both success (`complete`)
 * and explicit cancel. Requires the owning operation unless already
 * `normal` (idempotent no-op). Cross-owner release fails closed.
 */
export async function clearMaintenanceWith(
  handle: DirectDatabase,
  operationId: string,
  now: Date = new Date(),
): Promise<MaintenanceSnapshot> {
  if (!operationId) throw new MaintenanceTransitionError("operationId required", "not_owner");
  return handle.transaction(async (tx) => {
    const row = await ensureSingletonRow(tx, now);
    const [locked] = await tx
      .select()
      .from(serverMaintenance)
      .where(eq(serverMaintenance.singletonKey, row.singletonKey))
      .for("update");
    if (!locked) throw new MaintenanceTransitionError("singleton row vanished mid-tx", "not_found");

    if (locked.state === "normal") {
      return toSnapshot(locked);
    }
    if (locked.operationId !== operationId) {
      throw new MaintenanceTransitionError("clearMaintenance refused: not the owning operation", "not_owner");
    }
    const [updated] = await tx
      .update(serverMaintenance)
      .set({
        state: "normal",
        operationId: null,
        leaseExpiresAt: null,
        hardExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(serverMaintenance.singletonKey, row.singletonKey))
      .returning();
    if (!updated) throw new MaintenanceTransitionError("clearMaintenance update returned no row", "not_found");
    return toSnapshot(updated);
  });
}

/**
 * Reclaim an abandoned / restored lease once its hard expiry has passed.
 * The escape hatch that returns a dead CLI's or restored snapshot's
 * `applying` row to `normal` without operator intervention. No-op (and
 * safe) when the lease is still live or already normal.
 */
export async function recoverExpiredMaintenanceWith(
  handle: DirectDatabase,
  now: Date = new Date(),
): Promise<{ recovered: boolean; snapshot: MaintenanceSnapshot }> {
  return handle.transaction(async (tx) => {
    const row = await ensureSingletonRow(tx, now);
    const [locked] = await tx
      .select()
      .from(serverMaintenance)
      .where(eq(serverMaintenance.singletonKey, row.singletonKey))
      .for("update");
    if (!locked) throw new MaintenanceTransitionError("singleton row vanished mid-tx", "not_found");

    const expired =
      locked.state !== "normal" &&
      locked.hardExpiresAt !== null &&
      locked.hardExpiresAt.getTime() <= now.getTime();
    if (!expired) {
      return { recovered: false, snapshot: toSnapshot(locked) };
    }
    const [updated] = await tx
      .update(serverMaintenance)
      .set({
        state: "normal",
        operationId: null,
        leaseExpiresAt: null,
        hardExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(serverMaintenance.singletonKey, row.singletonKey))
      .returning();
    if (!updated) throw new MaintenanceTransitionError("recoverExpired update returned no row", "not_found");
    return { recovered: true, snapshot: toSnapshot(updated) };
  });
}

/**
 * Count of accepted (un-dispatched, un-terminated) work-acceptance rows.
 * Aggregate only; no payload. Used by the operator status read (later
 * task) to report queued/buffered intent truthfully without leaking
 * content. Implemented here because the count is a maintenance-level
 * aggregate over the ledger.
 */
export async function countAcceptedWorkWith(
  handle: DirectDatabase,
): Promise<number> {
  const [row] = await handle
    .select({ n: sql<number>`count(*)::int` })
    .from(workAcceptances)
    .where(eq(workAcceptances.status, "accepted"));
  return row?.n ?? 0;
}

// --- convenience overloads (lazy internal pool) ------------------------

export function getMaintenanceState(): Promise<MaintenanceSnapshot> {
  return getMaintenanceStateWith(db() as unknown as DirectDatabase);
}
export function enterDraining(
  operationId: string,
  durations: MaintenanceLeaseDurations,
  now?: Date,
): Promise<MaintenanceSnapshot> {
  return enterDrainingWith(db() as unknown as DirectDatabase, operationId, durations, now);
}
export function transitionApplying(
  operationId: string,
  now?: Date,
): Promise<MaintenanceSnapshot> {
  return transitionApplyingWith(db() as unknown as DirectDatabase, operationId, now);
}
export function renewLease(
  operationId: string,
  leaseMs: number,
  now?: Date,
): Promise<MaintenanceSnapshot> {
  return renewLeaseWith(db() as unknown as DirectDatabase, operationId, leaseMs, now);
}
export function clearMaintenance(
  operationId: string,
  now?: Date,
): Promise<MaintenanceSnapshot> {
  return clearMaintenanceWith(db() as unknown as DirectDatabase, operationId, now);
}
export function recoverExpiredMaintenance(
  now?: Date,
): Promise<{ recovered: boolean; snapshot: MaintenanceSnapshot }> {
  return recoverExpiredMaintenanceWith(db() as unknown as DirectDatabase, now);
}
