import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { users } from "../schema/users";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import { slugifyToHandle } from "@nautilo/config";
import { resolveDirectDatabaseConnectionString } from "../config/direct-database";
import { assertCanCreateBootstrapOwner } from "./db-identity-guard";

/**
 * Ensures at least one user exists. If the users table is empty,
 * inserts a default owner. Returns the owner's ID.
 *
 * M042C: also ensures `users.handle` is populated. Fresh installs
 * insert a new row with `handle = null`; the onboarding wizard later
 * writes the chosen handle via `PUT /api/owner/handle`. Existing
 * installs where `users.handle IS NULL` get an auto-derived handle
 * from `users.name` (slugified, fallback `"owner"`, numeric suffix
 * on collision). Idempotent — re-running on a row that already has a
 * handle is a no-op.
 *
 * This is runtime seeding, not a migration — called on startup.
 */
export async function seedDefaultOwner(
  log?: (message: string) => void,
): Promise<string> {
  const print = log ?? (() => {});
  const directConnection = resolveDirectDatabaseConnectionString();

  const sql = postgres(directConnection, { max: 1 });
  const db = drizzle(sql);

  try {
    const [result] = await db.select({ total: count() }).from(users);
    const total = result?.total ?? 0;

    let ownerId: string;
    if (total === 0) {
      await assertCanCreateBootstrapOwner(directConnection);
      print("Creating default owner account...");
      const [owner] = await db
        .insert(users)
        .values({ name: "user", email: "owner@example.com" })
        .returning({ id: users.id });
      if (!owner) throw new Error("Failed to create default owner");
      ownerId = owner.id;
    } else {
      // Deterministic pick: oldest user by created_at. Without an
      // explicit ORDER BY, Postgres does not promise a stable row
      // order — integration-test leftover rows could outrank the
      // real owner between boots and cause the server to act as if
      // "someone else" is the single owner (no profile, no
      // channel_identities, relay falls back to a hardcoded string).
      // The oldest row is the real owner on any long-lived dev DB
      // and matches the intent of `seedDefaultOwner` ("ensure at
      // least one user exists, use the one that does").
      const [firstUser] = await db
        .select({ id: users.id })
        .from(users)
        .orderBy(asc(users.createdAt))
        .limit(1);
      if (!firstUser) throw new Error("Users table unexpectedly empty");
      ownerId = firstUser.id;
    }

    // M042C — auto-derive handle if missing. The onboarding wizard
    // writes the chosen handle on fresh installs (`PUT /api/owner/handle`);
    // this backfill is for pre-M042C DBs where the column was just
    // added and is NULL. The wizard path sets handle first, so by the
    // time this seed runs again on a fresh install, the branch is a
    // no-op.
    const [row] = await db
      .select({ id: users.id, name: users.name, handle: users.handle })
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1);

    if (row && !row.handle) {
      const derived = await deriveUniqueHandle(db, row.name, ownerId);
      print(`Auto-deriving handle for owner ${ownerId}: "${derived}" (from name="${row.name}")`);
      await db.update(users).set({ handle: derived, updatedAt: new Date() }).where(eq(users.id, ownerId));
    }

    return ownerId;
  } finally {
    await sql.end();
  }
}

/**
 * Derive a unique handle from a name. Slugifies via `slugifyToHandle`;
 * falls back to `"owner"` on failure. Appends a numeric suffix if the
 * derived handle is already in use by another user row.
 *
 * Single-owner OSS deployments never hit the collision branch (only
 * one user exists); the suffix logic is forward-looking for
 * Iteration 2 multi-user.
 *
 * M047: the collision check scopes to `users.server IS NULL` (local
 * users only). Foreign-origin stubs for federated Humans
 * (`@alice@remote.com`) are a distinct identity — `(handle, server)`
 * pair — and must not block the local owner from picking the same
 * local-part handle.
 */
async function deriveUniqueHandle(
  db: ReturnType<typeof drizzle>,
  name: string,
  ownerId: string,
): Promise<string> {
  const base = slugifyToHandle(name) ?? "owner";
  let candidate = base;
  let suffix = 2;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [clash] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.handle, candidate), isNull(users.server)))
      .limit(1);
    if (!clash || clash.id === ownerId) return candidate;
    candidate = `${base}${suffix}`;
    suffix += 1;
  }
  // Defensive: shouldn't happen in OSS (single owner). Multi-user
  // Iteration 2 can revisit with a saner strategy.
  return `${base}${Math.random().toString(36).slice(2, 6)}`;
}
