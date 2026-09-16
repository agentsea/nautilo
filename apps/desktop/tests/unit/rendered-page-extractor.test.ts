import { describe, expect, test } from "bun:test";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import {
  mozillaReadabilityTurndownExtractor,
  normalizeAgentBrowserAccessibilitySnapshot,
  parseAgentBrowserAccessibilitySnapshotEnvelope,
  RENDERED_PAGE_PRIMARY_METHOD,
  type RenderedPageSource,
} from "../../electron/rendered-page-extractor";
import {
  emptyRenderedPageFixture,
  generatedLongRenderedPageFixture,
  malformedRenderedPageFixture,
  renderedPageExtractorFixtures,
  type RenderedPageExtractorFixture,
} from "../fixtures/rendered-page-extractor-fixtures";

const BASE_URL = "https://example.test/guide";

const source = (html: string, overrides: Partial<RenderedPageSource> = {}): RenderedPageSource => ({
  html,
  finalUrl: BASE_URL,
  iframeCount: 0,
  virtualizedHint: false,
  ...overrides,
});

interface BenchmarkRead {
  content: string;
  title: string;
  failure: "none" | "empty" | "inadequate";
}

interface BenchmarkScore {
  primaryContentRetention: number;
  noiseExclusion: number;
  headings: boolean;
  links: boolean;
  tables: boolean;
  code: boolean;
  ordering: boolean;
  metadata: boolean;
  deterministic: boolean;
  runtimeMs: number;
  failureTruth: boolean;
}

const RELAY_CLEANUP_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "form",
  "button",
  "input",
  "select",
  "textarea",
  "nav",
  "header",
  "footer",
  "aside",
  "dialog",
  "[hidden]",
  '[aria-hidden="true"]',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="complementary"]',
  '[class*="cookie" i]',
  '[id*="cookie" i]',
  '[class*="consent" i]',
  '[id*="consent" i]',
  '[class*="advert" i]',
  '[id*="advert" i]',
  '[class*="newsletter" i]',
  '[id*="newsletter" i]',
  '[class*="navigation" i]',
  '[id*="navigation" i]',
];

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\u00a0/g, " ").replace(/[\t\r\n ]+/g, " ").trim();
}

function normalizeMarkdown(value: string): string {
  return value.replaceAll("\\_", "_");
}

function absoluteHttpLink(href: string): string {
  try {
    const url = new URL(href, BASE_URL);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

/**
 * Faithful test-only extraction of the existing fixed Relay program's semantic
 * behavior: article → main → body, its cleanup selectors, ordered readable
 * blocks, tables, and per-block links. This is intentionally not textContent.
 */
function fixedStructuralReader(html: string): BenchmarkRead {
  const { document } = parseHTML(html);
  const root = document.querySelector("article") ?? document.querySelector("main") ?? document.body;
  if (!root) return { content: "", title: "", failure: "empty" };

  const clone = root.cloneNode(true) as Element;
  for (const node of clone.querySelectorAll(RELAY_CLEANUP_SELECTORS.join(","))) node.remove();

  const blocks: string[] = [];
  for (const node of clone.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,table")) {
    if (node.tagName.toLowerCase() === "li" && node.parentElement?.closest("li")) continue;
    const text = node.tagName.toLowerCase() === "table"
      ? Array.from(node.querySelectorAll("tr"))
          .map((row) => Array.from(row.querySelectorAll("th,td")).map((cell) => cleanText(cell.textContent)).filter(Boolean).join(" | "))
          .filter(Boolean)
          .join("\n")
      : cleanText(node.textContent);
    if (!text) continue;
    const links = Array.from(node.querySelectorAll("a[href]"))
      .map((link) => ({ text: cleanText(link.textContent), href: absoluteHttpLink(link.getAttribute("href") ?? "") }))
      .filter((link) => link.text && link.href)
      .map((link) => ` [${link.text}](${link.href})`)
      .join("");
    blocks.push(`${text}${links}`);
  }
  if (!blocks.length) {
    const text = cleanText(clone.textContent);
    if (text) blocks.push(text);
  }
  const content = blocks.join("\n\n");
  return { content, title: cleanText(document.title), failure: content ? "none" : "empty" };
}

function primaryReader(fixture: RenderedPageExtractorFixture): BenchmarkRead {
  const extracted = mozillaReadabilityTurndownExtractor.extract(source(fixture.html, {
    iframeCount: fixture.iframeCount ?? 0,
    virtualizedHint: fixture.application === true,
  }));
  return {
    content: normalizeMarkdown(extracted.content),
    title: extracted.title ?? "",
    failure: extracted.content ? (extracted.needsAccessibilityFallback ? "inadequate" : "none") : "empty",
  };
}

async function defuddleReader(fixture: RenderedPageExtractorFixture): Promise<BenchmarkRead> {
  const { document } = parseHTML(fixture.html);
  const extracted = await Defuddle(document as unknown as Document, BASE_URL, { markdown: true, useAsync: false });
  const content = normalizeMarkdown(extracted.content);
  return { content, title: extracted.title, failure: content ? "none" : "empty" };
}

function featureScore(read: BenchmarkRead, fixture: RenderedPageExtractorFixture): Omit<BenchmarkScore, "deterministic" | "runtimeMs"> {
  const content = read.content;
  const expected = fixture.expected.filter((marker) => content.includes(marker)).length;
  const excluded = (fixture.excluded ?? []).filter((marker) => !content.includes(marker)).length;
  const first = content.indexOf(fixture.expected[0] ?? "");
  const last = content.indexOf(fixture.expected.at(-1) ?? "");
  return {
    primaryContentRetention: expected,
    noiseExclusion: excluded,
    headings: /(?:^|\n)#{1,6}\s|<h[1-6]\b/i.test(content) || /<h[1-6]\b/i.test(fixture.html) && content.includes(fixture.title ?? ""),
    links: !fixture.html.includes("<a ") || /\[[^\]]+\]\(https:\/\/example\.test\//.test(content),
    tables: !fixture.html.includes("<table") || content.includes("Key | Value") || content.includes("Switch | Weight"),
    code: !fixture.html.includes("<pre") || content.includes("const answer = 42"),
    ordering: first >= 0 && last >= first,
    metadata: fixture.title === undefined || read.title === fixture.title,
    failureTruth: fixture.accessibilityFallback ? read.failure === "inadequate" : read.failure === "none",
  };
}

function structuralScore(score: Omit<BenchmarkScore, "deterministic" | "runtimeMs">): number {
  return [
    score.headings,
    score.links,
    score.tables,
    score.code,
    score.ordering,
    score.metadata,
    score.failureTruth,
  ].filter(Boolean).length;
}

function measured<T>(read: () => T): { value: T; runtimeMs: number } {
  const started = performance.now();
  const value = read();
  return { value, runtimeMs: performance.now() - started };
}

async function measuredAsync<T>(read: () => Promise<T>): Promise<{ value: T; runtimeMs: number }> {
  const started = performance.now();
  const value = await read();
  return { value, runtimeMs: performance.now() - started };
}

describe("D504 1.4.1 rendered-page extractor corpus and selection", () => {
  test("benchmarks the fixed structural reader, Readability plus Turndown, and synchronous Defuddle across every representative fixture", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("extractors must not fetch");
    }) as typeof fetch;

    try {
      const aggregate = {
        fixed: { retention: 0, noise: 0, structure: 0 },
        primary: { retention: 0, noise: 0, structure: 0 },
        defuddle: { retention: 0, noise: 0, structure: 0 },
      };

      for (const fixture of renderedPageExtractorFixtures) {
        const fixed = measured(() => fixedStructuralReader(fixture.html));
        const primary = measured(() => primaryReader(fixture));
        const defuddle = await measuredAsync(() => defuddleReader(fixture));
        const readers = { fixed, primary, defuddle };

        for (const [name, result] of Object.entries(readers)) {
          const repeat = name === "fixed"
            ? fixedStructuralReader(fixture.html)
            : name === "primary"
              ? primaryReader(fixture)
              : await defuddleReader(fixture);
          const score: BenchmarkScore = {
            ...featureScore(result.value, fixture),
            deterministic: JSON.stringify(result.value) === JSON.stringify(repeat),
            runtimeMs: result.runtimeMs,
          };

          // Runtime is observed, never a flaky selection threshold. The score shape
          // makes retention/noise, structure, metadata, determinism, and truthful
          // application fallback explicit for every approach and every fixture.
          expect(Number.isFinite(score.runtimeMs)).toBe(true);
          expect(score.runtimeMs).toBeGreaterThanOrEqual(0);
          expect(score.deterministic).toBe(true);
          if (name === "primary") {
            expect(score.primaryContentRetention).toBe(fixture.expected.length);
            expect(score.noiseExclusion).toBe((fixture.excluded ?? []).length);
            expect(score.failureTruth).toBe(true);
          }
        }

        const fixedScore = featureScore(fixed.value, fixture);
        const primaryScore = featureScore(primary.value, fixture);
        const defuddleScore = featureScore(defuddle.value, fixture);
        aggregate.fixed.retention += fixedScore.primaryContentRetention;
        aggregate.fixed.noise += fixedScore.noiseExclusion;
        aggregate.fixed.structure += structuralScore(fixedScore);
        aggregate.primary.retention += primaryScore.primaryContentRetention;
        aggregate.primary.noise += primaryScore.noiseExclusion;
        aggregate.primary.structure += structuralScore(primaryScore);
        aggregate.defuddle.retention += defuddleScore.primaryContentRetention;
        aggregate.defuddle.noise += defuddleScore.noiseExclusion;
        aggregate.defuddle.structure += structuralScore(defuddleScore);
      }

      expect(fetchCalls).toBe(0);
      expect(aggregate.primary.retention).toBeGreaterThan(aggregate.fixed.retention);
      expect(aggregate.primary.noise).toBeGreaterThanOrEqual(aggregate.fixed.noise);
      const total = (score: { retention: number; noise: number; structure: number }): number =>
        score.retention + score.noise + score.structure;
      expect(total(aggregate.primary)).toBeGreaterThanOrEqual(total(aggregate.fixed));
      // Defuddle is a benchmark-only dev dependency unless it materially beats this
      // local production pair on the full scorecard; this corpus does not show that.
      expect(aggregate.defuddle.retention).toBeLessThanOrEqual(aggregate.primary.retention);
      expect(aggregate.defuddle.structure).toBeLessThanOrEqual(aggregate.primary.structure);
      expect(total(aggregate.defuddle)).toBeLessThan(total(aggregate.primary));
      expect(RENDERED_PAGE_PRIMARY_METHOD).toBe("mozilla-readability-turndown-v1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("documents the package-impact selection: local production pair, Defuddle dev-only", async () => {
    const packageJson = await Bun.file(new URL("../../package.json", import.meta.url)).json() as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(packageJson.dependencies).toMatchObject({
      "@mozilla/readability": "0.6.0",
      linkedom: "0.18.13",
      turndown: "7.2.4",
    });
    expect(packageJson.devDependencies).toMatchObject({ defuddle: "0.19.2" });
    expect(packageJson.dependencies["defuddle"]).toBeUndefined();
  });

  test("preserves long-page, malformed, empty, Unicode, title, and deterministic truth", () => {
    const longPage = mozillaReadabilityTurndownExtractor.extract(source(generatedLongRenderedPageFixture));
    expect(longPage.content.length).toBeGreaterThan(159_000);
    expect(normalizeMarkdown(longPage.content)).toContain("LONG_START_SENTINEL");
    expect(normalizeMarkdown(longPage.content)).toContain("LONG_MIDDLE_SENTINEL");
    expect(normalizeMarkdown(longPage.content)).toContain("LONG_END_SENTINEL");

    expect(mozillaReadabilityTurndownExtractor.extract(source(emptyRenderedPageFixture))).toMatchObject({
      content: "",
      needsAccessibilityFallback: true,
    });
    const first = mozillaReadabilityTurndownExtractor.extract(source(malformedRenderedPageFixture));
    expect(first).toEqual(mozillaReadabilityTurndownExtractor.extract(source(malformedRenderedPageFixture)));
    expect(first.needsAccessibilityFallback).toBe(true);
    expect(primaryReader(renderedPageExtractorFixtures.at(-1)!).title).toBe("日本語");
  });

  test("accepts agent-browser's real head-plus-body HTML serialization", () => {
    const extracted = mozillaReadabilityTurndownExtractor.extract(source(
      `<head><title>CLI shape</title></head><body><article><h1>CLI shape</h1><p>${"Rendered CLI content. ".repeat(20)}</p></article></body>`,
    ));
    expect(extracted).toMatchObject({
      method: RENDERED_PAGE_PRIMARY_METHOD,
      root: "article",
      title: "CLI shape",
      needsAccessibilityFallback: false,
    });
    expect(extracted.content).toContain("Rendered CLI content.");
  });
});

describe("agent-browser v0.31.1 accessibility snapshot fallback", () => {
  test("parses and normalizes the installed CLI's JSON and [ref=eN] snapshot shape", () => {
    const parsed = parseAgentBrowserAccessibilitySnapshotEnvelope({
      success: true,
      data: {
        origin: "https://example.test/search",
        refs: { e1: { name: "Search", role: "heading" }, e2: { name: "Result", role: "link" } },
        snapshot: "- main\n  - heading \"Search\" [level=1, ref=e1]\n  - link \"Result\" [ref=e2, url=https://example.test/result]",
      },
      error: null,
    });
    expect(parsed).toEqual({
      snapshot: "- main\n  - heading \"Search\" [level=1, ref=e1]\n  - link \"Result\" [ref=e2, url=https://example.test/result]",
      origin: "https://example.test/search",
      refs: 2,
    });
    expect(normalizeAgentBrowserAccessibilitySnapshot(parsed!).content).toBe(
      "- main\n- heading \"Search\" [level=1]\n- link \"Result\" [url=https://example.test/result]",
    );
  });

  test("rejects malformed, failed, and oversized snapshot envelopes", () => {
    expect(parseAgentBrowserAccessibilitySnapshotEnvelope({ success: false, data: { snapshot: "no" } })).toBeUndefined();
    expect(parseAgentBrowserAccessibilitySnapshotEnvelope({ success: true, data: { snapshot: 3 } })).toBeUndefined();
    expect(parseAgentBrowserAccessibilitySnapshotEnvelope({ success: true, data: { snapshot: "x".repeat(2_000_001) } })).toBeUndefined();
  });
});
