import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { REVIEWED_M321_COVERAGE_ENTRIES } from "../../baseline/reviewed-m321-coverage";
import {
  REVIEWED_M321_DTO_DECLARATIONS,
  SUPERSEDED_M321_DTO_LOCATORS,
} from "../../baseline/reviewed-m321-dto";
import { REVIEWED_MAIN_2026_09_12_DTO_REPLACEMENTS } from
  "../../baseline/reviewed-main-2026-09-12-dto";
import { REVIEWED_M322_DTO_REPLACEMENTS } from
  "../../baseline/reviewed-m322-dto";
import { REVIEWED_MAIN_2026_08_29_SOURCE_ALARMS } from
  "../../baseline/reviewed-main-2026-08-29-source-alarms";
import { REVIEWED_M321_SOURCE_ALARMS } from
  "../../baseline/reviewed-m321-source-alarms";
import { auditDtoDeclarations, discoverDtoInventory } from
  "../../src/node/dto-inventory";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");

describe("M321 inventory review", () => {
  test("pins the exact changed Memory and Room wire shapes", async () => {
    const observations = (await discoverDtoInventory(repositoryRoot)).filter((entry) =>
      SUPERSEDED_M321_DTO_LOCATORS.has(entry.locator)
    );
    const september12Replacements = REVIEWED_MAIN_2026_09_12_DTO_REPLACEMENTS.filter((entry) =>
      SUPERSEDED_M321_DTO_LOCATORS.has(entry.locator)
    );
    expect(september12Replacements.map((entry) => entry.locator)).toEqual([
      "http:request_response:GET /api/memory/:id",
    ]);
    const protectedHistoryReplacements = REVIEWED_M322_DTO_REPLACEMENTS
      .filter((entry) => SUPERSEDED_M321_DTO_LOCATORS.has(entry.locator));
    expect(protectedHistoryReplacements.map((entry) => entry.locator)).toEqual([
      "http:request_response:GET /api/rooms/:id/messages/:messageId/around",
    ]);
    const reviewedReplacements = [...september12Replacements, ...protectedHistoryReplacements];
    const currentDeclarations = REVIEWED_M321_DTO_DECLARATIONS.map((entry) =>
      reviewedReplacements.find((replacement) => replacement.locator === entry.locator) ?? entry
    );
    expect(observations).toHaveLength(SUPERSEDED_M321_DTO_LOCATORS.size);
    expect(auditDtoDeclarations({
      observations,
      declarations: currentDeclarations,
    })).toEqual({
      ok: true,
      counts: {
        observations: SUPERSEDED_M321_DTO_LOCATORS.size,
        declarations: SUPERSEDED_M321_DTO_LOCATORS.size,
        arbitraryPayloads: 0,
      },
    });
  });

  test("classifies policy change as content-free invalidation metadata", () => {
    expect(REVIEWED_M321_COVERAGE_ENTRIES).toEqual([expect.objectContaining({
      locator: "ws:server_to_client:encryption.policy.changed",
      classification: "bounded_metadata",
      metadataAllowlist: ["type", "policyRevision"],
    })]);
  });

  test("retires only the removed seventh matching runtime log alarm", () => {
    expect(REVIEWED_MAIN_2026_08_29_SOURCE_ALARMS.some((entry) =>
      entry.locator === "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:02d6d32a757bab9d:7"
    )).toBe(false);
    expect(REVIEWED_M321_SOURCE_ALARMS).toHaveLength(4);
  });
});
