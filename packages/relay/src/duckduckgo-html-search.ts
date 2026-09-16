import { parseHTML } from "linkedom";

export const DUCKDUCKGO_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
export const DUCKDUCKGO_HTML_MAX_QUERY_CHARS = 512;
export const DUCKDUCKGO_HTML_MAX_RESULTS = 25;

const DEFAULT_MAX_RESULTS = 5;
const MAX_TITLE_CHARS = 512;
const MAX_SNIPPET_CHARS = 2_000;

export interface DuckDuckGoHtmlResultItem {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
}

export type DuckDuckGoHtmlSearchFailureKind =
  | "invalid_query"
  | "challenge"
  | "rate_limited"
  | "markup_drift"
  | "empty_parse"
  | "navigation_error"
  | "render_failed";

export type DuckDuckGoHtmlSearchOutcome =
  | { readonly ok: true; readonly items: readonly DuckDuckGoHtmlResultItem[] }
  | { readonly ok: false; readonly failure: DuckDuckGoHtmlSearchFailureKind };

interface SearchAnchor {
  getAttribute(name: string): string | null;
  textContent: string | null;
}

interface SearchRow {
  querySelector(selector: string): SearchAnchor | null;
}

interface SearchDocument {
  querySelector(selector: string): SearchAnchor | null;
  querySelectorAll(selector: string): Iterable<SearchRow>;
}

function clampResults(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_RESULTS;
  return Math.min(DUCKDUCKGO_HTML_MAX_RESULTS, Math.max(1, Math.floor(value as number)));
}

function collapseText(value: string | null | undefined, maxChars: number): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}…`;
}

function normalizeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function decodeDuckDuckGoRedirect(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value, DUCKDUCKGO_HTML_ENDPOINT);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if ((host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) && url.pathname === "/l/") {
    return url.searchParams.get("uddg") ?? undefined;
  }
  return value;
}

export function buildDuckDuckGoHtmlSearchUrl(query: string): string | undefined {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > DUCKDUCKGO_HTML_MAX_QUERY_CHARS) return undefined;
  const url = new URL(DUCKDUCKGO_HTML_ENDPOINT);
  url.searchParams.set("q", trimmed);
  url.searchParams.set("kl", "us-en");
  url.searchParams.set("kp", "1");
  return url.href;
}

/** Deterministic parser for rendered DuckDuckGo HTML. It performs no network I/O. */
export function parseDuckDuckGoHtmlResults(
  html: string,
  options: { readonly maxResults?: number } = {},
): DuckDuckGoHtmlSearchOutcome {
  const parsed = parseHTML(html) as unknown as { document: SearchDocument };
  const document = parsed.document;
  const rows = [...document.querySelectorAll(".result")];
  if (rows.length === 0 && /(?:captcha|verify\s+(?:you\s+are\s+)?human|unusual\s+traffic|robot\s+check)/i.test(html)) {
    return { ok: false, failure: "challenge" };
  }
  if (rows.length === 0 && /(?:too\s+many\s+requests|rate\s+limit|slow\s+down)/i.test(html)) {
    return { ok: false, failure: "rate_limited" };
  }

  const seen = new Set<string>();
  const items: DuckDuckGoHtmlResultItem[] = [];
  let recognizedResultLink = false;
  for (const row of rows) {
    const anchor = row.querySelector(".result__a");
    if (!anchor) continue;
    recognizedResultLink = true;
    const href = anchor.getAttribute("href");
    if (!href) continue;
    const decoded = decodeDuckDuckGoRedirect(href);
    const url = decoded ? normalizeHttpUrl(decoded) : undefined;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = collapseText(anchor.textContent, MAX_TITLE_CHARS);
    const snippet = collapseText(row.querySelector(".result__snippet")?.textContent, MAX_SNIPPET_CHARS);
    items.push({ url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}) });
    if (items.length === clampResults(options.maxResults)) break;
  }
  if (items.length > 0) return { ok: true, items };
  if (recognizedResultLink) return { ok: false, failure: "empty_parse" };
  if (document.querySelector(".no-results, .result--more") !== null) return { ok: true, items: [] };
  return { ok: false, failure: "markup_drift" };
}
