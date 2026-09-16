/**
 * Hostnames for third-party script/image loads inside the sandboxed HTML
 * viewer (KaTeX, Mermaid, Observable Plot / D3, model-viewer / Three.js,
 * Reveal.js, Shiki web builds). P5 (`<nw-*>` runtime) extends this array
 * in one place when components add new CDN dependencies.
 *
 * CSP source expressions use https://<host> (scheme required for clarity).
 */
export const HTML_VIEWER_CDN_HOSTS = [
  "cdn.jsdelivr.net",
  "unpkg.com",
  "esm.sh",
  "cdnjs.cloudflare.com",
  "d3js.org",
  "ajax.googleapis.com",
] as const;

function cdnSources(): string {
  return HTML_VIEWER_CDN_HOSTS.map((h) => `https://${h}`).join(" ");
}

/**
 * Single source of truth for the iframe srcDoc CSP (v1). Injected via
 * `<meta http-equiv="Content-Security-Policy" content="...">` in `srcdoc.ts`.
 */
export function buildCsp(): string {
  const cdns = cdnSources();
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${cdns}`,
    "style-src 'unsafe-inline'",
    `img-src data: blob: ${cdns}`,
    "font-src data:",
    "connect-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}
