import { safeDocumentLink } from "@nautilo/writer-proposal-core";

export function documentNavigation(url: string): { kind: "internal" } | { kind: "confirm"; url: string } | { kind: "blocked" } {
  if (url === "about:blank" || url.startsWith("about:blank#") || url.startsWith("#")) return { kind: "internal" };
  const safe = safeDocumentLink(url);
  return safe ? { kind: "confirm", url: safe } : { kind: "blocked" };
}
