/**
 * D121 P4 trade-off: DOMPurify is intentionally omitted for v1; iframe sandbox
 * plus CSP are the primary perimeter. If we add sanitization later, wire it
 * immediately before `buildSrcdoc` returns.
 */
function escapeHtmlAttributeValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function escapeInlineModuleSource(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

function runtimeScriptTag(runtime: string): string {
  const body = escapeInlineModuleSource(runtime);
  // "</script>" inside this template literal must be escaped so that
  // when the wrapping document (which is itself a string literal sent
  // through srcdoc) is later inlined back into another <script> block
  // the inner closing tag doesn't prematurely terminate the outer one.
  // eslint-disable-next-line no-useless-escape
  return `<script type="module">${body}<\/script>`;
}

/**
 * P4.7 default theme block. Injected BEFORE any user `<head>` content so
 * authored `<style>` rules win (later same-specificity selectors override
 * earlier). Targets only `html, body` — never anything inside — so `<nw-*>`
 * Lit components and authored content render unchanged. Prevents the dark-
 * theme-bleed-through that made Jeannie's first authored artifact look
 * empty on a dark workbench (2026-05-13 live verification).
 */
const DEFAULT_BODY_THEME =
  `<style>html,body{background:#ffffff;color:#0f172a;margin:0;}` +
  `body{padding:1rem 1.25rem;` +
  `font:14px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}` +
  `</style>`;

/**
 * Wrap artifact HTML for iframe `srcDoc` and inject CSP + optional Lit runtime.
 *
 * @param htmlContent - body fragment or full HTML document string
 * @param csp - full Content-Security-Policy value for the meta tag
 * @param runtime - optional bundled ESM source inlined as a module script
 *
 * Implementation note (load-bearing): the `.replace()` calls below MUST use
 * a function replacement, never a string replacement. `headInjection`
 * contains the inlined Lit runtime, whose minified source includes
 * sequences like `lit$${…}$\`` (Lit template-literal markers + the closing
 * backtick of a template). If passed as a string replacement, `String.prototype.replace`
 * interprets the embedded `$$` as a literal `$` AND — far more lethally —
 * interprets the `` $` `` sequence as the special "portion of the string
 * before the match" pattern, splicing the artifact's pre-match prefix
 * (e.g. `<!doctype html>\n`) into the middle of the Lit bundle.
 * The result is a parse-time SyntaxError in the iframe and the
 * `<nw-*>` runtime never registers. A function replacement bypasses
 * all special-pattern processing.
 */
export function buildSrcdoc(
  htmlContent: string,
  csp: string,
  runtime?: string,
  trustedScripts: string[] = [],
): string {
  const trimmed = htmlContent.trim();
  const lower = trimmed.toLowerCase();
  const isFullDocument =
    lower.startsWith("<!doctype html") || lower.startsWith("<html");

  const cspAttr = escapeHtmlAttributeValue(csp);
  const extraScripts = trustedScripts.filter((script) => script.length > 0);
  const headInjection = [
    `<meta charset="utf-8">`,
    `<meta http-equiv="Content-Security-Policy" content="${cspAttr}">`,
    DEFAULT_BODY_THEME,
    ...(runtime && runtime.length > 0 ? [runtimeScriptTag(runtime)] : []),
    ...extraScripts.map((script) => runtimeScriptTag(script)),
  ].join("");

  if (!isFullDocument) {
    return `<!doctype html><html><head>${headInjection}</head><body>${htmlContent}</body></html>`;
  }

  if (/<head[^>]*>/i.test(trimmed)) {
    return trimmed.replace(
      /<head([^>]*)>/i,
      (_match, attrs: string) => `<head${attrs}>${headInjection}`,
    );
  }

  if (/<html[^>]*>/i.test(trimmed)) {
    return trimmed.replace(
      /<html([^>]*)>/i,
      (_match, attrs: string) =>
        `<html${attrs}><head>${headInjection}</head>`,
    );
  }

  return `<!doctype html><html><head>${headInjection}</head><body>${trimmed}</body></html>`;
}
