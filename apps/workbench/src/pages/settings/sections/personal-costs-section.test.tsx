import { act } from "react";
import { beforeEach, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { PersonalCostsSummary } from "@nautilo/api-client/browser";
import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";

let summary: PersonalCostsSummary;
let viewerGeneration = 1;
const getPersonalCosts = mock(async () => summary);
mock.module("../../../lib/api", () => ({ apiClient: { getPersonalCosts } }));
mock.module("../../../hooks/use-auth", () => ({
  useAuth: () => ({ viewerGeneration }),
}));
const { PersonalCostsSection } = await import("./personal-costs-section");

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  getPersonalCosts.mockClear();
  getPersonalCosts.mockImplementation(async () => summary);
  viewerGeneration = 1;
  summary = {
    currency: "USD",
    range: {
      key: "30d",
      since: "2026-09-01T00:00:00Z",
      until: "2026-10-01T00:00:00Z",
    },
    pricingVersion: "test",
    entry: { available: true, hasPersonalCredentials: false, hasHistory: true },
    totals: {
      calls: 2,
      providerOperations: 1,
      unknownProviderOperations: 1,
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      totalTokens: 15,
      estimatedCostUsd: 0.01,
      actualCostUsd: 0.02,
      totalCostUsd: 0.03,
      pendingAttempts: 0,
      unknownAttempts: 0,
      retryableAttempts: 0,
      blockedAttempts: 0,
    },
    byModel: [],
    byCallType: [],
    byProvider: [],
    timeSeries: [],
    byTask: [],
    recovery: {
      attempts: [],
      pendingAttempts: 0,
      retryableAttempts: 0,
      blockedAttempts: 0,
      unknownAttempts: 0,
    },
  };
});

test("shows retained history independently of current key state", async () => {
  const view = render(
    <MemoryRouter>
      <PersonalCostsSection />
    </MemoryRouter>,
  );
  expect(await view.findByText("Known spend (30d)")).toBeTruthy();
  expect(
    view.getByText(/history remains available even though no personal API key/),
  ).toBeTruthy();
  expect(
    view
      .getByRole("link", { name: /View full cost dashboard/ })
      .getAttribute("href"),
  ).toBe("/account/costs");
});

test("shows the informative setup state only when there is no key or history", async () => {
  summary = {
    ...summary,
    entry: {
      available: false,
      hasPersonalCredentials: false,
      hasHistory: false,
    },
  };
  const view = render(
    <MemoryRouter>
      <PersonalCostsSection />
    </MemoryRouter>,
  );
  expect(await view.findByText(/Add a personal API key/)).toBeTruthy();
  expect(
    view
      .getByRole("link", { name: "Manage personal API keys" })
      .getAttribute("href"),
  ).toBe("/settings#personal-provider-keys");
});

test("does not show the prior account summary during an identity reload", async () => {
  const view = render(<MemoryRouter><PersonalCostsSection /></MemoryRouter>);
  expect(await view.findByText("Known spend (30d)")).toBeTruthy();
  let resolveNext!: (value: PersonalCostsSummary) => void;
  getPersonalCosts.mockImplementationOnce(
    () => new Promise((resolve) => { resolveNext = resolve; }),
  );
  viewerGeneration = 2;
  view.rerender(<MemoryRouter><PersonalCostsSection /></MemoryRouter>);
  expect(view.queryByText("Known spend (30d)")).toBeNull();
  await act(async () => resolveNext(summary));
  expect(await view.findByText("Known spend (30d)")).toBeTruthy();
});

test("keeps a recovery route available when the compact read fails", async () => {
  getPersonalCosts.mockImplementationOnce(async () => { throw new Error("offline"); });
  const view = render(<MemoryRouter><PersonalCostsSection /></MemoryRouter>);
  expect((await view.findByRole("alert")).textContent).toContain("could not be loaded");
  expect(view.getByRole("link", { name: /Open the full dashboard/ }).getAttribute("href"))
    .toBe("/account/costs");
});
