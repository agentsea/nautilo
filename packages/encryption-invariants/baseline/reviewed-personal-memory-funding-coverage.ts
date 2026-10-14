import type { EncryptionCoverageEntry } from "../src/model";
import type { ReviewedDebtLink } from "../src/registry";

const REVIEW_TEST =
  "packages/encryption-invariants/tests/integration/reviewed-personal-memory-funding-security.test.ts";

const BINDING_FIELDS = [
  "version",
  "role",
  "modelId",
  "inputCommitment",
  "kind",
  "humanUserId",
  "preferenceRevision",
  "funding.kind",
  "funding.providerRoute",
  "funding.credentialId",
  "funding.credentialRevision",
] as const;

const COMPACTION_PLAN_FIELDS = [
  "version",
  "owner",
  "operationId",
  "rebuildGeneration",
  "previousRollupId",
  "selectedEventIds",
  "protectedTailEventIds",
] as const;

const BINDING_EVIDENCE = [
  REVIEW_TEST,
  "packages/runtime/tests/unit/memory-review-repository.test.ts",
  "packages/runtime/tests/unit/stenographer-repository-parameters.test.ts",
  "packages/reflection-bridge/tests/unit/postgres-semantic-work-store.test.ts",
] as const;

export const PERSONAL_MEMORY_FUNDING_METADATA_LOCATORS = [
  "public.memory_review_turns.accepted_model_binding",
  "public.profiles.soul_revision",
  "public.reflection_record_semantic_work.accepted_model_binding",
  "public.reflection_record_semantic_work.accepted_model_binding_generation",
  "public.room_journal_batches.accepted_model_binding",
  "public.room_journal_state.compaction_accepted_model_binding",
  "public.room_journal_state.compaction_accepted_plan",
  "public.room_journal_state.compaction_last_attempt_known_nonusable",
] as const;

function bindingEntry(
  id: string,
  locator: string,
  owner: string,
  readers: readonly string[],
  writers: readonly string[],
): EncryptionCoverageEntry {
  return {
    id,
    surface: "db",
    locator,
    owner,
    readers: [...readers, "packages/server/src/lib/personal-memory-operation.ts"],
    writers: [...writers, "packages/server/src/lib/personal-memory-operation.ts"],
    migrationState: "not_applicable",
    retention:
      "Retained with the exact durable Memory operation until its owning work row is deleted by the existing Room, review, or Record lifecycle.",
    testEvidence: BINDING_EVIDENCE,
    classification: "bounded_metadata",
    metadataAllowlist: BINDING_FIELDS,
    plaintextReason:
      "The strict accepted binding contains only a capability role, canonical model, opaque HMAC input commitment, payer kind, causal Human and preference revision, plus a provider route and optional opaque personal credential id and revision. It contains no credential value, prompt, Memory text, journal statement, generated output, source coordinate, or provider error.",
  };
}

export const REVIEWED_PERSONAL_MEMORY_FUNDING_COVERAGE:
  readonly EncryptionCoverageEntry[] = [
  bindingEntry(
    "db.personal-memory-funding.review-binding",
    PERSONAL_MEMORY_FUNDING_METADATA_LOCATORS[0],
    "packages/runtime",
    ["packages/runtime/src/memory-review/repository.ts"],
    ["packages/runtime/src/memory-review/repository.ts"],
  ),
  {
    id: "db.personal-memory-funding.soul-revision",
    surface: "db",
    locator: PERSONAL_MEMORY_FUNDING_METADATA_LOCATORS[1],
    owner: "packages/agent",
    readers: [
      "packages/db/src/queries/reflection-sources.ts",
      "packages/server/src/lib/personal-memory-evidence-port.ts",
    ],
    writers: ["packages/agent/src/store/profile-store.ts"],
    migrationState: "not_applicable",
    retention: "Retained with the owning Agent Profile and deleted with it.",
    testEvidence: [
      REVIEW_TEST,
      "packages/agent/tests/unit/profile-store-soul-revision.test.ts",
      "packages/server/tests/unit/personal-memory-evidence-port.test.ts",
    ],
    classification: "bounded_metadata",
    metadataAllowlist: ["soul_revision"],
    plaintextReason:
      "This nonnegative monotonic counter advances when Soul content changes so derived work can reject a stale source snapshot. It contains no Soul text, prompt, digest, key, credential, or generated output.",
  },
  bindingEntry(
    "db.personal-memory-funding.reflection-binding",
    PERSONAL_MEMORY_FUNDING_METADATA_LOCATORS[2],
    "packages/reflection-bridge",
    ["packages/reflection-bridge/src/server/postgres-semantic-work-store.ts"],
    ["packages/reflection-bridge/src/server/postgres-semantic-work-store.ts"],
  ),
  {
    id: "db.personal-memory-funding.reflection-binding-generation",
    surface: "db",
    locator: PERSONAL_MEMORY_FUNDING_METADATA_LOCATORS[3],
    owner: "packages/reflection-bridge",
    readers: ["packages/reflection-bridge/src/server/postgres-semantic-work-store.ts"],
    writers: ["packages/reflection-bridge/src/server/postgres-semantic-work-store.ts"],
    migrationState: "not_applicable",
    retention:
      "Retained with the exact Reflection semantic-work row and its accepted binding.",
    testEvidence: [
      REVIEW_TEST,
      "packages/reflection-bridge/tests/unit/postgres-semantic-work-store.test.ts",
    ],
    classification: "bounded_metadata",
    metadataAllowlist: ["accepted_model_binding_generation"],
    plaintextReason:
      "This integer is the semantic-work generation for which the adjacent accepted model binding was frozen. A database check requires the pair to be absent together or to match the current work generation; it contains no source or generated content.",
  },
  bindingEntry(
    "db.personal-memory-funding.journal-extraction-binding",
    PERSONAL_MEMORY_FUNDING_METADATA_LOCATORS[4],
    "packages/runtime",
    ["packages/runtime/src/stenographer/repository.ts"],
    ["packages/runtime/src/stenographer/repository.ts"],
  ),
  bindingEntry(
    "db.personal-memory-funding.journal-compaction-binding",
    PERSONAL_MEMORY_FUNDING_METADATA_LOCATORS[5],
    "packages/runtime",
    ["packages/runtime/src/stenographer/repository.ts"],
    ["packages/runtime/src/stenographer/repository.ts"],
  ),
  {
    id: "db.personal-memory-funding.journal-compaction-plan",
    surface: "db",
    locator: PERSONAL_MEMORY_FUNDING_METADATA_LOCATORS[6],
    owner: "packages/runtime",
    readers: ["packages/runtime/src/stenographer/repository.ts"],
    writers: ["packages/runtime/src/stenographer/repository.ts"],
    migrationState: "not_applicable",
    retention:
      "Retained with the Room journal cursor while an accepted compaction can be resumed, then replaced only by the next independently admitted compaction.",
    testEvidence: [
      REVIEW_TEST,
      "packages/runtime/tests/unit/stenographer-repository-parameters.test.ts",
      "packages/db/tests/unit/room-journal-funding-schema.test.ts",
    ],
    classification: "bounded_metadata",
    metadataAllowlist: COMPACTION_PLAN_FIELDS,
    plaintextReason:
      "The strict plan stores only an owner mode, stable operation id, rebuild generation, optional prior-rollup id, and opaque event ids needed to resume the exact accepted compaction. selectedEventIds and protectedTailEventIds exist only for an ordinary-owner plan; a protected-owner receipt excludes both arrays. The plan contains no journal statement, rollup text, Message body, prompt, model output, key, credential, or provider error.",
  },
  {
    id: "db.personal-memory-funding.journal-compaction-known-nonusable",
    surface: "db",
    locator: PERSONAL_MEMORY_FUNDING_METADATA_LOCATORS[7],
    owner: "packages/runtime",
    readers: ["packages/runtime/src/stenographer/repository.ts"],
    writers: ["packages/runtime/src/stenographer/repository.ts"],
    migrationState: "not_applicable",
    retention:
      "Retained only as the current compaction replay fence and cleared atomically when a new attempt is claimed.",
    testEvidence: [
      REVIEW_TEST,
      "packages/runtime/tests/unit/stenographer-repository-parameters.test.ts",
      "packages/db/tests/unit/room-journal-funding-schema.test.ts",
    ],
    classification: "bounded_metadata",
    metadataAllowlist: ["compaction_last_attempt_known_nonusable"],
    plaintextReason:
      "This boolean records that the exact released compaction attempt durably failed with fixed invalid_output after producing no usable result. A database check requires no active lease, the accepted plan and binding, and the fixed failure code; it contains no provider response or content.",
  },
];

export const REVIEWED_PERSONAL_MEMORY_EXPOSURE_DEBT_LINKS:
  readonly ReviewedDebtLink[] = [
  {
    id: "link.db.personal-memory-funding.memory-exposure",
    surface: "db",
    locator: "public.memories.model_exposure_dependencies",
    owner: "packages/agent",
    targetDebtIds: ["debt.db.public.memories.content"],
    reason:
      "For an ordinary Memory this ancestry contains exact source coordinates and fingerprints from the same already-frozen plaintext Memory content boundary. A protected-only Memory must keep the column NULL and carries the ancestry only inside its authenticated encrypted Memory payload, so this link does not classify the ancestry as harmless metadata or add a plaintext protected representation.",
    testEvidence: [
      REVIEW_TEST,
      "packages/lattice-bridge/tests/unit/memory-payload-v1.test.ts",
    ],
    crossBoundaryProjection: {
      fields: ["model_exposure_dependencies"],
      rationale:
        "The field retains the complete model-input ancestry of the adjacent ordinary Memory content; protected-only ancestry is encoded in MemoryPayloadV1 and excluded from this clear column by a database representation check.",
    },
  },
  {
    id: "link.db.personal-memory-funding.rollup-exposure",
    surface: "db",
    locator: "public.room_event_rollups.model_exposure_dependencies",
    owner: "packages/runtime",
    targetDebtIds: ["debt.db.public.room_event_rollups.content"],
    reason:
      "For an ordinary journal rollup this ancestry contains exact source coordinates and fingerprints from the same already-frozen plaintext rollup content boundary. A protected-only rollup must keep the column NULL and carries the ancestry only inside its authenticated encrypted rollup payload, so this link does not classify the ancestry as harmless metadata or add a plaintext protected representation.",
    testEvidence: [
      REVIEW_TEST,
      "packages/lattice-bridge/tests/unit/room-journal-payload-v1.test.ts",
    ],
    crossBoundaryProjection: {
      fields: ["model_exposure_dependencies"],
      rationale:
        "The field retains the complete model-input ancestry of the adjacent ordinary rollup content; protected-only ancestry is encoded in RoomEventRollupPayloadV1 and excluded from this clear column by a database representation check.",
    },
  },
];
