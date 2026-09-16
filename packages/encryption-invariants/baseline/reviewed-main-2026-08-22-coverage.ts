import type { EncryptionCoverageEntry } from "../src/model";
import type { ReviewedDebtLink } from "../src/registry";

const REVIEW_EVIDENCE =
  "packages/encryption-invariants/tests/integration/reviewed-main-2026-08-22-security.test.ts";
const LIVE_SHADOW_NEGATIVE_EVIDENCE = [
  "packages/server/tests/unit/live-shadow-message-route.test.ts",
  "packages/server/tests/unit-isolated/messaging-route-http.test.ts",
  "packages/db/tests/unit/m282-conversation-shadow-turn-schema.test.ts",
] as const;

const CONTENT_FREE_DATABASE_LOCATORS = [
  "packages/lattice-bridge/src/server/message/postgres-live-shadow-client-verification.ts#verifyAndRecordLiveShadowClientVerification:raw_sql:update:public.conversation_shadow_turn_operations:1",
  "packages/lattice-bridge/src/server/message/postgres-live-shadow-client-verification.ts#verifyAndRecordLiveShadowClientVerification:raw_sql:update:public.conversation_shadow_turn_operations:2",
  "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts##beginAttempt:raw_sql:insert:public.conversation_shadow_turn_plan_attempts:1",
  "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts##recordAttemptUnavailable:raw_sql:update:public.conversation_shadow_turn_plan_attempts:1",
  "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts#bindJob:raw_sql:update:public.conversation_shadow_turn_operations:1",
  "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts#plan:raw_sql:insert:public.conversation_shadow_turn_agent_signers:1",
  "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts#plan:raw_sql:insert:public.conversation_shadow_turn_operations:1",
  "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts#plan:raw_sql:update:public.conversation_shadow_turn_plan_attempts:1",
  "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts#reconcileExpired:raw_sql:update:public.conversation_shadow_turn_operations:1",
  "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts#recordFallback:raw_sql:update:public.conversation_shadow_turn_operations:1",
  "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts#recordProcessLoss:raw_sql:update:public.conversation_shadow_turn_operations:1",
  "public.conversation_shadow_turn_agent_signers",
  "public.conversation_shadow_turn_agent_signers.agent_runtime_generation",
  "public.conversation_shadow_turn_agent_signers.agent_signer_key_id",
  "public.conversation_shadow_turn_agent_signers.agent_signer_public_key",
  "public.conversation_shadow_turn_agent_signers.created_at",
  "public.conversation_shadow_turn_agent_signers.operation_id",
  "public.conversation_shadow_turn_operations",
  "public.conversation_shadow_turn_operations.agent_authorization_revision",
  "public.conversation_shadow_turn_operations.agent_id",
  "public.conversation_shadow_turn_operations.attempt_coordinate",
  "public.conversation_shadow_turn_operations.binding_revision_at_wrap",
  "public.conversation_shadow_turn_operations.client_idempotency_key",
  "public.conversation_shadow_turn_operations.client_verification_digest",
  "public.conversation_shadow_turn_operations.committer_device_id",
  "public.conversation_shadow_turn_operations.created_at",
  "public.conversation_shadow_turn_operations.deadline_at",
  "public.conversation_shadow_turn_operations.domain_epoch",
  "public.conversation_shadow_turn_operations.domain_id",
  "public.conversation_shadow_turn_operations.final_causal_event_digest",
  "public.conversation_shadow_turn_operations.grant_digest",
  "public.conversation_shadow_turn_operations.host_authorization_revision",
  "public.conversation_shadow_turn_operations.human_message_created_at",
  "public.conversation_shadow_turn_operations.human_message_id",
  "public.conversation_shadow_turn_operations.human_request_digest",
  "public.conversation_shadow_turn_operations.job_id",
  "public.conversation_shadow_turn_operations.namespace_access_revision",
  "public.conversation_shadow_turn_operations.namespace_binding_hash",
  "public.conversation_shadow_turn_operations.namespace_id",
  "public.conversation_shadow_turn_operations.namespace_key_generation",
  "public.conversation_shadow_turn_operations.operation_id",
  "public.conversation_shadow_turn_operations.plan_digest",
  "public.conversation_shadow_turn_operations.policy_revision",
  "public.conversation_shadow_turn_operations.recipient_id",
  "public.conversation_shadow_turn_operations.recipient_key_id",
  "public.conversation_shadow_turn_operations.recipient_public_key",
  "public.conversation_shadow_turn_operations.reconciliation_attempt_count",
  "public.conversation_shadow_turn_operations.room_id",
  "public.conversation_shadow_turn_operations.sequence",
  "public.conversation_shadow_turn_operations.session_id",
  "public.conversation_shadow_turn_operations.started_at",
  "public.conversation_shadow_turn_operations.state",
  "public.conversation_shadow_turn_operations.subject_human_id",
  "public.conversation_shadow_turn_operations.terminal_at",
  "public.conversation_shadow_turn_operations.terminal_reason",
  "public.conversation_shadow_turn_operations.terminal_stage",
  "public.conversation_shadow_turn_operations.updated_at",
  "public.conversation_shadow_turn_plan_attempts",
  "public.conversation_shadow_turn_plan_attempts.client_idempotency_key",
  "public.conversation_shadow_turn_plan_attempts.created_at",
  "public.conversation_shadow_turn_plan_attempts.operation_id",
  "public.conversation_shadow_turn_plan_attempts.policy_revision",
  "public.conversation_shadow_turn_plan_attempts.room_id",
  "public.conversation_shadow_turn_plan_attempts.sequence",
  "public.conversation_shadow_turn_plan_attempts.session_id",
  "public.conversation_shadow_turn_plan_attempts.state",
  "public.conversation_shadow_turn_plan_attempts.subject_human_actor_id",
  "public.conversation_shadow_turn_plan_attempts.subject_user_id",
  "public.conversation_shadow_turn_plan_attempts.unavailable_reason",
  "public.conversation_shadow_turn_plan_attempts.updated_at",
  "public.encryption_transition_policy.shadow_encryption_started_at",
  "public.session_message_crypto_revisions.object_id_scheme",
  "public.session_message_crypto_revisions.shadow_durable_event_digest",
  "public.session_message_crypto_revisions.shadow_operation_id",
  "public.session_message_crypto_revisions.shadow_reserved_created_at",
  "public.session_message_crypto_revisions.shadow_stream_id",
  "public.session_message_crypto_revisions.shadow_stream_start_digest",
  "public.session_message_crypto_revisions.shadow_stream_terminal_digest",
  "public.session_message_crypto_revisions.shadow_streamed_text_digest",
  "public.session_message_crypto_revisions.shadow_transcript_ordinal"
] as const;
const PROTECTED_WIRE_LOCATORS = [
  "http:accepted_arbitrary:packages/server/src/messaging/dispatch.ts#RoomPostMessageBody#liveShadow",
  "http:accepted_arbitrary:packages/types/src/api.ts#RoomMessageLiveShadowResult",
  "http:accepted_arbitrary:packages/types/src/api.ts#RoomMessageLiveShadowResult#protectedMessage",
  "http:produced_arbitrary:packages/types/src/api.ts#RoomMessageSendResponse#liveShadow.protectedMessage",
  "http:request_response:GET /api/rooms/:roomId/live-shadow/:operationId/recovery",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/:operationId/verify",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/:operationId/verify#request.body",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace/:operationId/acknowledge",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace/:operationId/acknowledge#request.body",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace/:operationId/deliveries",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace/:operationId/deliveries#request.body",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace/:operationId/stage",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace/:operationId/stage#request.body",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace/plan",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace/plan#request.body",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/plan",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/plan#request.body",
  "http:request_response:POST /api/rooms/:roomId/messages#request.body.liveShadow",
  "ws:server_to_client:message.shadow_durable",
  "ws:server_to_client:message.shadow_stream_frame",
  "ws:server_to_client:message.shadow_stream_start"
] as const;
const AVATAR_METADATA_LOCATORS = [
  "http:accepted_arbitrary:packages/types/src/api.ts#ChatSearchConversationHit#room.roster[].agentAvatar",
  "http:accepted_arbitrary:packages/types/src/api.ts#ChatSearchPage#conversations[].room.roster[].agentAvatar",
  "http:accepted_arbitrary:packages/types/src/api.ts#RoomSummaryDto#roster[].agentAvatar",
  "http:accepted_arbitrary:packages/types/src/api.ts#RoomSummaryRosterMemberDto#agentAvatar",
  "http:produced_arbitrary:packages/types/src/api.ts#ListRoomsResponse#rooms[].roster[].agentAvatar"
] as const;

export const SUPERSEDED_MAIN_2026_08_22_COVERAGE_LOCATORS =
  new Set<string>([
    "public.encryption_transition_policy.shadow_writes_started_at",
  ]);

const databaseEntries: readonly EncryptionCoverageEntry[] =
  CONTENT_FREE_DATABASE_LOCATORS.map((locator, index) => ({
    id: `db.main-2026-08-22.content-free-live-shadow.${index + 1}`,
    surface: "db",
    locator,
    owner: locator.startsWith("packages/")
      ? locator.split("/").slice(0, 2).join("/")
      : "packages/db",
    readers: ["packages/lattice-bridge", "packages/server"],
    writers: ["packages/lattice-bridge", "packages/db"],
    migrationState: "shadow",
    retention:
      "Bounded live-turn coordination and verification state retained with its owning Session or transition policy; no Message body, ciphertext, envelope, manifest, private key, or stream frame is stored here.",
    testEvidence: [REVIEW_EVIDENCE, ...LIVE_SHADOW_NEGATIVE_EVIDENCE],
    classification: "bounded_metadata",
    metadataAllowlist: [
      "opaque operation, Session, Room, Message, Namespace, Domain, Human, Agent, device, job, and idempotency coordinates",
      "authorization, policy, key-generation, binding, sequence, ordinal, attempt, and lifecycle counters",
      "public encryption and signing keys plus their non-secret key identifiers",
      "fixed-size hashes and digests of protected protocol values",
      "lifecycle state, terminal reason/stage, object-ID scheme, timestamps, and retry bookkeeping",
    ],
    plaintextReason:
      "M282 deliberately persists only content-free protocol coordinates needed for idempotency, authorization revalidation, parity verification, recovery, and bounded operations. Plaintext, ciphertext bytes, manifests, envelopes, private keys, and stream frames are structurally absent and covered by the negative evidence.",
  }));

const protectedEntries: readonly EncryptionCoverageEntry[] =
  PROTECTED_WIRE_LOCATORS.map((locator, index) => ({
    id: `wire.main-2026-08-22.live-shadow-protected.${index + 1}`,
    surface: "wire",
    locator,
    owner: locator.includes("packages/types")
      ? "packages/types"
      : locator.startsWith("ws:")
      ? "packages/server"
      : "packages/server",
    readers: ["apps/workbench", "packages/server", "packages/lattice-bridge"],
    writers: ["apps/workbench", "packages/server", "packages/lattice-bridge"],
    migrationState: "shadow",
    retention:
      "Request-scoped or event-stream lifetime; protected bytes are opened only by an authorized Human device and are not persisted in these transport representations.",
    testEvidence: [REVIEW_EVIDENCE, ...LIVE_SHADOW_NEGATIVE_EVIDENCE],
    classification: "protected",
    keyFamily: "namespace_human",
    bridgeRepository: "packages/lattice-bridge",
    negativeTestEvidence: [...LIVE_SHADOW_NEGATIVE_EVIDENCE],
  }));

const avatarEntries: readonly EncryptionCoverageEntry[] =
  AVATAR_METADATA_LOCATORS.map((locator, index) => ({
    id: `wire.main-2026-08-22.agent-avatar-reference.${index + 1}`,
    surface: "wire",
    locator,
    owner: "packages/types",
    readers: ["apps/workbench", "packages/server"],
    writers: ["packages/server"],
    migrationState: "not_applicable",
    retention: "Room-list and chat-search response lifetime.",
    testEvidence: [REVIEW_EVIDENCE],
    classification: "bounded_metadata",
    metadataAllowlist: [
      "Agent avatar kind and opaque media/blob reference",
      "Agent avatar presentation coordinates carried in Room roster summaries",
    ],
    plaintextReason:
      "The added field is a presentation reference for an Agent avatar, not avatar bytes, Human-authored content, a credential, or encryption key material.",
  }));

export const REVIEWED_MAIN_2026_08_22_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
    ...databaseEntries,
    ...protectedEntries,
    ...avatarEntries,
  ];

export const REVIEWED_MAIN_2026_08_22_DEBT_LINKS:
  readonly ReviewedDebtLink[] = [{
    id: "link.db.main-2026-08-22.live-shadow-session-compatibility",
    surface: "db",
    locator:
      "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts#inspectProductCandidate:raw_sql:insert:public.sessions:1",
    owner: "packages/lattice-bridge",
    targetDebtIds: [
      "debt.db.public.sessions.agent_id",
      "debt.db.public.sessions.channel",
      "debt.db.public.sessions.id",
      "debt.db.public.sessions.room_id",
      "debt.db.public.sessions.thread_id",
    ],
    reason:
      "The compatibility path creates the same ordinary Session row already frozen by Wave 0 and adds no live-shadow payload, protected bytes, credential, or new content-bearing field.",
    testEvidence: [REVIEW_EVIDENCE],
    crossBoundaryProjection: {
      fields: ["agent_id", "channel", "id", "room_id", "thread_id"],
      rationale:
        "The raw INSERT is a second representation of the existing public.sessions boundary and writes exactly its frozen routing coordinates.",
    },
  }, ...([
    [
      "http:accepted_arbitrary:packages/types/src/api.ts#ChatSearchConversationHit",
      "debt.wire.http.request.response.get.api.rooms.id.7993e",
    ],
    [
      "http:accepted_arbitrary:packages/types/src/api.ts#ChatSearchPage",
      "debt.wire.http.request.response.get.api.rooms.id.7993e",
    ],
    [
      "http:accepted_arbitrary:packages/types/src/api.ts#RoomSummaryDto",
      "debt.wire.http.request.response.get.api.rooms.wqflaq",
    ],
    [
      "http:accepted_arbitrary:packages/types/src/api.ts#RoomSummaryRosterMemberDto",
      "debt.wire.http.request.response.get.api.rooms.wqflaq",
    ],
    [
      "http:produced_arbitrary:packages/types/src/api.ts#ListRoomsResponse",
      "debt.wire.http.request.response.get.api.rooms.wqflaq",
    ],
    [
      "http:produced_arbitrary:packages/types/src/api.ts#RoomMessageSendResponse",
      "debt.wire.http.request.response.post.api.rooms.roomid.messages.s536g0",
    ],
  ] as const).map(([locator, targetDebtId], index) => ({
    id: `link.wire.main-2026-08-22.named-room-contract-${index + 1}`,
    surface: "wire" as const,
    locator,
    owner: "packages/types",
    targetDebtIds: [targetDebtId],
    reason:
      "This named API type is a second representation of the existing frozen Room summary, roster, search, or Message-send boundary. Its new Agent-avatar leaf is classified separately as bounded presentation metadata, and any live-shadow protected-message leaf is classified separately as protected.",
    testEvidence: [REVIEW_EVIDENCE],
  }))];
