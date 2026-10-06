import { expect, test } from "bun:test";
import type { PersonalCostsSummary } from "@nautilo/api-client/browser";
import {
  formatPersonalCostUsd,
  personalCostCallTypeRows,
  personalCostDayRows,
  personalCostsForRequestedRange,
  personalUnknownProviderOperations,
} from "./personal-costs-presentation";

const summary = {
  range: {
    key: "30d",
    since: "2026-09-05T00:00:00Z",
    until: "2026-10-05T00:00:00Z",
  },
  timeSeries: [
    {
      day: "2026-10-03",
      estimatedCostUsd: 1,
      actualCostUsd: 2,
      totalCostUsd: 3,
    },
    {
      day: "2026-10-04",
      estimatedCostUsd: 0.5,
      actualCostUsd: 0,
      totalCostUsd: 0.5,
    },
  ],
  byCallType: [
    { callType: "chat", calls: 2, totalCostUsd: 3 },
    { callType: "custom_operation", calls: 1, totalCostUsd: 0.5 },
  ],
  totals: { unknownProviderOperations: 4 },
} as unknown as PersonalCostsSummary;

test("formats personal costs consistently with Workbench", () => {
  expect(formatPersonalCostUsd(0)).toBe("$0.00");
  expect(formatPersonalCostUsd(0.0001)).toBe("<$0.01");
  expect(formatPersonalCostUsd(0.006)).toBe("$0.01");
  expect(formatPersonalCostUsd(1284.57)).toBe("$1,284.57");
});

test("keeps API time-series order and known totals for the native day list", () => {
  expect(personalCostDayRows(summary)).toEqual([
    { key: "2026-10-03", label: "Oct 3", knownCostUsd: 3 },
    { key: "2026-10-04", label: "Oct 4", knownCostUsd: 0.5 },
  ]);
});

test("labels known call types and preserves unknown semantic identifiers", () => {
  expect(personalCostCallTypeRows(summary)).toEqual([
    { key: "chat", label: "Chat", calls: 2, knownCostUsd: 3 },
    {
      key: "custom_operation",
      label: "custom_operation",
      calls: 1,
      knownCostUsd: 0.5,
    },
  ]);
  expect(personalUnknownProviderOperations(summary)).toBe(4);
});

test("hides retained cost data that does not match the requested range", () => {
  expect(personalCostsForRequestedRange(summary, "30d")).toBe(summary);
  expect(personalCostsForRequestedRange(summary, "7d")).toBeNull();
  expect(personalCostsForRequestedRange(null, "7d")).toBeNull();
});
