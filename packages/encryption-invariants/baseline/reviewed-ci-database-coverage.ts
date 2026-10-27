import type { EncryptionCoverageEntry } from "../src/model";
import type { ReviewedDebtLink } from "../src/registry";

const QUERY_OWNER = "packages/db/src/queries/bolter-bridge.ts";
const SCHEMA_EVIDENCE =
  "packages/encryption-invariants/tests/integration/reviewed-ci-database-coverage.test.ts";
const QUERY_EVIDENCE = "packages/db/tests/unit/bolter-bridge-queries.test.ts";
const DATABASE_EVIDENCE =
  "packages/db/tests/integration/bolter-bridge.integration.test.ts";
const MIGRATION_EVIDENCE =
  "packages/db/tests/unit/magent-control-migration.test.ts";

const EXTERNAL_OPERATOR_CONNECTION_METADATA_FIELDS = [
  "provider",
  "transport_kind",
  "operator_binding_id",
] as const;

const EXTERNAL_OPERATOR_BINDING_METADATA_FIELDS = ["provider"] as const;

const EXTERNAL_OPERATOR_SESSION_METADATA_FIELDS = [
  "binding_id",
  "user_id",
  "session_id",
  "created_at",
] as const;

const EXTERNAL_OPERATOR_ARCHIVE_METADATA_FIELDS = [
  "message_id",
  "user_id",
  "receipt_id",
  "binding_id",
  "session_id",
  "kind",
  "archived_at",
] as const;

type MetadataGroup = Readonly<{
  id: string;
  table: string;
  fields: readonly string[];
  retention: string;
  plaintextReason: string;
  testEvidence: readonly string[];
}>;

function metadataEntries(
  group: MetadataGroup,
  includeTable: boolean,
): readonly EncryptionCoverageEntry[] {
  const locators = [
    ...(includeTable ? [`public.${group.table}`] : []),
    ...group.fields.map((field) => `public.${group.table}.${field}`),
  ];
  return locators.map((locator, index) => ({
    id: `db.external-operator.${group.id}.${index + 1}`,
    surface: "db",
    locator,
    owner: "packages/db",
    readers: [QUERY_OWNER],
    writers: [QUERY_OWNER, "packages/server/src/lib/user-account-deletion.ts"],
    migrationState: "not_applicable",
    retention: group.retention,
    testEvidence: group.testEvidence,
    classification: "bounded_metadata",
    metadataAllowlist: group.fields,
    plaintextReason: group.plaintextReason,
  }));
}

/** Exact content-free coordinates added for the isolated operator transport. */
export const REVIEWED_CI_DATABASE_COVERAGE: readonly EncryptionCoverageEntry[] = [
  ...metadataEntries({
    id: "connection",
    table: "bolter_connections",
    fields: EXTERNAL_OPERATOR_CONNECTION_METADATA_FIELDS,
    retention:
      "Retained with the owner-scoped external connection until explicit revocation or owning-Human deletion.",
    testEvidence: [SCHEMA_EVIDENCE, QUERY_EVIDENCE, DATABASE_EVIDENCE],
    plaintextReason:
      "The closed provider and transport discriminants plus the opaque operator binding UUID select one admitted transport. They contain no request, result, credential, display label, transcript, or encryption key.",
  }, false),
  ...metadataEntries({
    id: "binding",
    table: "bolter_room_bindings",
    fields: EXTERNAL_OPERATOR_BINDING_METADATA_FIELDS,
    retention:
      "Retained with the immutable external Room binding, including after the binding is paused or revoked.",
    testEvidence: [SCHEMA_EVIDENCE, QUERY_EVIDENCE, DATABASE_EVIDENCE],
    plaintextReason:
      "The closed provider discriminator binds the existing owner, Room, Genie, connection, and revision coordinates to one transport family. It contains no authored input or generated result.",
  }, false),
  ...metadataEntries({
    id: "session",
    table: "external_operator_sessions",
    fields: EXTERNAL_OPERATOR_SESSION_METADATA_FIELDS,
    retention:
      "Retained for the owner-scoped binding lifetime so a later connector generation cannot inherit an earlier execution context.",
    testEvidence: [SCHEMA_EVIDENCE, QUERY_EVIDENCE, DATABASE_EVIDENCE],
    plaintextReason:
      "The row contains only owner and binding UUIDs, an opaque connector-session generation, and creation time. It is an isolation fence and carries no prompt, result, transcript, credential, or key material.",
  }, true),
  ...metadataEntries({
    id: "archive-coordinate",
    table: "external_operator_control_archive",
    fields: EXTERNAL_OPERATOR_ARCHIVE_METADATA_FIELDS,
    retention:
      "Retained as immutable owner-scoped audit coordinates until the owning Human is deleted; the separately linked evidence payload remains plaintext debt.",
    testEvidence: [SCHEMA_EVIDENCE, MIGRATION_EVIDENCE,
      "packages/db/tests/integration/operator-control-archive-cascade.integration.test.ts"],
    plaintextReason:
      "These fields contain only original row, owner, receipt, binding and session identifiers, a closed input/result kind, and archive time. The evidence column and the table-wide content boundary are deliberately excluded and remain linked to frozen Message-content debt.",
  }, false),
];

const SESSION_MESSAGE_CONTENT_DEBT = "debt.db.public.session_messages.content";

function contentDebtLink(input: {
  id: string;
  locator: string;
  field: string;
  targetDebtIds?: readonly string[];
  reason: string;
  testEvidence: readonly string[];
}): ReviewedDebtLink {
  return {
    id: `debt-link.db.external-operator.${input.id}`,
    surface: "db",
    locator: input.locator,
    owner: "packages/db",
    targetDebtIds: input.targetDebtIds ?? [SESSION_MESSAGE_CONTENT_DEBT],
    reason: input.reason,
    testEvidence: input.testEvidence,
    crossBoundaryProjection: {
      fields: [input.field],
      rationale:
        "The field preserves whole legacy rows or the same authored input or generated result represented by their exact frozen plaintext database slots.",
    },
  };
}

/** Plaintext operator input, result, and historical evidence remain visible debt. */
export const REVIEWED_CI_DATABASE_DEBT_LINKS: readonly ReviewedDebtLink[] = [
  contentDebtLink({
    id: "control-input",
    locator: "public.bolter_inbox_receipts.control_input",
    field: "control_input",
    reason:
      "The isolated control receipt retains the externally authored request text that the legacy path stored as canonical Message content. Isolation from Human chat does not encrypt or reclassify that text.",
    testEvidence: [SCHEMA_EVIDENCE, QUERY_EVIDENCE, DATABASE_EVIDENCE],
  }),
  contentDebtLink({
    id: "control-result",
    locator: "public.bolter_outbox.control_result",
    field: "control_result",
    reason:
      "The isolated outbox retains generated result text that the legacy path stored as canonical Message content. Publication fencing does not encrypt or reclassify that text.",
    testEvidence: [SCHEMA_EVIDENCE, QUERY_EVIDENCE, DATABASE_EVIDENCE],
  }),
  contentDebtLink({
    id: "archive-table",
    locator: "public.external_operator_control_archive",
    field: "evidence",
    targetDebtIds: [
      SESSION_MESSAGE_CONTENT_DEBT,
      "debt.db.public.session_messages.content_search",
      "debt.db.public.session_messages.metadata",
      "debt.db.public.sessions.title",
      "debt.db.public.jobs.result",
      "debt.db.public.jobs.message",
      "debt.db.public.jobs.metadata",
    ],
    reason:
      "The immutable audit table contains exact legacy Message evidence, including authored input or generated result text. Owner scoping and immutability preserve custody but do not make the archive metadata-only.",
    testEvidence: [SCHEMA_EVIDENCE, MIGRATION_EVIDENCE,
      "packages/db/tests/integration/operator-control-archive-cascade.integration.test.ts"],
  }),
  contentDebtLink({
    id: "archive-evidence",
    locator: "public.external_operator_control_archive.evidence",
    field: "evidence",
    targetDebtIds: [
      SESSION_MESSAGE_CONTENT_DEBT,
      "debt.db.public.session_messages.content_search",
      "debt.db.public.session_messages.metadata",
      "debt.db.public.sessions.title",
      "debt.db.public.jobs.result",
      "debt.db.public.jobs.message",
      "debt.db.public.jobs.metadata",
    ],
    reason:
      "The evidence object deliberately preserves the legacy canonical Message row and therefore repeats its plaintext authored input or generated result content for audit.",
    testEvidence: [SCHEMA_EVIDENCE, MIGRATION_EVIDENCE,
      "packages/db/tests/integration/operator-control-archive-cascade.integration.test.ts"],
  }),
];

export const REVIEWED_CI_DATABASE_OBSERVATION_LOCATORS = [
  ...REVIEWED_CI_DATABASE_COVERAGE.map((entry) => entry.locator),
  ...REVIEWED_CI_DATABASE_DEBT_LINKS.map((entry) => entry.locator),
] as const;

export const REVIEWED_CI_DATABASE_WRITER_LOCATORS = [
  "packages/db/src/queries/bolter-bridge.ts#acceptBolterInboundWith:insert:public.external_operator_sessions:1",
  "packages/db/src/queries/bolter-bridge.ts#cancelMagentReceiptWith:update:public.bolter_inbox_receipts:1",
  "packages/db/src/queries/bolter-bridge.ts#cancelMagentReceiptWith:update:public.bolter_outbox:1",
  "packages/db/src/queries/bolter-bridge.ts#claimBolterOutboxWith:update:public.bolter_outbox:1",
  "packages/db/src/queries/bolter-bridge.ts#createMagentOperatorConnectionWith:insert:public.bolter_connections:1",
] as const;
