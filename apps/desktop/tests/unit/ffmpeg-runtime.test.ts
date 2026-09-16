import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  probeDesktopFfmpeg,
  resetDesktopFfmpegProbeCache,
} from "../../electron/ffmpeg-runtime.ts";

const PINNED_SHA256 = "a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584";
let tempRoot = "";

function makeTempRoot(): string {
  tempRoot = join(tmpdir(), `ffmpeg-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tempRoot, { recursive: true });
  return tempRoot;
}

function writeRuntimeManifest(filePath: string, platformKey: "darwin-arm64" | "darwin-x64"): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    JSON.stringify({
      ffmpeg: {
        version: "9.0.1",
        license: "LGPL-3.0-or-later",
        source: "https://github.com/ispysoftware/agentdvr-ffmpeg-build",
        binaryName: "ffmpeg",
        artifacts: {
          [platformKey]: {
            url: "https://example.test/ffmpeg",
            sha256: "f".repeat(64),
            binarySha256: PINNED_SHA256,
            sizeMin: 1,
          },
        },
      },
    }),
  );
}

afterEach(() => {
  resetDesktopFfmpegProbeCache();
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = "";
});

describe("probeDesktopFfmpeg", () => {
  test("fails closed when the managed binary is absent", async () => {
    const root = makeTempRoot();
    const probe = await probeDesktopFfmpeg({
      resourcesPath: join(root, "resources"),
      devVendorRoot: join(root, "vendor"),
      platformKey: "darwin-arm64",
      isPackaged: false,
      environment: {},
    });

    expect(probe).toMatchObject({ ok: false, code: "FFMPEG_MISSING" });
  });

  test("accepts only an explicitly developer-mode unverified override last", async () => {
    const root = makeTempRoot();
    const override = join(root, "ffmpeg-dev");
    writeFileSync(override, "developer binary");

    const probe = await probeDesktopFfmpeg({
      resourcesPath: join(root, "resources"),
      devVendorRoot: join(root, "vendor"),
      platformKey: "darwin-arm64",
      isPackaged: false,
      environment: { NAUTILO_FFMPEG_BIN: override },
    });

    expect(probe).toMatchObject({
      ok: true,
      binaryPath: override,
      source: "dev-override",
      unverified: true,
    });
  });

  test("rejects the developer override whenever Electron reports packaged", async () => {
    const root = makeTempRoot();
    const override = join(root, "ffmpeg-dev");
    writeFileSync(override, "developer binary");

    const probe = await probeDesktopFfmpeg({
      resourcesPath: join(root, "resources"),
      devVendorRoot: join(root, "vendor"),
      platformKey: "darwin-x64",
      isPackaged: true,
      environment: { NODE_ENV: "development", NAUTILO_FFMPEG_BIN: override },
    });

    expect(probe).toMatchObject({ ok: false, code: "FFMPEG_MISSING" });
  });

  test("fails closed for a packaged binary when its shipped checksum manifest is absent", async () => {
    const root = makeTempRoot();
    const resourcesPath = join(root, "resources");
    const binary = join(resourcesPath, "tools-ffmpeg", "arm64", "bin", "ffmpeg");
    mkdirSync(join(binary, ".."), { recursive: true });
    writeFileSync(binary, "packaged binary");

    const probe = await probeDesktopFfmpeg({
      resourcesPath,
      devVendorRoot: join(root, "vendor"),
      platformKey: "darwin-arm64",
      isPackaged: true,
      environment: {},
    });

    expect(probe).toMatchObject({ ok: false, code: "FFMPEG_UNAVAILABLE" });
    if (!probe.ok) expect(probe.error).toContain("checksum metadata");
  });

  test("uses the shipped packaged manifest, not the development vendor manifest", async () => {
    const root = makeTempRoot();
    const resourcesPath = join(root, "resources");
    const binary = join(resourcesPath, "tools-ffmpeg", "arm64", "bin", "ffmpeg");
    mkdirSync(join(binary, ".."), { recursive: true });
    writeFileSync(binary, "packaged binary");
    writeRuntimeManifest(join(resourcesPath, "tools-ffmpeg", "manifest.json"), "darwin-arm64");

    const probe = await probeDesktopFfmpeg({
      resourcesPath,
      devVendorRoot: join(root, "missing-vendor"),
      platformKey: "darwin-arm64",
      isPackaged: true,
      environment: {},
      verifyFile: async (file, sha) => {
        if (file.endsWith("/bin/ffmpeg")) expect(sha).toBe(PINNED_SHA256);
        return true;
      },
    });

    expect(probe).toMatchObject({ ok: true, binaryPath: binary, source: "managed", unverified: false });
  });

  test("uses the development vendor manifest for an unpackaged runtime", async () => {
    const root = makeTempRoot();
    const vendorRoot = join(root, "vendor");
    const binary = join(vendorRoot, "ffmpeg", "arm64", "bin", "ffmpeg");
    mkdirSync(join(binary, ".."), { recursive: true });
    writeFileSync(binary, "development binary");
    writeRuntimeManifest(join(vendorRoot, "tool-runtimes.manifest.json"), "darwin-arm64");

    const probe = await probeDesktopFfmpeg({
      resourcesPath: join(root, "missing-resources"),
      devVendorRoot: vendorRoot,
      platformKey: "darwin-arm64",
      isPackaged: false,
      environment: {},
      verifyFile: async (file, sha) => {
        if (file.endsWith("/bin/ffmpeg")) expect(sha).toBe(PINNED_SHA256);
        return true;
      },
    });

    expect(probe).toMatchObject({ ok: true, binaryPath: binary, source: "managed", unverified: false });
  });
  test("a missing or altered shared library refuses the managed runtime", async () => {
    const root = makeTempRoot(); const resourcesPath = join(root, "resources");
    const binary = join(resourcesPath, "tools-ffmpeg", "arm64", "bin", "ffmpeg");
    mkdirSync(join(binary, ".."), { recursive: true }); writeFileSync(binary, "fixture");
    writeRuntimeManifest(join(resourcesPath, "tools-ffmpeg", "manifest.json"), "darwin-arm64");
    const result = await probeDesktopFfmpeg({ isPackaged: true, resourcesPath, platformKey: "darwin-arm64", environment: {},
      verifyFile: async file => !file.includes("/lib/"),
    });
    expect(result).toMatchObject({ ok: false, code: "FFMPEG_UNAVAILABLE" });
  });

});
