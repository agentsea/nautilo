import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import {
  detectOfficeCliPlatformKey,
  loadOfficeCliManifest,
  resolveOfficeCliVendorRoot,
  resolveVendoredOfficeCliPath,
} from "@nautilo/config/officecli";

/** Injectable subset of `node:child_process` spawnSync used by the preflight. */
export type SpawnSyncFn = (
  command: string,
  args: string[],
  options: { stdio: "inherit"; cwd: string },
) => { status: number | null };

export interface EnsureOfficeCliProvisionedOptions {
  /** Test seam — defaults to node:child_process spawnSync. */
  spawn?: SpawnSyncFn;
}

/**
 * M203 — ensure the pinned OfficeCLI binary for THIS host is present and
 * matches the manifest version before the dev server starts. Idempotent:
 * a fresh binary (matching .version + present on disk) is a no-op.
 *
 * Never throws — a provisioning failure logs a warning and returns false so
 * dev-stack still boots (the officecli tool self-gates via officeCliAvailable).
 */
export function ensureOfficeCliProvisioned(
  repoRoot: string,
  opts: EnsureOfficeCliProvisionedOptions = {},
): boolean {
  const spawn: SpawnSyncFn = opts.spawn ?? (nodeSpawnSync as unknown as SpawnSyncFn);

  const platformKey = detectOfficeCliPlatformKey();
  if (platformKey === null) {
    process.stderr.write(
      `[dev-stack] officecli: unsupported host platform — skipping (office tools will be hidden)\n`,
    );
    return false;
  }

  const vendorRoot = resolveOfficeCliVendorRoot({ repoRoot });
  const manifestPath = join(vendorRoot, "manifest.json");
  if (!existsSync(manifestPath)) {
    process.stderr.write(`[dev-stack] officecli: no manifest at ${manifestPath} — skipping\n`);
    return false;
  }

  let manifest: ReturnType<typeof loadOfficeCliManifest>;
  try {
    manifest = loadOfficeCliManifest(manifestPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[dev-stack] officecli: manifest parse failed (${msg}) — skipping\n`);
    return false;
  }

  const artifact = manifest.officecli.artifacts[platformKey];
  if (!artifact) {
    process.stderr.write(
      `[dev-stack] officecli: manifest has no ${platformKey} artifact — skipping\n`,
    );
    return false;
  }

  let binaryPath: string;
  try {
    binaryPath = resolveVendoredOfficeCliPath({ vendorRoot, platformKey, manifest });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[dev-stack] officecli: cannot resolve binary path (${msg}) — skipping\n`);
    return false;
  }
  const stampPath = join(vendorRoot, ".version");

  // Freshness check (mirrors apps/desktop/scripts/vendor-agent-browser.ts isFresh()).
  const stampFresh =
    existsSync(stampPath) &&
    readFileSync(stampPath, "utf8").trim() === manifest.officecli.version;
  const binaryPresent =
    existsSync(binaryPath) && statSync(binaryPath).size >= (artifact.sizeMin ?? 1_000_000);
  if (stampFresh && binaryPresent) {
    return true; // cache hit — nothing to do
  }

  process.stderr.write(
    `[dev-stack] officecli: provisioning ${platformKey} v${manifest.officecli.version}…\n`,
  );
  const script = join(repoRoot, "dev/scripts/vendor-officecli.ts");
  const res = spawn("bun", [script, platformKey], { stdio: "inherit", cwd: repoRoot });
  if (res.status !== 0) {
    process.stderr.write(
      `[dev-stack] officecli: provisioning FAILED (exit ${res.status ?? "?"}) — ` +
        `office tools will be hidden until fixed\n`,
    );
    return false;
  }
  return true;
}
