import type { EncryptionCoverageEntry } from "../src/model";
import type { RetiredFrozenDebt, ReviewedDebtLink } from "../src/registry";
import { rawDatabaseWriterDebtId } from "../src/raw-database-writer-debt";

const EVIDENCE = "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-05-landing-security.test.ts";
export const LANDING_METADATA_LOCATORS = [
  "public.memory_review_turns",
  "public.memory_review_turns.access_scope",
  "public.memory_review_turns.actor_id",
  "public.memory_review_turns.agent_id",
  "public.memory_review_turns.attempt_id",
  "public.memory_review_turns.checkpoint_thread_id",
  "public.memory_review_turns.completed_at",
  "public.memory_review_turns.created_at",
  "public.memory_review_turns.failure_code",
  "public.memory_review_turns.failure_phase",
  "public.memory_review_turns.first_message_id",
  "public.memory_review_turns.generation_id",
  "public.memory_review_turns.has_human",
  "public.memory_review_turns.id",
  "public.memory_review_turns.last_attempt_at",
  "public.memory_review_turns.lease_until",
  "public.memory_review_turns.owner_id",
  "public.memory_review_turns.receipt_id",
  "public.memory_review_turns.retry_at",
  "public.memory_review_turns.room_id",
  "public.memory_review_turns.session_id",
  "public.memory_review_turns.source_ids",
  "public.memory_review_turns.state",
  "public.memory_review_turns.thread_id",
  "public.memory_review_turns.turn_id",
  "public.memory_review_turns.updated_at",
  "public.memory_review_receipts",
  "public.memory_review_receipts.actor_id",
  "public.memory_review_receipts.agent_id",
  "public.memory_review_receipts.code",
  "public.memory_review_receipts.counts",
  "public.memory_review_receipts.created_at",
  "public.memory_review_receipts.delivered",
  "public.memory_review_receipts.duration_ms",
  "public.memory_review_receipts.effects",
  "public.memory_review_receipts.id",
  "public.memory_review_receipts.model_id",
  "public.memory_review_receipts.outcome",
  "public.memory_review_receipts.owner_id",
  "public.memory_review_receipts.phase",
  "public.memory_review_receipts.work_id",
  "public.connected_web_action_operations.account_id",
  "public.connected_web_action_operations.action_type",
  "public.connected_web_action_operations.created_at",
  "public.connected_web_action_operations.delivery_id",
  "public.connected_web_action_operations.id",
  "public.connected_web_action_operations.owner_user_id",
  "public.connected_web_action_operations.request_digest",
  "public.connected_web_action_operations.status",
  "public.connected_web_action_operations.updated_at",
  "public.connected_web_operation_activity_entries.control_epoch",
  "public.connected_web_operation_activity_entries.id",
  "public.connected_web_operation_activity_entries.occurred_at",
  "public.connected_web_operation_activity_entries.operation_id",
  "public.connected_web_operation_activity_entries.provider_event_id",
  "public.connected_web_operation_activity_entries.status",
  "public.connected_web_operations.account_id",
  "public.connected_web_operations.action_operation_id",
  "public.connected_web_operations.browser_cleanup_started_at",
  "public.connected_web_operations.browser_idle_until",
  "public.connected_web_operations.control_epoch",
  "public.connected_web_operations.control_lease_expires_at",
  "public.connected_web_operations.control_lease_token",
  "public.connected_web_operations.created_at",
  "public.connected_web_operations.cumulative_cost_usd_micros",
  "public.connected_web_operations.delivery_id",
  "public.connected_web_operations.driver",
  "public.connected_web_operations.effect_idempotency_key",
  "public.connected_web_operations.event_cursor",
  "public.connected_web_operations.id",
  "public.connected_web_operations.initiating_agent_id",
  "public.connected_web_operations.initiating_lane",
  "public.connected_web_operations.initiating_room_id",
  "public.connected_web_operations.initiating_thread_id",
  "public.connected_web_operations.lifecycle",
  "public.connected_web_operations.next_check_at",
  "public.connected_web_operations.owner_user_id",
  "public.connected_web_operations.remaining_budget_usd_micros",
  "public.connected_web_operations.request_digest",
  "public.connected_web_operations.requested_wake_at",
  "public.connected_web_operations.supervisor_claim_expires_at",
  "public.connected_web_operations.supervisor_claim_owner",
  "public.connected_web_operations.terminal_at",
  "public.connected_web_operations.updated_at",
  "public.connected_web_operations.wake_attempts",
  "public.connected_web_operations.wake_claim_expires_at",
  "public.connected_web_operations.wake_claim_owner",
  "public.connected_web_operations.wake_delivered_at",
  "public.connected_web_operations.wake_fingerprint",
  "public.server_context_config.memory_review_enabled",
  "public.server_model_config.memory_review_model"
] as const;

const CONTROL_WIRE = [
  "http:request_response:GET /api/admin/memory-status",
  "http:request_response:POST /api/admin/memory-retry",
  "http:request_response:GET /api/connected-web-actions/:deliveryId/activity",
  "http:request_response:POST /api/connected-web-actions/:deliveryId/stop",
  "http:request_response:POST /api/auth/connected-web-action-reply",
  "ws:server_to_client:connected_web.action_resume_failed",
] as const;

const STATUS_SQL_LOCATORS = [
  "packages/db/src/queries/memory-review-status.ts#queryMemoryReviewStatus:raw_sql:unresolved:unresolved.dynamic_sql:1",
  "packages/db/src/queries/memory-review-status.ts#retryFailedMemoryReviews:raw_sql:unresolved:unresolved.dynamic_sql:1",
  "packages/runtime/src/memory-review/repository.ts#prune:raw_sql:delete:public.memory_review_receipts:1",
  "packages/runtime/src/memory-review/repository.ts#prune:raw_sql:delete:public.memory_review_turns:1"
] as const;

/** Caller-scoped receipt metadata, not a transcript or a retained access grant.
 * In particular memory-review-publication constructs effects from IDs/enums,
 * an empty IP and audit coordinates; its unknown[] schema is NOT permission
 * to store arbitrary model output here. */
const metadataEntries = [...LANDING_METADATA_LOCATORS, ...CONTROL_WIRE, ...STATUS_SQL_LOCATORS]
  .map((locator, index): EncryptionCoverageEntry => {
    const wire = locator.startsWith("http:") || locator.startsWith("ws:");
    return {
      id: `main.2026-09-05.landing.metadata.${index + 1}`,
      surface: wire ? "wire" : "db",
      locator,
      owner: wire ? "packages/server" : locator.startsWith("packages/runtime") ? "packages/runtime" : "packages/db",
      readers: ["packages/server", "packages/runtime"],
      writers: ["packages/server", "packages/runtime"],
      migrationState: "not_applicable",
      retention: wire ? "Authenticated request or event lifetime only." : "Owning account/work lifecycle; Memory review retains coverage anchors and unacknowledged effects.",
      testEvidence: [EVIDENCE, "packages/db/tests/unit/memory-review-status.test.ts", "packages/runtime/tests/unit/memory-review-repository.test.ts"],
      classification: "bounded_metadata",
      metadataAllowlist: [locator],
      plaintextReason: STATUS_SQL_LOCATORS.some((item) => item === locator)
        ? "The exact status builder is a read-only CTE over counts and closed failure codes; retry updates only retry/failure timestamps and codes. The two retention statements DELETE acknowledged receipts/covered turns, preserving anchors and uncertain work. Raw SQL expresses one-snapshot window aggregates or atomic CTE selection, not content insertion."
        : "Reviewed producers emit only IDs, model selection, public origins, counters, timestamps, closed control/failure states or content-free audit effects. Website targets, provider summaries, text results, credentials and sealed authority are classified separately and are not covered by this metadata declaration.",
    };
  });

export const LANDING_CONTENT_PROJECTIONS = [
  [
    "public.connected_web_action_operations",
    [
      "target",
      "receipt"
    ]
  ],
  [
    "public.connected_web_action_operations.target",
    [
      "target"
    ]
  ],
  [
    "public.connected_web_action_operations.receipt",
    [
      "receipt"
    ]
  ],
  [
    "public.connected_web_operation_activity_entries",
    [
      "summary"
    ]
  ],
  [
    "public.connected_web_operation_activity_entries.summary",
    [
      "summary"
    ]
  ],
  [
    "public.connected_web_operations",
    [
      "safe_activity",
      "terminal_receipt",
      "terminal_read_result"
    ]
  ],
  [
    "public.connected_web_operations.safe_activity",
    [
      "safe_activity"
    ]
  ],
  [
    "public.connected_web_operations.terminal_receipt",
    [
      "terminal_receipt"
    ]
  ],
  [
    "public.connected_web_operations.terminal_read_result",
    [
      "terminal_read_result"
    ]
  ]
] as const;

const SECRET_LOCATORS = [
  "public.connected_web_action_operations.opaque_run_ref",
  "public.connected_web_operations.sealed_intent",
  "public.connected_web_operations.sealed_provider_refs",
  "http:request_response:POST /api/connected-web-actions/:deliveryId/watch",
  "http:request_response:POST /api/connected-web-operations/:operationId/watch",
] as const;

export const REVIEWED_LANDING_COVERAGE_ENTRIES: readonly EncryptionCoverageEntry[] = [
  ...metadataEntries,
  ...SECRET_LOCATORS.map((locator, index): EncryptionCoverageEntry => ({
    id: `main.2026-09-05.landing.operator.${index + 1}`,
    surface: locator.startsWith("http:") ? "wire" : "db",
    locator,
    owner: "packages/server",
    readers: ["packages/server", "authenticated owning Human for transient watch URL only"],
    writers: ["packages/server"],
    migrationState: "not_applicable",
    retention: "Owning Connected Website operation lifecycle; watch URLs are transient provider capabilities.",
    testEvidence: [EVIDENCE, "packages/server/tests/unit/connected-web-account-direct-browser-harness.test.ts"],
    classification: "operator_secret",
    secretStoreLocation: "packages/server/src/connected-web-accounts/operation-secrets.ts: intent and provider envelopes use purpose-derived server pairing-pepper AES-GCM; the older action ledger retains a server-only provider run reference, and watch responses are bearer URLs.",
    backupProcedure: "Protect database backups and retain the separate instance pairing pepper to reopen server-sealed operation authority. Do not include provider refs or watch URLs in Agent grants. This is server custody, not Human Domain encryption.",
    excludedFromAgentGrants: true,
  })),
];

export const RETIRED_LANDING_RAW_LOCATORS = new Set<string>([
  "packages/agent/src/store/memory-store.ts#replaceMemory:raw_sql:update:public.memories:1",
  "packages/agent/src/store/scope-memory-store.ts#replaceScopeMemory:raw_sql:update:public.memories:1",
  "packages/agent/src/store/scope-memory-store.ts#saveScopeMemory:raw_sql:insert:public.memories:1",
  "packages/agent/src/store/scope-memory-store.ts#saveScopeMemory:raw_sql:update:public.memories:1"
]);
export const RETIRED_LANDING_FROZEN_DEBT: readonly RetiredFrozenDebt[] =
  [...RETIRED_LANDING_RAW_LOCATORS].map((locator) => ({
    debtId: rawDatabaseWriterDebtId(locator),
    reason: "Main moved this identical Memory mutation into its transaction-injected WithDb function. The exact replacement stays linked to the frozen plaintext Memory content boundary; no debt lock is expanded.",
    testEvidence: [EVIDENCE, "packages/agent/tests/unit-isolated/memory-review-publication.test.ts"],
  }));

const CONTENT_WIRE = [
  "http:request_response:GET /api/connected-web-operations/:operationId",
  "http:request_response:POST /api/connected-web-operations/:operationId/stop",
] as const;

export const REVIEWED_LANDING_DEBT_LINKS: readonly ReviewedDebtLink[] = [
  ...LANDING_CONTENT_PROJECTIONS.map(([locator, fields], index) => ({
    id: `main.2026-09-05.landing.website-content.${index + 1}`,
    surface: "db" as const,
    locator,
    owner: "packages/db",
    targetDebtIds: ["debt.db.public.session_messages.content", "debt.db.public.session_messages.tool_calls"],
    reason: "These exact durable operation fields project the existing Agent tool request/result content class: requested website target, postcondition evidence, browser action summaries and terminal read answer/facts. Sanitized or called safe does not mean encrypted. They remain plaintext-content debt, not metadata or a whole-product encryption claim.",
    testEvidence: [EVIDENCE, "packages/db/tests/unit/d568-connected-web-operation-schema.test.ts"],
    crossBoundaryProjection: {
      fields,
      rationale: "The named fields are retained projections of the same Connected Website tool input, progress and result exposed to the Agent and Human, rather than a new semantic entity class. The operation table stores these plaintext projections independently of any protected conversation copy.",
    },
  })),
  ...CONTENT_WIRE.map((locator, index) => ({
    id: `main.2026-09-05.landing.website-result-wire.${index + 1}`,
    surface: "wire" as const,
    locator,
    owner: "packages/server",
    targetDebtIds: ["debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n"],
    reason: "The owner-only operation card repeats the Agent tool result and activity content class carried by the frozen Message response, including page title, read answer and facts. It is not a ciphertext-only response and remains explicitly linked to content debt.",
    testEvidence: [EVIDENCE, "packages/server/tests/unit-isolated/connected-web-operation-owner-controller.test.ts"],
  })),
  {
    id: "main.2026-09-05.landing.website-attention-wire",
    surface: "wire",
    locator: "ws:server_to_client:connected_web.action_attention",
    owner: "packages/server",
    targetDebtIds: ["debt.wire.http.request.response.get.api.connections.ynrauj"],
    reason: "The requester-private attention event projects only the existing connection selector/account label and provider identity along with the closed sign-in decision, not a website read result or provider credential.",
    testEvidence: [EVIDENCE, "packages/server/tests/unit/connected-web-action-reply.test.ts"],
  },
  ...[...RETIRED_LANDING_RAW_LOCATORS].map((oldLocator, index) => ({
    id: `main.2026-09-05.landing.memory-writer.${index + 1}`,
    surface: "db" as const,
    locator: oldLocator.replace(/#(replaceMemory|replaceScopeMemory|saveScopeMemory):/, "#$1WithDb:"),
    owner: "packages/agent",
    targetDebtIds: [rawDatabaseWriterDebtId(oldLocator)],
    reason: "This is the exact pre-existing Memory insert/update moved into the WithDb transaction seam. The operation and public.memories boundary are unchanged; callers still require Memory authorization and this declaration does not claim all Memory writes are encrypted.",
    testEvidence: [EVIDENCE, "packages/agent/tests/unit-isolated/memory-review-publication.test.ts"],
  })),
];
