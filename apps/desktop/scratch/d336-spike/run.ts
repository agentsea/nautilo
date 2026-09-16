#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "../..");
const repoRoot = resolve(desktopRoot, "../..");
const outFile = resolve(desktopRoot, "dist/d336-spike/main.js");

await build({
  entryPoints: [resolve(here, "main.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  logLevel: "warning",
});

function resolveElectronPath(): string {
  if (process.env["D336_ELECTRON_PATH"]) return process.env["D336_ELECTRON_PATH"];
  const sibling = resolve(repoRoot, "../nautilo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  if (existsSync(sibling)) return sibling;
  return createRequire(import.meta.url)("electron") as unknown as string;
}

const electronPath = resolveElectronPath();
const child = spawn(electronPath, [outFile], {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    D336_SPIKE_PORT: process.env["D336_SPIKE_PORT"] ?? "47736",
    D336_SPIKE_TOKEN: process.env["D336_SPIKE_TOKEN"] ?? "d336-spike-token",
    D336_SPIKE_URL: process.env["D336_SPIKE_URL"] ?? "https://docs.google.com",
  },
});

child.on("exit", (code) => process.exit(code ?? 0));
