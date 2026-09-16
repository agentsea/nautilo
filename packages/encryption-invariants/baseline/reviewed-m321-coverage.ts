import type { EncryptionCoverageEntry } from "../src/model";

export const REVIEWED_M321_COVERAGE_ENTRIES: readonly EncryptionCoverageEntry[] = [{
  id: "wire.m321.encryption-policy-changed",
  surface: "wire",
  locator: "ws:server_to_client:encryption.policy.changed",
  owner: "packages/server",
  readers: ["apps/workbench/src/adapters/nautilo-runtime.tsx"],
  writers: ["packages/server/src/app.ts"],
  migrationState: "not_applicable",
  retention: "Ephemeral invalidation hint; clients re-read canonical policy and admission.",
  testEvidence: [
    "packages/server/tests/integration/encryption-policy-notification.integration.test.ts",
    "apps/workbench/tests/unit-isolated/admission-runtime.test.tsx",
  ],
  classification: "bounded_metadata",
  metadataAllowlist: ["type", "policyRevision"],
  plaintextReason: "Carries only a closed event discriminator and monotonic policy revision; no content, key, Grant, policy body, or authorization decision crosses the wire.",
}];
