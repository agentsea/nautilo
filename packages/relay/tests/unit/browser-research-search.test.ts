import { describe, expect, test } from "bun:test";
import {
  buildDuckDuckGoHtmlSearchUrl,
  canRelayExecuteBrowserResearchSearch,
  parseDuckDuckGoHtmlResults,
  parseRelayBrowserResearchSearchRequest,
  parseRelayBrowserResearchSearchResult,
} from "../../src/index";

const INVOCATION = { toolCallId: "tool-1", laneKey: "room:1" } as const;

describe("browser research search contract", () => {
  test("admits only bounded fixed-provider requests and capable Desktop relays", () => {
    expect(parseRelayBrowserResearchSearchRequest({ provider: "duckduckgo_html", query: " Nautilo ", maxResults: 10, ...INVOCATION }))
      .toEqual({ ok: true, request: { provider: "duckduckgo_html", query: "Nautilo", maxResults: 10, ...INVOCATION } });
    expect(parseRelayBrowserResearchSearchRequest({ provider: "custom", query: "Nautilo", maxResults: 10, ...INVOCATION }).ok).toBe(false);
    expect(parseRelayBrowserResearchSearchRequest({ provider: "duckduckgo_html", query: "Nautilo", maxResults: 26, ...INVOCATION }).ok).toBe(false);
    expect(canRelayExecuteBrowserResearchSearch(12, { profile: "desktop-agent", canResearchWeb: true, canSearchResearchWeb: true })).toBe(true);
    expect(canRelayExecuteBrowserResearchSearch(12, { profile: "desktop-agent", canResearchWeb: true })).toBe(false);
  });

  test("builds the fixed host and parses rendered results without fetching", () => {
    expect(new URL(buildDuckDuckGoHtmlSearchUrl("Nautilo")!).origin).toBe("https://html.duckduckgo.com");
    const parsed = parseDuckDuckGoHtmlResults('<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle">Example</a><div class="result__snippet">Evidence</div></div>');
    expect(parsed).toEqual({ ok: true, items: [{ url: "https://example.com/article", title: "Example", snippet: "Evidence" }] });
  });

  test("strictly validates the bounded result envelope", () => {
    expect(parseRelayBrowserResearchSearchResult({ provider: "duckduckgo_html", items: [{ url: "https://example.com/" }] }).ok).toBe(true);
    expect(parseRelayBrowserResearchSearchResult({ provider: "duckduckgo_html", items: [{ url: "file:///etc/passwd" }] }).ok).toBe(false);
    expect(parseRelayBrowserResearchSearchResult({ provider: "duckduckgo_html", items: [], cdpUrl: "ws://127.0.0.1" }).ok).toBe(false);
  });
});
