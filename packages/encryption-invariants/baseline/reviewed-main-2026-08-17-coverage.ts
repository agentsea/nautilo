import type { EncryptionCoverageEntry } from "../src/model";

const REVIEW_EVIDENCE =
  "packages/encryption-invariants/tests/integration/reviewed-main-2026-08-17-security.test.ts";
const MEDIA_SCHEMA_EVIDENCE =
  "packages/db/tests/unit/d525-media-generations-schema.test.ts";
const MEDIA_REPOSITORY_EVIDENCE =
  "packages/db/tests/unit/d525-media-generations-repository.test.ts";
const MEDIA_DISPATCH_EVIDENCE =
  "packages/server/tests/unit-isolated/messaging-route-http.test.ts";

const mediaLifecycleFields = [
  "completion_wake_claimed_at",
  "completion_wake_delivered_at",
  "initiating_agent_id",
  "initiating_thread_id",
  "provider_average_execution_seconds",
  "provider_execution_seconds",
] as const;

const mediaLifecycleEntries: readonly EncryptionCoverageEntry[] =
  mediaLifecycleFields.map((field) => ({
    id: `db.main-2026-08-17.media-generation-${field.replaceAll("_", "-")}`,
    surface: "db",
    locator: `public.media_generations.${field}`,
    owner: "packages/db",
    readers: ["packages/db/src/queries/media-generations.ts"],
    writers: ["packages/db/src/queries/media-generations.ts"],
    migrationState: "not_applicable",
    retention:
      "Retained only for bounded media-provider timing and restart-safe completion-wake coordination.",
    testEvidence: [
      REVIEW_EVIDENCE,
      MEDIA_SCHEMA_EVIDENCE,
      MEDIA_REPOSITORY_EVIDENCE,
    ],
    classification: "bounded_metadata",
    metadataAllowlist: [field],
    plaintextReason:
      "This field contains only an opaque Agent or thread coordinate, a non-negative provider timing, or a completion-wake lease/delivery timestamp. It contains no prompt, lyrics, reference bytes, generated media, provider credential, key, or message content.",
  }));

const workcardContinuationEntries: readonly EncryptionCoverageEntry[] = [
  "http:accepted_arbitrary:packages/server/src/messaging/dispatch.ts#RoomPostMessageBody#cardContinuation",
  "http:request_response:POST /api/rooms/:roomId/messages#request.body.cardContinuation",
].map((locator, index) => ({
  id: `wire.main-2026-08-17.advanced-video-workcard-continuation-${index + 1}`,
  surface: "wire",
  locator,
  owner: "packages/server",
  readers: ["packages/server/src/messaging/dispatch.ts"],
  writers: ["apps/workbench/src/components/tool-card/renderers/prepare-video.tsx"],
  migrationState: "not_applicable",
  retention:
    "The accepted marker exists only for the current request and becomes a closed content-free transcript annotation.",
  testEvidence: [REVIEW_EVIDENCE, MEDIA_DISPATCH_EVIDENCE],
  classification: "bounded_metadata",
  metadataAllowlist: ["advanced_video"],
  plaintextReason:
    "The parser accepts exactly the literal advanced_video after independently requiring the fixed continuation command and one to thirty Workspace Artifact references. It carries no prompt, image bytes, path, credential, or free-form continuation payload.",
}));

export const REVIEWED_MAIN_2026_08_17_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
  ...mediaLifecycleEntries,
  ...workcardContinuationEntries,
];
