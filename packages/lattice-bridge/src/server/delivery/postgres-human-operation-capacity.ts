import { CRYPTO_DELIVERY_COLLECTION_LIMITS } from "@nautilo/db";
import type {
  CryptoPostgresExecutor,
} from "../storage/postgres-lattice-storage.ts";

/**
 * Serialize every operation admission that affects a Human and enforce the
 * shared Wave 7 ceiling across both Human-owned device work and membership
 * transitions whose participant sets contain that Human.
 */
export async function humanHasOperationCapacity(
  executor: CryptoPostgresExecutor,
  humanId: string,
): Promise<boolean> {
  await executor.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`crypto-human-operation-capacity/${humanId}`],
  );
  const rows = await executor.query(
    `SELECT operation.operation_id
       FROM crypto_delivery_operations operation
       LEFT JOIN crypto_human_membership_transitions membership
         ON membership.operation_id = operation.operation_id
      WHERE operation.state NOT IN ('active', 'failed', 'cancelled')
        AND (
          operation.human_id = $1
          OR $1 = ANY(membership.old_participants)
          OR $1 = ANY(membership.new_participants)
        )
      ORDER BY convert_to(operation.operation_id, 'UTF8')
      LIMIT $2
      FOR UPDATE OF operation`,
    [
      humanId,
      CRYPTO_DELIVERY_COLLECTION_LIMITS.outstandingOperationsPerHuman,
    ],
  );
  return rows.length
    < CRYPTO_DELIVERY_COLLECTION_LIMITS.outstandingOperationsPerHuman;
}

export async function allHumansHaveOperationCapacity(
  executor: CryptoPostgresExecutor,
  humanIds: readonly string[],
): Promise<boolean> {
  for (const humanId of [...new Set(humanIds)].sort()) {
    if (!(await humanHasOperationCapacity(executor, humanId))) return false;
  }
  return true;
}
