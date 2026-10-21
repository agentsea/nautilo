import { eq } from "drizzle-orm";

import type { DirectDatabase } from "../config/direct-database";
import { serverMaintenance } from "../schema/server-maintenance";
import type { MaintenanceSnapshot } from "./maintenance";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type Transaction = Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];

/**
 * Lock and prove the exact upgrade drain that owns a Full policy transition.
 * The row lock is retained by the caller's transaction through its policy CAS.
 */
export async function lockProtectedTaskActivationDrainingLease(
  transaction: Pick<Transaction, "select">,
  input: Readonly<{ operationId: string; now: Date }>,
): Promise<MaintenanceSnapshot | null> {
  if (!CANONICAL_UUID.test(input.operationId)
    || !Number.isFinite(input.now.getTime())) {
    throw new TypeError("Protected Task activation drain identity is malformed");
  }
  const rows = await transaction.select().from(serverMaintenance)
    .where(eq(serverMaintenance.singletonKey, "upgrade"))
    .limit(2)
    .for("update");
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (row.state !== "draining"
    || row.operationId !== input.operationId
    || row.leaseExpiresAt === null
    || row.hardExpiresAt === null
    || row.leaseExpiresAt.getTime() <= input.now.getTime()
    || row.hardExpiresAt.getTime() <= input.now.getTime()) return null;
  return Object.freeze({
    singletonKey: row.singletonKey,
    state: row.state,
    operationId: row.operationId,
    leaseExpiresAt: new Date(row.leaseExpiresAt.getTime()),
    hardExpiresAt: new Date(row.hardExpiresAt.getTime()),
    createdAt: new Date(row.createdAt.getTime()),
    updatedAt: new Date(row.updatedAt.getTime()),
  });
}
