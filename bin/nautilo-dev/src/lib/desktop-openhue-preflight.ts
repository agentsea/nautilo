import { spawnSync as nodeSpawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SpawnSyncFn } from "./officecli-preflight";

const DESKTOP_REL = "apps/desktop";

export interface EnsureDesktopOpenHueProvisionedOptions {
  /** Test seam — defaults to node:child_process spawnSync. */
  spawn?: SpawnSyncFn;
}

interface DesktopOpenHueManifestEntry {
  version: string;
}

function loadDesktopOpenHueEntry(manifestPath: string): DesktopOpenHueManifestEntry | null {
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      openhue?: DesktopOpenHueManifestEntry;
    };
    const entry = parsed.openhue;
    if (entry === undefined || typeof entry.version !== "string" || entry.version.trim() === "") {
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

function isDesktopOpenHueFresh(vendorDir: string, entry: DesktopOpenHueManifestEntry): boolean {
  const stampPath = join(vendorDir, ".version");
  const binaryPath = join(vendorDir, "openhue");
  try {
    return (
      existsSync(stampPath) &&
      readFileSync(stampPath, "utf8").trim() === entry.version &&
      existsSync(binaryPath) &&
      statSync(binaryPath).isFile() &&
      (statSync(binaryPath).mode & 0o111) !== 0
    );
  } catch {
    return false;
  }
}

/**
 * Ensure the pinned universal OpenHue binary is available to the desktop relay
 * before Electron starts. Fail closed: Electron cannot launch unless the
 * version-stamped vendor binary is present and executable.
 */
export function ensureDesktopOpenHueProvisioned(
  repoRoot: string,
  opts: EnsureDesktopOpenHueProvisionedOptions = {},
): boolean {
  const spawn: SpawnSyncFn = opts.spawn ?? (nodeSpawnSync as unknown as SpawnSyncFn);
  const desktopRoot = join(repoRoot, DESKTOP_REL);
  const vendorDir = join(desktopRoot, "vendor", "openhue");
  const manifestPath = join(desktopRoot, "vendor", "tool-runtimes.manifest.json");
  const entry = loadDesktopOpenHueEntry(manifestPath);

  if (entry === null) {
    process.stderr.write(
      `[dev-stack] desktop openhue: no openhue entry in ${manifestPath} — cannot start Electron relay\n`,
    );
    return false;
  }
  if (isDesktopOpenHueFresh(vendorDir, entry)) return true;

  process.stderr.write(`[dev-stack] desktop openhue: provisioning v${entry.version}…\n`);
  try {
    const res = spawn("bun", [join(desktopRoot, "scripts/vendor-openhue.ts")], {
      stdio: "inherit",
      cwd: desktopRoot,
    });
    if (res.status !== 0 || !isDesktopOpenHueFresh(vendorDir, entry)) {
      process.stderr.write(
        `[dev-stack] desktop openhue: provisioning FAILED (exit ${res.status ?? "?"}) — ` +
          "Electron relay requires verified OpenHue\n",
      );
      return false;
    }
  } catch {
    process.stderr.write(
      "[dev-stack] desktop openhue: provisioning FAILED — Electron relay requires verified OpenHue\n",
    );
    return false;
  }
  return true;
}
