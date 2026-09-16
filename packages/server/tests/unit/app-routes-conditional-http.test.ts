import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { OutgoingHttpHeaders } from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appRoutes } from "../../src/apps/app-routes";
import { TEST_MINI_APP_MANIFEST } from "../helpers/test-mini-app-manifest";
import { resetInstalledAppRegistryForTests } from "../../src/apps/installed-app-registry";
import {
  PRIVATE_NO_STORE_CACHE_CONTROL,
  VARY_AUTHORIZATION,
} from "../../src/http/conditional-http";

const USER_WITH_MANAGE = "user-manage";
const USER_WITHOUT_MANAGE = "user-readonly";

let appsRoot = "";
let app: FastifyInstance;

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function writeTestApp(root: string): Promise<void> {
  const appDir = join(root, "test-canvas");
  await mkdir(join(appDir, "templates"), { recursive: true });
  await writeFile(join(appDir, "app.json"), `${JSON.stringify(TEST_MINI_APP_MANIFEST, null, 2)}\n`);
  await writeFile(join(appDir, "main.ts"), "export {};\n");
  await writeFile(
    join(appDir, "templates", "empty-spreadsheet.html"),
    '<!doctype html><script type="application/vnd.nautilo.document+json" id="manifest">{"documentType":"canvas","editor":"test-canvas","payloadId":"test-canvas-document","payloadFormat":"application/vnd.nautilo.test-canvas+json","version":"1.0"}</script>\n',
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
    request.sessionUserId = typeof header === "string" ? header : null;
    done();
  });
}

interface AppsListResponseBody {
  apps: unknown[];
}

interface AppDetailResponseBody {
  canEditSource: boolean;
  enabled?: boolean;
}

function expectConditionalHeaders(res: { headers: OutgoingHttpHeaders }): void {
  expect(res.headers["etag"]).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
  expect(res.headers["vary"]).toBe(VARY_AUTHORIZATION);
  expect(res.headers["cache-control"]).toBe(PRIVATE_NO_STORE_CACHE_CONTROL);
}

beforeEach(async () => {
  resetInstalledAppRegistryForTests();
  appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-routes-conditional-"));
  await writeTestApp(appsRoot);

  app = Fastify({ logger: false });
  installSessionPreHandler(app);
  appRoutes(app, {
    appsRoot,
    getCapabilities: async (userId) => {
      if (userId === USER_WITH_MANAGE) return ["manage_server_operations"];
      if (userId === USER_WITHOUT_MANAGE) return ["read_server_settings"];
      return [];
    },
  });
  await app.ready();
});

afterEach(async () => {
  if (app) await app.close();
  if (appsRoot) await rm(appsRoot, { recursive: true, force: true });
  resetInstalledAppRegistryForTests();
});

describe("/api/apps conditional HTTP (M213 Phase 8/9)", () => {
  test("list returns conditional headers on 200", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/apps",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
    });
    expect(res.statusCode).toBe(200);
    expectConditionalHeaders(res);
    expect((JSON.parse(res.body) as AppsListResponseBody).apps.length).toBeGreaterThan(0);
  });

  test("list returns empty 304 with conditional headers when If-None-Match matches", async () => {
    const first = await app.inject({
      method: "GET",
      url: "/api/apps",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
    });
    const etag = first.headers["etag"] as string;

    const second = await app.inject({
      method: "GET",
      url: "/api/apps",
      headers: {
        "x-test-user-id": USER_WITHOUT_MANAGE,
        "if-none-match": etag,
      },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
    expectConditionalHeaders(second);
    expect(second.headers["etag"]).toBe(etag);
  });

  test("detail returns empty 304 with conditional headers when If-None-Match matches", async () => {
    const first = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
    });
    const etag = first.headers["etag"] as string;

    const second = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas",
      headers: {
        "x-test-user-id": USER_WITHOUT_MANAGE,
        "if-none-match": etag,
      },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
    expectConditionalHeaders(second);
  });

  test("does not return 304 across different authorization projections", async () => {
    const readonly = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
    });
    const manager = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
    });
    const readonlyEtag = readonly.headers["etag"] as string;
    const managerEtag = manager.headers["etag"] as string;
    expect(readonlyEtag).not.toBe(managerEtag);

    const readonlyWithManagerEtag = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas",
      headers: {
        "x-test-user-id": USER_WITHOUT_MANAGE,
        "if-none-match": managerEtag,
      },
    });
    expect(readonlyWithManagerEtag.statusCode).toBe(200);
    expect((JSON.parse(readonlyWithManagerEtag.body) as AppDetailResponseBody).canEditSource).toBe(false);

    const managerWithReadonlyEtag = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas",
      headers: {
        "x-test-user-id": USER_WITH_MANAGE,
        "if-none-match": readonlyEtag,
      },
    });
    expect(managerWithReadonlyEtag.statusCode).toBe(200);
    expect((JSON.parse(managerWithReadonlyEtag.body) as AppDetailResponseBody).canEditSource).toBe(true);
  });

  test("registry invalidation after source write yields a different list ETag", async () => {
    const before = await app.inject({
      method: "GET",
      url: "/api/apps",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
    });
    const etagBefore = before.headers["etag"] as string;

    const readRes = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas/source/file?path=main.ts",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
    });
    const readBody = JSON.parse(readRes.body) as { sha256: string };
    const next = "export const saved = 1;\n";

    const saveRes = await app.inject({
      method: "PUT",
      url: "/api/apps/test-canvas/source/file?path=main.ts",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
      payload: { content: next, baseSha256: readBody.sha256 },
    });
    expect(saveRes.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: "/api/apps",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
    });
    expect(after.headers["etag"]).not.toBe(etagBefore);

    const stale304 = await app.inject({
      method: "GET",
      url: "/api/apps",
      headers: {
        "x-test-user-id": USER_WITH_MANAGE,
        "if-none-match": etagBefore,
      },
    });
    expect(stale304.statusCode).toBe(200);

    const onDisk = await readFile(join(appsRoot, "test-canvas", "main.ts"), "utf8");
    expect(onDisk).toBe(next);
    expect(sha256Hex(onDisk)).toBe(sha256Hex(next));
  });

  test("disable invalidates detail ETag and rejects stale If-None-Match", async () => {
    const before = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
    });
    const etagBefore = before.headers["etag"] as string;

    const disableRes = await app.inject({
      method: "POST",
      url: "/api/apps/test-canvas/disable",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
    });
    expect(disableRes.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
    });
    expect(after.headers["etag"]).not.toBe(etagBefore);
    expect((JSON.parse(after.body) as AppDetailResponseBody).enabled).toBe(false);

    const stale304 = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas",
      headers: {
        "x-test-user-id": USER_WITH_MANAGE,
        "if-none-match": etagBefore,
      },
    });
    expect(stale304.statusCode).toBe(200);
  });
});
