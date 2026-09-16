import { join, resolve } from "node:path";
import { mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

let fx: AppFixture;
let certsDir: string;
let bearer: string;

beforeAll(async () => {
  certsDir = mkdtempSync(join(tmpdir(), "nautilo-pair-"));
  copyFileSync(
    resolve(import.meta.dirname, "../fixtures/pair-test-ca.crt"),
    join(certsDir, "ca.crt"),
  );
  fx = await setupOwnerAppFixture({
    suiteName: "pair",
    createAppExtras: {
      certsDir,
      hostname: "127.0.0.1",
      port: 3001,
    },
  });
  bearer = await fx.mintOwnerBearer();
});

afterAll(async () => {
  await fx.cleanup();
  try {
    rmSync(certsDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("pair (LAN)", () => {
  test("POST /api/pair/generate returns a code and URL", async () => {
    const res = await authedInject(fx.app, {
      method: "POST",
      url: "/api/pair/generate",
      bearer,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { code?: string; url?: string };
    expect(typeof body.code).toBe("string");
    expect(body.code!.length).toBeGreaterThan(3);
    expect(body.url).toContain("/pair/");
  });

  test("GET /pair/:code serves HTML then marks code used", async () => {
    const gen = await authedInject(fx.app, {
      method: "POST",
      url: "/api/pair/generate",
      bearer,
      payload: {},
    });
    const { code } = JSON.parse(gen.body) as { code: string };

    const page = await fx.app.inject({
      method: "GET",
      url: `/pair/${code}`,
      headers: { "user-agent": "curl" },
    });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("html");

    const again = await fx.app.inject({ method: "GET", url: `/pair/${code}` });
    expect(again.statusCode).toBe(410);
  });
});
