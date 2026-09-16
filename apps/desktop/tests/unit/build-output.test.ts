import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const desktopRoot = join(import.meta.dir, "../..");
const electronBuilderYml = readFileSync(join(desktopRoot, "electron-builder.yml"), "utf-8");
const packageJson = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf-8")) as {
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

test("Cua builds have one fixed production host identity", () => {
  expect(Object.keys(packageJson.scripts).some((name) => name.toLowerCase().includes(["d", "516"].join("")))).toBe(false);
  const buildElectron = readFileSync(join(desktopRoot, "scripts/build-electron.ts"), "utf-8");
  const mainProcess = readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8");
  expect(mainProcess).toContain('hostBundleId: "com.nautilo.desktop"');
  expect(buildElectron).not.toContain("MAC_BUNDLE_ID");
});

test("packaged main-process native modules are production dependencies", () => {
  expect(packageJson.dependencies?.sharp).toBe("0.35.4");
  expect(packageJson.devDependencies?.sharp).toBeUndefined();
});

function expectExtraResourceMapping(from: string, to: string): void {
  const fromNeedle = `from: ${from}`;
  const toNeedle = `to: ${to}`;
  expect(electronBuilderYml).toContain(fromNeedle);
  expect(electronBuilderYml).toContain(toNeedle);
  const fromIndex = electronBuilderYml.indexOf(fromNeedle);
  const toIndex = electronBuilderYml.indexOf(toNeedle, fromIndex);
  expect(toIndex).toBeGreaterThan(fromIndex);
}

function extraResourceFilterPatterns(from: string): string[] {
  const fromNeedle = `from: ${from}`;
  const fromIndex = electronBuilderYml.indexOf(fromNeedle);
  expect(fromIndex).toBeGreaterThanOrEqual(0);
  const block = electronBuilderYml.slice(fromIndex, fromIndex + 400);
  return [...block.matchAll(/^\s+-\s+"([^"]+)"/gm)].map((match) => match[1]!);
}

test("electron-builder extraResources maps vendored Relay Host and managed tools", () => {
  expectExtraResourceMapping("vendor/relay-host", "tools-relay-host");
  expectExtraResourceMapping("dist/browser-control-provider.js", "browser-control-provider.js");
  expectExtraResourceMapping("vendor/agent-browser", "tools-agent-browser");
  expectExtraResourceMapping("vendor/gog", "tools-gog");
  expectExtraResourceMapping("vendor/ffmpeg", "tools-ffmpeg");
  expectExtraResourceMapping("vendor/openhue", "tools");
  expectExtraResourceMapping("vendor/officecli", "tools-officecli");
  expectExtraResourceMapping("vendor/apply-patch", "tools-apply-patch");
});

test("Desktop launch and package flows build the private Relay Host before Electron", () => {
  expect(packageJson.scripts["vendor:relay-host"]).toBe("bun scripts/vendor-relay-host.ts");
  expect(packageJson.scripts["app"]).toContain("bun run dev:prepare");
  for (const scriptName of ["dev:prepare", "package:mac:build", "package:dev:build"] as const) {
    const script = packageJson.scripts[scriptName];
    expect(script).toContain("bun run vendor:relay-host");
    const boundary = scriptName.startsWith("package:") ? script.indexOf("electron-builder") : script.indexOf("build:electron");
    expect(script.indexOf("bun run vendor:relay-host")).toBeLessThan(boundary);
  }
  const filters = extraResourceFilterPatterns("vendor/relay-host");
  expect(filters).toEqual(["nautilo-relay-host.js", "manifest.json"]);
  const relaySource = readFileSync(join(desktopRoot, "electron/relay.ts"), "utf8");
  expect(relaySource).toContain("createDesktopRelaySidecarClient({");
  expect(relaySource).not.toContain("createRelayClient({");
});

test("shared tools extraResources exclude vendor .version stamps but keep binaries and licenses", () => {
  const openhueFilters = extraResourceFilterPatterns("vendor/openhue");
  expect(openhueFilters).toEqual(["openhue", "LICENSE-openhue.txt"]);
  expect(openhueFilters).not.toContain(".version");
  expect(openhueFilters).not.toContain("**/*");
});

test("macOS packaging vendors managed FFmpeg before universal packaging", () => {
  expect(packageJson.scripts["vendor:ffmpeg"]).toBe("bun scripts/vendor-ffmpeg.ts");
  expect(packageJson.scripts["package:mac:build"]).toContain("bun run vendor:ffmpeg");
  expect(packageJson.scripts["package:dev:build"]).toContain("bun run vendor:ffmpeg");
  const macVendorIndex = packageJson.scripts["package:mac:build"].indexOf("bun run vendor:ffmpeg");
  const macBuilderIndex = packageJson.scripts["package:mac:build"].indexOf("electron-builder");
  expect(macVendorIndex).toBeGreaterThanOrEqual(0);
  expect(macBuilderIndex).toBeGreaterThan(macVendorIndex);
  const devVendorIndex = packageJson.scripts["package:dev:build"].indexOf("bun run vendor:ffmpeg");
  const devBuilderIndex = packageJson.scripts["package:dev:build"].indexOf("electron-builder");
  expect(devVendorIndex).toBeGreaterThanOrEqual(0);
  expect(devBuilderIndex).toBeGreaterThan(devVendorIndex);
  const vendorFfmpeg = readFileSync(join(desktopRoot, "scripts/vendor-ffmpeg.ts"), "utf-8");
  expect(vendorFfmpeg).toContain('writeFileSync(join(root, "manifest.json")');
  expect(vendorFfmpeg).toContain("JSON.stringify({ ffmpeg: ffmpegManifest }");
});

test("macOS package builds vendor both Darwin Sharp native package trees into the unpacked runtime path", () => {
  expect(packageJson.scripts["vendor:sharp-darwin"]).toBe("bun scripts/vendor-sharp-darwin.ts");
  for (const scriptName of ["package:mac:build", "package:dev:build"] as const) {
    const script = packageJson.scripts[scriptName];
    expect(script).toContain("bun run vendor:sharp-darwin");
    expect(script.indexOf("bun run vendor:sharp-darwin")).toBeLessThan(script.indexOf("electron-builder"));
  }
  expectExtraResourceMapping("vendor/sharp-darwin/node_modules/@img", "app.asar.unpacked/node_modules/@img");
  const filters = extraResourceFilterPatterns("vendor/sharp-darwin/node_modules/@img");
  expect(filters).toEqual([
    "sharp-darwin-arm64/**",
    "sharp-darwin-x64/**",
    "sharp-libvips-darwin-arm64/**",
    "sharp-libvips-darwin-x64/**",
  ]);
  const vendor = readFileSync(join(desktopRoot, "scripts/vendor-sharp-darwin.ts"), "utf8");
  expect(vendor).toContain("SHARP_DARWIN_PACKAGES");
  expect(vendor).toContain("SHA-512 integrity verification failed");
  expect(vendor).toContain("installAtomically");
  expect(vendor).toContain("treeSha512");
});

test("macOS packaging builds apply-patch from source and verifies signed/notarized bundles separately", () => {
  expect(packageJson.scripts["build:apply-patch"]).toBe("bun scripts/build-apply-patch.ts host");
  expect(packageJson.scripts["build:apply-patch:universal"]).toBe("bun scripts/build-apply-patch.ts universal");
  expect(packageJson.scripts["package:mac:build"]).toContain("bun run build:apply-patch:universal");
  expect(packageJson.scripts["package:dev:build"]).toContain("bun run build:apply-patch");
  expect(packageJson.scripts["dev:prepare"]).toContain("bun run build:apply-patch");
  expect(packageJson.scripts["dev"]).toBe("export NAUTILO_HOST=${NAUTILO_HOST:-127.0.0.1} NAUTILO_PROFILE=${NAUTILO_PROFILE:-}; bun run dev:prepare && bun run dev:launch");
  expect(packageJson.scripts["dev:launch"]).toBe("electron --remote-debugging-port=${NAUTILO_REMOTE_DEBUGGING_PORT:-9222} dist/main.js");
  expect(packageJson.scripts["app"]).toContain("bun run dev:prepare");
  const filters = extraResourceFilterPatterns("vendor/apply-patch");
  expect(filters).toEqual([
    "darwin-arm64/nautilo-apply-patch",
    "darwin-x64/nautilo-apply-patch",
    "runtime-manifest.json",
    "LICENSE",
    "NOTICE",
    "UPSTREAM.toml",
    "THIRD_PARTY_NOTICES.txt",
  ]);
  expect(electronBuilderYml).toContain("tools-apply-patch");
  const sourceBuild = readFileSync(join(desktopRoot, "scripts/build-apply-patch.ts"), "utf-8");
  expect(sourceBuild).toContain('"--locked"');
  expect(sourceBuild).toContain("rustup");
  expect(sourceBuild).toContain('join(homedir(), ".cargo", "bin", command)');
  expect(sourceBuild).toContain('process.env["CARGO_HOME"]');
  expect(sourceBuild).not.toMatch(/releaseAssetBearerTokenFile|fetchAndVerifyVendoredBinary|GITHUB_TOKEN/);
});

// D417 — desktop dev resolution (electron/ffmpeg-runtime.ts) requires the
// checksum-pinned vendor/ffmpeg to exist before launch. Without provisioning
// it, `bun run dev` / `bun run app` boot Electron into a state where the
// extract-audio tool surfaces the managed-FFmpeg-missing error. The dev/app
// scripts must invoke `vendor:ffmpeg` before `build:electron` so a plain dev
// loop provisions the pinned binary without relying on PATH/Homebrew fallback.
test("dev prepares managed FFmpeg before the standalone Electron launch command", () => {
  expect(packageJson.scripts["dev:prepare"]).toContain("bun run vendor:ffmpeg");
  expect(packageJson.scripts["app"]).toContain("bun run dev:prepare");
  const devVendorIndex = packageJson.scripts["dev:prepare"].indexOf("bun run vendor:ffmpeg");
  const devBuildIndex = packageJson.scripts["dev:prepare"].indexOf("bun run build:electron");
  expect(devVendorIndex).toBeGreaterThanOrEqual(0);
  expect(devBuildIndex).toBeGreaterThan(devVendorIndex);
  expect(packageJson.scripts["dev:launch"]).not.toContain("vendor:ffmpeg");
  expect(packageJson.scripts["dev:launch"]).not.toContain("build:electron");
});

test("Electron build copies OpenMLS beside the main bundle and injects that runtime path", () => {
  const buildScript = readFileSync(
    join(desktopRoot, "scripts/build-electron.ts"),
    "utf-8",
  );
  const latticeCryptoRoot = join(desktopRoot, "../../packages/lattice-crypto");
  const openMlsSources = [
    readFileSync(join(latticeCryptoRoot, "src/group/openmls.ts"), "utf-8"),
    readFileSync(join(latticeCryptoRoot, "src/group/v2-openmls.ts"), "utf-8"),
  ];
  expect(buildScript).toContain(
    "__NAUTILO_OPENMLS_WASM_GLUE__: JSON.stringify(",
  );
  expect(buildScript).toContain('"./openmls-wasm/openmls_wasm.js"');
  expect(buildScript).toContain(
    '["openmls_wasm.js", "openmls_wasm_bg.wasm"]',
  );
  expect(buildScript).toContain('JSON.stringify({ type: "module" })');
  expect(buildScript).toContain("__NAUTILO_OPENMLS_WASM_BYTES__");
  expect(buildScript).toContain("openmls_wasm_bg.wasm");
  for (const source of openMlsSources) {
    expect(source).toContain(
      'typeof __NAUTILO_OPENMLS_WASM_GLUE__ === "string"',
    );
    expect(source).toContain("? __NAUTILO_OPENMLS_WASM_GLUE__");
    expect(source).toContain(
      'typeof __NAUTILO_OPENMLS_WASM_BYTES__ === "undefined"',
    );
    expect(source).toContain("default(VENDOR_WASM_BYTES)");
  }
});

// D373 stack-137 — node-pty's spawn-helper is posix_spawn'd at runtime and
// cannot live inside app.asar. The pin must be explicit (electron-builder's
// implicit smart-unpack is unreliable over bun's symlinked node_modules), and
// after-pack.cjs must re-assert +x on the unpacked binary. Guard both so a
// config edit can't silently ship a build with broken terminals.
test("electron-builder pins native runtime packages to asarUnpack", () => {
  expect(electronBuilderYml).toMatch(/asarUnpack:/);
  expect(electronBuilderYml).toContain("**/node_modules/node-pty/**");
  expect(electronBuilderYml).toContain("**/node_modules/argon2/**");
  expect(electronBuilderYml).toContain("**/node_modules/sharp/**");
  expect(electronBuilderYml).toContain("**/node_modules/@img/sharp-*/**");
  expect(electronBuilderYml).toContain("**/node_modules/@img/sharp-libvips-*/**");
  expect(packageJson.dependencies?.["argon2"]).toBe("0.44.0");
  expect(packageJson.dependencies?.["sharp"]).toBe("0.35.4");
});

test("after-pack re-asserts +x on the packaged spawn-helper and vendored tool binaries", () => {
  const afterPack = readFileSync(join(desktopRoot, "scripts/after-pack.cjs"), "utf-8");
  expect(afterPack).toContain("spawn-helper");
  expect(afterPack).toContain("fixVendoredToolBinaryPerms");
  expect(afterPack).toContain("officecli");
  expect(afterPack).toContain("ffmpeg");
  expect(afterPack).toContain("openhue");
  expect(afterPack).toContain("nautilo-apply-patch");
  expect(afterPack).toContain("0o755");
});

test("every packaged app enforces the production ASAR inventory before signing", () => {
  const afterPack = readFileSync(join(desktopRoot, "scripts/after-pack.cjs"), "utf-8");
  expect(electronBuilderYml).toContain('"!**/*.map"');
  expect(electronBuilderYml).toContain('"!**/*.{test,spec}.{js,cjs,mjs,jsx,ts,tsx}"');
  expect(afterPack).toContain("verify-package-inventory.ts");
  expect(afterPack).toContain('join(resourcesDir, "app.asar")');
  expect(packageJson.scripts["verify:package-inventory"])
    .toBe("bun scripts/verify-package-inventory.ts");
  expect(packageJson.devDependencies?.["@electron/asar"]).toBe("3.4.1");
});

test("after-pack flips fuses but does not manually codesign the Darwin bundle", () => {
  const afterPack = readFileSync(join(desktopRoot, "scripts/after-pack.cjs"), "utf-8");
  expect(afterPack).toContain("flip-fuses.ts");
  expect(afterPack).toContain("flipping Electron fuses");
  expect(afterPack).not.toContain("adHocSignDarwinBundle");
  expect(afterPack).not.toMatch(/execFileSync\s*\(\s*["']codesign["']/);
  expect(afterPack).not.toContain('"codesign"');
  expect(afterPack).not.toContain("'codesign'");
  expect(afterPack).not.toContain("--deep");
});

const UNSIGNED_ENTITLEMENTS_OVERRIDE =
  "-c.mac.entitlements=entitlements.mac.unsigned.plist";
const UNSIGNED_ENTITLEMENTS_INHERIT_OVERRIDE =
  "-c.mac.entitlementsInherit=entitlements.mac.unsigned.inherit.plist";
const UNSIGNED_IDENTITY_OVERRIDE = "-c.mac.identity=-";
const UNSIGNED_NOTARIZE_OVERRIDE = "-c.mac.notarize=false";

test("contributor electron-builder config keeps host-only TCC entitlements off helpers", () => {
  expect(electronBuilderYml).toMatch(/^ {2}entitlements: entitlements\.mac\.unsigned\.plist$/m);
  expect(electronBuilderYml).toMatch(/^ {2}entitlementsInherit: entitlements\.mac\.unsigned\.inherit\.plist$/m);
});

test("macOS source config declares only Nautilo's picker-triggered Local Network Bonjour service", () => {
  const extendInfo = electronBuilderYml.match(/ {2}extendInfo:\n([\s\S]*?)(?=\n {2}extraResources:)/)?.[1] ?? "";
  expect(extendInfo).toContain("NSLocalNetworkUsageDescription:");
  expect(extendInfo).toContain("NSBonjourServices:");
  expect(extendInfo.match(/^ {6}- _nautilo\._tcp$/gm)).toEqual(["      - _nautilo._tcp"]);
  expect(extendInfo).not.toContain("com.apple.security.network.server");
});

test("after-pack validates the generated macOS Info.plist before either signing path", () => {
  const afterPack = readFileSync(join(desktopRoot, "scripts/after-pack.cjs"), "utf-8");
  expect(afterPack).toContain("assertMacLocalNetworkInfo");
  expect(afterPack).toContain("NSLocalNetworkUsageDescription");
  expect(afterPack).toContain("NSBonjourServices");
  expect(afterPack).toContain("_nautilo._tcp");
  expect(afterPack).toContain(
    "Nautilo looks for Nautilo servers on your local network when you open the server picker.",
  );
  expect(afterPack).toContain('electronPlatformName === "darwin"');
  expect(afterPack).not.toContain("com.apple.security.app-sandbox");
  for (const scriptName of ["package:mac", "package:dev"] as const) {
    expect(packageJson.scripts[scriptName]).not.toContain("mac.extendInfo");
  }
});

test("packaged Local Network inspector records exact plist identity, commit, and actual signature mode", () => {
  expect(packageJson.scripts["inspect:mac:local-network"])
    .toBe("bun scripts/inspect-macos-local-network-artifact.ts");
  const inspector = readFileSync(
    join(desktopRoot, "scripts/inspect-macos-local-network-artifact.ts"),
    "utf-8",
  );
  expect(inspector).toContain('EXPECTED_BUNDLE_ID = "com.nautilo.desktop"');
  expect(inspector).toContain('EXPECTED_BONJOUR_SERVICES = ["_nautilo._tcp"]');
  expect(inspector).toContain('spawnSync("codesign", ["-d", "--verbose=4", appPath]');
  expect(inspector).toContain('spawnSync("codesign", ["--verify", "--strict", "--verbose=4", appPath]');
  expect(inspector).toContain('runChecked("dwarfdump", ["--uuid", executable])');
  expect(inspector).toContain('process.env["APPLE_TEAM_ID"]');
  expect(inspector).toContain('runChecked("git", ["rev-parse", "HEAD"])');
  expect(inspector).toContain("--expect-signature");
  expect(electronBuilderYml).toContain("afterSign: ./scripts/after-sign.cjs");
  const afterSign = readFileSync(join(desktopRoot, "scripts/after-sign.cjs"), "utf-8");
  expect(afterSign).toContain("inspect-macos-local-network-artifact.ts");
  expect(afterSign).toContain("verify-packaged-computer-use-host.ts");
  expect(afterSign).toContain("PACKAGED_HOST_VERIFIER_TIMEOUT_MS");
  expect(afterSign).toContain('killSignal: "SIGKILL"');
  expect(afterSign).toContain("process.env.APPLE_TEAM_ID");
  expect(afterSign).toContain("context.appOutDir");
  expect(afterSign).toContain('context.electronPlatformName !== "darwin"');
});

test("unsigned package wrappers pass unsigned entitlements overrides and disable notarization", () => {
  for (const scriptName of ["package:mac", "package:dev"] as const) {
    const script = packageJson.scripts[scriptName];
    expect(script).toContain(UNSIGNED_IDENTITY_OVERRIDE);
    expect(script).toContain(UNSIGNED_ENTITLEMENTS_OVERRIDE);
    expect(script).toContain(UNSIGNED_ENTITLEMENTS_INHERIT_OVERRIDE);
    expect(script).toContain(UNSIGNED_NOTARIZE_OVERRIDE);
    expect(script).toMatch(/bun run package:(?:mac|dev):build -- /);
  }
});

test("contributor packaging has no official signed command or certificate discovery default", () => {
  expect(packageJson.scripts["package:mac:signed"]).toBeUndefined();
  expect(electronBuilderYml).toMatch(/^ {2}identity: "-"$/m);
  expect(electronBuilderYml).toMatch(/^ {2}notarize: false$/m);
});

test("unsigned entitlements plist copies signed capabilities and adds disable-library-validation", () => {
  const unsignedPlist = readFileSync(
    join(desktopRoot, "entitlements.mac.unsigned.plist"),
    "utf-8",
  );
  expect(unsignedPlist).toContain("com.apple.security.cs.allow-jit");
  expect(unsignedPlist).toContain("com.apple.security.network.client");
  expect(unsignedPlist).toContain("com.apple.security.device.audio-input");
  expect(unsignedPlist).toContain("com.apple.security.automation.apple-events");
  expect(unsignedPlist).toContain("com.apple.security.device.screen-capture");
  expect(unsignedPlist).toContain("com.apple.security.cs.disable-library-validation");
  const inherited = readFileSync(
    join(desktopRoot, "entitlements.mac.unsigned.inherit.plist"),
    "utf-8",
  );
  expect(inherited).toContain("com.apple.security.cs.disable-library-validation");
  expect(inherited).not.toContain("com.apple.security.automation.apple-events");
  expect(inherited).not.toContain("com.apple.security.device.screen-capture");
});

test("signed entitlements plist does not disable library validation", () => {
  const signedPlist = readFileSync(join(desktopRoot, "entitlements.mac.plist"), "utf-8");
  expect(signedPlist).toContain("com.apple.security.cs.allow-jit");
  expect(signedPlist).toContain("com.apple.security.network.client");
  expect(signedPlist).toContain("com.apple.security.device.audio-input");
  expect(signedPlist).toContain("com.apple.security.automation.apple-events");
  expect(signedPlist).toContain("com.apple.security.device.screen-capture");
  expect(signedPlist).not.toContain("com.apple.security.cs.disable-library-validation");
  const inherited = readFileSync(
    join(desktopRoot, "entitlements.mac.inherit.plist"),
    "utf-8",
  );
  expect(inherited).not.toContain("com.apple.security.automation.apple-events");
  expect(inherited).not.toContain("com.apple.security.device.screen-capture");
});

// D373 stack-137 — node-pty's thin per-arch prebuilds are byte-identical across
// the x64/arm64 temp apps, so the universal merge (@electron/universal) errors
// unless they're in the x64ArchFiles runtime-select allowlist (like bun/tools).
// Without this the universal DMG build fails at the merge step.
test("native addon payloads are covered by the x64ArchFiles universal allowlist", () => {
  const match = electronBuilderYml.match(/x64ArchFiles:\s*"([^"]+)"/);
  expect(match).not.toBeNull();
  expect(match?.[1]).toContain("app.asar.unpacked/node_modules/{node-pty,argon2,sharp,");
  expect(match?.[1]).toContain("tools-ffmpeg");
});

test("Sharp's external darwin runtime payload is universal-merge safe", () => {
  const match = electronBuilderYml.match(/x64ArchFiles:\s*"([^"]+)"/);
  expect(match).not.toBeNull();
  for (const packageName of [
    "sharp",
    "@img/sharp-darwin-arm64",
    "@img/sharp-darwin-x64",
    "@img/sharp-libvips-darwin-arm64",
    "@img/sharp-libvips-darwin-x64",
  ]) {
    expect(match?.[1]).toContain(packageName);
  }
  const buildElectron = readFileSync(join(desktopRoot, "scripts/build-electron.ts"), "utf-8");
  expect(buildElectron).toMatch(/external:\s*\[[^\]]*"sharp"/);
});

/** Legacy D091 inline palette hex values — must not remain in source HTML. */
const LEGACY_ONBOARDING_PALETTE_HEX = [
  "#0a0d16",
  "#13182a",
  "#a78bfa",
  "#7c3aed",
  "#fafbff",
] as const;

test(
  "build:electron produces all expected dist artifacts",
  () => {
    const r = spawnSync("bun", ["run", "build:electron"], {
      cwd: desktopRoot,
      stdio: "inherit",
    });
    expect(r.status).toBe(0);
    const expected = [
      "dist/main.js",
      "dist/preload.js",
      "dist/preload-first-run.js",
      "dist/preload-onboarding.js",
      "dist/browser-control-provider.js",
      "dist/first-run/index.html",
      "dist/first-run/index.js",
      "dist/onboarding/index.html",
      "dist/onboarding/index.js",
    ];
    for (const p of expected) {
      expect(existsSync(join(desktopRoot, p))).toBe(true);
    }

    const distFirstRunHtml = readFileSync(
      join(desktopRoot, "dist/first-run/index.html"),
      "utf-8",
    );
    expect(distFirstRunHtml).toContain("--bg: #1a1b26;");
    expect(distFirstRunHtml).toContain("--accent: #82aaff;");
    expect(distFirstRunHtml).toContain("--bg: #faf8f5;");
    expect(distFirstRunHtml).toContain("--accent: #2d2a26;");
    expect(distFirstRunHtml).not.toContain("__NAUTILO_SEMANTIC_SETUP_PALETTE__");

    const sourceFirstRunHtml = readFileSync(
      join(desktopRoot, "first-run/index.html"),
      "utf-8",
    );
    expect(sourceFirstRunHtml).toContain("/* __NAUTILO_SEMANTIC_SETUP_PALETTE__ */");
    expect(sourceFirstRunHtml).not.toMatch(/#[0-9a-f]{6}/i);

    const distOnboardingHtml = readFileSync(
      join(desktopRoot, "dist/onboarding/index.html"),
      "utf-8",
    );
    expect(distOnboardingHtml).toContain("--accent: #a78bfa;");
    expect(distOnboardingHtml).toContain("@media (prefers-color-scheme: light)");
    expect(distOnboardingHtml).toContain("--accent: #7c3aed;");

    const sourceOnboardingHtml = readFileSync(
      join(desktopRoot, "onboarding/index.html"),
      "utf-8",
    );
    expect(sourceOnboardingHtml).toContain("/* __NAUTILO_ONBOARDING_PALETTE__ */");
    for (const hex of LEGACY_ONBOARDING_PALETTE_HEX) {
      expect(sourceOnboardingHtml).not.toContain(hex);
    }
    expect(sourceOnboardingHtml).not.toContain("D091 Phase 1 — standalone palette");
  },
  { timeout: 600_000 },
);
