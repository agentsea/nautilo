import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { DirectDatabase } from "../config/direct-database";
import { findClaimedOwnerIdWithDb } from "./find-claimed-owner";
import {
  invites,
} from "../schema";

function extractRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

export async function invitesTableExists(db: DirectDatabase): Promise<boolean> {
  const result = await db.execute<{ reg: string | null }>(
    sql`SELECT to_regclass('public.invites')::text AS reg`,
  );
  const rows = extractRows<{ reg: string | null }>(result);
  return Boolean(rows[0]?.reg);
}

/**
 * True when a bootstrap `kind=claim` invite row is still redeemable.
 *
 * `expires_at` is deliberately part of the canonical predicate. An expired
 * row is historical evidence only: it cannot make a target look claimable,
 * cannot block a controller from replacing a failed handoff, and must not
 * keep a setup-status projection fresh indefinitely. Legacy local-Compose
 * claim rows have a NULL expiry and remain valid until consumed or revoked.
 */
export async function hasUnredeemedClaimInvite(db: DirectDatabase): Promise<boolean> {
  if (!(await invitesTableExists(db))) {
    return false;
  }
  const [row] = await db
    .select({ id: invites.id })
    .from(invites)
    .where(
      and(
        eq(invites.kind, "claim"),
        eq(invites.usedCount, 0),
        isNull(invites.revokedAt),
        or(isNull(invites.expiresAt), gt(invites.expiresAt, new Date())),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * D112 / D219 — canonical "server has a claimed owner" predicate:
 * a **local** user (`server IS NULL`) who is a member of the canonical
 * `owners` Group, with a PIN credential and a profile row.
 *
 * D219 retired the `users.server_role` enum; the claimed-owner signal is
 * now `owners`-Group membership (the bootstrap claimer is seated there by
 * `seedTrustPersonal`, inherited via the in-place seed-row update on
 * claim). `hasAdminUser` is kept as a back-compat alias for one release
 * (`setup-status.ts` + tests import it).
 */
export async function hasClaimedOwner(db: DirectDatabase): Promise<boolean> {
  return (await findClaimedOwnerIdWithDb(db)) !== null;
}

/** @deprecated D219 — renamed to {@link hasClaimedOwner}; thin wrapper kept
 * for one release while callers migrate (`app.ts`, CLI doctor, tests). */
export async function hasAdminUser(db: DirectDatabase): Promise<boolean> {
  return hasClaimedOwner(db);
}
