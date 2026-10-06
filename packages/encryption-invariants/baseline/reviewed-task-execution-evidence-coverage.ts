import type { EncryptionCoverageEntry } from "../src/model";

type MetadataGroup = Readonly<{
  id: string;
  table: string;
  fields: readonly string[];
  readers: readonly string[];
  writers: readonly string[];
  retention: string;
  testEvidence: readonly string[];
  plaintextReason: string;
}>;

function entriesFor(group: MetadataGroup): readonly EncryptionCoverageEntry[] {
  const locators = [
    group.table,
    ...group.fields.map((field) => `${group.table}.${field}`),
  ];
  return locators.map((locator, index) => ({
    id: `db.task-execution-evidence.${group.id}.${index + 1}`,
    surface: "db",
    locator,
    owner: "packages/runtime",
    readers: group.readers,
    writers: group.writers,
    migrationState: "not_applicable",
    retention: group.retention,
    testEvidence: group.testEvidence,
    classification: "bounded_metadata",
    metadataAllowlist: group.fields,
    plaintextReason: group.plaintextReason,
  }));
}

export const TASK_RUN_MESSAGE_ASSOCIATION_METADATA_FIELDS = [
  "task_run_id",
  "session_id",
  "message_id",
  "published_revision",
  "kind",
  "publication_key",
  "created_at",
] as const;

export const PROTECTED_TASK_EXECUTION_SEGMENT_METADATA_FIELDS = [
  "task_run_id",
  "execution_segment",
  "job_id",
  "route",
  "transcript_contract",
  "expected_transcript_association_count",
  "transcript_association_digest",
  "checkpoint_contract",
  "expected_checkpoint_count",
  "checkpoint_digest",
  "expected_checkpoint_blob_count",
  "checkpoint_blob_digest",
  "expected_pending_write_count",
  "pending_write_digest",
  "sealed_at",
] as const;

export const PROTECTED_TASK_CONTINUATION_METADATA_FIELDS = [
  "task_run_id",
  "execution_segment",
  "job_id",
  "kind",
  "reason",
  "effect_disposition",
  "interrupt_id",
  "operation_id",
  "request_digest",
  "required_authority_digest",
  "sealed_at",
] as const;

const RECEIPT_QUERY =
  "packages/db/src/queries/protected-task-execution-receipts.ts";
const MESSAGE_QUERY =
  "packages/db/src/queries/task-run-message-associations.ts";

export const REVIEWED_TASK_EXECUTION_EVIDENCE_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
  ...entriesFor({
    id: "message-association",
    table: "public.task_run_message_associations",
    fields: TASK_RUN_MESSAGE_ASSOCIATION_METADATA_FIELDS,
    readers: [MESSAGE_QUERY],
    writers: [MESSAGE_QUERY],
    retention:
      "Retained as an immutable TaskRun publication receipt until the owning TaskRun is deleted; Message deletion deliberately leaves this content-free denominator intact.",
    testEvidence: [
      "packages/db/tests/unit/task-run-message-associations.test.ts",
      "packages/db/tests/integration/task-message-evidence.integration.test.ts",
      "packages/db/tests/unit/task-execution-evidence-migration.test.ts",
    ],
    plaintextReason:
      "The exact schema stores only TaskRun, Session and Message coordinates, a nonnegative published revision, a closed publication kind, a bounded opaque idempotency key and creation time. It contains no Message body, prompt, response, tool payload, checkpoint bytes, credential or key material.",
  }),
  ...entriesFor({
    id: "execution-segment",
    table: "public.protected_task_execution_segment_receipts",
    fields: PROTECTED_TASK_EXECUTION_SEGMENT_METADATA_FIELDS,
    readers: [RECEIPT_QUERY],
    writers: [RECEIPT_QUERY],
    retention:
      "Retained as one immutable physical-writer manifest per protected TaskRun segment until the owning TaskRun is deleted.",
    testEvidence: [
      "packages/db/tests/unit/protected-task-execution-receipts.test.ts",
      "packages/db/tests/integration/protected-task-execution-receipts.integration.test.ts",
      "packages/db/tests/unit/task-execution-evidence-migration.test.ts",
    ],
    plaintextReason:
      "The exact schema stores only TaskRun, Job and segment coordinates, closed route and manifest-contract codes, nonnegative counts, fixed 32-byte ordered digests and seal time. Digests attest already protected transcript and checkpoint stores without retaining their content, ciphertext or key material.",
  }),
  ...entriesFor({
    id: "continuation",
    table: "public.protected_task_continuation_receipts",
    fields: PROTECTED_TASK_CONTINUATION_METADATA_FIELDS,
    readers: [RECEIPT_QUERY],
    writers: [RECEIPT_QUERY],
    retention:
      "Retained as one immutable continuation decision per protected TaskRun segment until its exact segment or owning TaskRun is deleted.",
    testEvidence: [
      "packages/db/tests/unit/protected-task-execution-receipts.test.ts",
      "packages/db/tests/integration/protected-task-execution-receipts.integration.test.ts",
      "packages/db/tests/unit/task-execution-evidence-migration.test.ts",
    ],
    plaintextReason:
      "The exact schema stores only TaskRun, Job and segment coordinates, closed continuation, reason and effect-disposition codes, bounded opaque interrupt and operation identifiers, fixed 32-byte request and authority digests, and seal time. It contains no request body, tool payload, checkpoint content, credential or key material.",
  }),
];
