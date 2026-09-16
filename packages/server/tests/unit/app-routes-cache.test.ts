import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMiniAppSource } from "../../src/apps/app-authoring-store";
import { appRoutes } from "../../src/apps/app-routes";
import { TEST_MINI_APP_MANIFEST } from "../helpers/test-mini-app-manifest";
import {
  InstalledAppRegistry,
  resetInstalledAppRegistryForTests,
} from "../../src/apps/installed-app-registry";
import { MiniAppRuntimeBuildCache } from "../../src/apps/runtime-build-cache";

const USER_WITH_MANAGE = "user-manage";

const PAINT_DEMO_FILES = [
  {
    path: "app.json",
    content: `${JSON.stringify(
      {
        id: "paint-demo",
        name: "Paint Demo",
        version: "0.1.0",
        entry: "./main.ts",
        html: "./index.html",
        styles: ["./styles.css"],
        fileAssociations: { extensions: [], mimeTypes: [] },
        capabilities: { document: { artifact: "readwrite" }, state: "readwrite" },
      },
      null,
      2,
    )}\n`,
  },
  {
    path: "index.html",
    content: `<!DOCTYPE html><html><body><canvas id="paint-canvas"></canvas></body></html>\n`,
  },
  { path: "main.ts", content: "export {};\n" },
  { path: "styles.css", content: "canvas { display: block; }\n" },
];

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function writeTestApp(root: string): Promise<void> {
  const appDir = join(root, "test-canvas");
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "app.json"), `${JSON.stringify(TEST_MINI_APP_MANIFEST, null, 2)}\n`);
  await writeFile(join(appDir, "main.ts"), "export {};\n");
  await writeFile(
    join(appDir, "index.html"),
    `<!DOCTYPE html><html><body><div id="app"></div></body></html>\n`,
  );
  await writeFile(
    join(appDir, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
}

function installSessionPreHandler(instance: FastifyInstance): void {
  instance.decorateRequest("sessionUserId", null);
  instance.addHook("preHandler", (request, _reply, done) => {
    const header = request.headers["x-test-user-id"];
    request.sessionUserId = typeof header === "string" ? header : "user-1";
    done();
  });
}

describe("app-routes installed-app registry integration", () => {
  let appsRoot = "";
  let app: FastifyInstance;
  let scanCount = 0;
  let buildCount = 0;
  let installedAppRegistry: InstalledAppRegistry;
  let runtimeBuildCache: MiniAppRuntimeBuildCache;

  beforeEach(async () => {
    resetInstalledAppRegistryForTests();
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-routes-cache-"));
    await writeTestApp(appsRoot);
    scanCount = 0;
    buildCount = 0;

    installedAppRegistry = new InstalledAppRegistry({
      scan: async (root) => {
        scanCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        const { scanInstalledApps } = await import("../../src/apps/app-registry");
        return scanInstalledApps(root);
      },
    });

    runtimeBuildCache = new MiniAppRuntimeBuildCache({
      build: async (registeredApp, root) => {
        buildCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        const { buildMiniApp } = await import("../../src/apps/app-builder");
        return buildMiniApp(registeredApp, root);
      },
    });

    app = Fastify({ logger: false });
    installSessionPreHandler(app);
    appRoutes(app, {
      appsRoot,
      installedAppRegistry,
      runtimeBuildCache,
      getCapabilities: async () => [],
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
    if (appsRoot) await rm(appsRoot, { recursive: true, force: true });
    resetInstalledAppRegistryForTests();
  });

  test("concurrent list/detail/runtime requests share one scan per generation", async () => {
    const headers = { "x-test-user-id": "user-1" };
    const [list, detail, runtime] = await Promise.all([
      app.inject({ method: "GET", url: "/api/apps", headers }),
      app.inject({ method: "GET", url: "/api/apps/test-canvas", headers }),
      app.inject({ method: "GET", url: "/api/apps/test-canvas/runtime", headers }),
    ]);

    expect(list.statusCode).toBe(200);
    expect(detail.statusCode).toBe(200);
    expect(runtime.statusCode).toBeGreaterThanOrEqual(400);
    expect(scanCount).toBe(1);
    expect(buildCount).toBe(1);
  });
});

describe("process-wide installed-app registry invalidation", () => {
  let appsRoot = "";
  let app: FastifyInstance;

  beforeEach(async () => {
    resetInstalledAppRegistryForTests();
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-routes-cache-invalidate-"));
    await writeTestApp(appsRoot);

    app = Fastify({ logger: false });
    installSessionPreHandler(app);
    appRoutes(app, {
      appsRoot,
      getCapabilities: async (userId) =>
        userId === USER_WITH_MANAGE ? ["manage_server_operations"] : [],
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
    if (appsRoot) await rm(appsRoot, { recursive: true, force: true });
    resetInstalledAppRegistryForTests();
  });

  async function listAppIds(): Promise<string[]> {
    const res = await app.inject({
      method: "GET",
      url: "/api/apps",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { apps: Array<{ id: string }> };
    return body.apps.map((entry) => entry.id).sort();
  }

  test("agent authoring create invalidates warmed /api/apps cache", async () => {
    const warmIds = await listAppIds();
    expect(warmIds).toEqual(["test-canvas"]);

    await createMiniAppSource(
      appsRoot,
      { appId: "paint-demo", files: PAINT_DEMO_FILES },
      {
        registerAppTools: async () => ({
          status: "none",
          appId: "paint-demo",
        }),
      },
    );

    const afterIds = await listAppIds();
    expect(afterIds).toEqual(["paint-demo", "test-canvas"]);
  });

  test("source write invalidates warmed /api/apps cache", async () => {
    const warm = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
    });
    expect(warm.statusCode).toBe(200);
    const warmBody = JSON.parse(warm.body) as { version: string | null; sourceHash: string | null };
    expect(warmBody.version).toBe("1.0.0");

    const manifestPath = join(appsRoot, "test-canvas", "app.json");
    const manifestContent = await readFile(manifestPath, "utf8");
    const updatedManifest = {
      ...(JSON.parse(manifestContent) as Record<string, unknown>),
      version: "1.0.1",
    };
    const updatedContent = `${JSON.stringify(updatedManifest, null, 2)}\n`;
    const baseSha256 = sha256Hex(manifestContent);

    const writeRes = await app.inject({
      method: "PUT",
      url: "/api/apps/test-canvas/source/file?path=app.json",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
      payload: { content: updatedContent, baseSha256 },
    });
    expect(writeRes.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
    });
    expect(after.statusCode).toBe(200);
    const afterBody = JSON.parse(after.body) as { version: string | null; sourceHash: string | null };
    expect(afterBody.version).toBe("1.0.1");
    expect(afterBody.sourceHash).not.toBe(warmBody.sourceHash);
  });

  test("enable and disable invalidate warmed /api/apps cache", async () => {
    const warm = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
    });
    expect(warm.statusCode).toBe(200);
    expect((JSON.parse(warm.body) as { enabled: boolean }).enabled).toBe(true);

    const disableRes = await app.inject({
      method: "POST",
      url: "/api/apps/test-canvas/disable",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
    });
    expect(disableRes.statusCode).toBe(200);
    expect((JSON.parse(disableRes.body) as { enabled: boolean }).enabled).toBe(false);

    const disabledList = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
    });
    expect((JSON.parse(disabledList.body) as { enabled: boolean }).enabled).toBe(false);

    const enableRes = await app.inject({
      method: "POST",
      url: "/api/apps/test-canvas/enable",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
    });
    expect(enableRes.statusCode).toBe(200);
    expect((JSON.parse(enableRes.body) as { enabled: boolean }).enabled).toBe(true);

    const enabledList = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
    });
    expect((JSON.parse(enabledList.body) as { enabled: boolean }).enabled).toBe(true);
  });
});
