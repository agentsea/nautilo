/**
 * Builds Nautilo's tiny, source-owned Screen Recording request helper.
 *
 * It is deliberately not fetched from the network. Both Mach-O slices are
 * compiled from the checked-in source, then lipo'd into the one universal
 * binary shipped in Contents/Resources/tools-permissions.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

export const SCREEN_RECORDING_PERMISSION_HELPER = "nautilo-screen-recording-permission";
export const SCREEN_RECORDING_PERMISSION_VENDOR_DIR = "screen-recording-permission";

export type BuildScreenRecordingPermissionPlan = Readonly<{
  readonly source: string;
  readonly arm64Output: string;
  readonly x64Output: string;
  readonly universalOutput: string;
}>;

export function screenRecordingPermissionBuildPlan(desktopRoot: string): BuildScreenRecordingPermissionPlan {
  const source = join(desktopRoot, "native", "screen-recording-permission", "main.m");
  const vendorDir = join(desktopRoot, "vendor", SCREEN_RECORDING_PERMISSION_VENDOR_DIR);
  return {
    source,
    arm64Output: join(vendorDir, `${SCREEN_RECORDING_PERMISSION_HELPER}.arm64`),
    x64Output: join(vendorDir, `${SCREEN_RECORDING_PERMISSION_HELPER}.x64`),
    universalOutput: join(vendorDir, SCREEN_RECORDING_PERMISSION_HELPER),
  };
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(
      `[build-screen-recording-permission] ${command} failed: ${result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`)}`,
    );
  }
}

export function buildScreenRecordingPermissionHelper(
  desktopRoot: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  // Development setup invokes this shared preparation script on every desktop
  // platform. The helper is a macOS-only resource, so non-macOS runs must not
  // require the Apple toolchain or create a macOS vendor artifact.
  if (platform !== "darwin") return null;
  const plan = screenRecordingPermissionBuildPlan(desktopRoot);
  if (!existsSync(plan.source)) {
    throw new Error(`[build-screen-recording-permission] missing source ${plan.source}`);
  }
  mkdirSync(dirname(plan.universalOutput), { recursive: true });
  // Clear only the three exact build outputs, never a parent vendor tree.
  for (const output of [plan.arm64Output, plan.x64Output, plan.universalOutput]) {
    rmSync(output, { force: true });
  }
  for (const [arch, output] of [["arm64", plan.arm64Output], ["x86_64", plan.x64Output]] as const) {
    run("xcrun", [
      "clang",
      "-arch", arch,
      "-mmacosx-version-min=11.0",
      "-framework", "CoreGraphics",
      plan.source,
      "-o", output,
    ]);
  }
  run("xcrun", ["lipo", "-create", "-output", plan.universalOutput, plan.arm64Output, plan.x64Output]);
  run("xcrun", ["lipo", plan.universalOutput, "-verify_arch", "arm64", "x86_64"]);
  run("chmod", ["0755", plan.universalOutput]);
  for (const output of [plan.arm64Output, plan.x64Output]) {
    rmSync(output, { force: true });
  }
  return plan.universalOutput;
}

if (import.meta.main) {
  const desktopRoot = dirname(import.meta.dir);
  const helper = buildScreenRecordingPermissionHelper(desktopRoot);
  if (helper) process.stdout.write(`${helper}\n`);
}
