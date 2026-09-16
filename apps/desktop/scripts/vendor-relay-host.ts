#!/usr/bin/env bun
/** Build and hash the Relay Host program consumed by Nautilo's bundled Bun. */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const hostRoot = join(repositoryRoot, "bin", "nautilo-relay");
const scriptName = "nautilo-relay-host.js";
const source = join(hostRoot, "dist", scriptName);
const vendorRoot = join(desktopRoot, "vendor", "relay-host");
const destination = join(vendorRoot, scriptName);

function fail(message: string): never {
  process.stderr.write(`[vendor-relay-host] FATAL ${message}\n`);
  process.exit(1);
}

function main(): void {
  const build = spawnSync("bun", ["run", "build:desktop-host"], { cwd: hostRoot, stdio: "inherit" });
  if (build.error || build.status !== 0) fail(build.error?.message ?? "Relay Host build failed");
  if (!existsSync(source) || !statSync(source).isFile() || statSync(source).size === 0) {
    fail(`Host build did not create ${source}`);
  }
  mkdirSync(vendorRoot, { recursive: true, mode: 0o700 });
  rmSync(join(vendorRoot, "nautilo-relay-host"), { force: true });
  rmSync(destination, { force: true });
  copyFileSync(source, destination);
  const bytes = readFileSync(destination);
  const packageJson = JSON.parse(readFileSync(join(hostRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) fail("Relay Host package version is invalid");
  writeFileSync(join(vendorRoot, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    script: scriptName,
    packageVersion: packageJson.version,
    hostVersion: "1.0.0",
    protocolVersion: 1,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }, null, 2)}\n`, { mode: 0o600 });
}

main();
