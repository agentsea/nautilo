import type {
  ReflectionAdminStatus,
  ReflectionSemanticSchedulerStatus,
} from "@nautilo/types";
import { asc, desc, isNotNull, sql } from "drizzle-orm";
import type { DirectDatabase } from "../config/direct-database";
import { getSharedDirectDb } from "../config/database";
import { reflectionRecordSemanticWork } from "../schema/reflection-records";

const DELAYED_OVERDUE_MS = 60_000;
const DEGRADED_OVERDUE_MS = 5 * 60_000;
const DEGRADED_ATTEMPTS = 3;

interface SummaryRow {
  total_records: number | string;
  backlog: number | string;
  due: number | string;
  claimed: number | string;
  checkpointed: number | string;
  deferred: number | string;
  complete: number | string;
  quarantined: number | string;
  recovery_eligible: number | string;
  maximum_recovery_round: number | string;
  stale_leases: number | string;
  maximum_attempts: number | string;
  current_parent_violations: number | string;
  oldest_overdue_at: string | Date | null;
  authority_projection: number | string;
  search_projection: number | string;
  organization: number | string;
  available_records: number | string;
  current_projections: number | string;
  pending_projections: number | string;
  incompatible_projections: number | string;
  completed_work: number | string;
  synthetic_parents_created: number | string;
  last_completed_at: string | Date | null;
  next_recovery_at: string | Date | null;
}

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result !== null && typeof result === "object" && "rows" in result) {
    const value = (result as { rows: unknown }).rows;
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}

function count(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function date(value: string | Date | null): Date | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function classifyReflectionHealth(input: Readonly<{
  deferred: number;
  quarantined: number;
  staleLeases: number;
  maximumAttempts: number;
  oldestOverdueMs: number;
  currentParentViolations: number;
}>): ReflectionAdminStatus["health"] {
  if (
    input.currentParentViolations > 0
    ||
    input.quarantined > 0
    || input.staleLeases > 0
    || input.maximumAttempts >= DEGRADED_ATTEMPTS
    || input.oldestOverdueMs >= DEGRADED_OVERDUE_MS
  ) return "degraded";
  if (input.deferred > 0 || input.oldestOverdueMs >= DELAYED_OVERDUE_MS) {
    return "delayed";
  }
  return "healthy";
}

export async function queryReflectionAdminStatus(
  input: Readonly<{
    now: Date;
    since: Date;
    until: Date;
    scheduler: ReflectionSemanticSchedulerStatus;
  }>,
  db: DirectDatabase = getSharedDirectDb(),
): Promise<ReflectionAdminStatus> {
  const now = input.now.toISOString();
  const since = input.since.toISOString();
  const until = input.until.toISOString();
  const summaryRows = rows<SummaryRow>(await db.execute(sql`
    WITH work AS (
      SELECT * FROM reflection_record_semantic_work
    ), projection AS (
      SELECT
        count(*) FILTER (
          WHERE record.disposition = 'available' AND record.lifecycle = 'current'
        )::integer
          AS available_records,
        count(*) FILTER (
          WHERE record.disposition = 'available'
            AND record.lifecycle = 'current'
            AND search.record_id IS NOT NULL
            AND search.record_processing_generation = record.processing_generation
            AND search.projection_version = 1
            AND search.embedding_contract_version = 1
            AND search.embedding_dimensions = 1536
        )::integer AS current_projections,
        count(*) FILTER (
          WHERE record.disposition = 'available'
            AND record.lifecycle = 'current'
            AND search.record_id IS NULL
        )::integer AS pending_projections,
        count(*) FILTER (
          WHERE record.disposition = 'available'
            AND record.lifecycle = 'current'
            AND search.record_id IS NOT NULL
            AND (
              search.record_processing_generation <> record.processing_generation
              OR search.projection_version <> 1
              OR search.embedding_contract_version <> 1
              OR search.embedding_dimensions <> 1536
            )
        )::integer AS incompatible_projections
      FROM reflection_records record
      LEFT JOIN reflection_record_search_projections search
        ON search.record_id = record.record_id
    )
    SELECT
      (SELECT count(*)::integer FROM reflection_records) AS total_records,
      count(*) FILTER (
        WHERE state IN ('due', 'claimed', 'checkpointed', 'deferred')
      )::integer AS backlog,
      count(*) FILTER (WHERE state = 'due')::integer AS due,
      count(*) FILTER (WHERE state = 'claimed')::integer AS claimed,
      count(*) FILTER (WHERE state = 'checkpointed')::integer AS checkpointed,
      count(*) FILTER (WHERE state = 'deferred')::integer AS deferred,
      count(*) FILTER (WHERE state = 'complete')::integer AS complete,
      count(*) FILTER (WHERE state = 'quarantined')::integer AS quarantined,
      count(*) FILTER (
        WHERE state = 'quarantined' AND recover_after <= ${now}
      )::integer AS recovery_eligible,
      coalesce(max(quarantine_round), 0)::integer AS maximum_recovery_round,
      count(*) FILTER (
        WHERE state = 'claimed' AND lease_expires_at <= ${now}
      )::integer AS stale_leases,
      coalesce(max(attempt_count) FILTER (
        WHERE state IN ('due', 'claimed', 'checkpointed', 'deferred', 'quarantined')
      ), 0)::integer AS maximum_attempts,
      (SELECT count(*)::integer
         FROM (
           SELECT dependency.child_record_id
             FROM reflection_record_dependencies AS dependency
             JOIN reflection_records AS parent
               ON parent.record_id = dependency.parent_record_id
            WHERE parent.disposition = 'available'
              AND parent.lifecycle = 'current'
            GROUP BY dependency.child_record_id
           HAVING count(*) > 1
         ) AS violation
      ) AS current_parent_violations,
      min(due_since) FILTER (
        WHERE (
          state IN ('due', 'checkpointed', 'deferred')
          AND next_attempt_at <= ${now}
        ) OR (state = 'claimed' AND lease_expires_at <= ${now})
      ) AS oldest_overdue_at,
      count(*) FILTER (WHERE stage = 'authority_projection')::integer
        AS authority_projection,
      count(*) FILTER (WHERE stage = 'search_projection')::integer
        AS search_projection,
      count(*) FILTER (WHERE stage = 'organization')::integer AS organization,
      projection.available_records,
      projection.current_projections,
      projection.pending_projections,
      projection.incompatible_projections,
      count(*) FILTER (
        WHERE completed_at >= ${since} AND completed_at <= ${until}
      )::integer AS completed_work,
      (SELECT count(*)::integer FROM reflection_records
        WHERE structural_height > 0
          AND created_at >= ${since} AND created_at <= ${until}
      ) AS synthetic_parents_created,
      max(completed_at) AS last_completed_at,
      min(recover_after) FILTER (WHERE state = 'quarantined') AS next_recovery_at
    FROM projection LEFT JOIN work ON true
    GROUP BY projection.available_records, projection.current_projections,
      projection.pending_projections, projection.incompatible_projections
  `));
  const summary: SummaryRow = summaryRows[0] ?? {
    total_records: 0, backlog: 0, due: 0, claimed: 0, checkpointed: 0,
    deferred: 0, complete: 0, quarantined: 0, recovery_eligible: 0,
    maximum_recovery_round: 0, stale_leases: 0,
    maximum_attempts: 0, current_parent_violations: 0,
    oldest_overdue_at: null, authority_projection: 0,
    search_projection: 0, organization: 0, available_records: 0,
    current_projections: 0, pending_projections: 0,
    incompatible_projections: 0, completed_work: 0,
    synthetic_parents_created: 0, last_completed_at: null, next_recovery_at: null,
  };

  const oldestOverdueAt = date(summary.oldest_overdue_at);
  const oldestOverdueMs = oldestOverdueAt === null
    ? 0
    : Math.max(0, input.now.getTime() - oldestOverdueAt.getTime());
  const current = {
    totalRecords: count(summary.total_records),
    backlog: count(summary.backlog),
    due: count(summary.due),
    claimed: count(summary.claimed),
    checkpointed: count(summary.checkpointed),
    deferred: count(summary.deferred),
    complete: count(summary.complete),
    quarantined: count(summary.quarantined),
    recoveryEligible: count(summary.recovery_eligible),
    maximumRecoveryRound: count(summary.maximum_recovery_round),
    staleLeases: count(summary.stale_leases),
    oldestOverdueMs,
    maximumAttempts: count(summary.maximum_attempts),
    currentParentViolations: count(summary.current_parent_violations),
  };
  const failureRows = await db
    .select({
      stage: reflectionRecordSemanticWork.stage,
      failureCode: reflectionRecordSemanticWork.failureCode,
      updatedAt: reflectionRecordSemanticWork.updatedAt,
      attemptCount: reflectionRecordSemanticWork.attemptCount,
    })
    .from(reflectionRecordSemanticWork)
    .where(isNotNull(reflectionRecordSemanticWork.failureCode))
    .orderBy(
      desc(reflectionRecordSemanticWork.updatedAt),
      asc(reflectionRecordSemanticWork.recordId),
    )
    .limit(5);

  // A dormant or not-yet-completed process has no process-local observation.
  // Project the canonical durable backlog instead of rendering a misleading zero.
  const scheduler = input.scheduler.state === "disabled" || input.scheduler.lastPoll === null
    ? {
        ...input.scheduler,
        backlog: { size: current.backlog, oldestAgeMs: current.oldestOverdueMs },
      }
    : input.scheduler;
  const durableHealth = classifyReflectionHealth(current);
  return {
    generatedAt: input.now.toISOString(),
    window: { since: input.since.toISOString(), until: input.until.toISOString() },
    health: scheduler.state === "pressure_paused" ? "degraded" : durableHealth,
    scheduler,
    current,
    stages: {
      authorityProjection: count(summary.authority_projection),
      searchProjection: count(summary.search_projection),
      organization: count(summary.organization),
    },
    projections: {
      availableRecords: count(summary.available_records),
      current: count(summary.current_projections),
      pending: count(summary.pending_projections),
      incompatible: count(summary.incompatible_projections),
    },
    last24h: {
      completedWork: count(summary.completed_work),
      syntheticParentsCreated: count(summary.synthetic_parents_created),
    },
    lastCompletedAt: date(summary.last_completed_at)?.toISOString() ?? null,
    nextRecoveryAt: date(summary.next_recovery_at)?.toISOString() ?? null,
    currentFailures: failureRows.map((row) => ({
      stage: row.stage,
      // The query predicate excludes NULL; Drizzle does not narrow selected
      // column nullability from an isNotNull() predicate.
      errorCode: row.failureCode!,
      occurredAt: date(row.updatedAt)?.toISOString() ?? input.now.toISOString(),
      attemptCount: count(row.attemptCount),
    })),
  };
}
