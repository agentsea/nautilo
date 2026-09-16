import type { EncryptionCoverageEntry } from "../src/model";
import type { ReviewedDebtLink } from "../src/registry";

const MESSAGE_SCHEMA_EVIDENCE = [
  "packages/db/tests/unit/migration-0131-m237-message-crypto-mapping.test.ts",
  "packages/db/tests/unit/migration-0132-m237-message-crypto-lifecycle.test.ts",
  "packages/db/tests/unit/migration-0133-m237-message-delete-effects.test.ts",
  "packages/db/tests/unit/migration-0134-m237-message-lifecycle-hardening.test.ts",
  "packages/db/tests/unit/migration-0136-m237-message-structural-authority.test.ts",
] as const;
const SIGNER_SCHEMA_EVIDENCE =
  "packages/db/tests/unit/migration-0135-m237-agent-runtime-signers.test.ts";
const MESSAGE_STORE_EVIDENCE =
  "packages/lattice-bridge/tests/integration/postgres-conversation-product-store.integration.test.ts";
const SIGNER_STORE_EVIDENCE =
  "packages/lattice-bridge/tests/integration/postgres-lattice-storage.integration.test.ts";

const MESSAGE_REVISION_COLUMNS = [
  "allocation_request_digest",
  "append_idempotency_key",
  "attempt_count",
  "author_role",
  "completion",
  "created_at",
  "crypto_completed_at",
  "crypto_object_id",
  "delete_orphaned_turn_id",
  "delete_root_anchor_message_id",
  "delete_root_last_reply_at",
  "delete_root_parent_room_id",
  "delete_root_reply_count",
  "delete_root_summary_revision",
  "delete_was_unread",
  "disposition",
  "edit_revision",
  "failure_code",
  "key_class",
  "lease_expires_at",
  "lease_token",
  "message_id",
  "namespace_id_at_allocation",
  "next_attempt_at",
  "parity_status",
  "payload_version",
  "quarantine_lease_token",
  "room_id",
  "sequence",
  "session_id",
  "subthread_reply_classification",
  "terminal_expected_revision",
  "terminal_operation_group_id",
  "terminal_operation_id",
  "terminal_operation_type",
  "terminal_request_digest",
  "updated_at",
] as const;

const RUNTIME_SIGNER_COLUMNS = [
  "agent_id",
  "authorization_revision",
  "operation_id",
  "publication_bytes",
  "runtime_generation",
  "signer_key_id",
  "signer_public_key",
  "transition_kind",
] as const;

const MESSAGE_WRITER_LOCATORS = [
  "packages/lattice-bridge/src/server/message/postgres-conversation-product-store.ts##persistStaleMapping:raw_sql:update:public.session_message_crypto_revisions:1",
  "packages/lattice-bridge/src/server/message/postgres-conversation-product-store.ts#afterDeleteEffects:raw_sql:update:public.session_message_crypto_revisions:1",
  "packages/lattice-bridge/src/server/message/postgres-conversation-product-store.ts#afterMessageIdAllocated:raw_sql:insert:public.session_message_crypto_revisions:1",
  "packages/lattice-bridge/src/server/message/postgres-conversation-product-store.ts#afterRowsEdited:raw_sql:insert:public.session_message_crypto_revisions:1",
  "packages/lattice-bridge/src/server/message/postgres-conversation-product-store.ts#afterRowsEdited:raw_sql:update:public.session_message_crypto_revisions:1",
  "packages/lattice-bridge/src/server/message/postgres-conversation-product-store.ts#claimReconciliationCandidates:raw_sql:update:public.session_message_crypto_revisions:1",
  "packages/lattice-bridge/src/server/message/postgres-conversation-product-store.ts#compareAndSwapCryptoMapping:raw_sql:update:public.session_message_crypto_revisions:1",
  "packages/lattice-bridge/src/server/message/postgres-conversation-product-store.ts#compareAndSwapCryptoMapping:raw_sql:update:public.session_messages:1",
  "packages/lattice-bridge/src/server/message/postgres-conversation-product-store.ts#failReconciliationClaim:raw_sql:update:public.session_message_crypto_revisions:1",
  "packages/lattice-bridge/src/server/message/postgres-conversation-product-store.ts#markCryptoComplete:raw_sql:update:public.session_message_crypto_revisions:1",
  "packages/lattice-bridge/src/server/message/postgres-conversation-product-store.ts#quarantineRevision:raw_sql:update:public.session_message_crypto_revisions:1",
] as const;

function stableId(locator: string): string {
  return locator
    .replaceAll("/", "-")
    .replaceAll("#", "-")
    .replaceAll(":", "-")
    .replaceAll(".", "-")
    .replaceAll("_", "-");
}

function boundedDatabaseEntry(input: Readonly<{
  locator: string;
  repository: string;
  metadataAllowlist: readonly string[];
  testEvidence: readonly string[];
}>): EncryptionCoverageEntry {
  return {
    id: `db.wave9.${stableId(input.locator)}`,
    surface: "db",
    locator: input.locator,
    owner: "packages/lattice-bridge",
    readers: [input.repository],
    writers: [input.repository],
    migrationState: "not_applicable",
    retention:
      "Retained only with the owning message-revision receipt, published message mapping, or append-only Agent Runtime signer generation.",
    testEvidence: input.testEvidence,
    classification: "bounded_metadata",
    metadataAllowlist: input.metadataAllowlist,
    plaintextReason:
      "The exact field set is limited to typed identifiers, public verification material, hashes, counters, enums, booleans, or timestamps; it contains no message content, ciphertext plaintext, private key, Runtime root, or free-form error.",
  };
}

const MESSAGE_REVISION_REPOSITORY =
  "packages/lattice-bridge/src/server/message/postgres-conversation-product-store.ts";
const RUNTIME_SIGNER_REPOSITORY =
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts";

const messageRevisionEntries: readonly EncryptionCoverageEntry[] = [
  boundedDatabaseEntry({
    locator: "public.session_message_crypto_revisions",
    repository: MESSAGE_REVISION_REPOSITORY,
    metadataAllowlist: MESSAGE_REVISION_COLUMNS,
    testEvidence: [...MESSAGE_SCHEMA_EVIDENCE, MESSAGE_STORE_EVIDENCE],
  }),
  ...MESSAGE_REVISION_COLUMNS.map((column) =>
    boundedDatabaseEntry({
      locator: `public.session_message_crypto_revisions.${column}`,
      repository: MESSAGE_REVISION_REPOSITORY,
      metadataAllowlist: [column],
      testEvidence: [...MESSAGE_SCHEMA_EVIDENCE, MESSAGE_STORE_EVIDENCE],
    })
  ),
  boundedDatabaseEntry({
    locator: "public.session_messages.crypto_object_id",
    repository: MESSAGE_REVISION_REPOSITORY,
    metadataAllowlist: ["crypto_object_id"],
    testEvidence: [...MESSAGE_SCHEMA_EVIDENCE, MESSAGE_STORE_EVIDENCE],
  }),
];

const runtimeSignerEntries: readonly EncryptionCoverageEntry[] = [
  boundedDatabaseEntry({
    locator: "public.agent_crypto_runtime_signers",
    repository: RUNTIME_SIGNER_REPOSITORY,
    metadataAllowlist: RUNTIME_SIGNER_COLUMNS,
    testEvidence: [SIGNER_SCHEMA_EVIDENCE, SIGNER_STORE_EVIDENCE],
  }),
  ...RUNTIME_SIGNER_COLUMNS.map((column) =>
    boundedDatabaseEntry({
      locator: `public.agent_crypto_runtime_signers.${column}`,
      repository: RUNTIME_SIGNER_REPOSITORY,
      metadataAllowlist: [column],
      testEvidence: [SIGNER_SCHEMA_EVIDENCE, SIGNER_STORE_EVIDENCE],
    })
  ),
];

const writerEntries: readonly EncryptionCoverageEntry[] = [
  ...MESSAGE_WRITER_LOCATORS.map((locator) =>
    boundedDatabaseEntry({
      locator,
      repository: MESSAGE_REVISION_REPOSITORY,
      metadataAllowlist: [
        "message_revision_coordinate",
        "bounded_lifecycle_receipt",
        "opaque_crypto_object_id",
      ],
      testEvidence: [MESSAGE_STORE_EVIDENCE],
    })
  ),
  boundedDatabaseEntry({
    locator:
      "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#insertRuntimeSignerPublication:raw_sql:insert:public.agent_crypto_runtime_signers:1",
    repository: RUNTIME_SIGNER_REPOSITORY,
    metadataAllowlist: RUNTIME_SIGNER_COLUMNS,
    testEvidence: [SIGNER_STORE_EVIDENCE],
  }),
].map((entry, index) => ({
  ...entry,
  id: `db.wave9.lattice-writer-${String(index + 1).padStart(2, "0")}`,
}));

const notificationWireEntries: readonly EncryptionCoverageEntry[] = [
  {
    id: "wire.wave9.notification-state",
    surface: "wire",
    locator: "http:request_response:GET /api/notifications/state",
    owner: "packages/server",
    readers: ["packages/server/src/routes/notification-preferences.ts"],
    writers: ["packages/trust/src/notification-state.ts"],
    migrationState: "not_applicable",
    retention:
      "The authenticated response is an ephemeral projection of the requesting Human's current bounded notification state.",
    testEvidence: [
      "packages/server/tests/unit-isolated/notification-preferences-routes.test.ts",
    ],
    classification: "bounded_metadata",
    metadataAllowlist: [
      "generatedAt",
      "preferences.defaultLevel",
      "preferences.roomOverrides[].level",
      "preferences.roomOverrides[].roomId",
      "rooms[].importantUnreadCount",
      "rooms[].ownImportantUnreadCount",
      "rooms[].ownUnreadCount",
      "rooms[].roomId",
      "rooms[].subthreadImportantUnreadCount",
      "rooms[].subthreadUnreadCount",
      "rooms[].unreadCount",
      "subthreads[].anchorMessageId",
      "subthreads[].importantUnreadCount",
      "subthreads[].parentRoomId",
      "subthreads[].replyCount",
      "subthreads[].roomId",
      "subthreads[].unreadCount",
      "totals.importantUnreadCount",
      "totals.unreadCount",
    ],
    plaintextReason:
      "The response contains only canonical Room/Subthread coordinates, bounded preference enums, counters, and a generation timestamp; it contains no message text or preview.",
  },
  {
    id: "wire.wave9.room-notification-changed",
    surface: "wire",
    locator: "ws:server_to_client:room.notification.changed",
    owner: "packages/types",
    readers: ["apps/workbench/src/adapters/nautilo-runtime.tsx"],
    writers: ["packages/server/src/realtime/ws-publisher.ts"],
    migrationState: "not_applicable",
    retention:
      "The content-free realtime snapshot is transient and replaces the requesting Human's bounded Room notification counters.",
    testEvidence: [
      "packages/server/tests/unit-isolated/ws-publisher-notification-state.test.ts",
    ],
    classification: "bounded_metadata",
    metadataAllowlist: [
      "roomId",
      "roomOwnImportantUnreadCount",
      "roomOwnUnreadCount",
      "topLevelImportantUnreadCount",
      "topLevelRoomId",
      "topLevelUnreadCount",
      "userId",
    ],
    plaintextReason:
      "The event carries only one canonical Room identifier and bounded unread counters; it carries no message text, display string, or preview.",
  },
];

/** Explicit classifications for every database and content-free wire surface added by Wave 9. */
export const REVIEWED_WAVE_9_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
    ...messageRevisionEntries,
    ...runtimeSignerEntries,
    ...writerEntries,
    ...notificationWireEntries,
  ];

/**
 * The WebSocket transport reuses the same user-authored document mutation
 * payload already frozen on the SSE transport. Wave 9 does not pretend that
 * moving those bytes to WebSocket made them safe metadata.
 */
export const REVIEWED_WAVE_9_DEBT_LINKS: readonly ReviewedDebtLink[] = [
  {
    id: "debt-link.wire.wave9-document-mutation-committed",
    surface: "wire",
    locator: "ws:server_to_client:document.mutation.committed",
    owner: "packages/types",
    targetDebtIds: [
      "debt.wire.sse.produced.get.api.workspace.artifacts.events.document.mutation.committed.mscmws",
    ],
    reason:
      "The WebSocket event carries the same frozen user-authored document mutation payload as the existing SSE event; Wave 9 does not reclassify that plaintext as metadata.",
    testEvidence: [
      "packages/types/tests/unit/document-mutation-committed-realtime.test.ts",
    ],
  },
  {
    id: "debt-link.wire.wave9-important-message-labels",
    surface: "wire",
    locator: "ws:server_to_client:notification.message.important",
    owner: "packages/types",
    targetDebtIds: [
      "debt.wire.http.request.response.get.api.rooms.id.7993e",
    ],
    reason:
      "The event contains no message preview, but it repeats the same frozen Human display-name and Room-label plaintext already returned by the authenticated Room detail boundary.",
    testEvidence: [
      "packages/server/tests/unit-isolated/event-bridge-notification-arrival.test.ts",
    ],
  },
];
