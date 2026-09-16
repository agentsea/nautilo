import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveDesktopRipgrepPath,
  resolveDesktopRuntimePath,
} from "../../electron/tool-runtime-resolver";
import { parseToolRuntimesManifest } from "../../electron/tool-runtimes-manifest";

const desktopRoot = join(import.meta.dir, "../..");

describe("D446 packaged ripgrep runtime", () => {
  test("pins official release archives for both macOS architectures", () => {
    const manifest = parseToolRuntimesManifest(
      readFileSync(join(desktopRoot, "vendor/tool-runtimes.manifest.json"), "utf8"),
    );
    const ripgrep = manifest.ripgrep;
    expect(ripgrep?.version).toBe("15.1.0");
    expect(ripgrep?.source).toBe("https://github.com/BurntSushi/ripgrep");
    expect(ripgrep?.license).toBe("MIT OR Unlicense");
    expect(ripgrep?.binaryName).toBe("rg");
    expect(ripgrep?.artifacts["darwin-arm64"]).toMatchObject({
      sha256: "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
      binarySha256: "4fdf1d8365af224bc70e3c1490d8461d859c37cc70e739a11e987af0215f3e94",
      member: "rg",
      sizeMin: 4_048_816,
    });
    expect(ripgrep?.artifacts["darwin-x64"]).toMatchObject({
      sha256: "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
      binarySha256: "3bafa7e6ee51ba3ac4ed065883484a309be09b26ea6dad561ae4049bfe049c50",
      member: "rg",
      sizeMin: 4_442_900,
    });
  });

  test("packaging extends existing vendor/resource/signing hooks", () => {
    const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const builder = readFileSync(join(desktopRoot, "electron-builder.yml"), "utf8");
    const afterPack = readFileSync(join(desktopRoot, "scripts/after-pack.cjs"), "utf8");
    const vendorScript = readFileSync(join(desktopRoot, "scripts/vendor-ripgrep.ts"), "utf8");
    const executableVendorSource = vendorScript
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    expect(pkg.scripts["vendor:ripgrep"]).toContain("vendor-ripgrep.ts");
    expect(pkg.scripts.dev).toContain("dev:prepare");
    expect(pkg.scripts["dev:prepare"]).toContain("vendor:ripgrep");
    expect(pkg.scripts["dev:prepare"].indexOf("vendor:ripgrep")).toBeLessThan(
      pkg.scripts["dev:prepare"].indexOf("build:electron"),
    );
    expect(pkg.scripts.app).toContain("dev:prepare");
    for (const script of ["package:mac:build", "package:dev:build"] as const) {
      expect(pkg.scripts[script]).toContain("vendor:ripgrep");
      expect(pkg.scripts[script].indexOf("vendor:ripgrep")).toBeLessThan(
        pkg.scripts[script].indexOf("bun run build"),
      );
    }
    expect(builder).toContain("from: vendor/ripgrep");
    expect(builder).toContain("to: tools-ripgrep");
    expect(builder).toMatch(/x64ArchFiles:.*tools-ripgrep/);
    expect(afterPack).toContain('"rg"');
    expect(vendorScript).toContain("fetchAndVerifyVendoredBinary");
    expect(vendorScript).toContain('format: "tar.gz"');
    expect(executableVendorSource).not.toMatch(/cargo|brew|npm install|process\.env\.PATH/i);
  });

  test("resolver is fail-closed and has no ambient PATH branch", () => {
    const root = join(import.meta.dir, ".missing-ripgrep-runtime");
    expect(
      resolveDesktopRuntimePath({
        runtime: "ripgrep",
        resourcesPath: join(root, "resources"),
        devVendorRoot: join(root, "vendor"),
        platformKey: "darwin-arm64",
      }),
    ).toMatchObject({ ok: false, runtime: "ripgrep", platformKey: "darwin-arm64" });
    expect(
      resolveDesktopRipgrepPath({
        resourcesPath: join(root, "resources"),
        devVendorRoot: join(root, "vendor"),
        platformKey: "darwin-x64",
      }),
    ).toBeNull();

    const resolver = readFileSync(join(desktopRoot, "electron/tool-runtime-resolver.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(resolver).not.toMatch(/process\.env\.PATH|which\(|homebrew/i);
  });
});
