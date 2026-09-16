#!/usr/bin/env bun
/**
 * Vendor Sharp's pinned Darwin platform packages for universal Electron builds.
 *
 * Bun installs only the host-architecture optional dependency tree. A universal
 * package built on Apple Silicon would therefore otherwise lack Sharp's x64
 * addon/libvips pair. This build-only script fetches the four exact npm package
 * tarballs, verifies their lockfile SHA-512 integrities, and atomically writes
 * their complete package trees under vendor/sharp-darwin/node_modules/@img.
 * electron-builder maps that tree into app.asar.unpacked/node_modules/@img in
 * both temporary apps; no packaged runtime download or ambient npm is used.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export interface SharpDarwinPackage {
  readonly name: "@img/sharp-darwin-arm64" | "@img/sharp-darwin-x64" | "@img/sharp-libvips-darwin-arm64" | "@img/sharp-libvips-darwin-x64";
  readonly version: string;
  /** Exact npm Subresource Integrity value pinned in bun.lock. */
  readonly integrity: string;
  /** Exact native payloads the packaged resolver needs from this tree. */
  readonly requiredFiles: readonly string[];
  /** libvips packages publish license metadata but no LICENSE file. */
  readonly requiresLicenseFile: boolean;
}

export const SHARP_DARWIN_PACKAGES: readonly SharpDarwinPackage[] = [
  { name: "@img/sharp-darwin-arm64", version: "0.35.4", integrity: "sha512-Uhfl4V4lhP2nbUVF9+hyH1+luj86f1gUFeo8ALYxFoULoU+G87D43BfeMP8XHsk9boxAnCY/bf2EHwhA7MuGsA==", requiredFiles: ["lib/sharp-darwin-arm64-0.35.4.node"], requiresLicenseFile: true },
  { name: "@img/sharp-darwin-x64", version: "0.35.4", integrity: "sha512-hWniXY3bG5qKpkKrAwPe4y+VTPmf086YQAnkxWh7uA1YrlRouWGa0M0Mxj3ZjnXFkv7/TD1bTy9lGUK26vRvWw==", requiredFiles: ["lib/sharp-darwin-x64-0.35.4.node"], requiresLicenseFile: true },
  { name: "@img/sharp-libvips-darwin-arm64", version: "1.3.3", integrity: "sha512-suTBPTDGrI9WodccaDdwZItTSaBYASlBk1NSfElSHrUfzu3szG6lvIF58+WiFvnfzuK8ZBFS5zE00PxqxnRiPg==", requiredFiles: ["lib/libvips-cpp.8.18.6.dylib"], requiresLicenseFile: false },
  { name: "@img/sharp-libvips-darwin-x64", version: "1.3.3", integrity: "sha512-FVJZ5mITMobmXIz/hPDTw0EintTW5H3WfrxwLqEqjiIihlu+hVRyGrFQ60xl0Lxn7Bt3zdpevPaQi0HEzqz9fw==", requiredFiles: ["lib/libvips-cpp.8.18.6.dylib"], requiresLicenseFile: false },
] as const;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
export const DEFAULT_VENDOR_DIR = join(desktopRoot, "vendor", "sharp-darwin");
const MANIFEST_FILE = "manifest.json";
const PROVENANCE_FILE = "PROVENANCE.md";

function packageLeafName(packageName: SharpDarwinPackage["name"]): string {
  return packageName.slice(packageName.lastIndexOf("/") + 1);
}

export function npmTarballUrl(spec: SharpDarwinPackage): string {
  return `https://registry.npmjs.org/${encodeURIComponent(spec.name)}/-/${packageLeafName(spec.name)}-${spec.version}.tgz`;
}

function expectedDigest(integrity: string): string | null {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  return match?.[1] ?? null;
}

function packageDirectory(vendorDir: string, spec: SharpDarwinPackage): string {
  return join(vendorDir, "node_modules", "@img", packageLeafName(spec.name));
}

function packageJsonIsExpected(path: string, spec: SharpDarwinPackage): boolean {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; version?: unknown };
    return value.name === spec.name && value.version === spec.version;
  } catch {
    return false;
  }
}

function treeSha512(path: string): string {
  const hash = createHash("sha512");
  const visit = (directory: string, relative = ""): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const next = join(directory, entry.name);
      const nextRelative = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      const stat = lstatSync(next);
      if (stat.isSymbolicLink()) throw new Error("npm package tree contains a symbolic link");
      if (stat.isDirectory()) visit(next, nextRelative);
      else if (stat.isFile()) {
        hash.update(nextRelative).update("\0").update(readFileSync(next)).update("\0");
      } else throw new Error("npm package tree contains a non-file member");
    }
  };
  visit(path);
  return hash.digest("base64");
}

function installedTreeIsComplete(vendorDir: string, packages: readonly SharpDarwinPackage[]): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(vendorDir, MANIFEST_FILE), "utf8")) as { packages?: unknown; treeSha512?: unknown };
    if (JSON.stringify(manifest.packages) !== JSON.stringify(packages)) return false;
    if (typeof manifest.treeSha512 !== "object" || manifest.treeSha512 === null || Array.isArray(manifest.treeSha512)) return false;
    if (!existsSync(join(vendorDir, PROVENANCE_FILE))) return false;
    return packages.every((spec) => {
      const directory = packageDirectory(vendorDir, spec);
      const expectedHash = (manifest.treeSha512 as Record<string, unknown>)[spec.name];
      return (!spec.requiresLicenseFile || existsSync(join(directory, "LICENSE")))
        && packageJsonIsExpected(join(directory, "package.json"), spec)
        && statSync(directory).isDirectory()
        && spec.requiredFiles.every((file) => lstatSync(join(directory, file)).isFile())
        && typeof expectedHash === "string"
        && treeSha512(directory) === expectedHash;
    });
  } catch {
    return false;
  }
}

function ensureSafeTarEntries(bytes: Buffer, tarPath: string): void {
  writeFileSync(tarPath, bytes, { mode: 0o600 });
  const listed = spawnSync("tar", ["-tzf", tarPath], { encoding: "utf8" });
  if (listed.status !== 0) throw new Error("npm package tarball cannot be listed safely");
  for (const entry of listed.stdout.split("\n").filter(Boolean)) {
    if (!entry.startsWith("package/") || entry.startsWith("/") || entry.split("/").includes("..")) {
      throw new Error("npm package tarball contains an unsafe member path");
    }
  }
}

function assertTreeHasNoLinks(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error("npm package tree contains a symbolic link");
    if (stat.isDirectory()) assertTreeHasNoLinks(full);
  }
}

function extractVerifiedPackage(bytes: Buffer, spec: SharpDarwinPackage, destination: string): void {
  const extraction = mkdtempSync(join(tmpdir(), "nautilo-sharp-extract-"));
  try {
    const tarPath = join(extraction, "package.tgz");
    ensureSafeTarEntries(bytes, tarPath);
    const result = spawnSync("tar", ["-xzf", tarPath, "-C", extraction], { encoding: "utf8" });
    if (result.status !== 0) throw new Error("npm package tarball cannot be extracted safely");
    const source = join(extraction, "package");
    if (!packageJsonIsExpected(join(source, "package.json"), spec)
      || (spec.requiresLicenseFile && !existsSync(join(source, "LICENSE")))
      || !spec.requiredFiles.every((file) => existsSync(join(source, file)))) {
      throw new Error(`npm package tree does not match ${spec.name}@${spec.version}`);
    }
    assertTreeHasNoLinks(source);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
    cpSync(source, destination, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  } finally {
    rmSync(extraction, { recursive: true, force: true });
  }
}

async function fetchVerifiedTarball(spec: SharpDarwinPackage, fetchImpl: typeof fetch): Promise<Buffer> {
  const response = await fetchImpl(npmTarballUrl(spec));
  if (!response.ok) throw new Error(`npm registry returned ${response.status} for ${spec.name}@${spec.version}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const expected = expectedDigest(spec.integrity);
  if (expected === null || createHash("sha512").update(bytes).digest("base64") !== expected) {
    throw new Error(`SHA-512 integrity verification failed for ${spec.name}@${spec.version}`);
  }
  return bytes;
}

function installAtomically(staging: string, vendorDir: string): void {
  const backup = `${vendorDir}.previous-${randomBytes(8).toString("hex")}`;
  const hadCurrent = existsSync(vendorDir);
  if (hadCurrent) renameSync(vendorDir, backup);
  try {
    renameSync(staging, vendorDir);
    if (hadCurrent) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (hadCurrent && !existsSync(vendorDir) && existsSync(backup)) renameSync(backup, vendorDir);
    throw error;
  }
}

export interface VendorSharpDarwinOptions {
  readonly vendorDir?: string;
  /** Test seam; production always uses the four lockfile-pinned packages. */
  readonly packages?: readonly SharpDarwinPackage[];
  readonly fetchImpl?: typeof fetch;
  readonly log?: (message: string) => void;
}

/** Fetch, verify, extract, and atomically install all four exact package trees. */
export async function vendorSharpDarwin(options: VendorSharpDarwinOptions = {}): Promise<"cached" | "installed"> {
  const vendorDir = options.vendorDir ?? DEFAULT_VENDOR_DIR;
  const packages = options.packages ?? SHARP_DARWIN_PACKAGES;
  const doFetch = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => {});
  if (installedTreeIsComplete(vendorDir, packages)) return "cached";

  mkdirSync(dirname(vendorDir), { recursive: true, mode: 0o755 });
  const staging = mkdtempSync(join(dirname(vendorDir), ".sharp-darwin-stage-"));
  try {
    for (const spec of packages) {
      log(`fetching ${spec.name}@${spec.version}`);
      const bytes = await fetchVerifiedTarball(spec, doFetch);
      extractVerifiedPackage(bytes, spec, packageDirectory(staging, spec));
    }
    const treeHashes = Object.fromEntries(packages.map((spec) => [spec.name, treeSha512(packageDirectory(staging, spec))]));
    writeFileSync(join(staging, MANIFEST_FILE), `${JSON.stringify({ packages, treeSha512: treeHashes }, null, 2)}\n`, { mode: 0o644 });
    writeFileSync(
      join(staging, PROVENANCE_FILE),
      "Sharp Darwin optional dependency trees are vendored from immutable npm package tarballs.\n" +
        "Each tarball is pinned to the SHA-512 integrity in bun.lock and verified before atomic installation.\n",
      { mode: 0o644 },
    );
    if (!installedTreeIsComplete(staging, packages)) throw new Error("staged Sharp Darwin package trees are incomplete");
    installAtomically(staging, vendorDir);
    return "installed";
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const outcome = await vendorSharpDarwin({ log: (message) => process.stdout.write(`[vendor-sharp-darwin] ${message}\n`) });
  process.stdout.write(`[vendor-sharp-darwin] ${outcome} ${DEFAULT_VENDOR_DIR}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`[vendor-sharp-darwin] FATAL ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
