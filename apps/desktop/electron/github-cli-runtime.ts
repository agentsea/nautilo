import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../vendor/tool-runtimes.manifest.json";
import { detectDesktopPlatformKey, resolveDesktopRuntimePath } from "./tool-runtime-resolver";
import { parseToolRuntimesManifest, type ToolRuntimePlatformKey } from "./tool-runtimes-manifest";

export const githubCliManifest = parseToolRuntimesManifest(JSON.stringify(manifest))["github-cli"]!;
type SignatureCommand = (args: readonly string[]) => string;
function codesign(args: readonly string[]): string {
  const result = spawnSync("/usr/bin/codesign", [...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" } });
  if (result.error || result.status !== 0) throw new Error("GITHUB_RUNTIME_UNAVAILABLE");
  return `${result.stdout}\n${result.stderr}`;
}
function team(details: string): string | null {
  return /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(details)?.[1] ?? null;
}

/** Package bytes are authenticated by the enclosing app seal. A valid nested
 * signature alone cannot turn an arbitrary replacement into the pinned CLI.
 * Ad-hoc bundles are deliberately unavailable for credential custody. */
export function verifyGitHubAppSignature(input: {
  binaryPath: string; resourcesPath: string; executablePath: string;
}, run: SignatureCommand = codesign): boolean {
  try {
    const resources = resolve(input.resourcesPath);
    const executable = resolve(input.executablePath);
    const app = dirname(dirname(dirname(executable)));
    if (!app.endsWith(".app") || dirname(executable) !== join(app, "Contents", "MacOS") ||
      resources !== join(app, "Contents", "Resources") || realpathSync(resources) !== resources ||
      realpathSync(executable) !== executable || realpathSync(input.binaryPath) !== resolve(input.binaryPath) ||
      !["darwin-arm64", "darwin-x64"].some(key => resolve(input.binaryPath) === join(resources, "tools-github-cli", key, "gh"))) return false;
    // codesign treats -R arguments as filenames unless prefixed with '='.
    run(["--verify", "--deep", "--strict", "--all-architectures", "-R", '=anchor apple generic and identifier "com.nautilo.desktop"', app]);
    const appDetails = run(["-d", "--verbose=4", app]);
    const appTeam = team(appDetails);
    if (!appTeam || !/^Identifier=com\.nautilo\.desktop$/m.test(appDetails)) return false;
    for (const path of [executable, input.binaryPath]) {
      run(["--verify", "--strict", "--all-architectures", "-R", `=anchor apple generic and certificate leaf[subject.OU] = "${appTeam}"`, path]);
      if (team(run(["-d", "--verbose=4", path])) !== appTeam) return false;
    }
    return true;
  } catch { return false; }
}

/** Never caches success: installation custody pins this returned actual hash
 * and rejects subsequent drift. No credential process is executed here. */
export function verifiedGitHubFileHash(binaryPath: string, upstreamSha256: string,
  sealedPackage?: { resourcesPath: string; executablePath: string }, run?: SignatureCommand): string | null {
  try {
    if (!/^[a-f0-9]{64}$/.test(upstreamSha256) || realpathSync(binaryPath) !== resolve(binaryPath)) return null;
    const before = lstatSync(binaryPath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o111) === 0 || (before.mode & 0o022) !== 0) return null;
    const bytes = readFileSync(binaryPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sealedPackage ? !verifyGitHubAppSignature({ binaryPath, ...sealedPackage }, run) : sha256 !== upstreamSha256) return null;
    const after = lstatSync(binaryPath);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs || realpathSync(binaryPath) !== resolve(binaryPath) ||
      createHash("sha256").update(readFileSync(binaryPath)).digest("hex") !== sha256) return null;
    return sha256;
  } catch { return null; }
}

export type ProbeDesktopGitHubRuntimeResult =
  | { readonly ok: true; readonly binaryPath: string; readonly executableSha256: string; readonly version: string }
  | { readonly ok: false; readonly code: "GITHUB_RUNTIME_UNAVAILABLE" };

export function probeDesktopGitHubRuntime(input: {
  readonly isPackaged: boolean; readonly resourcesPath?: string | null;
  readonly devVendorRoot?: string; readonly platformKey?: ToolRuntimePlatformKey | null;
}): ProbeDesktopGitHubRuntimeResult {
  const unavailable = { ok: false, code: "GITHUB_RUNTIME_UNAVAILABLE" } as const;
  const key = input.platformKey === undefined ? detectDesktopPlatformKey() : input.platformKey;
  if (!key || !githubCliManifest) return unavailable;
  const resourcesPath = input.isPackaged ? input.resourcesPath ?? process.resourcesPath ?? null : null;
  if (input.isPackaged && (process.platform !== "darwin" || !resourcesPath)) return unavailable;
  const vendorRoot = input.devVendorRoot ?? join(fileURLToPath(new URL("..", import.meta.url)), "vendor");
  const outcome = resolveDesktopRuntimePath({ runtime: "github-cli", resourcesPath,
    devVendorRoot: vendorRoot, platformKey: key });
  if (!outcome.ok || (input.isPackaged && outcome.result.source !== "bundled")) return unavailable;
  const expected = githubCliManifest.artifacts[key]?.binarySha256;
  if (!expected) return unavailable;
  const executableSha256 = verifiedGitHubFileHash(outcome.result.path, expected,
    input.isPackaged && resourcesPath ? { resourcesPath, executablePath: process.execPath } : undefined);
  return executableSha256 ? { ok: true, binaryPath: outcome.result.path, executableSha256, version: githubCliManifest.version } : unavailable;
}
