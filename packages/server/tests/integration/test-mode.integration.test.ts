import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";

let fx: AppFixture;
let prevTestMode: string | undefined;
let prevTestToken: string | undefined;

beforeEach(async () => {
  prevTestMode = process.env["NAUTILO_TEST_MODE"];
  prevTestToken = process.env["NAUTILO_TEST_TOKEN"];
  process.env["NAUTILO_TEST_MODE"] = "1";
  process.env["NAUTILO_TEST_TOKEN"] = "test-token-123456789012";
  fx = await setupOwnerAppFixture({ suiteName: `tmode${Date.now().toString(36)}` });
});

afterEach(async () => {
  await fx.cleanup();
  if (prevTestMode === undefined) delete process.env["NAUTILO_TEST_MODE"];
  else process.env["NAUTILO_TEST_MODE"] = prevTestMode;
  if (prevTestToken === undefined) delete process.env["NAUTILO_TEST_TOKEN"];
  else process.env["NAUTILO_TEST_TOKEN"] = prevTestToken;
});

describe("test-mode routes", () => {
  test("GET /api/test/ping without token returns 404", async () => {
    const res = await fx.app.inject({ method: "GET", url: "/api/test/ping" });
    expect(res.statusCode).toBe(404);
  });

  test("GET /api/test/ping with test bearer returns ok", async () => {
    const res = await fx.app.inject({
      method: "GET",
      url: "/api/test/ping",
      headers: { authorization: "Bearer test-token-123456789012" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok?: boolean; testMode?: boolean };
    expect(body.ok).toBe(true);
    expect(body.testMode).toBe(true);
  });

  test("POST /api/test/security-scan returns scanner envelope", async () => {
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/test/security-scan",
      headers: {
        authorization: "Bearer test-token-123456789012",
        "content-type": "application/json",
      },
      payload: {
        layer: "command",
        level: "standard",
        input: "echo hello",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { layer?: string; blocked?: boolean };
    expect(body.layer).toBe("command");
    expect(typeof body.blocked).toBe("boolean");
  });
});
