import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { BrowserResearchSearchExecutor } from "../../electron/browser-research-search-executor";

const INVOCATION = { toolCallId: "tool-search-1", laneKey: "room:1" } as const;

describe("BrowserResearchSearchExecutor", () => {
  test("navigates only the fixed DDG target, captures rendered HTML, and releases it", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "nautilo-research-search-test-"));
    let requestedUrl = "";
    let released = 0;
    const lease = {
      leaseId: "lease-search",
      role: "research" as const,
      requestedUrl: "https://html.duckduckgo.com/html/",
      currentUrl: "https://html.duckduckgo.com/html/",
      partition: "nautilo-research-lease-search",
      cdpUrl: "ws://127.0.0.1:1234/devtools/page/search",
    };
    try {
      const result = await new BrowserResearchSearchExecutor({
        temporaryRoot,
        agentBrowserBin: "/agent-browser",
        pluginRuntimeBin: "/node",
        providerScriptPath: "/provider.js",
        targetManager: {
          createLease: async (url) => { requestedUrl = url; return { ...lease, requestedUrl: url, currentUrl: url }; },
          getActiveLease: () => ({ ...lease, requestedUrl, currentUrl: requestedUrl }),
          release: async () => { released += 1; return true; },
        },
        exec: async (_bin, argv) => argv.at(-1) === "close" ? { stdout: "" } : { stdout: JSON.stringify({
          success: true,
          data: { html: '<div class="result"><a class="result__a" href="https://example.com/article">Example</a><div class="result__snippet">Useful evidence</div></div>' },
        }) },
      }).search({ provider: "duckduckgo_html", query: "Nautilo", maxResults: 5, ...INVOCATION });

      expect(new URL(requestedUrl).origin).toBe("https://html.duckduckgo.com");
      expect(new URL(requestedUrl).searchParams.get("q")).toBe("Nautilo");
      expect(result).toMatchObject({ status: "ok", result: { provider: "duckduckgo_html", items: [{ url: "https://example.com/article" }] } });
      expect(released).toBe(1);
      expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: temporaryRoot }))).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("returns typed failure rather than asking the Human on a DDG challenge", async () => {
    const lease = { leaseId: "lease-challenge", role: "research" as const, requestedUrl: "https://html.duckduckgo.com/html/", currentUrl: "https://html.duckduckgo.com/html/", partition: "research", cdpUrl: "ws://127.0.0.1:1234/devtools/page/challenge" };
    const result = await new BrowserResearchSearchExecutor({
      agentBrowserBin: "/agent-browser", pluginRuntimeBin: "/node", providerScriptPath: "/provider.js",
      targetManager: { createLease: async () => lease, getActiveLease: () => lease, release: async () => true },
      exec: async (_bin, argv) => argv.at(-1) === "close" ? { stdout: "" } : { stdout: JSON.stringify({ success: true, data: { html: "<main>Verify you are human with this CAPTCHA</main>" } }) },
    }).search({ provider: "duckduckgo_html", query: "Nautilo", maxResults: 5, ...INVOCATION });
    expect(result).toEqual({ status: "ok", result: { provider: "duckduckgo_html", items: [], failure: "challenge" } });
  });

  test("clears an ordinary DDG cookie wall once and recaptures results without Human work", async () => {
    const lease = { leaseId: "lease-cookie", role: "research" as const, requestedUrl: "https://html.duckduckgo.com/html/", currentUrl: "https://html.duckduckgo.com/html/", partition: "research", cdpUrl: "ws://127.0.0.1:1234/devtools/page/cookie" };
    let htmlCaptures = 0;
    const clicks: string[] = [];
    const result = await new BrowserResearchSearchExecutor({
      agentBrowserBin: "/agent-browser", pluginRuntimeBin: "/node", providerScriptPath: "/provider.js",
      targetManager: { createLease: async () => lease, getActiveLease: () => lease, release: async () => true },
      exec: async (_bin, argv) => {
        if (argv.at(-1) === "close") return { stdout: "" };
        if (argv.includes("snapshot")) return { stdout: JSON.stringify({ success: true, data: { snapshot: '- dialog "Cookie privacy choices"\n  - button "Reject all" [ref=e7]' } }) };
        if (argv.includes("click")) { clicks.push(argv.at(-1)!); return { stdout: JSON.stringify({ success: true }) }; }
        if (argv.includes("wait")) return { stdout: JSON.stringify({ success: true }) };
        htmlCaptures += 1;
        return { stdout: JSON.stringify({ success: true, data: { html: htmlCaptures === 1
          ? '<main>Cookie consent privacy preferences <button>Reject all</button></main>'
          : '<div class="result"><a class="result__a" href="https://example.com/article">Example</a></div>' } }) };
      },
    }).search({ provider: "duckduckgo_html", query: "Nautilo", maxResults: 5, ...INVOCATION });

    expect(result).toMatchObject({ status: "ok", result: { items: [{ url: "https://example.com/article" }] } });
    expect(htmlCaptures).toBe(2);
    expect(clicks).toEqual(["@e7"]);
  });

  test("does not conflate a CAPTCHA that mentions cookies with a routine cookie wall", async () => {
    const lease = { leaseId: "lease-challenge-cookie", role: "research" as const, requestedUrl: "https://html.duckduckgo.com/html/", currentUrl: "https://html.duckduckgo.com/html/", partition: "research", cdpUrl: "ws://127.0.0.1:1234/devtools/page/challenge-cookie" };
    const calls: string[][] = [];
    const result = await new BrowserResearchSearchExecutor({
      agentBrowserBin: "/agent-browser", pluginRuntimeBin: "/node", providerScriptPath: "/provider.js",
      targetManager: { createLease: async () => lease, getActiveLease: () => lease, release: async () => true },
      exec: async (_bin, argv) => {
        calls.push(argv);
        return argv.at(-1) === "close"
          ? { stdout: "" }
          : { stdout: JSON.stringify({ success: true, data: { html: "<main>Cookie consent: verify you are human with this CAPTCHA</main>" } }) };
      },
    }).search({ provider: "duckduckgo_html", query: "Nautilo", maxResults: 5, ...INVOCATION });

    expect(result).toEqual({ status: "ok", result: { provider: "duckduckgo_html", items: [], failure: "challenge" } });
    expect(calls.some((argv) => argv.includes("snapshot") || argv.includes("click"))).toBe(false);
  });

  test("makes one consent attempt, re-observes once, then returns the original truthful failure", async () => {
    const lease = { leaseId: "lease-still-cookie", role: "research" as const, requestedUrl: "https://html.duckduckgo.com/html/", currentUrl: "https://html.duckduckgo.com/html/", partition: "research", cdpUrl: "ws://127.0.0.1:1234/devtools/page/still-cookie" };
    let htmlCaptures = 0;
    let clicks = 0;
    const result = await new BrowserResearchSearchExecutor({
      agentBrowserBin: "/agent-browser", pluginRuntimeBin: "/node", providerScriptPath: "/provider.js",
      targetManager: { createLease: async () => lease, getActiveLease: () => lease, release: async () => true },
      exec: async (_bin, argv) => {
        if (argv.at(-1) === "close") return { stdout: "" };
        if (argv.includes("snapshot")) return { stdout: JSON.stringify({ success: true, data: { snapshot: '- dialog "Cookie preferences"\n  - button "Reject all" [ref=e7]' } }) };
        if (argv.includes("click")) { clicks += 1; return { stdout: JSON.stringify({ success: true }) }; }
        if (argv.includes("wait")) return { stdout: JSON.stringify({ success: true }) };
        htmlCaptures += 1;
        return { stdout: JSON.stringify({ success: true, data: { html: '<main>Cookie consent privacy preferences <button>Reject all</button></main>' } }) };
      },
    }).search({ provider: "duckduckgo_html", query: "Nautilo", maxResults: 5, ...INVOCATION });

    expect(result).toEqual({ status: "ok", result: { provider: "duckduckgo_html", items: [], failure: "markup_drift" } });
    expect(htmlCaptures).toBe(2);
    expect(clicks).toBe(1);
  });
});
