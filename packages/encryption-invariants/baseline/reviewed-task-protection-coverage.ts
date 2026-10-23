import type { EncryptionCoverageEntry } from "../src/model";
import type { ReviewedDebtLink } from "../src/registry";

const EVIDENCE = [
  "packages/encryption-invariants/tests/integration/reviewed-task-protection-coverage.test.ts",
] as const;
const DB_SCHEMA_EVIDENCE = [
  ...EVIDENCE,
  "packages/encryption-invariants/tests/integration/database-writer-inventory.test.ts",
  "packages/db/tests/unit/foreground-memory-publication-schema.test.ts",
  "packages/lattice-bridge/tests/unit/postgres-foreground-memory-publication.test.ts",
  "packages/db/tests/unit/task-crypto-schema.test.ts",
  "packages/server/tests/lattice-integration/protected-task-memory-object-writer.integration.test.ts",
  "packages/db/tests/unit/task-content-backfill.test.ts",
  "packages/db/tests/unit/protected-task-output-binding-schema.test.ts",
  "packages/db/tests/unit/protected-task-wake-continuation-schema.test.ts",
  "packages/db/tests/unit/protected-task-wake-continuation.test.ts",
] as const;
const PROTECTED_ROUTE_EVIDENCE = [
  ...EVIDENCE,
  "packages/server/tests/unit-isolated/task-protected-routes.test.ts",
  "packages/server/tests/unit/protected-task-transcript-read.test.ts",
  "packages/server/tests/unit/task-content-backfill-routes.test.ts",
  "packages/server/tests/unit/protected-task-pending-attention-route.test.ts",
] as const;
const TASK_ORDINARY_FALLBACK_EVIDENCE = [
  ...EVIDENCE,
  "packages/api-client/tests/unit/task-ordinary-fallback-schema.test.ts",
  "packages/lattice-bridge/tests/unit/authorized-human-task-client.test.ts",
  "packages/lattice-bridge/tests/unit/human-task-ordinary-fallback-request.test.ts",
  "packages/lattice-bridge/tests/unit/vault-human-task-device-content.test.ts",
  "packages/server/tests/unit-isolated/task-ordinary-fallback-composition.test.ts",
  "packages/server/tests/unit-isolated/task-ordinary-fallback-routes.test.ts",
  "packages/server/tests/lattice-integration/protected-task-memory-object-writer.integration.test.ts",
] as const;
const TASK_DEFINITION_AUTHORIZATION_EVIDENCE = [
  ...EVIDENCE,
  "packages/lattice-bridge/tests/unit/authorized-human-live-shadow-message-client.test.ts",
  "packages/lattice-crypto/tests/unit/domain-foreground-authorization-v2.test.ts",
  "packages/server/tests/unit/live-shadow-message-route.test.ts",
  "packages/server/tests/unit/task-definition-foreground-authorization.test.ts",
  "packages/server/tests/unit/ws-publisher-task-authorization-audience.test.ts",
] as const;

const TASK_PROTECTION_DATABASE_LOCATORS = [
  "public.background_crypto_authorization_domain_requirements.expected_authorization_revision",
  "public.background_crypto_authorization_requests.runtime_kind",
  "public.background_crypto_authorization_requests.runtime_version",
  "public.foreground_memory_crypto_publication_receipts",
  "public.foreground_memory_crypto_publication_receipts.agent_id",
  "public.foreground_memory_crypto_publication_receipts.content_revision",
  "public.foreground_memory_crypto_publication_receipts.crypto_object_id",
  "public.foreground_memory_crypto_publication_receipts.genesis_manifest_hash",
  "public.foreground_memory_crypto_publication_receipts.memory_id",
  "public.foreground_memory_crypto_publication_receipts.operation_id",
  "public.foreground_memory_crypto_publication_receipts.required_namespace_fingerprint",
  "public.foreground_memory_crypto_publication_receipts.reservation_digest",
  "public.foreground_memory_crypto_publication_receipts.staged_at",
  "public.llm_usage_events.task_id",
  "public.protected_task_run_output_bindings",
  "public.protected_task_run_output_bindings.accepted_at",
  "public.protected_task_run_output_bindings.accepted_policy_revision",
  "public.protected_task_run_output_bindings.binding_id",
  "public.protected_task_run_output_bindings.completed_at",
  "public.protected_task_run_output_bindings.delivery_mode",
  "public.protected_task_run_output_bindings.destination_namespace_id",
  "public.protected_task_run_output_bindings.destination_room_id",
  "public.protected_task_run_output_bindings.message_id",
  "public.protected_task_run_output_bindings.message_operation_id",
  "public.protected_task_run_output_bindings.message_published_at",
  "public.protected_task_run_output_bindings.result_attached_at",
  "public.protected_task_run_output_bindings.result_object_id",
  "public.protected_task_run_output_bindings.result_operation_id",
  "public.protected_task_run_output_bindings.result_revision",
  "public.protected_task_run_output_bindings.result_terminal_at",
  "public.protected_task_run_output_bindings.task_run_id",
  "public.protected_task_run_output_bindings.wake_job_id",
  "public.protected_task_run_output_bindings.wake_operation_id",
  "public.protected_task_run_output_bindings.wake_scheduled_at",
  "public.protected_task_wake_continuation_receipts",
  "public.protected_task_wake_continuation_receipts.additional_authorization_request_id",
  "public.protected_task_wake_continuation_receipts.binding_id",
  "public.protected_task_wake_continuation_receipts.blob_ordered_digest",
  "public.protected_task_wake_continuation_receipts.checkpoint_contract",
  "public.protected_task_wake_continuation_receipts.checkpoint_ordered_digest",
  "public.protected_task_wake_continuation_receipts.checkpoint_thread_id",
  "public.protected_task_wake_continuation_receipts.destination_authority_digest",
  "public.protected_task_wake_continuation_receipts.destination_namespace_id",
  "public.protected_task_wake_continuation_receipts.destination_room_id",
  "public.protected_task_wake_continuation_receipts.expected_blob_count",
  "public.protected_task_wake_continuation_receipts.expected_checkpoint_count",
  "public.protected_task_wake_continuation_receipts.expected_pending_write_count",
  "public.protected_task_wake_continuation_receipts.initial_agent_authorization_revision",
  "public.protected_task_wake_continuation_receipts.initial_policy_revision",
  "public.protected_task_wake_continuation_receipts.interrupt_id",
  "public.protected_task_wake_continuation_receipts.operation_id",
  "public.protected_task_wake_continuation_receipts.pending_write_ordered_digest",
  "public.protected_task_wake_continuation_receipts.prior_recipient_generation",
  "public.protected_task_wake_continuation_receipts.request_digest",
  "public.protected_task_wake_continuation_receipts.required_authority_digest",
  "public.protected_task_wake_continuation_receipts.retained_source_namespace_ids",
  "public.protected_task_wake_continuation_receipts.sealed_at",
  "public.protected_task_wake_continuation_receipts.segment",
  "public.protected_task_wake_continuation_receipts.semantic_authority_requirements",
  "public.protected_task_wake_continuation_receipts.source_envelope_digest",
  "public.protected_task_wake_continuation_receipts.task_id",
  "public.protected_task_wake_continuation_receipts.task_run_id",
  "public.protected_task_wake_continuation_receipts.wake_authorization_request_id",
  "public.protected_task_wake_continuation_receipts.wake_job_id",
  "public.protected_task_wake_continuation_receipts.wake_operation_id",
  "public.provider_cost_events.task_id",
  "public.session_message_crypto_revisions.task_wake_operation_id",
  "public.task_cancellation_crypto_staging_receipts",
  "public.task_cancellation_crypto_staging_receipts.authority_fingerprint",
  "public.task_cancellation_crypto_staging_receipts.authorization_digest",
  "public.task_cancellation_crypto_staging_receipts.claim_id",
  "public.task_cancellation_crypto_staging_receipts.crypto_object_id",
  "public.task_cancellation_crypto_staging_receipts.genesis_manifest_hash",
  "public.task_cancellation_crypto_staging_receipts.policy_revision",
  "public.task_cancellation_crypto_staging_receipts.recipient_generation",
  "public.task_cancellation_crypto_staging_receipts.request_id",
  "public.task_cancellation_crypto_staging_receipts.staged_at",
  "public.task_cancellation_crypto_staging_receipts.stopped_intent_hash",
  "public.task_content_backfill_failures",
  "public.task_content_backfill_failures.entity_id",
  "public.task_content_backfill_failures.kind",
  "public.task_content_backfill_failures.observed_at",
  "public.task_content_backfill_failures.policy_revision",
  "public.task_content_backfill_failures.reason",
  "public.task_content_backfill_failures.source_completed_at",
  "public.task_content_backfill_failures.source_revision",
  "public.task_content_backfill_failures.source_status",
  "public.task_content_backfill_failures.source_updated_at",
  "public.task_content_backfill_failures.task_id",
  "public.task_content_backfill_failures.task_run_id",
  "public.task_content_backfill_scans",
  "public.task_content_backfill_scans.claim",
  "public.task_content_backfill_scans.cursor_at",
  "public.task_content_backfill_scans.cursor_task_id",
  "public.task_content_backfill_scans.cursor_task_run_id",
  "public.task_content_backfill_scans.human_actor_id",
  "public.task_content_backfill_scans.last_active_at",
  "public.task_content_backfill_scans.last_sweep_at",
  "public.task_content_backfill_scans.lease_device_id",
  "public.task_content_backfill_scans.lease_expires_at",
  "public.task_content_backfill_scans.lease_token",
  "public.task_content_backfill_scans.phase",
  "public.task_content_backfill_scans.resume_at",
  "public.task_content_backfill_scans.sweep_started_at",
  "public.task_content_backfill_scans.through_at",
  "public.task_content_backfill_scans.through_task_id",
  "public.task_content_backfill_scans.through_task_run_id",
  "public.task_definition_crypto_revisions",
  "public.task_definition_crypto_revisions.anchor_namespace_id",
  "public.task_definition_crypto_revisions.attempt_count",
  "public.task_definition_crypto_revisions.authority_fingerprint",
  "public.task_definition_crypto_revisions.completion",
  "public.task_definition_crypto_revisions.content_namespace_id",
  "public.task_definition_crypto_revisions.content_revision",
  "public.task_definition_crypto_revisions.created_at",
  "public.task_definition_crypto_revisions.crypto_access_revision",
  "public.task_definition_crypto_revisions.crypto_completed_at",
  "public.task_definition_crypto_revisions.crypto_object_id",
  "public.task_definition_crypto_revisions.disposition",
  "public.task_definition_crypto_revisions.failure_code",
  "public.task_definition_crypto_revisions.historical_repair",
  "public.task_definition_crypto_revisions.lease_expires_at",
  "public.task_definition_crypto_revisions.lease_token",
  "public.task_definition_crypto_revisions.next_attempt_at",
  "public.task_definition_crypto_revisions.operation_id",
  "public.task_definition_crypto_revisions.operational_metadata",
  "public.task_definition_crypto_revisions.payload_version",
  "public.task_definition_crypto_revisions.representation",
  "public.task_definition_crypto_revisions.request_digest",
  "public.task_definition_crypto_revisions.requester_human_id",
  "public.task_definition_crypto_revisions.required_namespace_fingerprint",
  "public.task_definition_crypto_revisions.sequence",
  "public.task_definition_crypto_revisions.task_id",
  "public.task_definition_crypto_revisions.updated_at",
  "public.task_historical_content_crypto_staging_receipts",
  "public.task_historical_content_crypto_staging_receipts.authority_fingerprint",
  "public.task_historical_content_crypto_staging_receipts.crypto_object_id",
  "public.task_historical_content_crypto_staging_receipts.genesis_manifest_hash",
  "public.task_historical_content_crypto_staging_receipts.operation_id",
  "public.task_historical_content_crypto_staging_receipts.signed_publication_request_bytes",
  "public.task_historical_content_crypto_staging_receipts.signed_request_digest",
  "public.task_historical_content_crypto_staging_receipts.staged_at",
  "public.task_run_result_crypto_revisions",
  "public.task_run_result_crypto_revisions.anchor_namespace_id",
  "public.task_run_result_crypto_revisions.attempt_count",
  "public.task_run_result_crypto_revisions.authority_fingerprint",
  "public.task_run_result_crypto_revisions.completion",
  "public.task_run_result_crypto_revisions.content_namespace_id",
  "public.task_run_result_crypto_revisions.created_at",
  "public.task_run_result_crypto_revisions.crypto_access_revision",
  "public.task_run_result_crypto_revisions.crypto_completed_at",
  "public.task_run_result_crypto_revisions.crypto_object_id",
  "public.task_run_result_crypto_revisions.disposition",
  "public.task_run_result_crypto_revisions.failure_code",
  "public.task_run_result_crypto_revisions.historical_repair",
  "public.task_run_result_crypto_revisions.lease_expires_at",
  "public.task_run_result_crypto_revisions.lease_token",
  "public.task_run_result_crypto_revisions.next_attempt_at",
  "public.task_run_result_crypto_revisions.operation_id",
  "public.task_run_result_crypto_revisions.payload_version",
  "public.task_run_result_crypto_revisions.representation",
  "public.task_run_result_crypto_revisions.request_digest",
  "public.task_run_result_crypto_revisions.requester_human_id",
  "public.task_run_result_crypto_revisions.required_namespace_fingerprint",
  "public.task_run_result_crypto_revisions.result_revision",
  "public.task_run_result_crypto_revisions.sequence",
  "public.task_run_result_crypto_revisions.task_id",
  "public.task_run_result_crypto_revisions.task_run_id",
  "public.task_run_result_crypto_revisions.updated_at",
  "public.task_runs.funding_binding",
  "public.task_runs.funding_predecessor_run_id",
  "public.task_runs.result_content_namespace_id",
  "public.task_runs.result_crypto_access_revision",
  "public.task_runs.result_crypto_mapping_state",
  "public.task_runs.result_crypto_object_id",
  "public.task_runs.result_crypto_required_namespace_fingerprint",
  "public.task_runs.result_representation",
  "public.task_runs.result_revision",
  "public.task_terminal_message_crypto_staging_receipts",
  "public.task_terminal_message_crypto_staging_receipts.accepted_policy_revision",
  "public.task_terminal_message_crypto_staging_receipts.authority_fingerprint",
  "public.task_terminal_message_crypto_staging_receipts.authorization_digest",
  "public.task_terminal_message_crypto_staging_receipts.claim_id",
  "public.task_terminal_message_crypto_staging_receipts.crypto_object_id",
  "public.task_terminal_message_crypto_staging_receipts.delivery_intent_hash",
  "public.task_terminal_message_crypto_staging_receipts.genesis_manifest_hash",
  "public.task_terminal_message_crypto_staging_receipts.publication_policy_revision",
  "public.task_terminal_message_crypto_staging_receipts.raw_result_message_intent",
  "public.task_terminal_message_crypto_staging_receipts.recipient_generation",
  "public.task_terminal_message_crypto_staging_receipts.request_id",
  "public.task_terminal_message_crypto_staging_receipts.staged_at",
  "public.tasks.content_namespace_id",
  "public.tasks.content_representation",
  "public.tasks.content_revision",
  "public.tasks.crypto_access_revision",
  "public.tasks.crypto_mapping_state",
  "public.tasks.crypto_object_id",
  "public.tasks.crypto_required_namespace_fingerprint",
  "public.tasks.funding_mode",
  "public.tasks.local_execution_delegation",
  "public.tasks.ordinary_fallback_completed_at",
  "public.tasks.ordinary_fallback_operation_id",
  "public.tasks.ordinary_fallback_policy_revision",
  "public.tasks.ordinary_fallback_reason",
  "public.tasks.ordinary_fallback_request_digest",
  "public.tasks.pause_reason",
  "public.tasks.pause_request_id",
  "public.tasks.pause_requested_at",
] as const;

/** Exact mechanically inventoried database writers added by Task protection. */
export const REVIEWED_TASK_PROTECTION_DATABASE_WRITER_LOCATORS = [
  "packages/db/src/queries/protected-task-cancellation-output.ts#prepareProtectedTaskCancellationOutput:insert:public.protected_task_run_output_bindings:1",
  "packages/db/src/queries/protected-task-cancellation-output.ts#prepareProtectedTaskCancellationOutput:update:public.protected_task_run_output_bindings:1",
  "packages/db/src/queries/protected-task-cancellation-output.ts#prepareProtectedTaskCancellationOutput:update:public.protected_task_run_output_bindings:2",
  "packages/db/src/queries/protected-task-cancellation-output.ts#publishProtectedTaskCancellationProduct:update:public.task_runs:1",
  "packages/db/src/queries/protected-task-cancellation-output.ts#settleProtectedTaskCancellationOutput:update:public.protected_task_run_output_bindings:1",
  "packages/db/src/queries/protected-task-checkpoint-pause.ts#finalizeProtectedTaskCheckpointPause:update:public.tasks:1",
  "packages/db/src/queries/protected-task-checkpoint-pause.ts#requestProtectedTaskCheckpointPause:update:public.tasks:1",
  "packages/db/src/queries/protected-task-checkpoint-pause.ts#resumeProtectedTaskCheckpointPause:update:public.tasks:1",
  "packages/db/src/queries/protected-task-funding.ts#bindProtectedTaskRunFunding:update:public.task_runs:1",
  "packages/db/src/queries/protected-task-output-wake.ts#claimProtectedTaskWakeJob:update:public.jobs:1",
  "packages/db/src/queries/protected-task-output-wake.ts#insertOrAdoptProtectedTaskWakeJob:insert:public.jobs:1",
  "packages/db/src/queries/protected-task-output-wake.ts#insertOrAdoptProtectedTaskWakeJob:update:public.protected_task_run_output_bindings:1",
  "packages/db/src/queries/protected-task-output-wake.ts#settleProtectedTaskWakeJob:update:public.jobs:1",
  "packages/db/src/queries/protected-task-parked-preexecution.ts#recoverUnstartedParkedProtectedTaskRun:update:public.jobs:2",
  "packages/db/src/queries/protected-task-running-recovery.ts#settleAbandonedProtectedTaskRun:update:public.jobs:1",
  "packages/db/src/queries/protected-task-running-recovery.ts#settleAbandonedProtectedTaskRun:update:public.task_runs:1",
  "packages/db/src/queries/protected-task-running-recovery.ts#settleAbandonedProtectedTaskRun:update:public.tasks:1",
  "packages/db/src/queries/protected-task-wake-continuation.ts#parkProtectedTaskWakeContinuation:insert:public.protected_task_wake_continuation_receipts:1",
  "packages/db/src/queries/protected-task-wake-continuation.ts#parkProtectedTaskWakeContinuation:update:public.jobs:1",
  "packages/db/src/queries/task-content-backfill.ts#acknowledgeTaskContentBackfill:delete:public.task_content_backfill_failures:1",
  "packages/db/src/queries/task-content-backfill.ts#acknowledgeTaskContentBackfill:update:public.task_content_backfill_scans:1",
  "packages/db/src/queries/task-content-backfill.ts#claimTaskContentBackfill:update:public.task_content_backfill_scans:1",
  "packages/db/src/queries/task-content-backfill.ts#discoverTaskContentBackfill:delete:public.task_content_backfill_failures:1",
  "packages/db/src/queries/task-content-backfill.ts#discoverTaskContentBackfill:insert:public.task_content_backfill_scans:1",
  "packages/db/src/queries/task-content-backfill.ts#discoverTaskContentBackfill:update:public.task_content_backfill_scans:1",
  "packages/db/src/queries/task-content-backfill.ts#discoverTaskContentBackfill:update:public.task_content_backfill_scans:2",
  "packages/db/src/queries/task-content-backfill.ts#discoverTaskContentBackfill:update:public.task_content_backfill_scans:3",
  "packages/db/src/queries/task-content-backfill.ts#discoverTaskContentBackfill:update:public.task_content_backfill_scans:4",
  "packages/db/src/queries/task-content-backfill.ts#discoverTaskContentBackfill:update:public.task_content_backfill_scans:5",
  "packages/db/src/queries/task-content-backfill.ts#discoverTaskContentBackfill:update:public.task_content_backfill_scans:6",
  "packages/db/src/queries/task-content-backfill.ts#discoverTaskContentBackfill:update:public.task_content_backfill_scans:7",
  "packages/db/src/queries/task-content-backfill.ts#discoverTaskContentBackfill:update:public.task_content_backfill_scans:8",
  "packages/db/src/queries/task-content-backfill.ts#releaseTaskContentBackfillLease:update:public.task_content_backfill_scans:1",
  "packages/db/src/queries/task-content-backfill.ts#renewTaskContentBackfillLease:update:public.task_content_backfill_scans:1",
  "packages/db/src/queries/task-content-backfill.ts#setHighWater:update:public.task_content_backfill_scans:1",
  "packages/db/src/queries/task-content-backfill.ts#setHighWater:update:public.task_content_backfill_scans:2",
  "packages/db/src/queries/task-content-backfill.ts#setHighWater:update:public.task_content_backfill_scans:3",
  "packages/db/src/queries/task-content-backfill.ts#upsertFailure:insert:public.task_content_backfill_failures:1",
  "packages/db/src/queries/tasks.ts#acceptProtectedTaskHumanContinuation:update:public.jobs:1",
  "packages/db/src/queries/tasks.ts#sealProtectedTaskHumanApprovalPolicy:update:public.jobs:1",
  "packages/db/src/queries/tasks.ts#transitionProtectedTaskLifecycleStop:insert:public.task_runs:1",
  "packages/db/src/queries/tasks.ts#transitionProtectedTaskLifecycleStop:update:public.task_runs:1",
  "packages/db/src/queries/tasks.ts#transitionProtectedTaskLifecycleStop:update:public.tasks:1",
  "packages/db/src/utils/strict-shadow-boundary-health.ts#retireLegacyUnsupportedTaskObserverHealth:delete:public.encryption_transition_boundary_health:1",
  "packages/lattice-bridge/src/server/memory/postgres-foreground-memory-publication.ts#persist:insert:public.foreground_memory_crypto_publication_receipts:1",
  "packages/lattice-bridge/src/server/task/postgres-task-content-product-store.ts##mapDefinition:update:public.tasks:2",
  "packages/lattice-bridge/src/server/task/postgres-task-content-product-store.ts##mapResult:update:public.task_runs:2",
  "packages/lattice-bridge/src/server/task/postgres-task-cancellation-crypto-staging.ts#stageNativeTaskCancellationPublication:insert:public.task_cancellation_crypto_staging_receipts:1",
  "packages/lattice-bridge/src/server/task/postgres-task-historical-content-staging.ts#stageHistoricalTaskContentPublication:insert:public.task_historical_content_crypto_staging_receipts:1",
  "packages/lattice-bridge/src/server/task/postgres-task-run-result-message-staging.ts#stageNativeTaskRunResultMessagePublication:insert:public.task_terminal_message_crypto_staging_receipts:1",
  "packages/lattice-bridge/src/server/task/postgres-task-terminal-message-staging.ts#stageNativeTaskTerminalMessagePublication:insert:public.task_terminal_message_crypto_staging_receipts:1",
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts#parkTaskWakeForAdditionalAuthority:delete:public.background_crypto_authorization_domain_requirements:1",
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts#parkTaskWakeForAdditionalAuthority:delete:public.background_crypto_authorization_namespace_requirements:1",
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts#parkTaskWakeForAdditionalAuthority:update:public.background_crypto_authorization_requests:1",
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts#renewParkedTaskWakeRecipient:delete:public.background_crypto_authorization_domain_requirements:1",
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts#renewParkedTaskWakeRecipient:delete:public.background_crypto_authorization_namespace_requirements:1",
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts#renewParkedTaskWakeRecipient:update:public.background_crypto_authorization_requests:1",
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts##replaceUnclaimedAuthority:delete:public.background_crypto_authorization_domain_requirements:1",
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts##replaceUnclaimedAuthority:delete:public.background_crypto_authorization_namespace_requirements:1",
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts##replaceUnclaimedAuthority:update:public.background_crypto_authorization_requests:1",
  "packages/server/src/routes/protected-task-foreground-creation-publication.ts#use:insert:public.tasks:1",
  "packages/server/src/routes/protected-task-foreground-creation-publication.ts#use:insert:public.tasks:2",
  "packages/server/src/routes/task-ordinary-fallback-composition.ts#dual:update:public.tasks:1",
  "packages/server/src/routes/protected-task-output-read-product.ts#loadForegroundState:insert:public.sessions:1",
  "packages/server/src/routes/protected-task-native-transcript-composition.ts#admitTranscript:insert:public.sessions:1",
  "packages/server/src/routes/protected-task-terminal-message-product.ts#refreshUnstagedProtectedTaskTerminalMessagePolicy:update:public.session_message_crypto_revisions:1",
  "packages/server/src/routes/protected-task-terminal-message-product.ts#resolveProtectedTaskTerminalMessageDestination:insert:public.sessions:1",
] as const;

/** Exact predecessor locators replaced by current Task continuation and shared
 * background-authorization writers. */
export const SUPERSEDED_TASK_PROTECTION_DATABASE_WRITER_LOCATORS = [
  "packages/db/src/queries/tasks.ts#acceptProtectedTaskAwaitReply:update:public.jobs:1",
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts#replaceUnclaimedTaskRuntimeAuthority:delete:public.background_crypto_authorization_domain_requirements:1",
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts#replaceUnclaimedTaskRuntimeAuthority:delete:public.background_crypto_authorization_namespace_requirements:1",
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts#replaceUnclaimedTaskRuntimeAuthority:update:public.background_crypto_authorization_requests:1",
] as const;
const TASK_PROTECTION_BOUNDED_WIRE_LOCATORS = [
  "http:request_response:GET /api/protected/tasks",
  "http:request_response:GET /api/tasks/content/backfill/progress",
  "http:request_response:POST /api/tasks/content/backfill/ack",
  "http:request_response:POST /api/tasks/content/backfill/claim",
  "http:request_response:POST /api/tasks/content/backfill/discover",
  "http:request_response:POST /api/tasks/content/backfill/recover",
  "http:request_response:POST /api/tasks/content/backfill/release",
] as const;
const TASK_PROTECTION_PROTECTED_WIRE_LOCATORS = [
  "http:request_response:GET /api/protected/tasks/:taskId/definition",
  "http:request_response:GET /api/protected/tasks/:taskId/runs/:taskRunId/result",
  "http:request_response:PATCH /api/protected/tasks/:taskId/publication",
  "http:request_response:POST /api/protected/tasks/publication",
  "http:request_response:POST /api/protected/tasks/publication-plan",
  "http:request_response:POST /api/tasks/:taskId/runs/:taskRunId/transcript-v1",
  "http:request_response:POST /api/tasks/:taskId/runs/:taskRunId/transcript-v1#request.body",
  "http:request_response:POST /api/tasks/content/backfill/publish",
  "http:request_response:POST /api/tasks/content/backfill/source",
  "http:request_response:POST /api/tasks/pending-attention",
  "http:request_response:POST /api/tasks/pending-attention/read",
  "http:request_response:POST /api/tasks/pending-attention/read#response.body.events[].tools[].args",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/task-definition/authorize",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/task-definition/authorize#request.body",
  "ws:server_to_client:message.task_definition_authorization_required",
] as const;

function databaseReason(locator: string): string {
  if (locator.includes("foreground_memory_crypto_publication_receipts")) {
    return "The immutable crypto-role receipt retains only a Memory operation, object, Memory and Agent identifier; a positive content revision; a staging timestamp; and three 32-byte commitments. It stores no Memory content, ciphertext, envelope, prompt, result, transcript, private key, recipient key or signed request bytes.";
  }
  if (locator.endsWith(".signed_publication_request_bytes")) {
    return "The retained signed request is the schema-bounded public publication statement: coordinates, digests, revisions and signer evidence only. The encrypted Task payload remains in canonical crypto storage.";
  }
  if (locator.includes("public.tasks.ordinary_fallback_")) {
    return "This field is one component of the coherent signed Shadow fallback receipt: an operation identifier, fixed 32-byte authenticated request digest, closed reason, positive policy revision, or completion timestamp. It does not duplicate the ordinary Task definition stored elsewhere on the owning Task row.";
  }
  if (locator.endsWith(".raw_result_message_intent")) {
    return "The nullable recovery intent is accepted only after exact decoding as the fixed terminal Task Message coordinates and delivery policy. It cannot contain an authored prompt, result, tool payload, credential or key.";
  }
  if (locator.endsWith(".historical_repair")) {
    return "The schema closes this repair provenance to version, claim and device identifiers plus fixed digests and source revision zero; it stores no historical Task payload or ciphertext.";
  }
  if (locator.endsWith(".operational_metadata")) {
    return "The Task definition product store validates this object as the closed operational Task fields used to reproduce the encrypted definition mapping; prompt and expected-output bytes remain in canonical crypto storage.";
  }
  if (locator.endsWith(".claim")) {
    return "The scan claim is schema- and service-validated content-free repair coordination containing only Task coordinates, source lifecycle facts, policy revision, and lease authority.";
  }
  if (locator.includes(".protected_task_wake_continuation_receipts")) {
    return "The immutable wake continuation receipt contains only Task, Run, Job, authorization, Namespace and checkpoint coordinates; closed semantic requirements; counts; revisions; timestamps; and 32-byte digests. It stores no prompt, result, transcript, checkpoint payload, private key or recipient key material.";
  }
  if (locator.endsWith(".local_execution_delegation") || locator.endsWith(".funding_binding")) {
    return "This signed execution or funding binding contains closed actor, Task, provider and authority coordinates. It carries no prompt, result, transcript, credential secret or key material.";
  }
  return "The exact Task field is a closed identifier, revision, digest, timestamp, lease coordinate, lifecycle enum, funding coordinate, or publication receipt. Task prompts, results, transcripts, ciphertext and key material are stored outside this plaintext metadata row.";
}

function bridgeRepositoryFor(locator: string): string {
  if (locator.includes("/live-shadow/task-definition/")
    || locator === "ws:server_to_client:message.task_definition_authorization_required") {
    return "packages/lattice-crypto/src/format/domain-foreground-authorization-v2.ts";
  }
  if (locator.includes("/pending-attention")) {
    return "packages/lattice-bridge/src/server/task/native-task-runtime-checkpoint-cell-crypto.ts";
  }
  if (locator.includes("/transcript-v1")) {
    return "packages/lattice-bridge/src/server/message/postgres-room-history-shadow-projection.ts";
  }
  if (locator.includes("/backfill/")) {
    return "packages/lattice-bridge/src/server/task/postgres-task-historical-content-staging.ts";
  }
  return "packages/lattice-bridge/src/server/task/task-content-repository-composition.ts";
}

function protectedRouteEvidenceFor(locator: string): readonly string[] {
  return locator.includes("/live-shadow/task-definition/")
      || locator === "ws:server_to_client:message.task_definition_authorization_required"
    ? TASK_DEFINITION_AUTHORIZATION_EVIDENCE
    : PROTECTED_ROUTE_EVIDENCE;
}

function protectedRouteMigrationState(locator: string): "ciphertext_reading" | "shadow" {
  return locator.includes("/live-shadow/task-definition/")
      || locator === "ws:server_to_client:message.task_definition_authorization_required"
    ? "shadow"
    : "ciphertext_reading";
}

function protectedRouteKeyFamily(locator: string): "agent_runtime" | "namespace_ai" {
  return locator.includes("/live-shadow/task-definition/")
      || locator === "ws:server_to_client:message.task_definition_authorization_required"
    ? "agent_runtime"
    : "namespace_ai";
}

export const REVIEWED_TASK_PROTECTION_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
  ...TASK_PROTECTION_DATABASE_LOCATORS.map((locator, index) => ({
    id: `db.task-protection.metadata.${index + 1}`,
    surface: "db" as const,
    locator,
    owner: "packages/db",
    readers: ["packages/db", "packages/server", "packages/lattice-bridge"],
    writers: ["packages/db", "packages/server", "packages/lattice-bridge"],
    migrationState: "not_applicable" as const,
    retention: "Retained with the owning Task, TaskRun, authorization request, publication receipt, or bounded repair lifecycle.",
    testEvidence: DB_SCHEMA_EVIDENCE,
    classification: "bounded_metadata" as const,
    metadataAllowlist: [locator],
    plaintextReason: databaseReason(locator),
  })),
  ...TASK_PROTECTION_BOUNDED_WIRE_LOCATORS.map((locator, index) => ({
    id: `wire.task-protection.metadata.${index + 1}`,
    surface: "wire" as const,
    locator,
    owner: "packages/server",
    readers: ["packages/api-client", "packages/lattice-bridge"],
    writers: ["packages/server"],
    migrationState: "not_applicable" as const,
    retention: "Authenticated private no-store request lifetime only; clients retain only current repair or publication coordination while the operation is active.",
    testEvidence: PROTECTED_ROUTE_EVIDENCE,
    classification: "bounded_metadata" as const,
    metadataAllowlist: [locator],
    plaintextReason: "This exact route carries only closed Task coordinates, lifecycle states, counters, policy revisions, digests, or publication authority. It carries no prompt, result, transcript, tool payload, credential or key material.",
  })),
  ...TASK_PROTECTION_PROTECTED_WIRE_LOCATORS.map((locator, index) => ({
    id: `wire.task-protection.protected.${index + 1}`,
    surface: "wire" as const,
    locator,
    owner: "packages/server",
    readers: ["packages/api-client", "packages/lattice-bridge"],
    writers: ["packages/server"],
    migrationState: protectedRouteMigrationState(locator),
    retention: "Authenticated private no-store request lifetime only; payload bytes are wiped or released by the bounded client and server operation after use.",
    testEvidence: protectedRouteEvidenceFor(locator),
    classification: "protected" as const,
    keyFamily: protectedRouteKeyFamily(locator),
    bridgeRepository: bridgeRepositoryFor(locator),
    negativeTestEvidence: protectedRouteEvidenceFor(locator),
  })),
];

const CONTENT_ROUTE_DEBT = [
  ["http:request_response:GET /api/tasks/:id/content-v1", "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"],
  ["http:request_response:GET /api/tasks/:id/content-v1#response.body.runs[].content.transcript[].toolCalls[].args", "debt.wire.arbitrary.19ijf0o"],
  ["http:request_response:GET /api/tasks/content-v1", "debt.wire.http.request.response.get.api.tasks.1veo2i8"],
] as const;

const ORDINARY_FALLBACK_ROUTE_DEBT = [
  ["http:request_response:POST /api/protected/tasks/ordinary-fallback-plan", "debt.wire.http.request.response.post.api.tasks.1o4qxxy"],
  ["http:request_response:POST /api/protected/tasks/ordinary-fallback", "debt.wire.http.request.response.post.api.tasks.1o4qxxy"],
  ["http:request_response:POST /api/protected/tasks/:taskId/ordinary-fallback-plan", "debt.wire.http.request.response.patch.api.tasks.id.1conpo2"],
  ["http:request_response:PATCH /api/protected/tasks/:taskId/ordinary-fallback", "debt.wire.http.request.response.patch.api.tasks.id.1conpo2"],
] as const;

const TASK_UPDATE_PLAN_ROUTE_DEBT = [
  ["http:request_response:POST /api/protected/tasks/:taskId/publication-plan", "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"],
] as const;

export const REVIEWED_TASK_PROTECTION_DEBT_LINKS: readonly ReviewedDebtLink[] = [
  ...CONTENT_ROUTE_DEBT.map(([locator, targetDebtId], index) => ({
    id: `wire.task-protection.existing-content-debt.${index + 1}`,
    surface: "wire" as const,
    locator,
    owner: "packages/server",
    targetDebtIds: [targetDebtId],
    reason: "The mixed ordinary Task content projection can carry the same prompt, result, transcript, error, or tool-argument material already frozen at the established Task transport boundary. Protected rows remain opaque, but this route is not independently reclassified as metadata.",
    testEvidence: [
      ...EVIDENCE,
      "packages/server/tests/unit-isolated/task-content-detail-policy.test.ts",
    ],
  })),
  ...ORDINARY_FALLBACK_ROUTE_DEBT.map(([locator, targetDebtId], index) => ({
    id: `wire.task-protection.existing-ordinary-fallback-debt.${index + 1}`,
    surface: "wire" as const,
    locator,
    owner: "packages/server",
    targetDebtIds: [targetDebtId],
    reason: "The signed Shadow fallback route carries the ordinary Task definition already frozen at the established create or update transport boundary. Its plan binds the same source and publication coordinates but does not reclassify those definition bytes as metadata.",
    testEvidence: TASK_ORDINARY_FALLBACK_EVIDENCE,
  })),
  ...TASK_UPDATE_PLAN_ROUTE_DEBT.map(([locator, targetDebtId], index) => ({
    id: `wire.task-protection.existing-update-plan-debt.${index + 1}`,
    surface: "wire" as const,
    locator,
    owner: "packages/server",
    targetDebtIds: [targetDebtId],
    reason: "In Shadow mode this signed update plan can include the complete current ordinary Task definition for exact repair. Full and Plain omit that optional source, but the route as a whole cannot be classified as protected or metadata.",
    testEvidence: [
      ...EVIDENCE,
      "packages/api-client/tests/unit/protected-task-schema.test.ts",
      "packages/server/tests/unit-isolated/task-protected-composition.test.ts",
      "packages/server/tests/unit-isolated/task-protected-routes.test.ts",
    ],
  })),
];
