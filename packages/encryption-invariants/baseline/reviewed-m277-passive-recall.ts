import type { EncryptionCoverageEntry } from "../src/model";

/** M277 — one content-free server policy bit; no prompt or Record content. */
export const REVIEWED_M277_PASSIVE_RECALL_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [{
  id: "db.m277.server-context-passive-recall-enabled",
  surface: "db",
  locator: "public.server_context_config.passive_recall_enabled",
  owner: "packages/db",
  readers: [
    "packages/db/src/utils/server-context-config-queries.ts",
    "packages/runtime/src/context/build-transcript-context.ts",
  ],
  writers: [
    "packages/db/src/utils/server-context-config-queries.ts",
    "packages/server/src/routes/server-context.ts",
  ],
  migrationState: "not_applicable",
  retention: "Retained as the current server-wide foreground-context policy.",
  testEvidence: [
    "packages/db/tests/unit/migration-0179-m277-passive-recall.test.ts",
    "packages/runtime/tests/unit/build-transcript-context.test.ts",
    "apps/workbench/src/pages/admin/sections/reflection-health-card.test.tsx",
  ],
  classification: "bounded_metadata",
  metadataAllowlist: ["passive_recall_enabled"],
  plaintextReason:
    "This boolean only enables or disables optional foreground Record retrieval. "
    + "It contains no Room, Human, query, Record, source, prompt, or model content.",
}, {
  id: "db.reflection.server-context-sleep-enabled",
  surface: "db",
  locator: "public.server_context_config.reflection_sleep_enabled",
  owner: "packages/db",
  readers: [
    "packages/db/src/utils/server-context-config-queries.ts",
    "packages/server/src/app.ts",
  ],
  writers: [
    "packages/db/src/utils/server-context-config-queries.ts",
    "packages/server/src/routes/server-context.ts",
  ],
  migrationState: "not_applicable",
  retention: "Retained as the current server-wide Reflection/Sleep safety policy.",
  testEvidence: [
    "packages/db/tests/unit/migration-0180-reflection-sleep-switch.test.ts",
    "packages/server/tests/unit/reflection-sleep-controller.test.ts",
    "apps/workbench/src/pages/admin/sections/reflection-health-card.test.tsx",
  ],
  classification: "bounded_metadata",
  metadataAllowlist: ["reflection_sleep_enabled"],
  plaintextReason:
    "This boolean only enables or disables the background semantic worker. "
    + "It contains no Room, Human, query, Record, source, prompt, or model content.",
}];
