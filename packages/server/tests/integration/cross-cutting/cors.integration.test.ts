import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupOwnerAppFixture, type AppFixture } from "../helpers/app-fixture";

let fx: AppFixture;

beforeAll(async () => {
  fx = await setupOwnerAppFixture({ suiteName: "cors" });
});

afterAll(async () => {
  await fx.cleanup();
});

describe("CORS (dev origin reflection)", () => {
  test("OPTIONS preflight on /health includes allow headers", async () => {
    const res = await fx.app.inject({
      method: "OPTIONS",
      url: "/health",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
      },
    });
    expect(res.statusCode).toBe(204);
    const allowOrigin = res.headers["access-control-allow-origin"];
    expect(allowOrigin === "http://localhost:5173" || allowOrigin === "*").toBe(true);
  });
});
