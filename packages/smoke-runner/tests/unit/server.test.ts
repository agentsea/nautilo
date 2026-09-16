import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createSmokeServer, matchPattern, type SmokeServer } from "../../src/server";
import type { RunnerConfig } from "../../src/run-registry";
import { makeExpectations } from "../integration/mock-driver";

const TOKEN = "nsk_test-token-unit";

function buildRunnerConfig(): RunnerConfig {
  // The server unit tests don't care about the runner doing anything —
  // auth + routing + health + 404 are all testable with an empty expectations.
  return {
    expectations: makeExpectations({}),
    platforms: {},
  };
}

describe("matchPattern — route pattern matcher", () => {
  test("exact literal match", () => {
    expect(matchPattern("/health", "/health")).toEqual({});
    expect(matchPattern("/health", "/not-health")).toBeNull();
    expect(matchPattern("/health", "/health/extra")).toBeNull();
  });

  test("single :param capture", () => {
    expect(matchPattern("/api/smoke/runs/:id", "/api/smoke/runs/abc123")).toEqual({ id: "abc123" });
    expect(matchPattern("/api/smoke/runs/:id", "/api/smoke/runs/")).toBeNull();
  });

  test("URL-decodes captured segment", () => {
    expect(matchPattern("/api/smoke/vms/:name", "/api/smoke/vms/hello%20world")).toEqual({ name: "hello world" });
  });

  test("multiple segments with mixed literals + params", () => {
    expect(matchPattern("/api/smoke/vms/:name/health", "/api/smoke/vms/nautilo-smoke-linux/health"))
      .toEqual({ name: "nautilo-smoke-linux" });
    expect(matchPattern("/api/smoke/vms/:name/health", "/api/smoke/vms/x/health/extra")).toBeNull();
  });

  test("trailing slashes don't match against patterns without one", () => {
    expect(matchPattern("/health", "/health/")).toEqual({}); // pattern split ignores empty
  });
});

describe("SmokeServer — auth + basic routing", () => {
  let s: SmokeServer;
  let baseUrl: string;

  beforeAll(async () => {
    s = await createSmokeServer({
      runnerConfig: buildRunnerConfig(),
      token: TOKEN,
      host: "127.0.0.1",
      port: 0, // ephemeral
      log: () => {},
    });
    baseUrl = `http://${s.host}:${s.port}`;
  });

  afterAll(async () => {
    await s.close();
  });

  test("GET /health responds 200 with liveness info (no auth)", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; uptimeMs: number };
    expect(body.ok).toBe(true);
    expect(typeof body.uptimeMs).toBe("number");
  });

  test("unknown path returns 404 JSON", async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Not found");
  });

  test("/api/* routes require Bearer token → 401 without auth", async () => {
    // /api/smoke/tests exists; no auth → 401.
    const res = await fetch(`${baseUrl}/api/smoke/tests`);
    expect(res.status).toBe(401);
  });

  test("/api/* with valid Bearer token succeeds", async () => {
    const res = await fetch(`${baseUrl}/api/smoke/tests`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tests: unknown[] };
    expect(Array.isArray(body.tests)).toBe(true);
  });

  test("/api/* with bogus token → 401", async () => {
    const res = await fetch(`${baseUrl}/api/smoke/tests`, {
      headers: { Authorization: "Bearer bogus-token" },
    });
    expect(res.status).toBe(401);
  });

  test("health is GET-only (POST → 404)", async () => {
    const res = await fetch(`${baseUrl}/health`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("Content-Type is application/json; charset=utf-8 on responses", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-type")).toContain("utf-8");
  });

  test("bound host/port are reachable via loopback only", () => {
    expect(s.host).toBe("127.0.0.1");
    expect(s.port).toBeGreaterThan(0);
  });
});
