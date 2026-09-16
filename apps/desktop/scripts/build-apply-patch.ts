#!/usr/bin/env bun
/**
 * Build the product-owned apply-patch runtime from checked-in Rust source.
 *
 * This is deliberately a build/package command, never a runtime fallback:
 * Electron resolves only the copied, checksum-recorded bytes beneath vendor
 * (or Contents/Resources in a packaged app). `host` supports the normal local
 * dev/unsigned path; `universal` prepares both Darwin slices before a signed
 * universal macOS package is assembled.
 */

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getApplyPatchDesktopManifestEntry,
  parseToolRuntimesManifest,
  type ApplyPatchDesktopManifestEntry,
  type ToolRuntimePlatformKey,
} from "../electron/tool-runtimes-manifest.ts";

export type ApplyPatchBuildMode = "host" | "universal";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "../..");
const nativeRoot = join(repoRoot, "native", "apply-patch");
const vendorRoot = join(desktopRoot, "vendor");
const outputRoot = join(vendorRoot, "apply-patch");
const sourceManifestPath = join(vendorRoot, "tool-runtimes.manifest.json");
const cargoTargetDir = join(vendorRoot, ".apply-patch-target");

const TARGET_BY_PLATFORM: Readonly<Record<ToolRuntimePlatformKey, string>> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
};

function rustBuildCommand(command: "cargo" | "rustup"): string {
  const override = process.env[command === "cargo" ? "CARGO" : "RUSTUP"]?.trim();
  const cargoHome = process.env["CARGO_HOME"]?.trim();
  for (const candidate of [
    override,
    cargoHome ? join(cargoHome, "bin", command) : undefined,
    join(homedir(), ".cargo", "bin", command),
  ]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  // Preserve ordinary PATH resolution for system/package-manager installs.
  return command;
}

function fail(message: string): never {
  process.stderr.write(`[build-apply-patch] FATAL ${message}\n`);
  process.exit(1);
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    env: { ...process.env, ...env },
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? (result.stderr.trim() || `${command} exited ${result.status}`);
    throw new Error(`${command} ${args.join(" ")}: ${detail}`);
  }
  return result.stdout;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function pinnedToolchainVersion(): string {
  const toolchain = readFileSync(join(nativeRoot, "rust-toolchain.toml"), "utf8");
  const channel = /^channel\s*=\s*"([^"]+)"$/m.exec(toolchain)?.[1];
  if (!channel) throw new Error("native/apply-patch/rust-toolchain.toml does not declare a Rust channel");
  return channel;
}

function assertPinnedBuildInputs(): void {
  const entry = getApplyPatchDesktopManifestEntry(parseToolRuntimesManifest(readFileSync(sourceManifestPath, "utf8")));
  if (entry.provenance.cargoLockSha256 !== sha256(join(nativeRoot, "Cargo.lock"))) {
    throw new Error("native/apply-patch/Cargo.lock does not match the checked-in apply-patch provenance");
  }
  if (entry.provenance.rustToolchain !== pinnedToolchainVersion()) {
    throw new Error("native/apply-patch/rust-toolchain.toml does not match the checked-in apply-patch provenance");
  }
  const cargoVersion = run(rustBuildCommand("cargo"), ["--version"], nativeRoot).match(/^cargo\s+(\S+)/)?.[1];
  if (cargoVersion !== entry.provenance.rustToolchain) {
    throw new Error(`pinned Rust toolchain ${entry.provenance.rustToolchain} is required; found cargo ${cargoVersion ?? "unknown"}`);
  }
}

function machOArch(binaryPath: string): "arm64" | "x64" | null {
  const header = readFileSync(binaryPath).subarray(0, 8);
  if (header.length < 8 || header.readUInt32LE(0) !== 0xfeedfacf) return null;
  const cpu = header.readUInt32LE(4);
  return cpu === 0x0100000c ? "arm64" : cpu === 0x01000007 ? "x64" : null;
}

function exactVersionJson(output: string, entry: ApplyPatchDesktopManifestEntry): boolean {
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    const provenance = value["provenance"] as Record<string, unknown>;
    return Object.keys(value).sort().join(",") === "nautilo_extraction_revision,protocol,provenance,runtime_version,upstream_revision" &&
      Object.keys(provenance ?? {}).sort().join(",") === "format,license_sha256,notice_sha256,upstream_revision" &&
      value["runtime_version"] === entry.version && value["protocol"] === entry.protocol &&
      value["upstream_revision"] === entry.provenance.upstreamRevision &&
      value["nautilo_extraction_revision"] === entry.provenance.nautiloExtractionRevision &&
      provenance["format"] === entry.provenance.format && provenance["upstream_revision"] === entry.provenance.upstreamRevision &&
      provenance["license_sha256"] === entry.provenance.licenseSha256 && provenance["notice_sha256"] === entry.provenance.noticeSha256;
  } catch { return false; }
}

/** Pure output acceptance gate; it never executes the candidate. */
export function verifySourceBuiltApplyPatchCandidate(
  binaryPath: string,
  platformKey: ToolRuntimePlatformKey,
  expectedSha256: string,
  versionJson: string,
  entry: ApplyPatchDesktopManifestEntry,
): { readonly sha256: string; readonly size: number } {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("expected SHA-256 must be 64 lowercase hexadecimal characters");
  const artifact = entry.artifacts[platformKey];
  const size = readFileSync(binaryPath).byteLength;
  if (size < artifact.sizeMin) throw new Error(`candidate is below minimum size ${artifact.sizeMin}`);
  const actual = sha256(binaryPath);
  if (actual !== expectedSha256 || artifact.sha256 !== expectedSha256) throw new Error("candidate source-build SHA-256 mismatch");
  if (machOArch(binaryPath) !== artifact.machOArch) throw new Error(`candidate Mach-O architecture does not match ${platformKey}`);
  if (!exactVersionJson(versionJson, entry)) throw new Error("candidate version/provenance does not exactly match the pinned manifest");
  return { sha256: actual, size };
}

export function platformKeyForHostArch(arch: string): ToolRuntimePlatformKey {
  if (arch === "arm64") return "darwin-arm64";
  if (arch === "x64") return "darwin-x64";
  throw new Error(`apply-patch local source builds support Darwin arm64 or x64, not ${arch}`);
}

export function platformKeysForBuild(mode: ApplyPatchBuildMode, hostArch: string): readonly ToolRuntimePlatformKey[] {
  return mode === "universal" ? ["darwin-arm64", "darwin-x64"] : [platformKeyForHostArch(hostArch)];
}

function sourceBuiltRuntimeManifest(hashes: Readonly<Partial<Record<ToolRuntimePlatformKey, string>>>): string {
  const raw = JSON.parse(readFileSync(sourceManifestPath, "utf8")) as Record<string, unknown>;
  const applyPatch = raw["apply-patch"] as { artifacts: Record<ToolRuntimePlatformKey, Record<string, unknown>> };
  for (const platformKey of Object.keys(applyPatch.artifacts) as ToolRuntimePlatformKey[]) {
    if (hashes[platformKey] !== undefined) applyPatch.artifacts[platformKey].sha256 = hashes[platformKey];
  }
  return JSON.stringify({ "apply-patch": applyPatch }, null, 2) + "\n";
}

function buildPlatform(platformKey: ToolRuntimePlatformKey): string {
  const target = TARGET_BY_PLATFORM[platformKey];
  run(rustBuildCommand("cargo"), ["build", "--locked", "--release", "--target", target], nativeRoot, { CARGO_TARGET_DIR: cargoTargetDir });
  const builtBinary = join(cargoTargetDir, target, "release", "nautilo-apply-patch");
  if (!existsSync(builtBinary)) throw new Error(`Cargo did not produce ${builtBinary}`);
  const destination = join(outputRoot, platformKey, "nautilo-apply-patch");
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(builtBinary, destination);
  chmodSync(destination, 0o755);
  return destination;
}

function ensureRustTargets(keys: readonly ToolRuntimePlatformKey[]): void {
  const toolchain = pinnedToolchainVersion();
  run(rustBuildCommand("rustup"), ["target", "add", "--toolchain", toolchain, ...keys.map((key) => TARGET_BY_PLATFORM[key])], nativeRoot);
}

function copyPackageMetadata(): void {
  for (const [source, destination] of [
    ["native/apply-patch/LICENSE", "LICENSE"],
    ["native/apply-patch/NOTICE", "NOTICE"],
    ["native/apply-patch/UPSTREAM.toml", "UPSTREAM.toml"],
    ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.txt"],
  ] as const) {
    copyFileSync(join(repoRoot, source), join(outputRoot, destination));
  }
}

export function parseBuildMode(args: readonly string[]): ApplyPatchBuildMode {
  const mode = args[0] ?? "host";
  if (mode === "host" || mode === "universal") return mode;
  throw new Error("usage: build-apply-patch.ts [host|universal]");
}

export function buildApplyPatchRuntime(mode: ApplyPatchBuildMode, hostArch = process.arch): void {
  // The product currently ships this local relay runtime on Darwin only. This
  // makes `bun run dev`/`app` remain usable on other developer platforms; the
  // runtime resolver still reports the explicit PLATFORM_UNSUPPORTED outcome.
  if (process.platform !== "darwin") return;
  assertPinnedBuildInputs();
  const keys = platformKeysForBuild(mode, hostArch);
  ensureRustTargets(keys);
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  const hashes: Partial<Record<ToolRuntimePlatformKey, string>> = {};
  for (const platformKey of keys) {
    const destination = buildPlatform(platformKey);
    hashes[platformKey] = sha256(destination);
  }
  const runtimeManifest = sourceBuiltRuntimeManifest(hashes);
  const entry = getApplyPatchDesktopManifestEntry(parseToolRuntimesManifest(runtimeManifest));
  for (const platformKey of keys) {
    const destination = join(outputRoot, platformKey, "nautilo-apply-patch");
    verifySourceBuiltApplyPatchCandidate(destination, platformKey, hashes[platformKey]!, run(destination, ["--version-json"], nativeRoot, {}), entry);
  }
  writeFileSync(join(outputRoot, "runtime-manifest.json"), runtimeManifest);
  copyPackageMetadata();
}

if (import.meta.main) {
  try {
    const mode = parseBuildMode(process.argv.slice(2));
    buildApplyPatchRuntime(mode);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
