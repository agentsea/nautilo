/**
 * M206 Phase 3 — desktop OfficeCLI probe + canRunOffice advertisement.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getCachedCanRunOffice,
  officeRuntimeCapabilities,
  probeDesktopOfficeCli,
  resetDesktopOfficeCliProbeCache,
} from "../../electron/office-runtime.ts";
import { detectDesktopPlatformKey } from "../../electron/tool-runtime-resolver.ts";

function makeTempRoot(prefix: string): string {
  const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

afterEach(() => {
  resetDesktopOfficeCliProbeCache();
});

describe("probeDesktopOfficeCli (M206)", () => {
  let tempRoot = "";

  afterEach(() => {
    if (tempRoot && existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("fails closed when bundled binary is missing", async () => {
    tempRoot = makeTempRoot("office-probe-missing");
    const resourcesPath = join(tempRoot, "resources");
    const emptyVendorRoot = join(tempRoot, "empty-vendor");
    mkdirSync(resourcesPath, { recursive: true });
    mkdirSync(emptyVendorRoot, { recursive: true });

    const probe = await probeDesktopOfficeCli({
      resourcesPath,
      devVendorRoot: emptyVendorRoot,
      platformKey: "darwin-arm64",
    });

    expect(probe.canRunOffice).toBe(false);
    expect(probe.binaryPath).toBeNull();
    expect(probe.error).toContain("darwin-arm64");
    expect(getCachedCanRunOffice()).toBe(false);
  });

  test("officeRuntimeCapabilities omits canRunOffice when probe fails", async () => {
    tempRoot = makeTempRoot("office-probe-caps");
    const resourcesPath = join(tempRoot, "resources");
    const emptyVendorRoot = join(tempRoot, "empty-vendor");
    mkdirSync(resourcesPath, { recursive: true });
    mkdirSync(emptyVendorRoot, { recursive: true });

    const caps = await officeRuntimeCapabilities({
      resourcesPath,
      devVendorRoot: emptyVendorRoot,
      platformKey: "darwin-arm64",
    });
    expect(caps.canRunOffice).toBeUndefined();
  });

  test("fails closed when platform key is unsupported", () => {
    expect(detectDesktopPlatformKey("linux", "x64")).toBeNull();
    expect(detectDesktopPlatformKey("win32", "x64")).toBeNull();
  });
});

describe("resolveDesktopOfficeCliPath integration (M206)", () => {
  test("darwin-arm64 and darwin-x64 resolve distinct platform-key layouts", async () => {
    const { resolveDesktopOfficeCliPath } = await import("../../electron/tool-runtime-resolver.ts");
    const tempRoot = makeTempRoot("office-probe-layouts");
    try {
      const devVendorRoot = join(tempRoot, "vendor");
      const armPath = join(devVendorRoot, "officecli", "darwin-arm64", "officecli");
      const x64Resources = join(tempRoot, "resources");
      const x64Path = join(x64Resources, "tools-officecli", "darwin-x64", "officecli");
      mkdirSync(join(armPath, ".."), { recursive: true });
      mkdirSync(join(x64Path, ".."), { recursive: true });
      writeFileSync(armPath, "arm-binary");
      writeFileSync(x64Path, "x64-binary");

      expect(
        resolveDesktopOfficeCliPath({
          resourcesPath: null,
          devVendorRoot,
          platformKey: "darwin-arm64",
        })?.path,
      ).toBe(armPath);

      expect(
        resolveDesktopOfficeCliPath({
          resourcesPath: x64Resources,
          devVendorRoot,
          platformKey: "darwin-x64",
        })?.path,
      ).toBe(x64Path);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
