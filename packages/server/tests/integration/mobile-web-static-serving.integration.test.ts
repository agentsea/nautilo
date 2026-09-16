import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ensureDatabase } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../../src/app";
import { withListeningServer } from "./helpers/request-helpers";

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
});

describe("D515 Mobile Web static serving", () => {
  const instances: Awaited<ReturnType<typeof createApp>>[] = [];
  const tempDirs: string[] = [];
  const previousMobileDist = process.env["NAUTILO_MOBILE_WEB_DIST"];
  const previousWorkbenchDist = process.env["NAUTILO_WORKBENCH_DIST"];
  const previousLogtoEndpoint = process.env["LOGTO_ENDPOINT"];

  afterEach(async () => {
    await Promise.all(instances.splice(0).map((app) => app.close()));
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    if (previousMobileDist === undefined) delete process.env["NAUTILO_MOBILE_WEB_DIST"];
    else process.env["NAUTILO_MOBILE_WEB_DIST"] = previousMobileDist;
    if (previousWorkbenchDist === undefined) delete process.env["NAUTILO_WORKBENCH_DIST"];
    else process.env["NAUTILO_WORKBENCH_DIST"] = previousWorkbenchDist;
    if (previousLogtoEndpoint === undefined) delete process.env["LOGTO_ENDPOINT"];
    else process.env["LOGTO_ENDPOINT"] = previousLogtoEndpoint;
  });

  test("shows a bounded exact-entry diagnostic when the mobile export env is unset", async () => {
    const workbenchDist = await mkdtemp(join(tmpdir(), "nautilo-workbench-dist-"));
    tempDirs.push(workbenchDist);
    await mkdir(join(workbenchDist, "assets"));
    await writeFile(join(workbenchDist, "index.html"), '<main data-test="workbench-shell">Workbench</main>');
    delete process.env["NAUTILO_MOBILE_WEB_DIST"];
    process.env["NAUTILO_WORKBENCH_DIST"] = workbenchDist;
    const app = await createApp({ silent: true });
    instances.push(app);
    for (const url of ["/mobile", "/mobile/", "/mobile/?x=1"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(503);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.body).toContain("Mobile Web isn&apos;t available on this server");
      expect(response.body).toContain('href="/?nautilo-interface=workbench"');
      expect(response.body).not.toContain("mobile-shell");
      expect(response.body).not.toContain("workbench-shell");
    }
    for (const url of [
      "/mobile/_expo/static/missing.js",
      "/mobile/assets/missing.wasm",
      "/mobile/manifest.json",
      "/mobile/not-an-emitted-route",
      "/mobile/%2e%2e/api/health",
    ]) {
      const missing = await app.inject({ method: "GET", url });
      expect(missing.statusCode).toBe(404);
      expect(missing.headers["content-type"]).not.toContain("text/html");
      expect(missing.body).not.toContain("Mobile Web isn&apos;t available");
      expect(missing.body).not.toContain("workbench-shell");
    }
    const nonGet = await app.inject({ method: "POST", url: "/mobile/" });
    expect(nonGet.statusCode).toBe(404);
    expect(nonGet.headers["content-type"] ?? "").not.toContain("text/html");
    for (const url of ["/relay?x=1", "/api?x=1"]) {
      const guarded = await app.inject({ method: "GET", url });
      expect(guarded.statusCode).toBe(404);
      expect(guarded.body).not.toContain("workbench-shell");
    }
    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('data-test="workbench-shell"');
    const ws = await app.inject({ method: "GET", url: "/ws" });
    expect(ws.statusCode).not.toBe(200);
    expect(ws.body).not.toContain("workbench-shell");
    const relay = await app.inject({ method: "GET", url: "/relay" });
    expect(relay.statusCode).not.toBe(200);
    expect(relay.body).not.toContain("workbench-shell");
  });

  test("diagnoses a configured mobile export with no index.html", async () => {
    const mobileDist = await mkdtemp(join(tmpdir(), "nautilo-mobile-web-incomplete-"));
    tempDirs.push(mobileDist);
    process.env["NAUTILO_MOBILE_WEB_DIST"] = mobileDist;
    delete process.env["NAUTILO_WORKBENCH_DIST"];
    const app = await createApp({ silent: true });
    instances.push(app);
    const response = await app.inject({ method: "GET", url: "/mobile/" });
    expect(response.statusCode).toBe(503);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.body).toContain("configured Mobile Web export is incomplete");
    expect(response.body).not.toContain(mobileDist);
  });

  test("fails closed before static registration when an asset root is a regular file", async () => {
    const mobileDist = await mkdtemp(join(tmpdir(), "nautilo-mobile-web-invalid-root-"));
    const workbenchDist = await mkdtemp(join(tmpdir(), "nautilo-workbench-dist-"));
    tempDirs.push(mobileDist, workbenchDist);
    await mkdir(join(workbenchDist, "assets"));
    await writeFile(join(mobileDist, "index.html"), '<main data-test="mobile-index">Index</main>');
    await writeFile(join(mobileDist, "assets"), "not a directory");
    await writeFile(join(workbenchDist, "index.html"), '<main data-test="workbench-shell">Workbench</main>');
    process.env["NAUTILO_MOBILE_WEB_DIST"] = mobileDist;
    process.env["NAUTILO_WORKBENCH_DIST"] = workbenchDist;

    const app = await createApp({ silent: true });
    instances.push(app);

    const mobile = await app.inject({ method: "GET", url: "/mobile/" });
    expect(mobile.statusCode).toBe(503);
    expect(mobile.headers["content-type"]).toContain("text/html");
    expect(mobile.body).toContain("did not pass its static-asset validation");
    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('data-test="workbench-shell"');
    const api = await app.inject({ method: "GET", url: "/api/not-a-route" });
    expect(api.statusCode).toBe(404);
  });

  test("serves a mounted mobile export without taking over Workbench or API", async () => {
    const mobileDist = await mkdtemp(join(tmpdir(), "nautilo-mobile-web-dist-"));
    const workbenchDist = await mkdtemp(join(tmpdir(), "nautilo-workbench-dist-"));
    tempDirs.push(mobileDist, workbenchDist);
    await mkdir(join(mobileDist, "_expo", "static", "js", "web"), { recursive: true });
    await mkdir(join(mobileDist, "assets"), { recursive: true });
    await mkdir(join(mobileDist, "chat"), { recursive: true });
    await mkdir(join(workbenchDist, "assets"), { recursive: true });
    await writeFile(join(mobileDist, "index.html"), '<main data-test="mobile-index">Index</main>');
    await writeFile(join(mobileDist, "callback.html"), '<main data-test="mobile-callback">Callback</main>');
    await writeFile(join(mobileDist, "chat", "[roomId].html"), '<main data-test="mobile-room">Room</main>');
    await writeFile(join(mobileDist, "favicon.ico"), "ico");
    await writeFile(join(mobileDist, "_expo", "static", "js", "web", "index-0123456789abcdef0123456789abcdef.js"), "export const mobile = true;\n");
    await writeFile(join(mobileDist, "_expo", "static", "js", "web", "worker-0123456789abcdef0123456789abcdef.js"), "this is not valid JavaScript );\n");
    await writeFile(join(mobileDist, "assets", "parser.abcdef0123456789abcdef0123456789.wasm"), Buffer.from([0, 97, 115, 109]));
    await writeFile(join(mobileDist, "assets", "parser-valid.0123456789abcdef0123456789abcdef.wasm"), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    await writeFile(join(mobileDist, "assets", "parser-malformed.0123456789abcdef0123456789abcdef.wasm"), Buffer.from([0, 97, 115, 109, 1, 0, 0]));
    await writeFile(join(workbenchDist, "index.html"), '<main data-test="workbench-shell">Workbench</main>');
    await writeFile(join(workbenchDist, "assets", "app-a1.js"), "export const desktop = true;\n");
    process.env["NAUTILO_MOBILE_WEB_DIST"] = mobileDist;
    process.env["NAUTILO_WORKBENCH_DIST"] = workbenchDist;
    process.env["LOGTO_ENDPOINT"] = "https://auth.example.test/oidc";

    const app = await createApp({ silent: true });
    instances.push(app);

    const redirect = await app.inject({ method: "GET", url: "/mobile" });
    expect(redirect.statusCode).toBe(308);
    expect(redirect.headers.location).toBe("/mobile/");
    expect(redirect.headers["cache-control"]).toBe("no-store");
    expect(redirect.headers["content-security-policy"]).toBeUndefined();
    expect(redirect.headers["x-content-type-options"]).toBe("nosniff");

    for (const [url, marker] of [
      ["/mobile/", "mobile-index"],
      ["/mobile/?source=choice", "mobile-index"],
      ["/mobile/chat/room-1", "mobile-room"],
      ["/mobile/callback", "mobile-callback"],
      ["/mobile/callback/", "mobile-callback"],
    ] as const) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(response.headers["content-security-policy"]).toContain(
        "connect-src 'self' https://auth.example.test",
      );
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.body).toContain(`data-test="${marker}"`);
      expect(response.body).not.toContain("workbench-shell");
    }

    const js = await app.inject({ method: "GET", url: "/mobile/_expo/static/js/web/index-0123456789abcdef0123456789abcdef.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(js.headers["x-content-type-options"]).toBe("nosniff");
    expect(js.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(js.body).toContain("mobile = true");

    const malformedWorker = await app.inject({ method: "GET", url: "/mobile/_expo/static/js/web/worker-0123456789abcdef0123456789abcdef.js" });
    expect(malformedWorker.statusCode).toBe(200);
    expect(malformedWorker.headers["content-type"]).toContain("javascript");
    expect(malformedWorker.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(malformedWorker.headers["x-content-type-options"]).toBe("nosniff");
    expect(malformedWorker.headers["content-type"]).not.toContain("text/html");

    const wasm = await app.inject({ method: "GET", url: "/mobile/assets/parser.abcdef0123456789abcdef0123456789.wasm" });
    expect(wasm.statusCode).toBe(200);
    expect(wasm.headers["content-type"]).toContain("application/wasm");
    expect(wasm.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(wasm.headers["x-content-type-options"]).toBe("nosniff");

    const validWasmUrl = "/mobile/assets/parser-valid.0123456789abcdef0123456789abcdef.wasm";
    const validWasm = await app.inject({ method: "GET", url: validWasmUrl });
    expect(validWasm.statusCode).toBe(200);
    expect(validWasm.headers["content-type"]).toContain("application/wasm");
    expect(validWasm.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const malformedWasmUrl = "/mobile/assets/parser-malformed.0123456789abcdef0123456789abcdef.wasm";
    const malformedWasm = await app.inject({ method: "GET", url: malformedWasmUrl });
    expect(malformedWasm.statusCode).toBe(200);
    expect(malformedWasm.headers["content-type"]).toContain("application/wasm");
    expect(malformedWasm.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(malformedWasm.headers["x-content-type-options"]).toBe("nosniff");
    expect(malformedWasm.headers["content-type"]).not.toContain("text/html");

    const favicon = await app.inject({ method: "GET", url: "/mobile/favicon.ico" });
    expect(favicon.statusCode).toBe(200);
    expect(favicon.body).toBe("ico");
    expect(favicon.headers["cache-control"]).toBe("no-store");
    expect(favicon.headers["x-content-type-options"]).toBe("nosniff");

    for (const url of [
      "/mobile/_expo/static/js/web/missing.js",
      "/mobile/assets/missing.wasm",
      "/mobile/missing.css",
      "/mobile/missing.js.map",
      "/mobile/manifest.json",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-security-policy"]).toBeUndefined();
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.body).not.toContain("mobile-shell");
      expect(response.body).not.toContain("workbench-shell");
    }

    // `app.inject()` normalizes this malformed target to `/api/health` before
    // Fastify's request hooks. Preserve the important routing invariant here;
    // real raw-request header behavior belongs to an HTTP-level probe.
    const traversal = await app.inject({ method: "GET", url: "/mobile/%2e%2e/api/health" });
    expect(traversal.statusCode).toBe(404);
    expect(traversal.body).not.toContain("mobile-shell");
    expect(traversal.body).not.toContain("workbench-shell");

    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('data-test="workbench-shell"');
    expect(root.headers["content-security-policy"]).toBeUndefined();
    expect(root.headers["x-content-type-options"]).toBeUndefined();
    const api = await app.inject({ method: "GET", url: "/api/not-a-route" });
    expect(api.statusCode).toBe(404);
    expect(api.headers["content-security-policy"]).toBeUndefined();
    const ws = await app.inject({ method: "GET", url: "/ws" });
    expect(ws.statusCode).not.toBe(200);
    expect(ws.body).not.toContain("mobile-shell");
    const relay = await app.inject({ method: "GET", url: "/relay" });
    expect(relay.statusCode).not.toBe(200);
    expect(relay.body).not.toContain("mobile-shell");
    const unknownRelay = await app.inject({ method: "GET", url: "/relay/not-real" });
    expect(unknownRelay.statusCode).toBe(404);
    expect(unknownRelay.body).not.toContain("mobile-shell");
    expect(unknownRelay.body).not.toContain("workbench-shell");
    const nonGet = await app.inject({ method: "POST", url: "/mobile/chat/room-1" });
    expect(nonGet.statusCode).toBe(404);
    expect(nonGet.body).not.toContain("mobile-shell");

    // `app.inject()` verifies the static MIME/cache contract above. This real
    // HTTP round-trip additionally proves malformed bytes and a hard asset
    // miss fail as WASM loading failures rather than receiving either SPA HTML.
    const appIndex = instances.indexOf(app);
    expect(appIndex).toBeGreaterThanOrEqual(0);
    instances.splice(appIndex, 1);
    await withListeningServer(app, async (baseUrl) => {
      const validResponse = await fetch(`${baseUrl}${validWasmUrl}`);
      expect(validResponse.status).toBe(200);
      const validWasmBytes = await validResponse.clone().arrayBuffer();
      const validModule = await WebAssembly.compileStreaming(validResponse);
      expect(validModule).toBeInstanceOf(WebAssembly.Module);

      // Synthetic Bun client/runtime negative control only: this does not
      // represent a server MIME failure, which the real HTTP response above
      // already proves is served as application/wasm.
      const wrongMimeResponse = new Response(validWasmBytes, {
        headers: { "content-type": "application/octet-stream" },
      });
      const wrongMimeFailure = await WebAssembly.compileStreaming(wrongMimeResponse).catch((error: unknown) => error);
      expect(wrongMimeFailure).toBeInstanceOf(TypeError);

      const malformedResponse = await fetch(`${baseUrl}${malformedWasmUrl}`);
      expect(malformedResponse.status).toBe(200);
      expect(malformedResponse.headers.get("content-type")).toContain("application/wasm");
      expect(malformedResponse.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      const malformedFailure = await WebAssembly.compileStreaming(malformedResponse).catch((error: unknown) => error);
      expect(malformedFailure).toBeInstanceOf(WebAssembly.CompileError);

      const missingResponse = await fetch(`${baseUrl}/mobile/assets/missing.wasm`);
      expect(missingResponse.status).toBe(404);
      expect(missingResponse.headers.get("content-type") ?? "").not.toContain("text/html");
      expect(missingResponse.headers.get("cache-control")).toBe("no-store");
      const missingFailure = await WebAssembly.compileStreaming(missingResponse).catch((error: unknown) => error);
      expect(missingFailure).toBeInstanceOf(TypeError);
    });
  });

  test("diagnoses an invalid generated export without leaking its filename", async () => {
    const mobileDist = await mkdtemp(join(tmpdir(), "nautilo-mobile-web-invalid-"));
    tempDirs.push(mobileDist);
    await mkdir(join(mobileDist, "assets"));
    await writeFile(join(mobileDist, "index.html"), '<main data-test="mobile-index">Index</main>');
    await writeFile(join(mobileDist, "assets", "operator-private.wasm"), Buffer.from([0, 97, 115, 109]));
    process.env["NAUTILO_MOBILE_WEB_DIST"] = mobileDist;
    delete process.env["NAUTILO_WORKBENCH_DIST"];
    const app = await createApp({ silent: true });
    instances.push(app);
    const response = await app.inject({ method: "GET", url: "/mobile/" });
    expect(response.statusCode).toBe(503);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toContain("did not pass its static-asset validation");
    expect(response.body).not.toContain("operator-private.wasm");
    expect(response.body).not.toContain("mobile-index");
  });
});
