import { createHash, createPublicKey, verify as verifyEd25519 } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

import { CLI_PUBLIC_RELEASE_ORIGIN, CLI_RELEASE_TRUSTED_PUBLIC_KEYS, CLI_STABLE_MANIFEST_URL } from "./cli-release-trust.ts";

const CLI_RELEASE_MAX_MANIFEST_BYTES = 64 * 1024;
const CLI_RELEASE_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SHA512 = /^[a-f0-9]{128}$/;
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PLATFORM = /^(?:darwin-arm64|darwin-x64)$/;

export type CliReleasePlatform = "darwin-arm64" | "darwin-x64";
export interface CliReleaseTarget {
  readonly platform: CliReleasePlatform;
  readonly archive: { readonly filename: string; readonly url: string; readonly size: number; readonly sha256: string; readonly sha512: string };
  readonly evidence: { readonly filename: string; readonly url: string; readonly size: number; readonly sha256: string };
  readonly installer: { readonly filename: string; readonly url: string; readonly size: number; readonly sha256: string };
}
export interface CliReleaseManifestBody {
  readonly schemaVersion: 1;
  readonly channel: "stable";
  readonly version: string;
  readonly source: string;
  readonly targets: readonly CliReleaseTarget[];
}
export interface SignedCliReleaseManifest {
  readonly manifest: CliReleaseManifestBody;
  readonly signature: { readonly algorithm: "ed25519"; readonly keyId: string; readonly value: string };
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
export function canonicalCliReleaseBytes(value: Json): Buffer {
  const canonical = (item: Json): string => {
    if (item === null || typeof item !== "object") return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    const record = item as { readonly [key: string]: Json };
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key]!)}`).join(",")}}`;
  };
  return Buffer.from(canonical(value));
}

function releaseUrl(value: unknown, version: string, filename: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const expected = `/cli/releases/${version}/${filename}`;
    return url.origin === CLI_PUBLIC_RELEASE_ORIGIN && url.protocol === "https:" && url.pathname === expected && url.search === "" && url.hash === "" ? url.href : null;
  } catch { return null; }
}
function artifact(value: unknown, version: string, kind: "archive"): CliReleaseTarget["archive"] | null;
function artifact(value: unknown, version: string, kind: "evidence" | "installer"): CliReleaseTarget["evidence"] | null;
function artifact(value: unknown, version: string, kind: "archive" | "evidence" | "installer"): CliReleaseTarget["archive"] | CliReleaseTarget["evidence"] | null {
  if (!object(value)) return null;
  const keys = kind === "archive" ? ["filename", "url", "size", "sha256", "sha512"] : ["filename", "url", "size", "sha256"];
  if (!exact(value, keys) || typeof value["filename"] !== "string" || basename(value["filename"]) !== value["filename"] || !/^[A-Za-z0-9._-]+$/.test(value["filename"])) return null;
  const filename = value["filename"];
  const url = releaseUrl(value["url"], version, filename);
  const size = value["size"];
  if (url === null || typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > CLI_RELEASE_MAX_ARCHIVE_BYTES || typeof value["sha256"] !== "string" || !SHA256.test(value["sha256"])) return null;
  if (kind === "archive") {
    if (typeof value["sha512"] !== "string" || !SHA512.test(value["sha512"])) return null;
    return { filename, url, size, sha256: value["sha256"], sha512: value["sha512"] };
  }
  return { filename, url, size, sha256: value["sha256"] };
}

export function parseAndVerifyCliReleaseManifest(
  value: unknown,
  trustedPublicKeys: Readonly<Record<string, string>> = CLI_RELEASE_TRUSTED_PUBLIC_KEYS,
): SignedCliReleaseManifest {
  if (!object(value) || !exact(value, ["manifest", "signature"]) || !object(value["manifest"]) || !object(value["signature"])) throw new Error("CLI release manifest is malformed.");
  const body = value["manifest"];
  const signature = value["signature"];
  if (!exact(body, ["schemaVersion", "channel", "version", "source", "targets"]) || body["schemaVersion"] !== 1 || body["channel"] !== "stable" || typeof body["version"] !== "string" || !SEMVER.test(body["version"]) || typeof body["source"] !== "string" || !SOURCE_SHA.test(body["source"]) || !Array.isArray(body["targets"]) || body["targets"].length !== 2) throw new Error("CLI release manifest body is malformed.");
  const version = body["version"];
  const seen = new Set<string>();
  const targets: CliReleaseTarget[] = body["targets"].map((candidate) => {
    if (!object(candidate) || !exact(candidate, ["platform", "archive", "evidence", "installer"]) || typeof candidate["platform"] !== "string" || !PLATFORM.test(candidate["platform"]) || seen.has(candidate["platform"])) throw new Error("CLI release target is malformed.");
    const targetPlatform = candidate["platform"];
    seen.add(targetPlatform);
    const archiveValue = artifact(candidate["archive"], version, "archive");
    const evidenceValue = artifact(candidate["evidence"], version, "evidence");
    const installerValue = artifact(candidate["installer"], version, "installer");
    if (archiveValue === null || evidenceValue === null || installerValue === null) throw new Error("CLI release target artifact is malformed.");
    const expectedArchive = `nautilo-cli-${version}-${targetPlatform}.tar.gz`;
    const expectedEvidence = `nautilo-cli-${version}-${targetPlatform}.evidence.tar.gz`;
    const expectedInstaller = `install-nautilo-${targetPlatform}`;
    if (archiveValue.filename !== expectedArchive || evidenceValue.filename !== expectedEvidence || installerValue.filename !== expectedInstaller) throw new Error("CLI release target filenames do not match the platform contract.");
    return { platform: targetPlatform as CliReleasePlatform, archive: archiveValue, evidence: evidenceValue, installer: installerValue };
  });
  if (!seen.has("darwin-arm64") || !seen.has("darwin-x64")) throw new Error("CLI release target matrix is incomplete.");
  if (!exact(signature, ["algorithm", "keyId", "value"]) || signature["algorithm"] !== "ed25519" || typeof signature["keyId"] !== "string" || typeof signature["value"] !== "string" || !BASE64.test(signature["value"])) throw new Error("CLI release signature is malformed.");
  const key = trustedPublicKeys[signature["keyId"]];
  if (key === undefined) throw new Error("CLI release signing key is not trusted.");
  const manifest: CliReleaseManifestBody = { schemaVersion: 1, channel: "stable", version: body["version"], source: body["source"], targets };
  const verified = verifyEd25519(null, canonicalCliReleaseBytes(manifest as unknown as Json), createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" }), Buffer.from(signature["value"], "base64"));
  if (!verified) throw new Error("CLI release signature is invalid.");
  return { manifest, signature: { algorithm: "ed25519", keyId: signature["keyId"], value: signature["value"] } };
}

function platform(): CliReleasePlatform {
  if (process.platform !== "darwin" || (process.arch !== "arm64" && process.arch !== "x64")) throw new Error("Nautilo standalone updates support macOS arm64 and x64 only.");
  return `darwin-${process.arch}`;
}
async function fetchExact(url: string, max: number, expected?: { size: number; sha256: string; sha512?: string }): Promise<Buffer> {
  const response = await fetch(url, { redirect: "error", headers: { accept: "application/json, application/octet-stream" } });
  if (!response.ok || response.url !== url) throw new Error(`CLI release download failed (${response.status}).`);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > max) throw new Error("CLI release download exceeds its size limit.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > max || (expected !== undefined && bytes.length !== expected.size)) throw new Error("CLI release download has the wrong size.");
  if (expected !== undefined) {
    if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256) throw new Error("CLI release download has the wrong SHA-256 digest.");
    if (expected.sha512 !== undefined && createHash("sha512").update(bytes).digest("hex") !== expected.sha512) throw new Error("CLI release download has the wrong SHA-512 digest.");
  }
  return bytes;
}
function verifyArtifactBytes(bytes: Buffer, expected: CliReleaseTarget["archive"]): Buffer {
  if (bytes.length !== expected.size || bytes.length > CLI_RELEASE_MAX_ARCHIVE_BYTES) throw new Error("CLI release download has the wrong size.");
  if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256 || createHash("sha512").update(bytes).digest("hex") !== expected.sha512) throw new Error("CLI release download has the wrong digest.");
  return bytes;
}
export async function fetchStableCliRelease(): Promise<SignedCliReleaseManifest> {
  const bytes = await fetchExact(CLI_STABLE_MANIFEST_URL, CLI_RELEASE_MAX_MANIFEST_BYTES);
  try { return parseAndVerifyCliReleaseManifest(JSON.parse(bytes.toString("utf8")) as unknown); }
  catch (error) { throw new Error(error instanceof Error ? error.message : "CLI release manifest verification failed."); }
}

export interface CliInstallRoots { readonly share: string; readonly bin: string }
function defaultCliInstallRoots(): CliInstallRoots {
  return { share: join(homedir(), ".local", "share", "nautilo-cli"), bin: join(homedir(), ".local", "bin") };
}
function atomicSymlink(target: string, destination: string): void {
  const temp = `${destination}.new-${process.pid}`;
  if (existsSync(temp)) rmSync(temp, { force: true });
  symlinkSync(target, temp);
  renameSync(temp, destination);
}
function currentVersion(roots: CliInstallRoots): string | null {
  const current = join(roots.share, "current");
  if (!existsSync(current)) return null;
  const target = readlinkSync(current);
  const match = /^versions\/([^/]+)\/[^/]+$/.exec(target);
  return match?.[1] ?? null;
}
function compareVersions(left: string, right: string): number {
  const a = SEMVER.exec(left); const b = SEMVER.exec(right);
  if (a === null || b === null) throw new Error("CLI release version is invalid.");
  for (let i = 1; i <= 3; i += 1) { const delta = Number(a[i]) - Number(b[i]); if (delta !== 0) return delta; }
  return 0;
}
function verifyArchiveListing(archive: string, expectedRoot: string): void {
  const result = Bun.spawnSync(["tar", "-tzf", archive], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("CLI release archive cannot be listed.");
  const entries = new TextDecoder().decode(result.stdout).trim().split("\n").filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => !entry.startsWith(`${expectedRoot}/`) || entry.startsWith("/") || entry.split("/").includes("..") || entry.includes("\\"))) throw new Error("CLI release archive contains an unsafe path.");
  const verbose = Bun.spawnSync(["tar", "-tvzf", archive], { stdout: "pipe", stderr: "pipe" });
  if (verbose.exitCode !== 0 || new TextDecoder().decode(verbose.stdout).trim().split("\n").filter(Boolean).some((line) => !["-", "d"].includes(line[0] ?? ""))) throw new Error("CLI release archive contains a link or special file.");
}

export async function installStableCliRelease(input: {
  roots?: CliInstallRoots;
  allowDowngrade?: boolean;
  manifest?: SignedCliReleaseManifest;
  platform?: CliReleasePlatform;
  fetchArchive?: (target: CliReleaseTarget["archive"]) => Promise<Buffer>;
} = {}): Promise<{ version: string; previousVersion: string | null; changed: boolean }> {
  const roots = input.roots ?? defaultCliInstallRoots();
  const signed = input.manifest ?? await fetchStableCliRelease();
  const target = signed.manifest.targets.find((entry) => entry.platform === (input.platform ?? platform()));
  if (target === undefined) throw new Error("CLI release has no artifact for this Mac.");
  const prior = currentVersion(roots);
  if (prior !== null && compareVersions(signed.manifest.version, prior) < 0 && input.allowDowngrade !== true) throw new Error("CLI update refuses a downgrade; use rollback for the previous installed release.");
  if (prior === signed.manifest.version) return { version: prior, previousVersion: prior, changed: false };
  const bytes = input.fetchArchive === undefined
    ? await fetchExact(target.archive.url, CLI_RELEASE_MAX_ARCHIVE_BYTES, target.archive)
    : verifyArtifactBytes(await input.fetchArchive(target.archive), target.archive);
  mkdirSync(join(roots.share, "versions"), { recursive: true, mode: 0o755 });
  mkdirSync(roots.bin, { recursive: true, mode: 0o755 });
  const work = mkdtempSync(join(tmpdir(), "nautilo-cli-install-"));
  try {
    const archive = join(work, target.archive.filename);
    writeFileSync(archive, bytes, { flag: "wx", mode: 0o600 });
    const bundleName = `nautilo-cli-${signed.manifest.version}-${target.platform}`;
    verifyArchiveListing(archive, bundleName);
    const extracted = join(work, "extracted"); mkdirSync(extracted, { mode: 0o700 });
    const untar = Bun.spawnSync(["tar", "-xzf", archive, "-C", extracted], { stdout: "pipe", stderr: "pipe" });
    if (untar.exitCode !== 0) throw new Error("CLI release archive cannot be extracted.");
    const bundle = join(extracted, bundleName);
    const binary = join(bundle, "bin", "nautilo");
    const manifest = join(bundle, "artifact-manifest.json");
    for (const required of [binary, manifest]) { const stat = lstatSync(required); if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("CLI release bundle is incomplete."); }
    chmodSync(binary, 0o755);
    const smoke = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
    if (smoke.exitCode !== 0 || !new TextDecoder().decode(smoke.stdout).startsWith(`nautilo ${signed.manifest.version} `)) throw new Error("CLI release binary failed its installed smoke check.");
    const versionDir = join(roots.share, "versions", signed.manifest.version);
    mkdirSync(versionDir, { recursive: true, mode: 0o755 });
    const destination = join(versionDir, bundleName);
    if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
    renameSync(bundle, destination);
    const currentTarget = `versions/${signed.manifest.version}/${bundleName}`;
    if (prior !== null) {
      const old = readlinkSync(join(roots.share, "current"));
      atomicSymlink(old, join(roots.share, "previous"));
    }
    atomicSymlink(currentTarget, join(roots.share, "current"));
    const relativeBinary = relative(roots.bin, join(roots.share, "current", "bin", "nautilo"));
    atomicSymlink(relativeBinary, join(roots.bin, "nautilo"));
    if (realpathSync(join(roots.bin, "nautilo")) !== realpathSync(join(destination, "bin", "nautilo"))) throw new Error("CLI release activation verification failed.");
    return { version: signed.manifest.version, previousVersion: prior, changed: true };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

export function rollbackCliRelease(roots: CliInstallRoots = defaultCliInstallRoots()): { version: string } {
  const current = join(roots.share, "current"); const previous = join(roots.share, "previous");
  if (!existsSync(current) || !existsSync(previous)) throw new Error("No previous Nautilo CLI release is available for rollback.");
  const currentTarget = readlinkSync(current); const previousTarget = readlinkSync(previous);
  atomicSymlink(previousTarget, current); atomicSymlink(currentTarget, previous);
  const version = currentVersion(roots);
  if (version === null) throw new Error("CLI rollback activation verification failed.");
  return { version };
}
