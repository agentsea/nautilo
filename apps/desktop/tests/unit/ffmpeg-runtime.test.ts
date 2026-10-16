import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  detectDesktopFfmpegPlatformKey,
  probeDesktopFfmpeg,
  resetDesktopFfmpegProbeCache,
} from "../../electron/ffmpeg-runtime.ts";
import { acceptsReplacedFfmpeg, verifyFfmpegFile } from "../../electron/ffmpeg-integrity";
import { detectDesktopPlatformKey } from "../../electron/tool-runtime-resolver.ts";
import type { ToolRuntimePlatformKey } from "../../electron/tool-runtimes-manifest.ts";
import ffmpegDistribution from "../../scripts/ffmpeg-distribution.json";

const PINNED_SHA256 = "a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584";
let tempRoot = "";

function makeTempRoot(): string {
  tempRoot = join(tmpdir(), `ffmpeg-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tempRoot, { recursive: true });
  return tempRoot;
}

function writeRuntimeManifest(filePath: string, platformKey: ToolRuntimePlatformKey): void {
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
        if (file.endsWith(join("bin", "ffmpeg"))) expect(sha).toBe(PINNED_SHA256);
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
        if (file.endsWith(join("bin", "ffmpeg"))) expect(sha).toBe(PINNED_SHA256);
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
      verifyFile: async file => !file.includes(`${sep}lib${sep}`),
    });
    expect(result).toMatchObject({ ok: false, code: "FFMPEG_UNAVAILABLE" });
  });

  test("a packaged Windows runtime verifies ffmpeg.exe and every DLL beside it", async () => {
    const root = makeTempRoot(); const resourcesPath = join(root, "resources");
    const binary = join(resourcesPath, "tools-ffmpeg", "win-x64", "bin", "ffmpeg.exe");
    mkdirSync(join(binary, ".."), { recursive: true }); writeFileSync(binary, "fixture");
    writeRuntimeManifest(join(resourcesPath, "tools-ffmpeg", "manifest.json"), "win-x64");
    const verified = new Map<string, string>();
    const result = await probeDesktopFfmpeg({ isPackaged: true, resourcesPath, platformKey: "win-x64", environment: {},
      verifyFile: async (file, sha) => { verified.set(file, sha); return true; },
    });
    expect(result).toMatchObject({ ok: true, binaryPath: binary, source: "managed" });
    expect(verified.get(binary)).toBe(PINNED_SHA256);
    const dlls = ffmpegDistribution.binaries.filter(file => file.path.startsWith("win-x64/") && file.path.endsWith(".dll"));
    expect(dlls).toHaveLength(9);
    for (const dll of dlls) expect(verified.get(join(resourcesPath, "tools-ffmpeg", dll.path))).toBe(dll.sha256);
    expect([...verified.keys()].every(file => file.includes(`${sep}win-x64${sep}`))).toBe(true);
  });

  test("an altered Windows DLL refuses the managed runtime", async () => {
    const root = makeTempRoot(); const resourcesPath = join(root, "resources");
    const binary = join(resourcesPath, "tools-ffmpeg", "win-x64", "bin", "ffmpeg.exe");
    mkdirSync(join(binary, ".."), { recursive: true }); writeFileSync(binary, "fixture");
    writeRuntimeManifest(join(resourcesPath, "tools-ffmpeg", "manifest.json"), "win-x64");
    const result = await probeDesktopFfmpeg({ isPackaged: true, resourcesPath, platformKey: "win-x64", environment: {},
      verifyFile: async file => !file.endsWith("avcodec-63.dll"),
    });
    expect(result).toMatchObject({ ok: false, code: "FFMPEG_UNAVAILABLE" });
  });

  test("a packaged Windows runtime lets the integrity check accept replaced LGPL files only for an unsigned app", async () => {
    const root = makeTempRoot(); const resourcesPath = join(root, "resources");
    const binary = join(resourcesPath, "tools-ffmpeg", "win-x64", "bin", "ffmpeg.exe");
    mkdirSync(join(binary, ".."), { recursive: true }); writeFileSync(binary, "fixture");
    writeRuntimeManifest(join(resourcesPath, "tools-ffmpeg", "manifest.json"), "win-x64");
    let asked = 0;
    for (const unsigned of [true, false]) {
      resetDesktopFfmpegProbeCache();
      const result = await probeDesktopFfmpeg({ isPackaged: true, resourcesPath, platformKey: "win-x64", environment: {},
        acceptsReplaced: () => { asked++; return unsigned; },
        // Every file differs from its pin, as after replacing the LGPL libraries.
        verifyFile: async (_file, _sha, _cache, signing) => signing?.allowReplaced?.() ?? false,
      });
      expect(result.ok).toBe(unsigned);
    }
    // One signature lookup per probe, not one per replaced file.
    expect(asked).toBe(2);
  });

  test.skipIf(process.platform !== "win32")("a replaced Windows file passes integrity only when replacement is allowed", async () => {
    const file = join(makeTempRoot(), "avcodec-63.dll");
    writeFileSync(file, "a user's interface-compatible rebuild");
    expect(await verifyFfmpegFile(file, PINNED_SHA256, new Map())).toBe(false);
    expect(await verifyFfmpegFile(file, PINNED_SHA256, new Map(), { allowReplaced: () => false })).toBe(false);
    expect(await verifyFfmpegFile(file, PINNED_SHA256, new Map(), { allowReplaced: () => true })).toBe(true);
  });

  test("only a missing signature or a modified signed app accepts replaced FFmpeg files", () => {
    expect(acceptsReplacedFfmpeg("NotSigned")).toBe(true);
    expect(acceptsReplacedFfmpeg("HashMismatch")).toBe(true);
    expect(acceptsReplacedFfmpeg("Valid")).toBe(false);
    expect(acceptsReplacedFfmpeg("UnknownError")).toBe(false);
    expect(acceptsReplacedFfmpeg(null)).toBe(false);
  });

  test("only FFmpeg resolves a Windows platform key", () => {
    expect(detectDesktopFfmpegPlatformKey("win32", "x64")).toBe("win-x64");
    expect(detectDesktopFfmpegPlatformKey("win32", "arm64")).toBeNull();
    expect(detectDesktopFfmpegPlatformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(detectDesktopFfmpegPlatformKey("linux", "x64")).toBeNull();
    // Other bundled tools ship for macOS only and must keep reporting that.
    expect(detectDesktopPlatformKey("win32", "x64")).toBeNull();
  });
});
