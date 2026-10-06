import { act } from "react";
import { beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { PersonalCostsSummary } from "@nautilo/api-client/browser";

import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";

let viewerGeneration = 1;
let summary: PersonalCostsSummary;
const getPersonalCosts = mock(async () => summary);

mock.module("../../hooks/use-auth", () => ({
  useAuth: () => ({ viewerGeneration }),
}));
mock.module("../../lib/api", () => ({ apiClient: { getPersonalCosts } }));

const { PersonalCostsPage } = await import("./personal-costs-page");

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  viewerGeneration = 1;
  getPersonalCosts.mockClear();
  getPersonalCosts.mockImplementation(async () => summary);
  summary = {
    currency: "USD",
    range: {
      key: "30d",
      since: "2026-09-05T00:00:00Z",
      until: "2026-10-05T00:00:00Z",
    },
    pricingVersion: "v1",
    entry: { available: true, hasPersonalCredentials: true, hasHistory: true },
    totals: {
      calls: 2,
      providerOperations: 2,
      unknownProviderOperations: 1,
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      totalTokens: 15,
      estimatedCostUsd: 0.01,
      actualCostUsd: 0.02,
      totalCostUsd: 0.03,
      pendingAttempts: 1,
      unknownAttempts: 0,
      retryableAttempts: 0,
      blockedAttempts: 1,
    },
    byModel: [
      {
        model: "openai:gpt-5",
        provider: "surplus",
        displayName: "GPT-5",
        calls: 2,
        inputTokens: 10,
        outputTokens: 5,
        estimatedCostUsd: 0.01,
        actualCostUsd: 0.02,
        totalCostUsd: 0.03,
        hasActual: true,
        hasFallbackEstimate: false,
        pendingAttempts: 1,
        unknownAttempts: 0,
        blockedAttempts: 1,
      },
    ],
    byCallType: [],
    byProvider: [
      {
        provider: "surplus",
        operation: "chat",
        operations: 2,
        unknownOperations: 1,
        estimatedCostUsd: 0.01,
        actualCostUsd: 0.02,
        totalCostUsd: 0.03,
      },
    ],
    timeSeries: [],
    byTask: [],
    recovery: {
      attempts: [],
      pendingAttempts: 1,
      retryableAttempts: 0,
      blockedAttempts: 1,
      unknownAttempts: 0,
    },
  };
});

test("hides the prior account immediately while an identity-scoped reload is pending", async () => {
  const view = render(
    <MemoryRouter>
      <PersonalCostsPage />
    </MemoryRouter>,
  );
  expect((await view.findAllByText("GPT-5")).length).toBeGreaterThan(0);
  let resolveNext!: (value: PersonalCostsSummary) => void;
  getPersonalCosts.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveNext = resolve;
      }),
  );
  viewerGeneration = 2;
  view.rerender(
    <MemoryRouter>
      <PersonalCostsPage />
    </MemoryRouter>,
  );
  expect(view.queryAllByText("GPT-5")).toHaveLength(0);
  await act(async () => resolveNext(summary));
  expect((await view.findAllByText("GPT-5")).length).toBeGreaterThan(0);
});

test("separates personal payer costs and preserves unresolved receipt states", async () => {
  const view = render(
    <MemoryRouter>
      <PersonalCostsPage />
    </MemoryRouter>,
  );
  expect(await view.findByText("By model / provider")).toBeTruthy();
  expect(
    view.getByText(/\$0\.02 actual · \$0\.01 current estimate/),
  ).toBeTruthy();
  expect(view.getByText(/Unknown paid operations 1/)).toBeTruthy();
  expect(
    view.getByText(
      /Grant receipt-read permission to the key that created those requests/,
    ),
  ).toBeTruthy();
  expect(
    view.getByText(
      /Receipts from a removed or replaced key may remain unresolved/,
    ),
  ).toBeTruthy();
  expect(view.getByText("Provider routes and services")).toBeTruthy();
  expect(view.getByText("Surplus · Chat")).toBeTruthy();
  expect(view.queryByText("By user")).toBeNull();
  expect(
    view.getByText(
      /Server-funded work stays in the separate administrator dashboard/,
    ),
  ).toBeTruthy();
});

test("clears the prior range and ignores a late range response", async () => {
  const view = render(<MemoryRouter><PersonalCostsPage /></MemoryRouter>);
  await view.findAllByText("GPT-5");
  let finishSeven!: (value: PersonalCostsSummary) => void;
  let finishNinety!: (value: PersonalCostsSummary) => void;
  getPersonalCosts.mockImplementationOnce(() => new Promise((resolve) => { finishSeven = resolve; }));
  getPersonalCosts.mockImplementationOnce(() => new Promise((resolve) => { finishNinety = resolve; }));
  fireEvent.click(view.getByRole("button", { name: "Last 7 days" }));
  expect(view.queryAllByText("GPT-5")).toHaveLength(0);
  expect(view.getByText("Loading your costs…")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Last 90 days" }));
  await act(async () => finishSeven(summary));
  expect(view.queryAllByText("GPT-5")).toHaveLength(0);
  await act(async () => finishNinety({ ...summary, range: { ...summary.range, key: "90d" } }));
  expect((await view.findAllByText("GPT-5")).length).toBeGreaterThan(0);
  expect(view.getByRole("button", { name: "Last 90 days" }).getAttribute("aria-pressed")).toBe("true");
});

test("does not present unresolved zero-cost model attempts as free", async () => {
  summary = {
    ...summary,
    totals: {
      ...summary.totals,
      estimatedCostUsd: 0,
      actualCostUsd: 0,
      totalCostUsd: 0,
    },
    byModel: summary.byModel.map((row) => ({
      ...row,
      estimatedCostUsd: 0,
      actualCostUsd: 0,
      totalCostUsd: 0,
      hasActual: false,
    })),
  };
  const view = render(
    <MemoryRouter>
      <PersonalCostsPage />
    </MemoryRouter>,
  );
  expect((await view.findAllByText("Known spend")).length).toBeGreaterThan(0);
  expect(view.getByText(/unknown paid operation/)).toBeTruthy();
});

test("shows an empty panel after a key is saved but before its first paid request", async () => {
  summary = {
    ...summary,
    entry: { available: true, hasPersonalCredentials: true, hasHistory: false },
    totals: {
      ...summary.totals,
      calls: 0,
      providerOperations: 0,
      unknownProviderOperations: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      actualCostUsd: 0,
      totalCostUsd: 0,
      pendingAttempts: 0,
      blockedAttempts: 0,
    },
    byModel: [],
    byProvider: [],
    byTask: [],
    recovery: {
      attempts: [],
      pendingAttempts: 0,
      retryableAttempts: 0,
      blockedAttempts: 0,
      unknownAttempts: 0,
    },
  };
  const view = render(
    <MemoryRouter>
      <PersonalCostsPage />
    </MemoryRouter>,
  );
  expect(
    await view.findByText("No personal-key usage recorded in this window yet."),
  ).toBeTruthy();
});
