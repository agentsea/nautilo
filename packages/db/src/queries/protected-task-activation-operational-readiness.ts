import { sql, type SQL } from "drizzle-orm";

import type { DirectDatabase } from "../config/direct-database";
import { jobs } from "../schema/jobs";
import { protectedTaskRunOutputBindings } from
  "../schema/protected-task-run-output-bindings";
import { protectedTaskWakeContinuationReceipts } from
  "../schema/protected-task-wake-continuation-receipts";
import { taskDefinitionCryptoRevisions } from
  "../schema/task-definition-crypto-revisions";
import { taskRuns } from "../schema/task-runs";
import { tasks } from "../schema/tasks";
import { PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY } from
  "./protected-task-running-recovery";
import {
  PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY,
  PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY,
  PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY,
} from "./tasks";

type ReadinessTransaction = Parameters<
  Parameters<DirectDatabase["transaction"]>[0]
>[0];

export type ProtectedTaskActivationOperationalPersistence = Readonly<{
  protectedTaskBackedJobs: bigint;
  protectedJobContentViolations: bigint;
  parkedJobsRequiringIntegrityProof: bigint;
}>;

export type ProtectedTaskActivationOperationalReadiness = Readonly<{
  policyRevision: number;
  maintenance: Readonly<{
    state: "normal" | "draining" | "applying";
    operationId: string | null;
    leaseExpiresAt: Date | null;
    hardExpiresAt: Date | null;
  }>;
  activity: Readonly<{
    runningForegroundJobs: number;
    runningBackgroundJobs: number;
    queuedTurns: number;
    bufferedLanes: number;
    acceptedWork: number;
    runningTaskRuns: number;
    claimedTasks: number;
  }>;
  persistence: ProtectedTaskActivationOperationalPersistence;
}>;

type AggregateRow = Readonly<{
  protected_task_backed_jobs: string;
  protected_job_content_violations: string;
  parked_jobs_requiring_integrity_proof: string;
}>;

function count(row: AggregateRow, key: keyof AggregateRow): bigint {
  const value = row[key];
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`Protected Task operational readiness ${key} is invalid`);
  }
  return BigInt(value);
}

/**
 * Count only content-free structural Job facts. Parked receipt, transcript and
 * physical encrypted-checkpoint equality require their owning readers and are
 * deliberately reported as a denominator for the server validation port.
 */
export function buildProtectedTaskActivationOperationalPersistenceQuery(): SQL {
  return sql`
    WITH protected_jobs AS (
      SELECT job.id,
             job.owner_id,
             job.requestor_id,
             job.lane_key,
             job.type,
             job.input,
             job.result,
             job.message,
             job.metadata,
             task.id AS task_id,
             task.requestor_id AS task_requestor_id,
             run.id AS task_run_id,
             run.job_id AS task_run_job_id,
             run.status AS task_run_status,
             job.status AS job_status,
             definition.crypto_object_id AS definition_object_id,
             binding.result_operation_id AS binding_result_operation_id,
             binding.result_object_id AS binding_result_object_id,
             CASE
               WHEN job.input ->> 'policyRevision' ~ '^[1-9][0-9]{0,9}$'
               THEN (job.input ->> 'policyRevision')::numeric
               ELSE NULL
             END AS reference_policy_revision,
             CASE
               WHEN job.input ->> 'executionSegment' ~ '^[1-9][0-9]{0,9}$'
               THEN (job.input ->> 'executionSegment')::numeric
               ELSE NULL
             END AS reference_execution_segment
        FROM ${jobs} job
        JOIN ${tasks} task
          ON job.lane_key = 'task:' || task.id::text
        LEFT JOIN ${taskRuns} run
          ON run.id::text = job.input ->> 'taskRunId'
         AND run.task_id = task.id
        LEFT JOIN ${taskDefinitionCryptoRevisions} definition
          ON definition.task_id = task.id
         AND definition.crypto_object_id = job.input ->> 'inputObjectId'
         AND definition.payload_version = 1
         AND definition.completion = 'complete'
         AND definition.disposition = 'mapped'
         AND definition.failure_code IS NULL
        LEFT JOIN ${protectedTaskRunOutputBindings} binding
          ON binding.task_run_id = run.id
         AND binding.result_object_id = job.input ->> 'resultObjectId'
       WHERE task.content_representation IN ('dual', 'protected')
    ), classified AS (
      SELECT *,
        COALESCE(
          metadata ? ${PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY}
          AND task_run_id IS NOT NULL
          AND task_run_job_id = id
          AND task_run_status = 'awaiting'
          AND job_status = 'completed',
          false
        ) AS parked,
        COALESCE((
          result IS NULL
          AND message IS NULL
          AND owner_id = task_requestor_id
          AND requestor_id = task_requestor_id
          AND type = 'foreground'
          AND jsonb_typeof(input) = 'object'
          AND input ->> 'kind' = 'protected_task_run_v1'
          AND input ->> 'taskId' = task_id::text
          AND input ->> 'taskRunId' = task_run_id::text
          AND definition_object_id = input ->> 'inputObjectId'
          AND binding_result_object_id = input ->> 'resultObjectId'
          AND input ->> 'authorizationRequestId'
            ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
          AND octet_length(input ->> 'authorizationRequestId') <= 128
          AND reference_policy_revision BETWEEN 1 AND 2147483647
          AND reference_execution_segment BETWEEN 1 AND 2147483647
          AND (
            reference_execution_segment = 1
            AND input ?& ARRAY[
              'authorizationRequestId', 'executionSegment', 'inputObjectId',
              'kind', 'policyRevision', 'resultObjectId', 'taskId', 'taskRunId'
            ]
            AND (SELECT count(*) FROM jsonb_object_keys(CASE
              WHEN jsonb_typeof(input) = 'object' THEN input
              ELSE '{}'::jsonb
            END)) = 8
            AND NOT input ? 'resumeAcceptanceId'
            AND NOT input ? 'resumeContinuationFingerprint'
            OR reference_execution_segment > 1
            AND (
              input ? 'resumeAcceptanceId'
              AND NOT input ? 'resumeContinuationFingerprint'
              AND input ->> 'resumeAcceptanceId'
                ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
              AND octet_length(input ->> 'resumeAcceptanceId') <= 128
              OR input ? 'resumeContinuationFingerprint'
              AND NOT input ? 'resumeAcceptanceId'
              AND input ->> 'resumeContinuationFingerprint'
                ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
            )
            AND (SELECT count(*) FROM jsonb_object_keys(CASE
              WHEN jsonb_typeof(input) = 'object' THEN input
              ELSE '{}'::jsonb
            END)) = 9
          )
          AND jsonb_typeof(metadata) = 'object'
          AND NOT EXISTS (
            SELECT 1
              FROM jsonb_object_keys(CASE
                WHEN jsonb_typeof(metadata) = 'object' THEN metadata
                ELSE '{}'::jsonb
              END) AS metadata_key(key)
             WHERE metadata_key.key <> ALL (ARRAY[
               ${PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY},
               ${PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY},
               ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY},
               ${PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY}
             ])
          )
          AND (NOT metadata ? ${PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY}
            OR metadata ? ${PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY})
          AND (NOT metadata ? ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY}
            OR (SELECT count(*) FROM jsonb_object_keys(CASE
              WHEN jsonb_typeof(metadata) = 'object' THEN metadata
              ELSE '{}'::jsonb
            END)) = 1)
          AND (NOT metadata ? ${PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY}
            OR (SELECT count(*) FROM jsonb_object_keys(CASE
              WHEN jsonb_typeof(metadata) = 'object' THEN metadata
              ELSE '{}'::jsonb
            END)) = 1)
          AND (NOT metadata ? ${PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY}
            OR jsonb_typeof(metadata -> ${PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY}) = 'object')
          AND (NOT metadata ? ${PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY}
            OR jsonb_typeof(metadata -> ${PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY}) = 'object')
          AND (NOT metadata ? ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY}
            OR (
              jsonb_typeof(metadata -> ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY}) = 'object'
              AND (SELECT count(*) FROM jsonb_object_keys(CASE
                WHEN jsonb_typeof(metadata -> ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY}) = 'object'
                  THEN metadata -> ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY}
                ELSE '{}'::jsonb
              END)) = 10
              AND metadata -> ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY} ->> 'taskId' = task_id::text
              AND metadata -> ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY} ->> 'taskRunId' = task_run_id::text
              AND metadata -> ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY} ->> 'resultObjectId'
                = binding_result_object_id
              AND metadata -> ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY} ->> 'operationId'
                = binding_result_operation_id
              AND metadata -> ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY} ->> 'requestDigest'
                ~ '^[0-9a-f]{64}$'
              AND jsonb_typeof(metadata -> ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY} -> 'completedAt')
                = 'string'
              AND octet_length(metadata -> ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY} ->> 'completedAt')
                <= 32
              AND metadata -> ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY} ->> 'completedAt'
                ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
              AND metadata -> ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY} ->> 'resultRepresentation'
                IN ('dual', 'protected')
              AND metadata -> ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY} ->> 'outcome'
                IN ('completed', 'errored')
              AND jsonb_typeof(metadata -> ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY} -> 'version')
                = 'number'
              AND jsonb_typeof(metadata -> ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY} -> 'resultRevision')
                = 'number'
              AND metadata -> ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY} ->> 'version' = '1'
              AND metadata -> ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY} ->> 'resultRevision' = '1'
            ))
          AND (NOT metadata ? ${PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY}
            OR (
              jsonb_typeof(metadata -> ${PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY}) = 'object'
              AND (SELECT count(*) FROM jsonb_object_keys(CASE
                WHEN jsonb_typeof(metadata -> ${PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY}) = 'object'
                  THEN metadata -> ${PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY}
                ELSE '{}'::jsonb
              END)) = 10
              AND metadata -> ${PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY} ->> 'taskId' = task_id::text
              AND metadata -> ${PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY} ->> 'taskRunId' = task_run_id::text
              AND metadata -> ${PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY} ->> 'authorizationRequestId'
                = input ->> 'authorizationRequestId'
              AND metadata -> ${PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY} ->> 'executionSegment'
                = input ->> 'executionSegment'
              AND jsonb_typeof(metadata -> ${PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY} -> 'executionSegment')
                = 'number'
              AND jsonb_typeof(metadata -> ${PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY} -> 'requestRevision')
                = 'number'
              AND metadata -> ${PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY} ->> 'requestRevision'
                ~ '^[1-9][0-9]{0,9}$'
              AND jsonb_typeof(metadata -> ${PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY} -> 'recipientGeneration')
                = 'number'
              AND metadata -> ${PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY} ->> 'recipientGeneration'
                ~ '^(0|[1-9][0-9]{0,9})$'
              AND jsonb_typeof(metadata -> ${PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY} -> 'parentTaskTerminalized')
                = 'boolean'
              AND jsonb_typeof(metadata -> ${PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY} -> 'settledAt')
                = 'string'
              AND octet_length(metadata -> ${PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY} ->> 'settledAt')
                <= 32
              AND metadata -> ${PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY} ->> 'settledAt'
                ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
              AND metadata -> ${PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY} ->> 'reason'
                = 'provider_outcome_unknown'
              AND jsonb_typeof(metadata -> ${PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY} -> 'version')
                = 'number'
              AND metadata -> ${PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY} ->> 'version' = '1'
            ))
        ), false) AS exact_content_free
      FROM protected_jobs
    ), latest_wake_continuations AS (
      SELECT DISTINCT ON (receipt.wake_job_id)
             job.id,
             job.owner_id,
             job.requestor_id,
             job.room_id,
             job.lane_key,
             job.type,
             job.status AS job_status,
             job.started_at,
             job.completed_at,
             job.input,
             job.result,
             job.message,
             job.metadata,
             task.id AS task_id,
             task.owner_id AS task_owner_id,
             task.requestor_id AS task_requestor_id,
             task.content_namespace_id AS task_namespace_id,
             task.content_revision AS task_content_revision,
             task.crypto_object_id AS task_object_id,
             task.crypto_mapping_state AS task_mapping_state,
             run.id AS task_run_id,
             run.task_id AS run_task_id,
             run.status AS run_status,
             run.completed_at AS run_completed_at,
             run.result_representation,
             run.result_content_namespace_id,
             run.result_revision,
             run.result_crypto_object_id,
             run.result_crypto_mapping_state,
             binding.binding_id,
             binding.delivery_mode,
             binding.destination_room_id AS binding_room_id,
             binding.destination_namespace_id AS binding_namespace_id,
             binding.result_object_id,
             binding.wake_operation_id,
             binding.wake_job_id,
             binding.wake_scheduled_at,
             binding.completed_at AS binding_completed_at,
             receipt.segment,
             receipt.prior_recipient_generation,
             receipt.wake_authorization_request_id,
             receipt.binding_id AS receipt_binding_id,
             receipt.wake_operation_id AS receipt_wake_operation_id,
             receipt.destination_room_id AS receipt_destination_room_id,
             receipt.destination_namespace_id AS receipt_destination_namespace_id,
             receipt.checkpoint_thread_id,
             receipt.checkpoint_contract,
             receipt.expected_checkpoint_count,
             receipt.checkpoint_ordered_digest,
             receipt.expected_blob_count,
             receipt.blob_ordered_digest,
             receipt.expected_pending_write_count,
             receipt.pending_write_ordered_digest,
             receipt.semantic_authority_requirements,
             receipt.retained_source_namespace_ids,
             receipt.initial_policy_revision,
             receipt.initial_agent_authorization_revision
        FROM ${protectedTaskWakeContinuationReceipts} receipt
        JOIN ${tasks} task ON task.id = receipt.task_id
        JOIN ${taskRuns} run ON run.id = receipt.task_run_id
        JOIN ${protectedTaskRunOutputBindings} binding
          ON binding.task_run_id = receipt.task_run_id
        JOIN ${jobs} job ON job.id = receipt.wake_job_id
       WHERE task.content_representation IN ('dual', 'protected')
       ORDER BY receipt.wake_job_id, receipt.segment DESC
    ), wake_classified AS (
      SELECT id,
        COALESCE((
          owner_id = task_requestor_id
          AND requestor_id = task_requestor_id
          AND task_owner_id = task_requestor_id
          AND task_content_revision > 0
          AND task_object_id IS NOT NULL
          AND task_namespace_id IS NOT NULL
          AND task_mapping_state = 'verified'
          AND run_task_id = task_id
          AND run_status IN ('completed', 'cancelled', 'errored')
          AND run_completed_at IS NOT NULL
          AND result_representation IN ('dual', 'protected')
          AND result_content_namespace_id = task_namespace_id
          AND result_revision > 0
          AND result_crypto_object_id = result_object_id
          AND result_crypto_mapping_state = 'verified'
          AND binding_id = 'task-run-output:' || task_run_id::text
          AND receipt_binding_id = binding_id
          AND delivery_mode IN ('wake', 'raw_and_wake')
          AND binding_room_id IS NOT NULL
          AND binding_namespace_id IS NOT NULL
          AND wake_operation_id = 'task-run-delivery-wake:' || task_run_id::text
          AND receipt_wake_operation_id = wake_operation_id
          AND wake_job_id = id
          AND wake_scheduled_at IS NOT NULL
          AND binding_completed_at IS NOT NULL
          AND room_id = binding_room_id
          AND lane_key = 'room:' || binding_room_id::text
          AND type = 'foreground'
          AND (
            job_status = 'queued' AND started_at IS NULL AND completed_at IS NULL
            OR job_status = 'running' AND started_at IS NOT NULL AND completed_at IS NULL
          )
          AND result IS NULL
          AND message IS NULL
          AND jsonb_typeof(metadata) = 'object'
          AND (SELECT count(*) FROM jsonb_object_keys(CASE
            WHEN jsonb_typeof(metadata) = 'object' THEN metadata
            ELSE '{}'::jsonb
          END)) = 0
          AND jsonb_typeof(input) = 'object'
          AND input ?& ARRAY[
            'bindingId', 'kind', 'resultObjectId', 'taskId', 'taskRunId',
            'wakeOperationId'
          ]
          AND (SELECT count(*) FROM jsonb_object_keys(CASE
            WHEN jsonb_typeof(input) = 'object' THEN input
            ELSE '{}'::jsonb
          END)) = 6
          AND input ->> 'kind' = 'protected_task_delivery_v1'
          AND input ->> 'taskId' = task_id::text
          AND input ->> 'taskRunId' = task_run_id::text
          AND input ->> 'bindingId' = binding_id
          AND input ->> 'resultObjectId' = result_object_id
          AND input ->> 'wakeOperationId' = wake_operation_id
          AND segment = prior_recipient_generation + 1
          AND segment > 0
          AND wake_authorization_request_id = 'task-wake-authorization:' || id::text
          AND receipt_destination_namespace_id <> task_namespace_id
          AND NOT (
            receipt_destination_room_id = binding_room_id
            AND receipt_destination_namespace_id = binding_namespace_id
          )
          AND checkpoint_thread_id = 'protected-task-wake:' || id::text
          AND checkpoint_contract = 'encrypted_langgraph_v1'
          AND expected_checkpoint_count > 0
          AND expected_blob_count >= 0
          AND expected_pending_write_count >= 0
          AND octet_length(checkpoint_ordered_digest) = 32
          AND octet_length(blob_ordered_digest) = 32
          AND octet_length(pending_write_ordered_digest) = 32
          AND jsonb_typeof(semantic_authority_requirements) = 'array'
          AND cardinality(retained_source_namespace_ids) > 0
          AND NOT receipt_destination_namespace_id
            = ANY(retained_source_namespace_ids)
          AND initial_policy_revision > 0
          AND initial_agent_authorization_revision > 0
        ), false) AS exact_content_free
        FROM latest_wake_continuations
    )
    SELECT (
             (SELECT count(DISTINCT id) FROM classified)
             + (SELECT count(DISTINCT id) FROM wake_classified)
           )::text AS protected_task_backed_jobs,
           (
             (SELECT count(DISTINCT id) FROM classified
               WHERE NOT exact_content_free)
             + (SELECT count(DISTINCT id) FROM wake_classified
               WHERE NOT exact_content_free)
           )::text AS protected_job_content_violations,
           (
             (SELECT count(DISTINCT id) FROM classified WHERE parked)
             + (SELECT count(DISTINCT id) FROM wake_classified)
           )::text AS parked_jobs_requiring_integrity_proof`;
}

export async function readProtectedTaskActivationOperationalPersistenceInTransaction(
  transaction: Pick<ReadinessTransaction, "execute">,
): Promise<ProtectedTaskActivationOperationalPersistence> {
  const rows = await transaction.execute<AggregateRow>(
    buildProtectedTaskActivationOperationalPersistenceQuery(),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Protected Task operational readiness is unavailable");
  }
  return Object.freeze({
    protectedTaskBackedJobs: count(row, "protected_task_backed_jobs"),
    protectedJobContentViolations: count(
      row,
      "protected_job_content_violations",
    ),
    parkedJobsRequiringIntegrityProof: count(
      row,
      "parked_jobs_requiring_integrity_proof",
    ),
  });
}
