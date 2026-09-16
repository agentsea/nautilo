import type { EncryptionCoverageEntry } from "../src/model";

const TEST_EVIDENCE = [
  "packages/encryption-invariants/tests/integration/reviewed-m300-security.test.ts",
  "packages/server/tests/unit/protected-additional-device-route.test.ts",
] as const;

const PROTECTED_ADDITIONAL_DEVICE_ROUTES = [
  "http:request_response:POST /api/protected/devices/additional/:operationId/grant-sync-page",
  "http:request_response:POST /api/protected/devices/additional/:operationId/plan-page",
  "http:request_response:POST /api/protected/devices/additional/grant-sync-pending",
] as const;

function stableId(locator: string): string {
  return locator.replaceAll(/[^a-zA-Z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .toLowerCase();
}

export const REVIEWED_M300_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = PROTECTED_ADDITIONAL_DEVICE_ROUTES.map(
    (locator) => ({
      id: `wire.m300.protected-${stableId(locator)}`,
      surface: "wire",
      locator,
      owner: "packages/server",
      readers: ["packages/lattice-bridge/src/device/additional-device-client.ts"],
      writers: ["packages/server/src/routes/protected-additional-device.ts"],
      migrationState: "ciphertext_only",
      retention:
        "Request-scoped authenticated device-enrollment transport; durable protected material remains in the Human device and Namespace authority stores.",
      testEvidence: TEST_EVIDENCE,
      classification: "protected",
      keyFamily: "namespace_human",
      bridgeRepository:
        "packages/lattice-bridge/src/device/additional-device-client.ts",
      negativeTestEvidence: TEST_EVIDENCE,
    }),
  );
