#!/usr/bin/env bun
/**
 * D362 Phase-0 spike runner (throwaway). Bundles main.ts + preload.ts and
 * launches Electron pointed at the Collabora-hosted doc. Mirrors d336-spike/run.ts.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "../..");
const repoRoot = resolve(desktopRoot, "../..");
const outDir = resolve(desktopRoot, "dist/d362-spike");

await build({
  entryPoints: [resolve(here, "main.ts"), resolve(here, "preload.ts")],
  outdir: outDir,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  logLevel: "warning",
});

function resolveElectronPath(): string {
  if (process.env["D362_ELECTRON_PATH"]) return process.env["D362_ELECTRON_PATH"];
  const sibling = resolve(repoRoot, "../nautilo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  if (existsSync(sibling)) return sibling;
  return createRequire(import.meta.url)("electron") as unknown as string;
}

const child = spawn(resolveElectronPath(), [resolve(outDir, "main.js")], {
  cwd: repoRoot,
  stdio: "inherit",
  env: { ...process.env },
});
child.on("exit", (code) => process.exit(code ?? 0));
