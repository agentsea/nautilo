/**
 * D392 P2 — tool-runtimes.manifest.json schema validation.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getApplyPatchDesktopManifestEntry,
  ToolRuntimesManifestError,
  parseToolRuntimesManifest,
} from "../../electron/tool-runtimes-manifest";

const desktopRoot = join(import.meta.dir, "../..");
const manifestPath = join(desktopRoot, "vendor/tool-runtimes.manifest.json");

const VALID_ENTRY = {
  version: "1.0.0",
  license: "MIT",
  source: "https://example.com/tool",
  artifacts: {
    "darwin-arm64": {
      url: "https://example.com/darwin-arm64",
      sha256: "a".repeat(64),
    },
  },
};

describe("parseToolRuntimesManifest", () => {
  test("accepts os-arch keyed artifacts", () => {
    const parsed = parseToolRuntimesManifest(
      JSON.stringify({
        demo: VALID_ENTRY,
      }),
    );
    expect(parsed.demo?.artifacts["darwin-arm64"]?.url).toBe("https://example.com/darwin-arm64");
  });

  test("rejects bare arch keys", () => {
    expect(() =>
      parseToolRuntimesManifest(
        JSON.stringify({
          demo: {
            ...VALID_ENTRY,
            artifacts: {
              arm64: {
                url: "https://example.com/arm64",
                sha256: "b".repeat(64),
              },
            },
          },
        }),
      ),
    ).toThrow(ToolRuntimesManifestError);
  });

  test("rejects mobile platform keys", () => {
    expect(() =>
      parseToolRuntimesManifest(
        JSON.stringify({
          demo: {
            ...VALID_ENTRY,
            artifacts: {
              "ios-arm64": {
                url: "https://example.com/ios",
                sha256: "c".repeat(64),
              },
            },
          },
        }),
      ),
    ).toThrow(/forbidden/);
  });

  test("rejects invalid sha256", () => {
    expect(() =>
      parseToolRuntimesManifest(
        JSON.stringify({
          demo: {
            ...VALID_ENTRY,
            artifacts: {
              "darwin-arm64": {
                url: "https://example.com/darwin-arm64",
                sha256: "not-a-hash",
              },
            },
          },
        }),
      ),
    ).toThrow(ToolRuntimesManifestError);
  });
});

describe("committed tool-runtimes.manifest.json", () => {
  test("keeps OfficeCLI release, shared artifacts, and provenance aligned across Desktop and Server", () => {
    const serverVendorRoot = join(desktopRoot, "../../packages/server/vendor/officecli");
    const desktop = parseToolRuntimesManifest(readFileSync(manifestPath, "utf8")).officecli!;
    const server = parseToolRuntimesManifest(
      readFileSync(join(serverVendorRoot, "manifest.json"), "utf8"),
    ).officecli!;

    expect(desktop.version).toBe(server.version);
    expect(desktop.source).toBe(server.source);
    expect(desktop.license).toBe(server.license);
    expect(desktop.binaryName).toBe(server.binaryName);
    for (const platformKey of ["darwin-arm64", "darwin-x64"] as const) {
      expect(desktop.artifacts[platformKey]).toEqual(server.artifacts[platformKey]);
    }
    expect(readFileSync(join(serverVendorRoot, ".version"), "utf8").trim()).toBe(server.version);
    const upstreamHashes = new Map(
      readFileSync(join(serverVendorRoot, "SHA256SUMS"), "utf8").trim().split(/\r?\n/).map((line) => {
        const [digest, filename] = line.trim().split(/\s+/);
        return [filename, digest] as const;
      }),
    );
    for (const artifact of Object.values(server.artifacts)) {
      expect(artifact.url).toContain(`/releases/download/v${server.version}/`);
      const filename = new URL(artifact.url!).pathname.split("/").at(-1);
      expect(upstreamHashes.get(filename)).toBe(artifact.sha256);
    }
  });

  test("uses D392 os-arch keys and includes aligned Desktop and Server officecli artifacts", () => {
    const manifest = parseToolRuntimesManifest(readFileSync(manifestPath, "utf8"));

    for (const tool of ["agent-browser", "gog"] as const) {
      expect(manifest[tool]?.artifacts["darwin-arm64"]).toBeDefined();
      expect(manifest[tool]?.artifacts["darwin-x64"]).toBeDefined();
      expect(manifest[tool]?.artifacts.arm64).toBeUndefined();
      expect(manifest[tool]?.artifacts.x64).toBeUndefined();
    }

    const ffmpeg = manifest.ffmpeg;
    expect(ffmpeg?.version).toBe("9.0.1");
    expect(ffmpeg?.license).toBe("LGPL-3.0-or-later");
    expect(ffmpeg?.source).toBe("https://github.com/ispysoftware/agentdvr-ffmpeg-build");
    expect(ffmpeg?.binaryName).toBe("bin/ffmpeg");
    expect(ffmpeg?.artifacts["darwin-arm64"]?.url).toContain("lgpl-macos-arm64.zip");
    expect(ffmpeg?.artifacts["darwin-arm64"]?.sha256).toBe(
      "39d84ef366ea48e13c34db27f5a19f39bc993cf69962812f7c1285271ddcf57e",
    );
    expect(ffmpeg?.artifacts["darwin-arm64"]?.sizeMin).toBeGreaterThanOrEqual(300_000);
    expect(ffmpeg?.artifacts["darwin-x64"]?.url).toContain("lgpl-macos-x86_64.zip");
    expect(ffmpeg?.artifacts["darwin-x64"]?.sha256).toBe(
      "11d48a60696f3280a4faae07de8c059cc863a44ab57ed89291e7574251a5a143",
    );
    expect(ffmpeg?.artifacts["darwin-x64"]?.sizeMin).toBeGreaterThanOrEqual(300_000);

    const officecli = manifest.officecli;
    expect(officecli?.version).toBe("1.0.148");
    expect(officecli?.binaryName).toBe("officecli");
    expect(officecli?.license).toBe("Apache-2.0");

    for (const platformKey of ["darwin-arm64", "darwin-x64"] as const) {
      const desktopArtifact = officecli?.artifacts[platformKey];
      expect(desktopArtifact?.url).toContain(
        "github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.148/",
      );
      expect(desktopArtifact?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(desktopArtifact?.sizeMin).toBe(1_000_000);
    }
  });

  test("pins a URL-free Darwin source-build descriptor without placeholder hashes", () => {
    const manifest = parseToolRuntimesManifest(readFileSync(manifestPath, "utf8"));
    const applyPatch = getApplyPatchDesktopManifestEntry(manifest);
    expect(applyPatch.version).toBe("0.1.0");
    expect(applyPatch.binaryName).toBe("nautilo-apply-patch");
    expect(applyPatch.protocol).toBe("nautilo.apply_patch/v1");
    expect(applyPatch.provenance.upstreamRevision).toBe("3389fa554e953d07a12a34f5681aae46f17958f8");
    for (const platformKey of ["darwin-arm64", "darwin-x64"] as const) {
      const artifact = applyPatch.artifacts[platformKey];
      expect(artifact.url).toBeUndefined();
      expect(artifact.sha256).toBeUndefined();
      expect(artifact.sizeMin).toBeGreaterThanOrEqual(100_000);
      expect(artifact.machOArch).toBe(platformKey === "darwin-arm64" ? "arm64" : "x64");
      expect(artifact.target).toBe(platformKey === "darwin-arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin");
    }
  });

  test("rejects an apply-patch descriptor that retains abandoned release-asset fields", () => {
    const descriptorWithReleaseFields = {
      ...VALID_ENTRY,
      binaryName: "nautilo-apply-patch",
      protocol: "nautilo.apply_patch/v1",
      provenance: {
        format: "nautilo.apply_patch.provenance/v1",
        upstreamRevision: "a",
        licenseSha256: "a".repeat(64),
        noticeSha256: "b".repeat(64),
        rustToolchain: "1.95.0",
        cargoLockSha256: "c".repeat(64),
        nautiloExtractionRevision: "d".repeat(64),
      },
      artifacts: {
        "darwin-arm64": { url: "https://token@example.com/releases/download/v0/a", sha256: "a".repeat(64), sizeMin: 100_000, machOArch: "arm64", target: "aarch64-apple-darwin" },
        "darwin-x64": { sizeMin: 100_000, machOArch: "x64", target: "x86_64-apple-darwin" },
      },
    };
    expect(() => parseToolRuntimesManifest(JSON.stringify({ "apply-patch": descriptorWithReleaseFields }))).toThrow(/only target/);
  });
});
