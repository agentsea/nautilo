/**
 * M195 / D345 Phase 2b + M206 Phase 3 — integrity guard for
 * vendor/tool-runtimes.manifest.json.
 *
 * Static metadata checks only; does not fetch large vendor binaries.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getApplyPatchDesktopManifestEntry, parseToolRuntimesManifest } from "../../electron/tool-runtimes-manifest";
import { removeOfficeCliUpdateSidecars } from "../../scripts/vendor-officecli.ts";

const desktopRoot = join(import.meta.dir, "../..");
const manifestPath = join(desktopRoot, "vendor/tool-runtimes.manifest.json");
const SHA256_HEX = /^[a-f0-9]{64}$/;

describe("tool-runtimes.manifest.json", () => {
  test.skipIf(!existsSync(manifestPath))(
    "agent-browser, gog, openhue, and officecli entries use pinned artifacts",
    () => {
      const manifest = parseToolRuntimesManifest(readFileSync(manifestPath, "utf8"));

      const agentBrowser = manifest["agent-browser"];
      expect(typeof agentBrowser?.version).toBe("string");
      expect(typeof agentBrowser?.source).toBe("string");
      expect(agentBrowser?.license).toBe("Apache-2.0");

      for (const platformKey of ["darwin-arm64", "darwin-x64"] as const) {
        const artifact = agentBrowser?.artifacts?.[platformKey];
        expect(typeof artifact?.url).toBe("string");
        expect((artifact?.url as string).length).toBeGreaterThan(0);
        expect(typeof artifact?.sha256).toBe("string");
        expect(artifact?.sha256).toMatch(SHA256_HEX);
      }
      expect(agentBrowser?.artifacts?.arm64).toBeUndefined();
      expect(agentBrowser?.artifacts?.x64).toBeUndefined();

      const gog = manifest.gog;
      expect(typeof gog?.version).toBe("string");
      expect(typeof gog?.source).toBe("string");
      expect(gog?.license).toBe("MIT");

      for (const platformKey of ["darwin-arm64", "darwin-x64"] as const) {
        const artifact = gog?.artifacts?.[platformKey];
        expect(typeof artifact?.url).toBe("string");
        expect((artifact?.url as string).length).toBeGreaterThan(0);
        expect(typeof artifact?.sha256).toBe("string");
        expect(artifact?.sha256).toMatch(SHA256_HEX);
        expect(artifact?.member).toBe("gog");
      }

      const openhue = manifest.openhue;
      expect(openhue?.version).toBe("0.24");
      expect(openhue?.binaryName).toBe("openhue");
      expect(openhue?.license).toBe("Apache-2.0");
      expect(openhue?.source).toBe("https://github.com/openhue/openhue-cli");
      const openhueArtifact = openhue?.artifacts?.["darwin-arm64"];
      expect(openhueArtifact?.url).toBe(
        "https://github.com/openhue/openhue-cli/releases/download/0.24/openhue_Darwin_all.tar.gz",
      );
      expect(openhueArtifact?.sha256).toBe(
        "a99e24102e9f11d958fad2ac98a06aabad5e5099fd2aa3143d6874e2c3ce18b6",
      );
      expect(openhueArtifact?.member).toBe("openhue");
      expect(openhueArtifact?.sizeMin).toBe(1_000_000);
      expect(openhue?.artifacts?.["darwin-x64"]).toBeUndefined();

      const officecli = manifest.officecli;
      expect(officecli?.version).toBe("1.0.148");
      expect(officecli?.binaryName).toBe("officecli");
      expect(officecli?.license).toBe("Apache-2.0");
      expect(officecli?.source).toBe("https://github.com/iOfficeAI/OfficeCLI");

      for (const platformKey of ["darwin-arm64", "darwin-x64"] as const) {
        const artifact = officecli?.artifacts?.[platformKey];
        expect(typeof artifact?.url).toBe("string");
        expect((artifact?.url as string)).toContain("github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.148/");
        expect(typeof artifact?.sha256).toBe("string");
        expect(artifact?.sha256).toMatch(SHA256_HEX);
        expect(artifact?.sizeMin).toBe(1_000_000);
      }
    },
  );
  test("D448 apply-patch keeps a Desktop-only URL-free source-build descriptor", () => {
    const manifest = parseToolRuntimesManifest(readFileSync(manifestPath, "utf8"));
    const applyPatch = getApplyPatchDesktopManifestEntry(manifest);

    expect(applyPatch.binaryName).toBe("nautilo-apply-patch");
    expect(applyPatch.version).toBe("0.1.0");
    expect(applyPatch.protocol).toBe("nautilo.apply_patch/v1");
    expect(applyPatch.provenance.upstreamRevision).toBe(
      "3389fa554e953d07a12a34f5681aae46f17958f8",
    );
    expect(Object.keys(applyPatch.artifacts).sort()).toEqual(["darwin-arm64", "darwin-x64"]);

    for (const platformKey of ["darwin-arm64", "darwin-x64"] as const) {
      const artifact = applyPatch.artifacts[platformKey];
      expect(artifact.url).toBeUndefined();
      expect(artifact.sha256).toBeUndefined();
      expect(artifact.sizeMin).toBeGreaterThanOrEqual(100_000);
      expect(artifact.target).toBe(platformKey === "darwin-arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin");
    }
  });
});

describe("packaging layout expectations", () => {
  test("source launches provision every non-Computer-Use managed tool runtime", () => {
    const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    const prepare = pkg.scripts["dev:prepare"];
    const buildIndex = prepare.indexOf("bun run build:electron");

    for (const runtime of ["agent-browser", "gog", "ffmpeg", "openhue", "officecli", "ripgrep"] as const) {
      const vendorIndex = prepare.indexOf(`bun run vendor:${runtime}`);
      expect(vendorIndex).toBeGreaterThanOrEqual(0);
      expect(vendorIndex).toBeLessThan(buildIndex);
    }
    expect(pkg.scripts.app).toBe("bun run dev:prepare && bun scripts/run-desktop.ts");
  });

  test("electron-builder maps officecli vendor tree to tools-officecli", () => {
    const electronBuilderYml = readFileSync(join(desktopRoot, "electron-builder.yml"), "utf-8");
    expect(electronBuilderYml).toContain("from: vendor/officecli");
    expect(electronBuilderYml).toContain("to: tools-officecli");
    expect(electronBuilderYml).toMatch(/x64ArchFiles:.*tools-officecli/);
  });

  test("electron-builder maps the universal OpenHue vendor tree to tools", () => {
    const electronBuilderYml = readFileSync(join(desktopRoot, "electron-builder.yml"), "utf-8");
    expect(electronBuilderYml).toContain("from: vendor/openhue");
    expect(electronBuilderYml).toContain("to: tools");
    expect(electronBuilderYml).toMatch(/x64ArchFiles:.*tools/);
  });

  test("vendor-officecli script targets platform-key output layout", () => {
    const script = readFileSync(join(desktopRoot, "scripts/vendor-officecli.ts"), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(script).toContain("fetchAndVerifyVendoredBinary");
    expect(script).toContain('join(desktopRoot, "vendor", "officecli")');
    expect(script).toContain("platformKey");
    expect(script).toContain("tool-runtimes.manifest.json");
    expect(script).not.toMatch(/packages\/server\/vendor/);
  });

  test("package scripts provision officecli before build", () => {
    const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["vendor:officecli"]).toContain("vendor-officecli.ts");
    for (const packageScript of ["package:mac:build", "package:dev:build"] as const) {
      expect(pkg.scripts[packageScript]).toMatch(/vendor:officecli/);
      const chain = pkg.scripts[packageScript].split("&&").map((s) => s.trim());
      const officecliIndex = chain.findIndex((step) => step.includes("vendor:officecli"));
      const buildIndex = chain.findIndex((step) => step.includes("build"));
      expect(officecliIndex).toBeGreaterThan(-1);
      expect(buildIndex).toBeGreaterThan(officecliIndex);
    }
  });

  const SIGNING_ENV_VARS = [
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "CSC_NAME",
    "CSC_KEYCHAIN",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
    "APPLE_KEYCHAIN",
    "APPLE_KEYCHAIN_PROFILE",
  ] as const;

  test("package:mac:build runs the full unsigned mac electron-builder pipeline", () => {
    const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["package:mac:build"]).toContain("vendor:officecli");
    expect(pkg.scripts["package:mac:build"]).toContain("electron-builder --mac --universal");
    expect(pkg.scripts["package:mac:build"]).not.toContain("unset ");
  });

  test("package:dev:build runs the full unsigned dir electron-builder pipeline", () => {
    const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["package:dev:build"]).toContain("vendor:officecli");
    expect(pkg.scripts["package:dev:build"]).toContain("electron-builder --dir");
    expect(pkg.scripts["package:dev:build"]).not.toContain("unset ");
  });

  test("package:mac clears signing credentials in a subshell before build", () => {
    const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    const script = pkg.scripts["package:mac"];
    expect(script.startsWith("(")).toBe(true);
    expect(script.endsWith(")")).toBe(true);
    const unsetVars = script.slice(1, -1).match(/^unset ([^;]+)/)?.[1]?.split(/\s+/) ?? [];
    for (const envVar of SIGNING_ENV_VARS) {
      expect(unsetVars).toContain(envVar);
    }
    expect(script).toContain("export CSC_IDENTITY_AUTO_DISCOVERY=false");
    expect(script).toContain("bun run package:mac:build -- ");
    expect(script).toContain("-c.mac.entitlements=entitlements.mac.unsigned.plist");
    expect(script).toContain("-c.mac.entitlementsInherit=entitlements.mac.unsigned.inherit.plist");
    expect(script).toContain("-c.mac.notarize=false");
    expect(script).not.toContain("electron-builder");
  });

  test("package:dev clears signing credentials in a subshell before build", () => {
    const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    const script = pkg.scripts["package:dev"];
    expect(script.startsWith("(")).toBe(true);
    expect(script.endsWith(")")).toBe(true);
    const unsetVars = script.slice(1, -1).match(/^unset ([^;]+)/)?.[1]?.split(/\s+/) ?? [];
    for (const envVar of SIGNING_ENV_VARS) {
      expect(unsetVars).toContain(envVar);
    }
    expect(script).toContain("export CSC_IDENTITY_AUTO_DISCOVERY=false");
    expect(script).toContain("bun run package:dev:build -- ");
    expect(script).toContain("-c.mac.entitlements=entitlements.mac.unsigned.plist");
    expect(script).toContain("-c.mac.entitlementsInherit=entitlements.mac.unsigned.inherit.plist");
    expect(script).toContain("-c.mac.notarize=false");
    expect(script).not.toContain("electron-builder");
  });

  test("unsigned package wrappers clear credentials without mutating the parent environment", () => {
    const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    const parentSigningEnv = Object.fromEntries(
      SIGNING_ENV_VARS.map((envVar) => [envVar, process.env[envVar]]),
    );
    const childEnv = {
      ...process.env,
      ...Object.fromEntries(
        SIGNING_ENV_VARS.map((envVar) => [envVar, `sentinel-${envVar}`]),
      ),
      CSC_IDENTITY_AUTO_DISCOVERY: "sentinel-auto-discovery",
    };

    for (const [packageScript, buildScript] of [
      ["package:mac", "package:mac:build"],
      ["package:dev", "package:dev:build"],
    ] as const) {
      const wrapper = pkg.scripts[packageScript];
      const probeCommand = wrapper.replace(
        new RegExp(`bun run ${buildScript}(?:\\s+--[^)]*)?`),
        "env",
      );
      expect(probeCommand).not.toBe(wrapper);

      const probe = spawnSync("/bin/sh", ["-c", probeCommand], {
        encoding: "utf8",
        env: childEnv,
      });
      expect(probe.error).toBeUndefined();
      expect(probe.status).toBe(0);

      for (const envVar of SIGNING_ENV_VARS) {
        expect(probe.stdout).not.toMatch(new RegExp(`^${envVar}=`, "m"));
      }
      expect(probe.stdout).toMatch(/^CSC_IDENTITY_AUTO_DISCOVERY=false$/m);
    }

    for (const envVar of SIGNING_ENV_VARS) {
      expect(process.env[envVar]).toBe(parentSigningEnv[envVar]);
    }
  });

  test("root and Desktop expose contributor packaging without official signed commands", () => {
    const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
    const rootPkg = JSON.parse(readFileSync(join(desktopRoot, "../../package.json"), "utf8"));
    expect(pkg.scripts["package:mac:signed"]).toBeUndefined();
    expect(rootPkg.scripts["desktop:package:mac:signed"]).toBeUndefined();
    expect(rootPkg.scripts["desktop:package:mac"]).toContain("package:mac");
  });

  test("package scripts provision OpenHue before build", () => {
    const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["vendor:openhue"]).toContain("vendor-openhue.ts");
    for (const packageScript of ["package:mac:build", "package:dev:build"] as const) {
      const chain = pkg.scripts[packageScript].split("&&").map((step) => step.trim());
      const openhueIndex = chain.findIndex((step) => step.includes("vendor:openhue"));
      const buildIndex = chain.findIndex((step) => step.includes("build"));
      expect(openhueIndex).toBeGreaterThan(-1);
      expect(buildIndex).toBeGreaterThan(openhueIndex);
    }
  });

  test("after-pack restores executable bits on vendored tool binaries", () => {
    const afterPack = readFileSync(join(desktopRoot, "scripts/after-pack.cjs"), "utf-8");
    expect(afterPack).toContain("officecli");
    expect(afterPack).toContain("openhue");
    expect(afterPack).toContain("fixVendoredToolBinaryPerms");
    expect(afterPack).toContain("0o755");
  });

  test("runtime resolver module exists and is fail-closed for officecli", () => {
    const resolver = readFileSync(join(desktopRoot, "electron/tool-runtime-resolver.ts"), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(resolver).toContain("tools-officecli");
    expect(resolver).toContain("resolveDesktopOfficeCliPath");
    expect(resolver).not.toMatch(/opt\/homebrew/);
    expect(resolver).not.toMatch(/process\.env/);
    expect(resolver).not.toMatch(/packages\/server\/vendor/);
  });

  test("electron-builder officecli filter allows canonical darwin binaries but not update sidecars", () => {
    const electronBuilderYml = readFileSync(join(desktopRoot, "electron-builder.yml"), "utf-8");
    const officecliStart = electronBuilderYml.indexOf("from: vendor/officecli");
    const nextResourceStart = electronBuilderYml.indexOf("\n  - from:", officecliStart);
    const officecliBlock = electronBuilderYml.slice(
      officecliStart,
      nextResourceStart === -1 ? undefined : nextResourceStart,
    );
    const filterPatterns = [...officecliBlock.matchAll(/^\s+-\s+"([^"]+)"/gm)].map((m) => m[1]);

    expect(filterPatterns).toEqual([
      "darwin-arm64/officecli",
      "darwin-x64/officecli",
      "LICENSE-officecli.txt",
      ".version",
    ]);
    expect(filterPatterns).not.toContain("**/*");

    const allowedPaths = new Set(filterPatterns);
    const deniedPaths = [
      "darwin-arm64/officecli.update",
      "darwin-arm64/officecli.update.partial",
      "darwin-x64/officecli.update",
      "darwin-x64/officecli.update.partial",
    ];
    for (const path of deniedPaths) {
      expect(allowedPaths.has(path)).toBe(false);
    }
    expect(allowedPaths.has("darwin-arm64/officecli")).toBe(true);
    expect(allowedPaths.has("darwin-x64/officecli")).toBe(true);
  });
});

describe("removeOfficeCliUpdateSidecars", () => {
  const platformKeys = ["darwin-arm64", "darwin-x64", "linux-x64"] as const;

  test("deletes update sidecars across platform dirs and preserves canonical officecli", () => {
    const tmpRoot = join(import.meta.dir, ".tmp-officecli-sidecar-cleanup");
    try {
      mkdirSync(tmpRoot, { recursive: true });
      for (const platformKey of platformKeys) {
        const platformDir = join(tmpRoot, platformKey);
        mkdirSync(platformDir, { recursive: true });
        writeFileSync(join(platformDir, "officecli"), "canonical-binary");
        writeFileSync(join(platformDir, "officecli.update"), "update-sidecar");
        writeFileSync(join(platformDir, "officecli.update.partial"), "partial-sidecar");
      }

      removeOfficeCliUpdateSidecars(tmpRoot, platformKeys);

      for (const platformKey of platformKeys) {
        const platformDir = join(tmpRoot, platformKey);
        expect(existsSync(join(platformDir, "officecli"))).toBe(true);
        expect(existsSync(join(platformDir, "officecli.update"))).toBe(false);
        expect(existsSync(join(platformDir, "officecli.update.partial"))).toBe(false);
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("is safe when update sidecars are already absent", () => {
    const tmpRoot = join(import.meta.dir, ".tmp-officecli-sidecar-absent");
    try {
      mkdirSync(tmpRoot, { recursive: true });
      for (const platformKey of platformKeys) {
        const platformDir = join(tmpRoot, platformKey);
        mkdirSync(platformDir, { recursive: true });
        writeFileSync(join(platformDir, "officecli"), "canonical-binary");
      }

      expect(() => removeOfficeCliUpdateSidecars(tmpRoot, platformKeys)).not.toThrow();

      for (const platformKey of platformKeys) {
        expect(existsSync(join(tmpRoot, platformKey, "officecli"))).toBe(true);
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
