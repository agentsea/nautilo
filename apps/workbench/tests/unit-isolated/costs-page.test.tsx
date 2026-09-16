/**
 * M217 — Costs page rendering: all model rows reachable, fallback badge + callout.
 */
import { act } from "react";
import type { ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import {
  MODEL_BADGE_FALLBACK_ESTIMATE,
  type CostsModelBarInput,
} from "../../src/pages/costs/costs-view-model";
import type { CostsSummary } from "../../src/lib/costs-api";

let happyWindow: Window;
let root: Root | null = null;

const priorGlobals: Record<string, unknown> = {};

const summaryRef: { current: CostsSummary | null } = { current: null };

function modelRow(
  index: number,
  overrides: Partial<CostsModelBarInput> = {},
): CostsModelBarInput {
  const model = overrides.model ?? `provider:model-${index}`;
  return {
    model,
    provider: "openai",
    displayName: overrides.displayName ?? `Model ${index}`,
    calls: 1,
    inputTokens: 100 + index,
    outputTokens: 50,
    estimatedCostUsd: 0.01 * (12 - index),
    actualCostUsd: overrides.hasActual ? 0.05 : 0,
    totalCostUsd: overrides.totalCostUsd ?? 0.01 * (12 - index),
    hasActual: false,
    hasFallbackEstimate: false,
    ...overrides,
  };
}

function buildSummary(modelCount: number): CostsSummary {
  const byModel: CostsModelBarInput[] = Array.from({ length: modelCount }, (_, i) =>
    modelRow(i + 1, {
      hasFallbackEstimate: i === 4,
      hasActual: i === 2,
      actualCostUsd: i === 2 ? 0.5 : 0,
      totalCostUsd: 0.01 * (modelCount - i),
    }),
  );
  return {
    range: { since: "2026-06-01T00:00:00.000Z", until: "2026-07-01T00:00:00.000Z", key: "30d" },
    pricingVersion: "2026-07",
    providerPricingVersion: "2026-09-02.1",
    providerCoverage: {
      state: "partial",
      accounted: [{ provider: "browser_use", operation: "hosted_read" }],
      unavailable: ["dynamic_mcp_billing", "external_harness_billing"],
    },
    totals: {
      calls: modelCount,
      providerOperations: 2,
      unknownProviderOperations: 1,
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 500,
      totalTokens: 1500,
      estimatedCostUsd: 0.02,
      actualCostUsd: 0.5,
      totalCostUsd: 0.52,
    },
    byModel,
    byCallType: [{ callType: "chat", calls: modelCount, totalCostUsd: 0.52 }],
    byProvider: [{
      provider: "browser_use",
      operation: "hosted_read",
      operations: 2,
      unknownOperations: 1,
      estimatedCostUsd: 0,
      actualCostUsd: 0.014,
      totalCostUsd: 0.014,
    }],
    byUser: [
      {
        userId: "user-1",
        handle: "owner",
        name: "Owner",
        label: "@owner",
        calls: modelCount,
        providerOperations: 2,
        unknownProviderOperations: 1,
        totalTokens: 1500,
        estimatedCostUsd: 0.02,
        actualCostUsd: 0.5,
        totalCostUsd: 0.52,
      },
    ],
    timeSeries: [
      { day: "2026-06-30", estimatedCostUsd: 0.02, actualCostUsd: 0.5, totalCostUsd: 0.52 },
    ],
  };
}

beforeAll(async () => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/costs" });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  for (const k of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "localStorage",
    "sessionStorage",
  ] as const) {
    priorGlobals[k] = (globalThis as Record<string, unknown>)[k];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    localStorage: happyWindow.localStorage,
    sessionStorage: happyWindow.sessionStorage,
  });

  mock.module("react-router-dom", () => ({
    useNavigate: () => () => {},
  }));

  mock.module("../../src/hooks/use-auth", () => ({
    useAuth: () => ({
      session: { state: "signed-in" as const },
      viewer: { isVerified: true, role: "owner" as const },
    }),
  }));

  mock.module("../../src/hooks/use-can", () => ({
    useCan: () => () => true,
  }));

  mock.module("../../src/lib/costs-api", () => ({
    fetchCostsSummary: async () => {
      if (!summaryRef.current) throw new Error("summary not set");
      return summaryRef.current;
    },
  }));

  mock.module("recharts", () => ({
    ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    AreaChart: ({ children }: { children: ReactNode }) => <div data-testid="area-chart">{children}</div>,
    Area: () => null,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
  }));
});

beforeEach(async () => {
  summaryRef.current = buildSummary(11);
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
});

afterAll(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const g = globalThis as Record<string, unknown>;
  for (const key of Object.keys(priorGlobals)) {
    if (priorGlobals[key] === undefined) {
      delete g[key];
    } else {
      g[key] = priorGlobals[key];
    }
  }
  mock.restore();
});

async function renderCostsPage(): Promise<{ html: string; text: string }> {
  const { CostsPage } = await import("../../src/pages/costs/costs-page");
  const container = happyWindow.document.createElement("div");
  root = createRoot(container);
  await act(async () => {
    root!.render(<CostsPage />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    html: container.innerHTML,
    text: container.textContent ?? "",
  };
}

describe("CostsPage (M217)", () => {
  test("renders all eleven model rows in the by-model panel", async () => {
    const { text } = await renderCostsPage();
    for (let i = 1; i <= 11; i += 1) {
      expect(text).toContain(`Model ${i}`);
    }
  });

  test("shows fallback estimate badge copy for flagged models", async () => {
    const { text } = await renderCostsPage();
    expect(text).toContain(MODEL_BADGE_FALLBACK_ESTIMATE);
  });

  test("model row titles include raw model ids for diagnosis", async () => {
    const { html } = await renderCostsPage();
    expect(html).toContain('title="Model 5 (provider:model-5)"');
  });

  test("explains cost coverage without exposing accounting machinery", async () => {
    const { text } = await renderCostsPage();
    expect(text).toContain("Server admin / Costs");
    expect(text).toContain("Known spend");
    expect(text).toContain("Browser Use · Hosted read");
    expect(text).toContain("Costs include supported model and paid-tool activity");
    expect(text).toContain("Some amounts are estimated from usage");
    expect(text).toContain("shown as unknown—not $0");
    expect(text).not.toContain("tracked boundaries");
    expect(text).not.toContain("price table");
  });
});
