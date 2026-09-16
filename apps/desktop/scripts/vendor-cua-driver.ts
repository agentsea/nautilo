#!/usr/bin/env bun
/**
 * D516 — acquire the reviewed Cua Driver release for Nautilo packaging.
 *
 * This is deliberately a build-time-only path. It accepts exactly one
 * immutable HTTPS release asset, verifies its archive checksum before parsing
 * it, rejects unsafe tar members, and atomically stages the one executable we
 * package. Runtime code must resolve the packaged path directly; it must not
 * download Cua, consult PATH, or use a local development build.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/**
 * D516 qualified this exact signed release against Nautilo's admitted schemas,
 * retained browser-session lifecycle, and live native/browser verification
 * envelopes. Keep the
 * archive and source pin together: a matching version label alone is not
 * provenance.
 */
export const PINNED_CUA_DRIVER_VERSION = "0.23.2";
export const PINNED_CUA_DRIVER_SOURCE_REVISION = "e88e9d899ac5effaeae38619527ebaa46b26ce72";
export const PINNED_CUA_DRIVER_RELEASE_REVISION = "e88e9d899ac5effaeae38619527ebaa46b26ce72";
export const PINNED_CUA_DRIVER_RELEASE_TAG = `cua-driver-rs-v${PINNED_CUA_DRIVER_VERSION}`;
export const PINNED_CUA_DRIVER_ARCHIVE_NAME =
  `cua-driver-rs-${PINNED_CUA_DRIVER_VERSION}-darwin-universal-binary.tar.gz`;
export const PINNED_CUA_DRIVER_ARCHIVE_URL =
  `https://github.com/trycua/cua/releases/download/${PINNED_CUA_DRIVER_RELEASE_TAG}/${PINNED_CUA_DRIVER_ARCHIVE_NAME}`;
export const PINNED_CUA_DRIVER_ARCHIVE_SHA256 =
  "0127c82ff17922df4290931a8ebf9b4a8b21656aad24cba6f21ee50e41ed4493";
export const PINNED_CUA_DRIVER_SOURCE_URL =
  `https://github.com/trycua/cua/tree/${PINNED_CUA_DRIVER_SOURCE_REVISION}`;
export const PINNED_CUA_DRIVER_RELEASE_URL =
  `https://github.com/trycua/cua/releases/tag/${PINNED_CUA_DRIVER_RELEASE_TAG}`;
export const PINNED_CUA_DRIVER_LICENSE_URL =
  `https://raw.githubusercontent.com/trycua/cua/${PINNED_CUA_DRIVER_SOURCE_REVISION}/LICENSE.md`;
export const PINNED_CUA_DRIVER_LICENSE_SHA256 =
  "c0779290c1d4783169aa3dbfb55feb505e563ef8a004bbf55298ceffcfbda8d9";

export type CuaDriverReleaseContract = {
  readonly driverVersion: string;
  readonly releaseRevision: string;
  readonly reviewedSourceRevision: string;
  readonly sourceUrl: string;
  readonly releaseTag: string;
  readonly releaseUrl: string;
  readonly archiveName: string;
  readonly archiveUrl: string;
  readonly archiveSha256: string;
  readonly licenseUrl: string;
  readonly licenseSha256: string;
};

/** The sole production acquisition contract. Test fixtures may inject a contract. */
export const PINNED_CUA_DRIVER_RELEASE: CuaDriverReleaseContract = {
  driverVersion: PINNED_CUA_DRIVER_VERSION,
  releaseRevision: PINNED_CUA_DRIVER_RELEASE_REVISION,
  reviewedSourceRevision: PINNED_CUA_DRIVER_SOURCE_REVISION,
  sourceUrl: PINNED_CUA_DRIVER_SOURCE_URL,
  releaseTag: PINNED_CUA_DRIVER_RELEASE_TAG,
  releaseUrl: PINNED_CUA_DRIVER_RELEASE_URL,
  archiveName: PINNED_CUA_DRIVER_ARCHIVE_NAME,
  archiveUrl: PINNED_CUA_DRIVER_ARCHIVE_URL,
  archiveSha256: PINNED_CUA_DRIVER_ARCHIVE_SHA256,
  licenseUrl: PINNED_CUA_DRIVER_LICENSE_URL,
  licenseSha256: PINNED_CUA_DRIVER_LICENSE_SHA256,
};

const CUA_BINARY_MEMBER = "cua-driver";
const CUA_LICENSE_MEMBER = "LICENSE";
const CUA_VENDOR_DIRECTORY_NAME = "cua-driver";
const CUA_PACKAGED_TOOLS_DIRECTORY = "tools-cua";
const CUA_PACKAGED_BINARY_RELATIVE_PATH = `${CUA_PACKAGED_TOOLS_DIRECTORY}/${CUA_BINARY_MEMBER}`;
const EXPECTED_UNIVERSAL_ARCHITECTURES = ["arm64", "x86_64"] as const;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const defaultVendorDirectory = join(desktopRoot, "vendor", CUA_VENDOR_DIRECTORY_NAME);

export type CuaDriverVendorManifest = {
  schemaVersion: 1;
  driverVersion: string;
  releaseRevision: string;
  reviewedSourceRevision: string;
  sourceUrl: string;
  licenseUrl: string;
  licenseSha256: string;
  releaseTag: string;
  releaseUrl: string;
  archiveName: string;
  archiveUrl: string;
  archiveSha256: string;
  binaryMember: typeof CUA_BINARY_MEMBER;
  binarySha256: string;
  packagedPath: typeof CUA_PACKAGED_BINARY_RELATIVE_PATH;
  architectures: readonly (typeof EXPECTED_UNIVERSAL_ARCHITECTURES)[number][];
  license: "MIT";
};

export type CuaDriverVendorOptions = {
  readonly vendorDirectory?: string;
  readonly fetchImpl?: typeof fetch;
  readonly inspectArchitectures?: (binaryPath: string) => readonly string[];
  readonly log?: (message: string) => void;
  /** Test-only fixture seam; the command-line entrypoint always uses the pin above. */
  readonly contract?: CuaDriverReleaseContract;
};

export type TarEntry = { readonly path: string; readonly type: "file" | "directory"; readonly mode: number; readonly bytes: Buffer };

function fail(message: string): never {
  throw new Error(`[vendor-cua-driver] ${message}`);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeNullTerminated(buffer: Buffer): string {
  const nul = buffer.indexOf(0);
  return buffer.subarray(0, nul === -1 ? buffer.length : nul).toString("utf8");
}

function parseTarOctal(field: Buffer, label: string): number {
  const text = decodeNullTerminated(field).trim();
  if (!/^[0-7]*$/.test(text)) fail(`tar ${label} is not an octal field`);
  const value = text.length === 0 ? 0 : Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail(`tar ${label} is outside the safe integer range`);
  return value;
}

function safeTarPath(path: string): string {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    fail(`unsafe tar member path ${JSON.stringify(path)}`);
  }
  const parts = path.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    fail(`unsafe tar member path ${JSON.stringify(path)}`);
  }
  return path;
}

function tarHeaderChecksum(header: Buffer): number {
  let sum = 0;
  for (let index = 0; index < header.length; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  return sum;
}

/** Parse a gzip tar without extracting it, accepting only safe regular files/directories. */
export function parseSafeCuaDriverArchive(archive: Buffer): ReadonlyMap<string, TarEntry> {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive);
  } catch {
    fail("archive is not a valid gzip stream");
  }
  const entries = new Map<string, TarEntry>();
  let offset = 0;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.length !== 512) fail("truncated tar header");
    if (header.every((byte) => byte === 0)) break;
    const declaredChecksum = parseTarOctal(header.subarray(148, 156), "checksum");
    if (declaredChecksum !== tarHeaderChecksum(header)) fail("tar header checksum mismatch");
    const name = decodeNullTerminated(header.subarray(0, 100));
    const prefix = decodeNullTerminated(header.subarray(345, 500));
    const path = safeTarPath(prefix.length === 0 ? name : `${prefix}/${name}`);
    if (entries.has(path)) fail(`duplicate tar member ${path}`);
    const typeByte = header[156]!;
    const type = typeByte === 0 || typeByte === 48 ? "file" : typeByte === 53 ? "directory" : undefined;
    if (type === undefined) fail(`tar member ${path} has forbidden type ${String.fromCharCode(typeByte)}`);
    const size = parseTarOctal(header.subarray(124, 136), "size");
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) fail(`tar member ${path} extends beyond archive`);
    if (type === "directory" && size !== 0) fail(`tar directory ${path} has non-zero data size`);
    entries.set(path, {
      path,
      type,
      mode: parseTarOctal(header.subarray(100, 108), "mode"),
      bytes: Buffer.from(tar.subarray(dataStart, dataEnd)),
    });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (entries.size === 0) fail("archive contains no tar members");
  return entries;
}

function assertExpectedArchive(entries: ReadonlyMap<string, TarEntry>): TarEntry {
  for (const path of entries.keys()) {
    if (path === "CuaDriver.app" || path.startsWith("CuaDriver.app/")) {
      fail("bare Cua archive unexpectedly contains CuaDriver.app");
    }
  }
  const binary = entries.get(CUA_BINARY_MEMBER);
  if (!binary || binary.type !== "file" || binary.bytes.length === 0) fail(`archive is missing regular ${CUA_BINARY_MEMBER}`);
  if ((binary.mode & 0o111) === 0) fail(`${CUA_BINARY_MEMBER} is not marked executable in the archive`);
  return binary;
}

function inspectUniversalMachO(binaryPath: string): readonly string[] {
  const result = spawnSync("lipo", ["-archs", binaryPath], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    fail(result.error?.message ?? (result.stderr.trim() || "lipo could not inspect Cua binary"));
  }
  return result.stdout.trim().split(/\s+/).filter(Boolean);
}

function assertExpectedArchitectures(architectures: readonly string[]): void {
  const actual = [...new Set(architectures)].sort();
  const expected = [...EXPECTED_UNIVERSAL_ARCHITECTURES].sort();
  if (actual.length !== expected.length || actual.some((arch, index) => arch !== expected[index])) {
    fail(`cua-driver must be universal ${expected.join("+")}; found ${actual.join("+") || "none"}`);
  }
}

function expectedManifest(contract: CuaDriverReleaseContract, binarySha256: string): CuaDriverVendorManifest {
  return {
    schemaVersion: 1,
    driverVersion: contract.driverVersion,
    releaseRevision: contract.releaseRevision,
    reviewedSourceRevision: contract.reviewedSourceRevision,
    sourceUrl: contract.sourceUrl,
    licenseUrl: contract.licenseUrl,
    licenseSha256: contract.licenseSha256,
    releaseTag: contract.releaseTag,
    releaseUrl: contract.releaseUrl,
    archiveName: contract.archiveName,
    archiveUrl: contract.archiveUrl,
    archiveSha256: contract.archiveSha256,
    binaryMember: CUA_BINARY_MEMBER,
    binarySha256,
    packagedPath: CUA_PACKAGED_BINARY_RELATIVE_PATH,
    architectures: [...EXPECTED_UNIVERSAL_ARCHITECTURES],
    license: "MIT",
  };
}

function provenanceText(manifest: CuaDriverVendorManifest): string {
  return [
    `Cua Driver ${manifest.driverVersion}`,
    `Release tag revision: ${manifest.releaseRevision}`,
    `Reviewed equivalent source revision: ${manifest.reviewedSourceRevision}`,
    `Source: ${manifest.sourceUrl}`,
    `License source: ${manifest.licenseUrl}`,
    `License SHA-256: ${manifest.licenseSha256}`,
    `Release: ${manifest.releaseUrl}`,
    `Archive: ${manifest.archiveUrl}`,
    `Archive SHA-256: ${manifest.archiveSha256}`,
    `Extracted binary SHA-256: ${manifest.binarySha256}`,
    "License: MIT",
    `Nautilo package destination: Contents/Resources/${manifest.packagedPath}`,
    "The packaged executable is a directly spawned Nautilo child; CuaDriver.app is intentionally not bundled.",
    "No runtime download, PATH lookup, local debug target, upstream telemetry, or upstream update path is authorized by this vendor contract.",
    "",
  ].join("\n");
}

function validateCachedVendor(
  vendorDirectory: string,
  inspectArchitectures: (binaryPath: string) => readonly string[],
  contract: CuaDriverReleaseContract,
): boolean {
  const binaryPath = join(vendorDirectory, CUA_BINARY_MEMBER);
  const licensePath = join(vendorDirectory, CUA_LICENSE_MEMBER);
  const manifestPath = join(vendorDirectory, "manifest.json");
  const provenancePath = join(vendorDirectory, "PROVENANCE.md");
  if (!existsSync(binaryPath) || !existsSync(licensePath) || !existsSync(manifestPath) || !existsSync(provenancePath)) return false;
  try {
    const binary = readFileSync(binaryPath);
    const manifest = expectedManifest(contract, sha256(binary));
    if (readFileSync(manifestPath, "utf8") !== `${JSON.stringify(manifest, null, 2)}\n`) return false;
    if (sha256(readFileSync(licensePath)) !== contract.licenseSha256) return false;
    if (!/MIT License/i.test(readFileSync(licensePath, "utf8"))) return false;
    if (readFileSync(provenancePath, "utf8") !== provenanceText(manifest)) return false;
    if (!statSync(binaryPath).isFile() || (statSync(binaryPath).mode & 0o111) === 0) return false;
    assertExpectedArchitectures(inspectArchitectures(binaryPath));
    return true;
  } catch {
    return false;
  }
}

function writeProvenance(stageDirectory: string, manifest: CuaDriverVendorManifest): void {
  writeFileSync(join(stageDirectory, "PROVENANCE.md"), provenanceText(manifest));
}

export function replaceAtomically(stageDirectory: string, vendorDirectory: string): void {
  const backupDirectory = `${vendorDirectory}.previous-${randomUUID()}`;
  let movedExisting = false;
  try {
    if (existsSync(vendorDirectory)) {
      renameSync(vendorDirectory, backupDirectory);
      movedExisting = true;
    }
    renameSync(stageDirectory, vendorDirectory);
    if (movedExisting) rmSync(backupDirectory, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(vendorDirectory) && movedExisting && existsSync(backupDirectory)) {
      renameSync(backupDirectory, vendorDirectory);
    }
    throw error;
  }
}

function assertPinnedReleaseUrl(contract: CuaDriverReleaseContract): void {
  const url = new URL(contract.archiveUrl);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.search.length !== 0 ||
    url.hash.length !== 0 ||
    !url.pathname.endsWith(`/releases/download/${contract.releaseTag}/${contract.archiveName}`) ||
    contract.releaseTag === "latest" ||
    contract.archiveSha256.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(contract.archiveSha256)
  ) {
    fail("Cua archive URL must remain the exact immutable HTTPS release asset");
  }
}

function assertPinnedLicenseUrl(contract: CuaDriverReleaseContract): void {
  const url = new URL(contract.licenseUrl);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "raw.githubusercontent.com" ||
    url.search.length !== 0 ||
    url.hash.length !== 0 ||
    !url.pathname.endsWith(`/${contract.reviewedSourceRevision}/LICENSE.md`) ||
    !/^[a-f0-9]{40}$/.test(contract.releaseRevision) ||
    !/^[a-f0-9]{40}$/.test(contract.reviewedSourceRevision) ||
    !/^[a-f0-9]{64}$/.test(contract.licenseSha256)
  ) {
    fail("Cua license URL must remain the exact immutable HTTPS source file");
  }
}

async function fetchPinnedLicense(fetchImpl: typeof fetch, contract: CuaDriverReleaseContract): Promise<Buffer> {
  const response = await fetchImpl(contract.licenseUrl, { redirect: "error" });
  if (!response.ok) fail(`license download failed: HTTP ${response.status} ${response.statusText}`);
  const license = Buffer.from(await response.arrayBuffer());
  const licenseSha256 = sha256(license);
  if (licenseSha256 !== contract.licenseSha256) {
    fail(`license SHA-256 mismatch; expected ${contract.licenseSha256}, got ${licenseSha256}`);
  }
  if (!/MIT License/i.test(license.toString("utf8"))) fail("pinned Cua license is not recognizably MIT");
  return license;
}

/** Download, prove, safely stage, and atomically install Cua for macOS packaging. */
export async function vendorCuaDriver(options: CuaDriverVendorOptions = {}): Promise<"cached" | "installed"> {
  const contract = options.contract ?? PINNED_CUA_DRIVER_RELEASE;
  assertPinnedReleaseUrl(contract);
  assertPinnedLicenseUrl(contract);
  const vendorDirectory = options.vendorDirectory ?? defaultVendorDirectory;
  const inspectArchitectures = options.inspectArchitectures ?? inspectUniversalMachO;
  const log = options.log ?? ((message: string) => process.stdout.write(`[vendor-cua-driver] ${message}\n`));
  if (validateCachedVendor(vendorDirectory, inspectArchitectures, contract)) {
    log(`cache hit (${contract.driverVersion})`);
    return "cached";
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  log(`GET ${contract.archiveUrl}`);
  const response = await fetchImpl(contract.archiveUrl, { redirect: "follow" });
  if (!response.ok) fail(`download failed: HTTP ${response.status} ${response.statusText}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const archiveSha256 = sha256(archive);
  if (archiveSha256 !== contract.archiveSha256) {
    fail(`archive SHA-256 mismatch; expected ${contract.archiveSha256}, got ${archiveSha256}`);
  }
  const binary = assertExpectedArchive(parseSafeCuaDriverArchive(archive));
  log(`GET ${contract.licenseUrl}`);
  const license = await fetchPinnedLicense(fetchImpl, contract);

  const parentDirectory = dirname(vendorDirectory);
  mkdirSync(parentDirectory, { recursive: true });
  const stageDirectory = mkdtempSync(join(parentDirectory, `.${CUA_VENDOR_DIRECTORY_NAME}.stage-`));
  try {
    const binaryPath = join(stageDirectory, CUA_BINARY_MEMBER);
    writeFileSync(binaryPath, binary.bytes, { mode: 0o755 });
    chmodSync(binaryPath, 0o755);
    writeFileSync(join(stageDirectory, CUA_LICENSE_MEMBER), license);
    const manifest = expectedManifest(contract, sha256(binary.bytes));
    writeFileSync(join(stageDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeProvenance(stageDirectory, manifest);
    assertExpectedArchitectures(inspectArchitectures(binaryPath));
    replaceAtomically(stageDirectory, vendorDirectory);
  } catch (error) {
    rmSync(stageDirectory, { recursive: true, force: true });
    throw error;
  }
  log(`installed Cua Driver ${contract.driverVersion} at ${vendorDirectory}`);
  return "installed";
}

export async function vendorForPackaging(options: {
  qualification: boolean;
  buildQualification: () => Promise<void>;
  buildRelease: () => Promise<unknown>;
}): Promise<void> {
  if (options.qualification) await options.buildQualification();
  else await options.buildRelease();
}

if (import.meta.main) {
  vendorForPackaging({
    qualification: existsSync(new URL("../cua-driver/qualification/manifest.json", import.meta.url)),
    buildQualification: () => import("./build-qualification-cua-driver").then(({ buildQualificationCuaDriver }) => buildQualificationCuaDriver()),
    buildRelease: () => vendorCuaDriver(),
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
