import { describe, expect, test } from "bun:test";
import {
  agentBrowserPageReadEvalArgv,
  browserArgvPrefix,
  type BrowserPageReadProgramOutput,
  type BrowserPageReadResult,
} from "@nautilo/relay";
import {
  BROWSER_PAGE_READ_NO_ACTIVE_TARGET_ERROR,
  BROWSER_RESEARCH_PAGE_READ_NO_TARGET_ERROR,
  agentBrowserPageReadAccessibilitySnapshotArgv,
  agentBrowserPageReadHtmlArgv,
  dispatchInteractiveBrowserPageRead,
  dispatchResearchBrowserPageRead,
  parseAgentBrowserRenderedHtmlEnvelope,
} from "../../electron/browser-page-read-dispatch";
import {
  BrowserPageSnapshotStore,
  type BrowserPageSnapshotOwnerBinding,
} from "../../electron/browser-page-snapshot-store";

const SNAPSHOT_OWNER: BrowserPageSnapshotOwnerBinding = {
  instanceId: "instance-1",
  userId: "user-1",
  relayId: "relay-1",
  desktopSessionId: "session-1",
};

function programOutput(overrides: Partial<BrowserPageReadProgramOutput> = {}): BrowserPageReadProgramOutput {
  return {
    finalUrl: "https://example.test/final?token=secret&keep=yes",
    title: "Example page",
    readiness: "complete",
    extractionMs: 3,
    root: "main",
    blocks: [{ kind: "paragraph", text: "Evaluator metadata only" }],
    totalCharacters: 23,
    totalCharactersCapped: false,
    metadataTruncated: false,
    iframeCount: 0,
    canvasCount: 0,
    virtualizedHint: false,
    boilerplateHint: false,
    challengeSignals: [],
    sourceTruncated: false,
    ...overrides,
  };
}

const input = {
  bin: "/app/agent-browser",
  cfgPath: "/tmp/provider.json",
  session: "nautilo-active-1",
  timeoutMs: 30_000,
  maxBuffer: 1024 * 1024,
};

function htmlEnvelope(html: string): string {
  return JSON.stringify({ success: true, data: { html }, error: null });
}

function snapshotEnvelope(snapshot: string): string {
  return JSON.stringify({
    success: true,
    data: { origin: "https://example.test/", refs: { e1: { role: "link", name: "Useful link" } }, snapshot },
    error: null,
  });
}

describe("rendered browser page-read dispatch", () => {
  test("uses only exact fixed evaluator and HTML argv, then returns Readability Markdown", async () => {
    const executed: string[][] = [];
    const result = await dispatchInteractiveBrowserPageRead(
      { script: "document.cookie", selector: "#attacker", url: "https://attacker.test", maxChars: 20_000 },
      input,
      {
        hasActiveTarget: () => true,
        exec: async (_bin, argv) => {
          executed.push(argv);
          return { stdout: htmlEnvelope(`<head><title>Rendered title</title></head><body><article><h1>Rendered title</h1><p>${"A useful rendered paragraph with enough evidence. ".repeat(20)}</p><a href='/docs'>Docs</a></article></body>`) };
        },
        parseOutput: () => ({ ok: true, programOutput: programOutput() }),
      },
    );

    expect(executed).toEqual([
      agentBrowserPageReadEvalArgv(input.cfgPath, input.session),
      agentBrowserPageReadHtmlArgv(input.cfgPath, input.session),
    ]);
    expect(executed.flat()).not.toContain("document.cookie");
    expect(executed.flat()).not.toContain("#attacker");
    expect(executed.flat()).not.toContain("https://attacker.test");
    const page = result.result as BrowserPageReadResult;
    expect(page.extraction.method).toBe("mozilla-readability-turndown-v1");
    expect(page.quality).toBe("complete");
    expect(page.finalUrl).toBe("https://example.test/final?keep=yes");
    expect(page.content).toContain("A useful rendered paragraph with enough evidence.");
    expect(page.content).toContain("[Docs](https://example.test/docs)");
    expect(page.content).not.toContain("Evaluator metadata only");
  });

  test("uses the exact JSON accessibility snapshot for a short application surface and strips internal refs", async () => {
    const executed: string[][] = [];
    const result = await dispatchInteractiveBrowserPageRead({}, input, {
      hasActiveTarget: () => true,
      exec: async (_bin, argv) => {
        executed.push(argv);
        if (argv.includes("snapshot")) {
          return { stdout: snapshotEnvelope("- main\n  - heading \"App page\" [level=1, ref=e1]\n  - link \"Useful link\" [ref=e1, url=https://example.test/docs]") };
        }
        return { stdout: htmlEnvelope("<head><title>Search</title></head><body><main role='search'><h1>App page</h1><p>Rendered shell</p></main></body>") };
      },
      parseOutput: () => ({ ok: true, programOutput: programOutput() }),
    });

    expect(executed).toEqual([
      agentBrowserPageReadEvalArgv(input.cfgPath, input.session),
      agentBrowserPageReadHtmlArgv(input.cfgPath, input.session),
      agentBrowserPageReadAccessibilitySnapshotArgv(input.cfgPath, input.session),
    ]);
    const page = result.result as BrowserPageReadResult;
    expect(page.extraction.method).toBe("agent-browser-accessibility-snapshot-v1");
    expect(page.quality).toBe("partial");
    expect(page.content).toContain("url=https://example.test/docs");
    expect(page.content).not.toContain("ref=e1");
    expect(page.diagnostics).toContain("accessibility-content-may-be-partial");
  });

  test("keeps a strong Readability article despite an incidental iframe", async () => {
    const executed: string[][] = [];
    const result = await dispatchInteractiveBrowserPageRead({}, input, {
      hasActiveTarget: () => true,
      exec: async (_bin, argv) => {
        executed.push(argv);
        return { stdout: htmlEnvelope(`<head><title>Article</title></head><body><article><h1>Article</h1><p>${"Substantive article evidence. ".repeat(40)}</p><iframe src='https://ads.example.test/embed'></iframe></article></body>`) };
      },
      parseOutput: () => ({ ok: true, programOutput: programOutput({ iframeCount: 1 }) }),
    });
    expect(executed).toEqual([
      agentBrowserPageReadEvalArgv(input.cfgPath, input.session),
      agentBrowserPageReadHtmlArgv(input.cfgPath, input.session),
    ]);
    expect(result).toMatchObject({
      status: "ok",
      result: { extraction: { method: "mozilla-readability-turndown-v1" }, quality: "partial", failure: "iframe-limited" },
    });
  });

  test("preserves readiness retry before rendered capture and uses the renewed metadata", async () => {
    const executed: string[][] = [];
    let evalCount = 0;
    const result = await dispatchInteractiveBrowserPageRead({}, input, {
      hasActiveTarget: () => true,
      exec: async (_bin, argv) => {
        executed.push(argv);
        return { stdout: htmlEnvelope(`<head><title>Settled</title></head><body><article><p>${"Settled rendered content with enough evidence. ".repeat(20)}</p></article></body>`) };
      },
      parseOutput: () => ({
        ok: true,
        programOutput: programOutput({ readiness: ++evalCount === 1 ? "loading" : "complete" }),
      }),
    });

    expect(executed).toEqual([
      agentBrowserPageReadEvalArgv(input.cfgPath, input.session),
      [...browserArgvPrefix(input.cfgPath, input.session), "wait", "250"],
      agentBrowserPageReadEvalArgv(input.cfgPath, input.session),
      agentBrowserPageReadHtmlArgv(input.cfgPath, input.session),
    ]);
    expect((result.result as BrowserPageReadResult).content).toContain("Settled rendered content");
  });

  test("does not fetch a challenge page after the fixed evaluator classifies it", async () => {
    const executed: string[][] = [];
    const result = await dispatchInteractiveBrowserPageRead({}, input, {
      hasActiveTarget: () => true,
      exec: async (_bin, argv) => {
        executed.push(argv);
        return { stdout: "ignored" };
      },
      parseOutput: () => ({ ok: true, programOutput: programOutput({ challengeSignals: ["cloudflare", "captcha"] }) }),
    });

    expect(executed).toEqual([agentBrowserPageReadEvalArgv(input.cfgPath, input.session)]);
    expect(result).toMatchObject({ status: "ok", result: { quality: "challenge", failure: "challenge", content: "" } });
  });

  test("reports an honest failure when neither rendered HTML nor fallback snapshot can be read", async () => {
    let call = 0;
    const result = await dispatchInteractiveBrowserPageRead({}, input, {
      hasActiveTarget: () => true,
      exec: async () => {
        call += 1;
        if (call === 1) return { stdout: "evaluator" };
        throw new Error("internal transport detail must not escape");
      },
      parseOutput: () => ({ ok: true, programOutput: programOutput() }),
    });

    expect(result).toMatchObject({ status: "ok", result: { failure: "evaluation-error", quality: "error" } });
    expect(JSON.stringify(result)).not.toContain("internal transport detail");
  });

  test("shares one deadline across evaluator, HTML, and fallback commands", async () => {
    let time = 0;
    const observed: Array<{ argv: string[]; timeout: number }> = [];
    const boundedInput = { ...input, timeoutMs: 350 };
    const result = await dispatchInteractiveBrowserPageRead({}, boundedInput, {
      hasActiveTarget: () => true,
      now: () => time,
      exec: async (_bin, argv, options) => {
        observed.push({ argv, timeout: options.timeout });
        time += 100;
        if (argv.includes("snapshot")) return { stdout: snapshotEnvelope("- main\n  - paragraph\n    - StaticText \"Fallback text\"") };
        return { stdout: htmlEnvelope("<head><title>Short</title></head><body><main role='search'><p>Short</p></main></body>") };
      },
      parseOutput: () => ({ ok: true, programOutput: programOutput() }),
    });
    expect(observed).toEqual([
      { argv: agentBrowserPageReadEvalArgv(input.cfgPath, input.session), timeout: 350 },
      { argv: agentBrowserPageReadHtmlArgv(input.cfgPath, input.session), timeout: 250 },
      { argv: agentBrowserPageReadAccessibilitySnapshotArgv(input.cfgPath, input.session), timeout: 150 },
    ]);
    expect(time).toBeLessThanOrEqual(boundedInput.timeoutMs);
    expect(result).toMatchObject({ status: "ok", result: { extraction: { method: "agent-browser-accessibility-snapshot-v1" } } });
  });

  test("does not start HTML capture after the evaluator exhausts the deadline", async () => {
    let time = 0;
    const executed: string[][] = [];
    const result = await dispatchInteractiveBrowserPageRead({}, { ...input, timeoutMs: 100 }, {
      hasActiveTarget: () => true,
      now: () => time,
      exec: async (_bin, argv) => {
        executed.push(argv);
        time = 100;
        return { stdout: "evaluator" };
      },
      parseOutput: () => ({ ok: true, programOutput: programOutput() }),
    });
    expect(executed).toEqual([agentBrowserPageReadEvalArgv(input.cfgPath, input.session)]);
    expect(result).toMatchObject({ status: "ok", result: { failure: "timeout", quality: "error" } });
  });

  test("retains full extracted total beyond the legacy evaluator ceiling while bounding this response", async () => {
    const longParagraph = "meaningful rendered content ".repeat(2_000);
    const result = await dispatchInteractiveBrowserPageRead({ maxChars: 40_000 }, input, {
      hasActiveTarget: () => true,
      exec: async () => ({ stdout: htmlEnvelope(`<head><title>Long</title></head><body><article><p>${longParagraph}</p></article></body>`) }),
      parseOutput: () => ({ ok: true, programOutput: programOutput({ sourceTruncated: true, totalCharactersCapped: true }) }),
    });
    const page = result.result as BrowserPageReadResult;
    expect(page.totalCharacters).toBeGreaterThan(40_000);
    expect(page.totalCharactersCapped).toBe(false);
    expect(page.returnedCharacters).toBe(40_000);
    expect(page.truncated).toBe(true);
  });

  test("creates one immutable snapshot after extraction and returns a structural continuation", async () => {
    let commands = 0;
    const store = new BrowserPageSnapshotStore();
    const longParagraph = "snapshot evidence ".repeat(4_000);
    const result = await dispatchInteractiveBrowserPageRead({}, input, {
      hasActiveTarget: () => true,
      exec: async () => {
        commands += 1;
        return { stdout: htmlEnvelope(`<head><title>Long</title></head><body><article><p>${longParagraph}</p></article></body>`) };
      },
      parseOutput: () => ({ ok: true, programOutput: programOutput() }),
      snapshotStore: store,
      snapshotOwner: SNAPSHOT_OWNER,
    });
    const page = result.result as BrowserPageReadResult;
    expect(commands).toBe(2);
    expect(page).toMatchObject({ returnedCharacters: 24_000, eof: false, truncated: true });
    expect(page.continuation).toBeDefined();
    expect(page.pageReference).toBeUndefined();
    expect(store.debugState().entries).toBe(1);
  });

  test("returns a capability-gated page reference when the initial page is already EOF", async () => {
    const store = new BrowserPageSnapshotStore();
    const result = await dispatchInteractiveBrowserPageRead({}, input, {
      hasActiveTarget: () => true,
      exec: async () => ({ stdout: htmlEnvelope("<head><title>Short</title></head><body><article><p>Short complete page.</p></article></body>") }),
      parseOutput: () => ({ ok: true, programOutput: programOutput() }),
      snapshotStore: store,
      snapshotOwner: SNAPSHOT_OWNER,
      publishSnapshotReference: true,
    });
    expect(result).toMatchObject({ status: "ok", result: { eof: true } });
    expect((result.result as BrowserPageReadResult).continuation).toBeUndefined();
    expect((result.result as BrowserPageReadResult).pageReference).toEqual(expect.objectContaining({ version: 1 }));
    expect(store.debugState().entries).toBe(1);
  });

  test("keeps old-relay one-shot EOF behavior when no negotiated snapshot owner is installed", async () => {
    const store = new BrowserPageSnapshotStore();
    const result = await dispatchInteractiveBrowserPageRead({}, input, {
      hasActiveTarget: () => true,
      exec: async () => ({ stdout: htmlEnvelope("<head><title>Short</title></head><body><article><p>Short complete page.</p></article></body>") }),
      parseOutput: () => ({ ok: true, programOutput: programOutput() }),
      snapshotStore: store,
    });
    expect(result).toMatchObject({ status: "ok", result: { eof: true } });
    expect((result.result as BrowserPageReadResult).pageReference).toBeUndefined();
    expect(store.debugState()).toEqual({ entries: 0, retainedBytes: 0 });
  });

  test("never creates a continuation for a classified challenge", async () => {
    const store = new BrowserPageSnapshotStore();
    const result = await dispatchInteractiveBrowserPageRead({}, input, {
      hasActiveTarget: () => true,
      exec: async () => ({ stdout: "ignored" }),
      parseOutput: () => ({ ok: true, programOutput: programOutput({ challengeSignals: ["captcha"] }) }),
      snapshotStore: store,
      snapshotOwner: SNAPSHOT_OWNER,
    });
    expect(result).toMatchObject({ status: "ok", result: { challenge: { detected: true } } });
    expect((result.result as BrowserPageReadResult).continuation).toBeUndefined();
    expect(store.debugState().entries).toBe(0);
  });

  test("never creates a page reference for an empty or failed extraction", async () => {
    const store = new BrowserPageSnapshotStore();
    const result = await dispatchInteractiveBrowserPageRead({}, input, {
      hasActiveTarget: () => true,
      exec: async () => { throw new Error("capture failed"); },
      parseOutput: () => ({ ok: true, programOutput: programOutput() }),
      snapshotStore: store,
      snapshotOwner: SNAPSHOT_OWNER,
    });
    expect(result).toMatchObject({ status: "ok", result: { content: "", quality: "error" } });
    expect((result.result as BrowserPageReadResult).pageReference).toBeUndefined();
    expect(store.debugState()).toEqual({ entries: 0, retainedBytes: 0 });
  });

  test("runs the identical rendered integration for research while retaining its exact requested URL", async () => {
    const executed: string[][] = [];
    const result = await dispatchResearchBrowserPageRead(
      { maxChars: 500 },
      "https://requested.example/article",
      input,
      {
        hasActiveTarget: () => true,
        exec: async (_bin, argv) => {
          executed.push(argv);
          return { stdout: htmlEnvelope(`<head><title>Research</title></head><body><article><h1>Research</h1><p>${"Research body with durable evidence. ".repeat(20)}</p></article></body>`) };
        },
        parseOutput: () => ({ ok: true, programOutput: programOutput({ finalUrl: "https://final.example/article" }) }),
      },
    );
    expect(executed).toEqual([
      agentBrowserPageReadEvalArgv(input.cfgPath, input.session),
      agentBrowserPageReadHtmlArgv(input.cfgPath, input.session),
    ]);
    expect(result).toMatchObject({
      status: "ok",
      result: { targetRole: "research", requestedUrl: "https://requested.example/article", finalUrl: "https://final.example/article" },
    });
  });

  test("fails closed before any command without the exact active target", async () => {
    let executed = false;
    const interactive = await dispatchInteractiveBrowserPageRead({}, input, {
      hasActiveTarget: () => false,
      exec: async () => {
        executed = true;
        return { stdout: "unexpected" };
      },
    });
    const research = await dispatchResearchBrowserPageRead({}, "https://requested.example/", input, {
      hasActiveTarget: () => false,
      exec: async () => ({ stdout: "unexpected" }),
    });
    expect(interactive).toEqual({ status: "error", error: BROWSER_PAGE_READ_NO_ACTIVE_TARGET_ERROR });
    expect(research).toEqual({ status: "error", error: BROWSER_RESEARCH_PAGE_READ_NO_TARGET_ERROR });
    expect(executed).toBe(false);
  });

  test("rejects invalid maxChars before execution and preserves evaluator timeout/malformed contracts", async () => {
    let executed = false;
    const invalid = await dispatchInteractiveBrowserPageRead({ maxChars: 0 }, input, {
      hasActiveTarget: () => true,
      exec: async () => {
        executed = true;
        return { stdout: "unexpected" };
      },
    });
    expect(invalid).toEqual({ status: "error", error: "browser page read maxChars must be a positive integer" });
    expect(executed).toBe(false);

    const timeout = await dispatchInteractiveBrowserPageRead({}, input, {
      hasActiveTarget: () => true,
      exec: async () => { throw { killed: true, stderr: "ws://127.0.0.1:9222 secret" }; },
    });
    expect(timeout).toMatchObject({ status: "ok", result: { failure: "timeout", quality: "error" } });
    expect(JSON.stringify(timeout)).not.toContain("ws://127.0.0.1:9222");

    const malformed = await dispatchInteractiveBrowserPageRead({}, input, {
      hasActiveTarget: () => true,
      exec: async () => ({ stdout: "not evaluator output" }),
    });
    expect(malformed).toMatchObject({ status: "ok", result: { failure: "evaluation-error", quality: "error" } });
  });

  test("accepts only the actual fixed HTML JSON envelope", () => {
    expect(parseAgentBrowserRenderedHtmlEnvelope(htmlEnvelope("<main>OK</main>"))).toBe("<main>OK</main>");
    expect(parseAgentBrowserRenderedHtmlEnvelope('{"success":true,"data":{"html":7}}')).toBeUndefined();
    expect(parseAgentBrowserRenderedHtmlEnvelope('{"success":false,"data":{"html":"x"}}')).toBeUndefined();
  });
});
