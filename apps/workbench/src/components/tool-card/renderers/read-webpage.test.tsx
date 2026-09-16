/** D523 — run_web_search has truthful search presentation while preserving page-read behavior. */
import "../../../../tests/bun-dom-preload";
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ToolActivityEvent } from "../../../adapters/runtime-contexts";
import type { ToolRenderer, ToolRendererProps } from "./types";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const openExternal = mock(async () => undefined);
let getToolRenderer: typeof import("./index").getToolRenderer;
let readWebpageRenderer: typeof import("./read-webpage").readWebpageRenderer;
let webSearchRenderer: typeof import("./read-webpage").webSearchRenderer;

beforeAll(async () => {
  mock.module("../../../lib/desktop", () => ({
    isDesktop: false,
    desktopAPI: { browserControl: { openExternal } },
  }));
  const renderers = await import("./read-webpage");
  ({ readWebpageRenderer, webSearchRenderer } = renderers);
  ({ getToolRenderer } = await import("./index"));
});

async function renderExpanded(
  renderer: ToolRenderer,
  props: Partial<ToolRendererProps>,
): Promise<string> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <renderer.ExpandedBody
        toolName="read_webpage"
        args={{}}
        result={undefined}
        state="success"
        event={undefined}
        resultText={undefined}
        resultTruncated={false}
        {...props}
      />,
    );
  });
  return container.textContent ?? "";
}

async function disposeRendered(): Promise<void> {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
}

afterEach(async () => {
  openExternal.mockClear();
  await disposeRendered();
});

function webSearchEnvelope(overrides: Record<string, unknown> = {}): string {
  const opaqueHandle = "A".repeat(43);
  return JSON.stringify({
    kind: "web_search_result",
    version: 1,
    answer: "SanDisk closed higher after its earnings report. [1]",
    sources: [{
      number: 1,
      title: "SanDisk investor relations",
      url: "https://investors.example.test/earnings",
      evidence: {
        status: "partial",
        returnedCharacters: 1_000,
        totalCharacters: 2_000,
        totalIsLowerBound: false,
        remainingCharacters: 1_000,
      },
      nextAction: {
        operation: "read_webpage",
        continuation: {
          version: 1,
          reference: opaqueHandle,
          offsetCharacters: 1_000,
          mode: "page",
        },
        snapshot: {
          version: 1,
          reference: opaqueHandle,
          operation: "snapshot",
        },
      },
    }],
    coverage: {
      sourcesReturned: 5,
      readsRequested: 2,
      readsAttempted: 3,
      readsSucceeded: 2,
      readsFailed: 1,
      snippetOnly: 3,
    },
    warnings: ["Figures may update after market close."],
    nextAction: {
      operation: "read_webpage",
      snapshot: {
        version: 1,
        reference: opaqueHandle,
        operation: "find",
        query: "earnings",
        maxMatches: 8,
      },
    },
    ...overrides,
  });
}

function interventionEvent(toolName: string): ToolActivityEvent {
  return {
    toolCallId: "search-call",
    toolName,
    args: {},
    status: "running",
    startedAt: 1,
    browserResearchIntervention: {
      id: "intervention-1",
      toolCallId: "search-call",
      laneKey: "lane-1",
      state: "awaiting_choice",
      host: "example.test",
      reason: "human-verification",
      expiresAt: "2026-08-13T00:00:00.000Z",
    },
  };
}

describe("D523 — web-search ToolCard presentation", () => {
  test("uses Web search for the display label and collapsed fallback", () => {
    expect(getToolRenderer("run_web_search")).toBe(webSearchRenderer);
    expect(webSearchRenderer.displayName).toBe("Web search");
    expect(
      webSearchRenderer.collapsedSummary?.({
        args: {},
        result: undefined,
        state: "pending",
        resultText: undefined,
      }),
    ).toBe("Web search");
    expect(
      webSearchRenderer.collapsedSummary?.({
        args: { query: "SanDisk stock price" },
        result: undefined,
        state: "running",
        resultText: undefined,
      }),
    ).toBe("SanDisk stock price");
  });

  test("uses searching semantics while running and when empty", async () => {
    expect(
      await renderExpanded(webSearchRenderer, {
        toolName: "run_web_search",
        event: {
          ...interventionEvent("run_web_search"),
          browserResearchIntervention: undefined,
        },
        state: "running",
      }),
    ).toContain("Searching the web…");
    await disposeRendered();

    expect(
      await renderExpanded(webSearchRenderer, { toolName: "run_web_search" }),
    ).toContain("No search result was returned.");
  });

  test("renders the strict v1 envelope without projecting machine metadata or opening another browser", async () => {
    const opaqueHandle = "A".repeat(43);
    const resultText = await renderExpanded(webSearchRenderer, {
      toolName: "run_web_search",
      resultText: webSearchEnvelope(),
    });

    expect(resultText).toContain("SanDisk closed higher after its earnings report. [1]");
    expect(resultText).toContain("5 sources returned; 2 page reads requested; 3 attempted; 1 partial; 1 failed attempt; 3 snippet-only.");
    expect(resultText).toContain("Figures may update after market close.");
    expect(resultText).toContain("SanDisk investor relations");
    expect(resultText).toContain("https://investors.example.test/earnings");
    expect(resultText).not.toContain(opaqueHandle);
    expect(resultText).not.toContain("nextAction");
    expect(resultText).toContain("Page URL fetched and read: partial — 1,000 of 2,000 characters; 1,000 remaining.");
    expect(container?.querySelectorAll("a")).toHaveLength(0);
    expect(openExternal).not.toHaveBeenCalled();
  });

  test("shows URL-level proof for complete, failed, and unread sources", async () => {
    const resultText = await renderExpanded(webSearchRenderer, {
      toolName: "run_web_search",
      resultText: webSearchEnvelope({
        sources: [
          {
            number: 1,
            title: "Complete article",
            url: "https://example.test/complete",
            evidence: {
              status: "complete",
              returnedCharacters: 34_297,
              totalCharacters: 34_297,
              remainingCharacters: 0,
            },
          },
          {
            number: 2,
            title: "Failed article",
            url: "https://example.test/failed",
            evidence: { status: "failed" },
            nextAction: { operation: "read_webpage", url: "https://example.test/failed" },
          },
          {
            number: 3,
            title: "Search result only",
            url: "https://example.test/unread",
            evidence: { status: "unread" },
            nextAction: { operation: "read_webpage", url: "https://example.test/unread" },
          },
        ],
        coverage: {
          sourcesReturned: 3,
          readsRequested: 2,
          readsAttempted: 2,
          readsSucceeded: 1,
          readsFailed: 1,
          snippetOnly: 2,
        },
      }),
    });

    expect(resultText).toContain("3 sources returned; 2 page reads requested; 2 attempted; 1 complete; 1 failed attempt; 2 snippet-only.");
    expect(resultText).toContain("Page URL fetched and read: complete — 34,297 of 34,297 characters.");
    expect(resultText).toContain("Page URL fetch/read failed; only search-result evidence is available.");
    expect(resultText).toContain("Snippet only — page URL was not fetched.");
  });

  test("rejects malformed and extra v1 shapes to a redacted raw fallback", async () => {
    const opaqueHandle = "A".repeat(43);
    const malformed = webSearchEnvelope({
      provider: "Tavily",
      extractionMethod: "browser",
      fallbackReason: "tavily_empty",
      nextActions: [{ reference: opaqueHandle }],
    });
    const resultText = await renderExpanded(webSearchRenderer, {
      toolName: "run_web_search",
      resultText: malformed,
    });
    expect(resultText).not.toContain("Tavily");
    expect(resultText).not.toContain("browser");
    expect(resultText).not.toContain("tavily_empty");
    expect(resultText).not.toContain("nextAction");
    expect(resultText).not.toContain(opaqueHandle);
    expect(openExternal).not.toHaveBeenCalled();
  });

  test("rejects invalid evidence, continuation, and coverage accounting", async () => {
    const invalidEvidence = JSON.parse(webSearchEnvelope()) as Record<string, unknown>;
    ((invalidEvidence.sources as Array<Record<string, unknown>>)[0].evidence as Record<string, unknown>).status = "provider";
    await renderExpanded(webSearchRenderer, {
      toolName: "run_web_search",
      resultText: JSON.stringify(invalidEvidence),
    });
    expect(container?.querySelector('[data-testid="web-search-result"]')).toBeNull();
    await disposeRendered();

    const invalidContinuation = JSON.parse(webSearchEnvelope()) as Record<string, unknown>;
    (((invalidContinuation.sources as Array<Record<string, unknown>>)[0].nextAction as Record<string, unknown>).continuation as Record<string, unknown>).reference = "not-an-opaque-handle";
    await renderExpanded(webSearchRenderer, {
      toolName: "run_web_search",
      resultText: JSON.stringify(invalidContinuation),
    });
    expect(container?.querySelector('[data-testid="web-search-result"]')).toBeNull();
    await disposeRendered();

    const invalidCoverage = JSON.parse(webSearchEnvelope()) as Record<string, unknown>;
    (invalidCoverage.coverage as Record<string, unknown>).readsFailed = 2;
    await renderExpanded(webSearchRenderer, {
      toolName: "run_web_search",
      resultText: JSON.stringify(invalidCoverage),
    });
    expect(container?.querySelector('[data-testid="web-search-result"]')).toBeNull();
  });

  test("preserves the result body and exact verification intervention actions", async () => {
    const opaqueReference = "A".repeat(43);
    const resultText = await renderExpanded(webSearchRenderer, {
      toolName: "run_web_search",
      resultText: `Useful research evidence\n{\"reference\":\"${opaqueReference}\"}`,
    });
    expect(resultText).toContain("Useful research evidence");
    expect(resultText).toContain('"reference":"[hidden]"');
    expect(resultText).not.toContain(opaqueReference);
    await disposeRendered();

    const interventionText = await renderExpanded(webSearchRenderer, {
      toolName: "run_web_search",
      event: interventionEvent("run_web_search"),
    });
    expect(interventionText).toContain(
      "before Genie can continue this search.",
    );
    expect(interventionText).toContain("Complete verification");
    expect(interventionText).toContain("Try another source");
    expect(interventionText).toContain("Stop research");
  });

  test("keeps read_webpage labels and page-reading body copy unchanged", async () => {
    expect(getToolRenderer("read_webpage")).toBe(readWebpageRenderer);
    expect(readWebpageRenderer.displayName).toBeUndefined();
    expect(
      readWebpageRenderer.collapsedSummary?.({
        args: {},
        result: undefined,
        state: "pending",
        resultText: undefined,
      }),
    ).toBe("Read webpage");
    expect(
      readWebpageRenderer.collapsedSummary?.({
        args: { url: "https://example.test/article" },
        result: undefined,
        state: "success",
        resultText: undefined,
      }),
    ).toBe("https://example.test/article");

    expect(
      await renderExpanded(readWebpageRenderer, {
        toolName: "read_webpage",
        event: {
          ...interventionEvent("read_webpage"),
          browserResearchIntervention: undefined,
        },
        state: "running",
      }),
    ).toContain("Reading the rendered page…");
  });
});
