/**
 * D416 Phase 1.4 — metadata-only find_explainer tool-card tests.
 */
import "../bun-dom-preload";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup } from "@testing-library/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ExplainerCatalogListResult } from "@nautilo/types";
import type { ToolRendererProps } from "../../src/components/tool-card/renderers/types";
import {
  explainerVideoRenderer,
  formatCollapsedSummary,
  formatDuration,
  parseExplainerCatalogResult,
} from "../../src/components/tool-card/renderers/explainer-video";
import { getToolRenderer } from "../../src/components/tool-card/renderers";

function makeResult(overrides: Partial<ExplainerCatalogListResult> = {}): ExplainerCatalogListResult {
  return {
    version: 1,
    catalogVersion: "2026.07.14.1",
    publishedAt: "2026-07-14T10:00:00Z",
    source: "local",
    items: [
      {
        id: "search-memory-basics",
        title: "Search memory basics",
        summary: "Find relevant memories with targeted search terms.",
        tags: ["memory", "search"],
        durationSeconds: 125,
        captionsAvailable: true,
      },
    ],
    page: 1,
    pageSize: 10,
    total: 1,
    hasMore: false,
    ...overrides,
  };
}

async function renderExpanded(resultText: string, overrides: Partial<ToolRendererProps> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const props: ToolRendererProps = {
    args: {},
    result: undefined,
    state: "success",
    event: undefined,
    resultText,
    resultTruncated: false,
    ...overrides,
  };
  await act(async () => {
    root.render(<explainerVideoRenderer.ExpandedBody {...props} />);
  });
  return { container, root };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("find_explainer renderer", () => {
  test("is registered for find_explainer", () => {
    expect(getToolRenderer("find_explainer")).toBe(explainerVideoRenderer);
  });

  test("strictly parses the shared metadata-only list result", () => {
    const raw = JSON.stringify(makeResult());
    expect(parseExplainerCatalogResult(raw)).toEqual(makeResult());
    expect(formatCollapsedSummary(raw)).toBe("Find explainer · 1 result");
    expect(formatDuration(125)).toBe("2:05");
  });

  test("rejects malformed and unexpected playback-shaped results", () => {
    expect(parseExplainerCatalogResult("not json")).toBeNull();
    expect(
      parseExplainerCatalogResult(
        JSON.stringify({
          ...makeResult(),
          videoId: "opaque-provider-id",
        }),
      ),
    ).toBeNull();
  });

  test("renders only safe metadata and explains that playback is unavailable", async () => {
    const { container, root } = await renderExpanded(JSON.stringify(makeResult()));

    expect(container.textContent).toContain("Search memory basics");
    expect(container.textContent).toContain("2:05");
    expect(container.textContent).toContain("Captions available");
    expect(container.textContent).toContain("memory · search");
    expect(container.textContent).toContain("Playback is not configured.");
    expect(container.querySelector("video, audio, iframe")).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  test("falls back to the raw result for malformed output", async () => {
    const raw = '{"items":[{"title":"broken"}]}';
    const { container, root } = await renderExpanded(raw);

    expect(container.textContent).toContain(raw);
    expect(container.querySelector('[data-testid="explainer-video-expanded"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});
