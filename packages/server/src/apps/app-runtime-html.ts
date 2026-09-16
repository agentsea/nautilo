const MINI_APP_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  // Desktop's owner-bound, revocable proxy capability. Possessing the scheme
  // alone grants nothing; main process validates the random token and the
  // requesting WebContents before serving bounded MP4 bytes.
  "media-src nautilo-media:",
  "font-src data:",
  "connect-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const DEFAULT_BODY_THEME =
  `<style>html,body{background:#ffffff;color:#0f172a;margin:0;}` +
  `body{padding:1rem 1.25rem;` +
  `font:14px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}` +
  `</style>`;

function escapeHtmlAttributeValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function escapeInlineScriptSource(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

function escapeInlineStyleSource(source: string): string {
  return source.replace(/<\/style/gi, "<\\/style");
}

function runtimeScriptTag(runtime: string): string {
  const body = escapeInlineScriptSource(runtime);
  // eslint-disable-next-line no-useless-escape
  return `<script type="module">${body}<\/script>`;
}

function inlineStyleTag(css: string): string {
  return `<style>${escapeInlineStyleSource(css)}</style>`;
}

function bridgeBootstrapScript(appId: string): string {
  const escapedAppId = JSON.stringify(appId);
  const source = `window.nautiloApp=Object.freeze({version:1,appId:${escapedAppId}});`;
  // eslint-disable-next-line no-useless-escape
  return `<script>${escapeInlineScriptSource(source)}<\/script>`;
}

export interface MiniAppRuntimeHtmlInput {
  appId: string;
  html: string;
  styles: Array<{ path: string; content: string }>;
  bundleJs: string;
}

export function buildMiniAppRuntimeSrcDoc(input: MiniAppRuntimeHtmlInput): string {
  const trimmed = input.html.trim();
  const lower = trimmed.toLowerCase();
  const isFullDocument =
    lower.startsWith("<!doctype html") || lower.startsWith("<html");

  // Video consumes only host-issued local media capabilities. Workspace
  // and Current Folder previews use the owner-bound Desktop scheme; derived
  // visuals may use blobs. Neither grants arbitrary network or file access.
  const csp = input.appId === "nautilo-video"
    ? MINI_APP_CSP.replace("media-src nautilo-media:", "media-src nautilo-media: blob:")
      .replace("img-src data: blob:", "img-src data: blob: nautilo-media:")
      .replace("connect-src 'none'", "connect-src nautilo-media: blob:")
    : MINI_APP_CSP;
  const cspAttr = escapeHtmlAttributeValue(csp);
  const styleInjection = input.styles.map((style) => inlineStyleTag(style.content)).join("");
  const headInjection = [
    `<meta charset="utf-8">`,
    `<meta http-equiv="Content-Security-Policy" content="${cspAttr}">`,
    DEFAULT_BODY_THEME,
    styleInjection,
    bridgeBootstrapScript(input.appId),
    runtimeScriptTag(input.bundleJs),
  ].join("");

  if (!isFullDocument) {
    return `<!doctype html><html><head>${headInjection}</head><body>${input.html}</body></html>`;
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
      (_match, attrs: string) => `<html${attrs}><head>${headInjection}</head>`,
    );
  }

  return `<!doctype html><html><head>${headInjection}</head><body>${trimmed}</body></html>`;
}
