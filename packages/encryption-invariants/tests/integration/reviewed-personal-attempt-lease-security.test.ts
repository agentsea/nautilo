import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { BASELINE_REGISTRY, CURRENT_FROZEN_BASELINE_DEBT } from "../../baseline/existing-debt";
import {
  PERSONAL_ATTEMPT_LEASE_METADATA_FIELDS,
  PERSONAL_ATTEMPT_LEASE_METADATA_LOCATORS,
  REVIEWED_PERSONAL_ATTEMPT_LEASE_COVERAGE,
} from "../../baseline/reviewed-personal-attempt-lease-coverage";
import { validateCoverageEntry } from "../../src/model";

const repoRoot = resolve(import.meta.dir, "../../../..");

async function source(path: string): Promise<string> {
  return Bun.file(resolve(repoRoot, path)).text();
}

describe("personal attempt lease encryption review", () => {
  test("classifies exactly the owner and expiry metadata without adding debt", () => {
    expect(PERSONAL_ATTEMPT_LEASE_METADATA_FIELDS).toEqual([
      "attempt_owner_token",
      "attempt_lease_expires_at",
    ]);
    expect(PERSONAL_ATTEMPT_LEASE_METADATA_LOCATORS).toEqual([
      "public.llm_usage_events.attempt_owner_token",
      "public.llm_usage_events.attempt_lease_expires_at",
    ]);
    expect(REVIEWED_PERSONAL_ATTEMPT_LEASE_COVERAGE).toHaveLength(2);

    for (const entry of REVIEWED_PERSONAL_ATTEMPT_LEASE_COVERAGE) {
      expect(validateCoverageEntry(entry)).toEqual({ ok: true });
      expect(entry.classification).toBe("bounded_metadata");
      if (entry.classification !== "bounded_metadata") {
        throw new Error(`unexpected coverage class: ${entry.classification}`);
      }
      expect(entry.metadataAllowlist).toEqual(PERSONAL_ATTEMPT_LEASE_METADATA_FIELDS);
      expect(entry.writers.every((writer) =>
        writer.startsWith("packages/db/") || writer.startsWith("packages/server/")
      )).toBe(true);
      expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
    }
    expect(CURRENT_FROZEN_BASELINE_DEBT.some((entry) =>
      entry.id.includes("personal-attempt-lease")
    )).toBe(false);
  });

  test("binds the UUID and expiry as an exact schema pair", async () => {
    const schema = await source("packages/db/src/schema/llm-usage.ts");
    expect(schema).toContain('attemptOwnerToken: uuid("attempt_owner_token")');
    expect(schema).toContain(
      'attemptLeaseExpiresAt: timestamp("attempt_lease_expires_at", { withTimezone: true })',
    );

    const ownerCheck = schema.slice(
      schema.indexOf('"llm_usage_events_attempt_owner_check"'),
      schema.indexOf('index("idx_llm_usage_personal_attempt_lease")'),
    );
    expect(ownerCheck).toContain(
      "(${table.attemptOwnerToken} IS NULL AND ${table.attemptLeaseExpiresAt} IS NULL)",
    );
    expect(ownerCheck).toContain(
      "(${table.attemptOwnerToken} IS NOT NULL AND ${table.attemptLeaseExpiresAt} IS NOT NULL",
    );
    expect(ownerCheck).toContain("${table.fundingKind} IN ('personal', 'server', 'service')");
    expect(ownerCheck).toContain("${table.providerRoute} <> 'surplus'");
    expect(ownerCheck).toContain("${table.attemptOutcome} IS NOT NULL");
    expect(ownerCheck).toContain("${table.costState} IS NOT NULL");
  });

  test("keeps generation and lifecycle custody in server-side writers", async () => {
    const queries = await source("packages/db/src/queries/llm-usage.ts");
    expect(queries).toContain("attemptOwnerToken: ownerToken");
    expect(queries).toContain(
      "attemptLeaseExpiresAt: personalAttemptLeaseExpiresAt(leaseNow)",
    );
    expect(queries).toContain("eq(llmUsageEvents.attemptOwnerToken, ownerToken)");

    const ownerRuntime = await source(
      "packages/server/src/lib/personal-llm-attempt-owner.ts",
    );
    expect(ownerRuntime).toContain("createOwnerToken: randomUUID");
    expect(ownerRuntime).toContain("installPersonalLlmAttemptOwner({ ownerToken })");
    for (const forbidden of ["apiKey", "rawKey", "prompt", "providerResponse"]) {
      expect(ownerRuntime).not.toContain(forbidden);
      expect(PERSONAL_ATTEMPT_LEASE_METADATA_FIELDS).not.toContain(forbidden);
    }
  });

  test("does not project lease custody on personal or administrative Costs wires", async () => {
    const costsRoute = await source("packages/server/src/routes/costs.ts");
    const personalCosts = await source("packages/types/src/personal-costs.ts");
    const apiClient = await source("packages/api-client/src/client.ts");
    const queries = await source("packages/db/src/queries/llm-usage.ts");
    const costsSummary = queries.slice(
      queries.indexOf("export interface CostsSummary"),
      queries.indexOf("function n(", queries.indexOf("export interface CostsSummary")),
    );

    for (const forbidden of [
      "attemptOwnerToken",
      "attemptLeaseExpiresAt",
      "attempt_owner_token",
      "attempt_lease_expires_at",
    ]) {
      expect(costsRoute).not.toContain(forbidden);
      expect(personalCosts).not.toContain(forbidden);
      expect(apiClient).not.toContain(forbidden);
      expect(costsSummary).not.toContain(forbidden);
    }
    expect(costsRoute).toContain("const response: PersonalCostsSummary");
    expect(costsRoute).toContain("totals: summary.totals");
    expect(costsRoute).toContain("serviceRecovery: summary.serviceRecovery");
  });
});
