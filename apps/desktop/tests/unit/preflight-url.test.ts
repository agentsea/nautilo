/**
 * Unit tests for preflight.probeUrl (D057 2a.2).
 *
 * probeUrl is the gate between "user typed a URL in the connect-mode
 * input" and "main boots pointing at that URL". We spin up a tiny
 * Bun.serve server in-test and exercise each discriminated-union case.
 *
 * Intentionally doesn't test every subtlety of fetch error mapping
 * (TLS, DNS, etc.) — those are branches we rely on the runtime to
 * classify. We test the shape-preserving branches that our code owns.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { probeUrl } from "../../electron/preflight";

let server: { url: URL; stop: () => void } | null = null;

interface Routes {
  readiness?: () => Response | Promise<Response>;
  bare?: () => Response | Promise<Response>;
}

function startServer(routes: Routes): { url: URL; stop: () => void } {
  const s = Bun.serve({
    port: 0, // OS-assigned
    fetch(req) {
      const u = new URL(req.url);
      // M051: probe path corrected from `/api/health/ready` (which 404s
      // against a real Nautilo server) to `/health/ready`.
      if (u.pathname === "/health/ready" && routes.readiness) {
        return routes.readiness();
      }
      if (u.pathname === "/" && routes.bare) {
        return routes.bare();
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: new URL(`http://localhost:${s.port}/`),
    stop: () => s.stop(),
  };
}

describe("probeUrl — invalid input", () => {
  test("empty string", async () => {
    const r = await probeUrl("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid-url");
  });

  test("non-URL", async () => {
    const r = await probeUrl("not a url at all");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid-url");
  });

  test("unsupported scheme", async () => {
    const r = await probeUrl("ftp://example.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid-url");
  });
});

describe("probeUrl — reachable happy paths", () => {
  beforeAll(() => {
    server = startServer({
      // M051: shape corrected from `{ready: boolean}` (which never existed
      // on the real route) to `{status: "ready" | "starting", components}`.
      readiness: () =>
        new Response(
          JSON.stringify({ status: "ready", components: {}, version: "test" }),
          { headers: { "content-type": "application/json" } },
        ),
    });
  });

  afterAll(() => {
    server?.stop();
    server = null;
  });

  test("bare URL appends /health/ready and succeeds", async () => {
    const r = await probeUrl(server!.url.toString());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.statusCode).toBe(200);
      expect(r.reachableAt).toContain("/health/ready");
    }
  });

  test("status: 'starting' is also accepted (server still warming)", async () => {
    server?.stop();
    server = startServer({
      readiness: () =>
        new Response(JSON.stringify({ status: "starting", components: {} }), {
          headers: { "content-type": "application/json" },
        }),
    });
    const r = await probeUrl(server.url.toString());
    expect(r.ok).toBe(true);
  });
});

describe("D514 — delayed healthy readiness remains healthy", () => {
  for (const delayMs of [801, 1_500, 2_500]) {
    test(`healthy /health/ready after ${delayMs}ms is not classified as unreachable`, async () => {
      const delayed = startServer({
        readiness: async () => {
          await Bun.sleep(delayMs);
          return new Response(JSON.stringify({ status: "ready", components: {} }), {
            headers: { "content-type": "application/json" },
          });
        },
      });
      try {
        const r = await probeUrl(delayed.url.toString());
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.elapsedMs).toBeGreaterThanOrEqual(delayMs - 25);
          expect(r.elapsedMs).toBeLessThan(5_000);
        }
      } finally {
        delayed.stop();
      }
    });
  }

  test("a transient failure can be retried into a healthy result", async () => {
    let requestCount = 0;
    const transient = startServer({
      readiness: () => {
        requestCount += 1;
        return requestCount === 1
          ? new Response("temporarily unavailable", { status: 503 })
          : new Response(JSON.stringify({ status: "ready", components: {} }), {
              headers: { "content-type": "application/json" },
            });
      },
    });
    try {
      const first = await probeUrl(transient.url.toString());
      expect(first.ok).toBe(false);
      if (!first.ok) expect(first.reason).toBe("bad-status");

      const second = await probeUrl(transient.url.toString());
      expect(second.ok).toBe(true);
      expect(requestCount).toBe(2);
    } finally {
      transient.stop();
    }
  });
});

describe("probeUrl — bad-status", () => {
  beforeAll(() => {
    server = startServer({
      readiness: () => new Response("server down", { status: 503 }),
    });
  });

  afterAll(() => {
    server?.stop();
    server = null;
  });

  test("5xx is bad-status", async () => {
    const r = await probeUrl(server!.url.toString());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("bad-status");
      expect(r.detail).toContain("503");
    }
  });
});

describe("probeUrl — not-nautilo", () => {
  beforeAll(() => {
    server = startServer({
      readiness: () =>
        // 200 but wrong shape — looks like some other service on that port.
        new Response(JSON.stringify({ ok: true, service: "not-us" }), {
          headers: { "content-type": "application/json" },
        }),
    });
  });

  afterAll(() => {
    server?.stop();
    server = null;
  });

  test("200 with wrong JSON shape is not-nautilo", async () => {
    const r = await probeUrl(server!.url.toString());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-nautilo");
  });
});

describe("probeUrl — network-error", () => {
  test("unreachable host", async () => {
    // Port 1 is reserved; no one listens there. Connection-refused or
    // similar surfaces as network-error in our classifier.
    const r = await probeUrl("http://127.0.0.1:1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(["network-error", "timeout"]).toContain(r.reason);
    }
  });
});
