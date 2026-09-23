import { describe, expect, mock, test } from "bun:test";
import { ToolMessage } from "@langchain/core/messages";

// This is deliberately local characterization coverage. Wave 2 will turn these
// classes into production provider/fallback metadata; do not use this table to
// change today's Tavily-only behavior.
const autoFallbackEligible = {
  missing_key: true,
  timeout: true,
  transport_or_upstream: true,
  per_url_failure: true,
  empty_unusable_content: true,
  healthy_tavily: false,
  blocked_url: false,
  explicit_tavily: false,
} as const;

const warn = mock();
mock.module("@nautilo/logger", () => ({ warn }));

import {
  buildAutoReadWebpageFetcher,
  buildReadWebpageFetcher,
  createReadWebpageTool,
  formatReadWebpageToolResponse,
} from "../../src/tools/utilities/read-webpage";
import { displaySearchProvider } from "../../src/tools/utilities/web-search";
import type { BrowserPageReadResult } from "@nautilo/relay";
import type { BrowserResearchExecutionReadInput } from "../../src/tools/utilities/browser-research-execution";

function browserPage(overrides: Partial<BrowserPageReadResult> = {}): BrowserPageReadResult {
  return {
    targetRole: "research",
    requestedUrl: "https://example.com",
    finalUrl: "https://example.com/final",
    title: "Rendered title",
    content: "Rendered page content",
    blocks: [{ kind: "paragraph", text: "Rendered page content" }],
    totalCharacters: 21,
    totalCharactersCapped: false,
    totalBytes: 21,
    estimatedTokens: 6,
    offsetCharacters: 0,
    nextOffsetCharacters: 21,
    returnedCharacters: 21,
    remainingCharacters: 0,
    eof: true,
    truncated: false,
    contextClamped: false,
    extraction: { method: "fixed-dom-semantic-v1", root: "article", iframeCount: 0 },
    timing: { readiness: "complete" },
    quality: "complete",
    challenge: { detected: false, confidence: "none", signals: [] },
    failure: "none",
    diagnostics: [],
    ...overrides,
  };
}

describe("read-webpage", () => {
  test("fetcher blocks localhost URLs", async () => {
    const fetchPage = buildReadWebpageFetcher();
    const result = await fetchPage("http://localhost:3000");
    expect(result.error).toContain("Blocked URL");
    expect(result.errorCode).toBe("blocked_url");
    expect(result.contentLength).toBe(0);
  });

  test("fetcher blocks private network URLs", async () => {
    const fetchPage = buildReadWebpageFetcher();
    const r1 = await fetchPage("http://192.168.1.10");
    expect(r1.error).toContain("Blocked URL");
    const r2 = await fetchPage("http://10.0.0.5");
    expect(r2.error).toContain("Blocked URL");
  });

  test("Tavily extraction denial stops before the provider fetch", async () => {
    const fetchImpl = mock(async () => new Response("{}"));
    const denied = new Error("funding_denied");
    const fetchPage = buildReadWebpageFetcher({
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      beforeTavilyDispatch: async () => { throw denied; },
    });
    let failure: unknown;
    try {
      await fetchPage("https://example.org/article");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBe(denied);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("propagates a parent deadline into Tavily extract and skips Browser fallback", async () => {
    const controller = new AbortController();
    let upstreamSignal: AbortSignal | null | undefined;
    let browserReads = 0;
    const fetchPage = buildAutoReadWebpageFetcher({
      apiKey: "test-key",
      fetchImpl: (async (_input, init) => {
        upstreamSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          if (upstreamSignal?.aborted) {
            reject(new Error("extract aborted"));
            return;
          }
          upstreamSignal?.addEventListener("abort", () => reject(new Error("extract aborted")), { once: true });
        });
      }) as typeof fetch,
      browserResearchExecutionPort: {
        read: async () => {
          browserReads += 1;
          return { category: "unavailable" };
        },
      },
    });

    const pending = fetchPage("https://example.org/article", { signal: controller.signal });
    controller.abort(new DOMException("deadline", "TimeoutError"));
    const result = await pending;

    expect(upstreamSignal?.aborted).toBe(true);
    expect(result.errorCode).toBe("cancelled");
    expect(browserReads).toBe(0);
  });

  test("tool is named read_webpage", () => {
    const tool = createReadWebpageTool();
    expect(tool.name).toBe("read_webpage");
  });

  test("fetcher uses env/platform Tavily key for extract", async () => {
    const calls: unknown[] = [];
    const fetchPage = buildReadWebpageFetcher({
      apiKey: "tvly-test",
      fetchImpl: ((input, init) => {
        calls.push({ input, init });
        return Promise.resolve(new Response(JSON.stringify({
          results: [{ url: "https://example.com", raw_content: "Example content" }],
          failedResults: [],
        }), { status: 200 }));
      }) as typeof fetch,
    });

    const result = await fetchPage("https://example.com");

    expect(result.content).toBe("Example content");
    expect(JSON.stringify(calls)).toContain("https://api.tavily.com/extract");
    expect(JSON.stringify(calls)).toContain("Bearer tvly-test");
  });

  test("records a successful Tavily extraction and never prices a failed URL", async () => {
    const receipts: Array<Record<string, unknown>> = [];
    const recordProviderCost = async (receipt: Record<string, unknown>) => { receipts.push(receipt); };
    const success = buildReadWebpageFetcher({
      apiKey: "tvly-test",
      recordProviderCost,
      fetchImpl: (async () => new Response(JSON.stringify({
        request_id: "extract-request-1",
        usage: { credits: 2 },
        results: [{ url: "https://example.com", raw_content: "body" }],
      }), { status: 200 })) as unknown as typeof fetch,
    });
    const failure = buildReadWebpageFetcher({
      apiKey: "tvly-test",
      recordProviderCost,
      fetchImpl: (async () => new Response(JSON.stringify({
        failedResults: [{ url: "https://failed.example", error: "no content" }],
        results: [],
      }), { status: 200 })) as unknown as typeof fetch,
    });

    await success("https://example.com");
    await failure("https://failed.example");

    expect(receipts).toEqual([{
      provider: "tavily",
      operation: "extract",
      receiptId: "extract-request-1",
      estimatedCostUsd: "0.01600000",
      evidenceState: "estimated",
    }]);
  });

  test("pins the exact Tavily Extract request, including the single requested URL", async () => {
    const calls: Array<{ input: unknown; init: RequestInit | undefined }> = [];
    const fetchPage = buildReadWebpageFetcher({
      apiKey: "tvly-test",
      fetchImpl: ((input, init) => {
        calls.push({ input, init });
        return Promise.resolve(new Response(JSON.stringify({
          results: [{ url: "https://different.example/final", raw_content: "body" }],
        }), { status: 200 }));
      }) as typeof fetch,
    });

    const requestedUrl = "https://example.com/article?view=full";
    const result = await fetchPage(requestedUrl);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("expected one Tavily Extract call");
    expect(call).toMatchObject({
      input: "https://api.tavily.com/extract",
      init: {
        method: "POST",
        headers: {
          Authorization: "Bearer tvly-test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          urls: [requestedUrl],
          client_source: "nautilo-agent",
        }),
      },
    });
    expect(Object.keys(call.init ?? {}).sort()).toEqual(["body", "headers", "method", "signal"]);
    expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    // The tool preserves the caller's URL rather than adopting Tavily's result URL.
    expect(result.url).toBe(requestedUrl);
  });

  test("pins raw-content normalization and first-result behavior", async () => {
    const fetchPage = buildReadWebpageFetcher({
      apiKey: "tvly-test",
      fetchImpl: (() => Promise.resolve(new Response(JSON.stringify({
        results: [
          { url: "https://other.example", raw_content: "first raw content", rawContent: "legacy must not win" },
          { url: "https://example.com", raw_content: "second matching result" },
        ],
        failedResults: [{ url: "https://unrelated.example", error: "unrelated" }],
      }), { status: 200 }))) as unknown as typeof fetch,
    });

    const result = await fetchPage("https://example.com");

    expect(result).toMatchObject({
      url: "https://example.com",
      status: 200,
      content: "first raw content",
      preview: "first raw content",
      contentLength: 17,
      totalContentLength: 17,
      truncated: false,
    });
  });

  test("pins failedResults as an exact requested-URL failure before result selection", async () => {
    const fetchPage = buildReadWebpageFetcher({
      apiKey: "tvly-test",
      fetchImpl: (() => Promise.resolve(new Response(JSON.stringify({
        results: [{ url: "https://example.com", raw_content: "otherwise usable" }],
        failedResults: [{ url: "https://example.com", error: "provider detail is not surfaced" }],
      }), { status: 200 }))) as unknown as typeof fetch,
    });

    const result = await fetchPage("https://example.com");
    expect(result).toMatchObject({
      status: 0,
      content: "",
      error: "This page could not be read. Try again or choose another source.",
      errorCode: "read_failed",
    });
  });

  test("A8: truncated fetch never claims full page content", async () => {
    const longContent = "a".repeat(200);
    const fetchPage = buildReadWebpageFetcher({
      maxContentLength: 50,
      apiKey: "tvly-test",
      fetchImpl: (() => Promise.resolve(new Response(JSON.stringify({
        results: [{ url: "https://example.com", raw_content: longContent }],
        failedResults: [],
      }), { status: 200 }))) as unknown as typeof fetch,
    });

    const result = await fetchPage("https://example.com");
    const toolText = formatReadWebpageToolResponse(result, "https://example.com");

    expect(result.truncated).toBe(true);
    expect(result.totalContentLength).toBe(200);
    expect(result.contentLength).toBe(50);
    expect(toolText).not.toContain("full page content");
    expect(toolText).toContain("Completeness: returned 50 characters; total 200; remaining 150; complete no.");
    expect(toolText).toContain("Truncated: yes.");
    expect(toolText).toContain("…[truncated at 50 characters]");
    expect(toolText).toContain("larger maxContentLength");
    expect(toolText).toContain("may observe changed page content");
  });

  test("A8: non-truncated fetch reports complete content without implementation wording", async () => {
    const fetchPage = buildReadWebpageFetcher({
      maxContentLength: 500,
      apiKey: "tvly-test",
      fetchImpl: (() => Promise.resolve(new Response(JSON.stringify({
        results: [{ url: "https://example.com", raw_content: "short content" }],
        failedResults: [],
      }), { status: 200 }))) as unknown as typeof fetch,
    });

    const result = await fetchPage("https://example.com");
    const toolText = formatReadWebpageToolResponse(result, "https://example.com");

    expect(result.truncated).toBe(false);
    expect(toolText).toContain("Completeness: returned 13 characters; total 13; remaining 0; complete yes.");
    expect(toolText).toContain("Complete extracted readable text returned.");
    expect(toolText).toContain("No retained page context is available");
    expect(toolText).toContain("Page content:\n\nshort content");
    expect(toolText).not.toMatch(/Provider:|fallbackReason|extraction:|Browser-rendered|Successfully fetched/);
    expect(toolText).not.toContain("Truncated:");
  });

  test("does not invent an exact total or completeness when extraction scope is unknown", () => {
    const toolText = formatReadWebpageToolResponse({
      url: "https://example.com/unknown",
      status: 200,
      content: "readable sample",
      preview: "readable sample",
      contentLength: 15,
    }, "https://example.com/unknown");

    expect(toolText).toContain("Completeness: returned 15 characters; total unknown; complete unknown.");
    expect(toolText).not.toContain("Complete extracted readable text returned.");
  });

  test("fetcher accepts legacy camelCase Tavily content field", async () => {
    const fetchPage = buildReadWebpageFetcher({
      apiKey: "tvly-test",
      fetchImpl: (() => Promise.resolve(new Response(JSON.stringify({
        results: [{ url: "https://example.com", rawContent: "Example content" }],
        failedResults: [],
      }), { status: 200 }))) as unknown as typeof fetch,
    });

    const result = await fetchPage("https://example.com");

    expect(result.content).toBe("Example content");
  });

  test("pins empty Tavily content as unusable while whitespace remains byte-preserved content", async () => {
    const responses = [
      { results: [{ raw_content: "" }] },
      { results: [{ raw_content: "  \n" }] },
    ];
    const fetchPage = buildReadWebpageFetcher({
      apiKey: "tvly-test",
      fetchImpl: (() => Promise.resolve(new Response(JSON.stringify(responses.shift()), { status: 200 }))) as unknown as typeof fetch,
    });

    const emptyResult = await fetchPage("https://example.com/empty");
    expect(emptyResult).toMatchObject({
      status: 404,
      content: "",
      error: "This page returned no readable content. Try another URL or source.",
      errorCode: "page_empty",
    });
    const whitespaceResult = await fetchPage("https://example.com/whitespace");
    expect(whitespaceResult).toMatchObject({
      status: 200,
      content: "  \n",
      preview: "  \n",
      contentLength: 3,
      totalContentLength: 3,
      truncated: false,
    });
  });

  test("pins timeout, missing-key, transport, and upstream result classes", async () => {
    warn.mockClear();
    const missingKey = buildReadWebpageFetcher({
      apiKey: undefined,
      fetchImpl: (() => { throw new Error("must not fetch"); }) as unknown as typeof fetch,
    });
    const timeout = buildReadWebpageFetcher({
      apiKey: "tvly-test",
      timeoutMs: 1,
      fetchImpl: (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
    });
    const transport = buildReadWebpageFetcher({
      apiKey: "tvly-test",
      fetchImpl: (() => Promise.reject(new Error("network unavailable"))) as unknown as typeof fetch,
    });
    const upstream = buildReadWebpageFetcher({
      apiKey: "tvly-test",
      fetchImpl: (() => Promise.resolve(new Response("unavailable", { status: 503 }))) as unknown as typeof fetch,
    });

    const missingKeyResult = await missingKey("https://example.com");
    const timeoutResult = await timeout("https://example.com");
    const transportResult = await transport("https://example.com");
    const upstreamResult = await upstream("https://example.com");
    const publicFailure = {
      status: 0,
      error: "This page could not be read. Try again or choose another source.",
      errorCode: "read_failed",
    };
    expect(missingKeyResult).toMatchObject(publicFailure);
    expect(timeoutResult).toMatchObject(publicFailure);
    expect(transportResult).toMatchObject(publicFailure);
    expect(upstreamResult).toMatchObject(publicFailure);
    expect(warn.mock.calls).toEqual([
      ["[read_webpage] TAVILY_API_KEY environment variable is required"],
      ["[read_webpage] Tavily extract timed out after 1ms"],
      ["[read_webpage] network unavailable"],
      ["[read_webpage] Tavily extract failed: HTTP 503"],
    ]);
  });

  test("pins the default 30-second timeout without waiting for it", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    globalThis.setTimeout = ((handler: (...handlerArgs: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
      delays.push(timeout ?? 0);
      return originalSetTimeout(handler, 60_000, ...args);
    }) as typeof setTimeout;
    try {
      const fetchPage = buildReadWebpageFetcher({
        apiKey: "tvly-test",
        fetchImpl: (() => Promise.resolve(new Response(JSON.stringify({
          results: [{ raw_content: "body" }],
        }), { status: 200 }))) as unknown as typeof fetch,
      });

      await fetchPage("https://example.com");
      expect(delays).toEqual([30_000]);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("documents auto fallback eligibility without changing current provider routing", () => {
    expect(autoFallbackEligible).toEqual({
      missing_key: true,
      timeout: true,
      transport_or_upstream: true,
      per_url_failure: true,
      empty_unusable_content: true,
      healthy_tavily: false,
      blocked_url: false,
      explicit_tavily: false,
    });
  });

  test("auto mode keeps healthy Tavily primary without touching the browser", async () => {
    const read = mock((_input: { url: string; maxChars?: number; signal?: AbortSignal }) => Promise.resolve({ category: "success" as const, result: browserPage() }));
    const fetchPage = buildAutoReadWebpageFetcher({
      apiKey: "tvly-test",
      fetchImpl: (() => Promise.resolve(new Response(JSON.stringify({
        results: [{ raw_content: "Tavily content" }],
      }), { status: 200 }))) as unknown as typeof fetch,
      browserResearchExecutionPort: { read },
    });

    const result = await fetchPage("https://example.com");
    expect(result).toMatchObject({ provider: "tavily", content: "Tavily content" });
    expect(result.errorCode).toBeUndefined();
    expect(result.fallbackFrom).toBeUndefined();
    expect(result.fallbackReason).toBeUndefined();
    const text = formatReadWebpageToolResponse(result, result.url);
    expect(text).toContain("Completeness: returned 14 characters; total 14; remaining 0; complete yes.");
    expect(text).toContain("Complete extracted readable text returned.");
    expect(text).toContain("No retained page context is available");
    expect(text).toContain("Page content:\n\nTavily content");
    expect(text).not.toMatch(/Provider:|fallback|browser|duckduckgo|extraction:/i);
    expect(read).not.toHaveBeenCalled();
  });

  test("explicit DuckDuckGo policy reads pages through Desktop without touching Tavily", async () => {
    let tavilyCalls = 0;
    const read = mock(async () => ({ category: "success" as const, result: browserPage() }));
    const fetchPage = buildAutoReadWebpageFetcher({
      provider: "duckduckgo_html",
      apiKey: "tvly-present-but-bypassed",
      fetchImpl: (async () => { tavilyCalls += 1; throw new Error("Tavily must not run"); }) as unknown as typeof fetch,
      browserResearchExecutionPort: { read },
    });

    const result = await fetchPage("https://example.com");
    expect(result).toMatchObject({ provider: "browser", content: "Rendered page content" });
    expect(result.fallbackFrom).toBeUndefined();
    expect(result.fallbackReason).toBeUndefined();
    expect(tavilyCalls).toBe(0);
    expect(read).toHaveBeenCalledTimes(1);
  });

  test("auto mode records the bounded unconfigured Tavily transition in successful Browser copy", async () => {
    const read = mock((_input: { url: string; maxChars?: number; signal?: AbortSignal }) => Promise.resolve({ category: "success" as const, result: browserPage() }));
    const fetchPage = buildAutoReadWebpageFetcher({
      apiKey: "",
      browserResearchExecutionPort: { read },
    });

    const result = await fetchPage("https://example.com");
    expect(result).toMatchObject({
      provider: "browser",
      fallbackFrom: "tavily",
      fallbackReason: "tavily_unconfigured",
      finalUrl: "https://example.com/final",
      title: "Rendered title",
      pageQuality: "complete",
      extractionMethod: "fixed-dom-semantic-v1",
      content: "Rendered page content",
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0]).toEqual({ url: "https://example.com", maxChars: 50_000 });
    const text = formatReadWebpageToolResponse(result, result.url);
    expect(text).toContain("Requested URL: https://example.com");
    expect(text).toContain("Final URL: https://example.com/final");
    expect(text).toContain("Completeness: returned 21 characters; total 21; remaining 0; complete yes.");
    expect(text).not.toMatch(/Provider:|fallback|extraction:|quality:/i);
  });

  test("successful Browser fallbacks retain only fixed Tavily transition reasons", async () => {
    const upstreamSecret = "Tavily upstream body: bearer secret and relay internals";
    const failed = await buildAutoReadWebpageFetcher({
      apiKey: "tvly-test",
      fetchImpl: (() => Promise.reject(new Error(upstreamSecret))) as unknown as typeof fetch,
      browserResearchExecutionPort: { read: async () => ({ category: "success", result: browserPage() }) },
    })("https://example.com/failed");
    const empty = await buildAutoReadWebpageFetcher({
      apiKey: "tvly-test",
      fetchImpl: (() => Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }))) as unknown as typeof fetch,
      browserResearchExecutionPort: { read: async () => ({ category: "success", result: browserPage() }) },
    })("https://example.com/empty");

    expect(failed).toMatchObject({ provider: "browser", fallbackFrom: "tavily", fallbackReason: "tavily_failed" });
    expect(empty).toMatchObject({ provider: "browser", fallbackFrom: "tavily", fallbackReason: "tavily_empty" });
    const failedText = formatReadWebpageToolResponse(failed, failed.url);
    expect(failedText).not.toContain(upstreamSecret);
    expect(failedText).not.toContain("Bearer");
    expect(failedText).not.toMatch(/Provider:|fallbackReason|extraction:|Browser-rendered/);
    expect(formatReadWebpageToolResponse(empty, empty.url)).not.toContain("fallbackReason");
  });

  test("table: only usable Browser pages carry bounded Tavily transition provenance", async () => {
    const usableBrowser = { read: async () => ({ category: "success" as const, result: browserPage() }) };
    const cases = [
      {
        name: "per-URL Tavily failure",
        options: {
          apiKey: "tvly-test",
          fetchImpl: (() => Promise.resolve(new Response(JSON.stringify({ failedResults: [{ url: "https://example.com/per-url" }] }), { status: 200 }))) as unknown as typeof fetch,
          browserResearchExecutionPort: usableBrowser,
        },
        url: "https://example.com/per-url",
        reason: "tavily_failed",
      },
      {
        name: "Tavily HTTP failure",
        options: {
          apiKey: "tvly-test",
          fetchImpl: (() => Promise.resolve(new Response("unavailable", { status: 503 }))) as unknown as typeof fetch,
          browserResearchExecutionPort: usableBrowser,
        },
        url: "https://example.com/http",
        reason: "tavily_failed",
      },
      {
        name: "Tavily timeout",
        options: {
          apiKey: "tvly-test",
          timeoutMs: 1,
          fetchImpl: (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
          browserResearchExecutionPort: usableBrowser,
        },
        url: "https://example.com/timeout",
        reason: "tavily_failed",
      },
      {
        name: "empty Tavily result",
        options: {
          apiKey: "tvly-test",
          fetchImpl: (() => Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }))) as unknown as typeof fetch,
          browserResearchExecutionPort: usableBrowser,
        },
        url: "https://example.com/empty",
        reason: "tavily_empty",
      },
      {
        name: "whitespace-only Tavily result",
        options: {
          apiKey: "tvly-test",
          fetchImpl: (() => Promise.resolve(new Response(JSON.stringify({ results: [{ raw_content: " \n\t " }] }), { status: 200 }))) as unknown as typeof fetch,
          browserResearchExecutionPort: usableBrowser,
        },
        url: "https://example.com/whitespace",
        reason: "tavily_empty",
      },
    ] as const;

    for (const testCase of cases) {
      const result = await buildAutoReadWebpageFetcher(testCase.options)(testCase.url);
      expect(result, testCase.name).toMatchObject({
        provider: "browser",
        fallbackFrom: "tavily",
        fallbackReason: testCase.reason,
        content: "Rendered page content",
      });
    }
  });

  test("table: non-usable Browser and relay outcomes never carry Tavily fallback provenance", async () => {
    const cases = [
      {
        name: "browser challenge",
        port: {
          read: async () => ({ category: "success" as const, result: browserPage({
            quality: "challenge", challenge: { detected: true, confidence: "heuristic", signals: ["captcha"] }, failure: "challenge",
          }) }),
        },
        errorCode: "verification_required",
      },
      {
        name: "browser empty page",
        port: {
          read: async () => ({ category: "success" as const, result: browserPage({
            content: "", quality: "empty", failure: "empty-dom", totalCharacters: 0, returnedCharacters: 0, remainingCharacters: 0,
          }) }),
        },
        errorCode: "page_empty",
      },
      {
        name: "browser navigation error",
        port: { read: async () => ({ category: "success" as const, result: browserPage({ quality: "error", failure: "navigation-error", content: "" }) }) },
        errorCode: "navigation_error",
      },
      {
        name: "relay lost",
        port: { read: async () => ({ category: "lost" as const }) },
        errorCode: "desktop_lost",
      },
      {
        name: "relay unavailable",
        port: { read: async () => ({ category: "unavailable" as const }) },
        errorCode: "background_unavailable",
      },
    ] as const;

    for (const testCase of cases) {
      const result = await buildAutoReadWebpageFetcher({ apiKey: "", browserResearchExecutionPort: testCase.port })(`https://example.com/${encodeURIComponent(testCase.name)}`);
      expect(result, testCase.name).toMatchObject({ errorCode: testCase.errorCode });
      expect(result.fallbackFrom, testCase.name).toBeUndefined();
      expect(result.fallbackReason, testCase.name).toBeUndefined();
    }
  });

  test("auto mode never sends a locally blocked URL to the browser", async () => {
    const read = mock((_input: { url: string; maxChars?: number; signal?: AbortSignal }) => Promise.resolve({ category: "success" as const, result: browserPage() }));
    const fetchPage = buildAutoReadWebpageFetcher({ apiKey: "", browserResearchExecutionPort: { read } });
    const result = await fetchPage("http://localhost:3000/private");
    expect(result.error).toContain("Blocked URL");
    expect(result.errorCode).toBe("blocked_url");
    expect(read).not.toHaveBeenCalled();
  });

  test("auto mode reports unavailable browser fallback and challenge pages truthfully", async () => {
    const unavailable = buildAutoReadWebpageFetcher({
      apiKey: "",
      browserResearchExecutionPort: { read: async () => ({ category: "unavailable" }) },
    });
    const unavailableResult = await unavailable("https://example.com");
    expect(unavailableResult.errorCode).toBe("background_unavailable");
    expect(unavailableResult.error).toContain("unavailable for this session");

    const challenged = buildAutoReadWebpageFetcher({
      apiKey: "",
      browserResearchExecutionPort: {
        read: async () => ({
          category: "success",
          result: browserPage({
            quality: "challenge",
            challenge: { detected: true, confidence: "heuristic", signals: ["captcha"] },
            failure: "challenge",
          }),
        }),
      },
    });
    const challengeResult = await challenged("https://example.com");
    expect(challengeResult).toMatchObject({
      provider: "browser",
      challengeDetected: true,
      status: 0,
      errorCode: "verification_required",
    });
    expect(challengeResult.error).toContain("requires human verification");
  });

  test("empty browser pages and ordinary fallback failures stay actionable without provider plumbing", async () => {
    const empty = buildAutoReadWebpageFetcher({
      apiKey: "",
      browserResearchExecutionPort: {
        read: async () => ({
          category: "success",
          result: browserPage({
            content: "",
            quality: "empty",
            failure: "empty-dom",
            totalCharacters: 0,
            returnedCharacters: 0,
            remainingCharacters: 0,
            eof: true,
          }),
        }),
      },
    });
    const lost = buildAutoReadWebpageFetcher({
      apiKey: "",
      browserResearchExecutionPort: { read: async () => ({ category: "lost" }) },
    });

    const emptyResult = await empty("https://example.com/empty");
    const lostResult = await lost("https://example.com/unavailable");
    expect(formatReadWebpageToolResponse(emptyResult, emptyResult.url)).toBe(
      "Error: [page_empty] This page returned no readable content. Try another URL or source.",
    );
    expect(emptyResult.errorCode).toBe("page_empty");
    expect(lostResult.errorCode).toBe("desktop_lost");
    expect(lostResult.error).toContain("Desktop connection was lost");
    expect(lostResult.error).not.toContain("Tavily");
    expect(lostResult.error).not.toContain("paired Desktop browser");

    const navigationFailure = await buildAutoReadWebpageFetcher({
      apiKey: "",
      browserResearchExecutionPort: {
        read: async () => ({ category: "success", result: browserPage({ quality: "error", failure: "navigation-error", content: "" }) }),
      },
    })("https://example.com/navigation-error");
    expect(navigationFailure.error).toBe("This page could not be opened. Try again or choose another source.");
    expect(navigationFailure.errorCode).toBe("navigation_error");
  });

  test("maps bounded relay failure categories to exact public error codes", async () => {
    const cases = [
      ["unsupported", "background_unavailable"],
      ["unavailable", "background_unavailable"],
      ["lost", "desktop_lost"],
      ["cancelled", "cancelled"],
      ["alternate", "alternate_requested"],
      ["expired", "verification_expired"],
      ["consent_wall", "consent_wall"],
      ["error", "read_failed"],
    ] as const;

    for (const [category, errorCode] of cases) {
      const result = await buildAutoReadWebpageFetcher({
        apiKey: "",
        browserResearchExecutionPort: { read: async () => ({ category }) },
      })(`https://example.com/${category}`);
      expect(result.errorCode).toBe(errorCode);
      expect(result.browserFailureCategory).toBe(category);
      expect(formatReadWebpageToolResponse(result, result.url)).toStartWith(`Error: [${errorCode}] `);
    }
  });

  test("returns unresolved consent controls to Genie and replays selected labels without Human work", async () => {
    const calls: BrowserResearchExecutionReadInput[] = [];
    const fetcher = buildAutoReadWebpageFetcher({
      provider: "duckduckgo_html",
      browserResearchExecutionPort: {
        read: async (input) => {
          calls.push(input);
          return { category: "success", result: browserPage({
            content: '- region "Cookie consent"\n- button "Privacy, but make it minimal"',
            returnedCharacters: 70,
            totalCharacters: 70,
            nextOffsetCharacters: 70,
            totalBytes: 70,
            estimatedTokens: 18,
            failure: "consent-wall",
            diagnostics: ["consent-attempted-reject-optional", "consent-wall-remained"],
            consentRecovery: {
              version: 1,
              reference: "r".repeat(43),
              expiresAt: "2026-08-10T12:00:00.000Z",
              operations: ["snapshot", "screenshot", "click_control", "click_coordinates", "wait", "read", "abandon"],
            },
          }) };
        },
      },
    });
    const result = await fetcher("https://example.com/consent", {
      consentActions: ["Privacy, but make it minimal"],
    });
    expect(calls[0]).toMatchObject({ consentActions: ["Privacy, but make it minimal"] });
    expect(result.errorCode).toBe("consent_wall");
    expect(result.consentOutcome).toBe("remained");
    expect(result.consentAction).toBe("reject_optional");
    expect(formatReadWebpageToolResponse(result, result.url)).toContain("Do not ask the Human");
    expect(formatReadWebpageToolResponse(result, result.url)).toContain("remained after reject_optional");
    expect(result.consentRecovery?.reference).toBe("r".repeat(43));
    expect(formatReadWebpageToolResponse(result, result.url)).toContain("exact anonymous Browser target is retained");
    expect(formatReadWebpageToolResponse(result, result.url)).toContain("click_coordinates");
  });

  test("surfaces a positive autonomous cookie-clearance receipt", async () => {
    const fetcher = buildAutoReadWebpageFetcher({
      provider: "duckduckgo_html",
      browserResearchExecutionPort: {
        read: async () => ({
          category: "success",
          result: browserPage({ diagnostics: ["consent-cleared-reject-optional"] }),
        }),
      },
    });
    const result = await fetcher("https://example.com/article");
    const formatted = formatReadWebpageToolResponse(result, result.url);
    expect(result.consentOutcome).toBe("cleared");
    expect(result.consentAction).toBe("reject_optional");
    expect(formatted).not.toContain("Cookie consent");
    expect(formatted).not.toContain("No Human intervention was requested");
  });

  test("uses human-readable DuckDuckGo provenance while keeping the machine enum", () => {
    expect(displaySearchProvider("duckduckgo_html")).toBe("DuckDuckGo");
    expect(displaySearchProvider("tavily")).toBe("Tavily");
  });

  test("tool schema exposes maxContentLength override for deeper reads", () => {
    const tool = createReadWebpageTool();
    const schema = tool.schema as { parse: (input: unknown) => { maxContentLength?: number } };
    const parsed = schema.parse({
      url: "https://example.com",
      maxContentLength: 120_000,
    });

    expect(parsed.maxContentLength).toBe(120_000);
  });

  test("tool description explains extraction, retained context, and refetch semantics", () => {
    const tool = createReadWebpageTool();
    expect(tool.description).toContain("actual extracted page content, not only a search snippet");
    expect(tool.description).toContain("when partial, re-read with a larger maxContentLength");
    expect(tool.description).toContain("Provider selection and recovery are internal");
    expect(tool.description).toContain("this refetches the URL");
    expect(tool.description).toContain("temporary page context with continuation, snapshot.find, and snapshot.range");
    expect(tool.description).toContain("returned characters, exact total or lower bound when known");
  });

  test("tool schema admits bounded consent-label replay only with a URL", () => {
    const schema = createReadWebpageTool().schema as { parse: (input: unknown) => unknown };
    expect(schema.parse({
      url: "https://example.com/consent",
      consentActions: ["Manage preferences", "Reject optional", "Save choices"],
    })).toBeTruthy();
    expect(() => schema.parse({ continuation: {
      version: 1, reference: "a".repeat(43), offsetCharacters: 0, mode: "page",
    }, consentActions: ["Reject optional"] })).toThrow();
  });

  test("tool schema exposes only bounded opaque same-target consent recovery operations", () => {
    const schema = createReadWebpageTool().schema as { parse: (input: unknown) => unknown };
    expect(schema.parse({ consentRecovery: {
      version: 1, reference: "r".repeat(43), operation: "click_coordinates", x: 420, y: 315,
    } })).toBeTruthy();
    expect(() => schema.parse({ consentRecovery: {
      version: 1, reference: "r".repeat(43), operation: "click_control", label: "#accept", selector: "#accept",
    } })).toThrow();
    expect(() => schema.parse({ url: "https://example.com", consentRecovery: {
      version: 1, reference: "r".repeat(43), operation: "snapshot",
    } })).toThrow();
  });

  test("tool returns same-target consent screenshots as bounded multimodal evidence", async () => {
    const reference = "r".repeat(43);
    const tool = createReadWebpageTool({
      browserResearchExecutionPort: {
        read: async () => ({ category: "error" as const }),
        recoverConsent: async () => ({ category: "success" as const, result: {
          kind: "browser_research_consent_recovery" as const,
          operation: "screenshot" as const,
          reference,
          expiresAt: "2026-08-10T12:00:00.000Z",
          state: "consent_wall" as const,
          viewport: { cssWidth: 800, cssHeight: 600, imageWidth: 1600, imageHeight: 1200, scale: 2 },
          image: { mime: "image/png" as const, base64: "aGVsbG8=" },
        } }),
      },
    } as never);
    const invoked: unknown = await tool.invoke({ consentRecovery: { version: 1, reference, operation: "screenshot" } });
    expect(invoked).toBeInstanceOf(ToolMessage);
    const result = invoked as ToolMessage;
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("x/y in these image pixels") },
      { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
    ]);
    expect(result.additional_kwargs["nautilo_event_summary"]).toContain("Consent recovery screenshot");
  });

  test("successful same-target consent reads disclose automatic target release", async () => {
    const reference = "r".repeat(43);
    const tool = createReadWebpageTool({
      browserResearchExecutionPort: {
        read: async () => ({ category: "error" as const }),
        recoverConsent: async () => ({ category: "success" as const, result: {
          kind: "browser_research_consent_recovery" as const,
          operation: "read" as const,
          reference,
          expiresAt: "2026-08-10T12:00:00.000Z",
          state: "cleared" as const,
          page: browserPage({ content: "Readable article", totalCharacters: 16, returnedCharacters: 16 }),
        } }),
      },
    } as never);

    const result: unknown = await tool.invoke({ consentRecovery: { version: 1, reference, operation: "read" } });
    expect(String(result)).toContain("automatically released");
    expect(String(result)).toContain("do not call abandon");
  });

  test("browser fallback preserves exact progress and continuation for the next read", async () => {
    const continuation = {
      version: 1 as const,
      reference: "a".repeat(43),
      nextOffsetCharacters: 50_000,
      expiresAt: "2026-08-08T15:00:00.000Z",
    };
    const fetchPage = buildAutoReadWebpageFetcher({
      apiKey: "",
      browserResearchExecutionPort: {
        read: async () => ({
          category: "success",
          result: browserPage({
            content: "a".repeat(50_000),
            totalCharacters: 120_000,
            nextOffsetCharacters: 50_000,
            returnedCharacters: 50_000,
            remainingCharacters: 70_000,
            eof: false,
            truncated: true,
            continuation,
          }),
        }),
      },
    });

    const result = await fetchPage("https://example.com/long");
    const text = formatReadWebpageToolResponse(result, "https://example.com/long");
    expect(result).toMatchObject({
      offsetCharacters: 0,
      nextOffsetCharacters: 50_000,
      remainingCharacters: 70_000,
      eof: false,
      continuation,
    });
    expect(text).toContain("Completeness: returned 50000 characters; total 120000; remaining 70000; complete no.");
    expect(text).toContain(`"reference":"${"a".repeat(43)}"`);
    expect(text).toContain('"offsetCharacters":50000');
    expect(text).toContain('"mode":"page"');
    expect(text).toContain('"mode":"remainder"');
    expect(text).not.toMatch(/Provider:|fallbackReason|extraction:|Browser-rendered/);
  });

  test("tool continues a released browser snapshot without URL or Tavily", async () => {
    const calls: unknown[] = [];
    const tool = createReadWebpageTool({
      browserResearchExecutionPort: {
        read: async (input: BrowserResearchExecutionReadInput) => {
          calls.push(input);
          return {
            category: "success",
            result: browserPage({
              requestedUrl: "https://example.com/long",
              content: "remaining",
              offsetCharacters: 50_000,
              nextOffsetCharacters: 50_009,
              returnedCharacters: 9,
              totalCharacters: 50_009,
              remainingCharacters: 0,
              eof: true,
              truncated: false,
              continuation: undefined,
            }),
          } as const;
        },
      },
    } as never);
    const continuation = {
      version: 1 as const,
      reference: "b".repeat(43),
      offsetCharacters: 50_000,
      mode: "remainder" as const,
    };

    const result: unknown = await tool.invoke({ continuation });
    expect(calls).toEqual([{ continuation }]);
    if (typeof result !== "string") throw new Error("expected string tool result");
    expect(result).toContain("Completeness: returned 9 characters; total 50009; remaining 0; complete yes.");
    expect(result).toContain("Page content:\n\nremaining");
    expect(result).not.toMatch(/Provider:|fallback|Tavily|extraction:|Browser-rendered/);
  });

  test("tool schema requires exactly one initial URL or continuation and bounds remainder mode", () => {
    const tool = createReadWebpageTool();
    const schema = tool.schema as { safeParse: (input: unknown) => { success: boolean } };
    const continuation = {
      version: 1 as const,
      reference: "c".repeat(43),
      offsetCharacters: 24_000,
      mode: "page" as const,
    };
    expect(schema.safeParse({ url: "https://example.com" }).success).toBe(true);
    expect(schema.safeParse({ continuation }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ url: "https://example.com", continuation }).success).toBe(false);
    expect(schema.safeParse({ continuation: { ...continuation, mode: "remainder" }, maxContentLength: 5 }).success).toBe(false);
    const snapshot = { version: 1, operation: "find" as const, reference: "d".repeat(43), query: "page" };
    expect(schema.safeParse({ snapshot }).success).toBe(true);
    expect(schema.safeParse({ url: "https://example.com", snapshot }).success).toBe(false);
    expect(schema.safeParse({ snapshot, maxContentLength: 5 }).success).toBe(false);
  });

  test("snapshot inspection goes straight to the bound Desktop port without Tavily or a fresh page read", async () => {
    const inspect = mock(async () => ({
      category: "success" as const,
      result: { version: 1 as const, operation: "range" as const, reference: "f".repeat(43), expiresAt: "2026-08-10T12:00:00.000Z",
        offsetCharacters: 12, startOffsetCharacters: 7, endOffsetCharacters: 17, content: "hello page", startsMidBlock: true, endsMidBlock: false, truncatedBlock: true },
    }));
    const read = mock(async () => ({ category: "success" as const, result: browserPage() }));
    const tool = createReadWebpageTool({ browserResearchExecutionPort: { read, inspectSnapshot: inspect } } as never);
    const output: unknown = await tool.invoke({ snapshot: { version: 1, operation: "range", reference: "f".repeat(43), offsetCharacters: 12 } });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(typeof output).toBe("string");
    if (typeof output !== "string") throw new Error("expected string tool result");
    expect(output).toContain("browser_page_snapshot_inspection");
    expect(output).not.toContain("Tavily");
  });

  test("retained Browser page output exposes find and range without provider chatter", () => {
    const text = formatReadWebpageToolResponse({
      url: "https://example.com",
      status: 200,
      content: "Rendered page content",
      preview: "Rendered page content",
      contentLength: 21,
      totalContentLength: 21,
      provider: "browser",
      pageReference: { version: 1, reference: "h".repeat(43), expiresAt: "2026-08-10T12:00:00.000Z" },
    }, "https://example.com");
    expect(text).toContain("snapshot find or range");
    expect(text).toContain('"reference":"' + "h".repeat(43) + '"');
    expect(text).not.toMatch(/Provider:|fallbackReason|extraction:|Browser-rendered/);
  });

  test("one-shot extraction discloses the 250000-character ceiling instead of promising completeness", () => {
    const result = {
      url: "https://example.com/huge",
      status: 200,
      content: "a".repeat(250_000),
      preview: "",
      contentLength: 250_000,
      totalContentLength: 300_000,
      truncated: true,
    };
    const text = formatReadWebpageToolResponse(result, result.url);
    expect(text).toContain("capped at 250000 characters");
    expect(text).toContain("a complete extraction is not available in one call");
    expect(text).toContain("may still be partial");
    expect(text).not.toContain("Complete extracted readable text returned.");
  });

  test("snapshot expiry and eviction remain typed and tell Genie how to recover", async () => {
    for (const [category, code] of [["expired", "snapshot_expired"], ["evicted", "snapshot_evicted"], ["snapshot_unavailable", "snapshot_unavailable"]] as const) {
      const tool = createReadWebpageTool({ browserResearchExecutionPort: {
        read: async () => ({ category: "error" }), inspectSnapshot: async () => ({ category }),
      } } as never);
      const output: unknown = await tool.invoke({ snapshot: { version: 1, operation: "find", reference: "g".repeat(43), query: "page" } });
      if (typeof output !== "string") throw new Error("expected string tool result");
      expect(output).toContain(`[${code}]`);
      expect(output).toContain("Re-read the original URL");
    }
  });
});
