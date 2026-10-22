import { sql, type SQL } from "drizzle-orm";

import type { DirectDatabase } from "../config/direct-database";

type ReadinessTransaction = Parameters<
  Parameters<DirectDatabase["transaction"]>[0]
>[0];

export type ProtectedTaskActivationProductReadiness = Readonly<{
  /** Product-role facts only. Crypto-role staging/orphan inventory is separate. */
  definitions: Readonly<{
    total: bigint;
    exactMapped: bigint;
    deferredNested: bigint;
    blockers: Readonly<{
      ordinarySupported: bigint;
      artifactDependentCandidates: bigint;
      invalidCurrentMapping: bigint;
      pendingRevisions: bigint;
      completeUnmappedRevisions: bigint;
      quarantinedRevisions: bigint;
      staleMappingRevisions: bigint;
    }>;
  }>;
  results: Readonly<{
    terminal: bigint;
    contentBearing: bigint;
    exactMapped: bigint;
    noContent: bigint;
    deferredNested: bigint;
    blockers: Readonly<{
      ordinarySupported: bigint;
      artifactDependentCandidates: bigint;
      invalidCurrentMapping: bigint;
      pendingRevisions: bigint;
      completeUnmappedRevisions: bigint;
      quarantinedRevisions: bigint;
      staleMappingRevisions: bigint;
    }>;
  }>;
  operations: Readonly<{
    blockers: Readonly<{
      activeBackfillClaims: bigint;
      incompleteOutputBindings: bigint;
    }>;
  }>;
}>;

type AggregateRow = Readonly<{
  definition_total: string;
  definition_exact_mapped: string;
  definition_deferred_nested: string;
  definition_ordinary_supported: string;
  definition_artifact_candidates: string;
  definition_invalid_mapping: string;
  definition_pending_revisions: string;
  definition_complete_unmapped_revisions: string;
  definition_quarantined_revisions: string;
  definition_stale_mapping_revisions: string;
  result_terminal: string;
  result_content_bearing: string;
  result_exact_mapped: string;
  result_no_content: string;
  result_deferred_nested: string;
  result_ordinary_supported: string;
  result_artifact_candidates: string;
  result_invalid_mapping: string;
  result_pending_revisions: string;
  result_complete_unmapped_revisions: string;
  result_quarantined_revisions: string;
  result_stale_mapping_revisions: string;
  active_backfill_claims: string;
  incomplete_output_bindings: string;
}>;

function count(row: AggregateRow, key: keyof AggregateRow): bigint {
  const value = row[key];
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`Protected Task activation readiness ${key} is invalid`);
  }
  return BigInt(value);
}

/**
 * One content-free product-role snapshot. Artifact metadata key presence is a
 * conservative blocker only: exact Artifact capability admission remains a
 * server-owned gate and these candidates are never treated as deferred-safe.
 */
export function buildProtectedTaskActivationProductReadinessQuery(
  now: Date,
): SQL {
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("Protected Task activation readiness time is invalid");
  }
  const nowIso = now.toISOString();
  return sql`
    WITH definition_state AS (
      SELECT task.id,
             task.content_representation,
             task.parent_task_id IS NOT NULL OR task.depth > 0 AS nested,
             task.metadata ?| ARRAY[
               'artifactRefs', 'artifactOperationId', 'artifactId'
             ] AS artifact_candidate,
             revision.task_id IS NOT NULL
               AND task.content_representation IN ('dual', 'protected')
               AND task.crypto_mapping_state = 'verified'
               AS exact_mapped
        FROM tasks task
        LEFT JOIN task_definition_crypto_revisions revision
          ON revision.task_id = task.id
         AND revision.content_namespace_id = task.content_namespace_id
         AND revision.content_revision = task.content_revision
         AND revision.crypto_object_id = task.crypto_object_id
         AND revision.required_namespace_fingerprint =
               task.crypto_required_namespace_fingerprint
         AND revision.representation = task.content_representation
         AND revision.payload_version = 1
         AND revision.crypto_access_revision <= task.crypto_access_revision
         AND revision.completion = 'complete'
         AND revision.disposition = 'mapped'
         AND revision.failure_code IS NULL
         AND revision.crypto_completed_at IS NOT NULL
    ),
    result_state AS (
      SELECT run.id,
             run.result_representation,
             task.parent_task_id IS NOT NULL OR task.depth > 0 AS nested,
             task.metadata ?| ARRAY[
               'artifactRefs', 'artifactOperationId', 'artifactId'
             ] AS artifact_candidate,
             run.result_text IS NOT NULL OR run.last_error IS NOT NULL
               AS ordinary_content_present,
             revision.task_run_id IS NOT NULL
               AND run.result_representation IN ('dual', 'protected')
               AND run.result_crypto_mapping_state = 'verified'
               AS exact_mapped
        FROM task_runs run
        JOIN tasks task ON task.id = run.task_id
        LEFT JOIN task_run_result_crypto_revisions revision
          ON revision.task_id = run.task_id
         AND revision.task_run_id = run.id
         AND revision.content_namespace_id = run.result_content_namespace_id
         AND revision.result_revision = run.result_revision
         AND revision.crypto_object_id = run.result_crypto_object_id
         AND revision.required_namespace_fingerprint =
               run.result_crypto_required_namespace_fingerprint
         AND revision.representation = run.result_representation
         AND revision.payload_version = 1
         AND revision.crypto_access_revision <= run.result_crypto_access_revision
         AND revision.completion = 'complete'
         AND revision.disposition = 'mapped'
         AND revision.failure_code IS NULL
         AND revision.crypto_completed_at IS NOT NULL
       WHERE run.status IN ('completed', 'errored', 'cancelled')
         AND run.completed_at IS NOT NULL
    ),
    definition_counts AS (
      SELECT count(*)::bigint AS total,
             count(*) FILTER (WHERE exact_mapped)::bigint AS exact_mapped,
             count(*) FILTER (WHERE nested)::bigint AS deferred_nested,
             count(*) FILTER (
               WHERE content_representation = 'ordinary'
                 AND NOT nested AND NOT artifact_candidate
             )::bigint AS ordinary_supported,
             count(*) FILTER (
               WHERE NOT nested AND artifact_candidate
             )::bigint AS artifact_candidates,
             count(*) FILTER (
               WHERE content_representation IN ('dual', 'protected')
                 AND NOT nested AND NOT artifact_candidate AND NOT exact_mapped
             )::bigint AS invalid_mapping
        FROM definition_state
    ),
    result_counts AS (
      SELECT count(*)::bigint AS terminal,
             count(*) FILTER (
               WHERE ordinary_content_present OR exact_mapped
                  OR result_representation IN ('dual', 'protected')
             )::bigint AS content_bearing,
             count(*) FILTER (WHERE exact_mapped)::bigint AS exact_mapped,
             count(*) FILTER (
               WHERE result_representation = 'ordinary'
                 AND NOT ordinary_content_present
             )::bigint AS no_content,
             count(*) FILTER (WHERE nested)::bigint AS deferred_nested,
             count(*) FILTER (
               WHERE result_representation = 'ordinary'
                 AND ordinary_content_present
                 AND NOT nested AND NOT artifact_candidate
             )::bigint AS ordinary_supported,
             count(*) FILTER (
               WHERE NOT nested AND artifact_candidate
                 AND (ordinary_content_present OR exact_mapped
                   OR result_representation IN ('dual', 'protected'))
             )::bigint AS artifact_candidates,
             count(*) FILTER (
               WHERE result_representation IN ('dual', 'protected')
                 AND NOT nested AND NOT artifact_candidate AND NOT exact_mapped
             )::bigint AS invalid_mapping
        FROM result_state
    ),
    definition_revision_counts AS (
      SELECT count(*) FILTER (
               WHERE completion = 'pending'
             )::bigint AS pending,
             count(*) FILTER (
               WHERE completion = 'complete' AND disposition = 'active'
             )::bigint AS complete_unmapped,
             count(*) FILTER (
               WHERE disposition = 'quarantined'
             )::bigint AS quarantined,
             count(*) FILTER (
               WHERE disposition = 'stale_mapping'
             )::bigint AS stale_mapping
        FROM task_definition_crypto_revisions
    ),
    result_revision_counts AS (
      SELECT count(*) FILTER (
               WHERE completion = 'pending'
             )::bigint AS pending,
             count(*) FILTER (
               WHERE completion = 'complete' AND disposition = 'active'
             )::bigint AS complete_unmapped,
             count(*) FILTER (
               WHERE disposition = 'quarantined'
             )::bigint AS quarantined,
             count(*) FILTER (
               WHERE disposition = 'stale_mapping'
             )::bigint AS stale_mapping
        FROM task_run_result_crypto_revisions
    ),
    operation_counts AS (
      SELECT (
               SELECT count(*)
                 FROM task_content_backfill_scans scan
                WHERE scan.lease_token IS NOT NULL
                  AND scan.lease_device_id IS NOT NULL
                  AND scan.lease_expires_at > ${nowIso}::timestamptz
                  AND scan.claim IS NOT NULL
             )::bigint AS active_backfill_claims,
             (
               SELECT count(*)
                 FROM protected_task_run_output_bindings binding
                WHERE binding.completed_at IS NULL
             )::bigint AS incomplete_output_bindings
    )
    SELECT definition_counts.total::text AS definition_total,
           definition_counts.exact_mapped::text AS definition_exact_mapped,
           definition_counts.deferred_nested::text AS definition_deferred_nested,
           definition_counts.ordinary_supported::text AS definition_ordinary_supported,
           definition_counts.artifact_candidates::text AS definition_artifact_candidates,
           definition_counts.invalid_mapping::text AS definition_invalid_mapping,
           definition_revision_counts.pending::text AS definition_pending_revisions,
           definition_revision_counts.complete_unmapped::text
             AS definition_complete_unmapped_revisions,
           definition_revision_counts.quarantined::text
             AS definition_quarantined_revisions,
           definition_revision_counts.stale_mapping::text
             AS definition_stale_mapping_revisions,
           result_counts.terminal::text AS result_terminal,
           result_counts.content_bearing::text AS result_content_bearing,
           result_counts.exact_mapped::text AS result_exact_mapped,
           result_counts.no_content::text AS result_no_content,
           result_counts.deferred_nested::text AS result_deferred_nested,
           result_counts.ordinary_supported::text AS result_ordinary_supported,
           result_counts.artifact_candidates::text AS result_artifact_candidates,
           result_counts.invalid_mapping::text AS result_invalid_mapping,
           result_revision_counts.pending::text AS result_pending_revisions,
           result_revision_counts.complete_unmapped::text
             AS result_complete_unmapped_revisions,
           result_revision_counts.quarantined::text
             AS result_quarantined_revisions,
           result_revision_counts.stale_mapping::text
             AS result_stale_mapping_revisions,
           operation_counts.active_backfill_claims::text AS active_backfill_claims,
           operation_counts.incomplete_output_bindings::text
             AS incomplete_output_bindings
      FROM definition_counts, result_counts,
           definition_revision_counts, result_revision_counts, operation_counts`;
}

export async function readProtectedTaskActivationProductReadinessInTransaction(
  transaction: Pick<ReadinessTransaction, "execute">,
  input: Readonly<{ now: Date }>,
): Promise<ProtectedTaskActivationProductReadiness> {
  const rows = await transaction.execute<AggregateRow>(
    buildProtectedTaskActivationProductReadinessQuery(input.now),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Protected Task activation readiness is unavailable");
  }
  return Object.freeze({
    definitions: Object.freeze({
      total: count(row, "definition_total"),
      exactMapped: count(row, "definition_exact_mapped"),
      deferredNested: count(row, "definition_deferred_nested"),
      blockers: Object.freeze({
        ordinarySupported: count(row, "definition_ordinary_supported"),
        artifactDependentCandidates: count(row, "definition_artifact_candidates"),
        invalidCurrentMapping: count(row, "definition_invalid_mapping"),
        pendingRevisions: count(row, "definition_pending_revisions"),
        completeUnmappedRevisions: count(
          row,
          "definition_complete_unmapped_revisions",
        ),
        quarantinedRevisions: count(row, "definition_quarantined_revisions"),
        staleMappingRevisions: count(row, "definition_stale_mapping_revisions"),
      }),
    }),
    results: Object.freeze({
      terminal: count(row, "result_terminal"),
      contentBearing: count(row, "result_content_bearing"),
      exactMapped: count(row, "result_exact_mapped"),
      noContent: count(row, "result_no_content"),
      deferredNested: count(row, "result_deferred_nested"),
      blockers: Object.freeze({
        ordinarySupported: count(row, "result_ordinary_supported"),
        artifactDependentCandidates: count(row, "result_artifact_candidates"),
        invalidCurrentMapping: count(row, "result_invalid_mapping"),
        pendingRevisions: count(row, "result_pending_revisions"),
        completeUnmappedRevisions: count(row, "result_complete_unmapped_revisions"),
        quarantinedRevisions: count(row, "result_quarantined_revisions"),
        staleMappingRevisions: count(row, "result_stale_mapping_revisions"),
      }),
    }),
    operations: Object.freeze({
      blockers: Object.freeze({
        activeBackfillClaims: count(row, "active_backfill_claims"),
        incompleteOutputBindings: count(row, "incomplete_output_bindings"),
      }),
    }),
  });
}

/** Read a fresh repeatable product snapshot; this does not claim crypto-role readiness. */
export async function readProtectedTaskActivationProductReadiness(
  database: Pick<DirectDatabase, "transaction">,
  input: Readonly<{ now: Date }>,
): Promise<ProtectedTaskActivationProductReadiness> {
  return database.transaction(
    transaction => readProtectedTaskActivationProductReadinessInTransaction(
      transaction,
      input,
    ),
    { isolationLevel: "repeatable read" },
  );
}
