import { expect, test } from "bun:test";
import type { PersonalCostsSummary } from "@nautilo/api-client/browser";
import {
  personalCostCallTypeRows,
  personalCostDayRows,
  personalUnknownProviderOperations,
} from "./personal-costs-presentation";

const summary = {
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
