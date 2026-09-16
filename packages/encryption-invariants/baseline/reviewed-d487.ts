import type { EncryptionCoverageEntry } from "../src/model";

const DATABASE_EVIDENCE = [
  "packages/db/tests/unit/migration-0137-d487-owned-photo-library.test.ts",
  "packages/db/tests/integration/d487-owned-photo-library.integration.test.ts",
] as const;
const ROUTE_EVIDENCE = [
  "packages/server/tests/integration/d487-agent-photo-library-read.integration.test.ts",
  "packages/server/tests/integration/d487-agent-photo-library-selection.integration.test.ts",
] as const;

const DATABASE_FIELDS = {
  agent_photo_selection_revisions: [
    "actor_user_id",
    "after_avatar_ref",
    "after_entry_id",
    "agent_id",
    "before_avatar_ref",
    "before_entry_id",
    "created_at",
    "id",
    "operation_id",
    "origin",
    "owner_user_id",
    "revision",
    "server_instance_id",
  ],
  owned_photo_entries: [
    "agent_id",
    "avatar_kind",
    "blob_id",
    "created_at",
    "deleted_at",
    "gc_claim_token",
    "gc_claimed_at",
    "generation_batch_ordinal",
    "generation_model",
    "generation_prompt",
    "generation_provider",
    "id",
    "media_byte_size",
    "media_mime_type",
    "media_sha256",
    "operation_id",
    "origin",
    "owner_user_id",
    "purge_after",
    "request_fingerprint",
    "server_instance_id",
    "source",
    "subject_kind",
  ],
  photo_library_operations: [
    "agent_id",
    "artifact_cleanup_completed_at",
    "completed_at",
    "created_at",
    "expires_at",
    "id",
    "operation_id",
    "operation_kind",
    "owner_user_id",
    "request_fingerprint",
    "reservation_expires_at",
    "reservation_lease_token",
    "reserved_slots",
    "result",
    "server_instance_id",
    "state",
    "viewer_user_id",
  ],
} as const;

function stableId(value: string): string {
  return value.replaceAll(/[^a-z0-9]+/gu, "-").replaceAll(/^-|-$/gu, "");
}

function boundedDatabase(
  locator: string,
  metadataAllowlist: readonly string[],
): EncryptionCoverageEntry {
  return {
    id: `db.d487.${stableId(locator)}`,
    surface: "db",
    locator,
    owner: "packages/db",
    readers: ["packages/db/src/queries/owned-photo-library.ts"],
    writers: ["packages/db/src/queries/owned-photo-library.ts"],
    migrationState: "not_applicable",
    retention:
      "Retained with the owning Agent photo entry, bounded selection revision, or idempotent photo-library operation and removed by the library purge and principal-deletion lifecycle.",
    testEvidence: DATABASE_EVIDENCE,
    classification: "bounded_metadata",
    metadataAllowlist,
    plaintextReason:
      "The exact allowlist contains only principal and operation identifiers, bounded lifecycle state, hashes, timestamps, media descriptors, typed AvatarRef values, and an optional 500-character Agent-profile art-direction prompt; image bytes remain in the separately inventoried avatar file boundary and Room or private-file content is never stored here.",
  };
}

const databaseEntries: readonly EncryptionCoverageEntry[] = [
  ...Object.entries(DATABASE_FIELDS).flatMap(([table, fields]) => [
    boundedDatabase(`public.${table}`, fields),
    ...fields.map((field) =>
      boundedDatabase(`public.${table}.${field}`, [field])
    ),
  ]),
  boundedDatabase("public.profiles.avatar_library_revision", [
    "avatar_library_revision",
  ]),
  boundedDatabase("public.profiles.avatar_selection_revision", [
    "avatar_selection_revision",
  ]),
];

const BOUNDED_WIRE_LOCATORS = [
  "http:request_response:GET /api/profile/agent-photo-library",
  "http:request_response:GET /api/profile/agent-photo-library/current",
  "http:request_response:GET /api/profile/agent-photo-library/entries/:entryId",
  "http:request_response:GET /api/profile/agent-photo-library/presets",
  "http:request_response:POST /api/profile/agent-photo-library/entries/:entryId/delete",
  "http:request_response:POST /api/profile/agent-photo-library/entries/:entryId/restore",
  "http:request_response:POST /api/profile/agent-photo-library/generate",
  "http:request_response:POST /api/profile/agent-photo-library/generate#request.body",
  "http:request_response:POST /api/profile/agent-photo-library/select",
  "http:request_response:POST /api/profile/agent-photo-library/select#request.body",
  "http:request_response:POST /api/profile/agent-photo-library/undo",
  "http:request_response:POST /api/profile/agent-photo-library/undo#request.body",
  "http:request_response:POST /api/profile/agent-photo-library/upload",
] as const;

const wireEntries: readonly EncryptionCoverageEntry[] = [
  ...BOUNDED_WIRE_LOCATORS.map((locator) => ({
    id: `wire.d487.${stableId(locator)}`,
    surface: "wire" as const,
    locator,
    owner: "packages/server",
    readers: ["apps/workbench/src", "apps/mobile/src"],
    writers: ["packages/server/src/routes/agent-photo-library.ts"],
    migrationState: "not_applicable" as const,
    retention:
      "The authenticated response is transient; durable state is limited to the separately inventoried owning Agent photo-library records and avatar file boundary.",
    testEvidence: ROUTE_EVIDENCE,
    classification: "bounded_metadata" as const,
    metadataAllowlist: [
      "owner-scoped entry and revision identifiers",
      "bounded lifecycle and media descriptors",
      "typed AvatarRef selection state",
      "optional bounded Agent-profile art direction",
    ],
    plaintextReason:
      "This owner-scoped contract carries bounded Agent presentation metadata and typed mutation state; it does not carry Room content, arbitrary local files, credentials, or private keys.",
  })),
  {
    id: "wire.d487.agent-photo-library-media",
    surface: "wire",
    locator:
      "http:request_response:GET /api/profile/agent-photo-library/entries/:entryId/media",
    owner: "packages/server",
    readers: ["apps/workbench/src", "apps/mobile/src"],
    writers: ["packages/server/src/routes/agent-photo-library.ts"],
    migrationState: "not_applicable",
    retention:
      "The authenticated response streams an owner-scoped Agent profile image and is not retained by the route; durable bytes remain in the separately inventoried avatar file boundary.",
    testEvidence: ROUTE_EVIDENCE,
    classification: "public",
    plaintextReason:
      "Agent profile photos are presentation assets deliberately shown as the Agent identity across authorized Nautilo clients; this route does not expose Room content, arbitrary local files, credentials, private keys, or media belonging to another owner.",
  },
];

export const REVIEWED_D487_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
    ...databaseEntries,
    ...wireEntries,
  ];
