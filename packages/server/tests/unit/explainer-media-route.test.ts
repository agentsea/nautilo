/**
 * D429 Phase 7.4.2 — unit tests for the authenticated, verified-byte
 * explainer media route (`GET /api/explainers/:id/media`) error paths.
 *
 * No network I/O: the runtime catalog is a fake loader returning a tiny custom
 * entry, and the upstream MP4 fetch is a test seam. Verifies auth, id
 * validation, verify-before-reply failures (altered/oversize/wrong-type/timeout),
 * and temp cleanup after verification failure.
 *
 * Successful streamed responses are covered in integration tests because they
 * require Fastify streamed-response lifecycle / full inject consumption.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FastifyInstance } from "fastify";
import {
  configureRuntimeExplainerCatalog,
  resetRuntimeExplainerCatalog,
} from "@nautilo/agent";
import {
  ENTRY_ID,
  ORIGIN_ENV,
  TEST_ORIGIN,
  fakeLoader,
  makeApp,
  makeMedia,
  media,
  mp4Response,
} from "../helpers/explainer-media-route-fixture";
import type { ExplainerMediaRouteDeps } from "../../src/routes/explainer-media";

const originalOriginEnv = process.env[ORIGIN_ENV];
let scratchDir: string;

beforeEach(() => {
  process.env[ORIGIN_ENV] = TEST_ORIGIN;
  scratchDir = mkdtempSync(join(tmpdir(), "nautilo-explainer-route-"));
  configureRuntimeExplainerCatalog({ loader: fakeLoader() });
});

afterEach(async () => {
  resetRuntimeExplainerCatalog();
  if (originalOriginEnv === undefined) delete process.env[ORIGIN_ENV];
  else process.env[ORIGIN_ENV] = originalOriginEnv;
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

describe("GET /api/explainers/:id/media (D429 Phase 7.4.2) — error paths", () => {
  const instances: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(instances.splice(0).map((app) => app.close()));
  });

  function depsFor(
    fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  ): ExplainerMediaRouteDeps {
    return {
      fetchImpl,
      cacheDir: join(scratchDir, "cache"),
      tmpDir: join(scratchDir, "tmp"),
      timeoutMs: 1000,
      maxBytes: 1024 * 1024,
    };
  }

  test("rejects an unauthenticated request with 401", async () => {
    const app = await makeApp({ deps: depsFor(async () => mp4Response(media.bytes)) });
    instances.push(app);
    const res = await app.inject({ method: "GET", url: `/api/explainers/${ENTRY_ID}/media` });
    expect(res.statusCode).toBe(401);
    // No origin or media URL leaks on auth failure.
    expect(res.body).not.toContain(TEST_ORIGIN);
  });

  test("rejects a malformed id (traversal/URL-like) with 404", async () => {
    const app = await makeApp({ deps: depsFor(async () => mp4Response(media.bytes)) });
    instances.push(app);
    const badIds = ["..%2Fetc%2Fpasswd", "UPPER-CASE", "has space", "a".repeat(81)];
    for (const id of badIds) {
      const res = await app.inject({
        method: "GET",
        url: `/api/explainers/${encodeURIComponent(id)}/media`,
        headers: { "x-test-user": "user-1" },
      });
      expect(res.statusCode).toBe(404);
    }
  });

  test("rejects an unknown id with 404 (no silent local spoof)", async () => {
    const app = await makeApp({ deps: depsFor(async () => mp4Response(media.bytes)) });
    instances.push(app);
    const res = await app.inject({
      method: "GET",
      url: `/api/explainers/not-in-catalog/media`,
      headers: { "x-test-user": "user-1" },
    });
    expect(res.statusCode).toBe(404);
  });

  test("fails closed (502) when upstream returns wrong content-type", async () => {
    const app = await makeApp({
      deps: depsFor(async () =>
        new Response(media.bytes, { status: 200, headers: { "content-type": "text/html" } }),
      ),
    });
    instances.push(app);
    const res = await app.inject({
      method: "GET",
      url: `/api/explainers/${ENTRY_ID}/media`,
      headers: { "x-test-user": "user-1" },
    });
    expect(res.statusCode).toBe(502);
  });

  test("fails closed (502) when upstream bytes are altered (SHA mismatch)", async () => {
    const altered = makeMedia(media.bytes.length, /* different seed */ 99);
    const app = await makeApp({ deps: depsFor(async () => mp4Response(altered.bytes)) });
    instances.push(app);
    const res = await app.inject({
      method: "GET",
      url: `/api/explainers/${ENTRY_ID}/media`,
      headers: { "x-test-user": "user-1" },
    });
    expect(res.statusCode).toBe(502);
  });

  test("fails closed (502) when upstream is oversize", async () => {
    const oversize = makeMedia(media.bytes.length + 512);
    const app = await makeApp({ deps: depsFor(async () => mp4Response(oversize.bytes)) });
    instances.push(app);
    const res = await app.inject({
      method: "GET",
      url: `/api/explainers/${ENTRY_ID}/media`,
      headers: { "x-test-user": "user-1" },
    });
    expect(res.statusCode).toBe(502);
  });

  test("fails closed (502) when upstream returns non-200", async () => {
    const app = await makeApp({
      deps: depsFor(async () => new Response("nope", { status: 500 })),
    });
    instances.push(app);
    const res = await app.inject({
      method: "GET",
      url: `/api/explainers/${ENTRY_ID}/media`,
      headers: { "x-test-user": "user-1" },
    });
    expect(res.statusCode).toBe(502);
  });

  test("fails closed (502) on upstream timeout", async () => {
    const app = await makeApp({
      deps: {
        fetchImpl: () =>
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error("slow")), 2000)),
        cacheDir: join(scratchDir, "cache"),
        tmpDir: join(scratchDir, "tmp"),
        timeoutMs: 50,
        maxBytes: 1024 * 1024,
      },
    });
    instances.push(app);
    const res = await app.inject({
      method: "GET",
      url: `/api/explainers/${ENTRY_ID}/media`,
      headers: { "x-test-user": "user-1" },
    });
    expect(res.statusCode).toBe(502);
  });

  test("cleans up the temp spool dir after a verification failure", async () => {
    const tmp = join(scratchDir, "tmp");
    const altered = makeMedia(media.bytes.length, 99);
    const app = await makeApp({ deps: depsFor(async () => mp4Response(altered.bytes)) });
    instances.push(app);
    await app.inject({
      method: "GET",
      url: `/api/explainers/${ENTRY_ID}/media`,
      headers: { "x-test-user": "user-1" },
    });
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("rejects and cleans a concurrent invalid winner after promotion loses", async () => {
    const corrupt = makeMedia(media.bytes.length, 99);
    const deps = depsFor(async () => mp4Response(media.bytes));
    deps.renameImpl = (_tmpPath, finalPath) => {
      writeFileSync(finalPath, corrupt.bytes);
      const error = new Error("destination exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    };
    const app = await makeApp({ deps });
    instances.push(app);

    const res = await app.inject({
      method: "GET",
      url: `/api/explainers/${ENTRY_ID}/media`,
      headers: { "x-test-user": "user-1" },
    });

    expect(res.statusCode).toBe(502);
    expect(existsSync(join(scratchDir, "cache", `${media.sha256}.mp4`))).toBe(false);
    expect(readdirSync(join(scratchDir, "tmp"))).toEqual([]);
  });
});
