import { describe, expect, test } from "bun:test";

import {
  REVIEWED_MAIN_2026_08_13_COVERAGE_ENTRIES,
  REVIEWED_MAIN_2026_08_13_DEBT_LINKS,
} from "../../baseline/reviewed-main-2026-08-13-coverage";
import {
  REVIEWED_MAIN_2026_08_13_DTO_DECLARATIONS,
} from "../../baseline/reviewed-main-2026-08-13-dto";
import {
  REVIEWED_MAIN_2026_08_13_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_08_13_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-13-source-alarms";

describe("reviewed 2026-08-13 main encryption boundaries", () => {
  test("keeps Human rollout identity and credential handoffs on exact frozen debt", () => {
    const linkedLocators = new Set(
      REVIEWED_MAIN_2026_08_13_DEBT_LINKS.map((link) => link.locator),
    );
    for (const locator of [
      "public.member_rollout_items.handle",
      "public.member_rollouts.manifest",
      "http:request_response:POST /api/admin/users/provision",
      "http:request_response:POST /api/admin/users/rollout/apply",
      "http:request_response:POST /api/admin/users/rollout/plan#request.body",
      "http:request_response:POST /api/admin/users/rollout/:rolloutId/resume",
      "sse:produced:GET /api/workspace/artifacts/events#document.patch.applied",
    ]) {
      expect(linkedLocators.has(locator)).toBe(true);
    }

    const classifiedLocators = new Set(
      REVIEWED_MAIN_2026_08_13_COVERAGE_ENTRIES.map((entry) => entry.locator),
    );
    for (const locator of linkedLocators) {
      expect(classifiedLocators.has(locator)).toBe(false);
    }
  });

  test("classifies only closed rollout controls, presentation state, and static assets", () => {
    expect(REVIEWED_MAIN_2026_08_13_COVERAGE_ENTRIES).toHaveLength(32);
    expect(REVIEWED_MAIN_2026_08_13_COVERAGE_ENTRIES.every(
      (entry) => entry.classification === "bounded_metadata",
    )).toBe(true);
    expect(JSON.stringify(REVIEWED_MAIN_2026_08_13_COVERAGE_ENTRIES)).not.toMatch(
      /member_rollouts[.]manifest|member_rollout_items[.]handle/,
    );
  });

  test("pins each changed DTO and every open leaf to an exact closed declaration", () => {
    expect(REVIEWED_MAIN_2026_08_13_DTO_DECLARATIONS).toHaveLength(23);
    expect(REVIEWED_MAIN_2026_08_13_DTO_DECLARATIONS.every((declaration) =>
      declaration.arbitraryPayloads.every((payload) =>
        ("schema" in payload && typeof payload.schema === "string")
        || ("debtId" in payload && typeof payload.debtId === "string")
      )
    )).toBe(true);
  });

  test("excludes only build/probe callsites and leaves runtime alarms explicit", () => {
    expect(SUPERSEDED_MAIN_2026_08_13_SOURCE_ALARM_LOCATORS.size).toBe(6);
    const exclusions = REVIEWED_MAIN_2026_08_13_SOURCE_ALARMS.filter(
      (review) => review.closure === "reviewed_exclusion",
    );
    const runtimeDebt = REVIEWED_MAIN_2026_08_13_SOURCE_ALARMS.filter(
      (review) => review.closure === "baseline_debt",
    );
    expect(exclusions).toHaveLength(11);
    expect(exclusions.every((review) => review.locator.includes("/scripts/")))
      .toBe(true);
    expect(runtimeDebt).toHaveLength(48);
    expect(runtimeDebt.every((review) =>
      !review.locator.includes("/scripts/")
      && review.releaseImpact === "blocks_whole_product_claim"
    )).toBe(true);
  });
});
