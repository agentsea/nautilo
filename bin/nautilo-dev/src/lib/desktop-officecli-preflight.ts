import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import type { SpawnSyncFn } from "./officecli-preflight";

/** macOS desktop OfficeCLI artifact keys (mirrors apps/desktop vendor script). */
const DESKTOP_DARWIN_PLATFORM_KEYS = ["darwin-arm64", "darwin-x64"] as const;

const DESKTOP_REL = "apps/desktop";

export interface EnsureDesktopOfficeCliProvisionedOptions {
  /** Test seam — defaults to node:child_process spawnSync. */
  spawn?: SpawnSyncFn;
}

interface DesktopOfficeCliManifestEntry {
  version: string;
  binaryName?: string;
  artifacts?: Partial<
    Record<(typeof DESKTOP_DARWIN_PLATFORM_KEYS)[number], { sizeMin?: number }>
  >;
}

function loadDesktopOfficeCliEntry(manifestPath: string): DesktopOfficeCliManifestEntry | null {
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      officecli?: DesktopOfficeCliManifestEntry;
    };
    const entry = parsed.officecli;
    if (entry === undefined || typeof entry.version !== "string" || entry.version.trim() === "") {
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

function isDesktopOfficeCliFresh(
  vendorDir: string,
  entry: DesktopOfficeCliManifestEntry,
): boolean {
  const stampPath = join(vendorDir, ".version");
  if (!existsSync(stampPath)) return false;
  if (readFileSync(stampPath, "utf8").trim() !== entry.version) return false;

  const binaryName = entry.binaryName ?? "officecli";
  for (const platformKey of DESKTOP_DARWIN_PLATFORM_KEYS) {
    const artifact = entry.artifacts?.[platformKey];
    if (artifact === undefined) return false;
    const bin = join(vendorDir, platformKey, binaryName);
    const minBytes = artifact.sizeMin ?? 1_000_000;
    if (!existsSync(bin) || statSync(bin).size < minBytes) return false;
  }
  return true;
}

/**
 * M206 — ensure the pinned desktop OfficeCLI binaries are present under
 * `apps/desktop/vendor/officecli` before Electron starts. Idempotent: a fresh
 * `.version` stamp plus both darwin binaries is a no-op.
 *
 * Fail closed — returns false on any provisioning failure so dev-stack does
 * not launch Electron without a verified local OfficeCLI runtime.
 */
export function ensureDesktopOfficeCliProvisioned(
  repoRoot: string,
  opts: EnsureDesktopOfficeCliProvisionedOptions = {},
): boolean {
  const spawn: SpawnSyncFn = opts.spawn ?? (nodeSpawnSync as unknown as SpawnSyncFn);
  const desktopRoot = join(repoRoot, DESKTOP_REL);
  const vendorDir = join(desktopRoot, "vendor", "officecli");
  const manifestPath = join(desktopRoot, "vendor", "tool-runtimes.manifest.json");

  const entry = loadDesktopOfficeCliEntry(manifestPath);
  if (entry === null) {
    process.stderr.write(
      `[dev-stack] desktop officecli: no officecli entry in ${manifestPath} — cannot start Electron relay\n`,
    );
    return false;
  }

  if (isDesktopOfficeCliFresh(vendorDir, entry)) {
    return true;
  }

  process.stderr.write(
    `[dev-stack] desktop officecli: provisioning darwin-arm64 + darwin-x64 v${entry.version}…\n`,
  );
  const script = join(desktopRoot, "scripts/vendor-officecli.ts");
  const res = spawn("bun", [script], { stdio: "inherit", cwd: desktopRoot });
  if (res.status !== 0) {
    process.stderr.write(
      `[dev-stack] desktop officecli: provisioning FAILED (exit ${res.status ?? "?"}) — ` +
        `Electron relay requires verified OfficeCLI\n`,
    );
    process.stderr.write(
      `[dev-stack] Remediation: from apps/desktop run \`bun run vendor:officecli\`\n`,
    );
    return false;
  }
  return true;
}
