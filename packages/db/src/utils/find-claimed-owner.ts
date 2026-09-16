import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, asc, eq, isNull } from "drizzle-orm";
import { users } from "../schema/users";
import { credentials, groupMembers, groups } from "../schema/trust";
import { profiles } from "../schema/profiles";
import { resolveDirectDatabaseConnectionString } from "../config/direct-database";

/**
 * D120 A1.P1 — returns the user-id of the first **real claimer** on
 * this instance, or `null` if no claim has happened yet.
 *
 * Predicate: oldest local user (by `created_at`) who simultaneously has a
 * PIN credential, profile, and membership in an owners group. This is the
 * canonical durable owner boundary used by setup status and boot hydration.
 *
 * Why the complete projection is required (not `serverRole='admin'`, not a
 * credential alone, and not merely `oldest user`):
 *   - `seedDefaultOwner` inserts a bootstrap dummy users row on first
 *     boot of a fresh DB (name=`"user"`, email=`"owner@example.com"`).
 *     The dummy never authenticates and has no credentials row.
 *   - Browser claim is deliberately split. A partial bind can create the user
 *     and actor before PIN/profile completion, so any looser predicate can
 *     retire bootstrap authority before a usable owner exists.
 *   - `serverRole='admin'` is unreliable: migration
 *     `0025_m061_users_server_role` backfilled all local users to
 *     `'admin'`, including the bootstrap dummy. Using it would
 *     re-introduce the F-1 regression shape this phase is fixing.
 *   - "Oldest user" would also pick the dummy (it's older than any
 *     claimer by construction). That's the bug `seedDefaultOwner` has
 *     today and the reason this function exists.
 *
 * This function is the boot-time read; the runtime read seam is the
 * sync `getBootstrapOwnerId()` cache populated from this query's
 * result + refreshed in `redeem-invite.ts` after a successful claim.
 *
 * Idempotent and side-effect-free. Caller owns the connection
 * lifecycle when an existing `db` is passed; the no-arg form opens
 * its own short-lived `postgres` client (matching the `seedDefault*`
 * pattern in this directory).
 */
export async function findClaimedOwnerId(): Promise<string | null> {
  const directConnection = resolveDirectDatabaseConnectionString();
  const sql = postgres(directConnection, { max: 1 });
  const db = drizzle(sql);
  try {
    return await findClaimedOwnerIdWithDb(db);
  } finally {
    await sql.end();
  }
}

/**
 * Inner form for callers that already hold a drizzle handle (tests,
 * future callers that want to share a transaction). Identical
 * predicate; pure-async, no I/O lifecycle.
 */
export async function findClaimedOwnerIdWithDb(
  db: ReturnType<typeof drizzle>,
): Promise<string | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(credentials, and(eq(credentials.userId, users.id), eq(credentials.type, "pin")))
    .innerJoin(profiles, eq(profiles.userId, users.id))
    .innerJoin(groupMembers, eq(groupMembers.userId, users.id))
    .innerJoin(groups, and(eq(groups.id, groupMembers.groupId), eq(groups.type, "owners")))
    .where(isNull(users.server))
    .orderBy(asc(users.createdAt))
    .limit(1);
  return row?.id ?? null;
}
