import type { EncryptionCoverageEntry } from "../src/model";
import type { ReviewedDebtLink } from "../src/registry";
import { rawDatabaseWriterDebtId } from "../src/raw-database-writer-debt";

const EVIDENCE =
  "packages/encryption-invariants/tests/integration/wave-4-security-decisions.test.ts";
const EXISTING_MEMORY_INSERT =
  "packages/agent/src/store/memory-store.ts#saveMemoryWithDb:raw_sql:insert:public.memories:1";
const EXISTING_NAMESPACE_EDGE_INSERT =
  "packages/agent/src/store/memory-store.ts#attachMemoryToNamespaceWithDb:raw_sql:insert:public.memory_namespaces:1";

/**
 * Current observations that Wave 4 can classify without an encryption bridge.
 *
 * These values are opaque, fixed-shape control metadata. They remain subject
 * to ordinary authorization and must never be widened to include labels,
 * content, free-form JSON, or other user-authored values.
 */
export const REVIEWED_WAVE_4_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
    {
      id: "db.public.memories.creation-key",
      surface: "db",
      locator: "public.memories.creation_key",
      owner: "packages/agent",
      readers: ["packages/agent/src/store/memory-store.ts"],
      writers: ["packages/agent/src/store/memory-store.ts"],
      migrationState: "not_applicable",
      retention: "Retained with the owning Memory row and deleted with that row.",
      testEvidence: [EVIDENCE],
      classification: "bounded_metadata",
      metadataAllowlist: ["creation_key"],
      plaintextReason:
        "Opaque server-derived idempotency metadata is required to make an approved Memory creation replay-safe without exposing Memory content.",
    },
    {
      id: "db.public.relay-tokens.device-group-id",
      surface: "db",
      locator: "public.relay_tokens.device_group_id",
      owner: "packages/server",
      readers: ["packages/server/src/lib/relay-token-store.ts"],
      writers: ["packages/server/src/lib/relay-token-store.ts"],
      migrationState: "not_applicable",
      retention: "Retained with the relay pairing and removed when its token row is deleted.",
      testEvidence: [EVIDENCE],
      classification: "bounded_metadata",
      metadataAllowlist: ["device_group_id"],
      plaintextReason:
        "An opaque client-minted UUID groups isolated relay installations for authenticated device lifecycle operations and contains no user-authored label or credential.",
    },
    {
      id: "db.public.relay-tokens.device-management-id",
      surface: "db",
      locator: "public.relay_tokens.device_management_id",
      owner: "packages/server",
      readers: [
        "packages/server/src/lib/relay-token-store.ts",
        "packages/server/src/routes/relay.ts",
      ],
      writers: ["packages/server/src/lib/relay-token-store.ts"],
      migrationState: "not_applicable",
      retention: "Retained with the relay pairing and removed when its token row is deleted.",
      testEvidence: [EVIDENCE],
      classification: "bounded_metadata",
      metadataAllowlist: ["device_management_id"],
      plaintextReason:
        "A server-issued opaque digest is the authenticated management target; it reveals neither the underlying device-group UUID nor a user-authored device label.",
    },
    {
      id: "wire.http.relay-device-group-revoke",
      surface: "wire",
      locator:
        "http:request_response:DELETE /api/relay/devices/v2/:deviceManagementId",
      owner: "packages/server",
      readers: ["packages/api-client/src/client.ts"],
      writers: ["packages/server/src/routes/relay.ts"],
      migrationState: "not_applicable",
      retention: "Request and response control metadata is not retained by this route.",
      testEvidence: [EVIDENCE, "packages/server/tests/unit/relay-routes.test.ts"],
      classification: "bounded_metadata",
      metadataAllowlist: [
        "device_management_id",
        "expected_pairing_count",
        "affected_pairing_count",
        "audit_recorded",
        "fixed_error_code",
      ],
      plaintextReason:
        "The authenticated route accepts only an opaque rdm_ digest and a safe integer from 0 through 500, and returns fixed lifecycle control fields.",
    },
    {
      id: "wire.http.relay-device-group-revoke.expected-count",
      surface: "wire",
      locator:
        "http:request_response:DELETE /api/relay/devices/v2/:deviceManagementId#request.body.expectedPairingCount",
      owner: "packages/server",
      readers: ["packages/server/src/routes/relay.ts"],
      writers: ["packages/api-client/src/client.ts"],
      migrationState: "not_applicable",
      retention: "Used for optimistic confirmation and not retained.",
      testEvidence: [EVIDENCE, "packages/server/tests/unit/relay-routes.test.ts"],
      classification: "bounded_metadata",
      metadataAllowlist: ["safe_integer_0_to_500"],
      plaintextReason:
        "The confirmation count is constrained to a non-negative safe integer no greater than 500.",
    },
    {
      id: "wire.http.relay-historical-cleanup",
      surface: "wire",
      locator:
        "http:request_response:POST /api/relay/devices/v2/historical/cleanup",
      owner: "packages/server",
      readers: ["packages/api-client/src/client.ts"],
      writers: ["packages/server/src/routes/relay.ts"],
      migrationState: "not_applicable",
      retention: "Request and response control metadata is not retained by this route.",
      testEvidence: [EVIDENCE, "packages/server/tests/unit/relay-routes.test.ts"],
      classification: "bounded_metadata",
      metadataAllowlist: [
        "literal_confirmation",
        "expected_pairing_count",
        "affected_pairing_count",
        "audit_recorded",
        "fixed_error_code",
      ],
      plaintextReason:
        "The authenticated route carries only a literal confirmation, a bounded count, and fixed lifecycle result fields.",
    },
    {
      id: "wire.http.relay-historical-cleanup.confirm",
      surface: "wire",
      locator:
        "http:request_response:POST /api/relay/devices/v2/historical/cleanup#request.body.confirm",
      owner: "packages/server",
      readers: ["packages/server/src/routes/relay.ts"],
      writers: ["packages/api-client/src/client.ts"],
      migrationState: "not_applicable",
      retention: "Consumed as a literal confirmation and not retained.",
      testEvidence: [EVIDENCE, "packages/server/tests/unit/relay-routes.test.ts"],
      classification: "bounded_metadata",
      metadataAllowlist: ["literal_true"],
      plaintextReason:
        "The route accepts only the literal boolean true as confirmation.",
    },
    {
      id: "wire.http.relay-historical-cleanup.expected-count",
      surface: "wire",
      locator:
        "http:request_response:POST /api/relay/devices/v2/historical/cleanup#request.body.expectedPairingCount",
      owner: "packages/server",
      readers: ["packages/server/src/routes/relay.ts"],
      writers: ["packages/api-client/src/client.ts"],
      migrationState: "not_applicable",
      retention: "Used for optimistic confirmation and not retained.",
      testEvidence: [EVIDENCE, "packages/server/tests/unit/relay-routes.test.ts"],
      classification: "bounded_metadata",
      metadataAllowlist: ["safe_integer_0_to_500"],
      plaintextReason:
        "The confirmation count is constrained to a non-negative safe integer no greater than 500.",
    },
    {
      id: "wire.http.relay-pair.device-group-id",
      surface: "wire",
      locator:
        "http:request_response:POST /api/relay/pair#request.body.deviceGroupId",
      owner: "packages/server",
      readers: ["packages/server/src/routes/relay.ts"],
      writers: ["apps/desktop/electron/auth/relay-pair.ts"],
      migrationState: "not_applicable",
      retention: "Persisted only as the separately classified relay-token device_group_id.",
      testEvidence: [EVIDENCE, "packages/server/tests/unit/relay-routes.test.ts"],
      classification: "bounded_metadata",
      metadataAllowlist: ["canonical_uuid_or_null_or_omitted"],
      plaintextReason:
        "The grouping pseudonym accepts only a canonical UUID-like fixed shape, null, or omission and never falls back to a label.",
    },
    {
      id: "db.public.session-messages.edited-at",
      surface: "db",
      locator: "public.session_messages.edited_at",
      owner: "packages/trust",
      readers: ["packages/agent/src/store/session-store.ts"],
      writers: ["packages/trust/src/message-edit.ts"],
      migrationState: "not_applicable",
      retention: "Retained with and deleted with the owning transcript row.",
      testEvidence: [EVIDENCE],
      classification: "bounded_metadata",
      metadataAllowlist: ["edit_timestamp"],
      plaintextReason:
        "The server-authored timestamp records only that an authorized edit committed and contains no message content.",
    },
    {
      id: "db.public.session-messages.edit-revision",
      surface: "db",
      locator: "public.session_messages.edit_revision",
      owner: "packages/trust",
      readers: ["packages/agent/src/store/session-store.ts"],
      writers: ["packages/trust/src/message-edit.ts"],
      migrationState: "not_applicable",
      retention: "Retained with and deleted with the owning transcript row.",
      testEvidence: [EVIDENCE],
      classification: "bounded_metadata",
      metadataAllowlist: ["nonnegative_revision"],
      plaintextReason:
        "The monotonic safe integer is an optimistic-concurrency token and contains no message content.",
    },
    {
      id: "db.public.room-journal-state.rebuild-generation",
      surface: "db",
      locator: "public.room_journal_state.rebuild_generation",
      owner: "packages/runtime",
      readers: ["packages/runtime/src/stenographer/repository.ts"],
      writers: [
        "packages/trust/src/message-edit.ts",
        "packages/runtime/src/stenographer/repository.ts",
      ],
      migrationState: "not_applicable",
      retention: "Retained with the Room journal state row.",
      testEvidence: [EVIDENCE],
      classification: "bounded_metadata",
      metadataAllowlist: ["nonnegative_generation"],
      plaintextReason:
        "The monotonic generation is a content-free CAS token for invalidated derived journal state.",
    },
    {
      id: "db.public.room-journal-state.rebuild-requested-at",
      surface: "db",
      locator: "public.room_journal_state.rebuild_requested_at",
      owner: "packages/runtime",
      readers: [
        "packages/runtime/src/stenographer/repository.ts",
        "packages/runtime/src/context/build-transcript-context-deps.ts",
      ],
      writers: [
        "packages/trust/src/message-edit.ts",
        "packages/runtime/src/stenographer/repository.ts",
      ],
      migrationState: "not_applicable",
      retention: "Cleared when the matching Room rebuild reaches its fixed target.",
      testEvidence: [EVIDENCE],
      classification: "bounded_metadata",
      metadataAllowlist: ["rebuild_timestamp_or_null"],
      plaintextReason:
        "The server-authored timestamp is only a fail-closed dirty marker and contains no journal or transcript content.",
    },
    {
      id: "db.public.room-journal-state.rebuild-target-message-id",
      surface: "db",
      locator: "public.room_journal_state.rebuild_target_message_id",
      owner: "packages/runtime",
      readers: ["packages/runtime/src/stenographer/repository.ts"],
      writers: [
        "packages/trust/src/message-edit.ts",
        "packages/runtime/src/stenographer/repository.ts",
      ],
      migrationState: "not_applicable",
      retention: "Cleared when the matching Room rebuild reaches the target.",
      testEvidence: [EVIDENCE],
      classification: "bounded_metadata",
      metadataAllowlist: ["nonnegative_internal_message_id_or_null"],
      plaintextReason:
        "The internal integer cursor bounds replay work and carries no message content.",
    },
    ...[
      ["delete-rollups", "delete:public.room_event_rollups"],
      ["delete-events", "delete:public.room_events"],
      ["delete-batches", "delete:public.room_journal_batches"],
      ["reset-state", "update:public.room_journal_state"],
      ["clear-dirty-state", "update:public.room_journal_state"],
    ].map(([id, boundary], index): EncryptionCoverageEntry => ({
      id: `db.m230-journal-rebuild.${id}`,
      surface: "db",
      locator:
        `packages/runtime/src/stenographer/repository.ts#prepareNextJournalRebuild:raw_sql:${boundary}:${boundary === "update:public.room_journal_state" ? index - 2 : 1}`,
      owner: "packages/runtime",
      readers: [],
      writers: ["packages/runtime/src/stenographer/repository.ts"],
      migrationState: "not_applicable",
      retention: "The operation removes stale derived state or resets content-free replay controls.",
      testEvidence: [EVIDENCE],
      classification: "bounded_metadata",
      metadataAllowlist: ["opaque_room_id", "delete_or_reset_operation"],
      plaintextReason:
        "The call site carries only an opaque Room id and fixed reset values; it never returns or copies the protected derived content it removes.",
    })),
  ];

/**
 * Reviewed post-Wave-0 observations that are known protected plaintext but
 * cannot yet claim a concrete bridge or negative plaintext-write evidence.
 */
export const REVIEWED_WAVE_4_DEBT_LINKS: readonly ReviewedDebtLink[] = [
    {
      id: "debt-link.db.public.rooms.normalized-label",
      surface: "db",
      locator: "public.rooms.normalized_label",
      owner: "packages/db",
      targetDebtIds: ["debt.db.public.rooms.label"],
      reason:
        "This generated search column is a second representation of the frozen user-authored Room-label plaintext boundary, not independently accepted metadata.",
      testEvidence: [EVIDENCE],
    },
    {
      id: "debt-link.db.memory-writer.atomic-projection.memory",
      surface: "db",
      locator:
        "packages/agent/src/store/memory-store.ts#executeAtomicProjectionMemoryInTx:raw_sql:insert:public.memories:1",
      owner: "packages/agent",
      targetDebtIds: [rawDatabaseWriterDebtId(EXISTING_MEMORY_INSERT)],
      reason:
        "This raw call site atomically writes the same frozen Memory content and embedding plaintext boundary; it does not introduce a different payload class.",
      testEvidence: [EVIDENCE],
    },
    {
      id: "debt-link.db.memory-writer.atomic-projection.namespace-edge",
      surface: "db",
      locator:
        "packages/agent/src/store/memory-store.ts#executeAtomicProjectionMemoryInTx:raw_sql:insert:public.memory_namespaces:1",
      owner: "packages/agent",
      targetDebtIds: [
        rawDatabaseWriterDebtId(EXISTING_NAMESPACE_EDGE_INSERT),
      ],
      reason:
        "This raw call site writes the same frozen Memory-to-Namespace authorization edge required by the atomic plaintext Memory operation.",
      testEvidence: [EVIDENCE],
    },
    {
      id: "debt-link.db.memory-writer.force-create.memory",
      surface: "db",
      locator:
        "packages/agent/src/store/memory-store.ts#forceCreateMemoryWithDb:raw_sql:insert:public.memories:1",
      owner: "packages/agent",
      targetDebtIds: [rawDatabaseWriterDebtId(EXISTING_MEMORY_INSERT)],
      reason:
        "This raw call site writes the same frozen Memory content and embedding plaintext boundary while preserving replay-safe creation.",
      testEvidence: [EVIDENCE],
    },
    {
      id: "debt-link.db.memory-writer.force-create.namespace-edge",
      surface: "db",
      locator:
        "packages/agent/src/store/memory-store.ts#forceCreateMemoryWithDb:raw_sql:insert:public.memory_namespaces:1",
      owner: "packages/agent",
      targetDebtIds: [
        rawDatabaseWriterDebtId(EXISTING_NAMESPACE_EDGE_INSERT),
      ],
      reason:
        "This raw call site writes the same frozen Memory-to-Namespace authorization edge as the existing Memory plaintext boundary.",
      testEvidence: [EVIDENCE],
    },
    {
      id: "debt-link.wire.relay-device-v2-list",
      surface: "wire",
      locator: "http:request_response:GET /api/relay/devices/v2",
      owner: "packages/server",
      targetDebtIds: [
        "debt.wire.http.request.response.get.api.relay.devices.1kclu9f",
      ],
      reason:
        "The grouped projection returns the same frozen caller-owned plaintext device label as the v1 device list; its remaining fields are bounded lifecycle metadata.",
      testEvidence: [EVIDENCE, "packages/server/tests/unit/relay-routes.test.ts"],
    },
    {
      id: "debt-link.wire.relay-device-v2-detail",
      surface: "wire",
      locator:
        "http:request_response:GET /api/relay/devices/v2/:deviceManagementId",
      owner: "packages/server",
      targetDebtIds: [
        "debt.wire.http.request.response.get.api.relay.devices.1kclu9f",
      ],
      reason:
        "The detail projection returns the same frozen caller-owned plaintext device label as the v1 device list; its opaque target is validated and user-scoped.",
      testEvidence: [EVIDENCE, "packages/server/tests/unit/relay-routes.test.ts"],
    },
    {
      id: "debt-link.wire.room-message-search",
      surface: "wire",
      locator: "http:request_response:GET /api/rooms/:id/messages/search",
      owner: "packages/server",
      targetDebtIds: [
        "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n",
      ],
      reason:
        "The authenticated search projection returns snippets derived from the same frozen Room-message plaintext boundary as the existing room transcript reader.",
      testEvidence: [
        EVIDENCE,
        "packages/agent/tests/integration/room-message-search.integration.test.ts",
      ],
    },
    {
      id: "debt-link.wire.room-messages-around",
      surface: "wire",
      locator:
        "http:request_response:GET /api/rooms/:id/messages/:messageId/around",
      owner: "packages/server",
      targetDebtIds: [
        "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n",
      ],
      reason:
        "The authenticated navigation window returns the same frozen Room-message plaintext boundary as the existing paginated room transcript reader.",
      testEvidence: [
        EVIDENCE,
        "packages/server/tests/unit-isolated/sessions-guest-leak.test.ts",
      ],
    },
    {
      id: "debt-link.wire.m230-message-edit",
      surface: "wire",
      locator:
        "http:request_response:PATCH /api/rooms/:roomId/messages/:messageId",
      owner: "packages/server",
      targetDebtIds: [
        "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n",
      ],
      reason:
        "The authenticated author-only edit carries the same frozen Room-message plaintext boundary plus bounded revision metadata.",
      testEvidence: [
        EVIDENCE,
        "packages/api-client/tests/unit/client-contract.test.ts",
      ],
    },
    {
      id: "debt-link.wire.m230-message-updated",
      surface: "wire",
      locator: "ws:server_to_client:message.updated",
      owner: "packages/types",
      targetDebtIds: ["debt.wire.ws.server.to.client.message.new.tqhwvb"],
      reason:
        "The Room-scoped replacement event carries the same frozen Human-message plaintext boundary as message.new plus bounded revision metadata.",
      testEvidence: [
        EVIDENCE,
        "apps/workbench/src/modes/rooms/thread-drawer/tests/thread-room-controller.test.ts",
      ],
    },
  ];
