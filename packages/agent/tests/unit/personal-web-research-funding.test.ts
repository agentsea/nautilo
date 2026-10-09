import { describe, expect, test } from "bun:test";
import { buildReadWebpageFetcher } from "../../src/tools/utilities/read-webpage";
import { buildSearchFetcher, buildTavilySearchFetcher } from "../../src/tools/utilities/web-search";
import type { ProviderCostReceipt, ProviderCostRecorder } from "../../src/usage/provider-cost-recorder";

function mockFetch(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect: (_url: string | URL) => {} });
}

function admittedRunner(
  apiKey: string,
  receipts: ProviderCostReceipt[],
) {
  return async <T>(callback: (input: {
    apiKey: string;
    recordProviderCost: ProviderCostRecorder;
  }) => Promise<T>): Promise<T> => callback({
    apiKey,
    recordProviderCost: (receipt) => { receipts.push(receipt); return Promise.resolve(); },
  });
}

describe("personal Tavily provider boundaries", () => {
  test("search uses only its request-local key and settles its admitted recorder", async () => {
    const receipts: ProviderCostReceipt[] = [];
    let authorization = "";
    const search = buildTavilySearchFetcher({
      runProviderAttempt: admittedRunner("personal-search-key", receipts),
      fetchImpl: mockFetch(async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify({ request_id: "search-receipt", usage: { credits: 1 },
          results: [{ url: "https://example.com", title: "Example" }] }),
        { status: 200, headers: { "content-type": "application/json" } });
      }),
    });

    const result = await search("example");

    expect(authorization).toBe("Bearer personal-search-key");
    expect(result.items).toHaveLength(1);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      provider: "tavily", operation: "search", receiptId: "search-receipt", evidenceState: "estimated",
    });
  });

  test("extraction keeps the key inside the admitted callback", async () => {
    const receipts: ProviderCostReceipt[] = [];
    let authorization = "";
    const read = buildReadWebpageFetcher({
      runTavilyAttempt: admittedRunner("personal-extract-key", receipts),
      fetchImpl: mockFetch(async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify({ request_id: "extract-receipt", usage: { credits: 1 },
          results: [{ url: "https://example.com", raw_content: "Evidence" }] }),
        { status: 200, headers: { "content-type": "application/json" } });
      }),
    });

    const result = await read("https://example.com");

    expect(authorization).toBe("Bearer personal-extract-key");
    expect(result.content).toBe("Evidence");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      provider: "tavily", operation: "extract", receiptId: "extract-receipt", evidenceState: "estimated",
    });
  });

  test("a missing paid credential preserves the admitted local search fallback", async () => {
    const search = buildSearchFetcher({
      provider: "auto",
      runTavilyAttempt: async () => {
        throw Object.assign(new Error("not configured"), { code: "personal_credential_missing" });
      },
      browserResearchExecutionPort: {
        read: async () => ({ category: "unavailable" }),
        search: async () => ({ category: "success", result: { provider: "duckduckgo_html",
          items: [{ url: "https://example.com/local", title: "Local result" }] } }),
      },
    });

    const result = await search("local query");

    expect(result).toMatchObject({ provider: "duckduckgo_html", fallbackFrom: "tavily",
      fallbackReason: "tavily_unconfigured", items: [{ title: "Local result" }] });
  });
});
