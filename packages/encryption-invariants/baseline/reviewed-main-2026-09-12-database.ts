import type { EncryptionCoverageEntry } from "../src/model";

type MetadataGroup = Readonly<{
  id: string;
  locators: readonly string[];
  owner: string;
  readers: readonly string[];
  writers: readonly string[];
  retention: string;
  testEvidence: readonly string[];
  metadataAllowlist: readonly string[];
  plaintextReason: string;
}>;

function entriesFor(group: MetadataGroup): readonly EncryptionCoverageEntry[] {
  return group.locators.map((locator, index) => ({
    id: `db.main-2026-09-12.${group.id}.${index + 1}`,
    surface: "db",
    locator,
    owner: group.owner,
    readers: group.readers,
    writers: group.writers,
    migrationState: "not_applicable",
    retention: group.retention,
    testEvidence: group.testEvidence,
    classification: "bounded_metadata",
    metadataAllowlist: group.metadataAllowlist,
    plaintextReason: group.plaintextReason,
  }));
}

export const CONTENT_ACCESS_OPERATION_METADATA_FIELDS = [
  "operation_id",
  "request_digest",
  "requester_user_id",
  "requester_actor_id",
  "memory_id",
  "artifact_id",
  "outcome",
  "changed",
  "attached_count",
  "detached_count",
  "skipped_count",
  "created_at",
] as const;

export const CONTENT_ACCESS_OPERATION_METADATA_LOCATORS = [
  "public.content_access_operations",
  ...CONTENT_ACCESS_OPERATION_METADATA_FIELDS.map(
    (field) => `public.content_access_operations.${field}`,
  ),
] as const;

export const FEED_EVENT_METADATA_FIELDS = [
  "id",
  "occurrence_key",
  "type",
  "actor_kind",
  "actor_id",
  "data",
  "created_at",
] as const;

export const FEED_EVENT_METADATA_LOCATORS = [
  "public.feed_events",
  ...FEED_EVENT_METADATA_FIELDS.map((field) => `public.feed_events.${field}`),
] as const;

export const FEED_RECIPIENT_METADATA_FIELDS = [
  "event_id",
  "user_id",
  "read_at",
] as const;

export const FEED_RECIPIENT_METADATA_LOCATORS = [
  "public.feed_recipients",
  ...FEED_RECIPIENT_METADATA_FIELDS.map(
    (field) => `public.feed_recipients.${field}`,
  ),
] as const;

export const PROCESSOR_SIGNER_METADATA_FIELDS = ["format_version"] as const;
const PROCESSOR_SIGNER_METADATA_LOCATORS = [
  "public.processor_crypto_signer_authorizations.format_version",
] as const;

export const REFLECTION_TARGET_METADATA_FIELDS = [
  "target_access_namespace_ids",
  "target_audience_set_commitment",
  "target_crypto_retired_at",
] as const;
const REFLECTION_TARGET_METADATA_LOCATORS =
  REFLECTION_TARGET_METADATA_FIELDS.map(
    (field) =>
      `public.reflection_record_authority_reconciliations.${field}`,
  );

export const ORDINARY_STENOGRAPHER_FALLBACK_METADATA_FIELDS = [
  "ordinary_fallback_reason",
  "ordinary_fallback_rebuild_generation",
  "ordinary_output_fingerprint",
] as const;
const ORDINARY_STENOGRAPHER_FALLBACK_METADATA_LOCATORS = [
  ...ORDINARY_STENOGRAPHER_FALLBACK_METADATA_FIELDS.map(
    (field) => `public.room_event_rollups.${field}`,
  ),
  ...ORDINARY_STENOGRAPHER_FALLBACK_METADATA_FIELDS.map(
    (field) => `public.room_journal_batches.${field}`,
  ),
] as const;

export const STENOGRAPHER_AUTHORIZATION_WAIT_METADATA_FIELDS = [
  "compaction_authorization_waiting_since",
  "extraction_authorization_wait_lane",
  "extraction_authorization_waiting_since",
] as const;
const STENOGRAPHER_AUTHORIZATION_WAIT_METADATA_LOCATORS =
  STENOGRAPHER_AUTHORIZATION_WAIT_METADATA_FIELDS.map(
    (field) => `public.room_journal_state.${field}`,
  );

export const MEDIA_MODEL_METADATA_FIELDS = [
  "image_model",
  "music_model",
  "video_model",
] as const;
const MEDIA_MODEL_METADATA_LOCATORS = MEDIA_MODEL_METADATA_FIELDS.map(
  (field) => `public.server_model_config.${field}`,
);

const CONTENT_ACCESS_EVIDENCE = [
  "packages/db/tests/unit/content-access-operations-schema.test.ts",
  "packages/db/tests/integration/content-access-operations.integration.test.ts",
  "packages/trust/tests/unit-isolated/content-access-publication.test.ts",
] as const;
const EVENT_FEED_EVIDENCE = [
  "packages/types/tests/unit/event-feed.test.ts",
  "packages/event-feed/tests/unit/event-feed.test.ts",
  "packages/db/tests/integration/event-feed.integration.test.ts",
] as const;
const PROCESSOR_SIGNER_EVIDENCE = [
  "packages/db/tests/unit/m241-background-authorization-schema.test.ts",
  "packages/db/tests/unit/m327-background-reflection-carrier-schema.test.ts",
  "packages/lattice-bridge/tests/integration/wave-10-background-postgres.integration.test.ts",
] as const;
const REFLECTION_TARGET_EVIDENCE = [
  "packages/db/tests/unit/m327-reflection-authority-finalizer.test.ts",
  "packages/reflection-bridge/tests/unit/postgres-authority-receipts.test.ts",
  "packages/lattice-bridge/tests/unit/postgres-reflection-authority-status.test.ts",
] as const;
const FALLBACK_EVIDENCE = [
  "packages/db/tests/unit/m317-stenographer-fallback-provenance-schema.test.ts",
  "packages/lattice-bridge/tests/unit/postgres-stenographer-fallback-selection.test.ts",
  "packages/reflection-bridge/tests/unit/postgres-ordinary-stenographer-publisher.test.ts",
] as const;
const AUTHORIZATION_WAIT_EVIDENCE = [
  "packages/db/tests/unit/room-journal-state.test.ts",
  "packages/lattice-bridge/tests/unit/postgres-stenographer-authorization-wait.test.ts",
] as const;
const MEDIA_MODEL_EVIDENCE = [
  "packages/db/tests/unit/server-model-config-defaults.test.ts",
  "packages/server/tests/unit/server-models-route.test.ts",
] as const;

export const REVIEWED_MAIN_2026_09_12_DATABASE_METADATA_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
  ...entriesFor({
    id: "content-access-operation",
    locators: CONTENT_ACCESS_OPERATION_METADATA_LOCATORS,
    owner: "packages/trust",
    readers: [
      "packages/trust/src/content-access-coordinator.ts",
      "packages/trust/src/content-access-publication.ts",
    ],
    writers: [
      "packages/trust/src/content-access-coordinator.ts",
      "packages/trust/src/content-access-publication.ts",
    ],
    retention:
      "Retained for the referenced Memory or Artifact lifetime as one immutable terminal access-operation receipt; requester references may be cleared only by their foreign-key lifecycle.",
    testEvidence: CONTENT_ACCESS_EVIDENCE,
    metadataAllowlist: CONTENT_ACCESS_OPERATION_METADATA_FIELDS,
    plaintextReason:
      "The exact schema permits only caller and object identifiers, a canonical request digest, a closed outcome, change/count facts, and creation time. It forbids content, result, plan, audience, Namespace, token, pending, claim, retry, and expiry payload fields and cannot be used as access authority.",
  }),
  ...entriesFor({
    id: "feed-event",
    locators: FEED_EVENT_METADATA_LOCATORS,
    owner: "packages/event-feed",
    readers: ["packages/db/src/queries/event-feed.ts"],
    writers: ["packages/db/src/queries/event-feed.ts"],
    retention:
      "Persistent personal event history; resource deletion preserves reference-only history while current authorization resolves any presentation labels.",
    testEvidence: EVENT_FEED_EVIDENCE,
    metadataAllowlist: FEED_EVENT_METADATA_FIELDS,
    plaintextReason:
      "Current strict event schemas admit only occurrence, type and actor coordinates plus Room, Human, Artifact, and closed destination-kind references. They reject additional human-authored content; display names are resolved only on the authorized wire projection and are never stored in the feed payload.",
  }),
  ...entriesFor({
    id: "feed-recipient",
    locators: FEED_RECIPIENT_METADATA_LOCATORS,
    owner: "packages/event-feed",
    readers: ["packages/db/src/queries/event-feed.ts"],
    writers: ["packages/db/src/queries/event-feed.ts"],
    retention:
      "Retained with its event until the recipient Human or event is deleted; read_at is the recipient-owned durable read marker.",
    testEvidence: EVENT_FEED_EVIDENCE,
    metadataAllowlist: FEED_RECIPIENT_METADATA_FIELDS,
    plaintextReason:
      "These rows contain only event and Human identifiers plus an optional read timestamp. Row-level policies bind reads and read-state changes to that exact Human and do not grant access to the referenced resource.",
  }),
  ...entriesFor({
    id: "processor-signer-format",
    locators: PROCESSOR_SIGNER_METADATA_LOCATORS,
    owner: "packages/lattice-bridge",
    readers: [
      "packages/lattice-bridge/src/server/storage/postgres-current-processor-signer-authorization.ts",
    ],
    writers: [
      "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts",
    ],
    retention:
      "Retained with the processor signer authorization receipt until its owning protected work and evidence lifecycle expires.",
    testEvidence: PROCESSOR_SIGNER_EVIDENCE,
    metadataAllowlist: PROCESSOR_SIGNER_METADATA_FIELDS,
    plaintextReason:
      "format_version is constrained to the closed supported carrier versions 1, 2, and 3 and contains no authorization bytes, key material, content, or free-form metadata.",
  }),
  ...entriesFor({
    id: "reflection-target",
    locators: REFLECTION_TARGET_METADATA_LOCATORS,
    owner: "packages/reflection-bridge",
    readers: [
      "packages/reflection-bridge/src/server/postgres-authority-store.ts",
      "packages/lattice-bridge/src/server/reflection/postgres-authority-status.ts",
    ],
    writers: ["packages/reflection-bridge/src/server/postgres-authority-store.ts"],
    retention:
      "Retained with the exact Reflection authority reconciliation receipt through deterministic replay and retirement of an obsolete protected target.",
    testEvidence: REFLECTION_TARGET_EVIDENCE,
    metadataAllowlist: REFLECTION_TARGET_METADATA_FIELDS,
    plaintextReason:
      "The fields contain only an exact nonempty set of Namespace identifiers, its fixed 32-byte audience commitment, and target-retirement time. Record semantic payload and cryptographic envelope bytes remain in the separately protected representation boundary.",
  }),
  ...entriesFor({
    id: "ordinary-stenographer-fallback",
    locators: ORDINARY_STENOGRAPHER_FALLBACK_METADATA_LOCATORS,
    owner: "packages/lattice-bridge",
    readers: [
      "packages/lattice-bridge/src/server/journal/postgres-stenographer-fallback-selection.ts",
      "packages/reflection-bridge/src/server/postgres-ordinary-stenographer-publisher.ts",
    ],
    writers: [
      "packages/runtime/src/stenographer/repository.ts",
      "packages/reflection-bridge/src/server/postgres-ordinary-stenographer-publisher.ts",
    ],
    retention:
      "Retained with the completed ordinary journal batch or rollup as deterministic fallback provenance for rebuild and repair.",
    testEvidence: FALLBACK_EVIDENCE,
    metadataAllowlist: ORDINARY_STENOGRAPHER_FALLBACK_METADATA_FIELDS,
    plaintextReason:
      "The tuple is restricted to the closed device/authority reason, a nonnegative rebuild generation, and a fixed 32-byte output fingerprint. Journal or Reflection semantic output is not stored in these provenance fields.",
  }),
  ...entriesFor({
    id: "stenographer-authorization-wait",
    locators: STENOGRAPHER_AUTHORIZATION_WAIT_METADATA_LOCATORS,
    owner: "packages/lattice-bridge",
    readers: [
      "packages/lattice-bridge/src/server/journal/postgres-stenographer-authorization-wait.ts",
    ],
    writers: [
      "packages/lattice-bridge/src/server/journal/postgres-stenographer-authorization-wait.ts",
      "packages/db/src/queries/room-journal-state.ts",
    ],
    retention:
      "Retained only while extraction or compaction is waiting for current protected authority, then cleared by the same state owner.",
    testEvidence: AUTHORIZATION_WAIT_EVIDENCE,
    metadataAllowlist: STENOGRAPHER_AUTHORIZATION_WAIT_METADATA_FIELDS,
    plaintextReason:
      "The fields contain only the closed live/historical/rebuild lane and wait timestamps. They are deliberately recorded before an exact crypto request can be described and contain no journal, message, key, envelope, or authorization payload.",
  }),
  ...entriesFor({
    id: "media-model",
    locators: MEDIA_MODEL_METADATA_LOCATORS,
    owner: "packages/db",
    readers: [
      "packages/db/src/utils/server-model-config-cache.ts",
      "packages/db/src/utils/server-model-config-queries.ts",
    ],
    writers: ["packages/db/src/utils/server-model-config-queries.ts"],
    retention:
      "Retained as singleton administrator configuration until a later validated model selection replaces or clears it.",
    testEvidence: MEDIA_MODEL_EVIDENCE,
    metadataAllowlist: MEDIA_MODEL_METADATA_FIELDS,
    plaintextReason:
      "The fields store only validated public provider:model catalogue identifiers for image, music, and video generation. They contain no prompt, generated media, provider credential, user content, or secret configuration.",
  }),
];

export const SUPERSEDED_MAIN_2026_09_12_DATABASE_WRITER_LOCATORS =
  new Set<string>([
    "packages/reflection-bridge/src/server/postgres-authority-store.ts#installInitialClosure:raw_sql:insert:public.reflection_record_authority_closure:1",
    "packages/reflection-bridge/src/server/postgres-authority-store.ts#installInitialClosure:raw_sql:insert:public.reflection_record_authority_projections:1",
    "packages/reflection-bridge/src/server/postgres-authority-store.ts#recordProtectedCryptoComplete:raw_sql:update:public.reflection_record_authority_reconciliations:1",
  ]);

// Keep the reviewed `raw_sql` provenance spelling solely so
// canonicalDatabaseWriterLocator can carry the prior exact review across the
// helper move. The current helper executes these two INSERTs through Drizzle.
export const REVIEWED_MAIN_2026_09_12_DATABASE_WRITER_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
  ...entriesFor({
    id: "reflection-initial-closure-writer",
    locators: [
      "packages/reflection-bridge/src/server/postgres-authority-store.ts#installInitialAuthorityClosureWithinTransaction:raw_sql:insert:public.reflection_record_authority_closure:1",
    ],
    owner: "packages/reflection-bridge",
    readers: ["packages/reflection-bridge/src/server/postgres-authority-store.ts"],
    writers: ["packages/reflection-bridge/src/server/postgres-authority-store.ts"],
    retention:
      "Retained with the Record authority graph until the owning Record is purged.",
    testEvidence: [
      "packages/reflection-bridge/tests/unit/authority-reconciliation.test.ts",
      "packages/reflection-bridge/tests/unit/postgres-authority-receipts.test.ts",
    ],
    metadataAllowlist: [
      "record_id",
      "terminal_leaf_handle",
      "closure_generation",
    ],
    plaintextReason:
      "The moved transaction helper writes only the exact Record identifier, terminal authority-leaf identifier, and closure generation already classified on this same bounded authority-graph boundary; it writes no Record payload or protected representation bytes.",
  }),
  ...entriesFor({
    id: "reflection-initial-projection-writer",
    locators: [
      "packages/reflection-bridge/src/server/postgres-authority-store.ts#installInitialAuthorityClosureWithinTransaction:raw_sql:insert:public.reflection_record_authority_projections:1",
    ],
    owner: "packages/reflection-bridge",
    readers: ["packages/reflection-bridge/src/server/postgres-authority-store.ts"],
    writers: ["packages/reflection-bridge/src/server/postgres-authority-store.ts"],
    retention:
      "Retained with the current Record authority projection until a later projection generation replaces it or the Record is purged.",
    testEvidence: [
      "packages/reflection-bridge/tests/unit/authority-reconciliation.test.ts",
      "packages/reflection-bridge/tests/unit/postgres-authority-receipts.test.ts",
    ],
    metadataAllowlist: [
      "record_id",
      "projection_generation",
      "source_change_generation",
      "processing_state",
      "current",
      "dirty_since",
    ],
    plaintextReason:
      "The moved transaction helper writes only the exact Record identity, bounded generations, closed dirty/current control state, and timestamp already classified on this same authority-projection boundary; it writes no Record payload or protected representation bytes.",
  }),
];

export const REVIEWED_MAIN_2026_09_12_DATABASE_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
  ...REVIEWED_MAIN_2026_09_12_DATABASE_METADATA_ENTRIES,
  ...REVIEWED_MAIN_2026_09_12_DATABASE_WRITER_ENTRIES,
];
