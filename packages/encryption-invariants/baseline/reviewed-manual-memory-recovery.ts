import type { EncryptionCoverageEntry } from "../src/model";
import type { DtoDeclaration } from "../src/node/dto-inventory";

const GET_RECOVERY_ROUTE =
  "http:request_response:GET /api/admin/memory-recovery";
const POST_RECOVERY_ROUTE =
  "http:request_response:POST /api/admin/memory-recovery";

const REVIEWED_MANUAL_RECOVERY_DTO_LOCATORS = new Set([
  GET_RECOVERY_ROUTE,
  POST_RECOVERY_ROUTE,
]);

export const REVIEWED_MANUAL_RECOVERY_DTO_DECLARATIONS:
  readonly DtoDeclaration[] = [
  {
    observationId:
      "wire.http.request.response.get.api.admin.memory.recovery.pmqz63",
    locator: GET_RECOVERY_ROUTE,
    structuralSignatures: [
      "response.body:{error:string}",
      "response.body:{run:{memory?:{held:number;queued:number;state:\"assessed\"}|{state:\"paused\"}|{state:\"unavailable\"};observedThrough:string;reflection?:{held:number;queued:number;state:\"assessed\"}|{state:\"paused\"}|{state:\"unavailable\"};requestId:string;stenographer?:{held:number;queued:number;state:\"assessed\"}|{state:\"paused\"}|{state:\"unavailable\"}}}",
    ],
    arbitraryPayloads: [],
  },
  {
    observationId:
      "wire.http.request.response.post.api.admin.memory.recovery.1sbu2fl",
    locator: POST_RECOVERY_ROUTE,
    structuralSignatures: [
      "response.body:{error:string}",
      "response.body:{memory?:{held:number;queued:number;state:\"assessed\"}|{state:\"paused\"}|{state:\"unavailable\"};observedThrough:string;reflection?:{held:number;queued:number;state:\"assessed\"}|{state:\"paused\"}|{state:\"unavailable\"};requestId:string;stenographer?:{held:number;queued:number;state:\"assessed\"}|{state:\"paused\"}|{state:\"unavailable\"}}",
    ],
    arbitraryPayloads: [],
  },
];

export function reviewedManualRecoveryDtoReplacements(
  declarations: readonly DtoDeclaration[],
): readonly DtoDeclaration[] {
  return [
    ...declarations.filter((entry) =>
      !REVIEWED_MANUAL_RECOVERY_DTO_LOCATORS.has(entry.locator)
    ),
    ...REVIEWED_MANUAL_RECOVERY_DTO_DECLARATIONS,
  ];
}

const RUN_TABLE = "public.memory_recovery_runs";
const RUN_FIELDS = [
  "authorized_by",
  "id",
  "memory",
  "observed_through",
  "reflection",
  "stenographer",
] as const;

const JOURNAL_TABLE = "public.room_journal_model_recoveries";
const JOURNAL_FIELDS = [
  "authorized_at",
  "authorized_by",
  "claim_lease_token",
  "claimed_at",
  "id",
  "observed_attempt",
  "observed_failure_at",
  "observed_through",
  "rebuild_generation",
  "room_id",
  "source_batch_id",
  "spent_at",
  "target_model_id",
  "work_id",
  "work_kind",
] as const;

const REFLECTION_TABLE = "public.reflection_record_semantic_work";
const REFLECTION_FIELDS = [
  "manual_recovery_authorized_at",
  "manual_recovery_authorized_by",
  "manual_recovery_id",
  "manual_recovery_observed_through",
  "manual_recovery_service_model_id",
  "manual_recovery_source_generation",
  "manual_recovery_spent_at",
] as const;

const SECURITY_TEST =
  "packages/encryption-invariants/tests/integration/reviewed-manual-memory-recovery-security.test.ts";

function metadataEntries(input: {
  readonly id: string;
  readonly table: string;
  readonly fields: readonly string[];
  readonly owner: string;
  readonly readers: readonly string[];
  readonly writers: readonly string[];
  readonly retention: string;
  readonly tests: readonly string[];
  readonly reason: string;
  readonly includeTable: boolean;
}): readonly EncryptionCoverageEntry[] {
  const locators = input.includeTable
    ? [input.table, ...input.fields.map((field) => `${input.table}.${field}`)]
    : input.fields.map((field) => `${input.table}.${field}`);
  return locators.map((locator, index): EncryptionCoverageEntry => ({
    id: `db.manual-memory-recovery.${input.id}.${index + 1}`,
    surface: "db",
    locator,
    owner: input.owner,
    readers: input.readers,
    writers: input.writers,
    migrationState: "not_applicable",
    retention: input.retention,
    testEvidence: [...input.tests, SECURITY_TEST],
    classification: "bounded_metadata",
    metadataAllowlist: locator === input.table
      ? [...input.fields]
      : [locator.slice(input.table.length + 1)],
    plaintextReason: input.reason,
  }));
}

export const REVIEWED_MANUAL_MEMORY_RECOVERY_COVERAGE:
  readonly EncryptionCoverageEntry[] = [
  ...metadataEntries({
    id: "run",
    table: RUN_TABLE,
    fields: RUN_FIELDS,
    owner: "packages/server",
    readers: ["packages/server/src/lib/manual-memory-recovery.ts"],
    writers: ["packages/server/src/lib/manual-memory-recovery.ts"],
    retention:
      "Retained as an idempotent operator-request receipt and lane-result audit record until ordinary server data retirement.",
    tests: [
      "packages/server/tests/integration/manual-memory-recovery.integration.test.ts",
      "packages/server/tests/unit/memory-status-route.test.ts",
    ],
    reason:
      "The product-only run contains one request UUID, one operator UUID, an observation timestamp, and three closed lane results containing only state and counts. It contains no prompt, Memory content, model output, provider response, credential, or cryptographic material.",
    includeTable: true,
  }),
  ...metadataEntries({
    id: "journal",
    table: JOURNAL_TABLE,
    fields: JOURNAL_FIELDS,
    owner: "packages/runtime",
    readers: [
      "packages/runtime/src/stenographer/repository.ts",
      "packages/server/src/lib/request-manual-journal-recovery.ts",
      "packages/server/src/lib/stenographer-memory-funding.ts",
    ],
    writers: [
      "packages/runtime/src/stenographer/repository.ts",
      "packages/server/src/lib/request-manual-journal-recovery.ts",
    ],
    retention:
      "Retained with the owning Journal work as authorization and consumption evidence; Room deletion cascades the receipt.",
    tests: [
      "packages/server/tests/integration/manual-journal-recovery.integration.test.ts",
      "packages/server/tests/unit/request-manual-journal-recovery.test.ts",
    ],
    reason:
      "The product-only receipt contains exact Journal work coordinates, attempt and rebuild counters, a configured model identifier, operator and lease UUIDs, and lifecycle timestamps. It contains no Journal text, model input or output, provider response, credential, or cryptographic material.",
    includeTable: true,
  }),
  ...metadataEntries({
    id: "reflection",
    table: REFLECTION_TABLE,
    fields: REFLECTION_FIELDS,
    owner: "packages/reflection-bridge",
    readers: [
      "packages/reflection-bridge/src/server/postgres-semantic-work-store.ts",
    ],
    writers: [
      "packages/reflection-bridge/src/server/postgres-semantic-work-store.ts",
    ],
    retention:
      "Retained on the exact semantic-work generation as authorization and consumption evidence; later canonical admission clears the marker and Record deletion cascades the work row.",
    tests: [
      "packages/reflection-bridge/tests/unit/postgres-semantic-work-store.test.ts",
      "packages/server/tests/integration/manual-reflection-recovery.integration.test.ts",
    ],
    reason:
      "These fields contain one recovery UUID, one operator UUID, source-generation and configured-model coordinates, and observation, authorization, and consumption timestamps. They contain no Record payload, model input or output, provider response, credential, HMAC key, or commitment secret.",
    includeTable: false,
  }),
  ...[GET_RECOVERY_ROUTE, POST_RECOVERY_ROUTE].map(
    (locator, index): EncryptionCoverageEntry => ({
      id: `wire.manual-memory-recovery.${index + 1}`,
      surface: "wire",
      locator,
      owner: "packages/server",
      readers: ["packages/server/src/routes/memory-status.ts"],
      writers: ["packages/server/src/routes/memory-status.ts"],
      migrationState: "not_applicable",
      retention: "Authenticated server-operations request lifetime only.",
      testEvidence: [
        "packages/server/tests/unit/memory-status-route.test.ts",
        SECURITY_TEST,
      ],
      classification: "bounded_metadata",
      metadataAllowlist: [
        "requestId",
        "confirmBillableRerun",
        "run",
        "observedThrough",
        "stenographer",
        "reflection",
        "memory",
        "state",
        "queued",
        "held",
        "error",
      ],
      plaintextReason:
        "The capability-gated route carries one request UUID, literal billable confirmation, observation time, and closed lane states and counts. It never carries Memory or Journal content, Record payloads, model input or output, provider responses, credentials, or keys.",
    }),
  ),
];

export const MANUAL_MEMORY_RECOVERY_DATABASE_LOCATORS = [
  RUN_TABLE,
  ...RUN_FIELDS.map((field) => `${RUN_TABLE}.${field}`),
  JOURNAL_TABLE,
  ...JOURNAL_FIELDS.map((field) => `${JOURNAL_TABLE}.${field}`),
  ...REFLECTION_FIELDS.map((field) => `${REFLECTION_TABLE}.${field}`),
] as const;
