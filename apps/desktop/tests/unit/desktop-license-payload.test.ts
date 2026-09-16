import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertDesktopLicensePayload, vendorPinnedBunLicense } from "../../scripts/desktop-license-payload";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const canonicalNotice = readFileSync(resolve(desktopRoot, "../../THIRD_PARTY_NOTICES.md"));
const upstreamLicense = readFileSync(join(desktopRoot, "licenses/bun/LICENSE.txt"));
const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nautilo-license-payload-"));
  roots.push(root);
  return root;
}

function validResources(): string {
  const root = temporaryRoot();
  mkdirSync(join(root, "legal"));
  writeFileSync(join(root, "legal/THIRD_PARTY_NOTICES.md"), canonicalNotice);
  vendorPinnedBunLicense("1.3.11", join(root, "bun"));
  return root;
}

function copiedSource(): { root: string; desktop: string } {
  const root = temporaryRoot();
  const desktop = join(root, "apps/desktop");
  for (const file of ["scripts/desktop-license-payload.ts", "scripts/vendor-bun.ts", "licenses/bun/LICENSE.txt", "licenses/bun/manifest.json"]) {
    mkdirSync(dirname(join(desktop, file)), { recursive: true });
    copyFileSync(join(desktopRoot, file), join(desktop, file));
  }
  writeFileSync(join(root, "THIRD_PARTY_NOTICES.md"), canonicalNotice);
  return { root, desktop };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Desktop license payload", () => {
  test("accepts exact canonical notices and full pinned Bun upstream notice", () => {
    expect(() => assertDesktopLicensePayload(validResources())).not.toThrow();
  });

  test("rejects an absent or stale canonical notice", () => {
    const root = validResources();
    rmSync(join(root, "legal/THIRD_PARTY_NOTICES.md"));
    expect(() => assertDesktopLicensePayload(root)).toThrow();
    writeFileSync(join(root, "legal/THIRD_PARTY_NOTICES.md"), "old notice");
    expect(() => assertDesktopLicensePayload(root)).toThrow("canonical source");
  });

  test("rejects a Bun attribution stub in the packaged resources", () => {
    const root = validResources();
    writeFileSync(join(root, "bun/LICENSE-bun.txt"), "Bun is MIT; see upstream");
    expect(() => assertDesktopLicensePayload(root)).toThrow("stale or incomplete");
  });

  test("refuses runtime/license version drift before replacing a destination", () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "LICENSE-bun.txt"), "existing");
    expect(() => vendorPinnedBunLicense("different-version", root)).toThrow("version differs");
    expect(readFileSync(join(root, "LICENSE-bun.txt"), "utf8")).toBe("existing");
  });

  test("refuses corrupted checked-in license input", () => {
    const { root, desktop } = copiedSource();
    const resources = validResources();
    writeFileSync(join(desktop, "licenses/bun/LICENSE.txt"), "corrupted upstream input");
    const result = spawnSync(process.execPath, [join(desktop, "scripts/desktop-license-payload.ts"), resources], { cwd: root, env: {}, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("pinned upstream provenance");
  });

  test("cached Bun binaries still repair an old license stub with network disabled", () => {
    const { root, desktop } = copiedSource();
    const vendor = join(desktop, "vendor/bun");
    for (const arch of ["arm64", "x64"]) {
      mkdirSync(join(vendor, arch), { recursive: true });
      writeFileSync(join(vendor, arch, "bun"), "cached binary fixture");
      truncateSync(join(vendor, arch, "bun"), 1_000_000);
    }
    writeFileSync(join(vendor, ".version"), "1.3.11");
    writeFileSync(join(vendor, "LICENSE-bun.txt"), "old stub");
    const before = readFileSync(join(vendor, "arm64/bun"));
    writeFileSync(join(root, "deny-network.ts"), 'globalThis.fetch = () => { throw new Error("unexpected network request"); };\n');
    const result = spawnSync(process.execPath, ["--preload", join(root, "deny-network.ts"), join(desktop, "scripts/vendor-bun.ts")], { cwd: root, env: {}, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("cache hit");
    expect(readFileSync(join(vendor, "LICENSE-bun.txt")).equals(upstreamLicense)).toBe(true);
    expect(readFileSync(join(vendor, "arm64/bun")).equals(before)).toBe(true);
  });

  test("electron-builder copies both notices despite the application Markdown exclusion", async () => {
    // Use the pinned packager's real matcher and copy implementation without
    // downloading Electron, building native tools, or invoking signing hooks.
    const require = createRequire(import.meta.url);
    const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
    const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
    const yaml = appBuilderRequire("js-yaml") as { load: (source: string) => unknown };
    interface Matcher { from: string; to: string }
    const { getFileMatchers, copyFiles } = appBuilderRequire("./out/fileMatcher") as {
      getFileMatchers: (config: unknown, name: string, destination: string, options: {
        defaultSrc: string; globalOutDir: string; customBuildOptions: object; macroExpander: (pattern: string) => string;
      }) => Matcher[];
      copyFiles: (matchers: Matcher[]) => Promise<void>;
    };
    const configuration = yaml.load(readFileSync(join(desktopRoot, "electron-builder.yml"), "utf8"));
    const { root, desktop } = copiedSource();
    vendorPinnedBunLicense("1.3.11", join(desktop, "vendor/bun"));
    mkdirSync(join(desktop, "dist"));
    writeFileSync(join(desktop, "dist/main.js"), "// application fixture\n");
    writeFileSync(join(desktop, "dist/internal.md"), "excluded application Markdown");
    const resources = join(root, "output/resources");
    const options = {
      defaultSrc: desktop,
      globalOutDir: join(root, "output"),
      customBuildOptions: {},
      macroExpander: (pattern: string) => pattern,
    };
    const extras = getFileMatchers(configuration, "extraResources", resources, options).filter(
      (matcher) => matcher.from === join(root, "THIRD_PARTY_NOTICES.md") || matcher.from === join(desktop, "vendor/bun"),
    );
    expect(extras).toHaveLength(2);
    await copyFiles(extras);
    await copyFiles(getFileMatchers(configuration, "files", join(resources, "app"), options));
    expect(readFileSync(join(resources, "legal/THIRD_PARTY_NOTICES.md")).equals(canonicalNotice)).toBe(true);
    expect(readFileSync(join(resources, "bun/LICENSE-bun.txt")).equals(upstreamLicense)).toBe(true);
    expect(existsSync(join(resources, "app/dist/main.js"))).toBe(true);
    expect(existsSync(join(resources, "app/dist/internal.md"))).toBe(false);
    const result = spawnSync(process.execPath, [join(desktop, "scripts/desktop-license-payload.ts"), resources], { cwd: root, env: {}, encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  test("copies canonical notices outside ASAR and runs the package verifier", () => {
    const configuration = readFileSync(join(desktopRoot, "electron-builder.yml"), "utf8");
    expect(configuration).toContain("from: ../../THIRD_PARTY_NOTICES.md\n    to: legal/THIRD_PARTY_NOTICES.md");
    const hook = readFileSync(join(desktopRoot, "scripts/after-pack.cjs"), "utf8");
    expect(hook).toContain('join(__dirname, "desktop-license-payload.ts"), resourcesDir');
  });
});
