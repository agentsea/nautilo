import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";

let fx: AppFixture;

beforeEach(async () => {
  fx = await setupOwnerAppFixture({ suiteName: `pwloginrm${Date.now().toString(36)}` });
});

afterEach(async () => {
  await fx.cleanup();
});

describe("POST /api/auth/logto-password-login (removed, M102)", () => {
  test("returns 404", async () => {
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/auth/logto-password-login",
      payload: { handle: "x", password: "y" },
    });
    expect(res.statusCode).toBe(404);
  });
});
