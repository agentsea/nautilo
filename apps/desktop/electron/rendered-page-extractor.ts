/** D504 Unit 1 — deterministic, local rendered-page extraction for Electron. */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

export const RENDERED_PAGE_PRIMARY_METHOD = "mozilla-readability-turndown-v1" as const;
export const RENDERED_PAGE_ACCESSIBILITY_METHOD = "agent-browser-accessibility-snapshot-v1" as const;

export type RenderedPageExtractionMethod =
  | typeof RENDERED_PAGE_PRIMARY_METHOD
  | typeof RENDERED_PAGE_ACCESSIBILITY_METHOD;

/** Already-rendered, fixed-session input. This contract deliberately has no response limit or JS field. */
export interface RenderedPageSource {
  html: string;
  finalUrl: string;
  iframeCount: number;
  virtualizedHint: boolean;
}

export interface RenderedPageExtraction {
  method: RenderedPageExtractionMethod;
  content: string;
  root: "article" | "none";
  title?: string;
  needsAccessibilityFallback: boolean;
  diagnostics: readonly string[];
}

export interface RenderedPageExtractor {
  extract(source: RenderedPageSource): RenderedPageExtraction;
}

export interface AgentBrowserAccessibilitySnapshot {
  snapshot: string;
  origin?: string;
  refs?: number;
}

const ACCESSIBILITY_SHORT_ARTICLE_CHARS = 320;
const MAX_ACCESSIBILITY_SNAPSHOT_CHARS = 2_000_000;
const NON_CONTENT_SELECTORS = [
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
].join(",");

function normalizeMarkdown(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeMarkdownLinks(markdown: string, baseUrl: string): string {
  return markdown.replace(/\[([^\]]*)\]\((?:<)?([^\s)>]+)(?:>)?\)/g, (_whole, text: string, href: string) => {
    try {
      const parsed = new URL(href, baseUrl);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? `[${text}](${parsed.href})` : text;
    } catch {
      return text;
    }
  });
}

function tableMarkdown(node: unknown): string {
  const table = node as { querySelectorAll(selector: string): ArrayLike<{ querySelectorAll(selector: string): ArrayLike<{ textContent: string | null }> }> };
  const rows = Array.from(table.querySelectorAll("tr"))
    .map((row) => Array.from(row.querySelectorAll("th,td"))
      .map((cell) => (cell.textContent ?? "").replace(/[\t\r\n ]+/g, " ").trim().replaceAll("|", "\\|"))
      .filter(Boolean))
    .filter((cells) => cells.length > 0);
  if (rows.length === 0) return "\n\n";
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array.from({ length: width - row.length }, () => "")]);
  const [header, ...body] = normalized;
  if (!header) return "\n\n";
  return `\n\n| ${header.join(" | ")} |\n| ${header.map(() => "---").join(" | ")} |${body.map((row) => `\n| ${row.join(" | ")} |`).join("")}\n\n`;
}

function createTurndown(): TurndownService {
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "_" });
  turndown.addRule("nautilo-table", { filter: "table", replacement: (_content, node) => tableMarkdown(node) });
  return turndown;
}

/** Keep Readability's scoring while applying the existing fixed reader's deterministic chrome cleanup. */
type ReadabilityDomDocument = Document & {
  querySelectorAll(selector: string): ArrayLike<{ remove(): void }>;
};

function cleanDocumentForReadability(document: ReadabilityDomDocument): void {
  for (const node of Array.from(document.querySelectorAll(NON_CONTENT_SELECTORS))) node.remove();
}

function looksLikeAnApplicationSurface(source: RenderedPageSource): boolean {
  return source.iframeCount > 0
    || source.virtualizedHint
    || /\brole\s*=\s*["'](?:application|search|grid|treegrid|listbox)["']/i.test(source.html)
    || /\bcontenteditable\b/i.test(source.html);
}

function inaccessibleResult(diagnostic: string): RenderedPageExtraction {
  return { method: RENDERED_PAGE_PRIMARY_METHOD, content: "", root: "none", needsAccessibilityFallback: true, diagnostics: [diagnostic] };
}

/** agent-browser `get html html` serializes the root as head+body, without an html wrapper. */
function documentHtmlForParsing(html: string): string {
  return /<html\b/i.test(html) ? html : `<!doctype html><html>${html}</html>`;
}

/**
 * The selected production extractor. It makes no requests and has no caller-controlled
 * options: it operates only on HTML obtained from agent-browser's exact selected session.
 */
export const mozillaReadabilityTurndownExtractor: RenderedPageExtractor = {
  extract(source) {
    if (!source.html.trim()) return inaccessibleResult("rendered-html-empty");
    try {
      const { document } = parseHTML(documentHtmlForParsing(source.html)) as unknown as { document: Document };
      cleanDocumentForReadability(document as ReadabilityDomDocument);
      const article = new Readability(document as unknown as Document, { charThreshold: 0 }).parse();
      if (!article?.content) return inaccessibleResult("readability-no-article");
      const content = safeMarkdownLinks(normalizeMarkdown(createTurndown().turndown(article.content)), source.finalUrl);
      if (!content) return inaccessibleResult("readability-empty-article");
      const applicationFallback = looksLikeAnApplicationSurface(source) && content.length < ACCESSIBILITY_SHORT_ARTICLE_CHARS;
      return {
        method: RENDERED_PAGE_PRIMARY_METHOD,
        content,
        root: "article",
        ...(article.title ? { title: article.title } : {}),
        needsAccessibilityFallback: applicationFallback,
        diagnostics: applicationFallback ? ["article-inadequate-for-application-surface"] : [],
      };
    } catch {
      return inaccessibleResult("readability-extraction-failed");
    }
  },
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Strictly accepts the v0.31.1 `agent-browser --json snapshot` envelope.
 * The installed CLI returns `data.snapshot` plus an eN-keyed `data.refs` map;
 * its human snapshot annotates nodes as `[ref=eN]` (not `@eN`).
 */
export function parseAgentBrowserAccessibilitySnapshotEnvelope(value: unknown): AgentBrowserAccessibilitySnapshot | undefined {
  const envelope = record(value);
  if (!envelope || envelope["success"] !== true) return undefined;
  const data = record(envelope["data"]);
  if (!data || typeof data["snapshot"] !== "string" || data["snapshot"].length > MAX_ACCESSIBILITY_SNAPSHOT_CHARS) return undefined;
  if (data["origin"] !== undefined && typeof data["origin"] !== "string") return undefined;
  if (data["refs"] !== undefined && !Array.isArray(data["refs"]) && typeof data["refs"] !== "object") return undefined;
  const refs = data["refs"];
  const refCount = Array.isArray(refs) ? refs.length : refs ? Object.keys(refs).length : 0;
  return {
    snapshot: data["snapshot"],
    ...(typeof data["origin"] === "string" ? { origin: data["origin"] } : {}),
    ...(refCount ? { refs: refCount } : {}),
  };
}

/** Converts fixed v0.31.1 accessibility text to inert, stable fallback content; no dispatch is wired here. */
export function normalizeAgentBrowserAccessibilitySnapshot(snapshot: AgentBrowserAccessibilitySnapshot): RenderedPageExtraction {
  const content = snapshot.snapshot
    .split("\n")
    .map((line) => line
      .replace(/,\s*ref=e\d+(?=\])/g, "")
      .replace(/\[ref=e\d+,\s*/g, "[")
      .replace(/\s+\[ref=e\d+\]/g, "")
      .replace(/\s+/g, " ")
      .trim())
    .filter(Boolean)
    .join("\n");
  return {
    method: RENDERED_PAGE_ACCESSIBILITY_METHOD,
    content,
    root: "none",
    needsAccessibilityFallback: false,
    diagnostics: ["accessibility-snapshot-fallback", ...(snapshot.refs ? ["accessibility-refs-stripped"] : [])],
  };
}
