/** D504 Wave 1 — browser_read_page ToolCard projection tests. */

import "../bun-dom-preload";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup } from "@testing-library/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ToolRendererProps } from "../../src/components/tool-card/renderers/types";
import {
  browserReadPageRenderer,
  formatBrowserPageReadExtras,
  formatBrowserPageReadSummary,
  parseBrowserPageReadResult,
  parseBrowserPageSnapshotInspectionResult,
} from "../../src/components/tool-card/renderers/browser-read-page";
import { getToolRenderer } from "../../src/components/tool-card/renderers";

function pageResult(overrides: Record<string, unknown> = {}) {
  const content = typeof overrides.content === "string"
    ? overrides.content
    : "A useful paragraph.\n\nA second paragraph.";
  const totalCharacters = typeof overrides.totalCharacters === "number" ? overrides.totalCharacters : content.length;
  const nextOffsetCharacters = typeof overrides.nextOffsetCharacters === "number" ? overrides.nextOffsetCharacters : content.length;
  const eof = typeof overrides.eof === "boolean" ? overrides.eof : totalCharacters === nextOffsetCharacters;
  return {
    targetRole: "interactive",
    finalUrl: "https://example.test/article",
    title: "An example article",
    content,
    blocks: [{ kind: "paragraph", text: "A useful paragraph." }],
    totalCharacters,
    totalCharactersCapped: false,
    totalBytes: Buffer.byteLength(content, "utf8"),
    estimatedTokens: Math.ceil(totalCharacters / 4),
    offsetCharacters: 0,
    nextOffsetCharacters,
    returnedCharacters: content.length,
    remainingCharacters: totalCharacters - nextOffsetCharacters,
    eof,
    truncated: !eof,
    contextClamped: false,
    extraction: { method: "fixed-dom-semantic-v1", root: "article", iframeCount: 0 },
    timing: { readiness: "complete", extractionMs: 12, elapsedMs: 42 },
    quality: "complete",
    challenge: { detected: false, confidence: "none", signals: [] },
    failure: "none",
    diagnostics: [],
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
    root.render(<browserReadPageRenderer.ExpandedBody {...props} />);
  });
  return { container, root };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("browser_read_page renderer", () => {
  test("is registered and summarizes a successful bounded page result", () => {
    const raw = JSON.stringify(pageResult());
    expect(getToolRenderer("browser_read_page")).toBe(browserReadPageRenderer);
    expect(parseBrowserPageReadResult(raw)?.extraction.root).toBe("article");
    expect(formatBrowserPageReadSummary(raw)).toBe("Read page · An example article");
    expect(formatBrowserPageReadExtras(raw)).toBe("complete · 40 chars");
  });

  test("projects persisted legacy fixed-dom results into the readable ToolCard shape", async () => {
    const legacy = pageResult() as Record<string, unknown>;
    for (const key of [
      "totalBytes", "estimatedTokens", "offsetCharacters", "nextOffsetCharacters",
      "remainingCharacters", "eof", "contextClamped",
    ]) delete legacy[key];
    const raw = JSON.stringify(legacy);
    expect(parseBrowserPageReadResult(raw)).toMatchObject({
      extraction: { method: "fixed-dom-semantic-v1" },
      offsetCharacters: 0,
      nextOffsetCharacters: 40,
      eof: true,
    });
    const { container, root } = await renderExpanded(raw);
    expect(container.textContent).toContain("An example article");
    expect(container.textContent).toContain("A useful paragraph.");
    await act(async () => root.unmount());
  });

  test("renders title, final URL, readable text, extraction, and stable diagnostics", async () => {
    const raw = JSON.stringify(pageResult({
      truncated: true,
      totalCharacters: 200,
      quality: "partial",
      failure: "iframe-limited",
      extraction: { method: "fixed-dom-semantic-v1", root: "main", iframeCount: 2 },
      diagnostics: ["iframe-content-not-read", "returned-content-truncated"],
    }));
    const { container, root } = await renderExpanded(raw);

    expect(container.textContent).toContain("An example article");
    expect(container.querySelector('[data-testid="browser-read-page-final-url"]')?.textContent).toBe(
      "https://example.test/article",
    );
    expect(container.querySelector('[data-testid="browser-read-page-content"]')?.textContent).toContain(
      "A useful paragraph.",
    );
    expect(container.textContent).toContain("fixed-dom-semantic-v1 · root: main · 2 iframes");
    expect(container.textContent).toContain("Page content was truncated.");
    expect(container.textContent).toContain("iframe-content-not-read · returned-content-truncated");

    await act(async () => root.unmount());
  });

  test("keeps untrusted content as text and exposes no navigation or challenge controls", async () => {
    const raw = JSON.stringify(pageResult({
      content: '<script>window.pwned = true</script><a href="javascript:alert(1)">bad</a>',
      quality: "challenge",
      failure: "challenge",
      challenge: { detected: true, confidence: "heuristic", signals: ["turnstile"] },
      diagnostics: ["challenge-heuristic"],
    }));
    const { container, root } = await renderExpanded(raw);

    expect(container.querySelector("script, a, button, iframe")).toBeNull();
    expect(container.querySelector('[data-testid="browser-read-page-content"]')?.textContent).toContain(
      '<script>window.pwned = true</script>',
    );
    expect(container.textContent).toContain("A human-verification challenge was detected.");
    expect(container.textContent).toContain("Challenge detection is heuristic: turnstile");

    await act(async () => root.unmount());
  });

  test("shows extraction and opaque continuation state without rendering a page link", async () => {
    const raw = JSON.stringify(pageResult({
      totalCharacters: 200,
      nextOffsetCharacters: 40,
      eof: false,
      truncated: true,
      contextClamped: true,
      extraction: { method: "mozilla-readability-turndown-v1", root: "article", iframeCount: 0 },
      continuation: {
        version: 1,
        reference: "a".repeat(43),
        nextOffsetCharacters: 40,
        expiresAt: "2026-08-08T12:00:00.000Z",
      },
    }));
    const { container, root } = await renderExpanded(raw);
    expect(container.textContent).toContain("mozilla-readability-turndown-v1");
    expect(container.textContent).toContain("160 remaining");
    expect(container.querySelector('[data-testid="browser-read-page-continuation"]')).not.toBeNull();
    expect(container.querySelector("a")).toBeNull();
    await act(async () => root.unmount());
  });

  test("renders temporary page context and same-owner replacement without exposing opaque handles", async () => {
    const raw = JSON.stringify(pageResult({
      pageReference: { version: 1, reference: "p".repeat(43), expiresAt: "2026-08-10T12:00:00.000Z" },
      evictedPageReferences: [{ version: 1, reference: "e".repeat(43), title: "Earlier page", finalUrl: "https://example.test/earlier" }],
    }));
    const { container, root } = await renderExpanded(raw);
    expect(container.querySelector('[data-testid="browser-read-page-page-reference"]')?.textContent).toContain("Temporary page context available");
    expect(container.textContent).toContain("Earlier page");
    expect(container.textContent).not.toContain("p".repeat(43));
    expect(container.textContent).not.toContain("e".repeat(43));
    await act(async () => root.unmount());
  });

  test("rejects contradictory, unsafe, or impossible page-reference receipts", () => {
    const reference = "p".repeat(43);
    const pageReference = { version: 1, reference, expiresAt: "2026-08-10T12:00:00.000Z" };
    const continuation = { version: 1, reference, nextOffsetCharacters: 40, expiresAt: "2026-08-10T12:00:00.000Z" };
    const base = pageResult({ totalCharacters: 100, nextOffsetCharacters: 40, eof: false, truncated: true, pageReference, continuation });
    const malformed = [
      { ...base, continuation: { ...continuation, expiresAt: "2026-08-11T12:00:00.000Z" } },
      { ...base, pageReference: undefined, evictedPageReferences: [{ version: 1, reference: "e".repeat(43), title: "Earlier", finalUrl: "https://example.test/earlier" }] },
      { ...base, evictedPageReferences: [{ version: 1, reference, title: "Current", finalUrl: "https://example.test/current" }] },
      { ...base, evictedPageReferences: [{ version: 1, reference: "e".repeat(43), title: "x".repeat(513), finalUrl: "https://example.test/earlier" }] },
      { ...base, evictedPageReferences: [{ version: 1, reference: "e".repeat(43), title: "Earlier", finalUrl: "https://user:pass@example.test/earlier" }] },
      pageResult({ pageReference, content: "", returnedCharacters: 0, totalCharacters: 0, nextOffsetCharacters: 0, remainingCharacters: 0, eof: true, truncated: false }),
      pageResult({ pageReference, quality: "challenge", failure: "challenge", challenge: { detected: true, confidence: "heuristic", signals: ["captcha"] } }),
    ];
    for (const value of malformed) expect(parseBrowserPageReadResult(JSON.stringify(value))).toBeNull();
  });

  test("strictly projects bounded snapshot find/range content and rejects leaked or contradictory fields", async () => {
    const find = {
      version: 1, operation: "find", reference: "f".repeat(43), expiresAt: "2026-08-10T12:00:00.000Z",
      caseSensitive: false, totalMatches: 2, returnedMatches: 1, matchesOmitted: 1,
      matches: [{ offsetCharacters: 10, matchCharacters: 4, previewOffsetCharacters: 4, preview: "some test text", startsMidBlock: true, endsMidBlock: false, truncatedBlock: true }],
    };
    expect(parseBrowserPageSnapshotInspectionResult(JSON.stringify(find))?.operation).toBe("find");
    expect(parseBrowserPageSnapshotInspectionResult(JSON.stringify({ ...find, cdpUrl: "ws://private" }))).toBeNull();
    expect(parseBrowserPageSnapshotInspectionResult(JSON.stringify({ ...find, matchesOmitted: 0 }))).toBeNull();
    expect(parseBrowserPageSnapshotInspectionResult(JSON.stringify({ ...find, matches: [{ ...find.matches[0], truncatedBlock: false }] }))).toBeNull();
    expect(formatBrowserPageReadSummary(JSON.stringify(find))).toBe("Find page text · 2 matches (1 shown)");
    expect(formatBrowserPageReadExtras(JSON.stringify(find))).toBe("1 shown · 1 omitted");
    const range = {
      version: 1, operation: "range", reference: "q".repeat(43), expiresAt: "2026-08-10T12:00:00.000Z",
      offsetCharacters: 12, startOffsetCharacters: 5, endOffsetCharacters: 16, content: "hello world", startsMidBlock: true, endsMidBlock: false, truncatedBlock: true,
    };
    expect(formatBrowserPageReadSummary(JSON.stringify(range))).toBe("Expand page context · 5–16");
    expect(formatBrowserPageReadExtras(JSON.stringify(range))).toBe("around 12");
    const { container, root } = await renderExpanded(JSON.stringify(find));
    expect(container.querySelector('[data-testid="browser-read-page-find-preview"]')?.textContent).toContain("some test text");
    expect(container.textContent).not.toContain("f".repeat(43));
    await act(async () => root.unmount());
  });

  test("falls back safely for malformed or legacy output", async () => {
    const reference = "r".repeat(43);
    const raw = `{"content":"not a BrowserPageReadResult","reference":"${reference}"}`;
    expect(parseBrowserPageReadResult(raw)).toBeNull();
    expect(formatBrowserPageReadSummary(raw)).toBe("Read page");
    expect(formatBrowserPageReadExtras(raw)).toBeNull();
    const { container, root } = await renderExpanded(raw);

    expect(container.querySelector('[data-testid="browser-read-page-raw"]')?.textContent).toContain("not a BrowserPageReadResult");
    expect(container.textContent).not.toContain(reference);
    expect(container.textContent).toContain("[hidden]");
    await act(async () => root.unmount());
  });

  test("renders a valid dedicated ToolCard from a clipped lifecycle-event preview", async () => {
    const preview = "Visible semantic preview.";
    const raw = JSON.stringify(pageResult({
      content: preview,
      blocks: [],
      totalCharacters: 50_000,
      nextOffsetCharacters: 50_000,
      returnedCharacters: 50_000,
      remainingCharacters: 0,
      eof: true,
      truncated: false,
      eventProjection: {
        kind: "browser_read_page",
        totalContentCharacters: 50_000,
        shownContentCharacters: preview.length,
        totalBlocks: 75,
        shownBlocks: 0,
        contentTruncated: true,
        blocksTruncated: true,
        truncated: true,
      },
    }));

    expect(formatBrowserPageReadSummary(raw)).toBe("Read page · An example article");
    expect(formatBrowserPageReadExtras(raw)).toBe("complete · 50,000 chars");
    const { container, root } = await renderExpanded(raw, { resultTruncated: true });
    expect(container.querySelector('[data-testid="browser-read-page-renderer"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="browser-read-page-raw"]')).toBeNull();
    expect(container.textContent).toContain("50,000 returned of 50,000 characters");
    expect(container.textContent).toContain("ToolCard preview clipped; Genie received the full chunk.");
    expect(container.querySelector('[data-testid="browser-read-page-content"]')?.textContent).toContain(preview);
    await act(async () => root.unmount());
  });
});
