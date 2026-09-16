/**
 * M206 Phase 3 — desktop bundled-runtime path resolver.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectDesktopPlatformKey,
  resolveDesktopOfficeCliPath,
  resolveDesktopRuntimePath,
} from "../../electron/tool-runtime-resolver";
import { resolveApplyPatchDesktopRuntime } from "../../electron/apply-patch-runtime";

function makeTempRoot(prefix: string): string {
  const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

describe("detectDesktopPlatformKey", () => {
  test("maps darwin hosts to darwin-* keys", () => {
    expect(detectDesktopPlatformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(detectDesktopPlatformKey("darwin", "x64")).toBe("darwin-x64");
  });

  test("returns null for non-darwin hosts", () => {
    expect(detectDesktopPlatformKey("linux", "x64")).toBeNull();
    expect(detectDesktopPlatformKey("win32", "x64")).toBeNull();
  });
});

describe("resolveDesktopRuntimePath — officecli", () => {
  let tempRoot = "";
  let devVendorRoot = "";
  let resourcesPath = "";

  afterEach(() => {
    if (tempRoot && existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("resolves darwin-arm64 from dev vendor platform-key layout", () => {
    tempRoot = makeTempRoot("officecli-arm64");
    devVendorRoot = join(tempRoot, "vendor");
    const binPath = join(devVendorRoot, "officecli", "darwin-arm64", "officecli");
    mkdirSync(join(binPath, ".."), { recursive: true });
    writeFileSync(binPath, "fake-binary");

    const outcome = resolveDesktopRuntimePath({
      runtime: "officecli",
      resourcesPath: null,
      devVendorRoot,
      platformKey: "darwin-arm64",
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.path).toBe(binPath);
      expect(outcome.result.source).toBe("dev-vendor");
    }
  });

  test("resolves darwin-x64 from packaged tools-officecli layout", () => {
    tempRoot = makeTempRoot("officecli-x64");
    devVendorRoot = join(tempRoot, "vendor");
    resourcesPath = join(tempRoot, "resources");
    const binPath = join(resourcesPath, "tools-officecli", "darwin-x64", "officecli");
    mkdirSync(join(binPath, ".."), { recursive: true });
    writeFileSync(binPath, "fake-binary");

    const outcome = resolveDesktopRuntimePath({
      runtime: "officecli",
      resourcesPath,
      devVendorRoot,
      platformKey: "darwin-x64",
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.path).toBe(binPath);
      expect(outcome.result.source).toBe("bundled");
    }
  });

  test("fails closed when officecli is missing", () => {
    tempRoot = makeTempRoot("officecli-missing");
    devVendorRoot = join(tempRoot, "vendor");
    mkdirSync(devVendorRoot, { recursive: true });

    const outcome = resolveDesktopRuntimePath({
      runtime: "officecli",
      resourcesPath: null,
      devVendorRoot,
      platformKey: "darwin-arm64",
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.runtime).toBe("officecli");
      expect(outcome.error).toContain("darwin-arm64");
      expect(outcome.error).toContain("vendor/officecli/darwin-arm64/officecli");
    }

    expect(
      resolveDesktopOfficeCliPath({
        resourcesPath: null,
        devVendorRoot,
        platformKey: "darwin-arm64",
      }),
    ).toBeNull();
  });
});

describe("resolveDesktopRuntimePath — legacy arch layout tools", () => {
  let tempRoot = "";
  let devVendorRoot = "";

  afterEach(() => {
    if (tempRoot && existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("maps darwin-arm64 to arm64 vendor dir for agent-browser", () => {
    tempRoot = makeTempRoot("agent-browser-arm64");
    devVendorRoot = join(tempRoot, "vendor");
    const binPath = join(devVendorRoot, "agent-browser", "arm64", "agent-browser");
    mkdirSync(join(binPath, ".."), { recursive: true });
    writeFileSync(binPath, "fake-binary");

    const outcome = resolveDesktopRuntimePath({
      runtime: "agent-browser",
      resourcesPath: null,
      devVendorRoot,
      platformKey: "darwin-arm64",
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.path).toBe(binPath);
    }
  });

  test("maps darwin-x64 to x64 managed FFmpeg resource dir", () => {
    tempRoot = makeTempRoot("ffmpeg-x64");
    devVendorRoot = join(tempRoot, "vendor");
    const resourcesPath = join(tempRoot, "resources");
    const binPath = join(resourcesPath, "tools-ffmpeg", "x64", "bin", "ffmpeg");
    mkdirSync(join(binPath, ".."), { recursive: true });
    writeFileSync(binPath, "fake-binary");

    const outcome = resolveDesktopRuntimePath({
      runtime: "ffmpeg",
      resourcesPath,
      devVendorRoot,
      platformKey: "darwin-x64",
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.path).toBe(binPath);
      expect(outcome.result.source).toBe("bundled");
    }
  });
});

describe("resolveApplyPatchDesktopRuntime", () => {
  test("returns an explicit unavailable outcome for headless, Windows, Linux, and mobile relay platforms", () => {
    for (const [platform, arch] of [["linux", "x64"], ["win32", "x64"], ["aix", "ppc64"], ["android", "arm64"]] as const) {
      const resolution = resolveApplyPatchDesktopRuntime({
        resourcesPath: null,
        devVendorRoot: "/trusted/vendor",
        platform,
        arch,
      });
      expect(resolution).toEqual({
        ok: false,
        code: "runtime_unavailable",
        reason: "PLATFORM_UNSUPPORTED",
        message: "Nautilo apply-patch runtime is unavailable on this relay platform.",
      });
    }
  });

  test("never falls back to PATH when the Darwin manifest is absent", () => {
    const resolution = resolveApplyPatchDesktopRuntime({
      resourcesPath: null,
      devVendorRoot: "/definitely-not-a-vendor-root",
      platform: "darwin",
      arch: "arm64",
    });
    expect(resolution).toEqual({
      ok: false,
      code: "runtime_unavailable",
      reason: "MANIFEST_MISSING",
      message: "Nautilo apply-patch runtime manifest is unavailable.",
    });
  });
});
