import type { EncryptionCoverageEntry } from "../src/model";
import type { RetiredFrozenDebt, ReviewedDebtLink } from "../src/registry";

const REVIEW_EVIDENCE =
  "packages/encryption-invariants/tests/integration/reviewed-main-2026-10-13-coverage.test.ts";

export const REVIEWED_MAIN_2026_10_13_UNRESOLVED_LOCATORS = new Set<string>([
  "public.invites.token",
  "public.invite_redemptions.join_message",
  "public.moderation_actions",
  "public.moderation_actions.private_note",
  "public.moderation_actions.reason",
  "http:request_response:GET /api/invites/:id/share",
  "http:request_response:GET /api/invites/:token/enrollment-review",
  "http:request_response:GET /api/moderation/enrollment",
  "http:request_response:GET /api/moderation/person",
  "http:request_response:GET /join",
  "http:request_response:POST /api/invites/:token/enrollment-review",
  "http:request_response:POST /api/moderation/actions",
  "http:request_response:POST /api/moderation/actions#request.body",
]);

const METADATA_LOCATORS = [
  "bin/nautilo-dev/src/lib/restore-migrations.ts#postRestore:raw_sql:insert:public.server_moderation_policy:1",
  "public.invite_redemptions.bound_admission_epoch",
  "public.invite_redemptions.completion_admission_epoch",
  "public.invite_redemptions.review_revision",
  "public.invite_redemptions.review_state",
  "public.invite_redemptions.reviewed_at",
  "public.llm_usage_events.attempt_outcome",
  "public.llm_usage_events.cost_state",
  "public.llm_usage_events.credential_id",
  "public.llm_usage_events.credential_revision",
  "public.llm_usage_events.endpoint",
  "public.llm_usage_events.failure_code",
  "public.llm_usage_events.funding_kind",
  "public.llm_usage_events.provider_request_id",
  "public.llm_usage_events.provider_route",
  "public.llm_usage_events.recovery_state",
  "public.llm_usage_events.serving_provider",
  "public.llm_usage_events.settled_at",
  "public.llm_usage_events.updated_at",
  "public.message_deletion_receipts.authority",
  "public.message_deletion_receipts.committed_at",
  "public.message_deletion_receipts.moderation_operation_id",
  "public.message_deletion_receipts.operation_id",
  "public.message_deletion_receipts.outcome",
  "public.message_deletion_receipts.report_id",
  "public.message_deletion_receipts.source",
  "public.moderation_actions.action",
  "public.moderation_actions.audit_recorded_at",
  "public.moderation_actions.community_messages_deleted_at",
  "public.moderation_actions.converged_at",
  "public.moderation_actions.created_at",
  "public.moderation_actions.delete_community_messages",
  "public.moderation_actions.expires_at",
  "public.moderation_actions.operation_id",
  "public.moderation_actions.request_digest",
  "public.moderation_actions.restriction_id",
  "public.moderation_actions.subject_id",
  "public.moderation_restrictions.create_operation_id",
  "public.moderation_restrictions.expires_at",
  "public.moderation_restrictions.id",
  "public.moderation_restrictions.kind",
  "public.moderation_restrictions.lift_operation_id",
  "public.moderation_restrictions.lifted_at",
  "public.moderation_restrictions.revision",
  "public.moderation_restrictions.starts_at",
  "public.moderation_restrictions.subject_id",
  "public.moderation_subjects.created_at",
  "public.moderation_subjects.id",
  "public.moderation_subjects.identity_digest",
  "public.personal_capability_preferences.created_at",
  "public.personal_capability_preferences.overrides",
  "public.personal_capability_preferences.revision",
  "public.personal_capability_preferences.updated_at",
  "public.personal_provider_credentials.created_at",
  "public.personal_provider_credentials.destination",
  "public.personal_provider_credentials.format_version",
  "public.personal_provider_credentials.id",
  "public.personal_provider_credentials.provider",
  "public.personal_provider_credentials.receipt_read_status",
  "public.personal_provider_credentials.revision",
  "public.personal_provider_credentials.updated_at",
  "public.personal_provider_credentials.validated_at",
  "public.personal_provider_credentials.validation_status",
  "public.provider_cost_events.attempt_outcome",
  "public.provider_cost_events.credential_id",
  "public.provider_cost_events.credential_revision",
  "public.provider_cost_events.failure_code",
  "public.provider_cost_events.funding_kind",
  "public.provider_cost_events.measured_units",
  "public.provider_cost_events.pricing_version",
  "public.provider_cost_events.provider_route",
  "public.provider_cost_events.request_reference",
  "public.provider_cost_events.unit_type",
  "public.provider_cost_events.workload",
  "public.reflection_record_search_projections.room_anchor_commitment",
  "public.reflection_record_semantic_work.completion_outcome",
  "public.reflection_record_semantic_work.failure_detail",
  "public.reflection_record_semantic_work.projection_refresh_only",
  "public.reflection_record_semantic_work.recovery_policy_version",
  "public.reflection_record_semantic_work.waiting_reason",
  "public.rooms.deleted_thread_last_reply_at",
  "public.rooms.deleted_thread_reply_count",
  "public.rooms.deleted_thread_summary_revision",
  "public.rooms.discoverable",
  "public.server_admission.admitted",
  "public.server_admission.epoch",
  "public.server_admission.operation_id",
  "public.server_model_config.prefer_surplus",
  "public.server_model_config.speech_model",
  "public.server_moderation_policy.approval_required",
  "public.server_moderation_policy.enabled",
  "public.server_moderation_policy.joins_paused",
  "public.server_moderation_policy.revision",
  "public.server_moderation_policy.singleton",
  "public.server_moderation_policy.updated_at",
  "public.server_provider_policy",
  "public.server_provider_policy.allow_personal_provider_keys",
  "public.server_provider_policy.funding_preference",
  "public.server_provider_policy.id",
  "public.server_provider_policy.updated_at",
  "public.server_public_join.revision",
  "public.server_public_join.singleton",
  "public.server_public_join.updated_at",
  "public.soul_generation_attempts.id",
  "public.soul_generation_attempts.started_at",
  "http:request_response:DELETE /api/account/provider-credentials/:provider",
  "http:request_response:DELETE /api/account/provider-credentials/:provider#response.body",
  "http:request_response:DELETE /api/setup/keys/:provider",
  "http:request_response:DELETE /api/setup/keys/:provider#request.params.provider",
  "http:request_response:GET /api/account/capability-preferences",
  "http:request_response:GET /api/account/provider-credentials",
  "http:request_response:GET /api/account/provider-credentials#response.body",
  "http:request_response:GET /api/account/provider-credentials#response.body.credentials[].masked",
  "http:request_response:GET /api/admin/public-join",
  "http:request_response:GET /api/admin/server-provider-policy",
  "http:request_response:GET /api/config/models/caller",
  "http:request_response:GET /api/config/models/caller#request.query",
  "http:request_response:GET /api/health/personal-provider-custody",
  "http:request_response:GET /api/moderation/actions/:operationId",
  "http:request_response:GET /api/moderation/policy",
  "http:request_response:GET /api/security/message-deletions",
  "http:request_response:POST /api/account/provider-credentials/:provider/validate",
  "http:request_response:POST /api/account/provider-credentials/:provider/validate#response.body",
  "http:request_response:POST /api/admin/server-provider-policy",
  "http:request_response:POST /api/admin/server-provider-policy#response.body.error",
  "http:request_response:POST /api/moderation/enrollment/decision",
  "http:request_response:PUT /api/account/capability-preferences",
  "http:request_response:PUT /api/account/provider-credentials/:provider#response.body",
  "http:request_response:PUT /api/admin/public-join",
  "http:request_response:PUT /api/moderation/policy",
  "ws:client_to_server:voice.consumed",
  "ws:client_to_server:voice.listen",
  "ws:server_to_client:voice.turn.end"
] as const;
const OPERATOR_SECRET_LOCATORS = [
  "public.personal_provider_credentials",
  "public.personal_provider_credentials.auth_tag_base64",
  "public.personal_provider_credentials.ciphertext_base64",
  "public.personal_provider_credentials.key_id",
  "public.personal_provider_credentials.nonce_base64",
  "http:request_response:PUT /api/account/provider-credentials/:provider"
] as const;

function surfaceFor(locator: string): "db" | "wire" {
  return locator.startsWith("public.") || locator.startsWith("bin/") ? "db" : "wire";
}

function ownerFor(locator: string): string {
  if (locator.startsWith("bin/")) return "bin/nautilo-dev";
  if (locator.startsWith("relay:")) return "packages/relay";
  if (locator.startsWith("ws:")) return "packages/realtime-client";
  return locator.startsWith("public.") ? "packages/db" : "packages/server";
}

function evidenceFor(locator: string): readonly string[] {
  if (locator.includes("personal_provider") || locator.includes("provider-credentials")) {
    return [REVIEW_EVIDENCE, "packages/server/tests/unit/personal-provider-credentials-route.test.ts"];
  }
  if (locator.includes("moderation") || locator.includes("message_deletion")) {
    return [REVIEW_EVIDENCE, "packages/server/tests/integration/moderation-controls-journey.integration.test.ts"];
  }
  if (locator.includes("invite") || locator === "http:request_response:GET /join") {
    return [REVIEW_EVIDENCE, "packages/server/tests/integration/recoverable-invites.integration.test.ts"];
  }
  if (locator.includes("reflection_record")) {
    return [REVIEW_EVIDENCE, "packages/db/tests/unit/reflection-record-schema.test.ts"];
  }
  if (locator.startsWith("relay:")) {
    return [REVIEW_EVIDENCE, "packages/relay/tests/unit/local-execution-delegation.test.ts"];
  }
  if (locator.startsWith("ws:")) {
    return [REVIEW_EVIDENCE, "packages/server/tests/unit/voice-delivery.test.ts"];
  }
  if (locator.includes("cost") || locator.includes("llm_usage")) {
    return [REVIEW_EVIDENCE, "packages/db/tests/unit/provider-costs.test.ts"];
  }
  if (locator.startsWith("bin/")) {
    return [REVIEW_EVIDENCE, "bin/nautilo-dev/tests/unit/restore-migrations.test.ts"];
  }
  return [REVIEW_EVIDENCE];
}

function plaintextReasonFor(locator: string): string {
  if (locator.includes("reflection_record")) {
    return "This exact Reflection coordinate is limited by schema checks to opaque commitments, fixed outcomes, recovery versions, and closed waiting or failure codes; it cannot contain a prompt, Message body, generated reflection, credential, or private key.";
  }
  if (locator.includes("cost") || locator.includes("llm_usage")) {
    return "This exact funding coordinate contains only provider routing labels, opaque receipt identifiers, fixed attempt and recovery states, revisions, units, timestamps, and numeric cost telemetry; it excludes prompts, provider credentials, response bodies, and private keys.";
  }
  if (locator.includes("moderation") || locator.includes("message_deletion")) {
    return "This exact moderation coordinate is restricted to opaque identities, operation digests, fixed decisions, lifecycle timestamps, counters, and deletion receipts. Human-authored reasons, notes, and enrollment text are separately retained on frozen content debt and are absent here.";
  }
  if (locator.includes("provider-credentials") || locator.includes("personal_provider")) {
    return "This exact credential-control coordinate contains only masked presentation, provider identity, revisions, fixed validation state, timestamps, or deletion status. Raw credentials and durable encrypted envelope fields are separately classified as operator secrets.";
  }
  if (locator.startsWith("relay:")) {
    return "This exact Relay coordinate contains only the closed dispatch envelope selected here. Open GitHub, terminal, and local-execution subtrees remain on the frozen Relay dispatch debt and are not admitted by this metadata review.";
  }
  if (locator.startsWith("ws:")) {
    return "This exact voice frame contains only opaque stream or actor identifiers, a sample counter, a boolean listen state, or a closed turn outcome; it excludes audio samples, transcripts, credentials, and private keys.";
  }
  return "This exact coordinate is schema-bounded to opaque entity or operation identifiers, fixed enums and booleans, counters, revisions, digests, timestamps, or public configuration state; it excludes Human-authored content, credentials, private keys, and protected payload bytes.";
}

export const REVIEWED_MAIN_2026_10_13_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
  ...METADATA_LOCATORS.map((locator, index): EncryptionCoverageEntry => ({
    id: `main.2026-10-13.metadata.${index + 1}`,
    surface: surfaceFor(locator),
    locator,
    owner: ownerFor(locator),
    readers: [ownerFor(locator)],
    writers: [ownerFor(locator)],
    migrationState: "not_applicable",
    retention: "Retained only for the owning control-plane, financial, moderation, configuration, or delivery lifecycle represented by this exact coordinate.",
    testEvidence: evidenceFor(locator),
    classification: "bounded_metadata",
    metadataAllowlist: [locator],
    plaintextReason: plaintextReasonFor(locator),
  })),
  ...OPERATOR_SECRET_LOCATORS.map((locator, index): EncryptionCoverageEntry => ({
    id: `main.2026-10-13.operator-secret.${index + 1}`,
    surface: surfaceFor(locator),
    locator,
    owner: ownerFor(locator),
    readers: ["authenticated credential owner and canonical provider-custody service"],
    writers: ["authenticated credential owner through canonical provider-custody service"],
    migrationState: "not_applicable",
    retention: locator.startsWith("public.")
      ? "The versioned AES-GCM envelope remains only until its owning Human replaces or deletes the provider credential."
      : "Raw credential input exists only for the authenticated request and is discarded after canonical custody encrypts or rejects it.",
    testEvidence: evidenceFor(locator),
    classification: "operator_secret",
    secretStoreLocation: locator.startsWith("public.")
      ? "The product database stores only the versioned AES-GCM ciphertext envelope, nonce, authentication tag, and key identifier; the plaintext provider credential is absent."
      : "Authenticated request memory only, immediately handed to the canonical personal-provider custody boundary for encryption.",
    backupProcedure: locator.startsWith("public.")
      ? "Database backups retain the encrypted envelope only; recovery still requires the separately held custody key."
      : "Raw request memory is not backed up; the Human must present the credential again after loss.",
    excludedFromAgentGrants: true,
  })),
];

const REVIEWED_LINK_INPUTS = [
  {
    "surface": "db",
    "locator": "public.group_moderation_scopes",
    "targetDebtIds": [
      "debt.db.public.groups.id",
      "debt.db.public.rooms.id"
    ],
    "fields": [
      "group_id",
      "room_id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.group_moderation_scopes.group_id",
    "targetDebtIds": [
      "debt.db.public.groups.id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.group_moderation_scopes.room_id",
    "targetDebtIds": [
      "debt.db.public.rooms.id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.invite_redemptions.reviewed_by",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.llm_usage_events.payer_human_id",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.message_deletion_receipts",
    "targetDebtIds": [
      "debt.db.public.agents.id",
      "debt.db.public.users.id",
      "debt.db.public.session_messages.id",
      "debt.db.public.rooms.id"
    ],
    "fields": [
      "actor_id",
      "actor_user_id",
      "message_id",
      "room_id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.message_deletion_receipts.actor_id",
    "targetDebtIds": [
      "debt.db.public.agents.id",
      "debt.db.public.users.id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.message_deletion_receipts.actor_user_id",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.message_deletion_receipts.message_id",
    "targetDebtIds": [
      "debt.db.public.session_messages.id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.message_deletion_receipts.room_id",
    "targetDebtIds": [
      "debt.db.public.rooms.id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.moderation_actions.requester_user_id",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.moderation_actions.room_id",
    "targetDebtIds": [
      "debt.db.public.rooms.id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.moderation_restrictions",
    "targetDebtIds": [
      "debt.db.public.rooms.id"
    ],
    "fields": [
      "room_id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.moderation_restrictions.room_id",
    "targetDebtIds": [
      "debt.db.public.rooms.id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.moderation_subjects",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ],
    "fields": [
      "user_id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.moderation_subjects.user_id",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.personal_capability_preferences",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ],
    "fields": [
      "user_id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.personal_capability_preferences.user_id",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.personal_provider_credentials.user_id",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.provider_cost_events.job_id",
    "targetDebtIds": [
      "debt.db.public.jobs.id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.provider_cost_events.payer_human_id",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.provider_cost_events.run_id",
    "targetDebtIds": [
      "debt.db.public.task_runs.id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.rooms.deleted_thread_root_message_id",
    "targetDebtIds": [
      "debt.db.public.session_messages.id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.server_admission",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ],
    "fields": [
      "user_id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.server_admission.user_id",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.server_moderation_policy",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ],
    "fields": [
      "updated_by"
    ]
  },
  {
    "surface": "db",
    "locator": "public.server_moderation_policy.updated_by",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.server_public_join",
    "targetDebtIds": [
      "debt.db.public.invites.id",
      "debt.db.public.users.id"
    ],
    "fields": [
      "invite_id",
      "updated_by"
    ]
  },
  {
    "surface": "db",
    "locator": "public.server_public_join.invite_id",
    "targetDebtIds": [
      "debt.db.public.invites.id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.server_public_join.updated_by",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.soul_generation_attempts",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ],
    "fields": [
      "human_user_id"
    ]
  },
  {
    "surface": "db",
    "locator": "public.soul_generation_attempts.human_user_id",
    "targetDebtIds": [
      "debt.db.public.users.id"
    ]
  },
  {
    "surface": "wire",
    "locator": "http:request_response:GET /api/account/costs",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.costs.vkk56s"
    ]
  },
  {
    "surface": "wire",
    "locator": "http:request_response:GET /api/account/costs#request.query",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.costs.vkk56s"
    ]
  },
  {
    "surface": "wire",
    "locator": "http:request_response:GET /api/moderation/people",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.admin.users.12jlf0u"
    ]
  },
  {
    "surface": "wire",
    "locator": "http:request_response:GET /api/rooms/:id/presence",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.users.id.presence.s5a44y"
    ]
  },
  {
    "surface": "wire",
    "locator": "http:request_response:POST /api/admin/server-models#request.body",
    "targetDebtIds": [
      "debt.wire.http.request.response.post.api.admin.server.models.1nyrg5s"
    ]
  },
  {
    "surface": "wire",
    "locator": "http:request_response:PUT /api/security/posture#request.body.localNetworkPolicy",
    "targetDebtIds": [
      "debt.wire.http.request.response.put.api.security.posture.du15aa"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayDispatchRequest#githubBinding",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayDispatchRequest#humanTerminalBinding.owner",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayDispatchRequest#localExecutionBinding.authority.delegation",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayDispatchRequest#localExecutionDelegationCapture.source",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayDispatchRequest#localExecutionDelegationCapture.source.target",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayDispatchRequest#localExecutionHistoryBinding.reader",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayHumanTerminalBinding",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayHumanTerminalBinding#owner",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayLocalExecutionBinding",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayLocalExecutionBinding#authority.delegation",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayLocalExecutionBindingV4",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayLocalExecutionBindingV4#authority.delegation",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayLocalExecutionDelegationCapture",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayLocalExecutionDelegationCapture#source",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayLocalExecutionDelegationCapture#source.target",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayLocalExecutionHistoryBindingV1",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayLocalExecutionHistoryBindingV1#reader",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayServerMessage#githubBinding",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayServerMessage#humanTerminalBinding.owner",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayServerMessage#localExecutionBinding.authority.delegation",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayServerMessage#localExecutionDelegationCapture.source",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayServerMessage#localExecutionDelegationCapture.source.target",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayServerMessage#localExecutionHistoryBinding.reader",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:server_to_client:relay:dispatch#githubBinding",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:server_to_client:relay:dispatch#humanTerminalBinding.owner",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:server_to_client:relay:dispatch#localExecutionBinding.authority.delegation",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:server_to_client:relay:dispatch#localExecutionDelegationCapture.source",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:server_to_client:relay:dispatch#localExecutionDelegationCapture.source.target",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:server_to_client:relay:dispatch#localExecutionHistoryBinding.reader",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage#githubBinding",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage#humanTerminalBinding.owner",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage#localExecutionBinding.authority.delegation",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage#localExecutionDelegationCapture.source",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage#localExecutionDelegationCapture.source.target",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  },
  {
    "surface": "wire",
    "locator": "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage#localExecutionHistoryBinding.reader",
    "targetDebtIds": [
      "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    ]
  }
] as const;

function debtReason(locator: string, targets: readonly string[]): string {
  if (locator.startsWith("relay:")) {
    return "This exact open Relay binding is part of the already-frozen relay:dispatch payload and can carry repository text, terminal ownership, local paths, or execution authority; it remains on that same transport debt instead of being relabelled metadata.";
  }
  if (locator.startsWith("public.")) {
    return targets.some((target) => target.endsWith("session_messages.content"))
      ? "This exact field stores Human-authored moderation or enrollment text projected from the already-frozen Message-content class; it creates no broader content channel."
      : "This exact field or table root retains only the named opaque Human, Agent, Room, Message, Task-run, Job, Group, or Invite coordinates already present in frozen database debt; any unrelated fields are independently classified.";
  }
  return "This exact authenticated route projects the named already-frozen wire content or identity class for the same product operation; it does not authorize a broader payload or a different custody domain.";
}

export const REVIEWED_MAIN_2026_10_13_DEBT_LINKS:
  readonly ReviewedDebtLink[] = REVIEWED_LINK_INPUTS.map((item, index) => ({
  id: `main.2026-10-13.debt-link.${index + 1}`,
  surface: item.surface,
  locator: item.locator,
  owner: ownerFor(item.locator),
  targetDebtIds: item.targetDebtIds,
  reason: debtReason(item.locator, item.targetDebtIds),
  testEvidence: evidenceFor(item.locator),
  ...(item.surface !== "db" ? {} : {
    crossBoundaryProjection: {
      fields: "fields" in item
        ? item.fields
        : [item.locator.split(".").at(-1)!],
      rationale: "Every listed field is an exact projection of the named frozen plaintext identity or Human-content class; no wildcard, adjacent field, credential, or new content store is admitted.",
    },
  }),
}));

export const RETIRED_MAIN_2026_10_13_FROZEN_DEBT:
  readonly RetiredFrozenDebt[] = [{
  debtId: "debt.wire.arbitrary.19gu260",
  reason: "The current app-runtime response no longer exposes tool inputSchema, so the exact frozen wire observation is absent and is retired without changing the immutable debt snapshot.",
  testEvidence: [
    REVIEW_EVIDENCE,
    "packages/encryption-invariants/tests/integration/reviewed-main-2026-10-13-dto.test.ts",
  ],
}];
