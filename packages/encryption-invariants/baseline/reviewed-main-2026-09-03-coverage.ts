import type { EncryptionCoverageEntry } from "../src/model";
import type { RetiredFrozenDebt, ReviewedDebtLink } from "../src/registry";

const REVIEW_EVIDENCE =
  "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-03-security.test.ts";
const MEMBERSHIP_EVIDENCE = [
  REVIEW_EVIDENCE,
  "packages/db/tests/unit/migration-0222-m304-human-device-membership.test.ts",
  "packages/server/tests/unit/human-device-membership-route.test.ts",
] as const;

export const SUPERSEDED_MAIN_2026_09_03_COVERAGE_LOCATORS = new Set<string>([
  "packages/lattice-bridge/src/server/message/postgres-human-peer-live-shadow-plan.ts#reconcileExpired:update:public.conversation_human_peer_shadow_operations:1",
  "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts##planDeviceWrapped:raw_sql:insert:public.conversation_shadow_turn_agent_signers:1",
  "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts##planDeviceWrapped:raw_sql:insert:public.conversation_shadow_turn_operations:1",
  "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts##planDeviceWrapped:raw_sql:update:public.conversation_shadow_turn_plan_attempts:1",
  "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts##planGrantDomain:raw_sql:insert:public.conversation_shadow_turn_agent_signers:1",
  "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts##planGrantDomain:raw_sql:insert:public.conversation_shadow_turn_operations:1",
  "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts##planGrantDomain:raw_sql:update:public.conversation_shadow_turn_plan_attempts:1",
  "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts#plan:raw_sql:insert:public.conversation_shadow_turn_agent_signers:1",
  "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts#plan:raw_sql:insert:public.conversation_shadow_turn_operations:1",
  "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts#plan:raw_sql:update:public.conversation_shadow_turn_plan_attempts:1",
  "http:produced_arbitrary:packages/types/src/api.ts#ApplyAcceptedLiveProposalResponse",
  "http:produced_arbitrary:packages/types/src/api.ts#ApplyAcceptedLiveProposalResponse#documentVersion",
  "http:request_response:POST /api/protected/devices/additional/:operationId/grant-sync-page",
  "http:request_response:POST /api/protected/devices/additional/grant-sync-pending",
]);

const CONNECTED_APP_METADATA = [
  "public.connected_app_oauth_attempts",
  "public.connected_app_oauth_attempts.completed_at",
  "public.connected_app_oauth_attempts.connection_request_id",
  "public.connected_app_oauth_attempts.created_at",
  "public.connected_app_oauth_attempts.driver_kind",
  "public.connected_app_oauth_attempts.error_code",
  "public.connected_app_oauth_attempts.expires_at",
  "public.connected_app_oauth_attempts.id",
  "public.connected_app_oauth_attempts.namespace_id",
  "public.connected_app_oauth_attempts.provider_config_id",
  "public.connected_app_oauth_attempts.provider_id",
  "public.connected_app_oauth_attempts.status",
  "public.connected_app_oauth_attempts.updated_at",
  "public.connected_app_oauth_attempts.user_id",
  "public.connected_app_profiles.connected_account_id",
  "public.connected_app_profiles.connected_at",
  "public.connected_app_profiles.created_at",
  "public.connected_app_profiles.driver_credential_agent_id",
  "public.connected_app_profiles.driver_credential_namespace_id",
  "public.connected_app_profiles.driver_credential_record_id",
  "public.connected_app_profiles.driver_credential_ref_id",
  "public.connected_app_profiles.driver_kind",
  "public.connected_app_profiles.id",
  "public.connected_app_profiles.last_error_code",
  "public.connected_app_profiles.last_verified_at",
  "public.connected_app_profiles.namespace_id",
  "public.connected_app_profiles.provider_config_id",
  "public.connected_app_profiles.provider_id",
  "public.connected_app_profiles.provider_user_kind",
  "public.connected_app_profiles.provider_workspace_identity",
  "public.connected_app_profiles.revision",
  "public.connected_app_profiles.status",
  "public.connected_app_profiles.updated_at",
  "public.connected_app_profiles.user_id",
  "public.connected_app_provider_configs",
  "public.connected_app_provider_configs.admin_credential_agent_id",
  "public.connected_app_provider_configs.admin_credential_namespace_id",
  "public.connected_app_provider_configs.admin_credential_ref_id",
  "public.connected_app_provider_configs.client_id",
  "public.connected_app_provider_configs.created_at",
  "public.connected_app_provider_configs.driver_kind",
  "public.connected_app_provider_configs.id",
  "public.connected_app_provider_configs.last_error_code",
  "public.connected_app_provider_configs.last_verified_at",
  "public.connected_app_provider_configs.provider_id",
  "public.connected_app_provider_configs.revision",
  "public.connected_app_provider_configs.status",
  "public.connected_app_provider_configs.updated_at",
] as const;

const CONNECTED_WEB_METADATA = [
  "public.connected_web_accounts",
  "public.connected_web_accounts.cleanup_failure_code",
  "public.connected_web_accounts.cleanup_state",
  "public.connected_web_accounts.created_at",
  "public.connected_web_accounts.execution_checkpoint",
  "public.connected_web_accounts.id",
  "public.connected_web_accounts.last_verified_at",
  "public.connected_web_accounts.origin",
  "public.connected_web_accounts.owner_user_id",
  "public.connected_web_accounts.profile_ref",
  "public.connected_web_accounts.revoked_at",
  "public.connected_web_accounts.service",
  "public.connected_web_accounts.status",
  "public.connected_web_accounts.updated_at",
] as const;

const MEMBERSHIP_METADATA = [
  "public.human_crypto_device_group_acknowledgements",
  "public.human_crypto_device_group_acknowledgements.acknowledged_at",
  "public.human_crypto_device_group_acknowledgements.acknowledged_head_digest",
  "public.human_crypto_device_group_acknowledgements.acknowledged_sequence",
  "public.human_crypto_device_group_acknowledgements.device_generation",
  "public.human_crypto_device_group_acknowledgements.device_id",
  "public.human_crypto_device_group_acknowledgements.human_id",
  "public.human_crypto_device_group_acknowledgements.lineage_generation",
  "public.human_crypto_device_group_acknowledgements.revision",
  "public.human_crypto_device_group_commits",
  "public.human_crypto_device_group_commits.commit_bytes",
  "public.human_crypto_device_group_commits.committer_device_generation",
  "public.human_crypto_device_group_commits.committer_device_id",
  "public.human_crypto_device_group_commits.created_at",
  "public.human_crypto_device_group_commits.expected_head_digest",
  "public.human_crypto_device_group_commits.human_id",
  "public.human_crypto_device_group_commits.lineage_generation",
  "public.human_crypto_device_group_commits.next_epoch",
  "public.human_crypto_device_group_commits.next_head_digest",
  "public.human_crypto_device_group_commits.next_security_revision",
  "public.human_crypto_device_group_commits.operation",
  "public.human_crypto_device_group_commits.operation_id",
  "public.human_crypto_device_group_commits.public_transition_bytes",
  "public.human_crypto_device_group_commits.roster_bytes",
  "public.human_crypto_device_group_commits.roster_digest",
  "public.human_crypto_device_group_commits.sequence",
  "public.human_crypto_device_group_commits.server_instance_id",
  "public.human_crypto_device_group_commits.target_device_generation",
  "public.human_crypto_device_group_commits.target_device_id",
  "public.human_crypto_device_group_commits.welcome_digest",
  "public.human_crypto_device_group_heads",
  "public.human_crypto_device_group_heads.commit_sequence",
  "public.human_crypto_device_group_heads.committing_device_generation",
  "public.human_crypto_device_group_heads.committing_device_id",
  "public.human_crypto_device_group_heads.created_at",
  "public.human_crypto_device_group_heads.epoch",
  "public.human_crypto_device_group_heads.group_id",
  "public.human_crypto_device_group_heads.head_bytes",
  "public.human_crypto_device_group_heads.head_digest",
  "public.human_crypto_device_group_heads.human_id",
  "public.human_crypto_device_group_heads.lineage_generation",
  "public.human_crypto_device_group_heads.previous_head_digest",
  "public.human_crypto_device_group_heads.provider_id",
  "public.human_crypto_device_group_heads.roster_bytes",
  "public.human_crypto_device_group_heads.roster_digest",
  "public.human_crypto_device_group_heads.security_revision",
  "public.human_crypto_device_group_heads.server_instance_id",
  "public.human_crypto_device_group_heads.state_hash",
  "public.human_crypto_device_group_heads.updated_at",
  "public.human_crypto_device_group_join_requests",
  "public.human_crypto_device_group_join_requests.consumed_at",
  "public.human_crypto_device_group_join_requests.created_at",
  "public.human_crypto_device_group_join_requests.expected_head_digest",
  "public.human_crypto_device_group_join_requests.human_id",
  "public.human_crypto_device_group_join_requests.lineage_generation",
  "public.human_crypto_device_group_join_requests.operation_id",
  "public.human_crypto_device_group_join_requests.request_bytes",
  "public.human_crypto_device_group_join_requests.state",
  "public.human_crypto_device_group_join_requests.target_device_generation",
  "public.human_crypto_device_group_join_requests.target_device_id",
  "public.human_crypto_device_group_welcomes.acknowledged_at",
  "public.human_crypto_device_group_welcomes.created_at",
  "public.human_crypto_device_group_welcomes.delivered_at",
  "public.human_crypto_device_group_welcomes.human_id",
  "public.human_crypto_device_group_welcomes.lineage_generation",
  "public.human_crypto_device_group_welcomes.operation_id",
  "public.human_crypto_device_group_welcomes.sequence",
  "public.human_crypto_device_group_welcomes.state",
  "public.human_crypto_device_group_welcomes.target_device_generation",
  "public.human_crypto_device_group_welcomes.target_device_id",
  "public.human_crypto_device_group_welcomes.welcome_digest",
  "public.human_crypto_devices.membership_acknowledged_sequence",
  "public.human_crypto_devices.membership_epoch",
  "public.human_crypto_devices.membership_head_digest",
  "public.human_crypto_devices.membership_leaf_index",
  "public.human_crypto_devices.membership_lineage_generation",
  "public.human_crypto_devices.membership_security_revision",
  "public.human_crypto_devices.membership_server_instance_id",
  "public.human_crypto_devices.membership_state",
] as const;

const COST_METADATA = [
  "public.provider_cost_events",
  "public.provider_cost_events.actual_cost_usd",
  "public.provider_cost_events.estimated_cost_usd",
  "public.provider_cost_events.evidence_state",
  "public.provider_cost_events.id",
  "public.provider_cost_events.idempotency_key",
  "public.provider_cost_events.occurred_at",
  "public.provider_cost_events.operation",
  "public.provider_cost_events.provider",
] as const;

const CONTROL_WIRE = [
  "http:request_response:GET /api/setup/research-status",
] as const;

const MEMBERSHIP_WIRE = [
  "http:request_response:POST /api/protected/devices/membership/:operationId/add",
  "http:request_response:POST /api/protected/devices/membership/:operationId/join",
  "http:request_response:POST /api/protected/devices/membership/:operationId/recovery",
  "http:request_response:POST /api/protected/devices/membership/:operationId/remove",
  "http:request_response:POST /api/protected/devices/membership/acknowledge",
  "http:request_response:POST /api/protected/devices/membership/begin",
  "http:request_response:POST /api/protected/devices/membership/initial",
  "http:request_response:POST /api/protected/devices/membership/pending",
  "http:request_response:POST /api/protected/devices/membership/recovery/begin",
  "http:request_response:POST /api/protected/devices/membership/roster",
  "http:request_response:POST /api/protected/devices/membership/status",
] as const;

const metadataEntries = [
  ...CONNECTED_APP_METADATA,
  ...CONNECTED_WEB_METADATA,
  ...MEMBERSHIP_METADATA,
  ...COST_METADATA,
  ...CONTROL_WIRE,
].map((locator, index): EncryptionCoverageEntry => {
  const wire = locator.startsWith("http:");
  return {
    id: `main.2026-09-03.metadata.${index + 1}`,
    surface: wire ? "wire" : "db",
    locator,
    owner: wire ? "packages/server" : "packages/db",
    readers: wire ? ["authenticated Nautilo clients"] : ["packages/server"],
    writers: wire ? ["packages/server"] : ["packages/server", "packages/lattice-bridge"],
    migrationState: "not_applicable",
    retention: wire
      ? "Request-scoped authenticated status data is discarded after the response."
      : "Retained with the bounded owning connection, device-membership, or provider-cost lifecycle.",
    testEvidence: [REVIEW_EVIDENCE],
    classification: "bounded_metadata",
    metadataAllowlist: [locator.includes(".") ? locator.split(".").at(-1)! : "response"],
    plaintextReason:
      "This exact coordinate contains only identifiers, fixed states, counters, timestamps, public cryptographic transcript material, or financial telemetry; it excludes Human-authored content, credentials, recovery secrets, and private keys.",
  };
});

const protectedEntries: readonly EncryptionCoverageEntry[] = [
  "public.human_crypto_device_group_welcomes",
  "public.human_crypto_device_group_welcomes.welcome_bytes",
  ...MEMBERSHIP_WIRE,
].map((locator, index) => ({
  id: `main.2026-09-03.protected-membership.${index + 1}`,
  surface: locator.startsWith("http:") ? "wire" : "db",
  locator,
  owner: locator.startsWith("http:") ? "packages/server" : "packages/db",
  readers: ["packages/lattice-bridge/src/device/human-device-membership-client.ts"],
  writers: ["packages/server/src/routes/human-device-membership.ts"],
  migrationState: "ciphertext_only",
  retention:
    "Authenticated MLS membership transport and encrypted welcome material are retained only for the current device-membership lineage and acknowledgement lifecycle.",
  testEvidence: MEMBERSHIP_EVIDENCE,
  classification: "protected",
  keyFamily: "namespace_human",
  bridgeRepository:
    "packages/lattice-bridge/src/device/human-device-membership-client.ts",
  negativeTestEvidence: MEMBERSHIP_EVIDENCE,
}));

export const REVIEWED_MAIN_2026_09_03_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [...metadataEntries, ...protectedEntries];

const IDENTITY_PROJECTIONS = [
  ["public.connected_app_oauth_attempts.connection_name", ["debt.db.public.rooms.label"]],
  ["public.connected_app_profiles", ["debt.db.public.users.email", "debt.db.public.users.name", "debt.db.public.users.handle", "debt.db.public.profiles.avatar_ref"]],
  ["public.connected_app_profiles.account_avatar_url", ["debt.db.public.profiles.avatar_ref"]],
  ["public.connected_app_profiles.account_display_name", ["debt.db.public.users.name"]],
  ["public.connected_app_profiles.account_email", ["debt.db.public.users.email"]],
  ["public.connected_app_profiles.account_username", ["debt.db.public.users.handle"]],
  ["public.connected_app_profiles.account_workspace_name", ["debt.db.public.users.name"]],
  ["public.connected_app_profiles.connection_name", ["debt.db.public.rooms.label"]],
  ["public.connected_app_profiles.provider_user_id", ["debt.db.public.users.id"]],
  ["public.connected_web_accounts.label", ["debt.db.public.rooms.label"]],
  ["public.provider_cost_events.agent_id", ["debt.db.public.agents.id"]],
  ["public.provider_cost_events.room_id", ["debt.db.public.rooms.id"]],
  ["public.provider_cost_events.user_id", ["debt.db.public.users.id"]],
] as const;

const CONNECTED_WIRE = [
  "http:request_response:DELETE /api/connected-apps/:providerId",
  "http:request_response:DELETE /api/connected-apps/:providerId/oauth/:attemptId",
  "http:request_response:DELETE /api/connected-web-accounts/:id",
  "http:request_response:GET /api/connected-apps",
  "http:request_response:GET /api/connected-apps/:providerId/oauth/:attemptId",
  "http:request_response:GET /api/connected-apps/:providerId/setup",
  "http:request_response:GET /api/connected-web-accounts",
  "http:request_response:GET /api/connected-web-accounts/:id",
  "http:request_response:GET /api/connected-web-accounts/:id/read-activity",
  "http:request_response:GET /connections/oauth/complete",
  "http:request_response:POST /api/connected-apps/:providerId/oauth",
  "http:request_response:POST /api/connected-web-accounts",
  "http:request_response:POST /api/connected-web-accounts/:id/cancel-login",
  "http:request_response:POST /api/connected-web-accounts/:id/cancel-read",
  "http:request_response:POST /api/connected-web-accounts/:id/close-page",
  "http:request_response:POST /api/connected-web-accounts/:id/finish",
  "http:request_response:POST /api/connected-web-accounts/:id/open-page",
  "http:request_response:POST /api/connected-web-accounts/:id/reconnect",
  "http:request_response:POST /api/connected-web-accounts/:id/watch-read",
  "http:request_response:PUT /api/connected-apps/:providerId/setup",
] as const;

const LIVE_REVIEW_WIRE = [
  "app_bridge:app_to_host:nautilo.app.live-proposal.ack",
  "app_bridge:app_to_host:nautilo.app.live-proposal.ack#documentVersion",
  "app_bridge:app_to_host:nautilo.app.session.req#invalidateProposal",
  "app_bridge:app_to_host:nautilo.app.session.req#invalidateProposal#documentVersion",
  "app_bridge:app_to_host:nautilo.app.session.req#resolveProposal",
  "app_bridge:app_to_host:nautilo.app.session.req#resolveProposal#documentVersion",
  "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppLiveProposalAcknowledgement",
  "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppLiveProposalAcknowledgement#documentVersion",
  "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppSessionInvalidateProposalRequest",
  "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppSessionInvalidateProposalRequest#documentVersion",
  "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppSessionResolveProposalRequest",
  "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppSessionResolveProposalRequest#documentVersion",
  "http:accepted_arbitrary:packages/types/src/api.ts#PendingLiveProposalReview",
  "http:accepted_arbitrary:packages/types/src/api.ts#PendingLiveProposalReview#operations[]",
  "http:produced_arbitrary:packages/types/src/api.ts#ListPendingLiveProposalReviewsResponse",
  "http:produced_arbitrary:packages/types/src/api.ts#ListPendingLiveProposalReviewsResponse#proposals[].operations[]",
  "http:request_response:POST /api/apps/:appId/live-session/invalidate-review",
  "http:request_response:POST /api/apps/:appId/live-session/invalidate-review#response.body.error",
  "http:request_response:POST /api/apps/:appId/live-session/resolve-review",
  "http:request_response:POST /api/apps/:appId/live-session/resolve-review#response.body.error",
  "http:request_response:POST /api/apps/:appId/live-session/reviews",
  "http:request_response:POST /api/apps/:appId/live-session/reviews#request.body.sessionToken",
  "http:request_response:POST /api/apps/:appId/live-session/reviews#response.body.proposals[].operations[]",
] as const;

export const REVIEWED_MAIN_2026_09_03_DEBT_LINKS: readonly ReviewedDebtLink[] = [
  ...IDENTITY_PROJECTIONS.map(([locator, targetDebtIds], index) => ({
    id: `main.2026-09-03.identity-projection.${index + 1}`,
    surface: "db" as const,
    locator,
    owner: "packages/db",
    targetDebtIds,
    reason:
      "The connected-account field is an exact provider projection of already-frozen Human identity or user-chosen label plaintext and is not mislabeled as operational metadata.",
    testEvidence: ["packages/server/tests/unit-isolated/connected-apps-routes.test.ts"],
    crossBoundaryProjection: {
      fields: locator === "public.connected_app_profiles"
        ? [
          "account_avatar_url",
          "account_display_name",
          "account_email",
          "account_username",
          "account_workspace_name",
          "connection_name",
          "provider_user_id",
        ]
        : [locator.split(".").at(-1)!],
      rationale:
        "The listed connected-account coordinate repeats the named frozen Human identity or label class without introducing a separate content store.",
    },
  })),
  ...CONNECTED_WIRE.map((locator, index) => ({
    id: `main.2026-09-03.connected-wire.${index + 1}`,
    surface: "wire" as const,
    locator,
    owner: "packages/server",
    targetDebtIds: ["debt.wire.http.request.response.get.api.connections.ynrauj"],
    reason:
      "The authenticated connected-app/account route projects the same provider identity and connection-capability plaintext class as the frozen Connections API; it does not carry provider result content or stored credential values.",
    testEvidence: ["packages/server/tests/unit-isolated/connected-apps-routes.test.ts"],
  })),
  ...LIVE_REVIEW_WIRE.map((locator, index) => ({
    id: `main.2026-09-03.live-review.${index + 1}`,
    surface: "wire" as const,
    locator,
    owner: locator.startsWith("app_bridge:") ? "apps/workbench" : "packages/server",
    targetDebtIds: ["debt.wire.app.bridge.host.to.app.nautilo.app.live.proposal.1c5vb88"],
    reason:
      "The review acknowledgement and resolution contracts project the same live proposal, document-version, and operation plaintext already frozen at the live-proposal bridge; they add lifecycle decisions but no independent content class.",
    testEvidence: ["packages/server/src/apps/live-review-extension-registry.test.ts"],
  })),
  {
    id: "main.2026-09-03.connected-result-media",
    surface: "wire",
    locator: "http:request_response:GET /api/connected-apps/result-media",
    owner: "packages/server",
    targetDebtIds: ["debt.wire.http.request.response.get.api.message.attachments.id.1dhoon6"],
    reason:
      "The connected-app media presenter streams the same plaintext binary attachment class already frozen at the Message attachment download boundary; it does not create a second retained copy.",
    testEvidence: ["packages/api-client/tests/unit/connected-app-result-media.test.ts"],
  },
  {
    id: "main.2026-09-03.connected-result-media-error",
    surface: "wire",
    locator: "http:request_response:GET /api/connected-apps/result-media#response.body.errored.cause",
    owner: "packages/server",
    targetDebtIds: ["debt.wire.http.request.response.get.api.message.attachments.id.1dhoon6"],
    reason:
      "The bounded media-fetch error is part of the same frozen attachment-download boundary and cannot carry a successful media body or a distinct durable payload.",
    testEvidence: ["packages/api-client/tests/unit/connected-app-result-media.test.ts"],
  },
];

export const RETIRED_MAIN_2026_09_03_FROZEN_DEBT:
  readonly RetiredFrozenDebt[] = [
  {
    debtId:
      "debt.wire.http.produced.arbitrary.packages.types.src.api.ts.applyacceptedliveproposalresponse.bf22iv",
    reason:
      "The standalone produced-arbitrary response observation was removed when the accepted-live-proposal result became an exact route and bridge response; current projections remain inventoried separately.",
    testEvidence: ["packages/server/src/apps/live-review-extension-registry.test.ts"],
  },
  {
    debtId: "debt.wire.arbitrary.1jbdmxb",
    reason:
      "The retired standalone response documentVersion leaf no longer exists; the exact current route and bridge document-version projections remain inventoried separately.",
    testEvidence: ["packages/server/src/apps/live-review-extension-registry.test.ts"],
  },
];
