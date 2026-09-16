/**
 * D362 Phase 3 §3.1b — focused regression tests for the same-origin
 * Collabora office proxy (`routes/office-proxy.ts`).
 *
 * Each test guards a specific failure we already lived through:
 *   1. Route registration smoke — `Method 'HEAD' already declared for
 *      route '/office-engine/*'` (duplicate HEAD route).
 *   2. Strip CSS route — `/office-engine/nw-strip.css` served as
 *      same-origin CSS, including query-string handling.
 *   3. cool.html cache-busting — rewrite `/office-engine/browser/...`
 *      asset URLs with `?nwproxy=1` and force `cache-control: no-store`
 *      so a stale `bundle.js`/`bundle.css` never survives a deploy.
 *   4. WS Origin forwarding — coolwsd rejects upgrades whose `Origin`
 *      isn't allow-listed; the proxy must forward the browser Origin
 *      verbatim. The WS upgrade itself is hard to mock end-to-end, so
 *      we test the pure `resolveUpstreamWsOrigin` helper instead.
 *
 * NOT here: the generic streaming-asset cases (HEAD auto-derivation +
 * Content-Encoding stripping for `/browser/...`) live in
 * `tests/integration/office-proxy-streaming.integration.test.ts`.
 * They go through `reply.hijack()` + `pipeline(upstreamRes.body, reply.raw)`,
 * which never completes against light-my-request's mock socket under
 * `app.inject()` — they need a real listener + client socket.
 *
 * Mocks:
 *   - `@nautilo/config` — deterministic `resolveInstance` /
 *     `collaboraHostPort` so the upstream origin is stable
 *     (`http://127.0.0.1:9981`) and no `instance.json` is touched.
 *   - `@nautilo/logger` — no-op `warn` so expected upstream-fetch
 *     failures don't print noise.
 *   - `globalThis.fetch` — per-test monkeypatch for the upstream
 *     response shape (cool.html body), restored in `afterEach`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";

const STUB_INSTANCE = {
  server: { port: 3001, host: "127.0.0.1", url: "http://127.0.0.1:3001" },
};
const STUB_COLLABORA_PORT = 9981;

mock.module("@nautilo/config", () => ({
  resolveInstance: () => STUB_INSTANCE,
  collaboraHostPort: () => STUB_COLLABORA_PORT,
}));
mock.module("@nautilo/logger", () => ({
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
  debug: () => undefined,
}));

const {
  officeProxyRoutes,
  resolveUpstreamWsOrigin,
  OFFICE_PROXY_PREFIX,
  isCspHeader,
  stripCspMetaTags,
  engineAssetCacheControl,
} = await import("../../src/routes/office-proxy");

type FetchImpl = typeof globalThis.fetch;
let realFetch: FetchImpl | null = null;

function makeApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  return app;
}

async function startApp(): Promise<FastifyInstance> {
  const app = makeApp();
  await app.register(websocket);
  officeProxyRoutes(app);
  await app.ready();
  return app;
}

describe("office-proxy route registration smoke", () => {
  test("registering officeProxyRoutes on a websocket-enabled Fastify app does not throw", async () => {
    const app = makeApp();
    await app.register(websocket);
    // The prior failure was a duplicate HEAD route declaration; this
    // call must complete without "Method 'HEAD' already declared".
    expect(() => officeProxyRoutes(app)).not.toThrow();
    await app.ready();
    await app.close();
  });
});

describe("office-proxy strip CSS route", () => {
  let app: FastifyInstance | null = null;
  beforeEach(async () => {
    app = await startApp();
  });
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  test("GET /office-engine/nw-strip.css?x=1 returns text/css with the strip selectors", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `${OFFICE_PROXY_PREFIX}/nw-strip.css?x=1`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/css");
    expect(res.headers["cache-control"]).toBe("no-store");
    // Core selectors the workbench relies on to hide the Collabora
    // chrome. Guards against accidental edits to OFFICE_STRIP_CSS.
    expect(res.body).toContain("#toolbar-wrapper");
    expect(res.body).toContain(".iframe-welcome-wrap");
  });
});

describe("office-proxy cool.html cache busting", () => {
  let app: FastifyInstance | null = null;
  let fetchCalls: { url: string }[] = [];

  beforeEach(async () => {
    fetchCalls = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = ((input: URL | string) => {
      fetchCalls.push({ url: String(input) });
      const html =
        '<!doctype html><html><head>' +
        '<link rel="stylesheet" href="/office-engine/browser/hash/bundle.css">' +
        '</head><body>' +
        '<script src="/office-engine/browser/hash/bundle.js"></script>' +
        '</body></html>';
      return Promise.resolve(
        new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    }) as FetchImpl;
    app = await startApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    app = null;
    if (realFetch) {
      globalThis.fetch = realFetch;
      realFetch = null;
    }
  });

  test("rewrites /office-engine/browser/... asset URLs with ?nwproxy=1 and forces no-store", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `${OFFICE_PROXY_PREFIX}/cool.html?WOPISrc=...`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    // Both JS and CSS bundle URLs get the cache-bust query appended.
    expect(res.body).toContain('/office-engine/browser/hash/bundle.js?nwproxy=1"');
    expect(res.body).toContain('/office-engine/browser/hash/bundle.css?nwproxy=1"');
    // The original un-busted URLs must not survive verbatim.
    expect(res.body).not.toMatch(/bundle\.js"/);
    expect(res.body).not.toMatch(/bundle\.css"/);
    // We do not inject nw-debug.js in production; assert it's absent
    // so a future regression that re-adds it is loud.
    expect(res.body).not.toContain("nw-debug.js");
    // Upstream was the loopback engine origin.
    expect(fetchCalls[0]?.url).toContain("http://127.0.0.1:9981/office-engine/cool.html");
  });
});

describe("office-proxy M201 R3 admin path deny (through the HTTP proxy)", () => {
  let app: FastifyInstance | null = null;
  let fetchCalls: { url: string }[] = [];

  beforeEach(async () => {
    fetchCalls = [];
    realFetch = globalThis.fetch;
    // Any upstream fetch here would be a BUG — admin paths must 404 before
    // proxying. Record calls so the test can assert upstream was never hit.
    globalThis.fetch = ((input: URL | string) => {
      fetchCalls.push({ url: String(input) });
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as FetchImpl;
    app = await startApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    app = null;
    if (realFetch) {
      globalThis.fetch = realFetch;
      realFetch = null;
    }
  });

  const adminPaths = [
    `${OFFICE_PROXY_PREFIX}/adminws`,
    `${OFFICE_PROXY_PREFIX}/cool/adminws`,
    `${OFFICE_PROXY_PREFIX}/admin`,
    `${OFFICE_PROXY_PREFIX}/browser/dist/admin/admin.html`,
  ];

  for (const url of adminPaths) {
    test(`GET ${url} returns 404 without hitting upstream`, async () => {
      const res = await app!.inject({ method: "GET", url });
      expect(res.statusCode).toBe(404);
      expect(fetchCalls).toHaveLength(0);
    });
  }
});

describe("office-proxy M201 CSP stripping (coolwsd's own CSP on cool.html)", () => {
  test("isCspHeader flags CSP + report-only, ignores others", () => {
    expect(isCspHeader("content-security-policy")).toBe(true);
    expect(isCspHeader("content-security-policy-report-only")).toBe(true);
    expect(isCspHeader("content-type")).toBe(false);
    expect(isCspHeader("x-frame-options")).toBe(false);
  });

  test("stripCspMetaTags removes CSP meta tags (any attribute order) but keeps other meta", () => {
    const html =
      '<head>' +
      '<meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="script-src \'self\'">' +
      "<meta content=\"default-src 'none'\" http-equiv='content-security-policy-report-only'>" +
      '<meta name="viewport" content="width=device-width">' +
      "</head>";
    const out = stripCspMetaTags(html);
    expect(out).not.toMatch(/content-security-policy/i);
    expect(out).toContain('<meta charset="utf-8">');
    expect(out).toContain('<meta name="viewport"');
  });

  test("proxied cool.html drops coolwsd's CSP header and CSP meta", async () => {
    const realFetchLocal = globalThis.fetch;
    globalThis.fetch = ((_input: URL | string) =>
      Promise.resolve(
        new Response(
          '<!doctype html><html><head>' +
            '<meta http-equiv="content-security-policy" content="script-src \'self\' \'unsafe-eval\'">' +
            '<script src="/office-engine/browser/hash/bundle.js"></script>' +
            "</head><body></body></html>",
          {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "content-security-policy": "script-src 'self' 'unsafe-eval'",
            },
          },
        ),
      )) as FetchImpl;
    const app = await startApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `${OFFICE_PROXY_PREFIX}/cool.html?WOPISrc=x`,
      });
      expect(res.statusCode).toBe(200);
      // Neither the response header nor the meta tag survives.
      expect(res.headers["content-security-policy"]).toBeUndefined();
      expect(res.body).not.toMatch(/content-security-policy/i);
      // The normal cache-bust rewrite still applies.
      expect(res.body).toContain("bundle.js?nwproxy=1");
    } finally {
      await app.close();
      globalThis.fetch = realFetchLocal;
    }
  });
});

describe("office-proxy M201 asset caching (engineAssetCacheControl)", () => {
  test("immutable, long-lived cache for hashed /browser/<hash>/ build assets", () => {
    const immutable = "public, max-age=31536000, immutable";
    expect(engineAssetCacheControl(`${OFFICE_PROXY_PREFIX}/browser/7d478/bundle.js`)).toBe(immutable);
    expect(engineAssetCacheControl(`${OFFICE_PROXY_PREFIX}/browser/7d478/bundle.css`)).toBe(immutable);
    expect(engineAssetCacheControl(`${OFFICE_PROXY_PREFIX}/browser/7d478/images/lc_prev.svg`)).toBe(
      immutable,
    );
  });

  test("cool.html and dynamic engine paths stay no-store", () => {
    expect(engineAssetCacheControl(`${OFFICE_PROXY_PREFIX}/browser/7d478/cool.html`)).toBe("no-store");
    expect(engineAssetCacheControl(`${OFFICE_PROXY_PREFIX}/hosting/discovery`)).toBe("no-store");
    expect(engineAssetCacheControl(`${OFFICE_PROXY_PREFIX}/cool/wopisrc/ws`)).toBe("no-store");
  });
});

describe("office-proxy WS Origin forwarding (pure helper)", () => {
  test("forwards the browser-sent Origin verbatim when present", () => {
    // Same-origin iframe → browser sends Origin: http://127.0.0.1:3001.
    // coolwsd's allow-list check requires this exact value on the
    // upstream upgrade; any rewriting breaks the editor socket.
    expect(resolveUpstreamWsOrigin({ origin: "http://127.0.0.1:3001" })).toBe(
      "http://127.0.0.1:3001",
    );
  });

  test("falls back to the local server origin when Origin header is absent", () => {
    // Some WS clients (non-browser) omit Origin; the proxy must still
    // send one or coolwsd rejects the upgrade. Fallback is the local
    // server port from resolveInstance() — stubbed to 3001 here.
    expect(resolveUpstreamWsOrigin({})).toBe("http://127.0.0.1:3001");
  });

  test("treats an empty-string Origin as absent and uses the fallback", () => {
    expect(resolveUpstreamWsOrigin({ origin: "" })).toBe("http://127.0.0.1:3001");
  });
});
