import type { EncryptionCoverageEntry } from "../src/model";
import type { SourceAlarmReview } from "../src/node/source-alarm-review";

/** Exact additions from merged PR #1323; payload classifications are unchanged. */
const schemaGroups = [
  ["reflection_record_authority_dependencies", ["record_id", "dependency_record_id"]],
  ["reflection_record_publications", ["origin_publication_binding_ref", "replay_predecessor_record_id", "replay_predecessor_relation", "replay_processing_generation", "replay_structural_height", "reserved_crypto_object_id"]],
  ["reflection_record_semantic_work", ["ordinary_fallback_reason"]],
] as const;

export const REVIEWED_REFLECTION_REPLAY_COVERAGE: readonly EncryptionCoverageEntry[] =
  schemaGroups.flatMap(([table, fields]) => {
    const locators = fields.map((field) => `public.${table}.${field}`);
    if (table === "reflection_record_authority_dependencies") locators.unshift(`public.${table}`);
    return locators.map((locator): EncryptionCoverageEntry => ({
      id: `db.main-2026-09-12.reflection-replay.${locator}`,
      surface: "db", locator, owner: "packages/reflection-bridge",
      readers: ["packages/reflection-bridge"], writers: ["packages/reflection-bridge"],
      classification: "bounded_metadata", migrationState: "not_applicable",
      metadataAllowlist: fields,
      plaintextReason: "These exact fields hold opaque Record/publication/crypto-object references, immutable replay structure, positive generations, or the closed ordinary-fallback reason. They contain no Record semantic payload; ordinary and protected payload representations retain their separate classifications. Dependency edges expose Record identity relationships and are product-role metadata, not encrypted content.",
      retention: "Retained with the durable Record publication, dependency edge, or semantic-work receipt; no new expiry or deletion guarantee.",
      testEvidence: [
        "packages/db/tests/unit/m327-reflection-replay-authority-schema.test.ts",
        "packages/db/tests/unit/m327-reflection-replay-authority-finalizer.test.ts",
        "packages/reflection-bridge/tests/unit/postgres-semantic-work-store.test.ts",
        "packages/encryption-invariants/tests/integration/reviewed-reflection-replay-security.test.ts",
      ],
    }));
  });

const composition = "packages/server/src/reflection/protected-authority-composition.ts";
const logLocators = [
  ...[1, 2, 3, 4].map((ordinal) => `${composition}#log_emitter:1be53929f7dfc3a8:${ordinal}`),
  `${composition}#log_emitter:1fd6e02a4dd1946e:1`,
  `${composition}#log_emitter:41b017e1495b9b88:4`,
];
export const REVIEWED_REFLECTION_REPLAY_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  ...logLocators.map((locator, index): SourceAlarmReview => ({
    locator, owner: "packages/server", closure: "declaration",
    declarationId: `source.main-2026-09-12.reflection-replay-failure-class-${index + 1}`,
    reason: "The exact console.warn emits a fixed Reflection lifecycle label and only the existing classifyDataOperationFailure result. It emits no exception message, stack, request descriptor, key, or semantic content. The source-security test checks every current warning argument and rejects additional fields.",
  })),
  {
    locator: "packages/db/scripts/finalize-m327-reflection-replay-authority.ts#filesystem_write:3dcc6339408547a4:1",
    owner: "packages/db", closure: "reviewed_exclusion",
    exclusionId: "exclusion.main-2026-09-12.reflection-replay-migration-finalizer",
    reason: "This build-time write updates only the latest source-controlled Drizzle migration with fixed RLS, grants and immutability-trigger SQL. It reads the migration journal and SQL source, never a running database or product content. Exact and partial-anchor rejection/idempotency tests cover the finalizer.",
  },
];
