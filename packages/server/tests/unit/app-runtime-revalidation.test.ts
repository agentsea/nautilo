import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NautiloApiClient } from "@nautilo/api-client";
import { appRoutes } from "../../src/apps/app-routes";
import type { SuccessfulMiniAppBuild } from "../../src/apps/app-builder";
import { InstalledAppRegistry } from "../../src/apps/installed-app-registry";
import { MiniAppRuntimeBuildCache } from "../../src/apps/runtime-build-cache";

describe("authenticated runtime revalidation", () => {
  let app: FastifyInstance;
  let root: string;
  let build: SuccessfulMiniAppBuild;
  let buildAvailable: boolean;
  let hostGranted: boolean;
  let authorityChecks: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "runtime-revalidation-"));
    build = {
      ok: true, appId: "sample-app", sourceHash: "a".repeat(64),
      appRoot: root, cacheDir: root, html: "<p>Sample editor</p>",
      styles: [], bundleJs: "export {};",
      manifest: {
        id: "sample-app", name: "Sample App", version: "1.0.0",
        entry: "./main.ts", html: "./index.html", fileAssociations: {}, capabilities: {},
      },
      agentToolsBuild: { status: "none" },
    };
    buildAvailable = true;
    hostGranted = true;
    authorityChecks = 0;
    const registry = new InstalledAppRegistry({ scan: async () => [{
      id: build.appId, root, sourceHash: build.sourceHash, manifest: build.manifest,
      status: "ready", enabled: true, installedAt: null,
    }] });
    const cache = new MiniAppRuntimeBuildCache();
    spyOn(cache, "build").mockImplementation(async () => buildAvailable ? structuredClone(build) : {
      ok: false, appId: build.appId, sourceHash: build.sourceHash,
      status: "build_failed", message: "Runtime unavailable",
    });
    app = Fastify();
    app.decorateRequest("sessionUserId", null);
    app.addHook("preHandler", async (request) => {
      request.sessionUserId = request.headers.authorization === "Bearer session-a" ? "sample-user" : null;
    });
    appRoutes(app, {
      appsRoot: root, installedAppRegistry: registry, runtimeBuildCache: cache,
      getCapabilities: async () => [],
      resolveHostCapabilities: async () => {
        authorityChecks += 1;
        return hostGranted ? { mediaProxy: true } : undefined;
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const get = (app: FastifyInstance, etag?: string, authorization = "Bearer session-a") => app.inject({
    method: "GET", url: "/api/apps/sample-app/runtime",
    headers: { authorization, ...(etag ? { "if-none-match": etag } : {}) },
  });

  test("returns bodyless 304 only after current authentication and authority checks", async () => {
    const first = await get(app);
    expect(first.statusCode).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();
    const reopen = await get(app, etag);
    expect(reopen.statusCode).toBe(304);
    expect(reopen.body).toBe("");
    expect(reopen.headers["cache-control"]).toBe("private, no-store");
    expect(reopen.headers.vary).toBe("Authorization");
    expect(authorityChecks).toBe(2);
    expect((await get(app, etag, "Bearer revoked")).statusCode).toBe(401);
    hostGranted = false;
    const revoked = await get(app, etag);
    expect(revoked.statusCode).toBe(200);
    expect(revoked.headers.etag).not.toBe(etag);
    expect(revoked.json<{ hostCapabilities?: unknown }>().hostCapabilities).toBeUndefined();
    buildAvailable = false;
    expect((await get(app, revoked.headers.etag as string)).statusCode).toBe(500);
  });

  test.each(["html", "bundle", "manifest"])("invalidates changed %s even with the same source hash", async (change) => {
    const first = await get(app);
    if (change === "html") build.html = "<p>Updated editor</p>";
    if (change === "bundle") build.bundleJs = "export const updated = true;";
    if (change === "manifest") build.manifest.name = "Updated App";
    const changed = await get(app, first.headers.etag as string);
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(first.headers.etag);
    expect(changed.json<{ sourceHash: string }>().sourceHash).toBe(first.json<{ sourceHash: string }>().sourceHash);
  });

  test("client and route reopen without transferring the runtime body, then adopt new bytes", async () => {
    const transfers: { status: number; bytes: number }[] = [];
    const client = new NautiloApiClient("https://example.test", { fetchImpl: async (url, init) => {
      const response = await app.inject({
        method: "GET", url: new URL(url instanceof Request ? url.url : url).pathname,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      transfers.push({ status: response.statusCode, bytes: Buffer.byteLength(response.body) });
      return new Response(response.statusCode === 304 ? null : response.body, {
        status: response.statusCode,
        headers: { etag: response.headers.etag as string },
      });
    } });
    client.setToken("session-a");
    const first = await client.getMiniAppRuntime("sample-app");
    expect(await client.getMiniAppRuntime("sample-app")).toEqual(first);
    expect(transfers[0]!.bytes).toBeGreaterThan(0);
    expect(transfers[1]).toEqual({ status: 304, bytes: 0 });
    build.html = "<p>New version</p>";
    expect((await client.getMiniAppRuntime("sample-app")).srcDoc).toContain("New version");
    expect(transfers[2]!.status).toBe(200);
  });
});
