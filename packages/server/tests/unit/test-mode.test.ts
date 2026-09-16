/**
 * Unit tests for the test-mode route (/api/test/*).
 *
 * Exercises the route in isolation via Fastify's inject API — no real
 * HTTP listener needed. Gated manually by constructing the app with
 * `enabled: true`; production callers route through resolveTestToken().
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { testModeRoutes } from "../../src/routes/test-mode";

const TEST_TOKEN = "test-token-0123456789abcdef";

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  testModeRoutes(app, { enabled: true, token: TEST_TOKEN });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function auth(): Record<string, string> {
  return { authorization: `Bearer ${TEST_TOKEN}` };
}

type PingBody = { ok: boolean; testMode: boolean; timestamp: string };
type ScanBody = {
  blocked: boolean;
  reason?: string;
  matchedPatterns?: Array<{ key: string; severity: string; description: string }>;
  matchedThreats?: string[];
  contentReplaced?: boolean;
};

// Fastify's LightMyRequestResponse.json() is typed `any`. Wrap it so
// the response body has a concrete type without tripping the
// no-unsafe-assignment / no-unnecessary-type-assertion dance.
function parseBody<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

describe("test-mode /api/test/ping", () => {
  test("returns 200 with valid token", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/test/ping",
      headers: auth(),
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<PingBody>(r.body);
    expect(body.ok).toBe(true);
    expect(body.testMode).toBe(true);
  });

  test("returns 404 without token", async () => {
    const r = await app.inject({ method: "GET", url: "/api/test/ping" });
    expect(r.statusCode).toBe(404);
  });

  test("returns 404 with wrong token", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/test/ping",
      headers: { authorization: "Bearer nope" },
    });
    expect(r.statusCode).toBe(404);
  });
});

describe("test-mode /api/test/security-scan — command layer", () => {
  test("blocks 'rm -rf /' at standard level", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/security-scan",
      headers: auth(),
      payload: { layer: "command", level: "standard", input: "rm -rf /" },
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<ScanBody>(r.body);
    expect(body.blocked).toBe(true);
    expect(body.reason?.toLowerCase()).toContain("critical");
  });

  test("allows harmless command at standard level", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/security-scan",
      headers: auth(),
      payload: { layer: "command", level: "standard", input: "echo hello" },
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<ScanBody>(r.body);
    expect(body.blocked).toBe(false);
  });

  test("yolo level bypasses scanner", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/security-scan",
      headers: auth(),
      payload: { layer: "command", level: "yolo", input: "sudo apt update" },
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<ScanBody>(r.body);
    expect(body.blocked).toBe(false);
  });

  test("sudo blocked at standard level", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/security-scan",
      headers: auth(),
      payload: { layer: "command", level: "standard", input: "sudo apt update" },
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<ScanBody>(r.body);
    expect(body.blocked).toBe(true);
  });

  // Live-testing finding — gaps surfaced during D053 PR #32.
  test("npm install <package> blocked (supply-chain)", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/security-scan",
      headers: auth(),
      payload: { layer: "command", level: "standard", input: "npm install left-pad" },
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<ScanBody>(r.body);
    expect(body.blocked).toBe(true);
  });

  test("echo $API_KEY blocked", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/security-scan",
      headers: auth(),
      payload: { layer: "command", level: "standard", input: "echo $OPENAI_API_KEY" },
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<ScanBody>(r.body);
    expect(body.blocked).toBe(true);
  });

  test("plain env dump blocked", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/security-scan",
      headers: auth(),
      payload: { layer: "command", level: "standard", input: "env" },
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<ScanBody>(r.body);
    expect(body.blocked).toBe(true);
  });

  test("cat ~/.zshrc blocked", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/security-scan",
      headers: auth(),
      payload: { layer: "command", level: "standard", input: "cat ~/.zshrc" },
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<ScanBody>(r.body);
    expect(body.blocked).toBe(true);
  });
});

describe("test-mode /api/test/security-scan — path layer", () => {
  test("blocks read of /etc/passwd", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/security-scan",
      headers: auth(),
      payload: { layer: "path", level: "standard", input: "/etc/passwd" },
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<ScanBody>(r.body);
    expect(body.blocked).toBe(true);
    expect(body.reason).toContain("/etc");
  });

  test("allows normal path", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/security-scan",
      headers: auth(),
      payload: { layer: "path", level: "standard", input: "/tmp/ok.txt" },
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<ScanBody>(r.body);
    expect(body.blocked).toBe(false);
  });
});

describe("test-mode /api/test/security-scan — content layer", () => {
  test("replaces invisible Unicode", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/security-scan",
      headers: auth(),
      payload: {
        layer: "content",
        level: "standard",
        input: "hello\u200b\u200c\u200dworld",
        source: "test_mock",
      },
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<ScanBody>(r.body);
    expect(body.blocked).toBe(true);
    expect(body.matchedThreats?.length ?? 0).toBeGreaterThan(0);
  });

  test("passes clean content", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/security-scan",
      headers: auth(),
      payload: {
        layer: "content",
        level: "standard",
        input: "This is perfectly clean text with no issues.",
        source: "test_mock",
      },
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<ScanBody>(r.body);
    expect(body.blocked).toBe(false);
  });
});

describe("test-mode /api/test/security-scan — validation", () => {
  test("rejects invalid layer with 400", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/security-scan",
      headers: auth(),
      payload: { layer: "bogus", level: "standard", input: "x" },
    });
    expect(r.statusCode).toBe(400);
  });

  test("rejects invalid level with 400", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/security-scan",
      headers: auth(),
      payload: { layer: "command", level: "bogus", input: "x" },
    });
    expect(r.statusCode).toBe(400);
  });

  test("rejects missing input with 400", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/security-scan",
      headers: auth(),
      payload: { layer: "command", level: "standard" },
    });
    expect(r.statusCode).toBe(400);
  });

  test("M-1: rejects input over 10_000 chars with 400 + 'input too long'", async () => {
    const oversize = "x".repeat(20_000);
    const r = await app.inject({
      method: "POST",
      url: "/api/test/security-scan",
      headers: auth(),
      payload: { layer: "command", level: "standard", input: oversize },
    });
    expect(r.statusCode).toBe(400);
    const body: { error: string; message: string } = r.json();
    expect(body.error).toBe("input too long");
    expect(body.message).toContain("10000");
    expect(body.message).toContain("20000");
  });

  test("M-1: accepts input exactly at the 10_000-char cap", async () => {
    // Boundary condition — the cap is `>`, so exactly-10000 should pass.
    const atCap = "x".repeat(10_000);
    const r = await app.inject({
      method: "POST",
      url: "/api/test/security-scan",
      headers: auth(),
      payload: { layer: "command", level: "standard", input: atCap },
    });
    expect(r.statusCode).toBe(200);
  });

  test("unauthenticated returns 404 (not 401 — route hidden)", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/security-scan",
      payload: { layer: "command", level: "standard", input: "echo hi" },
    });
    expect(r.statusCode).toBe(404);
  });
});

describe("test-mode disabled mode", () => {
  test("routes are not registered when enabled=false", async () => {
    const disabledApp = Fastify({ logger: false });
    testModeRoutes(disabledApp, { enabled: false, token: "whatever" });
    await disabledApp.ready();
    try {
      const r = await disabledApp.inject({
        method: "GET",
        url: "/api/test/ping",
        headers: auth(),
      });
      expect(r.statusCode).toBe(404);
    } finally {
      await disabledApp.close();
    }
  });
});
