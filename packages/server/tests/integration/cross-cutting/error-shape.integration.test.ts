import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupOwnerAppFixture, type AppFixture } from "../helpers/app-fixture";

let fx: AppFixture;

beforeAll(async () => {
  fx = await setupOwnerAppFixture({ suiteName: "errs" });
});

afterAll(async () => {
  await fx.cleanup();
});

describe("global error envelope", () => {
  test("validation failure returns 4xx JSON body", async () => {
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(typeof body["statusCode"] === "number" || typeof body["error"] === "string").toBe(true);
  });
});
