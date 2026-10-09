import { sql } from "@nautilo/db";
import type { SQLWrapper } from "drizzle-orm";

import { TASK_CONTENT_RECONCILE_MAX_ATTEMPTS } from "../../task/task-content-repository.ts";

// Shared with ordinary lifecycle reconciliation; exact-result recovery must
// use the same lease and retry schedule.
export function taskContentReconciliationLeaseExpiry() {
  return sql`CURRENT_TIMESTAMP + ${60} * interval '1 second'`;
}

export function taskContentReconciliationFailureValues(attemptCount: SQLWrapper) {
  return {
    attemptCount: sql`${attemptCount} + 1`,
    disposition: sql`CASE WHEN ${attemptCount} + 1 >= ${TASK_CONTENT_RECONCILE_MAX_ATTEMPTS} THEN 'quarantined' ELSE 'active' END`,
    failureCode: sql`CASE WHEN ${attemptCount} + 1 >= ${TASK_CONTENT_RECONCILE_MAX_ATTEMPTS} THEN 'retry_exhausted' ELSE NULL END`,
    nextAttemptAt: sql`CASE WHEN ${attemptCount} + 1 >= ${TASK_CONTENT_RECONCILE_MAX_ATTEMPTS}
      THEN NULL ELSE CURRENT_TIMESTAMP + LEAST(300000, (1000 * power(2, ${attemptCount}))::bigint) * interval '1 millisecond' END`,
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: sql`CURRENT_TIMESTAMP`,
  };
}
