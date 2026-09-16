import type { EncryptionCoverageEntry } from "../src/model";

const REVIEW_EVIDENCE =
  "packages/encryption-invariants/tests/integration/reviewed-main-2026-08-20-security.test.ts";

const PROTECTED_DATABASE_LOCATORS = [
  "packages/lattice-bridge/src/server/delivery/postgres-domain-transition-lease-repository.ts#claimExact:raw_sql:update:public.crypto_domain_transition_steps:1",
  "packages/lattice-bridge/src/server/device/production-additional-device.ts#prepareEnrollmentAuthorization:raw_sql:update:public.human_crypto_custodies:1"
] as const;
const PROTECTED_DEVICE_ROUTES = [
  "http:request_response:POST /api/protected/devices/additional/:operationId/ack",
  "http:request_response:POST /api/protected/devices/additional/:operationId/activate",
  "http:request_response:POST /api/protected/devices/additional/:operationId/approve",
  "http:request_response:POST /api/protected/devices/additional/:operationId/deliveries",
  "http:request_response:POST /api/protected/devices/additional/:operationId/join-packages",
  "http:request_response:POST /api/protected/devices/additional/:operationId/transition-plan",
  "http:request_response:POST /api/protected/devices/additional/:operationId/transitions",
  "http:request_response:POST /api/protected/devices/additional/begin",
  "http:request_response:POST /api/protected/devices/additional/pending",
  "http:request_response:POST /api/protected/devices/initial-bootstrap/begin",
  "http:request_response:POST /api/protected/devices/initial-bootstrap/complete",
  "http:request_response:POST /api/protected/devices/initial-bootstrap/receipt",
  "http:request_response:POST /api/protected/devices/initial-domain",
  "http:request_response:POST /api/protected/devices/initial-domain/plan"
] as const;
const BOUNDED_METADATA_LOCATORS = [
  [
    "db",
    "packages/db/src/utils/encryption-transition-observations.ts#recordObservationInTransaction:raw_sql:delete:public.encryption_transition_observation_buckets:1"
  ],
  [
    "db",
    "packages/lattice-bridge/src/server/message/postgres-conversation-product-store.ts#allocateExistingRepresentation:raw_sql:insert:public.session_message_crypto_revisions:1"
  ],
  [
    "db",
    "packages/reflection-bridge/scripts/run-postgres-integration.ts#<module>:raw_sql:insert:public.reflection_record_semantic_work:1"
  ],
  [
    "db",
    "packages/reflection-bridge/scripts/run-postgres-integration.ts#<module>:raw_sql:insert:public.reflection_record_semantic_work_admissions:1"
  ],
  [
    "db",
    "packages/server/src/lib/user-account-deletion.ts#deleteLocalUserAccount:raw_sql:delete:public.media_generations:1"
  ],
  [
    "db",
    "packages/server/src/lib/user-account-deletion.ts#deleteLocalUserAccount:raw_sql:update:public.media_generations:1"
  ],
  [
    "db",
    "public.account_deletion_photo_cleanup"
  ],
  [
    "db",
    "public.account_deletion_photo_cleanup.attempts"
  ],
  [
    "db",
    "public.account_deletion_photo_cleanup.avatar_kind"
  ],
  [
    "db",
    "public.account_deletion_photo_cleanup.blob_id"
  ],
  [
    "db",
    "public.account_deletion_photo_cleanup.claim_token"
  ],
  [
    "db",
    "public.account_deletion_photo_cleanup.claimed_at"
  ],
  [
    "db",
    "public.account_deletion_photo_cleanup.created_at"
  ],
  [
    "db",
    "public.account_deletion_photo_cleanup.id"
  ],
  [
    "db",
    "public.account_deletion_photo_cleanup.server_instance_id"
  ],
  [
    "db",
    "public.artifacts.crypto_mapping_state"
  ],
  [
    "db",
    "public.codex_account_profiles.registration_state"
  ],
  [
    "db",
    "public.encryption_transition_observation_admissions"
  ],
  [
    "db",
    "public.encryption_transition_observation_admissions.created_at"
  ],
  [
    "db",
    "public.encryption_transition_observation_admissions.expires_at"
  ],
  [
    "db",
    "public.encryption_transition_observation_admissions.family"
  ],
  [
    "db",
    "public.encryption_transition_observation_admissions.operation"
  ],
  [
    "db",
    "public.encryption_transition_observation_admissions.policy_revision"
  ],
  [
    "db",
    "public.encryption_transition_observation_admissions.token_digest"
  ],
  [
    "db",
    "public.encryption_transition_observation_buckets"
  ],
  [
    "db",
    "public.encryption_transition_observation_buckets.attempt_count"
  ],
  [
    "db",
    "public.encryption_transition_observation_buckets.bounds_revision"
  ],
  [
    "db",
    "public.encryption_transition_observation_buckets.bucket_started_at"
  ],
  [
    "db",
    "public.encryption_transition_observation_buckets.bucket_width_ms"
  ],
  [
    "db",
    "public.encryption_transition_observation_buckets.family"
  ],
  [
    "db",
    "public.encryption_transition_observation_buckets.latency_bucket"
  ],
  [
    "db",
    "public.encryption_transition_observation_buckets.operation"
  ],
  [
    "db",
    "public.encryption_transition_observation_buckets.outcome"
  ],
  [
    "db",
    "public.encryption_transition_observation_buckets.policy_revision"
  ],
  [
    "db",
    "public.encryption_transition_observation_buckets.reason"
  ],
  [
    "db",
    "public.encryption_transition_observation_buckets.updated_at"
  ],
  [
    "db",
    "public.encryption_transition_outcome_totals"
  ],
  [
    "db",
    "public.encryption_transition_outcome_totals.attempt_count"
  ],
  [
    "db",
    "public.encryption_transition_outcome_totals.family"
  ],
  [
    "db",
    "public.encryption_transition_outcome_totals.operation"
  ],
  [
    "db",
    "public.encryption_transition_outcome_totals.outcome"
  ],
  [
    "db",
    "public.encryption_transition_outcome_totals.policy_revision"
  ],
  [
    "db",
    "public.encryption_transition_outcome_totals.reason"
  ],
  [
    "db",
    "public.encryption_transition_outcome_totals.updated_at"
  ],
  [
    "db",
    "public.encryption_transition_policy"
  ],
  [
    "db",
    "public.encryption_transition_policy.created_at"
  ],
  [
    "db",
    "public.encryption_transition_policy.id"
  ],
  [
    "db",
    "public.encryption_transition_policy.mode"
  ],
  [
    "db",
    "public.encryption_transition_policy.observation_bounds_configured_at"
  ],
  [
    "db",
    "public.encryption_transition_policy.observation_bounds_revision"
  ],
  [
    "db",
    "public.encryption_transition_policy.observation_bucket_width_ms"
  ],
  [
    "db",
    "public.encryption_transition_policy.observation_latency_upper_bounds_ms"
  ],
  [
    "db",
    "public.encryption_transition_policy.observation_retention_ms"
  ],
  [
    "db",
    "public.encryption_transition_policy.observation_storage_limit_rows"
  ],
  [
    "db",
    "public.encryption_transition_policy.revision"
  ],
  [
    "db",
    "public.encryption_transition_policy.shadow_writes_started_at"
  ],
  [
    "db",
    "public.encryption_transition_policy.updated_at"
  ],
  [
    "db",
    "public.memories.crypto_mapping_state"
  ],
  [
    "db",
    "public.server_model_config.reasoning_policy"
  ],
  [
    "wire",
    "http:request_response:DELETE /api/account"
  ],
  [
    "wire",
    "http:request_response:DELETE /api/account#request.body"
  ],
  [
    "wire",
    "http:request_response:DELETE /api/admin/users/:id#response.body.code"
  ],
  [
    "wire",
    "http:request_response:DELETE /api/admin/users/:id#response.body.error"
  ],
  [
    "wire",
    "http:request_response:DELETE /api/admin/users/:id#response.body.logtoRevoked"
  ],
  [
    "wire",
    "http:request_response:GET /api/account/deletion/eligibility"
  ],
  [
    "wire",
    "http:request_response:GET /api/admin/encryption-transition"
  ],
  [
    "wire",
    "http:request_response:GET /api/admin/encryption-transition#response.body"
  ],
  [
    "wire",
    "http:request_response:GET /api/security/audit-log#response.body.events[].changes"
  ],
  [
    "wire",
    "http:request_response:POST /api/admin/encryption-transition"
  ],
  [
    "wire",
    "http:request_response:POST /api/admin/encryption-transition#response.body"
  ],
  [
    "wire",
    "http:request_response:POST /api/protected/shadow-attempts/observe"
  ],
  [
    "wire",
    "relay:declared_arbitrary:packages/relay/src/protocol.ts#DesktopAutomationInvocationBinding"
  ],
  [
    "wire",
    "relay:declared_arbitrary:packages/relay/src/protocol.ts#DesktopAutomationInvocationBinding#supportedActions[]"
  ],
  [
    "wire",
    "relay:declared_arbitrary:packages/relay/src/protocol.ts#DesktopAutomationInvocationBindingValidationResult"
  ],
  [
    "wire",
    "relay:declared_arbitrary:packages/relay/src/protocol.ts#DesktopAutomationInvocationBindingValidationResult#binding.supportedActions[]"
  ],
  [
    "wire",
    "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayDispatchRequest#desktopAutomationBinding.supportedActions[]"
  ],
  [
    "wire",
    "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayServerMessage#desktopAutomationBinding.supportedActions[]"
  ],
  [
    "wire",
    "relay:server_to_client:relay:dispatch#desktopAutomationBinding.supportedActions[]"
  ],
  [
    "wire",
    "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage#desktopAutomationBinding.supportedActions[]"
  ]
] as const;

function stableId(locator: string): string {
  return locator.replaceAll(/[^a-zA-Z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .toLowerCase();
}

const protectedDatabaseEntries: readonly EncryptionCoverageEntry[] =
  PROTECTED_DATABASE_LOCATORS.map((locator) => ({
    id: `db.main-2026-08-20.protected-${stableId(locator)}`,
    surface: "db",
    locator,
    owner: "packages/lattice-bridge",
    readers: [locator.split("#", 1)[0]!],
    writers: [locator.split("#", 1)[0]!],
    migrationState: "ciphertext_only",
    retention:
      "Retained only as signed Human device-custody or Domain-transition state.",
    testEvidence: [REVIEW_EVIDENCE],
    classification: "protected",
    keyFamily: "namespace_human",
    bridgeRepository: locator.split("#", 1)[0]!,
    negativeTestEvidence: [REVIEW_EVIDENCE],
  }));

const protectedDeviceEntries: readonly EncryptionCoverageEntry[] =
  PROTECTED_DEVICE_ROUTES.map((locator) => ({
    id: `wire.main-2026-08-20.protected-${stableId(locator)}`,
    surface: "wire",
    locator,
    owner: "packages/server",
    readers: ["packages/lattice-bridge/src/device/additional-device-client.ts"],
    writers: ["packages/server/src/routes/protected-additional-device.ts"],
    migrationState: "ciphertext_only",
    retention:
      "Request-scoped canonical protected device bootstrap transport; durable copies remain in the authenticated Human device lifecycle.",
    testEvidence: [REVIEW_EVIDENCE],
    classification: "protected",
    keyFamily: "namespace_human",
    bridgeRepository:
      "packages/lattice-bridge/src/device/additional-device-client.ts",
    negativeTestEvidence: [REVIEW_EVIDENCE],
  }));

const boundedEntries: readonly EncryptionCoverageEntry[] =
  BOUNDED_METADATA_LOCATORS.map(([surface, locator]) => ({
    id: `${surface}.main-2026-08-20.bounded-${stableId(locator)}`,
    surface,
    locator,
    owner: locator.startsWith("public.")
      || locator.startsWith("packages/db/")
      ? "packages/db"
      : locator.startsWith("packages/relay/")
      || locator.startsWith("relay:")
      ? "packages/relay"
      : locator.startsWith("packages/reflection-bridge/")
      ? "packages/reflection-bridge"
      : locator.startsWith("packages/lattice-bridge/")
      ? "packages/lattice-bridge"
      : "packages/server",
    readers: [locator.split("#", 1)[0]!],
    writers: [locator.split("#", 1)[0]!],
    migrationState: "not_applicable",
    retention:
      "Retained or transmitted only for a bounded transition, account-removal, protected-object coordinate, provider-profile, or desktop-automation lifecycle.",
    testEvidence: [REVIEW_EVIDENCE],
    classification: "bounded_metadata",
    metadataAllowlist: [
      "opaque identifiers, hashes, and revision counters",
      "closed lifecycle, operation, policy, capability, and outcome enums",
      "bounded timestamps, leases, counts, booleans, and routing coordinates",
    ],
    plaintextReason:
      "The exact surface excludes message, Memory, Artifact, Reflection statement, prompts, keys, recovery credentials, desktop arguments, and captured desktop content. It carries only the cited content-free bounded control or routing coordinates.",
  }));

export const REVIEWED_MAIN_2026_08_20_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
    ...protectedDatabaseEntries,
    ...protectedDeviceEntries,
    ...boundedEntries,
  ];

export const RETIRED_MAIN_2026_08_20_DATABASE_WRITER_LOCATORS =
  new Set<string>([
    "packages/db/src/queries/llm-usage.ts#rows:raw_sql:unresolved:unresolved.dynamic_sql:1",
    "packages/lattice-bridge/src/server/delivery/postgres-delivery-operation-reconciler.ts##failDeviceAdmission:raw_sql:insert:public.crypto_operation_outbox:1",
    "packages/lattice-bridge/src/server/delivery/postgres-delivery-operation-reconciler.ts##failHumanMembership:raw_sql:insert:public.crypto_operation_outbox:1",
    "packages/reflection-bridge/src/server/postgres-record-product-store.ts#readGraphPage:raw_sql:unresolved:unresolved.dynamic_sql:1",
    "packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#claimNext:raw_sql:update:public.reflection_record_semantic_work:2",
    "packages/runtime/src/conductor/history-search.ts#subthreadContextWindow:raw_sql:unresolved:unresolved.dynamic_sql:1",
    "packages/runtime/src/conductor/history-search.ts#subthreadContextWindow:raw_sql:unresolved:unresolved.dynamic_sql:2",
    "packages/runtime/src/conductor/history-search.ts#subthreadContextWindow:raw_sql:unresolved:unresolved.dynamic_sql:3",
    "packages/runtime/src/stenographer/repository.ts#tryClaimRoom:raw_sql:unresolved:unresolved.dynamic_sql:1",
  ]);
