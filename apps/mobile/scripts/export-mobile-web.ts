import { lstat, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";

import { verifySharedBrowserViewerWebExport } from "./shared-browser-viewer-export-probe";
import { verifyMobileWebExport } from "./verify-mobile-web-export";

export type CanonicalMobileWebExportDependencies = {
  readonly appRoot?: string;
  readonly exportWeb?: (stagingOutput: string) => Promise<void>;
  readonly verifyGeneric?: (stagingOutput: string) => Promise<unknown>;
  readonly verifyViewer?: (stagingOutput: string, appRoot: string) => Promise<unknown>;
};

function fail(message: string): never {
  throw new Error(`canonical Mobile Web export: ${message}`);
}

async function assertRemovableCanonicalOutput(outputDirectory: string): Promise<void> {
  try {
    const details = await lstat(outputDirectory);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      fail("apps/mobile/dist must be a real directory when it already exists");
    }
    await rm(outputDirectory, { recursive: true, force: false });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("canonical Mobile Web export:")) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function defaultExpoWebExport(stagingOutput: string, appRoot: string): Promise<void> {
  const child = Bun.spawn([
    process.execPath,
    "x",
    "expo",
    "export",
    "--platform",
    "web",
    "--output-dir",
    stagingOutput,
  ], { cwd: appRoot, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) fail("Expo Web export failed");
}

async function assertCanonicalOutputIsStillAbsent(outputDirectory: string): Promise<void> {
  try {
    await lstat(outputDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  fail("apps/mobile/dist appeared during export; refusing to replace it");
}

/**
 * Produce exactly apps/mobile/dist from one fresh, verified Web export.
 * Existing dist is intentionally removed before export so a failure cannot
 * leave a previous build looking like the current successful result.
 */
export async function exportCanonicalMobileWeb(
  dependencies: CanonicalMobileWebExportDependencies = {},
): Promise<void> {
  const appRoot = path.resolve(dependencies.appRoot ?? path.resolve(import.meta.dir, ".."));
  const outputDirectory = path.join(appRoot, "dist");
  const stagingRoot = await mkdtemp(path.join(appRoot, ".mobile-web-export-"));
  const stagingOutput = path.join(stagingRoot, "output");
  try {
    await assertRemovableCanonicalOutput(outputDirectory);
    await (dependencies.exportWeb ?? ((output) => defaultExpoWebExport(output, appRoot)))(stagingOutput);
    await (dependencies.verifyGeneric ?? verifyMobileWebExport)(stagingOutput);
    await (dependencies.verifyViewer ?? verifySharedBrowserViewerWebExport)(stagingOutput, appRoot);
    await assertCanonicalOutputIsStillAbsent(outputDirectory);
    await rename(stagingOutput, outputDirectory);
  } catch (error) {
    // All transaction writes stay inside staging. Do not touch an output that
    // appeared after the transaction started, even if promotion failed.
    throw error;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  void exportCanonicalMobileWeb().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "canonical Mobile Web export failed"}\n`);
    process.exitCode = 1;
  });
}
