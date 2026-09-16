/**
 * D362 Phase 3 §3.1b — integration tests for the office proxy's STREAMING
 * response path (`routes/office-proxy.ts` `proxyHttp` generic branch).
 *
 * These two cases were split out of `tests/unit-isolated/office-proxy.test.ts`
 * because they cannot run under `app.inject()`. For a generic asset (anything
 * that isn't `nw-strip.css` or `cool.html`), `proxyHttp` calls `reply.hijack()`
 * and streams the upstream body with `pipeline(upstreamRes.body, reply.raw)`.
 * Under light-my-request (`app.inject`), `reply.raw` is a mock socket that the
 * pipeline never finishes writing to, so the injected request hangs until the
 * test times out. (The `cool.html` / `nw-strip.css` cases stay as unit tests —
 * they finish with `reply.raw.end(body)` / `reply.send()` and don't stream.)
 *
 * The fix is to exercise the proxy over a REAL listening server with a real
 * client socket, so the hijack + pipeline path actually completes. The UPSTREAM
 * engine is still stubbed via `globalThis.fetch`; the client request uses
 * `node:http` directly so it is NOT intercepted by that stub.
 *
 * Mocks mirror the unit file: deterministic `@nautilo/config` + no-op
 * `@nautilo/logger`. The server integration runner gives every file its own
 * Bun process, containing these process-global mocks.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import http from "node:http";
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

const { officeProxyRoutes, OFFICE_PROXY_PREFIX } = await import(
  "../../src/routes/office-proxy"
);

type FetchImpl = typeof globalThis.fetch;

interface ClientResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Issue a request to the live test server over `node:http` (NOT `fetch`, which
 * is monkeypatched per-test to stub the upstream engine). Collects the full
 * body so assertions can check the streamed bytes.
 */
function clientRequest(port: number, method: string, path: string): Promise<ClientResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

/** Start a real listener and return the app + its ephemeral port. */
async function startServer(): Promise<{ app: FastifyInstance; port: number }> {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  officeProxyRoutes(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address from the test server");
  }
  return { app, port: address.port };
}

describe("office-proxy streaming path (real listener)", () => {
  let app: FastifyInstance | null = null;
  let port = 0;
  let realFetch: FetchImpl | null = null;
  let fetchCalls: { url: string; init?: RequestInit | undefined }[] = [];

  beforeEach(() => {
    fetchCalls = [];
    realFetch = globalThis.fetch;
  });

  afterEach(async () => {
    if (app) await app.close();
    app = null;
    if (realFetch) {
      globalThis.fetch = realFetch;
      realFetch = null;
    }
  });

  test("a HEAD request against /office-engine/* is handled (auto-derived from GET), not 404'd", async () => {
    // The original bug was a separate `app.head(...)` declaration colliding with
    // GET's implicit HEAD handling ("Method 'HEAD' already declared"). The fix
    // collapsed to GET + POST; Fastify auto-derives HEAD from GET. A missing
    // route would 404; a live one streams the (empty) upstream stub through the
    // hijack + pipeline path — which only completes over a real socket.
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("", { status: 200, headers: { "content-type": "text/plain" } }),
      )) as unknown as FetchImpl;

    ({ app, port } = await startServer());
    const res = await clientRequest(port, "HEAD", `${OFFICE_PROXY_PREFIX}/browser/hash/bundle.js`);
    expect(res.statusCode).toBe(200);
  });

  test("proxied JS asset has no content-encoding header and body is intact", async () => {
    // Stub upstream: a "gzipped" response whose body is already plain JS (mirrors
    // fetch's transparent decompression). The proxy MUST drop content-encoding or
    // the browser tries to gunzip already-plain bytes → blank editor.
    const body = 'console.log("collabora-asset");\n';
    globalThis.fetch = ((input: URL | string, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: {
            "content-type": "application/javascript",
            "content-encoding": "gzip",
            "content-length": String(new TextEncoder().encode(body).length),
          },
        }),
      );
    }) as FetchImpl;

    ({ app, port } = await startServer());
    const res = await clientRequest(port, "GET", `${OFFICE_PROXY_PREFIX}/browser/hash/bundle.js`);

    expect(res.statusCode).toBe(200);
    // The whole point: content-encoding must be stripped.
    expect(res.headers["content-encoding"]).toBeUndefined();
    // Body came through unmodified.
    expect(res.body).toContain('console.log("collabora-asset");');
    // Hashed Collabora build assets follow the production immutable-cache
    // contract; dynamic engine paths remain no-store.
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    // The upstream URL was the loopback Collabora port, not the public origin.
    expect(fetchCalls[0]?.url).toContain(
      "http://127.0.0.1:9981/office-engine/browser/hash/bundle.js",
    );
  });
});
