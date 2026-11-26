import type { EncryptionCoverageEntry } from "../src/model";
import type { DtoDeclaration } from "../src/node/dto-inventory";

const RECOVERY_ROUTE =
  "http:request_response:POST /api/admin/memory-review-recovery";
const STENOGRAPHER_STATUS_ROUTE =
  "http:request_response:GET /api/admin/stenographer-status";

const REVIEWED_MEMORY_REVIEW_DTO_LOCATORS = new Set([
  RECOVERY_ROUTE,
  STENOGRAPHER_STATUS_ROUTE,
]);

export const REVIEWED_MEMORY_REVIEW_DTO_DECLARATIONS:
  readonly DtoDeclaration[] = [
  {
    observationId:
      "wire.http.request.response.post.api.admin.memory.review.recovery.rscc0a",
    locator: RECOVERY_ROUTE,
    structuralSignatures: [
      "response.body:{error:string}",
      "response.body:{status:\"already_requested\"|\"blocked\"|\"queued\"}",
    ],
    arbitraryPayloads: [],
  },
  {
    observationId:
      "wire.http.request.response.get.api.admin.stenographer.status.v9h5bb",
    locator: STENOGRAPHER_STATUS_ROUTE,
    structuralSignatures: [
      "response.body:{compaction:{awaitingRooms:number;lastCompletedAt?:string;oldestOverdueMs:number;processingRooms:number;retryingRooms:number;staleLeases:number};current:{accumulatingRooms:number;caughtUpRooms:number;dueRooms:number;eligibleRooms:number;historicalCompletedRooms:number;historicalPendingRooms:number;oldestOverdueMs:number;processingRooms:number;rebuildingRooms:number;retryingRooms:number;staleLeases:number};generatedAt:string;health:\"degraded\"|\"delayed\"|\"healthy\";journal:{projectedBodyCodePointsMax?:number;projectedBodyCodePointsP50?:number;projectedBodyCodePointsP95?:number};last24h:{completedExtractionBatches:number;eventsWritten:number;extractionBatchesWithErrors:number;extractionDurationP50Ms?:number;extractionDurationP95Ms?:number;retriedExtractionBatches:number;zeroEventExtractionBatches:number};recentFailures:{attemptCount:number;errorCode:\"input_authority_unavailable\"|\"input_too_large\"|\"invalid_output\"|\"lease_lost\"|\"persistence\"|\"provider\"|\"provider_outcome_unknown\"|\"timeout\"|\"unknown\";modelId?:string;occurredAt:string;stage:\"compaction\"|\"extraction\"}[];window:{since:string;until:string}}",
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [],
  },
];

export function reviewedMemoryReviewDtoReplacements(
  declarations: readonly DtoDeclaration[],
): readonly DtoDeclaration[] {
  return [
    ...declarations.filter((entry) =>
      !REVIEWED_MEMORY_REVIEW_DTO_LOCATORS.has(entry.locator)
    ),
    ...REVIEWED_MEMORY_REVIEW_DTO_DECLARATIONS,
  ];
}

const RECOVERY_TABLE = "public.memory_review_model_recoveries";
const RECOVERY_FIELDS = [
  "authorized_at",
  "authorized_by",
  "blocked_attempt_id",
  "head_turn_id",
  "recovery_attempt_id",
  "spent_at",
  "turn_ids",
  "work_id",
] as const;
const RECOVERY_TESTS = [
  "packages/runtime/tests/unit/memory-review-repository.test.ts",
  "packages/runtime/tests/unit/memory-review-worker.test.ts",
] as const;
const ROUTE_TEST = "packages/server/tests/unit/memory-status-route.test.ts";

export const REVIEWED_MEMORY_REVIEW_RECOVERY_COVERAGE:
  readonly EncryptionCoverageEntry[] = [
  ...[RECOVERY_TABLE, ...RECOVERY_FIELDS.map((field) => `${RECOVERY_TABLE}.${field}`)]
    .map((locator, index): EncryptionCoverageEntry => ({
      id: `db.memory-review-model-recovery.${index + 1}`,
      surface: "db",
      locator,
      owner: "packages/runtime",
      readers: ["packages/runtime/src/memory-review/repository.ts"],
      writers: ["packages/runtime/src/memory-review/repository.ts"],
      migrationState: "not_applicable",
      retention:
        "Retained with the owning head turn after consumption so work cannot reuse the authorization. Deleting the head turn removes the row.",
      testEvidence: RECOVERY_TESTS,
      classification: "bounded_metadata",
      metadataAllowlist: locator === RECOVERY_TABLE
        ? [...RECOVERY_FIELDS]
        : [locator.slice(RECOVERY_TABLE.length + 1)],
      plaintextReason:
        "The server-only row contains UUID work, turn, attempt, and operator coordinates plus authorization and consumption timestamps. It contains no transcript, model input or output, provider response, credential, or cryptographic material.",
    })),
  {
    id: "wire.memory-review-model-recovery",
    surface: "wire",
    locator: RECOVERY_ROUTE,
    owner: "packages/server",
    readers: ["packages/server/src/routes/memory-status.ts"],
    writers: ["packages/server/src/routes/memory-status.ts"],
    migrationState: "not_applicable",
    retention: "Authenticated operations request lifetime only.",
    testEvidence: [ROUTE_TEST],
    classification: "bounded_metadata",
    metadataAllowlist: [
      "workId",
      "headTurnId",
      "confirmBillableRerun",
      "status",
      "error",
    ],
    plaintextReason:
      "The strictly parsed operator route carries two UUID coordinates, a literal confirmation, and a closed status or static error. It never carries the review input, output, provider response, or credential.",
  },
];
