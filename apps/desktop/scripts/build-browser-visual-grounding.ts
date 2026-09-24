/** Build the source-owned Apple Vision helper as one macOS 11 universal binary. */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

export const BROWSER_VISUAL_GROUNDING_HELPER = "nautilo-browser-visual-grounding";

export function browserVisualGroundingBuildPlan(desktopRoot: string) {
  const vendorDir = join(desktopRoot, "vendor", "browser-visual-grounding");
  return {
    source: join(desktopRoot, "native", "browser-visual-grounding", "main.swift"),
    arm64Output: join(vendorDir, `${BROWSER_VISUAL_GROUNDING_HELPER}.arm64`),
    x64Output: join(vendorDir, `${BROWSER_VISUAL_GROUNDING_HELPER}.x64`),
    universalOutput: join(vendorDir, BROWSER_VISUAL_GROUNDING_HELPER),
  } as const;
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`[build-browser-visual-grounding] ${command} failed: ${result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`)}`);
  }
}

export function buildBrowserVisualGroundingHelper(
  desktopRoot: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "darwin") return null;
  const plan = browserVisualGroundingBuildPlan(desktopRoot);
  if (!existsSync(plan.source)) throw new Error(`[build-browser-visual-grounding] missing source ${plan.source}`);
  mkdirSync(dirname(plan.universalOutput), { recursive: true });
  for (const output of [plan.arm64Output, plan.x64Output, plan.universalOutput]) rmSync(output, { force: true });
  for (const [target, output] of [
    ["arm64-apple-macos11.0", plan.arm64Output],
    ["x86_64-apple-macos11.0", plan.x64Output],
  ] as const) {
    run("xcrun", ["swiftc", "-O", "-target", target, "-framework", "AppKit", "-framework", "Vision", plan.source, "-o", output]);
  }
  run("xcrun", ["lipo", "-create", "-output", plan.universalOutput, plan.arm64Output, plan.x64Output]);
  run("xcrun", ["lipo", plan.universalOutput, "-verify_arch", "arm64", "x86_64"]);
  run("chmod", ["0755", plan.universalOutput]);
  for (const output of [plan.arm64Output, plan.x64Output]) rmSync(output, { force: true });
  return plan.universalOutput;
}

if (import.meta.main) {
  const helper = buildBrowserVisualGroundingHelper(dirname(import.meta.dir));
  if (helper) process.stdout.write(`${helper}\n`);
}
