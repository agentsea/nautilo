import type { EncryptionCoverageEntry } from "../src/model";

const PUSH_REPOSITORY = "packages/db/src/queries/push-notifications.ts";
const PUSH_SCHEMA_EVIDENCE =
  "packages/db/tests/unit/push-notification-schema.test.ts";

/**
 * Main added durable push-delivery coordination after the previous inventory
 * review. These raw-SQL sites contain no notification copy, provider token, or
 * Room content: they operate only on the bounded candidate lifecycle, or call
 * fixed read-only maintenance functions whose dynamic wrapper is deliberately
 * reported by the fail-closed raw-SQL scanner.
 */
export const REVIEWED_MAIN_2026_08_11_DATABASE_WRITER_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
    {
      id: "db.main-2026-08-11.push-candidate-claim",
      surface: "db",
      locator:
        "packages/db/src/queries/push-notifications.ts#claimNextPushMessageCandidate:raw_sql:update:public.push_message_candidates:1",
      owner: "packages/db",
      readers: [PUSH_REPOSITORY],
      writers: [PUSH_REPOSITORY],
      migrationState: "not_applicable",
      retention:
        "The content-free candidate row remains only through its bounded pending, claimed, and terminal delivery lifecycle before retention cleanup.",
      testEvidence: [PUSH_SCHEMA_EVIDENCE],
      classification: "bounded_metadata",
      metadataAllowlist: [
        "message_id",
        "state",
        "claim_owner",
        "claim_expires_at",
        "created_at",
      ],
      plaintextReason:
        "Claiming requires only the message coordinate, bounded lease identity, lifecycle state, and timestamps; the table is proven not to contain message or notification content.",
    },
    {
      id: "db.main-2026-08-11.push-maintenance-functions",
      surface: "db",
      locator:
        "packages/db/src/queries/push-notifications.ts#one:raw_sql:unresolved:unresolved.dynamic_sql:1",
      owner: "packages/db",
      readers: [PUSH_REPOSITORY],
      writers: [],
      migrationState: "not_applicable",
      retention:
        "The local wrapper retains nothing; it executes one of four fixed maintenance SELECT calls and returns only a bounded affected-row count.",
      testEvidence: [PUSH_SCHEMA_EVIDENCE],
      classification: "bounded_metadata",
      metadataAllowlist: [
        "maintenance_timestamp",
        "batch_limit",
        "affected_row_count",
      ],
      plaintextReason:
        "The scanner intentionally fails closed on the local SQL wrapper, but every caller supplies a fixed maintenance function invocation containing only a timestamp and bounded batch limit.",
    },
    {
      id: "db.main-2026-08-11.push-candidate-purge",
      surface: "db",
      locator:
        "packages/db/src/queries/push-notifications.ts#purgeTerminalPushMessageCandidates:raw_sql:delete:public.push_message_candidates:1",
      owner: "packages/db",
      readers: [PUSH_REPOSITORY],
      writers: [PUSH_REPOSITORY],
      migrationState: "not_applicable",
      retention:
        "Terminal content-free candidate rows are deleted in bounded batches after the configured seven-day operational retention window.",
      testEvidence: [PUSH_SCHEMA_EVIDENCE],
      classification: "bounded_metadata",
      metadataAllowlist: [
        "message_id",
        "terminal_at",
      ],
      plaintextReason:
        "Purge selection and deletion use only the message coordinate and terminal timestamp; executable schema evidence excludes message, notification, and provider-token content from the table.",
    },
  ];
