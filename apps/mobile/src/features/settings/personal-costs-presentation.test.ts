import { expect, test } from "bun:test";
import type { PersonalCostsSummary } from "@nautilo/api-client/browser";
import {
  formatPersonalCostUsd,
  personalCostCallTypeRows,
  personalCostDayRows,
  personalCostProviderEvidence,
  personalCostTaskRows,
  personalCostsForRequestedRange,
  personalServiceOperations,
  personalServiceOutcomeText,
  personalServiceRecoveryAttempts,
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
    { callType: "decision", calls: 1, totalCostUsd: 0.25 },
    { callType: "deep_research", calls: 1, totalCostUsd: 0.75 },
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
    { key: "decision", label: "Decision", calls: 1, knownCostUsd: 0.25 },
    { key: "deep_research", label: "Deep research", calls: 1, knownCostUsd: 0.75 },
    {
      key: "custom_operation",
      label: "custom_operation",
      calls: 1,
      knownCostUsd: 0.5,
    },
  ]);
  expect(personalUnknownProviderOperations(summary)).toBe(4);
});

test("presents provider actual, current estimate, and unresolved evidence without treating zero actual as missing", () => {
  expect(personalCostProviderEvidence({
    provider: "openrouter", operation: "chat", operations: 1,
    unknownOperations: 0, actualCostUsd: 0, estimatedCostUsd: 0,
    totalCostUsd: 0,
  })).toMatchObject({
    actualCostUsd: 0,
    currentEstimateUsd: 0,
    costPending: false,
    detail: "$0.00 actual · $0.00 current estimate",
  });
  expect(personalCostProviderEvidence({
    provider: "tavily", operation: "search", operations: 1,
    unknownOperations: 0, actualCostUsd: 0, estimatedCostUsd: 0.02,
    totalCostUsd: 0.02,
  })).toMatchObject({
    actualCostUsd: 0,
    currentEstimateUsd: 0.02,
    detail: "$0.00 actual · $0.02 current estimate",
  });
  expect(personalCostProviderEvidence({
    provider: "tavily", operation: "search", operations: 3,
    unknownOperations: 1, actualCostUsd: 0.03, estimatedCostUsd: 0.02,
    totalCostUsd: 0.05,
  })).toMatchObject({
    costPending: false,
    unresolvedOperations: 1,
    detail: "$0.03 actual · $0.02 current estimate · unresolved charges excluded",
  });
  expect(personalCostProviderEvidence({
    provider: "tavily", operation: "search", operations: 1,
    unknownOperations: 1, actualCostUsd: 0, estimatedCostUsd: 0,
    totalCostUsd: 0,
  }).costPending).toBe(true);
});

test("merges Task model and paid-service presentation with legacy-safe counts", () => {
  const withServices = {
    byTask: [{
      taskId: "task-1",
      calls: 2,
      providerOperations: 3,
      unknownProviderOperations: 1,
      actualCostUsd: 0.04,
      estimatedCostUsd: 0.01,
      totalCostUsd: 0.05,
      pendingAttempts: 1,
      unknownAttempts: 1,
    }],
  } as unknown as Pick<PersonalCostsSummary, "byTask">;
  expect(personalCostTaskRows(withServices)).toEqual([{
    taskId: "task-1",
    modelAttempts: 2,
    paidOperations: 3,
    actualCostUsd: 0.04,
    currentEstimateUsd: 0.01,
    knownCostUsd: 0.05,
    unresolved: 3,
  }]);

  const legacy = {
    byTask: [{
      taskId: "task-legacy", calls: 1, actualCostUsd: 0,
      estimatedCostUsd: 0.01, totalCostUsd: 0.01,
      pendingAttempts: 0, unknownAttempts: 0,
    }],
  } as unknown as Pick<PersonalCostsSummary, "byTask">;
  expect(personalCostTaskRows(legacy)[0]).toMatchObject({
    paidOperations: 0,
    unresolved: 0,
  });
});

test("presents paid service outcomes and content-free recovery with legacy-server fallbacks", () => {
  const current = {
    serviceOperations: {
      operations: 7, succeeded: 2, failed: 1, cancelled: 1,
      interrupted: 1, unknown: 1, legacy: 1,
    },
    serviceRecovery: { attempts: [{
      provider: "tavily", operation: "search", workload: "deep_research",
      attemptOutcome: "failed", failureCode: "upstream_error",
      taskId: "task-1", runId: null, jobId: "job-1",
      occurredAt: "2026-10-08T10:00:00Z",
    }] },
  } as unknown as PersonalCostsSummary;
  const operations = personalServiceOperations(current);
  expect(operations).not.toBeNull();
  expect(personalServiceOutcomeText(operations!)).toBe(
    "7 operations · 2 succeeded · 1 failed · 1 cancelled · 1 interrupted · 1 unknown · 1 older unclassified",
  );
  expect(personalServiceRecoveryAttempts(current)).toHaveLength(1);

  const legacy = {} as PersonalCostsSummary;
  expect(personalServiceOperations(legacy)).toBeNull();
  expect(personalServiceRecoveryAttempts(legacy)).toEqual([]);
});

test("hides retained cost data that does not match the requested range", () => {
  expect(personalCostsForRequestedRange(summary, "30d")).toBe(summary);
  expect(personalCostsForRequestedRange(summary, "7d")).toBeNull();
  expect(personalCostsForRequestedRange(null, "7d")).toBeNull();
});
