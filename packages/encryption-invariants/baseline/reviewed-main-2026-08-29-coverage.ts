import type { EncryptionCoverageEntry } from "../src/model";
import type { ReviewedDebtLink } from "../src/registry";

const REVIEW_EVIDENCE = "packages/encryption-invariants/tests/integration/reviewed-main-2026-08-29-security.test.ts";
const CRYPTO_EVIDENCE = [
  REVIEW_EVIDENCE,
  "packages/db/tests/unit/domain-key-authority-schema.test.ts",
  "packages/db/tests/unit/migration-0229-m306-retire-legacy-authority.test.ts",
  "packages/lattice-bridge/tests/unit/native-v2-production-authority-source-guard.test.ts",
  "packages/lattice-bridge/tests/unit/human-peer-live-shadow-message.test.ts",
  "packages/lattice-bridge/tests/unit/shared-agent-live-shadow-message.test.ts",
] as const;
const OPERATOR_SECRET_EVIDENCE = [
  REVIEW_EVIDENCE,
  "packages/server/tests/unit/workstation-access-route.test.ts",
  "packages/server/tests/integration/admin-users-provision.integration.test.ts",
] as const;

const REVIEWED_CLASSIFICATIONS = [
  {
    "surface": "db",
    "locator": "packages/db/src/utils/encryption-transition-observations.ts#pruneHistoryReadAdmissionsInTransaction:raw_sql:delete:public.encryption_transition_history_read_admissions:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-grant-domain-authority.ts#acknowledgeEnvelope:raw_sql:insert:public.grant_domain_envelope_acknowledgements:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-grant-domain-authority.ts#activate:raw_sql:insert:public.grant_domain_heads:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-grant-domain-authority.ts#activate:raw_sql:insert:public.grant_domain_publication_operations:1",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-grant-domain-authority.ts#activate:raw_sql:insert:public.grant_domain_recipient_envelopes:1",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-grant-domain-authority.ts#activate:raw_sql:insert:public.namespace_grant_domain_bindings:1",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-grant-domain-authority.ts#activate:raw_sql:insert:public.namespace_grant_domain_heads:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-grant-domain-authority.ts#activate:raw_sql:update:public.grant_domain_heads:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-grant-domain-authority.ts#activate:raw_sql:update:public.grant_domain_publication_operations:1",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-grant-domain-authority.ts#activate:raw_sql:update:public.namespace_grant_domain_bindings:1",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-grant-domain-authority.ts#activate:raw_sql:update:public.namespace_grant_domain_heads:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-grant-domain-authority.ts#authorizeRecipientSynchronization:raw_sql:insert:public.grant_domain_recipient_authorization_operations:1",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-grant-domain-authority.ts#authorizeRecipientSynchronization:raw_sql:insert:public.grant_domain_recipient_envelopes:1",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-grant-domain-authority.ts#authorizeRecipientSynchronization:raw_sql:update:public.grant_domain_recipient_authorization_operations:1",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-grant-domain-authority.ts#authorizeRecipientSynchronization:raw_sql:update:public.grant_domain_recipient_sync_campaigns:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-grant-domain-authority.ts#planRecipientSynchronization:raw_sql:insert:public.grant_domain_recipient_sync_campaigns:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-grant-domain-authority.ts#updateDomainBindingProjection:raw_sql:update:public.grant_domain_heads:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-namespace-key-authority.ts#acknowledge:raw_sql:insert:public.namespace_key_envelope_acknowledgements:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-namespace-key-authority.ts#activatePublicationHeads:raw_sql:insert:public.namespace_key_generation_heads:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-namespace-key-authority.ts#activatePublicationHeads:raw_sql:update:public.namespace_key_generation_heads:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-namespace-key-authority.ts#authorizeRecipientSynchronization:raw_sql:insert:public.namespace_key_recipient_authorization_operations:1",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-namespace-key-authority.ts#authorizeRecipientSynchronization:raw_sql:insert:public.namespace_key_recipient_envelopes:1",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-namespace-key-authority.ts#authorizeRecipientSynchronization:raw_sql:update:public.namespace_key_recipient_authorization_operations:1",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-namespace-key-authority.ts#insertPublicationEnvelopes:raw_sql:insert:public.namespace_key_recipient_envelopes:1",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-namespace-key-authority.ts#publish:raw_sql:insert:public.namespace_key_publication_operations:1",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-namespace-key-authority.ts#publish:raw_sql:update:public.namespace_key_publication_operations:1",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-namespace-key-authority.ts#publish:raw_sql:update:public.namespace_key_publication_operations:2",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-namespace-key-authority.ts#reconcileReserved:raw_sql:update:public.namespace_key_publication_operations:1",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-namespace-key-authority.ts#reconcileReserved:raw_sql:update:public.namespace_key_recipient_authorization_operations:1",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-namespace-key-authority.ts#upsertRecipientSyncCampaign:raw_sql:insert:public.namespace_key_recipient_sync_campaigns:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-human-peer-live-shadow-plan.ts#acknowledge:raw_sql:insert:public.conversation_human_peer_shadow_acknowledgements:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-human-peer-live-shadow-plan.ts#ensureHumanSession:raw_sql:insert:public.sessions:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-human-peer-live-shadow-plan.ts#plan:raw_sql:insert:public.conversation_human_peer_shadow_operations:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-human-peer-live-shadow-plan.ts#plan:raw_sql:insert:public.conversation_human_peer_shadow_plan_attempts:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-human-peer-live-shadow-plan.ts#recordFallback:raw_sql:update:public.conversation_human_peer_shadow_operations:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-human-peer-live-shadow-plan.ts#recordPublished:raw_sql:update:public.conversation_human_peer_shadow_operations:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts##planDeviceWrapped:raw_sql:insert:public.conversation_shadow_turn_agent_signers:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts##planDeviceWrapped:raw_sql:insert:public.conversation_shadow_turn_operations:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts##planDeviceWrapped:raw_sql:update:public.conversation_shadow_turn_plan_attempts:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts##planForegroundSession:raw_sql:insert:public.conversation_shadow_turn_agent_signers:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts##planForegroundSession:raw_sql:insert:public.conversation_shadow_turn_operations:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts##planForegroundSession:raw_sql:update:public.conversation_shadow_turn_plan_attempts:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts##planForegroundSession:raw_sql:update:public.conversation_shared_agent_shadow_executions:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts##planForegroundSession:raw_sql:update:public.conversation_shared_agent_shadow_executions:2",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts##planGrantDomain:raw_sql:insert:public.conversation_shadow_turn_agent_signers:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts##planGrantDomain:raw_sql:insert:public.conversation_shadow_turn_operations:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts##planGrantDomain:raw_sql:update:public.conversation_shadow_turn_plan_attempts:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-shared-agent-live-shadow-plan.ts#acknowledge:raw_sql:insert:public.conversation_shared_agent_shadow_acknowledgements:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-shared-agent-live-shadow-plan.ts#acknowledgeExecutionOutput:raw_sql:insert:public.conversation_shared_agent_shadow_acknowledgements:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-shared-agent-live-shadow-plan.ts#ensureHumanSession:raw_sql:insert:public.sessions:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-shared-agent-live-shadow-plan.ts#plan:raw_sql:insert:public.conversation_shared_agent_shadow_operations:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-shared-agent-live-shadow-plan.ts#plan:raw_sql:insert:public.conversation_shared_agent_shadow_plan_attempts:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-shared-agent-live-shadow-plan.ts#reconcileExpired:raw_sql:update:public.conversation_shared_agent_shadow_executions:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-shared-agent-live-shadow-plan.ts#reconcileExpired:raw_sql:update:public.conversation_shared_agent_shadow_invocations:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-shared-agent-live-shadow-plan.ts#reconcileExpired:raw_sql:update:public.conversation_shared_agent_shadow_operations:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-shared-agent-live-shadow-plan.ts#recordConductorResolution:raw_sql:update:public.conversation_shared_agent_shadow_operations:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-shared-agent-live-shadow-plan.ts#recordExecutionUnavailable:raw_sql:update:public.conversation_shared_agent_shadow_executions:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-shared-agent-live-shadow-plan.ts#recordFallback:raw_sql:update:public.conversation_shared_agent_shadow_operations:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-shared-agent-live-shadow-plan.ts#recordProcessLoss:raw_sql:update:public.conversation_shared_agent_shadow_executions:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-shared-agent-live-shadow-plan.ts#recordProcessLoss:raw_sql:update:public.conversation_shared_agent_shadow_invocations:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-shared-agent-live-shadow-plan.ts#recordPublished:raw_sql:update:public.conversation_shared_agent_shadow_operations:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-shared-agent-live-shadow-plan.ts#recordUnavailablePlanAttempt:raw_sql:insert:public.conversation_shared_agent_shadow_plan_attempts:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-shared-agent-live-shadow-plan.ts#reserveExecution:raw_sql:insert:public.conversation_shared_agent_shadow_execution_inputs:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-shared-agent-live-shadow-plan.ts#reserveExecution:raw_sql:insert:public.conversation_shared_agent_shadow_executions:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-shared-agent-live-shadow-plan.ts#reserveExecution:raw_sql:insert:public.sessions:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/lattice-bridge/src/server/message/postgres-shared-agent-live-shadow-plan.ts#reserveExecution:raw_sql:update:public.conversation_shared_agent_shadow_operations:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/reflection-bridge/scripts/run-postgres-integration.ts#<module>:raw_sql:update:public.reflection_record_semantic_work:2",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/reflection-bridge/scripts/run-postgres-integration.ts#<module>:raw_sql:update:public.reflection_record_semantic_work:3",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/reflection-bridge/scripts/run-postgres-integration.ts#assertOrdinaryStenographerPublication:raw_sql:insert:public.namespaces:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/reflection-bridge/scripts/run-postgres-integration.ts#assertOrdinaryStenographerPublication:raw_sql:insert:public.room_journal_batches:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/reflection-bridge/scripts/run-postgres-integration.ts#assertOrdinaryStenographerPublication:raw_sql:insert:public.room_journal_batches:2",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/reflection-bridge/scripts/run-postgres-integration.ts#assertOrdinaryStenographerPublication:raw_sql:insert:public.room_journal_state:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/reflection-bridge/scripts/run-postgres-integration.ts#assertOrdinaryStenographerPublication:raw_sql:insert:public.room_members:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/reflection-bridge/scripts/run-postgres-integration.ts#assertOrdinaryStenographerPublication:raw_sql:insert:public.rooms:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/reflection-bridge/scripts/run-postgres-integration.ts#assertOrdinaryStenographerPublication:raw_sql:insert:public.session_messages:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/reflection-bridge/scripts/run-postgres-integration.ts#assertOrdinaryStenographerPublication:raw_sql:insert:public.session_messages:2",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/reflection-bridge/scripts/run-postgres-integration.ts#assertOrdinaryStenographerPublication:raw_sql:insert:public.sessions:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/reflection-bridge/scripts/run-postgres-integration.ts#assertOrdinaryStenographerPublication:raw_sql:update:public.reflection_records:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/reflection-bridge/scripts/run-postgres-integration.ts#assertOrdinaryStenographerPublication:raw_sql:update:public.room_events:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/reflection-bridge/scripts/run-postgres-integration.ts#assertOrdinaryStenographerPublication:raw_sql:update:public.room_journal_state:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/server/src/lib/user-account-deletion.ts#deleteLocalUserAccount:raw_sql:unresolved:unresolved.dynamic_sql:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/server/src/lib/user-account-deletion.ts#deleteLocalUserAccount:raw_sql:unresolved:unresolved.dynamic_sql:2",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "packages/server/src/routes/live-shadow-message-composition.ts#admitPreparedForeground:raw_sql:update:public.conversation_shared_agent_shadow_executions:1",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.claude_connections.catalog",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.claude_connections.created_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.claude_connections.enabled",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.claude_connections.observation_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.claude_connections.observed_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.claude_connections.profile_ref",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.claude_connections.runtime",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.claude_connections.selected_model",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.claude_connections.updated_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.content_reports.closed_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.content_reports.closed_by_user_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.content_reports.created_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.content_reports.id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.content_reports.reason",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.content_reports.status",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.content_reports.target_type",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_acknowledgements",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_acknowledgements.acknowledgement_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_acknowledgements.committer_device_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_acknowledgements.committer_device_signing_key_generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_acknowledgements.created_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_acknowledgements.deadline_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_acknowledgements.host_authorization_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_acknowledgements.issued_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_acknowledgements.operation_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_acknowledgements.reason",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_acknowledgements.sequence",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_acknowledgements.status",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_acknowledgements.subject_human_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.attempt_coordinate",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.client_idempotency_key",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.committer_device_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.committer_device_signing_key_generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.created_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.crypto_object_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.deadline_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.final_event_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.host_authorization_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.human_message_created_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.human_message_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.human_request_bytes",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.human_request_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.human_verified_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.namespace_access_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.namespace_audience_fingerprint",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.namespace_head_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.namespace_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.namespace_key_generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.namespace_publication_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.namespace_publication_set_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.operation_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.plan_bytes",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.plan_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.policy_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.protected_message_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.reconciliation_attempt_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.room_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.sequence",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.session_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.state",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.subject_human_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.terminal_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.terminal_reason",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.terminal_stage",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.transcript_ordinal",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_operations.updated_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_plan_attempts",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_plan_attempts.client_idempotency_key",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_plan_attempts.created_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_plan_attempts.operation_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_plan_attempts.policy_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_plan_attempts.room_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_plan_attempts.sequence",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_plan_attempts.session_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_plan_attempts.state",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_plan_attempts.subject_user_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_plan_attempts.unavailable_reason",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_human_peer_shadow_plan_attempts.updated_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shadow_turn_operations.agent_grant_plan_bytes",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shadow_turn_operations.agent_grant_plan_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shadow_turn_operations.committer_device_signing_key_generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shadow_turn_operations.grant_domain_authorization_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shadow_turn_operations.grant_domain_head_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shadow_turn_operations.grant_domain_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shadow_turn_operations.grant_domain_key_generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shadow_turn_operations.grant_domain_participant_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shadow_turn_operations.grant_domain_publication_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shadow_turn_operations.human_request_bytes",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shadow_turn_operations.namespace_audience_fingerprint",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shadow_turn_operations.namespace_authority_scheme",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shadow_turn_operations.namespace_bundle_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shadow_turn_operations.namespace_bundle_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shadow_turn_operations.namespace_head_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shadow_turn_operations.namespace_publication_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shadow_turn_operations.namespace_publication_set_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shadow_turn_operations.plan_bytes",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_acknowledgements",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_acknowledgements.acknowledgement_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_acknowledgements.author_role",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_acknowledgements.committer_device_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_acknowledgements.committer_device_signing_key_generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_acknowledgements.created_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_acknowledgements.deadline_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_acknowledgements.edit_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_acknowledgements.host_authorization_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_acknowledgements.issued_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_acknowledgements.message_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_acknowledgements.operation_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_acknowledgements.operation_kind",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_acknowledgements.reason",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_acknowledgements.sequence",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_acknowledgements.status",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_acknowledgements.subject_human_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_execution_inputs",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_execution_inputs.created_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_execution_inputs.execution_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_execution_inputs.human_operation_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_execution_inputs.input_ordinal",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_execution_inputs.message_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_execution_inputs.sequence",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.agent_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.agent_runtime_generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.agent_signer_key_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.agent_signer_public_key",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.authorization_device_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.authorization_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.authorization_disposition",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.authorization_plan_bytes",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.authorization_plan_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.authorization_session_reference",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.authorized_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.client_action_session_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.created_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.deadline_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.execution_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.execution_kind",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.final_causal_event_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.input_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.input_set_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.invocation_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.invoking_device_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.invoking_human_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.plan_bytes",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.plan_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.policy_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.recipient_key_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.room_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.sequence",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.session_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.state",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.terminal_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.terminal_reason",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_executions.updated_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.authorization_device_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.authorization_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.authorization_disposition",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.authorization_plan_bytes",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.authorization_plan_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.authorization_session_reference",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.authorized_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.client_action_session_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.created_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.deadline_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.input_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.input_set_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.invocation_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.invoking_device_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.invoking_human_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.policy_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.recipient_key_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.room_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.sequence",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.session_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.state",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.terminal_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.terminal_reason",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_invocations.updated_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.agent_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.attempt_coordinate",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.client_idempotency_key",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.committer_device_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.committer_device_signing_key_generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.conductor_reason",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.conductor_resolved_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.conductor_state",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.created_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.crypto_object_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.deadline_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.final_event_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.host_authorization_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.human_message_created_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.human_message_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.human_request_bytes",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.human_request_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.human_verified_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.namespace_access_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.namespace_audience_fingerprint",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.namespace_head_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.namespace_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.namespace_key_generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.namespace_publication_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.namespace_publication_set_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.operation_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.participant_human_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.plaintext_participant_human_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.plan_bytes",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.plan_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.policy_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.protected_message_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.protected_participant_human_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.protected_recipient_device_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.reconciliation_attempt_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.room_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.sequence",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.session_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.state",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.subject_human_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.terminal_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.terminal_reason",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.terminal_stage",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.transcript_ordinal",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_operations.updated_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_plan_attempts",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_plan_attempts.client_idempotency_key",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_plan_attempts.created_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_plan_attempts.operation_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_plan_attempts.policy_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_plan_attempts.room_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_plan_attempts.sequence",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_plan_attempts.session_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_plan_attempts.state",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_plan_attempts.subject_user_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_plan_attempts.unavailable_reason",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.conversation_shared_agent_shadow_plan_attempts.updated_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.acknowledgement_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.client_crypto_unavailable_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.client_custody_unavailable_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.client_observation_expired_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.client_request_key",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.consumption_kind",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.current_read_authority_unavailable_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.eligible_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.expires_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.host_authorization_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.integrity_failure_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.issued_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.live_shadow_lifecycle_unavailable_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.operation_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.ordered_result_set_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.parity_mismatch_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.policy_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.reader_device_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.reader_device_signing_key_generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.retained_key_material_unavailable_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.room_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.selected_coordinate_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.selected_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.signer_evidence_unavailable_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.state",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.subject_human_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.terminal_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.token_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.updated_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.encryption_transition_history_read_admissions.verified_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_envelope_acknowledgements",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_envelope_acknowledgements.acknowledged_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_envelope_acknowledgements.acknowledgement_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_envelope_acknowledgements.device_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_envelope_acknowledgements.device_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_envelope_acknowledgements.domain_key_generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_envelope_acknowledgements.envelope_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_envelope_acknowledgements.grant_domain_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_envelope_acknowledgements.head_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_envelope_acknowledgements.recipient_human_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_envelope_acknowledgements.recipient_key_generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_envelope_acknowledgements.recipient_key_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_heads",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_heads.activated_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_heads.authorization_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_heads.binding_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_heads.binding_set_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_heads.created_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_heads.domain_key_generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_heads.grant_domain_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_heads.head_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_heads.issuer_device_generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_heads.issuer_device_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_heads.participant_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_heads.participant_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_heads.participant_set_bytes",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_heads.previous_head_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_heads.publication_authorization_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_heads.publication_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_heads.publication_operation_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_heads.recipient_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_heads.recipient_set_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.activated_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.aggregate_envelope_bytes",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.authorization_revision",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.created_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.deadline_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.domain_key_generation",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.envelope_set_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.expected_previous_head_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.failure_code",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.grant_domain_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.head_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.idempotency_key",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.issuer_device_generation",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.issuer_device_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.issuer_human_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.operation_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.participant_count",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.participant_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.participant_set_bytes",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.publication_bytes",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.publication_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.recipient_count",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.recipient_set_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.state",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.terminal_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_publication_operations.updated_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.activated_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.authorization_bytes",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.authorization_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.authorization_revision",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.created_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.deadline_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.domain_key_generation",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.envelope_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.failure_code",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.grant_domain_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.head_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.idempotency_key",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.issuer_device_generation",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.issuer_device_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.issuer_human_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.operation_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.participant_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.recipient_device_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.recipient_human_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.recipient_key_generation",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.recipient_key_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.recipient_kind",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.recipient_public_key_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.recipient_recovery_generation",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.recipient_recovery_key_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.state",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.terminal_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_authorization_operations.updated_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_envelopes",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_envelopes.authorization_revision",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_envelopes.created_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_envelopes.domain_key_generation",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_envelopes.envelope_bytes",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_envelopes.envelope_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_envelopes.grant_domain_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_envelopes.head_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_envelopes.issuer_device_generation",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_envelopes.issuer_device_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_envelopes.issuer_signature",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_envelopes.participant_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_envelopes.publication_operation_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_envelopes.recipient_authorization_operation_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_envelopes.recipient_device_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_envelopes.recipient_human_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_envelopes.recipient_key_generation",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_envelopes.recipient_key_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_envelopes.recipient_kind",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_envelopes.recipient_public_key_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_envelopes.recipient_recovery_generation",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_envelopes.recipient_recovery_key_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_sync_campaigns",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_sync_campaigns.campaign_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_sync_campaigns.covered_envelope_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_sync_campaigns.created_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_sync_campaigns.domain_key_generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_sync_campaigns.grant_domain_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_sync_campaigns.participant_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_sync_campaigns.reason",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_sync_campaigns.recipient_device_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_sync_campaigns.recipient_human_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_sync_campaigns.recipient_key_generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_sync_campaigns.recipient_key_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_sync_campaigns.recipient_kind",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_sync_campaigns.recipient_public_key_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_sync_campaigns.recipient_recovery_generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_sync_campaigns.recipient_recovery_key_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_sync_campaigns.required_envelope_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_sync_campaigns.state",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_sync_campaigns.terminal_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.grant_domain_recipient_sync_campaigns.updated_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.human_blocks.created_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.mobile_user_agreement_acceptances.accepted_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.mobile_user_agreement_acceptances.agreement_version",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.mobile_user_agreement_acceptances.id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.mobile_user_agreement_acceptances.policy_version",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.mobile_user_agreement_acceptances.recipient_manifest_version",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.mobile_user_agreement_acceptances.withdrawn_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.activated_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.binding_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.bundle_bytes",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.bundle_ciphertext_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.bundle_plaintext_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.bundle_revision",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.created_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.deadline_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.failure_code",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.idempotency_key",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.issuer_device_generation",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.issuer_device_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.issuer_human_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.namespace_access_revision",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.namespace_ai_generation",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.namespace_ai_head_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.namespace_audience_fingerprint",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.namespace_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.operation_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.previous_binding_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.retained_generation_count",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.source_grant_domain_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.state",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.target_domain_authorization_revision",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.target_domain_head_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.target_domain_key_generation",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.target_grant_domain_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.target_participant_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.terminal_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_bindings.updated_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_heads",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_heads.activated_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_heads.binding_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_heads.binding_operation_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_heads.bundle_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_heads.created_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_heads.domain_authorization_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_heads.domain_head_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_heads.domain_key_generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_heads.grant_domain_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_heads.namespace_access_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_heads.namespace_audience_fingerprint",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_heads.namespace_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_grant_domain_heads.participant_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_envelope_acknowledgements",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_envelope_acknowledgements.acknowledged_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_envelope_acknowledgements.acknowledgement_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_envelope_acknowledgements.device_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_envelope_acknowledgements.device_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_envelope_acknowledgements.envelope_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_envelope_acknowledgements.generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_envelope_acknowledgements.head_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_envelope_acknowledgements.key_class",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_envelope_acknowledgements.namespace_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_envelope_acknowledgements.recipient_human_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_envelope_acknowledgements.recipient_key_generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_envelope_acknowledgements.recipient_key_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_envelope_acknowledgements.recipient_kind",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_generation_heads",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_generation_heads.access_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_generation_heads.activated_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_generation_heads.audience_fingerprint",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_generation_heads.created_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_generation_heads.generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_generation_heads.generation_key_commitment",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_generation_heads.head_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_generation_heads.issuer_device_generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_generation_heads.issuer_device_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_generation_heads.key_class",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_generation_heads.namespace_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_generation_heads.previous_head_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_generation_heads.publication_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_generation_heads.publication_operation_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations.activated_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations.aggregate_envelope_bytes",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations.created_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations.deadline_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations.envelope_row_count",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations.envelope_set_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations.expected_access_revision",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations.expected_ai_predecessor_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations.expected_audience_fingerprint",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations.expected_human_predecessor_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations.failure_code",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations.idempotency_key",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations.issuer_device_generation",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations.issuer_device_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations.issuer_human_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations.namespace_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations.operation_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations.publication_bytes",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations.publication_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations.state",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations.terminal_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_publication_operations.updated_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.activated_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.aggregate_envelope_bytes",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.authorization_bytes",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.authorization_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.created_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.current_access_revision",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.current_audience_fingerprint",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.deadline_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.entry_count",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.failure_code",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.idempotency_key",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.issuer_device_generation",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.issuer_device_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.issuer_human_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.namespace_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.operation_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.recipient_device_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.recipient_human_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.recipient_key_generation",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.recipient_key_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.recipient_kind",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.recipient_public_key_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.recipient_recovery_generation",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.recipient_recovery_key_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.state",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.terminal_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_authorization_operations.updated_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.access_revision",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.audience_fingerprint",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.created_at",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.envelope_bytes",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.envelope_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.generation",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.generation_key_commitment",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.head_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.issuer_device_generation",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.issuer_device_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.issuer_signature",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.key_class",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.namespace_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.publication_operation_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.recipient_authorization_operation_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.recipient_device_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.recipient_human_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.recipient_key_generation",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.recipient_key_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.recipient_kind",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.recipient_public_key_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.recipient_recovery_generation",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.recipient_recovery_key_id",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.source_publication_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_envelopes.source_publication_set_digest",
    "classification": "protected"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_sync_campaigns",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_sync_campaigns.campaign_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_sync_campaigns.covered_generation_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_sync_campaigns.created_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_sync_campaigns.current_access_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_sync_campaigns.current_audience_fingerprint",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_sync_campaigns.namespace_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_sync_campaigns.reason",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_sync_campaigns.recipient_device_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_sync_campaigns.recipient_human_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_sync_campaigns.recipient_key_generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_sync_campaigns.recipient_key_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_sync_campaigns.recipient_kind",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_sync_campaigns.recipient_public_key_digest",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_sync_campaigns.recipient_recovery_generation",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_sync_campaigns.recipient_recovery_key_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_sync_campaigns.required_generation_count",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_sync_campaigns.state",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_sync_campaigns.terminal_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.namespace_key_recipient_sync_campaigns.updated_at",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.rooms.namespace_access_revision",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.session_message_crypto_revisions.human_peer_shadow_operation_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.session_message_crypto_revisions.shared_agent_shadow_execution_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "db",
    "locator": "public.session_message_crypto_revisions.shared_agent_shadow_operation_id",
    "classification": "bounded_metadata"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:DELETE /api/live-shadow/foreground-authorization-sessions",
    "classification": "bounded_metadata"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:DELETE /api/mobile-user-agreement",
    "classification": "bounded_metadata"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:GET /api/mobile-user-agreement",
    "classification": "bounded_metadata"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:GET /api/rooms/:id/messages#response.body.shadowEncryption",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:GET /api/security/uncontained-host-commands/session",
    "classification": "bounded_metadata"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/admin/users/provision#request.body.permanentCredential",
    "classification": "operator_secret"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/claude-connections/check",
    "classification": "bounded_metadata"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/claude-connections/model",
    "classification": "bounded_metadata"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/claude-connections/toggle",
    "classification": "bounded_metadata"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:id/messages/shadow-read/:operationId/ack",
    "classification": "bounded_metadata"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:id/messages/shadow-read/:operationId/ack#request.body",
    "classification": "bounded_metadata"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/grant-domain/:grantDomainId/acknowledge",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/grant-domain/:grantDomainId/fetch",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/grant-domain/:namespaceId/bundle/plan",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/grant-domain/:namespaceId/bundle/publish",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/grant-domain/:namespaceId/plan",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/grant-domain/:namespaceId/publish",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/grant-domain/:namespaceId/recipient-sync/authorize",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/grant-domain/:namespaceId/recipient-sync/plan",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/human-peer/:operationId/ack",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/human-peer/:operationId/ack#request.body",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/human-peer/:operationId/ack-plan",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/human-peer/:operationId/ack-plan#request.body",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace-authority/:namespaceId/acknowledge",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace-authority/:namespaceId/acknowledge#request.body",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace-authority/:namespaceId/fetch",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace-authority/:namespaceId/fetch#request.body",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace-authority/:namespaceId/plan",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace-authority/:namespaceId/plan#request.body",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace-authority/:namespaceId/plan#response.body.classes[2]",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace-authority/:namespaceId/publish",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace-authority/:namespaceId/publish#request.body",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace-authority/:namespaceId/recipient-sync/authorize",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace-authority/:namespaceId/recipient-sync/authorize#request.body",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace-authority/:namespaceId/recipient-sync/plan",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace-authority/:namespaceId/recipient-sync/plan#request.body",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/runtime-invocation/:invocationId/authorize",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/runtime-invocation/:invocationId/authorize#request.body",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/shared-agent-output/:executionId/ack",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/shared-agent-output/:executionId/ack#request.body",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/shared-agent-output/:executionId/read-plan",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/shared-agent-output/:executionId/read-plan#request.body",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/shared-agent/:executionId/authorize",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/shared-agent/:executionId/authorize#request.body",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/shared-agent/:operationId/ack",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/shared-agent/:operationId/ack#request.body",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/shared-agent/:operationId/ack-plan",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/shared-agent/:operationId/ack-plan#request.body",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/security/uncontained-host-commands/activate",
    "classification": "operator_secret"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/security/uncontained-host-commands/activate#request.body.desktopSessionId",
    "classification": "operator_secret"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/security/uncontained-host-commands/activate#request.body.pin",
    "classification": "operator_secret"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/security/uncontained-host-commands/activate#request.body.relayId",
    "classification": "operator_secret"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/security/uncontained-host-commands/activate#response.body.error",
    "classification": "operator_secret"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/security/uncontained-host-commands/activate#response.body.retryAfterMs",
    "classification": "operator_secret"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/security/uncontained-host-commands/disable",
    "classification": "bounded_metadata"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/security/uncontained-host-commands/disable#request.body.desktopSessionId",
    "classification": "bounded_metadata"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/security/uncontained-host-commands/disable#request.body.relayId",
    "classification": "bounded_metadata"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/workstation-access/activate#request.body.pin",
    "classification": "operator_secret"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/workstation-access/activate#request.body.startupReceipt",
    "classification": "operator_secret"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/workstation-access/activate-profile#request.body.pin",
    "classification": "operator_secret"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/workstation-access/activate-profile#request.body.startupReceipt",
    "classification": "operator_secret"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:PUT /api/admin/users/:id/permanent-credentials",
    "classification": "operator_secret"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:PUT /api/admin/users/:id/permanent-credentials#request.body.password",
    "classification": "operator_secret"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:PUT /api/admin/users/:id/permanent-credentials#request.body.pin",
    "classification": "operator_secret"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:PUT /api/mobile-user-agreement",
    "classification": "bounded_metadata"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:PUT /api/mobile-user-agreement#request.body.agreementVersion",
    "classification": "bounded_metadata"
  },
  {
    "surface": "wire",
    "locator": "http:request_response:PUT /api/security/posture#request.body.allowUncontainedHostCommands",
    "classification": "bounded_metadata"
  },
  {
    "surface": "wire",
    "locator": "ws:server_to_client:message.human_peer_shadow",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "ws:server_to_client:message.runtime_invocation_authorization_required",
    "classification": "bounded_metadata"
  },
  {
    "surface": "wire",
    "locator": "ws:server_to_client:message.shared_agent_authorization_required",
    "classification": "bounded_metadata"
  },
  {
    "surface": "wire",
    "locator": "ws:server_to_client:message.shared_agent_output_shadow",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "ws:server_to_client:message.shared_agent_shadow",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "ws:server_to_client:message.shared_agent_stream_frame",
    "classification": "protected"
  },
  {
    "surface": "wire",
    "locator": "ws:server_to_client:message.shared_agent_stream_start",
    "classification": "protected"
  }
] as const;

function owner(locator: string, surface: string): string {
  if (surface === "wire") return "packages/server";
  if (locator.startsWith("public.")) return "packages/db";
  return locator.split("#")[0]!.split("/").slice(0, 2).join("/");
}

export const REVIEWED_MAIN_2026_08_29_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = REVIEWED_CLASSIFICATIONS.map((item, index) => {
  const common = {
    id: `main.2026-08-29.coverage.${index + 1}`,
    surface: item.surface,
    locator: item.locator,
    owner: owner(item.locator, item.surface),
    readers: item.surface === "wire" ? ["authenticated Nautilo clients", "packages/server"] : ["packages/server", "packages/lattice-bridge"],
    writers: item.surface === "wire" ? ["authenticated Nautilo clients", "packages/server"] : [owner(item.locator, item.surface)],
    migrationState: item.classification === "protected" ? "shadow" : "not_applicable",
    retention: item.classification === "protected"
      ? "Protected protocol bytes and their exact bounded authority coordinates are retained only by the owning shadow-encryption lifecycle."
      : "Bounded lifecycle, identity, policy, diagnostic, or delivery metadata follows the retention of its owning product operation and contains no free-form Human content.",
    testEvidence: item.classification === "protected" ? CRYPTO_EVIDENCE : item.classification === "operator_secret" ? OPERATOR_SECRET_EVIDENCE : [REVIEW_EVIDENCE],
  } as const;
  if (item.classification === "protected") {
    const keyFamily = item.locator.includes("shared_agent") || item.locator.includes("shared-agent")
      ? "namespace_ai"
      : item.locator.includes("runtime-invocation")
      ? "agent_runtime"
      : "namespace_human";
    return {
      ...common,
      classification: "protected",
      keyFamily,
      bridgeRepository: "packages/lattice-bridge",
      negativeTestEvidence: CRYPTO_EVIDENCE,
    };
  }
  if (item.classification === "operator_secret") {
    return {
      ...common,
      classification: "operator_secret",
      secretStoreLocation: "Authenticated request memory only; durable stores retain only verifier, authorization, or audit metadata and never the plaintext credential.",
      backupProcedure: "Not backed up from transport memory; the Human or operator must present or mint a fresh credential after loss or expiry.",
      excludedFromAgentGrants: true,
    };
  }
  return {
    ...common,
    classification: "bounded_metadata",
    metadataAllowlist: [
      "opaque entity and operation identifiers, fixed enums, counters, timestamps, public keys, hashes, signatures, lifecycle state, and bounded public catalog facts",
    ],
    plaintextReason: "The reviewed coordinate is structurally bounded to content-free control-plane metadata; credentials, private keys, plaintext Messages, prompts, files, and protected payload bytes are absent.",
  };
});

const REVIEWED_LINK_INPUTS = [
  {
    "locator": "public.content_reports",
    "targetDebtIds": [
      "debt.db.public.session_messages.content",
      "debt.db.public.session_messages.id",
      "debt.db.public.rooms.id",
      "debt.db.public.users.id",
      "debt.db.public.users.name",
      "debt.db.public.users.handle",
      "debt.db.public.message_attachments.filename",
      "debt.db.public.message_attachments.mime_type",
      "debt.db.public.message_attachments.size_bytes"
    ],
    "fields": [
      "reporter_user_id",
      "room_id",
      "target_message_id",
      "target_user_id",
      "comment",
      "preview_text",
      "preview_display_name",
      "preview_handle",
      "preview_attachments"
    ],
    "reason": "The moderation row is an exact bounded projection of already-frozen Message, Room, Human identity, and attachment-preview plaintext classes; it introduces no attachment bytes or independent content store.",
    "evidence": [
      "packages/server/tests/unit/content-reports-route.test.ts",
      "packages/types/tests/unit/content-reports.test.ts"
    ]
  },
  {
    "locator": "public.content_reports.reporter_user_id",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ],
    "fields": [
      "reporter_user_id"
    ],
    "reason": "The moderation reporter_user_id field is a bounded snapshot or coordinate of the corresponding already-frozen product plaintext class, retained so an administrator can resolve a report after its target changes or disappears.",
    "evidence": [
      "packages/server/tests/unit/content-reports-route.test.ts",
      "packages/types/tests/unit/content-reports.test.ts"
    ]
  },
  {
    "locator": "public.content_reports.room_id",
    "targetDebtIds": [
      "debt.db.public.rooms.id"
    ],
    "fields": [
      "room_id"
    ],
    "reason": "The moderation room_id field is a bounded snapshot or coordinate of the corresponding already-frozen product plaintext class, retained so an administrator can resolve a report after its target changes or disappears.",
    "evidence": [
      "packages/server/tests/unit/content-reports-route.test.ts",
      "packages/types/tests/unit/content-reports.test.ts"
    ]
  },
  {
    "locator": "public.content_reports.target_message_id",
    "targetDebtIds": [
      "debt.db.public.session_messages.id"
    ],
    "fields": [
      "target_message_id"
    ],
    "reason": "The moderation target_message_id field is a bounded snapshot or coordinate of the corresponding already-frozen product plaintext class, retained so an administrator can resolve a report after its target changes or disappears.",
    "evidence": [
      "packages/server/tests/unit/content-reports-route.test.ts",
      "packages/types/tests/unit/content-reports.test.ts"
    ]
  },
  {
    "locator": "public.content_reports.target_user_id",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ],
    "fields": [
      "target_user_id"
    ],
    "reason": "The moderation target_user_id field is a bounded snapshot or coordinate of the corresponding already-frozen product plaintext class, retained so an administrator can resolve a report after its target changes or disappears.",
    "evidence": [
      "packages/server/tests/unit/content-reports-route.test.ts",
      "packages/types/tests/unit/content-reports.test.ts"
    ]
  },
  {
    "locator": "public.content_reports.comment",
    "targetDebtIds": [
      "debt.db.public.session_messages.content"
    ],
    "fields": [
      "comment"
    ],
    "reason": "The moderation comment field is a bounded snapshot or coordinate of the corresponding already-frozen product plaintext class, retained so an administrator can resolve a report after its target changes or disappears.",
    "evidence": [
      "packages/server/tests/unit/content-reports-route.test.ts",
      "packages/types/tests/unit/content-reports.test.ts"
    ]
  },
  {
    "locator": "public.content_reports.preview_text",
    "targetDebtIds": [
      "debt.db.public.session_messages.content"
    ],
    "fields": [
      "preview_text"
    ],
    "reason": "The moderation preview_text field is a bounded snapshot or coordinate of the corresponding already-frozen product plaintext class, retained so an administrator can resolve a report after its target changes or disappears.",
    "evidence": [
      "packages/server/tests/unit/content-reports-route.test.ts",
      "packages/types/tests/unit/content-reports.test.ts"
    ]
  },
  {
    "locator": "public.content_reports.preview_display_name",
    "targetDebtIds": [
      "debt.db.public.users.name"
    ],
    "fields": [
      "preview_display_name"
    ],
    "reason": "The moderation preview_display_name field is a bounded snapshot or coordinate of the corresponding already-frozen product plaintext class, retained so an administrator can resolve a report after its target changes or disappears.",
    "evidence": [
      "packages/server/tests/unit/content-reports-route.test.ts",
      "packages/types/tests/unit/content-reports.test.ts"
    ]
  },
  {
    "locator": "public.content_reports.preview_handle",
    "targetDebtIds": [
      "debt.db.public.users.handle"
    ],
    "fields": [
      "preview_handle"
    ],
    "reason": "The moderation preview_handle field is a bounded snapshot or coordinate of the corresponding already-frozen product plaintext class, retained so an administrator can resolve a report after its target changes or disappears.",
    "evidence": [
      "packages/server/tests/unit/content-reports-route.test.ts",
      "packages/types/tests/unit/content-reports.test.ts"
    ]
  },
  {
    "locator": "public.content_reports.preview_attachments",
    "targetDebtIds": [
      "debt.db.public.message_attachments.filename",
      "debt.db.public.message_attachments.mime_type",
      "debt.db.public.message_attachments.size_bytes"
    ],
    "fields": [
      "preview_attachments"
    ],
    "reason": "The moderation preview_attachments field is a bounded snapshot or coordinate of the corresponding already-frozen product plaintext class, retained so an administrator can resolve a report after its target changes or disappears.",
    "evidence": [
      "packages/server/tests/unit/content-reports-route.test.ts",
      "packages/types/tests/unit/content-reports.test.ts"
    ]
  },
  {
    "locator": "http:request_response:GET /api/admin/content-reports",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n",
      "debt.wire.http.request.response.get.api.admin.users.12jlf0u"
    ],
    "reason": "The authenticated moderation transport projects the already-frozen Message and Human identity plaintext classes into the bounded report workflow; its exact DTO remains separately shape-locked.",
    "evidence": [
      "packages/server/tests/unit/content-reports-route.test.ts",
      "packages/types/tests/unit/content-reports.test.ts"
    ]
  },
  {
    "locator": "http:request_response:POST /api/admin/content-reports/:reportId/actions",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n",
      "debt.wire.http.request.response.get.api.admin.users.12jlf0u"
    ],
    "reason": "The authenticated moderation transport projects the already-frozen Message and Human identity plaintext classes into the bounded report workflow; its exact DTO remains separately shape-locked.",
    "evidence": [
      "packages/server/tests/unit/content-reports-route.test.ts",
      "packages/types/tests/unit/content-reports.test.ts"
    ]
  },
  {
    "locator": "http:request_response:POST /api/content-reports",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n",
      "debt.wire.http.request.response.get.api.admin.users.12jlf0u"
    ],
    "reason": "The authenticated moderation transport projects the already-frozen Message and Human identity plaintext classes into the bounded report workflow; its exact DTO remains separately shape-locked.",
    "evidence": [
      "packages/server/tests/unit/content-reports-route.test.ts",
      "packages/types/tests/unit/content-reports.test.ts"
    ]
  },
  {
    "locator": "public.claude_connections",
    "targetDebtIds": [
      "debt.db.public.users.id",
      "debt.db.public.users.email"
    ],
    "fields": [
      "user_id",
      "account"
    ],
    "reason": "The Claude connection projection retains only the Human-owned account identity already represented by frozen User identity debt; credentials, filesystem paths, relay/session identifiers, provider flags, and cost are structurally excluded.",
    "evidence": [
      "packages/db/tests/unit/d452-claude-connections-schema-contract.test.ts",
      "packages/server/tests/unit-isolated/claude-connections-routes.test.ts"
    ]
  },
  {
    "locator": "public.claude_connections.user_id",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ],
    "fields": [
      "user_id"
    ],
    "reason": "The Claude connection projection retains only the Human-owned account identity already represented by frozen User identity debt; credentials, filesystem paths, relay/session identifiers, provider flags, and cost are structurally excluded.",
    "evidence": [
      "packages/db/tests/unit/d452-claude-connections-schema-contract.test.ts",
      "packages/server/tests/unit-isolated/claude-connections-routes.test.ts"
    ]
  },
  {
    "locator": "public.claude_connections.account",
    "targetDebtIds": [
      "debt.db.public.users.email"
    ],
    "fields": [
      "account.email",
      "account.organization",
      "account.subscriptionType"
    ],
    "reason": "The Claude connection projection retains only the Human-owned account identity already represented by frozen User identity debt; credentials, filesystem paths, relay/session identifiers, provider flags, and cost are structurally excluded.",
    "evidence": [
      "packages/db/tests/unit/d452-claude-connections-schema-contract.test.ts",
      "packages/server/tests/unit-isolated/claude-connections-routes.test.ts"
    ]
  },
  {
    "locator": "http:request_response:GET /api/claude-connections",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.auth.whoami.1qlua20"
    ],
    "reason": "The owner-only Claude connection summary projects the same frozen Human account identity exposed by whoami; raw credentials and local paths never enter this response.",
    "evidence": [
      "packages/db/tests/unit/d452-claude-connections-schema-contract.test.ts",
      "packages/server/tests/unit-isolated/claude-connections-routes.test.ts"
    ]
  },
  {
    "locator": "public.human_blocks",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ],
    "fields": [
      "blocker_user_id",
      "blocked_user_id"
    ],
    "reason": "The directional block relation is an exact projection of already-frozen Human User identifiers; it stores no free text, profile snapshot, Message, or credential.",
    "evidence": [
      "packages/trust/tests/unit/human-blocks.test.ts"
    ]
  },
  {
    "locator": "public.human_blocks.blocker_user_id",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ],
    "fields": [
      "blocker_user_id"
    ],
    "reason": "The directional block relation is an exact projection of already-frozen Human User identifiers; it stores no free text, profile snapshot, Message, or credential.",
    "evidence": [
      "packages/trust/tests/unit/human-blocks.test.ts"
    ]
  },
  {
    "locator": "public.human_blocks.blocked_user_id",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ],
    "fields": [
      "blocked_user_id"
    ],
    "reason": "The directional block relation is an exact projection of already-frozen Human User identifiers; it stores no free text, profile snapshot, Message, or credential.",
    "evidence": [
      "packages/trust/tests/unit/human-blocks.test.ts"
    ]
  },
  {
    "locator": "http:request_response:DELETE /api/human-blocks/:userId",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.admin.users.12jlf0u"
    ],
    "reason": "The authenticated Human-block transport carries only the same frozen User identity class plus fixed relation state; it has no content or credential payload.",
    "evidence": [
      "packages/trust/tests/unit/human-blocks.test.ts"
    ]
  },
  {
    "locator": "http:request_response:GET /api/human-blocks",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.admin.users.12jlf0u"
    ],
    "reason": "The authenticated Human-block transport carries only the same frozen User identity class plus fixed relation state; it has no content or credential payload.",
    "evidence": [
      "packages/trust/tests/unit/human-blocks.test.ts"
    ]
  },
  {
    "locator": "http:request_response:GET /api/human-blocks/:userId",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.admin.users.12jlf0u"
    ],
    "reason": "The authenticated Human-block transport carries only the same frozen User identity class plus fixed relation state; it has no content or credential payload.",
    "evidence": [
      "packages/trust/tests/unit/human-blocks.test.ts"
    ]
  },
  {
    "locator": "http:request_response:PUT /api/human-blocks/:userId",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.admin.users.12jlf0u"
    ],
    "reason": "The authenticated Human-block transport carries only the same frozen User identity class plus fixed relation state; it has no content or credential payload.",
    "evidence": [
      "packages/trust/tests/unit/human-blocks.test.ts"
    ]
  },
  {
    "locator": "public.mobile_user_agreement_acceptances",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ],
    "fields": [
      "user_id"
    ],
    "reason": "The agreement audit row associates fixed public policy-version metadata with an already-frozen Human User identifier; no agreement text or authored content is copied into the database.",
    "evidence": [
      "packages/db/tests/unit/mobile-user-agreement-schema.test.ts"
    ]
  },
  {
    "locator": "public.mobile_user_agreement_acceptances.user_id",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ],
    "fields": [
      "user_id"
    ],
    "reason": "The agreement audit User coordinate is the exact already-frozen Human User identifier and introduces no new plaintext value class.",
    "evidence": [
      "packages/db/tests/unit/mobile-user-agreement-schema.test.ts"
    ]
  },
  {
    "locator": "http:request_response:GET /api/tasks/:id/agent/avatar",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.users.id.avatar.1yatmfu"
    ],
    "reason": "The task Agent-avatar response projects the already-frozen avatar transport class and adds no image bytes or independent retained content.",
    "evidence": [
      "packages/server/tests/unit/task-summary-mapper.test.ts"
    ]
  },
  {
    "locator": "http:request_response:GET /api/tasks/pending-attention",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.tasks.1veo2i8"
    ],
    "reason": "The owner-private pending-attention projection selects an exact bounded subset of the already-frozen Task and tool-argument transport classes; it creates no independent persistence.",
    "evidence": [
      "packages/server/tests/unit/task-summary-mapper.test.ts"
    ]
  },
  {
    "locator": "http:request_response:GET /api/tasks/pending-attention#response.body[].activity.args",
    "targetDebtIds": [
      "debt.wire.arbitrary.19ijf0o"
    ],
    "reason": "The owner-private pending-attention projection selects an exact bounded subset of the already-frozen Task and tool-argument transport classes; it creates no independent persistence.",
    "evidence": [
      "packages/server/tests/unit/task-summary-mapper.test.ts"
    ]
  },
  {
    "locator": "http:request_response:GET /api/tasks/pending-attention#response.body[].tools[].args",
    "targetDebtIds": [
      "debt.wire.arbitrary.19ijf0o"
    ],
    "reason": "The owner-private pending-attention projection selects an exact bounded subset of the already-frozen Task and tool-argument transport classes; it creates no independent persistence.",
    "evidence": [
      "packages/server/tests/unit/task-summary-mapper.test.ts"
    ]
  }
] as const;

export const REVIEWED_MAIN_2026_08_29_DEBT_LINKS: readonly ReviewedDebtLink[] =
  REVIEWED_LINK_INPUTS.map((item, index) => ({
    id: `main.2026-08-29.debt-link.${index + 1}`,
    surface: item.locator.startsWith("public.") || item.locator.startsWith("packages/") ? "db" : "wire",
    locator: item.locator,
    owner: item.locator.startsWith("public.") ? "packages/db" : "packages/server",
    targetDebtIds: item.targetDebtIds,
    reason: item.reason,
    testEvidence: item.evidence,
    ...(!("fields" in item) ? {} : {
      crossBoundaryProjection: {
        fields: item.fields,
        rationale: "Each listed field is an exact bounded projection of the named frozen plaintext class; no wildcard or additional content channel is admitted.",
      },
    }),
  }));
