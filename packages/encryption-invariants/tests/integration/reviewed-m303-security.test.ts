import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import { REVIEWED_M303_COVERAGE_ENTRIES } from
  "../../baseline/reviewed-m303-coverage";
import { REVIEWED_M303_DTO_DECLARATIONS } from
  "../../baseline/reviewed-m303-dto";
import { REVIEWED_M303_SOURCE_ALARMS } from
  "../../baseline/reviewed-m303-source-alarms";
import { ACTIVATION_REFERENCE_EXCLUSIONS } from
  "../../src/node/activation-inventory";
import { CURRENT_SOURCE_ALARM_REVIEWS } from
  "../../src/node/source-alarm-review";

const repositoryRoot = join(import.meta.dir, "../../../..");

describe("M303 crypto-device admission encryption inventory", () => {
  test("classifies every admission table, column, and route as bounded metadata", () => {
    expect(REVIEWED_M303_COVERAGE_ENTRIES).toHaveLength(34);
    for (const entry of REVIEWED_M303_COVERAGE_ENTRIES) {
      expect(entry.classification).toBe("bounded_metadata");
      expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
      expect(entry.testEvidence.length).toBeGreaterThan(0);
    }
  });

  test("pins the three closed admission wire contracts", () => {
    expect(REVIEWED_M303_DTO_DECLARATIONS).toHaveLength(3);
    for (const declaration of REVIEWED_M303_DTO_DECLARATIONS) {
      expect(declaration.arbitraryPayloads).toEqual([]);
      expect(DTO_BASELINE_DECLARATIONS).toContainEqual(declaration);
    }
  });

  test("reviews every admission log and narrow rollback reference", async () => {
    expect(REVIEWED_M303_SOURCE_ALARMS).toHaveLength(8);
    for (const review of REVIEWED_M303_SOURCE_ALARMS) {
      expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);
    }
    const exclusions = ACTIVATION_REFERENCE_EXCLUSIONS.filter((item) =>
      item.path.includes("crypto-device-admission-gate")
      || item.path.includes("device-admission-gate")
    );
    expect(exclusions.map(({ path, token, signature }) => ({
      path,
      token,
      signature,
    }))).toEqual([
      {
        path: "apps/workbench/src/components/crypto-device-admission-gate.tsx",
        token: "/admin/sections/encryption-transition-card",
        signature: '"../pages/admin/sections/encryption-transition-card";',
      },
      {
        path: "apps/workbench/src/components/crypto-device-admission-gate.tsx",
        token: "/admin/encryption",
        signature: 'const minimalAdmin = location.pathname === "/admin/encryption";',
      },
      {
        path: "apps/workbench/src/components/crypto-device-admission-gate.tsx",
        token: "/admin/encryption",
        signature: '<a href="/admin/encryption" className="inline-flex rounded-md border border-border px-3 py-2 text-sm">',
      },
    ]);
    const workbenchGate = await readFile(
      join(
        repositoryRoot,
        "apps/workbench/src/components/crypto-device-admission-gate.tsx",
      ),
      "utf8",
    );
    for (const exclusion of exclusions) {
      expect(workbenchGate).toContain(exclusion.signature);
    }
    const serverGate = await readFile(
      join(repositoryRoot, "packages/server/src/auth/device-admission-gate.ts"),
      "utf8",
    );
    expect(serverGate).not.toContain("/api/admin/encryption-transition");
  });
});
