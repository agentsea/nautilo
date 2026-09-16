/**
 * D362 Phase 3 §3.1b — same-origin reverse proxy for Collabora coolwsd.
 *
 * Mounts coolwsd under the Nautilo server origin at `/office-engine/*` so the
 * editor `<iframe>` loaded by the workbench becomes same-origin with the
 * Nautilo server, unlocking DOM/CSS control over the editor chrome that a
 * cross-origin iframe forbids.
 *
 * Topology (Collabora's documented reverse-proxy pattern):
 *   - coolwsd is configured with `--o:net.service_root=/office-engine` so it
 *     serves assets + emits internal URLs under that root.
 *   - The Nautilo server proxies HTTP (GET/POST/HEAD) and WebSocket upgrades
 *     under `/office-engine/*` to the engine at 127.0.0.1:<collaboraHostPort>.
 *     The `/office-engine` prefix is preserved on the upstream path so
 *     coolwsd's service-root routing matches.
 *   - The browser loads `cool.html` via the same-origin proxied URL minted by
 *     `routes/wopi.ts` (see the `editorUrl` assembly there).
 *
 * Auth: the `/office-engine/*` prefix bypasses user-session auth in
 * `app.ts`'s trust preHandler (engine assets + WS aren't user-session-
 * authed). Document access stays gated by the WOPI `access_token` validated
 * inside the `/wopi/*` routes — the proxy never authorizes a doc open.
 *
 * Streaming: request bodies and upstream response bodies are streamed
 * end-to-end (fetch `duplex:"half"` for the request, `node:stream/promises`
 * `pipeline` for the response) so large coolwsd asset bundles (tile sheets,
 * wasm, fonts) never buffer in server memory.
 *
 * Phase 5: a hardened deploy may prefer nginx/Caddy in front of coolwsd for
 * TLS termination, header hardening, rate limiting, and a tight
 * `frame_ancestors` list. This in-process proxy is the dev / single-box
 * self-host path.
 */

import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { BodyInit } from "bun";
import { WebSocket, type RawData } from "ws";
import { resolveInstance, collaboraHostPort } from "@nautilo/config";
import { warn } from "@nautilo/logger";

/** Reverse-proxy prefix. coolwsd's `--o:net.service_root` mirrors this. */
export const OFFICE_PROXY_PREFIX = "/office-engine";

/** Hop-by-hop headers per RFC 7230 §6.1 — must not be re-forwarded. */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

const OFFICE_STRIP_CSS_PATH = `${OFFICE_PROXY_PREFIX}/nw-strip.css`;
const OFFICE_PROXY_ASSET_CACHE_BUSTER = "nwproxy=1";
const OFFICE_STRIP_CSS = `
#toolbar-wrapper, #toolbar-row, #toolbar-up, #toolbar-up-more,
#toolbar-down, .statusbar,
#formulabar, #formulabar-row, #spreadsheet-toolbar,
.notebookbar-shortcuts-bar,
.iframe-welcome-wrap, .iframe-welcome-content, .iframe-welcome-modal,
.iframe-welcome-modal-container, #iframe-welcome-modal,
.welcome, .welcome-dialog-container,
#navigator-floating-icon, .navigator-btn-wrapper, #floating-navigator,
/* Impress: hide Collabora's whole native slide navigator (the "Navigation"
   panel = header + #slide-sorter thumbnails + #presentation-toolbar). We render
   our own on-brand slide rail (ImpressSlideRail) with live getPreview
   thumbnails + our Present ribbon controls, so this duplicate is redundant.
   It is a single <nav> wrapping all the duplicate bits — one clean hide. */
#navigation-sidebar,
.leaflet-popup, .leaflet-tooltip,
#mobile-wizard, #mobile-wizard-tabs, #mobile-wizard-content,
[id*="mobile-wizard"], [class*="mobile-wizard"],
[id*="floating-toolbar"], [class*="floating-toolbar"],
[id*="context-toolbar"], [class*="context-toolbar"],
.vex, .vex-content,
.leaflet-control-zoom {
  display: none !important;
}
/* NOTE: do NOT hide .ui-dialog / .jsdialog — those carry FUNCTIONAL Collabora
   dialogs (Delete Contents, Format Cells, Insert Special Char, …). Hiding them
   left users with an invisible stuck modal (e.g. Calc's Delete key opens the
   "Delete Contents" prompt). The welcome splash is hidden via .iframe-welcome-*
   above + dismissed via the welcome-close postMessage, so functional dialogs
   can render without the splash returning. */
#map, .leaflet-container, #document-container, #main-document-content {
  inset: 0 !important;
}
`;

/**
 * Base HTTP URL of the Collabora engine the SERVER talks to (proxy upstream).
 *
 * M201 R1 — topology-aware. Honors `NAUTILO_COLLABORA_ENGINE_URL` so a
 * containerized deploy (DO droplet behind Caddy) can point the server at the
 * engine over the compose bridge network (`http://collabora:9980`). When the
 * var is unset it falls back to today's dev value — the localhost-published
 * port derived from `collaboraHostPort(resolveInstance())` — so
 * `bun run dev-stack` behaves identically. Mirrors the sibling nwuno
 * engine's `NAUTILO_OFFICE_URL` override. Trailing slash is stripped so URL
 * concatenation with `request.url` (which starts with `/`) never doubles it.
 */
export function collaboraEngineHttpUrl(): string {
  return (
    process.env["NAUTILO_COLLABORA_ENGINE_URL"] ??
    `http://127.0.0.1:${collaboraHostPort(resolveInstance())}`
  ).replace(/\/$/, "");
}

/** Upstream origin the proxy forwards HTTP to (server → engine). */
export function collaboraUpstreamOrigin(): string {
  return collaboraEngineHttpUrl();
}

/** Upstream WS origin (http→ws, https→wss) derived from the engine URL. */
export function collaboraUpstreamWsOrigin(): string {
  const http = collaboraEngineHttpUrl();
  return http.startsWith("https://")
    ? "wss://" + http.slice("https://".length)
    : "ws://" + http.slice("http://".length);
}

/**
 * M201 R3 — coolwsd's admin console + admin websocket must NEVER be reachable
 * through the un-authed `/office-engine/*` proxy. Collabora docs are
 * inconsistent about the admin-WS path (master `README.md` says `/adminws/`,
 * shipped nginx/Apache templates route `/cool/adminws`), so we block the
 * `adminws` segment ANYWHERE plus the admin console HTML under any prefix.
 * `enginePath` is the path with the `/office-engine` prefix already stripped.
 */
export function isCoolwsdAdminPath(enginePath: string): boolean {
  return /(^\/admin(\/|$)|^\/browser\/dist\/admin|(^|\/)adminws)/i.test(enginePath);
}

/**
 * M201 — `cache-control` for a proxied engine response.
 *
 * coolwsd's build assets under `/office-engine/browser/<hash>/…` are
 * content-hashed + immutable (the `<hash>` changes on every coolwsd version),
 * so they're safe to cache for a year — this is what makes the SECOND doc open
 * load them from disk (0 bytes over the network) instead of re-downloading the
 * multi-MB bundle every time. `cool.html` (the dynamic entry doc) and every
 * non-`/browser/` path (WS, discovery, WOPI-ish endpoints) stay `no-store`.
 */
export function engineAssetCacheControl(requestPath: string): string {
  if (
    requestPath.startsWith(`${OFFICE_PROXY_PREFIX}/browser/`) &&
    !requestPath.endsWith("/cool.html")
  ) {
    return "public, max-age=31536000, immutable";
  }
  return "no-store";
}

/** M201 — CSP response headers stripped from proxied engine responses. */
export function isCspHeader(headerNameLower: string): boolean {
  return (
    headerNameLower === "content-security-policy" ||
    headerNameLower === "content-security-policy-report-only"
  );
}

/**
 * M201 — remove any `<meta http-equiv="content-security-policy" ...>` (and the
 * report-only variant) from proxied engine HTML. coolwsd's editor UI must run
 * its inline bootstrap same-origin under our origin; its own CSP would block
 * that. Attribute order varies, so match `http-equiv` + the CSP token
 * independently within a single `<meta …>` tag.
 */
export function stripCspMetaTags(html: string): string {
  return html.replace(/<meta\b[^>]*>/gi, (tag) =>
    /http-equiv\s*=\s*["']?\s*content-security-policy(-report-only)?\s*["']?/i.test(tag)
      ? ""
      : tag,
  );
}

/**
 * Resolve the Origin header to send on the upstream WebSocket upgrade.
 *
 * coolwsd validates the WebSocket `Origin` header and rejects upgrades whose
 * origin isn't on its allow-list. The browser-sent `Origin` (same-origin, since
 * the proxy mounts under `/office-engine/*` on the Nautilo origin) must be
 * forwarded verbatim; only when the client omitted `Origin` do we synthesize
 * one from the local server port.
 *
 * Exposed for a focused unit test — the WS upgrade path itself is hard to
 * exercise with mocks (it needs a real socket pair), so the contract is
 * asserted on this pure helper instead.
 */
export function resolveUpstreamWsOrigin(headers: {
  origin?: string | undefined;
}): string {
  const origin = headers.origin;
  if (typeof origin === "string" && origin.length > 0) return origin;
  return `http://127.0.0.1:${resolveInstance().server.port}`;
}

/**
 * Strip hop-by-hop + size-derivable headers from the inbound set so the
 * upstream request is well-formed. `host` is dropped so fetch sets it from
 * the upstream URL; `content-length` is dropped so fetch recomputes it
 * from the actual body (which may be re-encoded for parsed-body cases).
 */
function forwardableHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === "host") continue;
    if (lower === "content-length") continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

interface ProxyBody {
  body: BodyInit | undefined;
  duplex?: "half";
}

/**
 * Convert the (possibly fastify-parsed) request body into a fetch body.
 * `application/octet-stream` arrives as a Buffer (wopi.ts's parser),
 * `application/json` / `text/plain` as object / string (fastify defaults),
 * and any other content type as a raw stream (our scoped catch-all parser
 * below). All four paths are handled; the stream path uses `duplex:"half"`.
 */
function resolveFetchBody(request: FastifyRequest): ProxyBody {
  if (request.method === "GET" || request.method === "HEAD") {
    return { body: undefined };
  }
  const body = request.body;
  if (body === undefined || body === null) return { body: undefined };
  if (typeof body === "string") return { body };
  if (Buffer.isBuffer(body)) return { body };
  if (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { pipe?: unknown }).pipe === "function"
  ) {
    // Bun's fetch accepts Node readable streams at runtime; the BodyInit
    // type union doesn't list NodeJS.ReadableStream explicitly, so cast
    // through unknown. `duplex:"half"` is required for streaming bodies.
    return { body: body as unknown as BodyInit, duplex: "half" };
  }
  // Parsed JSON / form object — re-encode. The inbound Content-Type header
  // is forwarded verbatim, which is correct for the proxy's small POST
  // surface (coolwsd's own endpoints; the WOPI POSTs go to `/wopi/*`).
  return { body: JSON.stringify(body) };
}

async function proxyHttp(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const requestPath = request.url.split("?", 1)[0] ?? request.url;
  // M201 R3 — refuse coolwsd admin console / admin-WS paths before proxying.
  const enginePath = requestPath.slice(OFFICE_PROXY_PREFIX.length);
  if (isCoolwsdAdminPath(enginePath)) {
    return reply.code(404).send({ error: "not found" });
  }
  if (request.method === "GET" && requestPath === OFFICE_STRIP_CSS_PATH) {
    return reply.type("text/css").header("cache-control", "no-store").send(OFFICE_STRIP_CSS);
  }

  const upstream = collaboraUpstreamOrigin();
  const upstreamUrl = `${upstream}${request.url}`;
  const { body, duplex } = resolveFetchBody(request);
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: forwardableHeaders(request.headers),
    // Upstream is loopback; 60s is ample for any asset / tile POST.
    signal: AbortSignal.timeout(60_000),
    body,
    ...(duplex ? { duplex } : {}),
  };

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, init);
  } catch (err) {
    warn(
      `[office-proxy] upstream fetch failed for ${request.url}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return reply.code(502).send({ error: "office engine unreachable" });
  }

  if (request.method === "GET" && request.url.includes("/cool.html")) {
    const contentType = upstreamRes.headers.get("content-type") ?? "";
    if (upstreamRes.ok && contentType.includes("text/html")) {
      const html = await upstreamRes.text();
      const cacheBusted = html.replace(
        /(src|href)="(\/office-engine\/browser\/[^"?]+\.(?:js|css))"/g,
        (_m, attr: string, url: string) => `${attr}="${url}?${OFFICE_PROXY_ASSET_CACHE_BUSTER}"`,
      );
      // M201 — strip coolwsd's own CSP from its editor UI. cool.html is
      // first-party engine code served SAME-ORIGIN under our origin; coolwsd's
      // self-imposed CSP (built for standalone coolwsd, esp. under
      // ssl.termination) blocks its own inline bootstrap `<script>` and the
      // editor never initializes. The outer workbench document + server-level
      // controls are the real perimeter; the engine iframe is trusted, not
      // user content. Strip both delivery vectors: the response header (below)
      // and any `<meta http-equiv="content-security-policy">` in the body.
      const cspStripped = stripCspMetaTags(cacheBusted);
      const headers: Record<string, string | number> = {};
      upstreamRes.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(lower)) return;
        if (lower === "content-length") return;
        // `fetch()` transparently decompresses upstream gzip/br bodies; forwarding
        // the original Content-Encoding would make the browser try to decompress
        // already-plain JS/CSS, producing script load errors and a blank editor.
        if (lower === "content-encoding") return;
        if (isCspHeader(lower)) return;
        headers[key] = value;
      });
      headers["cache-control"] = "no-store";
      headers["content-length"] = Buffer.byteLength(cspStripped);
      reply.hijack();
      reply.raw.writeHead(upstreamRes.status, headers);
      reply.raw.end(cspStripped);
      return;
    }
  }

  reply.hijack();
  const headers: Record<string, string | number> = {};
  upstreamRes.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) return;
    if (lower === "content-length") return; // reply.raw computes it
    // `fetch()` transparently decompresses upstream gzip/br bodies; forwarding
    // the original Content-Encoding would make the browser try to decompress
    // already-plain JS/CSS, producing script load errors and a blank editor.
    if (lower === "content-encoding") return;
    // M201 — never forward coolwsd's own CSP (see the cool.html branch).
    if (isCspHeader(lower)) return;
    headers[key] = value;
  });
  // M201 — cache immutable hashed build assets; keep everything else no-store.
  headers["cache-control"] = engineAssetCacheControl(requestPath);
  reply.raw.writeHead(upstreamRes.status, headers);
  if (upstreamRes.body) {
    try {
      // Stream the upstream response body straight to the client —
      // never buffer large asset responses in server memory.
      await pipeline(upstreamRes.body as unknown as NodeJS.ReadableStream, reply.raw);
    } catch (err) {
      warn(
        `[office-proxy] upstream stream failed for ${request.url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      try {
        reply.raw.destroy();
      } catch {
        /* already closed */
      }
    }
  } else {
    reply.raw.end();
  }
}

/**
 * Bidirectional WS pipe: client ↔ coolwsd. coolwsd's protocol is mostly
 * text frames (JSON control messages) plus some binary frames (tiles,
 * file payloads). We forward `data` verbatim with the original binary
 * flag preserved, and close both sides when either closes.
 */
function proxyWs(client: WebSocket, req: FastifyRequest): void {
  // M201 R3 — refuse the upgrade for coolwsd admin-WS paths (never proxy the
  // admin console websocket through the un-authed office proxy).
  const wsPath = req.url.split("?", 1)[0] ?? req.url;
  if (isCoolwsdAdminPath(wsPath.slice(OFFICE_PROXY_PREFIX.length))) {
    try {
      client.close(1008, "admin path forbidden");
    } catch {
      /* already closing */
    }
    return;
  }
  const upstreamUrl = `${collaboraUpstreamWsOrigin()}${req.url}`;
  const origin = resolveUpstreamWsOrigin(req.headers);
  const upstream = new WebSocket(upstreamUrl, {
    headers: {
      // coolwsd validates WebSocket Origin. The browser sends Origin to
      // Nautilo; the server-side proxy must forward it when opening the
      // upstream socket, or coolwsd rejects the upgrade as disallowed-origin.
      Origin: origin,
    },
  });

  let closed = false;
  const queuedClientFrames: Array<{ data: RawData; isBinary: boolean }> = [];
  const closeBoth = (code?: number, reason?: Buffer | string): void => {
    if (closed) return;
    closed = true;
    try {
      if (client.readyState === client.OPEN) client.close(code ?? 1000, reason);
    } catch {
      /* already closing */
    }
    try {
      if (upstream.readyState === upstream.OPEN) upstream.close(code ?? 1000, reason);
    } catch {
      /* already closing */
    }
  };

  client.on("message", (data, isBinary) => {
    if (upstream.readyState !== upstream.OPEN) {
      // Collabora sends its first session command immediately after the browser
      // side opens. The upstream socket may not be open yet; dropping that frame
      // leaves the editor stuck at "Connecting… 0%" with both sockets open.
      queuedClientFrames.push({ data, isBinary });
      return;
    }
    upstream.send(data, { binary: isBinary });
  });
  client.on("close", (code, reason) => closeBoth(code, reason));
  client.on("error", () => closeBoth(1011, "client socket error"));

  upstream.on("open", () => {
    while (queuedClientFrames.length > 0 && upstream.readyState === upstream.OPEN) {
      const frame = queuedClientFrames.shift()!;
      upstream.send(frame.data, { binary: frame.isBinary });
    }
  });
  upstream.on("message", (data, isBinary) => {
    if (client.readyState !== client.OPEN) return;
    client.send(data, { binary: isBinary });
  });
  upstream.on("close", (code, reason) => closeBoth(code, reason));
  upstream.on("error", (err: Error) => {
    warn(
      `[office-proxy] upstream WS error for ${req.url} (origin=${origin}): ${err instanceof Error ? err.message : String(err)}`,
    );
    closeBoth(1011, "upstream error");
  });
}

/**
 * Content types the proxy will forward WITH a body to coolwsd, and the max
 * body size per type. This is a deliberate ALLOWLIST, not a catch-all:
 *
 * - `multipart/form-data` is what Collabora's image-insert upload sends
 *   (Map.FileInserter.js `_sendFile`: XHR POST of FormData{name, childid,
 *   file} to `/cool/<WOPISrc>/insertfile`). Without a parser for it, the
 *   globally-registered @fastify/multipart plugin claims the type but leaves
 *   `request.body` undefined (its API is pull-based), so the proxy forwarded
 *   an EMPTY body and coolwsd 400'd with "Malformed multipart message" /
 *   Content-Length: 0 (live-diagnosed 2026-07-05).
 *
 * To support future engine uploads (e.g. `insertmultimedia` audio/video),
 * a developer must INTENTIONALLY add the type here — nothing else in the
 * server inherits this parser (see the encapsulated scope below).
 *
 * Bodies are BUFFERED (parseAs:"buffer"), not streamed: fetch then sends a
 * concrete Content-Length, which is what coolwsd's request dispatcher
 * expects — the same proven pattern as wopi.ts's PutFile octet-stream
 * parser. The per-type cap bounds server memory.
 */
const OFFICE_PROXY_UPLOAD_TYPES: ReadonlyArray<{ contentType: string; bodyLimit: number }> = [
  // Image insert. 25MB comfortably covers slide/document images while
  // bounding memory; raise deliberately if a real image exceeds it.
  { contentType: "multipart/form-data", bodyLimit: 25 * 1024 * 1024 },
];

export function officeProxyRoutes(app: FastifyInstance): void {
  // Encapsulated child scope: the upload parsers registered here override the
  // global @fastify/multipart claim ONLY for office-proxy routes. The rest of
  // the app keeps its existing parser behavior (multipart stays pull-based
  // for real form endpoints; unknown types still 415). Child scopes inherit
  // the root @fastify/websocket registration, so `wsHandler` keeps working.
  void app.register((scope, _opts, done) => {
    for (const { contentType, bodyLimit } of OFFICE_PROXY_UPLOAD_TYPES) {
      // The root-registered @fastify/multipart already claims
      // multipart/form-data and child scopes INHERIT parsers, so adding ours
      // directly throws FST_ERR_CTP_ALREADY_PRESENT. removeContentTypeParser
      // is encapsulation-aware: it removes the inherited claim from THIS
      // scope only, leaving the global multipart plugin intact for real form
      // endpoints elsewhere in the app.
      scope.removeContentTypeParser(contentType);
      scope.addContentTypeParser(
        contentType,
        { parseAs: "buffer", bodyLimit },
        (_req, body, parsed) => {
          parsed(null, body);
        },
      );
    }
    scope.route({
      method: "GET",
      url: `${OFFICE_PROXY_PREFIX}/*`,
      handler: proxyHttp,
      wsHandler: proxyWs,
    });
    scope.route({
      method: "POST",
      url: `${OFFICE_PROXY_PREFIX}/*`,
      handler: proxyHttp,
    });
    done();
  });
}
