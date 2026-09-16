import { describe, expect, test } from "bun:test";

import {
  RETIRED_MAIN_2026_09_09_PLATFORM_FROZEN_DEBT,
  REVIEWED_MAIN_2026_09_09_PLATFORM_DEBT_LINKS,
} from "../../baseline/reviewed-main-2026-09-09-platform-coverage";
import { REVIEWED_MAIN_2026_09_09_PLATFORM_DTO_DECLARATIONS } from "../../baseline/reviewed-main-2026-09-09-platform-dto";
import { REVIEWED_MAIN_2026_09_09_PLATFORM_SOURCE_ALARMS } from "../../baseline/reviewed-main-2026-09-09-platform-source-alarms";

describe("current-main scanner and platform inventory", () => {
  test("retires only the two replaced conversions leaves", () => {
    expect(RETIRED_MAIN_2026_09_09_PLATFORM_FROZEN_DEBT.map((entry) => entry.debtId)).toEqual([
      "debt.wire.arbitrary.4jbgyc",
      "debt.wire.arbitrary.9hgxgx",
    ]);
    expect(REVIEWED_MAIN_2026_09_09_PLATFORM_DEBT_LINKS.some((entry) => entry.locator.endsWith("#response.body"))).toBe(true);
  });

  test("records exact shapes and calls without claiming plaintext safety", () => {
    expect(REVIEWED_MAIN_2026_09_09_PLATFORM_DTO_DECLARATIONS.some((entry) => entry.locator === "http:request_response:GET /api/apps/:appId/runtime")).toBe(true);
    expect(REVIEWED_MAIN_2026_09_09_PLATFORM_SOURCE_ALARMS.length).toBeGreaterThan(400);
    expect(REVIEWED_MAIN_2026_09_09_PLATFORM_SOURCE_ALARMS.every((entry) => entry.closure === "declaration" && entry.reason.length > 24)).toBe(true);
  });
});
