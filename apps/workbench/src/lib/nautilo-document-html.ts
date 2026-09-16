import type { MiniAppContentAssociationDto } from "@nautilo/api-client/browser";

const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function hasUnsafeObjectKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasUnsafeObjectKey);
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) return true;
    if (hasUnsafeObjectKey(nested)) return true;
  }
  return false;
}

function parseJsonScript(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (hasUnsafeObjectKey(parsed)) return null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function extractWithDomParser(html: string, scriptId: string, scriptType: string): string | null {
  const Parser = globalThis.DOMParser;
  if (typeof Parser !== "function") return null;
  const doc = new Parser().parseFromString(html, "text/html");
  const script = doc.querySelector(
    `script#${scriptId}[type="${scriptType}"]`,
  );
  return script?.textContent?.trim() ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractWithFallback(html: string, scriptId: string, scriptType: string): string | null {
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  const scriptIdPattern = escapeRegExp(scriptId);
  const scriptTypePattern = escapeRegExp(scriptType);
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    const attrs = match[1] ?? "";
    if (!new RegExp(`\\bid\\s*=\\s*["']${scriptIdPattern}["']`, "i").test(attrs)) continue;
    if (!new RegExp(`\\btype\\s*=\\s*["']${scriptTypePattern}["']`, "i").test(attrs)) continue;
    return (match[2] ?? "").trim();
  }
  return null;
}

export function extractHtmlJsonScript(
  html: string,
  scriptId: string,
  scriptType: string,
): Record<string, unknown> | null {
  const raw = extractWithDomParser(html, scriptId, scriptType) ?? extractWithFallback(html, scriptId, scriptType);
  return raw ? parseJsonScript(raw) : null;
}

function matchesDeclaredFields(
  record: Record<string, unknown>,
  expected: Record<string, string | number | boolean | null>,
): boolean {
  for (const [key, value] of Object.entries(expected)) {
    if (record[key] !== value) return false;
  }
  return true;
}

export function htmlMatchesContentAssociation(
  html: string,
  association: MiniAppContentAssociationDto,
): boolean {
  if (association.kind !== "html-script-json") return false;
  const script = extractHtmlJsonScript(html, association.scriptId, association.scriptType);
  return script !== null && matchesDeclaredFields(script, association.match);
}

/** The `<script>` envelope every native Nautilo document embeds its manifest in. */
const NAUTILO_DOCUMENT_MANIFEST_SCRIPT_ID = "manifest";
const NAUTILO_DOCUMENT_MANIFEST_SCRIPT_TYPE = "application/vnd.nautilo.document+json";

/**
 * True when the HTML carries a native Nautilo document manifest (regardless of
 * which app owns it). D390: for such docs the embedded manifest is the routing
 * source of truth, so a bare `.html`/`text/html` extension claim must be
 * suppressed in favor of content (format-identity) associations.
 */
export function hasNautiloDocumentManifest(html: string): boolean {
  return (
    extractHtmlJsonScript(
      html,
      NAUTILO_DOCUMENT_MANIFEST_SCRIPT_ID,
      NAUTILO_DOCUMENT_MANIFEST_SCRIPT_TYPE,
    ) !== null
  );
}
