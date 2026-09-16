import {
  findClaimedOwnerId,
  findClaimedOwnerIdWithDb,
  type DirectDatabase,
} from "@nautilo/db";
import { setBootstrapOwnerBound, setBootstrapOwnerId } from "@nautilo/trust";

/**
 * Hydrate the synchronous ownership cache from the database's canonical
 * first-owner projection before the server accepts requests.
 *
 * The database remains the durable authority. The supplied seeded owner is
 * only the pre-claim fallback required by the legacy seeders; it must never
 * be mistaken for a completed first owner.
 */
export async function hydrateBootstrapOwnerState(args: {
  seededOwnerId: string;
  db?: DirectDatabase;
}): Promise<{ ownerId: string; claimedOwnerId: string | null }> {
  const claimedOwnerId = args.db
    ? await findClaimedOwnerIdWithDb(args.db)
    : await findClaimedOwnerId();
  const ownerId = claimedOwnerId ?? args.seededOwnerId;
  setBootstrapOwnerId(ownerId);
  setBootstrapOwnerBound(claimedOwnerId !== null);
  return { ownerId, claimedOwnerId };
}
