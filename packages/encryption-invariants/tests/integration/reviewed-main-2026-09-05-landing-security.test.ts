import { describe, expect, test } from "bun:test";
import { BASELINE_REGISTRY, WAVE_0_FROZEN_BASELINE_DEBT } from "../../baseline/existing-debt";
import { WAVE_0_BASELINE_DEBT_LOCK } from "../../baseline/inventory-fingerprints";
import {
  LANDING_CONTENT_PROJECTIONS, LANDING_METADATA_LOCATORS,
  RETIRED_LANDING_RAW_LOCATORS, REVIEWED_LANDING_COVERAGE_ENTRIES,
  REVIEWED_LANDING_DEBT_LINKS,
} from "../../baseline/reviewed-main-2026-09-05-landing-coverage";
import { REVIEWED_LANDING_DTO_DECLARATIONS } from "../../baseline/reviewed-main-2026-09-05-landing-dto";
import { REVIEWED_LANDING_SOURCE_ALARMS, SUPERSEDED_LANDING_SOURCE_LOCATORS } from "../../baseline/reviewed-main-2026-09-05-landing-source-alarms";
import {
  REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-12-source-alarms";
import { CURRENT_SOURCE_ALARM_REVIEWS } from "../../src/node/source-alarm-review";
import { auditCoverageRegistry, reviewedDebtLinkErrors } from "../../src/registry";

describe("M311 landing inventory after current main", () => {
  test("does not turn Website target, activity or result content into metadata", () => {
    for (const [locator, fields] of LANDING_CONTENT_PROJECTIONS) {
      expect((LANDING_METADATA_LOCATORS as readonly string[]).includes(locator)).toBe(false);
      expect(REVIEWED_LANDING_COVERAGE_ENTRIES.some((entry) => entry.locator === locator)).toBe(false);
      const link = REVIEWED_LANDING_DEBT_LINKS.find((entry) => entry.locator === locator);
      expect(link?.crossBoundaryProjection?.fields).toEqual(fields);
      expect(link?.targetDebtIds).toContain("debt.db.public.session_messages.content");
    }
    expect(REVIEWED_LANDING_COVERAGE_ENTRIES.filter((entry) =>
      entry.classification === "protected"
    )).toHaveLength(0);
  });

  test("keeps server-sealed authority separate from Human Domain encryption", () => {
    for (const field of ["sealed_intent", "sealed_provider_refs"]) {
      expect(REVIEWED_LANDING_COVERAGE_ENTRIES.find((entry) =>
        entry.locator === `public.connected_web_operations.${field}`
      )?.classification).toBe("operator_secret");
    }
  });

  test("qualifies metadata-only Memory review effects against their exact producer", async () => {
    const source = await Bun.file(new URL("../../../agent/src/memory/memory-review-publication.ts", import.meta.url)).text();
    const effect = source.slice(source.indexOf("result.effects.push"), source.indexOf("return result;", source.indexOf("result.effects.push")));
    expect(effect).toContain('ip: ""');
    expect(effect).toContain("memoryId");
    expect(effect).not.toMatch(/content:|embedding:|userAgent:|errorKind:/);
    expect(REVIEWED_LANDING_COVERAGE_ENTRIES.find((entry) =>
      entry.locator === "public.memory_review_receipts.effects"
    )?.classification).toBe("bounded_metadata");
  });

  test("moves exact Memory writer coordinates without expanding frozen debt", () => {
    expect(RETIRED_LANDING_RAW_LOCATORS.size).toBe(4);
    expect(REVIEWED_LANDING_DEBT_LINKS.filter((link) => link.locator.includes("WithDb:raw_sql:"))).toHaveLength(4);
    expect(WAVE_0_FROZEN_BASELINE_DEBT).toHaveLength(WAVE_0_BASELINE_DEBT_LOCK.count);
    expect(auditCoverageRegistry(BASELINE_REGISTRY).ok).toBe(true);
    expect(reviewedDebtLinkErrors(BASELINE_REGISTRY, WAVE_0_FROZEN_BASELINE_DEBT)).toEqual([]);
  });

  test("records actual Human recovery and Website result wire shapes", () => {
    const recovery = REVIEWED_LANDING_DTO_DECLARATIONS.find((entry) => entry.locator.endsWith("/live-shadow/:operationId/recovery"));
    expect(recovery?.structuralSignatures?.join(" ")).toContain("acceptedHumanRequestDigestBase64url");
    const website = REVIEWED_LANDING_DTO_DECLARATIONS.find((entry) => entry.locator === "http:request_response:GET /api/connected-web-operations/:operationId");
    expect(website?.structuralSignatures?.join(" ")).toContain("answer:string");
    expect(REVIEWED_LANDING_DEBT_LINKS.some((entry) => entry.locator === website?.locator)).toBe(true);
  });

  test("does not exclude the content-bearing browser subprocess or generic log wrappers", () => {
    const unchangedLanding = REVIEWED_LANDING_SOURCE_ALARMS.filter((review) =>
      !SUPERSEDED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS.has(review.locator)
    );
    const supersededLanding = REVIEWED_LANDING_SOURCE_ALARMS.filter((review) =>
      SUPERSEDED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS.has(review.locator)
    );
    const currentStenographerCalls = REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS
      .filter((review) =>
        review.locator.includes("/stenographer/")
        && review.locator !== "packages/runtime/src/stenographer/ordinary-stenographer-data-operation.ts#log_emitter:beea086e1bde4b98:1"
      );

    expect(unchangedLanding).toHaveLength(15);
    expect(supersededLanding).toHaveLength(6);
    expect(supersededLanding.every((review) =>
      review.locator.includes("/stenographer/worker.ts")
    )).toBe(true);
    for (const review of unchangedLanding) {
      expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);
      expect(review.closure).toBe(review.locator.includes("temporary_storage") ? "reviewed_exclusion" : "declaration");
    }
    expect(currentStenographerCalls).toHaveLength(19);
    for (const review of currentStenographerCalls) {
      expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);
      expect(review.closure).not.toBe("reviewed_exclusion");
      if (review.closure === "baseline_debt") {
        expect(review.releaseImpact).toBe("blocks_whole_product_claim");
      }
    }
    for (const review of supersededLanding) {
      expect(CURRENT_SOURCE_ALARM_REVIEWS.some((current) =>
        current.locator === review.locator
      )).toBe(false);
    }
    for (const locator of SUPERSEDED_LANDING_SOURCE_LOCATORS) {
      expect(CURRENT_SOURCE_ALARM_REVIEWS.some((review) => review.locator === locator)).toBe(false);
    }
  });
});
