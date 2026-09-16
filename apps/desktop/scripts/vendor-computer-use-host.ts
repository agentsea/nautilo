#!/usr/bin/env bun
/**
 * Materialize the in-repo, universal Computer Use Host into Desktop's signed
 * macOS resource lane. There is deliberately no download, PATH probe, or
 * alternate executable: the only source is this checkout's Host build.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const hostRoot = join(repositoryRoot, "packages", "computer-use-host");
const binaryName = "nautilo-computer-use-host";
const source = join(hostRoot, "dist", binaryName);
const vendorRoot = join(desktopRoot, "vendor", "computer-use-host");
const destination = join(vendorRoot, binaryName);

function fail(message: string): never {
  process.stderr.write(`[vendor-computer-use-host] FATAL ${message}\n`);
  process.exit(1);
}

function run(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error || result.status !== 0) fail(result.error?.message ?? `${command} failed`);
}

function assertUniversal(path: string): void {
  const result = spawnSync("lipo", ["-archs", path], { encoding: "utf8" });
  if (result.error || result.status !== 0) fail(result.error?.message ?? "lipo could not inspect Host");
  const actual = result.stdout.trim().split(/\s+/).filter(Boolean).sort();
  if (actual.length !== 2 || actual[0] !== "arm64" || actual[1] !== "x86_64") {
    fail(`Host must be universal arm64+x86_64; found ${actual.join(",") || "none"}`);
  }
}

function main(): void {
  run("bun", ["run", "build:executable"], hostRoot);
  if (!existsSync(source) || !statSync(source).isFile()) fail(`Host build did not create ${source}`);
  assertUniversal(source);
  if (statSync(source).size === 0) fail("Host executable is empty");
  mkdirSync(vendorRoot, { recursive: true, mode: 0o700 });
  rmSync(destination, { force: true });
  copyFileSync(source, destination);
  chmodSync(destination, 0o755);
  const packageJson = JSON.parse(readFileSync(join(hostRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) fail("Host package version is invalid");
  writeFileSync(join(vendorRoot, "manifest.json"), `${JSON.stringify({
    schemaVersion: 2,
    binary: binaryName,
    version: packageJson.version,
    architectures: ["arm64", "x64"],
  }, null, 2)}\n`, { mode: 0o600 });
}

main();
