import { beforeEach, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { PersonalCostsSummary } from "@nautilo/api-client/browser";

import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";

let viewerGeneration = 1;
let summary: PersonalCostsSummary;
const getPersonalCosts = mock(async () => summary);

mock.module("../../hooks/use-auth", () => ({ useAuth: () => ({ viewerGeneration }) }));
mock.module("../../lib/api", () => ({ apiClient: { getPersonalCosts } }));

const { PersonalCostsPage } = await import("./personal-costs-page");

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  viewerGeneration = 1;
  getPersonalCosts.mockClear();
  summary = {
    currency: "USD", range: { key: "30d", since: "2026-09-05T00:00:00Z", until: "2026-10-05T00:00:00Z" }, pricingVersion: "v1",
    entry: { available: true, hasPersonalCredentials: true, hasHistory: true },
    totals: { calls: 2, providerOperations: 0, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, totalTokens: 15, estimatedCostUsd: 0.01, actualCostUsd: 0.02, totalCostUsd: 0.03, pendingAttempts: 1, unknownAttempts: 0, retryableAttempts: 0, blockedAttempts: 1 },
    byModel: [{ model: "openai:gpt-5", provider: "surplus", displayName: "GPT-5", calls: 2, inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.01, actualCostUsd: 0.02, totalCostUsd: 0.03, hasActual: true, hasFallbackEstimate: false, pendingAttempts: 1, unknownAttempts: 0, blockedAttempts: 1 }],
    byCallType: [], byProvider: [{ provider: "surplus", operation: "chat", operations: 2, unknownOperations: 1, estimatedCostUsd: 0.01, actualCostUsd: 0.02, totalCostUsd: 0.03 }], timeSeries: [], recovery: { pendingAttempts: 1, retryableAttempts: 0, blockedAttempts: 1, unknownAttempts: 0 },
  };
});

test("separates personal payer costs and preserves unresolved receipt states", async () => {
  const view = render(<MemoryRouter><PersonalCostsPage /></MemoryRouter>);
  expect(await view.findByText("Models paid by you")).toBeTruthy();
  expect(view.getAllByText("$0.02 actual · $0.01 estimated · unresolved charges excluded")).toHaveLength(2);
  expect(view.getByText("1 unresolved")).toBeTruthy();
  expect(view.getByText(/Pending 1 · Unknown 0\. Of these, 0 retrying and 1 blocked\./)).toBeTruthy();
  expect(view.getByText(/Grant receipt-read permission to the key that created those requests/)).toBeTruthy();
  expect(view.getByText(/Receipts from a removed or replaced key may remain unresolved/)).toBeTruthy();
  expect(view.getByText("Provider routes")).toBeTruthy();
  expect(view.getByText("surplus / chat")).toBeTruthy();
  expect(view.getByText("2 operations · 1 unresolved")).toBeTruthy();
  expect(view.getByText(/Server-funded work stays in the separate administrator dashboard/)).toBeTruthy();
});

test("does not present unresolved zero-cost model attempts as free", async () => {
  summary = {
    ...summary,
    totals: { ...summary.totals, estimatedCostUsd: 0, actualCostUsd: 0, totalCostUsd: 0 },
    byModel: summary.byModel.map((row) => ({
      ...row,
      estimatedCostUsd: 0,
      actualCostUsd: 0,
      totalCostUsd: 0,
      hasActual: false,
    })),
  };
  const view = render(<MemoryRouter><PersonalCostsPage /></MemoryRouter>);
  expect(await view.findByText("Cost pending")).toBeTruthy();
  expect(view.getByText(/Unknown or pending receipt/)).toBeTruthy();
});

test("shows an empty panel after a key is saved but before its first paid request", async () => {
  summary = { ...summary, entry: { available: true, hasPersonalCredentials: true, hasHistory: false }, totals: { ...summary.totals, calls: 0, totalTokens: 0, estimatedCostUsd: 0, actualCostUsd: 0, totalCostUsd: 0, pendingAttempts: 0, blockedAttempts: 0 }, byModel: [], recovery: { pendingAttempts: 0, retryableAttempts: 0, blockedAttempts: 0, unknownAttempts: 0 } };
  const view = render(<MemoryRouter><PersonalCostsPage /></MemoryRouter>);
  expect(await view.findByText("No personal-key model usage in this period.")).toBeTruthy();
  expect(view.getByText("Settled")).toBeTruthy();
});
