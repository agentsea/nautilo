import { beforeEach, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CostsSummary } from "../../lib/costs-api";

import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";

const fetchCostsSummary = mock(async (): Promise<CostsSummary> => ({
  range: { since: "2026-10-01T00:00:00Z", until: "2026-10-08T00:00:00Z", key: "7d" },
  pricingVersion: "v1",
  providerPricingVersion: "v1",
  providerCoverage: { state: "partial", accounted: [], unavailable: [] },
  totals: {
    calls: 0, providerOperations: 1, unknownProviderOperations: 1,
    pendingModelAttempts: 0, unknownModelAttempts: 0,
    inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0,
    estimatedCostUsd: 0.01, actualCostUsd: 0.02, totalCostUsd: 0.03,
  },
  byModel: [],
  byCallType: [],
  byProvider: [{
    provider: "tavily", operation: "search", operations: 1,
    unknownOperations: 1, estimatedCostUsd: 0.01, actualCostUsd: 0.02,
    totalCostUsd: 0.03,
  }],
  byUser: [],
  timeSeries: [],
  serviceOperations: {
    operations: 1, succeeded: 0, failed: 1, cancelled: 0,
    interrupted: 0, unknown: 0, legacy: 0,
  },
  serviceRecovery: { attempts: [{
    provider: "tavily", operation: "search", workload: "deep_research",
    attemptOutcome: "failed", failureCode: "upstream_error",
    taskId: null, runId: "run-ref", jobId: null,
    occurredAt: "2026-10-08T10:00:00Z",
  }] },
}));

mock.module("../../hooks/use-auth", () => ({
  useAuth: () => ({ viewerGeneration: 1, viewer: { isVerified: true } }),
}));
mock.module("../../hooks/use-can", () => ({ useCan: () => () => true }));
mock.module("../../lib/costs-api", () => ({ fetchCostsSummary }));

const { CostsPage } = await import("./costs-page");

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  fetchCostsSummary.mockClear();
});

test("administrator Costs shows service outcomes and unresolved diagnostics", async () => {
  const view = render(<MemoryRouter><CostsPage /></MemoryRouter>);
  expect(await view.findByText("Paid service outcomes")).toBeTruthy();
  expect(view.getByText("Recent unresolved paid services")).toBeTruthy();
  expect(view.container.textContent).toContain("tavily · search · deep research");
  expect(view.container.textContent).toContain("Run run-ref");
  const providerRow = view.getByText("Tavily · Search").closest("tr");
  expect(providerRow?.textContent).toContain("$0.02");
  expect(providerRow?.textContent).toContain("$0.01");
  expect(providerRow?.textContent).toContain("$0.03");
  expect(providerRow?.textContent).toContain("1");
});
