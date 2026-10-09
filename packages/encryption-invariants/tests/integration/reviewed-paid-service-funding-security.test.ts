import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { BASELINE_REGISTRY, CURRENT_FROZEN_BASELINE_DEBT } from "../../baseline/existing-debt";
import {
  CONNECTED_WEB_ACTION_RUN_COST_CUSTODY_LOCATOR,
  CONVERSION_OPERATION_METADATA_FIELDS,
  CONVERSION_OPERATION_METADATA_LOCATORS,
  DURABLE_SERVICE_FUNDING_BINDING_LOCATORS,
  REVIEWED_PAID_SERVICE_FUNDING_COVERAGE,
} from "../../baseline/reviewed-paid-service-funding-coverage";
import {
  SUPERSEDED_PAID_SERVICE_FUNDING_DTO_LOCATORS,
} from "../../baseline/reviewed-paid-service-funding-dto";
import {
  REVIEWED_PAID_SERVICE_FUNDING_SOURCE_ALARMS,
  SUPERSEDED_PAID_SERVICE_FUNDING_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-paid-service-funding-source-alarms";
import { validateCoverageEntry } from "../../src/model";
import {
  auditDtoDeclarations,
  discoverDtoInventory,
} from "../../src/node/dto-inventory";
import {
  CURRENT_SOURCE_ALARM_REVIEWS,
  inspectSourceAlarmReviews,
} from "../../src/node/source-alarm-review";
import { scanSourceAlarms } from "../../src/node/source-inventory";

const repoRoot = resolve(import.meta.dir, "../../../..");

describe("paid service funding encryption review", () => {
  test("classifies only the exact new database metadata without adding debt", () => {
    expect(CONVERSION_OPERATION_METADATA_FIELDS).toHaveLength(47);
    expect(CONVERSION_OPERATION_METADATA_LOCATORS).toHaveLength(48);
    expect(DURABLE_SERVICE_FUNDING_BINDING_LOCATORS).toHaveLength(3);
    expect(REVIEWED_PAID_SERVICE_FUNDING_COVERAGE).toHaveLength(52);
    expect(new Set(REVIEWED_PAID_SERVICE_FUNDING_COVERAGE.map((entry) =>
      entry.locator
    )).size).toBe(52);

    for (const entry of REVIEWED_PAID_SERVICE_FUNDING_COVERAGE) {
      expect(validateCoverageEntry(entry)).toEqual({ ok: true });
      expect(entry.classification).toBe("bounded_metadata");
      expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
    }
    expect(REVIEWED_PAID_SERVICE_FUNDING_COVERAGE.some((entry) =>
      entry.locator === CONNECTED_WEB_ACTION_RUN_COST_CUSTODY_LOCATOR
    )).toBe(true);
    expect(CURRENT_FROZEN_BASELINE_DEBT.some((entry) =>
      entry.id.includes("paid-service-funding")
    )).toBe(false);
  });

  test("keeps content, paths, credentials, and raw provider errors outside metadata allowlists", () => {
    const allowlist = REVIEWED_PAID_SERVICE_FUNDING_COVERAGE.flatMap((entry) =>
      entry.classification === "bounded_metadata" ? entry.metadataAllowlist : []
    );
    for (const forbidden of [
      "apiKey", "credential", "sourceBytes", "outputBytesValue", "logicalPath",
      "exportUrl", "prompt", "errorMessage", "providerError",
    ]) {
      expect(allowlist).not.toContain(forbidden);
    }
    const failureEntry = REVIEWED_PAID_SERVICE_FUNDING_COVERAGE.find((entry) =>
      entry.locator === "public.conversion_operations.failure_code"
    );
    expect(failureEntry?.testEvidence).toContain(
      "packages/server/tests/unit/cloud-conversion-runtime.test.ts",
    );
    expect(failureEntry?.testEvidence).toContain(
      "packages/agent/src/tools/convert/convert-tool.test.ts",
    );
  });

  test("records the strict durable funding and run-cost custody shapes", async () => {
    const schema = await Bun.file(resolve(
      repoRoot,
      "packages/db/src/schema/connected-web-accounts.ts",
    )).text();
    expect(schema).toContain('jsonb("profile_funding_binding")');
    expect(schema.match(/jsonb\("funding_binding"\)/gu)).toHaveLength(2);
    expect(schema).toContain('jsonb("run_cost_custody")');
    expect(schema).toContain("run_cost_custody");
    expect(schema).toContain("'version', 'phase', 'hostedRun', 'browserSession', 'attribution'");
    expect(schema).toContain("'writer', 'verifier', 'resume_precheck'");
    const store = await Bun.file(resolve(
      repoRoot,
      "packages/server/src/connected-web-accounts/store.ts",
    )).text();
    expect(store).toContain("row.opaqueRunRef === null && runCostCustody !== null");

    const fundingTypes = await Bun.file(resolve(
      repoRoot,
      "packages/types/src/service-funding.ts",
    )).text();
    expect(fundingTypes).toContain("credentialFingerprint: string");
    expect(fundingTypes).not.toContain("apiKey");
  });

  test("updates only the reviewed result and deletion structural signatures", async () => {
    const declarations = DTO_BASELINE_DECLARATIONS.filter((entry) =>
      SUPERSEDED_PAID_SERVICE_FUNDING_DTO_LOCATORS.has(entry.locator)
    );
    const observations = (await discoverDtoInventory(repoRoot)).filter((entry) =>
      SUPERSEDED_PAID_SERVICE_FUNDING_DTO_LOCATORS.has(entry.locator)
    );
    expect(declarations).toHaveLength(4);
    expect(auditDtoDeclarations({ observations, declarations })).toEqual({
      ok: true,
      counts: {
        observations: 4,
        declarations: 4,
        arbitraryPayloads: declarations.reduce(
          (count, entry) => count + entry.arbitraryPayloads.length,
          0,
        ),
      },
    });
    for (const declaration of declarations.filter((entry) =>
      entry.locator.includes("connected-web-operations")
    )) {
      const signatures = declaration.structuralSignatures?.join("\n") ?? "";
      expect(signatures).toContain(
        "outputs:{artifactId:string;bytes:number;mime:string;path:string}[];outputsTruncated:boolean",
      );
      expect(signatures).not.toContain("outputs:never[];outputsTruncated:false");
    }
    for (const declaration of declarations.filter((entry) =>
      entry.locator.includes("deletion/eligibility")
      || entry.locator.includes("admin/users")
    )) {
      const signatures = declaration.structuralSignatures?.join("\n") ?? "";
      expect(signatures).toContain('code:"active_conversion_operation"');
    }
  }, 120_000);

  test("closes the exact current source alarms without concealing plaintext processing", async () => {
    const scan = await scanSourceAlarms({ repoRoot });
    const locators = new Set(REVIEWED_PAID_SERVICE_FUNDING_SOURCE_ALARMS.map(
      (review) => review.locator,
    ));
    const alarms = scan.alarms.filter((alarm) => locators.has(alarm.locator));
    expect(scan.errors).toEqual([]);
    expect(alarms).toHaveLength(REVIEWED_PAID_SERVICE_FUNDING_SOURCE_ALARMS.length);
    expect(inspectSourceAlarmReviews(
      alarms,
      REVIEWED_PAID_SERVICE_FUNDING_SOURCE_ALARMS,
    ).errors).toEqual([]);
    for (const review of REVIEWED_PAID_SERVICE_FUNDING_SOURCE_ALARMS) {
      expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);
    }
    for (const locator of SUPERSEDED_PAID_SERVICE_FUNDING_SOURCE_ALARM_LOCATORS) {
      expect(CURRENT_SOURCE_ALARM_REVIEWS.some((review) =>
        review.locator === locator
      )).toBe(false);
      expect(scan.alarms.some((alarm) => alarm.locator === locator)).toBe(false);
    }

    const cloudConvert = await Bun.file(resolve(
      repoRoot,
      "packages/cloudconvert/src/service.ts",
    )).text();
    expect(cloudConvert).toContain('fetch(next, { redirect: "manual", signal: fetchSignal })');
    expect(cloudConvert).toContain("next = assertSafeExportUrl");
    expect(cloudConvert).toContain("if (total > maxBytes)");
    const connectedApps = await Bun.file(resolve(
      repoRoot,
      "packages/server/src/connected-apps/service.ts",
    )).text();
    expect(connectedApps).toContain(
      'warn("[connected-apps] hosted cost settlement unavailable")',
    );
  }, 120_000);
});
