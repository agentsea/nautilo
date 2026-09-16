export const DEFAULT_SEARCH_TEMPLATE = "https://duckduckgo.com/?q=";

export interface ResolvedAddress {
  kind: "url" | "search";
  url: string;
}

const EXPLICIT_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const ABOUT_SCHEME_RE = /^about:/i;
const LOCALHOST_RE = /^localhost(:\d+)?(\/.*)?$/i;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/;

function hasExplicitScheme(input: string): boolean {
  return EXPLICIT_SCHEME_RE.test(input) || ABOUT_SCHEME_RE.test(input);
}

function looksLikeDomain(hostPart: string): boolean {
  if (!hostPart.includes(".")) {
    return false;
  }
  const tld = hostPart.slice(hostPart.lastIndexOf(".") + 1);
  return /^[a-z0-9]{2,}$/i.test(tld);
}

export function buildSearchUrl(
  query: string,
  searchTemplate = DEFAULT_SEARCH_TEMPLATE,
): string {
  return searchTemplate + encodeURIComponent(query);
}

export function resolveAddressInput(
  raw: string,
  searchTemplate?: string,
): ResolvedAddress {
  const trimmed = raw.trim();
  const template = searchTemplate ?? DEFAULT_SEARCH_TEMPLATE;

  if (trimmed === "") {
    return { kind: "search", url: buildSearchUrl("", template) };
  }

  if (hasExplicitScheme(trimmed)) {
    return { kind: "url", url: trimmed };
  }

  if (/\s/.test(trimmed)) {
    return { kind: "search", url: buildSearchUrl(trimmed, template) };
  }

  if (LOCALHOST_RE.test(trimmed)) {
    return { kind: "url", url: `http://${trimmed}` };
  }

  if (IPV4_RE.test(trimmed)) {
    return { kind: "url", url: `https://${trimmed}` };
  }

  const hostPart = trimmed.split("/")[0] ?? trimmed;
  if (looksLikeDomain(hostPart)) {
    return { kind: "url", url: `https://${trimmed}` };
  }

  return { kind: "search", url: buildSearchUrl(trimmed, template) };
}
