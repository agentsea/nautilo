/**
 * Integration test — D171 friendly "Workbench not served" HTML fallback.
 *
 * Originally lived in `tests/unit/workbench-not-served-fallback.test.ts`,
 * moved here because `createApp()` boots the full production app and
 * registers DB-backed startup observers (task engine, runtime telemetry,
 * etc.) — not unit-shaped.
 *
 * Tests run with `NAUTILO_WORKBENCH_DIST` unset/empty so the friendly
 * fallback branch in `createApp` is the one wired.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ensureDatabase } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../../src/app";

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
});

/**
 * D171 — the friendly "Workbench not served" HTML must apply ONLY to
 * `GET /`. Originally the fallback caught every unknown GET that wasn't
 * /api, /ws, or /relay, which silently turned retired routes (e.g. the
 * legacy `/setup` page deleted in D091) into 200 + branded HTML, masking
 * real 404s. PR #203 review (CI fail on health-keys.test.ts's
 * `GET /setup returns 404`) pinned the regression; this suite locks in
 * the narrow scope.
 */
describe("D171 friendly fallback — scope is GET / only", () => {
  const instances: Awaited<ReturnType<typeof createApp>>[] = [];
  const tempDirs: string[] = [];
  const prevDist = process.env["NAUTILO_WORKBENCH_DIST"];

  afterEach(async () => {
    await Promise.all(instances.splice(0).map((app) => app.close()));
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    if (prevDist === undefined) {
      delete process.env["NAUTILO_WORKBENCH_DIST"];
    } else {
      process.env["NAUTILO_WORKBENCH_DIST"] = prevDist;
    }
  });

  test("GET / returns 200 + friendly HTML (no bare JSON 404 leak)", async () => {
    delete process.env["NAUTILO_WORKBENCH_DIST"];
    const app = await createApp({ silent: true });
    instances.push(app);
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("NAUTILO_WORKBENCH_DIST");
    expect(res.body).not.toContain("Route GET:/ not found");
  });

  test("GET /setup returns 404 (retired route — not shadowed by fallback)", async () => {
    delete process.env["NAUTILO_WORKBENCH_DIST"];
    const app = await createApp({ silent: true });
    instances.push(app);
    const res = await app.inject({ method: "GET", url: "/setup" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
  });

  test("GET /api/unknown returns 404 JSON (API namespace honest)", async () => {
    delete process.env["NAUTILO_WORKBENCH_DIST"];
    const app = await createApp({ silent: true });
    instances.push(app);
    const res = await app.inject({ method: "GET", url: "/api/totally-not-a-route" });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { message: string };
    expect(body.message).toContain("not found");
  });

  test("GET /some-random-path returns 404 (not friendly HTML)", async () => {
    delete process.env["NAUTILO_WORKBENCH_DIST"];
    const app = await createApp({ silent: true });
    instances.push(app);
    const res = await app.inject({ method: "GET", url: "/random-deleted-page" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("NAUTILO_WORKBENCH_DIST");
  });

  test("POST / returns 404 (non-GET never gets HTML)", async () => {
    delete process.env["NAUTILO_WORKBENCH_DIST"];
    const app = await createApp({ silent: true });
    instances.push(app);
    const res = await app.inject({ method: "POST", url: "/" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("NAUTILO_WORKBENCH_DIST");
  });

  test("serves a mounted Workbench shell, deep links, and fingerprinted assets", async () => {
    const dist = await mkdtemp(join(tmpdir(), "nautilo-workbench-dist-"));
    tempDirs.push(dist);
    await mkdir(join(dist, "assets"));
    await writeFile(
      join(dist, "index.html"),
      '<!doctype html><html><body data-test="workbench-shell">Workbench</body></html>',
    );
    await writeFile(join(dist, "assets", "app-a1b2c3.js"), "export const ready = true;\n");
    process.env["NAUTILO_WORKBENCH_DIST"] = dist;

    const app = await createApp({ silent: true });
    instances.push(app);

    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.headers["content-type"]).toContain("text/html");
    expect(root.headers["cache-control"]).toBe("public, max-age=0");
    expect(root.body).toContain('data-test="workbench-shell"');

    const deepLink = await app.inject({ method: "GET", url: "/genie/example" });
    expect(deepLink.statusCode).toBe(200);
    expect(deepLink.headers["content-type"]).toContain("text/html");
    expect(deepLink.headers["cache-control"]).toBe("public, max-age=0");
    expect(deepLink.body).toContain('data-test="workbench-shell"');

    const asset = await app.inject({ method: "GET", url: "/assets/app-a1b2c3.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("javascript");
    expect(asset.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(asset.body).toContain("ready = true");

    const missingAsset = await app.inject({ method: "GET", url: "/assets/missing.js" });
    expect(missingAsset.statusCode).toBe(404);
    expect(missingAsset.body).not.toContain('data-test="workbench-shell"');

    const unknownApi = await app.inject({ method: "GET", url: "/api/not-a-route" });
    expect(unknownApi.statusCode).toBe(404);
    expect(unknownApi.body).not.toContain('data-test="workbench-shell"');

    const nonGet = await app.inject({ method: "POST", url: "/genie/example" });
    expect(nonGet.statusCode).toBe(404);
    expect(nonGet.body).not.toContain('data-test="workbench-shell"');
  });
});
