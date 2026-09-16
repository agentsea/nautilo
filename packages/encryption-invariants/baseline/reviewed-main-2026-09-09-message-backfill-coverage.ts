import type { EncryptionCoverageEntry } from "../src/model";
import type { ReviewedDebtLink, RetiredFrozenDebt } from "../src/registry";

/** Exact current-main messageBackfill inventory; content remains linked to frozen debt. */
export const REVIEWED_MAIN_2026_09_09_MESSAGEBACKFILL_COVERAGE_ENTRIES: readonly EncryptionCoverageEntry[] = [
  {
    "id": "main.2026-09-09.message-backfill.metadata.1",
    "surface": "db",
    "locator": "public.message_backfill_failures",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_failures"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.2",
    "surface": "db",
    "locator": "public.message_backfill_failures.crypto_object_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_failures.crypto_object_id"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.3",
    "surface": "db",
    "locator": "public.message_backfill_failures.edit_revision",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_failures.edit_revision"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.4",
    "surface": "db",
    "locator": "public.message_backfill_failures.message_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_failures.message_id"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.5",
    "surface": "db",
    "locator": "public.message_backfill_failures.namespace_access_revision",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_failures.namespace_access_revision"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.6",
    "surface": "db",
    "locator": "public.message_backfill_failures.observed_at",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_failures.observed_at"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.7",
    "surface": "db",
    "locator": "public.message_backfill_failures.policy_revision",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_failures.policy_revision"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.8",
    "surface": "db",
    "locator": "public.message_backfill_failures.reason",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_failures.reason"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.9",
    "surface": "db",
    "locator": "public.message_backfill_failures.source_revision",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_failures.source_revision"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.10",
    "surface": "db",
    "locator": "public.message_backfill_scans",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_scans"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.11",
    "surface": "db",
    "locator": "public.message_backfill_scans.claim",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The closed backfill claim contains only source coordinates, revisions, digests, and lease authority; product code explicitly excludes plaintext, ciphertext, keys, signatures, and error prose.",
    "metadataAllowlist": [
      "public.message_backfill_scans.claim"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.12",
    "surface": "db",
    "locator": "public.message_backfill_scans.claim_is_urgent",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The closed backfill claim contains only source coordinates, revisions, digests, and lease authority; product code explicitly excludes plaintext, ciphertext, keys, signatures, and error prose.",
    "metadataAllowlist": [
      "public.message_backfill_scans.claim_is_urgent"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.13",
    "surface": "db",
    "locator": "public.message_backfill_scans.cursor_message_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_scans.cursor_message_id"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.14",
    "surface": "db",
    "locator": "public.message_backfill_scans.human_actor_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_scans.human_actor_id"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.15",
    "surface": "db",
    "locator": "public.message_backfill_scans.last_active_at",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_scans.last_active_at"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.16",
    "surface": "db",
    "locator": "public.message_backfill_scans.last_sweep_at",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_scans.last_sweep_at"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.17",
    "surface": "db",
    "locator": "public.message_backfill_scans.lease_device_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_scans.lease_device_id"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.18",
    "surface": "db",
    "locator": "public.message_backfill_scans.lease_expires_at",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_scans.lease_expires_at"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.19",
    "surface": "db",
    "locator": "public.message_backfill_scans.lease_token",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_scans.lease_token"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.20",
    "surface": "db",
    "locator": "public.message_backfill_scans.resume_at",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_scans.resume_at"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.21",
    "surface": "db",
    "locator": "public.message_backfill_scans.sweep_started_at",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_scans.sweep_started_at"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.22",
    "surface": "db",
    "locator": "public.message_backfill_scans.urgent_message_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_scans.urgent_message_id"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.23",
    "surface": "db",
    "locator": "public.message_backfill_tool_contexts",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_tool_contexts"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.24",
    "surface": "db",
    "locator": "public.message_backfill_tool_contexts.after_created_at",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_tool_contexts.after_created_at"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.25",
    "surface": "db",
    "locator": "public.message_backfill_tool_contexts.after_message_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_tool_contexts.after_message_id"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.26",
    "surface": "db",
    "locator": "public.message_backfill_tool_contexts.call_ordinal",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_tool_contexts.call_ordinal"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.27",
    "surface": "db",
    "locator": "public.message_backfill_tool_contexts.comparison_sequence",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_tool_contexts.comparison_sequence"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.28",
    "surface": "db",
    "locator": "public.message_backfill_tool_contexts.current_message_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_tool_contexts.current_message_id"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.29",
    "surface": "db",
    "locator": "public.message_backfill_tool_contexts.human_actor_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_tool_contexts.human_actor_id"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.30",
    "surface": "db",
    "locator": "public.message_backfill_tool_contexts.next_sequence",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_tool_contexts.next_sequence"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.31",
    "surface": "db",
    "locator": "public.message_backfill_tool_contexts.phase",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_tool_contexts.phase"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.32",
    "surface": "db",
    "locator": "public.message_backfill_tool_contexts.selected_call_ordinal",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_tool_contexts.selected_call_ordinal"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.33",
    "surface": "db",
    "locator": "public.message_backfill_tool_contexts.selected_message_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_tool_contexts.selected_message_id"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.34",
    "surface": "db",
    "locator": "public.message_backfill_tool_contexts.selected_revision",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_tool_contexts.selected_revision"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.35",
    "surface": "db",
    "locator": "public.message_backfill_tool_contexts.session_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_tool_contexts.session_id"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.36",
    "surface": "db",
    "locator": "public.message_backfill_tool_contexts.source_revision",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_tool_contexts.source_revision"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.37",
    "surface": "db",
    "locator": "public.message_backfill_tool_contexts.target_message_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_tool_contexts.target_message_id"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.38",
    "surface": "db",
    "locator": "public.message_backfill_tool_contexts.target_revision",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_tool_contexts.target_revision"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.39",
    "surface": "db",
    "locator": "public.message_backfill_tool_pending_calls",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_tool_pending_calls"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.40",
    "surface": "db",
    "locator": "public.message_backfill_tool_pending_calls.call_ordinal",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_tool_pending_calls.call_ordinal"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.41",
    "surface": "db",
    "locator": "public.message_backfill_tool_pending_calls.human_actor_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_tool_pending_calls.human_actor_id"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.42",
    "surface": "db",
    "locator": "public.message_backfill_tool_pending_calls.sequence",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_tool_pending_calls.sequence"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.43",
    "surface": "db",
    "locator": "public.message_backfill_tool_pending_calls.source_message_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_tool_pending_calls.source_message_id"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.44",
    "surface": "db",
    "locator": "public.message_backfill_tool_pending_calls.source_revision",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.message_backfill_tool_pending_calls.source_revision"
    ],
    "retention": "One resumable per-Human backfill sweep or sparse actionable failure lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.45",
    "surface": "db",
    "locator": "public.session_message_crypto_revisions.repair_publisher_human_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.session_message_crypto_revisions.repair_publisher_human_id"
    ],
    "retention": "Owning configuration, crypto-repair, Session, or Video-project lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.46",
    "surface": "db",
    "locator": "public.session_message_crypto_revisions.repair_source_digest",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.session_message_crypto_revisions.repair_source_digest"
    ],
    "retention": "Owning configuration, crypto-repair, Session, or Video-project lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.47",
    "surface": "db",
    "locator": "public.session_message_crypto_revisions.repair_source_revision",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.session_message_crypto_revisions.repair_source_revision"
    ],
    "retention": "Owning configuration, crypto-repair, Session, or Video-project lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.metadata.48",
    "surface": "db",
    "locator": "public.sessions.message_source_revision",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.sessions.message_source_revision"
    ],
    "retention": "Owning configuration, crypto-repair, Session, or Video-project lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  }
];

export const REVIEWED_MAIN_2026_09_09_MESSAGEBACKFILL_DEBT_LINKS: readonly ReviewedDebtLink[] = [
  {
    "id": "main.2026-09-09.message-backfill.wire-debt.1",
    "surface": "wire",
    "locator": "http:request_response:GET /api/message-backfill/progress",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n"
    ],
    "reason": "This exact backfill route or open leaf transports source Message coordinates or Message/tool payload material from the same frozen plaintext conversation boundary. It remains release-blocking debt.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.wire-debt.2",
    "surface": "wire",
    "locator": "http:request_response:POST /api/apps/:appId/live-session/complete-command",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n"
    ],
    "reason": "This exact backfill route or open leaf transports source Message coordinates or Message/tool payload material from the same frozen plaintext conversation boundary. It remains release-blocking debt.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.wire-debt.3",
    "surface": "wire",
    "locator": "http:request_response:POST /api/apps/:appId/live-session/complete-command#request.body.requestId",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n"
    ],
    "reason": "This exact backfill route or open leaf transports source Message coordinates or Message/tool payload material from the same frozen plaintext conversation boundary. It remains release-blocking debt.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.wire-debt.4",
    "surface": "wire",
    "locator": "http:request_response:POST /api/apps/:appId/live-session/complete-command#request.body.result",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n"
    ],
    "reason": "This exact backfill route or open leaf transports source Message coordinates or Message/tool payload material from the same frozen plaintext conversation boundary. It remains release-blocking debt.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.wire-debt.5",
    "surface": "wire",
    "locator": "http:request_response:POST /api/apps/:appId/live-session/complete-command#request.body.sessionToken",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n"
    ],
    "reason": "This exact backfill route or open leaf transports source Message coordinates or Message/tool payload material from the same frozen plaintext conversation boundary. It remains release-blocking debt.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.wire-debt.6",
    "surface": "wire",
    "locator": "http:request_response:POST /api/apps/:appId/live-session/complete-command#response.body.command.command",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n"
    ],
    "reason": "This exact backfill route or open leaf transports source Message coordinates or Message/tool payload material from the same frozen plaintext conversation boundary. It remains release-blocking debt.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.wire-debt.7",
    "surface": "wire",
    "locator": "http:request_response:POST /api/apps/:appId/live-session/receive-command",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n"
    ],
    "reason": "This exact backfill route or open leaf transports source Message coordinates or Message/tool payload material from the same frozen plaintext conversation boundary. It remains release-blocking debt.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.wire-debt.8",
    "surface": "wire",
    "locator": "http:request_response:POST /api/apps/:appId/live-session/receive-command#request.body.requestId",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n"
    ],
    "reason": "This exact backfill route or open leaf transports source Message coordinates or Message/tool payload material from the same frozen plaintext conversation boundary. It remains release-blocking debt.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.wire-debt.9",
    "surface": "wire",
    "locator": "http:request_response:POST /api/apps/:appId/live-session/receive-command#request.body.result",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n"
    ],
    "reason": "This exact backfill route or open leaf transports source Message coordinates or Message/tool payload material from the same frozen plaintext conversation boundary. It remains release-blocking debt.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.wire-debt.10",
    "surface": "wire",
    "locator": "http:request_response:POST /api/apps/:appId/live-session/receive-command#request.body.sessionToken",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n"
    ],
    "reason": "This exact backfill route or open leaf transports source Message coordinates or Message/tool payload material from the same frozen plaintext conversation boundary. It remains release-blocking debt.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.wire-debt.11",
    "surface": "wire",
    "locator": "http:request_response:POST /api/apps/:appId/live-session/receive-command#response.body.command.command",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n"
    ],
    "reason": "This exact backfill route or open leaf transports source Message coordinates or Message/tool payload material from the same frozen plaintext conversation boundary. It remains release-blocking debt.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.wire-debt.12",
    "surface": "wire",
    "locator": "http:request_response:POST /api/message-backfill/ack",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n"
    ],
    "reason": "This exact backfill route or open leaf transports source Message coordinates or Message/tool payload material from the same frozen plaintext conversation boundary. It remains release-blocking debt.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.wire-debt.13",
    "surface": "wire",
    "locator": "http:request_response:POST /api/message-backfill/next",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n"
    ],
    "reason": "This exact backfill route or open leaf transports source Message coordinates or Message/tool payload material from the same frozen plaintext conversation boundary. It remains release-blocking debt.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.wire-debt.14",
    "surface": "wire",
    "locator": "http:request_response:POST /api/message-backfill/publish",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n"
    ],
    "reason": "This exact backfill route or open leaf transports source Message coordinates or Message/tool payload material from the same frozen plaintext conversation boundary. It remains release-blocking debt.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.message-backfill.wire-debt.15",
    "surface": "wire",
    "locator": "http:request_response:POST /api/message-backfill/source",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n"
    ],
    "reason": "This exact backfill route or open leaf transports source Message coordinates or Message/tool payload material from the same frozen plaintext conversation boundary. It remains release-blocking debt.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-message-backfill-security.test.ts"
    ]
  }
];

export const RETIRED_MAIN_2026_09_09_MESSAGEBACKFILL_FROZEN_DEBT: readonly RetiredFrozenDebt[] = [];
