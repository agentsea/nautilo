/** Build the pinned native repair for qualification or approved release packaging.
 * No runtime downloader, released-archive impersonation, or fallback on failure.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_CUA_DRIVER_LICENSE_SHA256, PINNED_CUA_DRIVER_SOURCE_REVISION, replaceAtomically } from "./vendor-cua-driver";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const qualificationRoot = join(desktopRoot, "cua-driver", "qualification");
const sourceRepository = "https://github.com/trycua/cua.git";
const architectures = ["aarch64-apple-darwin", "x86_64-apple-darwin"] as const;
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export interface QualificationSource {
  kind: "qualification-source-patch";
  productionPackaging: boolean;
  baseVersion: string;
  baseRevision: string;
  effectiveTree: string;
  patchSha256: string;
  rustToolchain: string;
  upstreamContribution: { url: string; commit: string; author: string; adaptation: string };
}

export function validateQualificationSource(value: unknown, patch: Buffer, desktopVersion: string): QualificationSource {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid qualification source manifest");
  const item = value as Record<string, unknown>;
  if (desktopVersion !== "0.0.0-dev" && item["productionPackaging"] !== true) {
    throw new Error("Patched Cua is qualification-only unless its reviewed manifest approves production packaging");
  }
  if (item["kind"] !== "qualification-source-patch" || item["baseVersion"] !== "0.23.2"
    || typeof item["productionPackaging"] !== "boolean"
    || item["baseRevision"] !== PINNED_CUA_DRIVER_SOURCE_REVISION
    || typeof item["effectiveTree"] !== "string" || !/^[a-f0-9]{40}$/.test(item["effectiveTree"])
    || item["rustToolchain"] !== "1.97.1" || item["patchSha256"] !== sha256(patch)) {
    throw new Error("Qualification source identity or patch checksum mismatch");
  }
  const contribution = item["upstreamContribution"] as Record<string, unknown> | undefined;
  if (!contribution || contribution["url"] !== "https://github.com/trycua/cua/pull/3404"
    || contribution["commit"] !== "ad79aa13eb06a52c13cc21a0a87c8cc80d389dd1"
    || typeof contribution["author"] !== "string" || typeof contribution["adaptation"] !== "string") {
    throw new Error("Qualification must retain upstream contribution provenance");
  }
  return value as QualificationSource;
}

function command(cwd: string, executable: string, args: string[], capture = false): string {
  const result = spawnSync(executable, args, {
    cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : ["ignore", "inherit", "inherit"],
    env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: "13.0", CUA_TELEMETRY_ENABLED: "false" },
  });
  if (result.error || result.status !== 0) throw new Error(`Qualification command failed: ${executable} ${args.join(" ")}`, { cause: result.error });
  return result.stdout?.trim() ?? "";
}

export function assertQualificationTree(actual: string, expected: string): void {
  if (actual !== expected) throw new Error("Patched Cua source tree differs from reviewed source");
}

export function buildQualificationCuaDriver(): void {
  const patchPath = join(qualificationRoot, "setup-controls.patch");
  const patch = readFileSync(patchPath);
  const packageMetadata = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")) as { version: string };
  const source = validateQualificationSource(JSON.parse(readFileSync(join(qualificationRoot, "manifest.json"), "utf8")), patch, packageMetadata.version);
  if (process.platform !== "darwin") throw new Error("Cua qualification source build requires macOS");
  const scratch = mkdtempSync(join(tmpdir(), "nautilo-cua-qualification-"));
  const checkout = join(scratch, "source");
  mkdirSync(checkout);
  try {
    command(checkout, "git", ["init", "--quiet"]);
    command(checkout, "git", ["remote", "add", "origin", sourceRepository]);
    command(checkout, "git", ["fetch", "--depth=1", "origin", source.baseRevision]);
    command(checkout, "git", ["checkout", "--detach", "FETCH_HEAD"]);
    assertQualificationTree(command(checkout, "git", ["rev-parse", "HEAD"], true), source.baseRevision);
    command(checkout, "git", ["apply", "--index", "--check", patchPath]);
    command(checkout, "git", ["apply", "--index", patchPath]);
    assertQualificationTree(command(checkout, "git", ["write-tree"], true), source.effectiveTree);
    const rustRoot = join(checkout, "libs", "cua-driver", "rust");
    command(rustRoot, "rustup", ["toolchain", "install", source.rustToolchain, "--profile", "minimal", "--component", "rustfmt"]);
    command(rustRoot, "rustup", ["target", "add", "--toolchain", source.rustToolchain, ...architectures]);
    command(rustRoot, "cargo", ["test", "--locked", "-p", "platform-macos"]);
    command(rustRoot, "cargo", ["fmt", "--all", "--", "--check"]);
    for (const architecture of architectures) {
      command(rustRoot, "cargo", ["build", "--locked", "--release", "-p", "cua-driver", "--target", architecture]);
    }
    const vendorDirectory = join(desktopRoot, "vendor", "cua-driver");
    mkdirSync(dirname(vendorDirectory), { recursive: true });
    const stage = mkdtempSync(join(dirname(vendorDirectory), ".cua-qualification-stage-"));
    try {
      const binary = join(stage, "cua-driver");
      command(rustRoot, "lipo", ["-create", ...architectures.map(arch => join(rustRoot, "target", arch, "release", "cua-driver")), "-output", binary]);
      if (command(rustRoot, "lipo", ["-archs", binary], true).split(/\s+/).sort().join(" ") !== "arm64 x86_64") {
        throw new Error("Patched Cua must contain both macOS architectures");
      }
      const license = readFileSync(join(checkout, "LICENSE.md"));
      if (sha256(license) !== PINNED_CUA_DRIVER_LICENSE_SHA256) throw new Error("Cua license checksum mismatch");
      writeFileSync(join(stage, "LICENSE"), license);
      chmodSync(binary, 0o755);
      const evidence = {
        schemaVersion: 1, ...source, sourceRepository,
        binarySha256BeforeSigning: sha256(readFileSync(binary)),
        architectures: ["arm64", "x86_64"],
        signing: "unsigned-build-input; the protected Desktop pipeline must sign and notarize the enclosing package",
      };
      writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(evidence, null, 2)}\n`);
      copyFileSync(patchPath, join(stage, "qualification.patch"));
      writeFileSync(join(stage, "PROVENANCE.md"), `# Cua pinned source build (not an upstream release)\n\nBase: ${source.baseRevision}\nPatched source tree: ${source.effectiveTree}\nPatch SHA-256: ${source.patchSha256}\nProduction packaging approved: ${source.productionPackaging}\n\n${source.upstreamContribution.author}: ${source.upstreamContribution.url}\n${source.upstreamContribution.adaptation}\n\nThe executable must be signed by the enclosing protected Desktop build. No runtime download or local unsigned installation is enabled.\n`);
      replaceAtomically(stage, vendorDirectory);
    } catch (error) {
      rmSync(stage, { recursive: true, force: true });
      throw error;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
