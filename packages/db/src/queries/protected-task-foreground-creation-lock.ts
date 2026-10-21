import { eq, sql } from "drizzle-orm";

import type { DirectDatabase } from "../config/direct-database";
import { tasks } from "../schema/tasks";

type CreationTransaction = Parameters<
  Parameters<DirectDatabase["transaction"]>[0]
>[0];

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type ProtectedTaskForegroundCreationIdentityLock =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "existing"; taskId: string }>;

/**
 * Serialize one deterministic foreground Task identity even before its row
 * exists. Callers acquire the encryption-policy fence first; current Room and
 * Namespace authority follows this helper's creation-identity/Task lock.
 */
export async function lockProtectedTaskForegroundCreationIdentity(
  transaction: Pick<CreationTransaction, "execute" | "select">,
  taskId: string,
): Promise<ProtectedTaskForegroundCreationIdentityLock> {
  if (!CANONICAL_UUID.test(taskId)) {
    throw new TypeError("Protected Task foreground creation identity is invalid");
  }
  const lockKey = `protected-task-foreground-creation:${taskId}`;
  await transaction.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(${lockKey}::text, 0))
  `);
  const rows = await transaction.select({ taskId: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .for("update")
    .limit(2);
  if (rows.length > 1 || rows[0] !== undefined && rows[0].taskId !== taskId) {
    throw new Error("Protected Task foreground creation identity is not unique");
  }
  return rows[0] === undefined
    ? Object.freeze({ status: "absent" as const })
    : Object.freeze({ status: "existing" as const, taskId });
}
