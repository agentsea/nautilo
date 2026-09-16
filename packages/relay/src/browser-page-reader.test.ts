import { describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import {
  agentBrowserPageReadEvalArgv,
  BROWSER_PAGE_READ_EVAL_SOURCE,
  BROWSER_PAGE_READ_MAX_TITLE_CHARS,
  BROWSER_PAGE_READ_MAX_URL_CHARS,
  BROWSER_PAGE_READ_PROGRAM_MAX_BLOCKS,
  BROWSER_PAGE_READ_PROGRAM_MAX_LINKS_PER_BLOCK,
  normalizeBrowserPageReadResult,
  parseAgentBrowserPageReadEvalOutput,
  type BrowserPageReadProgramOutput,
} from "./browser-page-reader";
import { browserArgvPrefix } from "./browser";
import { BROWSER_PAGE_READ_FIXTURES } from "./browser-page-reader-fixtures";

function runFixture(html: string, url: string): BrowserPageReadProgramOutput {
  const window = new Window({ url });
  window.document.write(html);
  // The fixture gate executes the exact fixed production program; it never
  // receives fixture text or model input as executable source.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const evaluate = new Function(
    "document",
    "location",
    "performance",
    `return ${BROWSER_PAGE_READ_EVAL_SOURCE};`,
  ) as (
    document: unknown,
    location: unknown,
    performance: unknown,
  ) => BrowserPageReadProgramOutput;
  return evaluate(window.document, window.location, window.performance);
}

describe("D504 fixed browser page reader", () => {
  it("uses one fixed agent-browser eval argv program with no caller JavaScript", () => {
    const argv = agentBrowserPageReadEvalArgv("/tmp/provider.json", "interactive-1");
    expect(argv.slice(0, -2)).toEqual([
      ...browserArgvPrefix("/tmp/provider.json", "interactive-1"),
    ]);
    expect(argv.at(-2)).toBe("eval");
    expect(argv.at(-1)).toBe(BROWSER_PAGE_READ_EVAL_SOURCE);
    expect(BROWSER_PAGE_READ_EVAL_SOURCE).toContain("article");
    expect(BROWSER_PAGE_READ_EVAL_SOURCE).toContain("main");
    expect(BROWSER_PAGE_READ_EVAL_SOURCE).toContain("return payload");
    expect(BROWSER_PAGE_READ_EVAL_SOURCE).not.toContain("${");
  });

  for (const fixture of BROWSER_PAGE_READ_FIXTURES) {
    it(`meets the objective fixture gate: ${fixture.name}`, () => {
      const programOutput = runFixture(fixture.html, fixture.url);
      const request = fixture.name === "long output"
        ? { targetRole: "interactive" as const, requestedUrl: fixture.requestedUrl ?? fixture.url, maxChars: 300 }
        : { targetRole: "interactive" as const, requestedUrl: fixture.requestedUrl ?? fixture.url };
      const result = normalizeBrowserPageReadResult(
        request,
        programOutput,
        { elapsedMs: 12 },
      );
      expect(result.extraction.root).toBe(fixture.expected.root);
      expect(result.quality).toBe(fixture.expected.quality);
      expect(result.failure).toBe(fixture.expected.failure);
      expect(result.timing.elapsedMs).toBe(12);
      if (fixture.expected.requestedUrl) expect(result.requestedUrl).toBe(fixture.expected.requestedUrl);
      if (fixture.expected.finalUrl) expect(result.finalUrl).toBe(fixture.expected.finalUrl);
      for (const retained of fixture.expected.retains ?? []) expect(result.content).toContain(retained);
      for (const excluded of fixture.expected.excludes ?? []) expect(result.content).not.toContain(excluded);
      for (const text of fixture.expected.occursOnce ?? []) {
        expect(result.content.split(text).length - 1).toBe(1);
      }
      if (fixture.expected.truncated) {
        expect(result.truncated).toBe(true);
        expect(result.returnedCharacters).toBeLessThanOrEqual(300);
        expect(result.totalCharacters).toBeGreaterThan(result.returnedCharacters);
      }
    });
  }

  it("parses one v0.31.1 pretty JSON object and rejects malformed or double-encoded eval output", () => {
    const output = runFixture(BROWSER_PAGE_READ_FIXTURES[0]!.html, "https://example.test/article");
    const stdout = JSON.stringify(output, null, 2);
    expect(parseAgentBrowserPageReadEvalOutput(stdout)).toEqual({ ok: true, programOutput: output });
    expect(parseAgentBrowserPageReadEvalOutput(JSON.stringify(stdout))).toEqual({
      ok: false,
      failure: "evaluation-error",
      diagnostic: "evaluation-output-malformed",
    });
    expect(parseAgentBrowserPageReadEvalOutput("not json")).toEqual({
      ok: false,
      failure: "evaluation-error",
      diagnostic: "evaluation-output-malformed",
    });
  });

  it("caps every fixed-program metadata collection before CLI serialization", () => {
    const giant = "x".repeat(10_000);
    const manyBlocks = Array.from(
      { length: BROWSER_PAGE_READ_PROGRAM_MAX_BLOCKS * 3 },
      (_, index) => `<p>block ${index}<a href="https://example.test/${giant}">${giant}</a></p>`,
    ).join("");
    const output = runFixture(
      `<html><head><title>${giant}</title></head><body><article>${manyBlocks}</article></body></html>`,
      `https://user:secret@example.test/${giant}?token=secret#fragment`,
    );
    expect(typeof output).toBe("object");
    expect((output.title as string).length).toBeLessThanOrEqual(BROWSER_PAGE_READ_MAX_TITLE_CHARS);
    expect((output.finalUrl as string).length).toBeLessThanOrEqual(2_048);
    expect((output.blocks as unknown[]).length).toBeLessThanOrEqual(BROWSER_PAGE_READ_PROGRAM_MAX_BLOCKS);
    for (const block of output.blocks as Array<{ links?: unknown[] }>) {
      expect(block.links?.length ?? 0).toBeLessThanOrEqual(BROWSER_PAGE_READ_PROGRAM_MAX_LINKS_PER_BLOCK);
    }
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(30_000);
    expect(output.sourceTruncated).toBe(true);
  });

  it("redacts sensitive browser-side URL and link metadata before eval output", () => {
    const output = runFixture(
      `<article><p><a href="https://person:secret@example.test/link?token=one&keep=yes&sig=two#fragment">Reference</a></p></article>`,
      "https://person:secret@example.test/final?access_token=one&keep=yes#fragment",
    ) as BrowserPageReadProgramOutput & {
      finalUrl: string;
      blocks: Array<{ links?: Array<{ href: string }> }>;
    };
    expect(output.finalUrl).toBe("https://example.test/final?keep=yes");
    expect(output.blocks[0]?.links?.[0]?.href).toBe("https://example.test/link?keep=yes");
  });

  it("keeps program-cap totals distinct from caller-cap returned content", () => {
    const programResult = normalizeBrowserPageReadResult(
      { targetRole: "interactive" },
      {
        finalUrl: "https://example.test/long",
        title: "Long",
        readiness: "complete",
        extractionMs: 1,
        root: "article",
        blocks: [{ kind: "paragraph", text: "only the capped prefix" }],
        totalCharacters: 10_000,
        totalCharactersCapped: false,
        iframeCount: 0,
        canvasCount: 0,
        virtualizedHint: false,
        boilerplateHint: false,
        challengeSignals: [],
        sourceTruncated: true,
      },
    );
    expect(programResult.totalCharacters).toBe(10_000);
    expect(programResult.returnedCharacters).toBe("only the capped prefix".length);
    expect(programResult.truncated).toBe(true);
    expect(programResult.quality).toBe("partial");

    const callerResult = normalizeBrowserPageReadResult(
      { targetRole: "interactive", maxChars: 5 },
      {
        finalUrl: "https://example.test/caller",
        title: "Caller",
        readiness: "complete",
        extractionMs: 1,
        root: "article",
        blocks: [{ kind: "paragraph", text: "ten chars!" }],
        totalCharacters: 10,
        totalCharactersCapped: false,
        iframeCount: 0,
        canvasCount: 0,
        virtualizedHint: false,
        boilerplateHint: false,
        challengeSignals: [],
        sourceTruncated: false,
      },
    );
    expect(callerResult.totalCharacters).toBe(10);
    expect(callerResult.returnedCharacters).toBe(5);
    expect(callerResult.truncated).toBe(true);
    expect(callerResult.quality).toBe("partial");
  });

  it("uses origin-only page URLs and omits oversized links instead of inventing a URL prefix", () => {
    const giant = "x".repeat(BROWSER_PAGE_READ_MAX_URL_CHARS + 100);
    const output = runFixture(
      `<article><p><a href="https://example.test/${giant}">Oversized link</a></p></article>`,
      `https://example.test/${giant}`,
    ) as BrowserPageReadProgramOutput & {
      finalUrl: string;
      blocks: Array<{ links?: Array<{ href: string }> }>;
    };
    expect(output.finalUrl).toBe("https://example.test/");
    expect(output.blocks[0]?.links).toBeUndefined();
    expect(output.metadataTruncated).toBe(true);
    const programNormalized = normalizeBrowserPageReadResult(
      { targetRole: "interactive" },
      output,
    );
    expect(programNormalized.diagnostics).toContain("metadata-truncated");
    expect(programNormalized.quality).toBe("partial");

    const normalized = normalizeBrowserPageReadResult(
      { targetRole: "interactive" },
      {
        finalUrl: `https://example.test/${giant}`,
        title: "Large URL",
        readiness: "complete",
        extractionMs: 1,
        root: "article",
        blocks: [{ kind: "paragraph", text: "Host", links: [{ text: "Oversized", href: `https://example.test/${giant}` }] }],
        totalCharacters: 4,
        totalCharactersCapped: false,
        iframeCount: 0,
        canvasCount: 0,
        virtualizedHint: false,
        boilerplateHint: false,
        challengeSignals: [],
        sourceTruncated: false,
      },
    );
    expect(normalized.finalUrl).toBe("https://example.test/");
    expect(normalized.blocks[0]?.links).toBeUndefined();
    expect(normalized.diagnostics).toEqual(["final-url-truncated"]);
  });

  it("redacts credentialed and sensitive URLs and bounds title/diagnostics", () => {
    const result = normalizeBrowserPageReadResult(
      {
        targetRole: "research",
        requestedUrl: "https://person:secret@example.test/requested?token=one&safe=yes&Code=two#private",
      },
      {
        finalUrl: "https://person:secret@example.test/final?api_key=three&keep=yes&sig=four#private",
        title: `  ${"A".repeat(BROWSER_PAGE_READ_MAX_TITLE_CHARS + 20)}  `,
        readiness: "complete",
        extractionMs: 1,
        root: "body",
        blocks: [{ kind: "paragraph", text: "Useful rendered content" }],
        totalCharacters: 23,
        totalCharactersCapped: false,
        iframeCount: 0,
        canvasCount: 0,
        virtualizedHint: false,
        boilerplateHint: false,
        challengeSignals: ["not-a-signal", "captcha"],
        sourceTruncated: false,
      },
    );
    expect(result.requestedUrl).toBe("https://example.test/requested?safe=yes");
    expect(result.finalUrl).toBe("https://example.test/final?keep=yes");
    expect(result.title.length).toBe(BROWSER_PAGE_READ_MAX_TITLE_CHARS);
    expect(result.challenge).toEqual({ detected: true, confidence: "heuristic", signals: ["captcha"] });
    expect(result.diagnostics).toEqual(["title-truncated", "challenge-heuristic"]);
  });

  it("drops stale content on transport failure without exposing implementation errors", () => {
    const result = normalizeBrowserPageReadResult(
      { targetRole: "interactive" },
      { blocks: [{ kind: "paragraph", text: "Do not leak this transport text" }] },
      { transportFailure: "timeout" },
    );
    expect(result.quality).toBe("error");
    expect(result.failure).toBe("timeout");
    expect(result.diagnostics).toEqual(["timeout"]);
    expect(result.content).toBe("");
    expect(result.blocks).toEqual([]);
    expect(result.totalCharacters).toBe(0);
    expect(result.returnedCharacters).toBe(0);
  });

  it("marks a still-loading document partial without overriding stronger visual limits", () => {
    const loading = normalizeBrowserPageReadResult(
      { targetRole: "interactive" },
      {
        finalUrl: "https://example.test/loading",
        title: "Loading",
        readiness: "loading",
        extractionMs: 1,
        root: "main",
        blocks: [{ kind: "paragraph", text: "Early rendered content" }],
        totalCharacters: 22,
        totalCharactersCapped: false,
        iframeCount: 0,
        canvasCount: 0,
        virtualizedHint: false,
        boilerplateHint: false,
        challengeSignals: [],
        sourceTruncated: false,
      },
    );
    expect(loading.quality).toBe("partial");
    expect(loading.failure).toBe("none");
    expect(loading.diagnostics).toContain("document-still-loading");

    const visual = normalizeBrowserPageReadResult(
      { targetRole: "interactive" },
      {
        finalUrl: "https://example.test/canvas",
        title: "Canvas",
        readiness: "loading",
        extractionMs: 1,
        root: "body",
        blocks: [],
        totalCharacters: 0,
        totalCharactersCapped: false,
        iframeCount: 0,
        canvasCount: 1,
        virtualizedHint: false,
        boilerplateHint: false,
        challengeSignals: [],
        sourceTruncated: false,
      },
    );
    expect(visual.quality).toBe("visual-required");
    expect(visual.failure).toBe("visual-required");
    expect(visual.diagnostics).not.toContain("document-still-loading");
  });

  it("does not claim completeness for combined virtual, iframe, and canvas limits", () => {
    const result = normalizeBrowserPageReadResult(
      { targetRole: "interactive" },
      {
        finalUrl: "https://example.test/limited",
        title: "Limited",
        readiness: "complete",
        extractionMs: 1,
        root: "main",
        blocks: [{ kind: "paragraph", text: "Host content" }],
        totalCharacters: 12,
        totalCharactersCapped: false,
        iframeCount: 1,
        canvasCount: 1,
        virtualizedHint: true,
        boilerplateHint: false,
        challengeSignals: [],
        sourceTruncated: false,
      },
    );
    expect(result.quality).toBe("partial");
    expect(result.failure).toBe("virtualized");
    expect(result.diagnostics).toEqual([
      "virtualized-content-may-be-partial",
      "iframe-content-not-read",
      "canvas-content-not-textually-extracted",
    ]);
  });
});
