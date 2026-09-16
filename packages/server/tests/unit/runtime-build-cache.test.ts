import { describe, expect, test } from "bun:test";
import {
  miniAppRuntimeBuildCacheKey,
  miniAppRuntimeToolchainHash,
  type MiniAppBuildResult,
} from "../../src/apps/app-builder";
import type { RegisteredMiniApp } from "../../src/apps/app-registry";
import { MiniAppRuntimeBuildCache } from "../../src/apps/runtime-build-cache";

function readyApp(id: string, sourceHash: string): RegisteredMiniApp {
  return {
    id,
    root: `/apps/${id}`,
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      entry: "./main.ts",
      html: "./index.html",
      fileAssociations: {},
      capabilities: {},
    },
    status: "ready",
    sourceHash,
    installedAt: null,
    enabled: true,
  };
}

function successBuild(appId: string, sourceHash: string, token: string): MiniAppBuildResult {
  return {
    ok: true,
    appId,
    sourceHash,
    appRoot: `/apps/${appId}`,
    cacheDir: `/cache/${appId}/${sourceHash}`,
    html: `<html>${token}</html>`,
    styles: [{ path: "styles.css", content: `#app { color: ${token}; }` }],
    bundleJs: `export const token = ${JSON.stringify(token)};`,
    manifest: {
      id: appId,
      name: appId,
      version: "1.0.0",
      entry: "./main.ts",
      html: "./index.html",
      fileAssociations: {},
      capabilities: {},
    },
    agentToolsBuild: { status: "none" },
  };
}

describe("miniAppRuntimeBuildCacheKey", () => {
  test("includes appId and sourceHash and avoids cross-app collisions", () => {
    const toolchain = miniAppRuntimeToolchainHash();
    const alpha = miniAppRuntimeBuildCacheKey("alpha", "hash-a");
    const beta = miniAppRuntimeBuildCacheKey("beta", "hash-a");
    expect(alpha).not.toBe(beta);
    expect(alpha.endsWith(toolchain)).toBe(true);
    expect(miniAppRuntimeBuildCacheKey("alpha", "hash-b")).not.toBe(alpha);
  });
});

describe("MiniAppRuntimeBuildCache", () => {
  test("coalesces concurrent builds for the same key", async () => {
    let buildCount = 0;
    const cache = new MiniAppRuntimeBuildCache({
      build: async (app) => {
        buildCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return successBuild(app.id, app.sourceHash!, "one");
      },
    });

    const app = readyApp("test-canvas", "hash-1");
    const [a, b, c] = await Promise.all([
      cache.build(app, "/apps"),
      cache.build(app, "/apps"),
      cache.build(app, "/apps"),
    ]);

    expect(buildCount).toBe(1);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c.ok).toBe(true);
    if (a.ok && b.ok && c.ok) {
      expect(a.html).toBe(b.html);
      expect(b.html).toBe(c.html);
    }
  });

  test("reuses successful builds but not failed builds", async () => {
    let buildCount = 0;
    const cache = new MiniAppRuntimeBuildCache({
      build: async (app) => {
        buildCount += 1;
        if (buildCount === 1) {
          return {
            ok: false,
            appId: app.id,
            sourceHash: app.sourceHash,
            status: "build_failed",
            message: "boom",
          };
        }
        return successBuild(app.id, app.sourceHash!, "ok");
      },
    });

    const app = readyApp("test-canvas", "hash-1");
    const first = await cache.build(app, "/apps");
    const second = await cache.build(app, "/apps");

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(true);
    expect(buildCount).toBe(2);
  });

  test("uses distinct keys for source generations and app ids", async () => {
    let buildCount = 0;
    const cache = new MiniAppRuntimeBuildCache({
      build: async (app) => {
        buildCount += 1;
        return successBuild(app.id, app.sourceHash!, `build-${buildCount}`);
      },
    });

    const appA1 = readyApp("alpha", "hash-1");
    const appA2 = readyApp("alpha", "hash-2");
    const appB1 = readyApp("beta", "hash-1");

    const [a1, a2, b1] = await Promise.all([
      cache.build(appA1, "/apps"),
      cache.build(appA2, "/apps"),
      cache.build(appB1, "/apps"),
    ]);

    expect(buildCount).toBe(3);
    if (a1.ok && a2.ok && b1.ok) {
      expect(a1.html).toContain("build-1");
      expect(a2.html).toContain("build-2");
      expect(b1.html).toContain("build-3");
    }
  });

  test("returns cloned successful output safe from caller mutation", async () => {
    const cache = new MiniAppRuntimeBuildCache({
      build: async (app) => successBuild(app.id, app.sourceHash!, "token-a"),
    });

    const app = readyApp("test-canvas", "hash-1");
    const first = await cache.build(app, "/apps");
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    first.html = "mutated";
    first.styles[0]!.content = "mutated";
    first.manifest.name = "mutated";

    const second = await cache.build(app, "/apps");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.html).toContain("token-a");
    expect(second.styles[0]?.content).toContain("token-a");
    expect(second.manifest.name).toBe("test-canvas");
  });
});
