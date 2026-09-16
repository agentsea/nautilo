import { getSharedDirectDb, type DirectDatabase } from "@nautilo/db";

/**
 * Process-wide direct Drizzle handle for lightweight read paths (`/health`
 * bridge, `/api/setup/status`) so we do not open a new `postgres-js` pool
 * per request.
 */
export function getServerDirectDb(): DirectDatabase {
  return getSharedDirectDb();
}
