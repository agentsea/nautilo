import type { EncryptionCoverageEntry } from "../src/model";

const LEGACY_LIFECYCLE_LOCATOR =
  "packages/reflection-bridge/scripts/run-postgres-integration.ts#forceLegacyFixtureLifecycle:raw_sql:update:public.reflection_records:1";
const EXPIRED_WORK_LOCATOR =
  "packages/reflection-bridge/scripts/run-postgres-integration.ts#<module>:raw_sql:insert:public.reflection_record_semantic_work:2";
const FRESH_WORK_LOCATOR =
  "packages/reflection-bridge/scripts/run-postgres-integration.ts#<module>:raw_sql:insert:public.reflection_record_semantic_work:3";
const SETTLE_WORK_LOCATOR =
  "packages/reflection-bridge/scripts/run-postgres-integration.ts#<module>:raw_sql:update:public.reflection_record_semantic_work:1";
const RETIRE_RECORD_LOCATOR =
  "packages/reflection-bridge/scripts/run-postgres-integration.ts#retireSyntheticIntegrationRecords:raw_sql:update:public.reflection_records:1";

const TEST_EVIDENCE = [
  "packages/encryption-invariants/tests/integration/reviewed-m288-security.test.ts",
] as const;

export const REVIEWED_M288_COVERAGE_ENTRIES: readonly EncryptionCoverageEntry[] = [{
  id: "db.m288.reflection-legacy-lifecycle-fixture",
  surface: "db",
  locator: LEGACY_LIFECYCLE_LOCATOR,
  owner: "packages/reflection-bridge",
  readers: ["packages/reflection-bridge"],
  writers: ["packages/reflection-bridge/scripts/run-postgres-integration.ts"],
  migrationState: "not_applicable",
  retention:
    "Disposable PostgreSQL integration-fixture lifecycle state; the fixture is restored in a finally block.",
  testEvidence: TEST_EVIDENCE,
  classification: "bounded_metadata",
  metadataAllowlist: [
    "synthetic integration Record identifier",
    "current or stale lifecycle",
    "monotonic processing generation and update timestamp",
  ],
  plaintextReason:
    "The disposable integration-only mutation constructs and then restores a synthetic legacy current-parent violation. It writes no Record payload, evidence, audience, source content, embedding, or protected representation.",
}, {
  id: "db.m288.reflection-expired-work-fixture",
  surface: "db",
  locator: EXPIRED_WORK_LOCATOR,
  owner: "packages/reflection-bridge",
  readers: ["packages/reflection-bridge"],
  writers: ["packages/reflection-bridge/scripts/run-postgres-integration.ts"],
  migrationState: "not_applicable",
  retention: "Disposable PostgreSQL expired-lease ordering fixture.",
  testEvidence: TEST_EVIDENCE,
  classification: "bounded_metadata",
  metadataAllowlist: [
    "synthetic Record identifier",
    "semantic-work generation, stage, reason, and state",
    "opaque lease token, attempt count, and bounded timestamps",
  ],
  plaintextReason:
    "The disposable integration-only insert models an expired semantic-work lease. It writes no Record payload, evidence, audience, source content, embedding, or protected representation.",
}, {
  id: "db.m288.reflection-fresh-work-fixture",
  surface: "db",
  locator: FRESH_WORK_LOCATOR,
  owner: "packages/reflection-bridge",
  readers: ["packages/reflection-bridge"],
  writers: ["packages/reflection-bridge/scripts/run-postgres-integration.ts"],
  migrationState: "not_applicable",
  retention: "Disposable PostgreSQL fresh-work ordering fixture.",
  testEvidence: TEST_EVIDENCE,
  classification: "bounded_metadata",
  metadataAllowlist: [
    "synthetic Record identifier",
    "semantic-work generation, stage, reason, and state",
    "attempt count and bounded timestamps",
  ],
  plaintextReason:
    "The disposable integration-only insert supplies a competing fresh work row. It writes no Record payload, evidence, audience, source content, embedding, or protected representation.",
}, {
  id: "db.m288.reflection-work-fixture-settlement",
  surface: "db",
  locator: SETTLE_WORK_LOCATOR,
  owner: "packages/reflection-bridge",
  readers: ["packages/reflection-bridge"],
  writers: ["packages/reflection-bridge/scripts/run-postgres-integration.ts"],
  migrationState: "not_applicable",
  retention: "Disposable PostgreSQL fixture settlement after the ordering assertion.",
  testEvidence: TEST_EVIDENCE,
  classification: "bounded_metadata",
  metadataAllowlist: [
    "synthetic Record identifier",
    "fixed quarantine state and failure code",
    "bounded recovery and update timestamps",
  ],
  plaintextReason:
    "The disposable integration-only update removes ordering fixtures from later claims. It writes no Record payload, evidence, audience, source content, embedding, or protected representation.",
}, {
  id: "db.m288.reflection-record-fixture-retirement",
  surface: "db",
  locator: RETIRE_RECORD_LOCATOR,
  owner: "packages/reflection-bridge",
  readers: ["packages/reflection-bridge"],
  writers: ["packages/reflection-bridge/scripts/run-postgres-integration.ts"],
  migrationState: "not_applicable",
  retention: "Disposable PostgreSQL integration Records are retired from later bootstrap scans.",
  testEvidence: TEST_EVIDENCE,
  classification: "bounded_metadata",
  metadataAllowlist: [
    "synthetic integration Record prefix",
    "purged disposition and update timestamp",
  ],
  plaintextReason:
    "The disposable integration-only update retires synthetic Records after verification. It writes no Record payload, evidence, audience, source content, embedding, or protected representation.",
}];
