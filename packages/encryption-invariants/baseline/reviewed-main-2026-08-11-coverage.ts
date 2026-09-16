import type { EncryptionCoverageEntry } from "../src/model";
import type { ReviewedDebtLink } from "../src/registry";

const CODEX_SCHEMA_EVIDENCE = "packages/db/tests/unit/d453-codex-schema-contract.test.ts";
const CODEX_ROUTE_EVIDENCE = "packages/server/tests/unit/codex-connection-routes.test.ts";
const CODEX_REQUEST_EVIDENCE = "packages/server/tests/unit/codex-requests-routes.test.ts";
const PUSH_SCHEMA_EVIDENCE = "packages/db/tests/unit/push-notification-schema.test.ts";
const PUSH_ROUTE_EVIDENCE = "packages/server/tests/integration/push-installations.integration.test.ts";
const OWNER_EVIDENCE = "packages/server/tests/unit-isolated/owner-claim-route-contract.test.ts";
const RELAY_EVIDENCE = "packages/relay/tests/unit/protocol-codex-v8.test.ts";
const MCP_EVIDENCE = "packages/server/tests/unit/mcp-servers-route.test.ts";

const legacyTargets = {
  "public.invites": "debt.db.object.public.invites",
  "public.mcp_servers": "debt.db.object.public.mcp_servers",
  "public.server_profile": "debt.db.object.public.server_profile",
} as const;

function owner(locator: string): string {
  if (locator.startsWith("public.")) return "packages/db";
  if (locator.startsWith("relay:")) return "packages/relay";
  return "packages/server";
}

function boundedDb(id: string, locator: string): EncryptionCoverageEntry {
  const field = locator.split(".").at(-1)!;
  return { id, surface: "db", locator, owner: "packages/db", readers: ["packages/server/src"], writers: ["packages/db/src"], migrationState: "not_applicable", retention: "Retained only for the bounded push-delivery lifecycle and removed by owner revocation, terminal cleanup, or canonical parent deletion.", testEvidence: [PUSH_SCHEMA_EVIDENCE], classification: "bounded_metadata", metadataAllowlist: [field], plaintextReason: "The exact field is an opaque identifier, fixed enum, bounded counter, lifecycle timestamp, or delivery lease coordinate and contains no notification copy or provider capability plaintext." };
}

function boundedCodexDb(id: string, locator: string): EncryptionCoverageEntry {
  const field = locator.split(".").at(-1)!;
  return { id, surface: "db", locator, owner: "packages/db", readers: ["packages/server/src/codex"], writers: ["packages/server/src/codex"], migrationState: "not_applicable", retention: "Retained for the owner-scoped Codex account, preference, binding, or input-request lifecycle and removed or archived with that canonical parent.", testEvidence: [CODEX_SCHEMA_EVIDENCE], classification: "bounded_metadata", metadataAllowlist: [field], plaintextReason: "The exact field is an opaque identifier, fixed execution policy, bounded generation/revision, lifecycle state, or timestamp; Human account identity, usage, and question text remain separately linked to frozen plaintext debt." };
}

function operatorSecret(id: string, surface: "db" | "wire", locator: string): EncryptionCoverageEntry {
  return { id, surface, locator, owner: surface === "db" ? "packages/db" : "packages/server", readers: ["packages/server/src/push"], writers: [surface === "db" ? "packages/server/src/push/push-installation-store.ts" : "apps/mobile/src/providers/push-lifecycle.ts"], migrationState: "not_applicable", retention: "The provider capability is retained only for the live Mobile installation binding; revocation terminalizes the binding and excludes it from future delivery.", testEvidence: [PUSH_ROUTE_EVIDENCE], classification: "operator_secret", secretStoreLocation: "The plaintext provider capability is transient on the authenticated registration wire and otherwise exists only inside the versioned AES-GCM database envelope whose key is loaded from the operator secret environment.", backupProcedure: "The operator backs up the push-token encryption key through the deployment secret store; loss requires Mobile installations to register fresh provider capabilities.", excludedFromAgentGrants: true };
}

const CODEX_DB_LOCATORS = [
  "public.codex_account_profiles",
  "public.codex_account_profiles.account_email",
  "public.codex_account_profiles.account_generation",
  "public.codex_account_profiles.auth_state",
  "public.codex_account_profiles.created_at",
  "public.codex_account_profiles.home_handle",
  "public.codex_account_profiles.id",
  "public.codex_account_profiles.label",
  "public.codex_account_profiles.last_error_code",
  "public.codex_account_profiles.plan_type",
  "public.codex_account_profiles.profile_generation",
  "public.codex_account_profiles.relay_id",
  "public.codex_account_profiles.removal_state",
  "public.codex_account_profiles.removed_at",
  "public.codex_account_profiles.revision",
  "public.codex_account_profiles.updated_at",
  "public.codex_account_profiles.usage_observed_at",
  "public.codex_account_profiles.usage_snapshot",
  "public.codex_account_profiles.user_id",
  "public.codex_thread_bindings",
  "public.codex_thread_bindings.account_generation",
  "public.codex_thread_bindings.account_profile_id",
  "public.codex_thread_bindings.archived_at",
  "public.codex_thread_bindings.binding_generation",
  "public.codex_thread_bindings.binding_kind",
  "public.codex_thread_bindings.capability_revision",
  "public.codex_thread_bindings.child_generation",
  "public.codex_thread_bindings.codex_approval_policy",
  "public.codex_thread_bindings.codex_sandbox_mode",
  "public.codex_thread_bindings.codex_thread_id",
  "public.codex_thread_bindings.created_at",
  "public.codex_thread_bindings.desktop_session_id",
  "public.codex_thread_bindings.id",
  "public.codex_thread_bindings.job_id",
  "public.codex_thread_bindings.lane_key",
  "public.codex_thread_bindings.last_item_cursor",
  "public.codex_thread_bindings.last_turn_id",
  "public.codex_thread_bindings.pairing_generation_ref",
  "public.codex_thread_bindings.parent_task_id",
  "public.codex_thread_bindings.profile_generation",
  "public.codex_thread_bindings.relay_id",
  "public.codex_thread_bindings.relay_session_id",
  "public.codex_thread_bindings.revision",
  "public.codex_thread_bindings.room_id",
  "public.codex_thread_bindings.runtime_generation",
  "public.codex_thread_bindings.selected_model",
  "public.codex_thread_bindings.source_agent_id",
  "public.codex_thread_bindings.state",
  "public.codex_thread_bindings.task_id",
  "public.codex_thread_bindings.task_run_id",
  "public.codex_thread_bindings.updated_at",
  "public.codex_thread_bindings.user_id",
  "public.codex_thread_bindings.workspace_expires_at",
  "public.codex_thread_bindings.workspace_fingerprint",
  "public.codex_thread_bindings.workspace_issued_at",
  "public.codex_thread_bindings.workspace_ref",
  "public.codex_thread_bindings.workspace_revision",
  "public.codex_user_input_requests",
  "public.codex_user_input_requests.auto_resolution_ms",
  "public.codex_user_input_requests.binding_generation",
  "public.codex_user_input_requests.binding_id",
  "public.codex_user_input_requests.codex_item_id",
  "public.codex_user_input_requests.codex_thread_id",
  "public.codex_user_input_requests.codex_turn_id",
  "public.codex_user_input_requests.created_at",
  "public.codex_user_input_requests.dispatching_at",
  "public.codex_user_input_requests.expires_at",
  "public.codex_user_input_requests.failure_code",
  "public.codex_user_input_requests.job_id",
  "public.codex_user_input_requests.questions",
  "public.codex_user_input_requests.request_ref",
  "public.codex_user_input_requests.revision",
  "public.codex_user_input_requests.room_id",
  "public.codex_user_input_requests.source_agent_id",
  "public.codex_user_input_requests.state",
  "public.codex_user_input_requests.submitted_at",
  "public.codex_user_input_requests.task_id",
  "public.codex_user_input_requests.task_run_id",
  "public.codex_user_input_requests.terminal_at",
  "public.codex_user_input_requests.updated_at",
  "public.codex_user_input_requests.user_id",
  "public.codex_user_preferences",
  "public.codex_user_preferences.account_profile_id",
  "public.codex_user_preferences.created_at",
  "public.codex_user_preferences.default_posture",
  "public.codex_user_preferences.enabled",
  "public.codex_user_preferences.revision",
  "public.codex_user_preferences.updated_at",
  "public.codex_user_preferences.user_id"
] as const;
const PUSH_DB_LOCATORS = [
  "public.push_installation_bindings",
  "public.push_installation_bindings.app_version",
  "public.push_installation_bindings.binding_id",
  "public.push_installation_bindings.created_at",
  "public.push_installation_bindings.disabled_at",
  "public.push_installation_bindings.enabled",
  "public.push_installation_bindings.installation_id",
  "public.push_installation_bindings.permission",
  "public.push_installation_bindings.platform",
  "public.push_installation_bindings.revoke_verifier_digest",
  "public.push_installation_bindings.revoked_at",
  "public.push_installation_bindings.state",
  "public.push_installation_bindings.token_auth_tag_base64",
  "public.push_installation_bindings.token_ciphertext_base64",
  "public.push_installation_bindings.token_generation",
  "public.push_installation_bindings.token_key_version",
  "public.push_installation_bindings.token_nonce_base64",
  "public.push_installation_bindings.updated_at",
  "public.push_installation_bindings.user_id",
  "public.push_message_candidates",
  "public.push_message_candidates.claim_expires_at",
  "public.push_message_candidates.claim_owner",
  "public.push_message_candidates.created_at",
  "public.push_message_candidates.message_id",
  "public.push_message_candidates.state",
  "public.push_message_candidates.terminal_at",
  "public.push_notification_deliveries",
  "public.push_notification_deliveries.attempt_count",
  "public.push_notification_deliveries.attention_request_id",
  "public.push_notification_deliveries.binding_id",
  "public.push_notification_deliveries.claim_expires_at",
  "public.push_notification_deliveries.claim_owner",
  "public.push_notification_deliveries.claim_purpose",
  "public.push_notification_deliveries.created_at",
  "public.push_notification_deliveries.event_id",
  "public.push_notification_deliveries.expires_at",
  "public.push_notification_deliveries.id",
  "public.push_notification_deliveries.kind",
  "public.push_notification_deliveries.last_failure_code",
  "public.push_notification_deliveries.message_id",
  "public.push_notification_deliveries.next_attempt_at",
  "public.push_notification_deliveries.occurred_at",
  "public.push_notification_deliveries.receipt_attempt_count",
  "public.push_notification_deliveries.room_id",
  "public.push_notification_deliveries.state",
  "public.push_notification_deliveries.terminal_at",
  "public.push_notification_deliveries.ticket_accepted_at",
  "public.push_notification_deliveries.ticket_id",
  "public.push_notification_deliveries.token_generation",
  "public.push_notification_deliveries.top_level_room_id",
  "public.push_notification_deliveries.updated_at",
  "public.push_notification_deliveries.user_id",
  "public.push_notification_test_intents",
  "public.push_notification_test_intents.binding_id",
  "public.push_notification_test_intents.claim_expires_at",
  "public.push_notification_test_intents.claim_owner",
  "public.push_notification_test_intents.created_at",
  "public.push_notification_test_intents.notification_id",
  "public.push_notification_test_intents.state",
  "public.push_notification_test_intents.terminal_at",
  "public.push_notification_test_intents.token_generation",
  "public.push_notification_test_intents.user_id"
] as const;
const LEGACY_DB_LOCATORS = [
  "public.invites.half_redeemed_user_id",
  "public.mcp_servers.last_check_failure_code",
  "public.mcp_servers.last_check_missing_environment",
  "public.mcp_servers.last_check_status",
  "public.mcp_servers.last_checked_at",
  "public.mcp_servers.last_connected_at",
  "public.server_profile.reviewed_at"
] as const;
const WIRE_DEBT = [
  [
    "http:request_response:POST /api/auth/verify-pin",
    "debt.wire.http.request.response.post.api.auth.pin.sj48n2"
  ],
  [
    "http:request_response:DELETE /api/codex/profiles/:profileId",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "http:request_response:DELETE /api/setup/owner-claim",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:GET /api/codex",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "http:request_response:GET /api/codex/preference",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "http:request_response:GET /api/codex/profiles/:profileId/models",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "http:request_response:GET /api/codex/profiles/:profileId/rate-limits",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "http:request_response:GET /api/codex/profiles/:profileId/usage",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "http:request_response:GET /api/codex/rooms/:roomId/requests",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "http:request_response:GET /api/rooms/search",
    "debt.wire.http.request.response.get.api.rooms.id.7993e"
  ],
  [
    "http:request_response:GET /api/setup/owner-claim/status",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:PATCH /api/codex/profiles/:profileId",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "http:request_response:POST /api/codex/profiles",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "http:request_response:POST /api/codex/profiles/:profileId/account",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "http:request_response:POST /api/codex/profiles/:profileId/login",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "http:request_response:POST /api/codex/profiles/:profileId/login/cancel",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "http:request_response:POST /api/codex/profiles/:profileId/logout",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "http:request_response:POST /api/codex/requests/:requestRef/respond",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "http:request_response:POST /api/codex/requests/:requestRef/respond#request.body",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "http:request_response:POST /api/codex/runtime/activate",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "http:request_response:POST /api/codex/runtime/cancel",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "http:request_response:POST /api/codex/runtime/inspect",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "http:request_response:POST /api/codex/runtime/install",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "http:request_response:POST /api/mcp-servers/:name/check",
    "debt.wire.http.request.response.get.api.mcp.servers.1j7qk9f"
  ],
  [
    "http:request_response:POST /api/mcp-servers/:name/check#response.body",
    "debt.wire.http.request.response.get.api.mcp.servers.1j7qk9f"
  ],
  [
    "http:request_response:POST /api/mcp-servers/:name/check#response.body.server.transport",
    "debt.wire.http.request.response.get.api.mcp.servers.1j7qk9f"
  ],
  [
    "http:request_response:POST /api/owner-claim/complete-profile",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:POST /api/owner-claim/complete-profile#request.body.claim",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:POST /api/owner-claim/complete-profile#request.body.displayName",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:POST /api/owner-claim/complete-profile#request.body.pin",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:POST /api/owner-claim/complete-profile#response.body",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:POST /api/owner-claim/complete-profile#response.body.code",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:POST /api/owner-claim/complete-profile#response.body.error",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:POST /api/owner-claim/prepare-auth",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:POST /api/owner-claim/prepare-auth#request.body.claim",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:POST /api/owner-claim/prepare-auth#request.body.handle",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:POST /api/owner-claim/prepare-auth#response.body",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:POST /api/owner-claim/prepare-logto-signup",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:POST /api/owner-claim/prepare-logto-signup#request.body.claim",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:POST /api/owner-claim/prepare-logto-signup#request.body.handle",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:POST /api/owner-claim/prepare-logto-signup#response.body",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:POST /api/owner-claim/preview",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:POST /api/owner-claim/preview#request.body.claim",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:POST /api/owner-claim/preview#response.body",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:POST /api/setup/owner-claim/redeem",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:POST /api/setup/owner-claim/redeem#response.body",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:POST /api/setup/owner-claim/redeem#response.body.code",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:POST /api/setup/owner-claim/redeem#response.body.error",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:POST /api/setup/owner-claim/redeem#response.body.message",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "http:request_response:PUT /api/codex/preference",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "http:request_response:PUT /api/setup/owner-claim",
    "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu"
  ],
  [
    "relay:client_to_server:relay:codex-event",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "relay:client_to_server:relay:codex-event#event",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "relay:client_to_server:relay:codex-request",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "relay:client_to_server:relay:codex-status",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "relay:client_to_server:relay:mcp-configure-result",
    "debt.wire.http.request.response.get.api.mcp.servers.1j7qk9f"
  ],
  [
    "relay:client_to_server:relay:mcp-preflight-result",
    "debt.wire.http.request.response.get.api.mcp.servers.1j7qk9f"
  ],
  [
    "relay:client_to_server:relay:run-shell-progress",
    "debt.wire.relay.client.to.server.relay.result.1bl4tr5"
  ],
  [
    "relay:client_to_server:relay:ssh-prepared",
    "debt.wire.relay.client.to.server.relay.result.1bl4tr5"
  ],
  [
    "relay:client_to_server:relay:ssh-prepared#failure.code",
    "debt.wire.relay.client.to.server.relay.result.1bl4tr5"
  ],
  [
    "relay:client_to_server:relay:structured-ssh-progress",
    "debt.wire.relay.client.to.server.relay.result.1bl4tr5"
  ],
  [
    "relay:client_to_server_arbitrary:packages/relay/src/protocol.ts#RelaySshPreparedMessage",
    "debt.wire.relay.client.to.server.relay.result.1bl4tr5"
  ],
  [
    "relay:client_to_server_arbitrary:packages/relay/src/protocol.ts#RelaySshPreparedMessage#failure.code",
    "debt.wire.relay.client.to.server.relay.result.1bl4tr5"
  ],
  [
    "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayClientMessage#failure.code",
    "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
  ],
  [
    "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayServerMessage#server.transport",
    "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
  ],
  [
    "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelaySshResolutionFailure",
    "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
  ],
  [
    "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelaySshResolutionFailure#code",
    "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
  ],
  [
    "relay:server_to_client:relay:codex-cancel",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "relay:server_to_client:relay:codex-command",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "relay:server_to_client:relay:codex-credit",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "relay:server_to_client:relay:codex-request-response",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "relay:server_to_client:relay:codex-request-response#response.answers",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "relay:server_to_client:relay:mcp-preflight",
    "debt.wire.http.request.response.get.api.mcp.servers.1j7qk9f"
  ],
  [
    "relay:server_to_client:relay:mcp-preflight#server.transport",
    "debt.wire.http.request.response.get.api.mcp.servers.1j7qk9f"
  ],
  [
    "relay:server_to_client:relay:ssh-prepare",
    "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
  ],
  [
    "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayMcpPreflightMessage",
    "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
  ],
  [
    "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayMcpPreflightMessage#server.transport",
    "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
  ],
  [
    "ws:server_to_client:codex.request",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "ws:server_to_client:codex.request.resolved",
    "debt.wire.http.request.response.get.api.tasks.id.gfjl0w"
  ],
  [
    "ws:server_to_client:tool.run_shell.progress",
    "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
  ],
  [
    "ws:server_to_client:tool.structured_ssh.progress",
    "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
  ]
] as const;
const BOUNDED_WIRE = [
  "http:request_response:DELETE /api/push/installations/:bindingId",
  "http:request_response:GET /api/acp/harnesses",
  "http:request_response:GET /api/push/installations/:bindingId",
  "http:request_response:GET /api/setup/research-provider",
  "http:request_response:GET /api/skills/tool-options",
  "http:request_response:PATCH /api/push/installations/:bindingId",
  "http:request_response:POST /api/acp/harnesses/:harnessId/readiness",
  "http:request_response:POST /api/acp/harnesses/:harnessId/readiness#request.body",
  "http:request_response:POST /api/push/installations/:bindingId/test",
  "http:request_response:PUT /api/setup/research-provider"
] as const;
const SECRET_WIRE = [
  "http:request_response:POST /api/push/installations",
  "http:request_response:POST /api/push/installations/:bindingId/revoke"
] as const;

const CODEX_CONTENT_DB_LOCATORS = CODEX_DB_LOCATORS.filter((locator) =>
  locator.startsWith("public.codex_account_profiles")
  || locator === "public.codex_user_input_requests"
  || locator === "public.codex_user_input_requests.questions"
);
const CODEX_METADATA_DB_LOCATORS = CODEX_DB_LOCATORS.filter(
  (locator) => !CODEX_CONTENT_DB_LOCATORS.includes(locator),
);

const PUSH_SECRET_FIELDS = new Set(["public.push_installation_bindings", "public.push_installation_bindings.token_key_version", "public.push_installation_bindings.token_nonce_base64", "public.push_installation_bindings.token_ciphertext_base64", "public.push_installation_bindings.token_auth_tag_base64", "public.push_installation_bindings.revoke_verifier_digest"]);

export const REVIEWED_MAIN_2026_08_11_COVERAGE_ENTRIES: readonly EncryptionCoverageEntry[] = [
  ...CODEX_METADATA_DB_LOCATORS.map((locator, index) => boundedCodexDb(`db.main-2026-08-11.codex-metadata-${index + 1}`, locator)),
  ...PUSH_DB_LOCATORS.map((locator, index) => PUSH_SECRET_FIELDS.has(locator) ? operatorSecret(`db.main-2026-08-11.push-secret-${index + 1}`, "db", locator) : boundedDb(`db.main-2026-08-11.push-metadata-${index + 1}`, locator)),
  ...BOUNDED_WIRE.map((locator, index): EncryptionCoverageEntry => ({ id: `wire.main-2026-08-11.bounded-${index + 1}`, surface: "wire", locator, owner: "packages/server", readers: ["apps/mobile/src", "apps/workbench/src"], writers: ["packages/server/src/routes"], migrationState: "not_applicable", retention: "The authenticated response is transient; durable state remains in its separately inventoried owner-scoped repository.", testEvidence: [locator.includes("push/installations") ? PUSH_ROUTE_EVIDENCE : "packages/server/tests/unit-isolated/setup-keys.test.ts"], classification: "bounded_metadata", metadataAllowlist: locator.includes("push/installations") ? ["binding_id", "installation_id", "platform", "token_generation", "enabled", "permission", "state", "updated_at", "notification_id", "accepted"] : locator.includes("acp/") ? ["harness_id", "relay_id", "state", "action", "label", "description"] : locator.includes("skills/") ? ["name", "label", "description", "category"] : ["provider", "tavily_configured", "desktop_reader_available", "keyless_search_available"], plaintextReason: "The exact contract contains only authenticated capability/status coordinates, fixed enums, public descriptions, or bounded operational state and excludes Human content and secret values." })),
  ...SECRET_WIRE.map((locator, index) => operatorSecret(`wire.main-2026-08-11.push-secret-${index + 1}`, "wire", locator)),
];

export const REVIEWED_MAIN_2026_08_11_DEBT_LINKS: readonly ReviewedDebtLink[] = [
  ...CODEX_CONTENT_DB_LOCATORS.map((locator, index) => {
    const accountProjection = locator.startsWith("public.codex_account_profiles");
    return { id: `debt-link.db.main-2026-08-11.codex-content-${index + 1}`, surface: "db" as const, locator, owner: "packages/db", targetDebtIds: accountProjection ? ["debt.db.public.users.email"] : ["debt.db.public.tasks.prompt"], reason: accountProjection ? "The Codex account projection contains the owning Human's account identity, chosen label, plan, and usage history. It remains blocked by the frozen Human-profile plaintext class instead of being mislabeled as operational metadata." : "The durable Codex input projection repeats Human-facing question and option text from the owning Task workflow, so it inherits that frozen Task-content release impact.", testEvidence: [CODEX_SCHEMA_EVIDENCE], crossBoundaryProjection: { fields: accountProjection ? ["account_email", "label", "plan_type", "usage_snapshot"] : ["questions"], rationale: accountProjection ? "Codex account identity and usage are a provider-specific projection of the owning Human profile." : "Codex questions are a bounded presentation of Human-facing prompt content from the owning Task." } };
  }),
  ...LEGACY_DB_LOCATORS.map((locator, index) => { const table=locator.split(".").slice(0,2).join(".") as keyof typeof legacyTargets; return { id: `debt-link.db.main-2026-08-11-existing-table-${index + 1}`, surface: "db" as const, locator, owner: "packages/db", targetDebtIds: [legacyTargets[table]], reason: "This added lifecycle field belongs to an already frozen plaintext table boundary and inherits that table release impact; it does not create a new independent content class.", testEvidence: [table === "public.invites" ? OWNER_EVIDENCE : table === "public.mcp_servers" ? MCP_EVIDENCE : OWNER_EVIDENCE] }; }),
  ...WIRE_DEBT.map(([locator, targetDebtId], index) => ({ id: `debt-link.wire.main-2026-08-11-${index + 1}`, surface: "wire" as const, locator, owner: owner(locator), targetDebtIds: [targetDebtId], reason: locator.includes("owner-claim") ? "The owner-claim route is a body-carried representation of the frozen invite redemption/profile boundary and can carry the same claim, Human profile, PIN, recovery, and failure material." : locator.includes("codex") ? "The Codex control or event surface carries the same Human work, account identity, prompts, answers, and execution results already blocked by the frozen Task boundary; it is not reclassified as metadata." : locator.includes("rooms/search") ? "Search returns labels, participants, and message snippets from the same frozen Room-detail and message-content boundary." : locator.includes("mcp") ? "This MCP status/config projection reuses the already frozen MCP connection boundary, including transport configuration, and inherits its release impact." : "This Relay or realtime frame is another representation of the frozen Relay dispatch/result boundary and can carry execution, host, path, progress, or failure context.", testEvidence: [locator.includes("owner-claim") ? OWNER_EVIDENCE : locator.includes("codex") && locator.startsWith("http:") ? (locator.includes("requests") ? CODEX_REQUEST_EVIDENCE : CODEX_ROUTE_EVIDENCE) : locator.includes("mcp") && locator.startsWith("http:") ? MCP_EVIDENCE : locator.includes("rooms/search") ? "packages/server/tests/unit-isolated/sessions-guest-leak.test.ts" : RELAY_EVIDENCE] })),
];
