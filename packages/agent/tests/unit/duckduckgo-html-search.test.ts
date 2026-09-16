import { describe, expect, test } from "bun:test";
import {
  buildDuckDuckGoHtmlSearchUrl,
  parseDuckDuckGoHtmlResults,
} from "@nautilo/relay";

const RESULTS_FIXTURE = `<!doctype html>
<html><body>
  <div class="result results_links"><a class="result__a" href="https://example.com/one#fragment">  Example   one </a><a class="result__snippet"> First\n snippet </a></div>
  <div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Ftwo%3Fsource%3Dddg&amp;rut=ignored">Example two</a><div class="result__snippet">Second snippet</div></div>
  <div class="result results_links"><a class="result__a" href="https://EXAMPLE.com/one">Duplicate</a></div>
  <div class="result results_links"><a class="result__a" href="javascript:alert(1)">Unsafe</a></div>
</body></html>`;

describe("duckduckgo HTML search", () => {
  test("parses supported result containers, decodes redirects, and deduplicates HTTP(S) URLs", () => {
    expect(parseDuckDuckGoHtmlResults(RESULTS_FIXTURE, { maxResults: 10 })).toEqual({
      ok: true,
      items: [
        { url: "https://example.com/one", title: "Example one", snippet: "First snippet" },
        { url: "https://example.org/two?source=ddg", title: "Example two", snippet: "Second snippet" },
      ],
    });
  });

  test("marks challenge pages and markup drift as provider failures", () => {
    expect(parseDuckDuckGoHtmlResults("<html><body>Verify you are human with this CAPTCHA</body></html>")).toEqual({
      ok: false,
      failure: "challenge",
    });
    expect(parseDuckDuckGoHtmlResults("<html><body><main>new markup</main></body></html>")).toEqual({
      ok: false,
      failure: "markup_drift",
    });
  });

  test("does not mistake an ordinary search result about CAPTCHAs for a challenge page", () => {
    const html = '<div class="result"><a class="result__a" href="https://example.com/captcha">CAPTCHA guide</a><div class="result__snippet">How to verify you are human</div></div>';
    expect(parseDuckDuckGoHtmlResults(html)).toEqual({
      ok: true,
      items: [{
        url: "https://example.com/captcha",
        title: "CAPTCHA guide",
        snippet: "How to verify you are human",
      }],
    });
  });

  test("represents an explicit no-results page as a successful empty result", () => {
    expect(parseDuckDuckGoHtmlResults('<div class="no-results">Nothing found</div>')).toEqual({
      ok: true,
      items: [],
    });
  });

  test("preserves international result text and normalizes international URLs", () => {
    const html = '<div class="result"><a class="result__a" href="https://例え.テスト/道?q=こんにちは#章">国際的な結果</a><div class="result__snippet">Résumé café — 你好</div></div>';
    const result = parseDuckDuckGoHtmlResults(html);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe("国際的な結果");
    expect(result.items[0]?.snippet).toBe("Résumé café — 你好");
    expect(result.items[0]?.url).toBe("https://xn--r8jz45g.xn--zckzah/%E9%81%93?q=%E3%81%93%E3%82%93%E3%81%AB%E3%81%A1%E3%81%AF");
  });

  test("bounds long result text and rejects malicious or malformed result URLs", () => {
    const html = `<div class="result"><a class="result__a" href="https://example.com/long">${"t".repeat(600)}</a><div class="result__snippet">${"s".repeat(2_100)}</div></div>
      <div class="result"><a class="result__a" href="data:text/html,owned">Data URL</a></div>
      <div class="result"><a class="result__a" href="file:///etc/passwd">File URL</a></div>
      <div class="result"><a class="result__a" href="http://[invalid">Malformed URL</a></div>`;
    const result = parseDuckDuckGoHtmlResults(html, { maxResults: 25 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toHaveLength(513);
    expect(result.items[0]?.title?.endsWith("…")).toBe(true);
    expect(result.items[0]?.snippet).toHaveLength(2_001);
    expect(result.items[0]?.snippet?.endsWith("…")).toBe(true);
  });

  test("distinguishes unusable recognized links from selector drift", () => {
    expect(parseDuckDuckGoHtmlResults('<div class="result"><a class="result__a" href="javascript:void(0)">Bad</a></div>')).toEqual({
      ok: false,
      failure: "empty_parse",
    });
    expect(parseDuckDuckGoHtmlResults('<div class="result"><a class="renamed-result-link" href="https://example.com">Moved selector</a></div>')).toEqual({
      ok: false,
      failure: "markup_drift",
    });
  });

  test("treats consent markup without challenge evidence as drift", () => {
    expect(parseDuckDuckGoHtmlResults('<html><body><form id="consent">Accept cookies to continue</form></body></html>')).toEqual({
      ok: false,
      failure: "markup_drift",
    });
  });

  test("rejects empty and overlong queries and clamps result count", () => {
    expect(buildDuckDuckGoHtmlSearchUrl("   ")).toBeUndefined();
    expect(buildDuckDuckGoHtmlSearchUrl("q".repeat(513))).toBeUndefined();
    expect(parseDuckDuckGoHtmlResults(RESULTS_FIXTURE, { maxResults: 1 })).toEqual({
      ok: true,
      items: [{ url: "https://example.com/one", title: "Example one", snippet: "First snippet" }],
    });
  });

  test("builds only the fixed DuckDuckGo HTML URL", () => {
    const url = new URL(buildDuckDuckGoHtmlSearchUrl("Nautilo web search")!);
    expect(url.origin).toBe("https://html.duckduckgo.com");
    expect(url.pathname).toBe("/html/");
    expect(url.searchParams.get("q")).toBe("Nautilo web search");
    expect(url.searchParams.get("kl")).toBe("us-en");
    expect(url.searchParams.get("kp")).toBe("1");
  });
});
