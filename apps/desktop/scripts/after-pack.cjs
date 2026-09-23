/**
 * electron-builder afterPack hook.
 *
 * electron-builder requires CommonJS for hook entry points. This hook
 * mutates the packaged app (fuse flip, executable permission fixes)
 * but does NOT sign it. The selected packaging configuration controls the
 * later signing phase; the product defaults permit ad-hoc identity only.
 * Manual codesign here would nest signatures and cause Team-ID mismatch /
 * DYLD crashes at launch.
 *
 * `context.appOutDir` is the platform-specific directory containing
 * the packaged app:
 * - macOS: `release/mac-arm64/` (or `mac/`) — contains `<productName>.app`
 * - Windows: `release/win-unpacked/` — contains `<productName>.exe`
 * - Linux: `release/linux-unpacked/` — contains the binary directory
 *
 * The fuses tool accepts the path TO the bundle (.app on macOS, the
 * .exe on Windows, the binary on Linux); we resolve it per-platform.
 */
const { execFileSync } = require("node:child_process");
const { chmodSync, existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const EXPECTED_LOCAL_NETWORK_USAGE =
  "Nautilo looks for Nautilo servers on your local network when you open the server picker.";
const EXPECTED_SCREEN_CAPTURE_USAGE =
  "Nautilo captures the screen only when you enable Computer use and ask a Genie to observe or control this Mac.";
const EXPECTED_APPLE_EVENTS_USAGE =
  "Nautilo uses Automation only when an approved Computer use action needs to communicate with another app.";

/** Vendored desktop tool binaries that must be executable in the packaged .app. */
const VENDORED_TOOL_BINARY_NAMES = new Set([
  "agent-browser",
  "cua-driver",
  "nautilo-computer-use-host",
  "ffmpeg",
  "gog",
  "nautilo-apply-patch",
  "officecli",
  "openhue",
  "rg",
  "nautilo-screen-recording-permission",
  "nautilo-window-presence",
]);

/**
 * inspect the generated Info.plist, not merely the YAML source. This
 * runs before electron-builder's normal post-afterPack signing step, so both
 * unsigned development bundles and Developer-ID bundles share the same guard.
 */
function assertMacLocalNetworkInfo(bundlePath) {
  const expectedBundleIdentifier = "com.nautilo.desktop";
  const infoPlist = join(bundlePath, "Contents", "Info.plist");
  const bundleIdentifier = execFileSync(
    "plutil",
    ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlist],
    { encoding: "utf8" },
  ).trim();
  const description = execFileSync(
    "plutil",
    ["-extract", "NSLocalNetworkUsageDescription", "raw", "-o", "-", infoPlist],
    { encoding: "utf8" },
  ).trim();
  const screenCaptureDescription = execFileSync(
    "plutil",
    ["-extract", "NSScreenCaptureUsageDescription", "raw", "-o", "-", infoPlist],
    { encoding: "utf8" },
  ).trim();
  const appleEventsDescription = execFileSync(
    "plutil",
    ["-extract", "NSAppleEventsUsageDescription", "raw", "-o", "-", infoPlist],
    { encoding: "utf8" },
  ).trim();
  const services = JSON.parse(execFileSync(
    "plutil",
    ["-extract", "NSBonjourServices", "json", "-o", "-", infoPlist],
    { encoding: "utf8" },
  ));
  if (
    bundleIdentifier !== expectedBundleIdentifier ||
    description !== EXPECTED_LOCAL_NETWORK_USAGE ||
    screenCaptureDescription !== EXPECTED_SCREEN_CAPTURE_USAGE ||
    appleEventsDescription !== EXPECTED_APPLE_EVENTS_USAGE ||
    !Array.isArray(services) ||
    services.length !== 1 ||
    services[0] !== "_nautilo._tcp"
  ) {
    throw new Error(
      `[after-pack] Info.plist must retain ${expectedBundleIdentifier}, the canonical Local Network, Screen Capture, and Automation usage strings, and exactly _nautilo._tcp`,
    );
  }
}

/**
 * Re-assert +x on vendored tool binaries under Contents/Resources/tools*.
 *
 * OfficeCLI uses platform-key subdirs (tools-officecli/darwin-arm64/officecli);
 * agent-browser/gog use arch subdirs (tools-agent-browser/arm64/agent-browser).
 * Source perms are not reliable across bun installs / universal temp merges.
 */
function fixVendoredToolBinaryPerms(appOutDir) {
  let fixed = 0;
  const stack = [appOutDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && VENDORED_TOOL_BINARY_NAMES.has(entry.name)) {
        chmodSync(full, 0o755);
        fixed++;
      }
    }
  }
  if (fixed > 0) {
    console.log(`[after-pack] restored +x on ${fixed} vendored tool binary(ies)`);
  }
}

/**
 * re-assert +x on node-pty's `spawn-helper` in the packed app.
 *
 * node-pty `posix_spawn`s `spawn-helper` at runtime; it MUST be mode 0755.
 * The packaged bit is inherited from the source file at pack time, and bun's
 * install drops +x on the prebuilt binary (see dev/scripts/fix-node-pty-perms.ts).
 * Relying on a fresh postinstall having run on the build machine is a timing
 * dependency, not a guarantee baked into the artifact — so we re-assert +x on
 * the SHIPPED binary here, before electron-builder's post-afterPack signing,
 * independent of source perms.
 *
 * Walks `appOutDir` for every file named `spawn-helper` (only ever appears
 * under app.asar.unpacked/.../node-pty/prebuilds/<platform-arch>/, which the
 * electron-builder.yml asarUnpack pin guarantees is unpacked). Running from
 * appOutDir means we also cover the per-arch universal temp apps, which return
 * early below after fuse flip. No-op on Windows (no spawn-helper).
 */
function fixSpawnHelperPerms(appOutDir) {
  let fixed = 0;
  const stack = [appOutDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir (e.g. a symlink loop) — skip
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name === "spawn-helper") {
        chmodSync(full, 0o755);
        fixed++;
      }
    }
  }
  if (fixed > 0) {
    console.log(`[after-pack] restored +x on ${fixed} node-pty spawn-helper binary(ies)`);
  }
}

function isUniversalTempOutput(appOutDir) {
  return /mac-universal-(arm64|x64)-temp$/.test(appOutDir);
}

/**
 * @param {{ appOutDir: string, packager: { appInfo: { productFilename: string, productName: string } }, electronPlatformName: string }} context
 */
exports.default = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  const productFilename = packager.appInfo.productFilename || packager.appInfo.productName;

  let bundlePath;
  if (electronPlatformName === "darwin" || electronPlatformName === "mas") {
    bundlePath = join(appOutDir, `${productFilename}.app`);
  } else if (electronPlatformName === "win32") {
    bundlePath = join(appOutDir, `${productFilename}.exe`);
  } else {
    bundlePath = join(appOutDir, productFilename);
  }

  // Re-assert +x on node-pty's spawn-helper first — this must happen for every
  // pack pass INCLUDING the per-arch universal temp apps, which return early
  // after fuse flip further down. Runs regardless of whether the bundle path
  // resolves, so terminals work even if the fuse flip is skipped.
  fixSpawnHelperPerms(appOutDir);
  fixVendoredToolBinaryPerms(appOutDir);

  if (!existsSync(bundlePath)) {
    console.warn(`[after-pack] could not locate built bundle at ${bundlePath} — skipping fuse flip`);
    return;
  }

  if (electronPlatformName === "darwin" || electronPlatformName === "mas") {
    assertMacLocalNetworkInfo(bundlePath);
  }

  const resourcesDir = electronPlatformName === "darwin" || electronPlatformName === "mas"
    ? join(bundlePath, "Contents", "Resources")
    : join(appOutDir, "resources");
  execFileSync("bun", ["run", join(__dirname, "desktop-license-payload.ts"), resourcesDir], {
    stdio: "inherit",
    cwd: join(__dirname, ".."),
  });

  const packageInventoryScript = join(__dirname, "verify-package-inventory.ts");
  execFileSync("bun", ["run", packageInventoryScript, join(resourcesDir, "app.asar")], {
    stdio: "inherit",
    cwd: join(__dirname, ".."),
  });

  if (electronPlatformName === "darwin" || electronPlatformName === "mas") {
    execFileSync("bun", ["run", join(__dirname, "verify-ffmpeg.ts"), join(resourcesDir, "tools-ffmpeg"), "--allow-resigned"], { stdio: "inherit", cwd: join(__dirname, "..") });
  }

  console.log(`[after-pack] flipping Electron fuses on ${bundlePath}`);
  const flipScript = join(__dirname, "flip-fuses.ts");
  execFileSync("bun", ["run", flipScript, bundlePath], {
    stdio: "inherit",
    cwd: join(__dirname, ".."),
  });

  if ((electronPlatformName === "darwin" || electronPlatformName === "mas") && isUniversalTempOutput(appOutDir)) {
    // electron-builder creates x64/arm64 temp apps, then @electron/universal
    // merges them into the final universal .app. Only the merged app is signed
    // in electron-builder's post-afterPack phase; temp apps need fuse flip and
    // permission fixes only.
    console.log(`[after-pack] done with universal temp app ${bundlePath} (signing deferred to merged app)`);
    return;
  }
};
