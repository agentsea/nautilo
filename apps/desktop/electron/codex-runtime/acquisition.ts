import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createGunzip } from "node:zlib";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { CodexRpcClient, rpcRuntimeDecoder } from "@nautilo/codex-app-server";
import type {
  CodexRuntimeCode,
  CodexRuntimeDetails,
  CodexRuntimeInstallState,
  CodexRuntimePlatformKey,
  CodexRuntimeReleaseDescriptor,
  CodexRuntimeReleaseManifest,
  ResolveManagedCodexRuntimeOptions,
  RuntimeProcess,
} from "./contracts.ts";
import { REVIEWED_CODEX_RUNTIME_MANIFEST, validateCodexRuntimeReleaseManifest } from "./release-manifest.ts";

const MAX_ARCHIVE_OVERHEAD = 64 * 1024;
const MAX_ARCHIVE_ENTRIES = 4_096;
const MAX_PATH_BYTES = 1_024;
const MAX_MEMBER_BYTES = 256 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 768 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
const MAX_PAX_HEADER_BYTES = 4 * 1024;
const MAX_PROCESS_OUTPUT = 512 * 1024;
const HEALTH_TIMEOUT_MS = 5_000;
const ROOT_MARKER = "nautilo-codex-managed-root-v1\n";
const ROOT_MARKER_FILE = ".nautilo-managed-root";
const LOCK_DIRECTORY = ".nautilo-mutation-lock";
const LOCK_OWNER_FILE = "owner.json";
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 25;

interface FetchResponse {
  readonly url: string;
  readonly status: number;
  readonly contentLength: number | null;
  readonly body: AsyncIterable<Uint8Array>;
}
export interface ManagedRuntimeHost {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly runtimeRoot: string;
  fetch(url: string, signal?: AbortSignal): Promise<FetchResponse>;
  verifyDarwinSignature(
    entrypoint: string,
    signature: CodexRuntimeReleaseDescriptor["signature"],
  ): Promise<boolean>;
  health(entrypoint: string, expectedVersion: string, signal?: AbortSignal): Promise<boolean>;
  now(): number;
  randomHandle(): string;
}
export interface ManagedRuntimeLease {
  readonly generation: number;
  release(): void;
}
interface ActiveRecord {
  readonly schemaVersion: 1;
  readonly handle: string;
  readonly version: string;
  readonly platform: CodexRuntimePlatformKey;
  readonly digest: string;
  readonly generation: number;
}
interface PrivateHandleRecord {
  readonly details: CodexRuntimeDetails;
  readonly generation: number;
  readonly digest: string;
  readonly entrypoint: string;
  readonly descriptor: CodexRuntimeReleaseDescriptor;
}
interface RuntimeLockOwner {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly nonce: string;
}

const fail = (code: CodexRuntimeCode, now: number, source?: "managed", version?: string): CodexRuntimeDetails =>
  Object.freeze({ state: code === "CODEX_RUNTIME_INCOMPATIBLE" ? "incompatible" : "unavailable", code, ...(source ? { source } : {}), ...(version ? { version } : {}), checkedAt: now });
const platformKey = (platform: NodeJS.Platform, arch: string): CodexRuntimePlatformKey | null =>
  platform === "darwin" && arch === "arm64" ? "darwin-arm64" : platform === "darwin" && arch === "x64" ? "darwin-x64" : null;
const DOWNLOAD_HOSTS = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
const allowedDownloadUrl = (url: string): boolean => {
  try { const parsed = new URL(url); return parsed.protocol === "https:" && DOWNLOAD_HOSTS.has(parsed.hostname); } catch { return false; }
};
const safeEqualHex = (expected: string, actual: string): boolean => {
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(actual, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};
const inside = (root: string, candidate: string): boolean => {
  const child = resolve(candidate);
  return child === root || child.startsWith(`${root}${sep}`);
};
const readableText = (value: Uint8Array) => new TextDecoder().decode(value);
const missing = (error: unknown): boolean =>
  Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
const alreadyExists = (error: unknown): boolean =>
  Boolean(error && typeof error === "object" && "code" in error && ["EEXIST", "ENOTEMPTY"].includes((error as { code?: unknown }).code as string));
const aborted = (error: unknown, signal?: AbortSignal): boolean =>
  Boolean(signal?.aborted || (error instanceof Error && error.name === "AbortError"));

/** A managed path is never allowed to cross a symlink below the owned root. */
async function assertOwnedDescendant(root: string, candidate: string, directory = false): Promise<void> {
  if (!inside(root, candidate)) throw new Error("unsafe_managed_path");
  const parts = relative(root, candidate).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    if (part === "." || part === "..") throw new Error("unsafe_managed_path");
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("unsafe_managed_path");
    if (current !== candidate && !info.isDirectory()) throw new Error("unsafe_managed_path");
    if (current === candidate && directory && !info.isDirectory()) throw new Error("unsafe_managed_path");
  }
}

async function readExactRegularFile(path: string, expected: string, maxBytes = 4 * 1024): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() && info.size <= maxBytes && (await readFile(path, "utf8")) === expected;
  } catch { return false; }
}

function tarString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return readableText(bytes.slice(0, end < 0 ? bytes.length : end));
}
function tarSize(bytes: Uint8Array): number | null {
  const raw = tarString(bytes).trim();
  return /^[0-7]*$/.test(raw) ? Number.parseInt(raw || "0", 8) : null;
}
function validateMemberName(name: string, directory = false): boolean {
  const normalized = directory ? name.replace(/\/$/, "") : name;
  return Boolean(normalized) && Buffer.byteLength(name, "utf8") <= MAX_PATH_BYTES && !name.includes("\0") && !name.startsWith("/") && !normalized.split("/").some((part) => !part || part === "." || part === "..");
}

/** Accept only the harmless local mtime record emitted by OpenAI's release tar. */
function validatePaxMtimeHeader(bytes: Uint8Array): boolean {
  let offset = 0;
  let records = 0;
  while (offset < bytes.byteLength) {
    const space = bytes.indexOf(0x20, offset);
    if (space <= offset) return false;
    const lengthText = readableText(bytes.slice(offset, space));
    if (!/^[1-9]\d*$/.test(lengthText)) return false;
    const length = Number.parseInt(lengthText, 10);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > bytes.byteLength || bytes[end - 1] !== 0x0a) return false;
    const record = readableText(bytes.slice(space + 1, end - 1));
    if (!/^mtime=-?\d+(?:\.\d+)?$/.test(record)) return false;
    records += 1;
    offset = end;
  }
  return records > 0;
}

/** Incremental tar reader: one header and one bounded member are resident at once. */
async function extractTarGz(archive: string, destination: string, signal?: AbortSignal): Promise<Set<string>> {
  const paths = new Set<string>();
  const folded = new Set<string>();
  let files = 0;
  let expanded = 0;
  let pending = new Uint8Array();
  let member: { remaining: number; padding: number; output?: Awaited<ReturnType<typeof open>>; pax?: Uint8Array; paxOffset?: number } | undefined;
  let zeroHeaders = 0;
  let complete = false;
  let inflated = 0;
  const input = createReadStream(archive, { highWaterMark: 64 * 1024 }).pipe(createGunzip());
  try {
    for await (const value of input as AsyncIterable<Uint8Array>) {
      if (signal?.aborted) throw new Error("cancelled");
      const chunk = new Uint8Array(value);
      if ((inflated += chunk.byteLength) > MAX_EXPANDED_BYTES) throw new Error("archive_limit");
      const merged = new Uint8Array(pending.byteLength + chunk.byteLength);
      merged.set(pending); merged.set(chunk, pending.byteLength);
      pending = merged;
      while (pending.byteLength) {
        if (member) {
          if (member.remaining) {
            const take = Math.min(member.remaining, pending.byteLength);
            if (member.output) await writeAll(member.output, pending.slice(0, take));
            if (member.pax) {
              member.pax.set(pending.slice(0, take), member.paxOffset ?? 0);
              member.paxOffset = (member.paxOffset ?? 0) + take;
            }
            member.remaining -= take;
            pending = pending.slice(take);
            if (member.remaining) continue;
            await member.output?.close();
            if (member.pax && !validatePaxMtimeHeader(member.pax)) throw new Error("unsafe_pax_header");
          }
          const take = Math.min(member.padding, pending.byteLength);
          member.padding -= take;
          pending = pending.slice(take);
          if (member.padding) continue;
          member = undefined;
          continue;
        }
        if (pending.byteLength < 512) break;
        const header = pending.slice(0, 512);
        pending = pending.slice(512);
        if (header.every((byte) => byte === 0)) {
          zeroHeaders += 1;
          if (zeroHeaders === 2) { complete = true; pending = new Uint8Array(); break; }
          continue;
        }
        if (zeroHeaders) throw new Error("invalid_tar_trailer");
        const prefix = tarString(header.slice(345, 500));
        const name = `${prefix ? `${prefix}/` : ""}${tarString(header.slice(0, 100))}`;
        const size = tarSize(header.slice(124, 136));
        const type = header[156] || 0;
        const checksum = tarSize(header.slice(148, 156));
        const calculated = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
        if (type === 120) {
          if (checksum !== calculated || name !== "././@PaxHeader" || size === null || size <= 0 || size > MAX_PAX_HEADER_BYTES)
            throw new Error("unsafe_pax_header");
          if (++files > MAX_ARCHIVE_ENTRIES || (expanded += size) > MAX_EXPANDED_BYTES) throw new Error("archive_limit");
          member = { remaining: size, padding: Math.ceil(size / 512) * 512 - size, pax: new Uint8Array(size), paxOffset: 0 };
          continue;
        }
        if (checksum !== calculated || !validateMemberName(name, type === 53) || size === null || size > MAX_MEMBER_BYTES || ![0, 48, 53].includes(type))
          throw new Error("unsafe_archive");
        if (++files > MAX_ARCHIVE_ENTRIES || (expanded += size) > MAX_EXPANDED_BYTES) throw new Error("archive_limit");
        const normalizedName = type === 53 ? name.replace(/\/$/, "") : name;
        const lower = normalizedName.toLowerCase();
        if (paths.has(normalizedName) || folded.has(lower)) throw new Error("duplicate_archive_member");
        paths.add(normalizedName); folded.add(lower);
        const file = join(destination, normalizedName);
        if (!inside(destination, file)) throw new Error("unsafe_archive");
        if (type === 53) {
          if (size !== 0) throw new Error("unsafe_archive");
          await mkdir(file, { recursive: false, mode: 0o700 });
          continue;
        }
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        const output = await open(file, "wx", 0o600);
        if (size === 0) await output.close();
        else member = { remaining: size, padding: Math.ceil(size / 512) * 512 - size, output };
      }
    }
    if (member || pending.byteLength || !complete) throw new Error("truncated_archive");
    return paths;
  } finally { await member?.output?.close().catch(() => undefined); }
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten <= 0) throw new Error("short_file_write");
    offset += bytesWritten;
  }
}
async function digestFile(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 }) as AsyncIterable<Uint8Array>) {
    if (signal?.aborted) throw new Error("cancelled");
    hash.update(chunk);
  }
  return hash.digest("hex");
}
async function validatePackage(
  root: string,
  descriptor: CodexRuntimeReleaseDescriptor,
  members?: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<string> {
  if ((await lstat(root)).isSymbolicLink()) throw new Error("unsafe_package");
  const canonical = await realpath(root);
  const expectedFiles = new Set(Object.keys(descriptor.package.requiredMembers));
  const expectedDirectories = new Set<string>();
  for (const member of expectedFiles) {
    const parts = member.split("/");
    for (let index = 1; index < parts.length; index += 1) expectedDirectories.add(parts.slice(0, index).join("/"));
  }
  if (members && ([...members].some((member) => !expectedFiles.has(member) && !expectedDirectories.has(member)) || [...expectedFiles].some((member) => !members.has(member))))
    throw new Error("unknown_package_member");
  const noSymlinkParents = async (member: string): Promise<string> => {
    let current = canonical;
    for (const segment of member.split("/")) {
      current = join(current, segment);
      if ((await lstat(current)).isSymbolicLink()) throw new Error("unsafe_package");
    }
    return current;
  };
  const entrypoint = join(canonical, descriptor.package.entrypoint);
  if (!inside(canonical, entrypoint)) throw new Error("unsafe_package");
  const seen = new Set<string>();
  const walk = async (directory: string, prefix = ""): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const member = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = await noSymlinkParents(member);
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error("unsafe_package");
      if (entry.isDirectory()) {
        if (!expectedDirectories.has(member)) throw new Error("unknown_package_member");
        await walk(path, member);
      } else {
        // This is manager metadata, outside the signed package layout. It is
        // admitted only at the release root and only with the exact digest.
        if (member === ".nautilo-managed-release" && (await readExactRegularFile(path, descriptor.sha256))) continue;
        const expected = descriptor.package.requiredMembers[member];
        if (!expected) throw new Error("unknown_package_member");
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.bytes || !safeEqualHex(expected.sha256, await digestFile(path, signal)))
          throw new Error("invalid_package_member");
        seen.add(member);
      }
    }
  };
  await walk(canonical);
  if (seen.size !== expectedFiles.size || [...expectedFiles].some((member) => !seen.has(member))) throw new Error("missing_member");
  for (const member of expectedFiles) {
    const path = await noSymlinkParents(member);
    if (!inside(canonical, path) || !(await lstat(path)).isFile()) throw new Error("missing_member");
  }
  const packageManifest = join(canonical, "codex-package.json");
  const packageBytes = await readFile(packageManifest);
  if (packageBytes.byteLength > MAX_PACKAGE_JSON_BYTES) throw new Error("package_manifest_limit");
  let manifest: unknown;
  try { manifest = JSON.parse(readableText(packageBytes)); } catch { throw new Error("invalid_package_manifest"); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || Object.keys(manifest).length !== 7 || !["layoutVersion", "version", "target", "variant", "entrypoint", "pathDir", "resourcesDir"].every((key) => Object.hasOwn(manifest, key))) throw new Error("invalid_package_manifest");
  const value = manifest as Record<string, unknown>;
  if (
    value["layoutVersion"] !== descriptor.package.layoutVersion ||
    value["version"] !== descriptor.package.version ||
    value["target"] !== descriptor.package.target ||
    value["variant"] !== descriptor.package.variant ||
    value["entrypoint"] !== descriptor.package.entrypoint ||
    value["pathDir"] !== descriptor.package.pathDir ||
    value["resourcesDir"] !== descriptor.package.resourcesDir
  ) throw new Error("wrong_package_manifest");
  const entry = await lstat(entrypoint);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("unsafe_entrypoint");
  return entrypoint;
}
async function enableManagedExecutables(root: string, descriptor: CodexRuntimeReleaseDescriptor): Promise<void> {
  for (const member of descriptor.package.executableMembers) {
    const path = join(root, member);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe_executable_member");
    await chmod(path, 0o700);
  }
}
async function requireExecutableMembers(root: string, descriptor: CodexRuntimeReleaseDescriptor): Promise<void> {
  for (const member of descriptor.package.executableMembers) {
    const info = await lstat(join(root, member));
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o100) === 0)
      throw new Error("executable_mode");
  }
}
async function hasDarwinArchitecture(entrypoint: string, arch: string): Promise<boolean> {
  const file = await open(entrypoint, "r");
  try {
    const header = new Uint8Array(4_096);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const bytes = header.slice(0, bytesRead);
    const u32be = (offset: number) => ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
    const u32le = (offset: number) => (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
    const cpu = arch === "arm64" ? 0x0100000c : arch === "x64" ? 0x01000007 : 0;
    const magic = u32be(0);
    // Mach-O stores both magic and CPU type in the file's byte order. Reading
    // the magic as big-endian means MH_MAGIC_64 uses big-endian CPU bytes,
    // while the native Darwin MH_CIGAM_64 form uses little-endian CPU bytes.
    if (magic === 0xfeedfacf) return u32be(4) === cpu;
    if (magic === 0xcffaedfe) return u32le(4) === cpu;
    if (magic !== 0xcafebabe && magic !== 0xcafebabf) return false;
    const count = u32be(4);
    const entryBytes = magic === 0xcafebabf ? 32 : 20;
    return count <= 32 && 8 + count * entryBytes <= bytes.length && Array.from({ length: count }, (_, index) => u32be(8 + index * entryBytes)).includes(cpu);
  } finally { await file.close(); }
}

async function fsyncFile(path: string): Promise<void> {
  const file = await open(path, "r");
  try { await file.sync(); } finally { await file.close(); }
}
async function fsyncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export class CodexManagedRuntimeManager {
  private readonly singleflight = new Map<string, Promise<CodexRuntimeDetails>>();
  private readonly leases = new Map<number, number>();
  private readonly generationDigests = new Map<number, string>();
  private readonly handles = new Map<string, PrivateHandleRecord>();
  private mutationTail: Promise<void> = Promise.resolve();
  private activeMutation: { readonly root: string; readonly nonce: string } | undefined;
  private readonly progress = new WeakMap<NonNullable<ResolveManagedCodexRuntimeOptions["onState"]>, CodexRuntimeInstallState>();
  private readonly catalog: readonly CodexRuntimeReleaseManifest[];
  private readonly defaultManifest: CodexRuntimeReleaseManifest;
  private generation = 0;
  constructor(
    private readonly host: ManagedRuntimeHost,
    source: CodexRuntimeReleaseManifest | readonly CodexRuntimeReleaseManifest[] = REVIEWED_CODEX_RUNTIME_MANIFEST as CodexRuntimeReleaseManifest,
  ) {
    const supplied = Array.isArray(source) ? source : [source];
    const catalog = supplied.map((manifest) => validateCodexRuntimeReleaseManifest(manifest));
    if (catalog.some((manifest) => manifest === null)) throw new Error("invalid_runtime_catalog");
    const resolved = catalog as CodexRuntimeReleaseManifest[];
    const identities = new Set<string>();
    for (const manifest of resolved) for (const descriptor of Object.values(manifest.artifacts)) {
      const key = `${descriptor.version}:${descriptor.platform}`;
      if (identities.has(key)) throw new Error("duplicate_runtime_catalog_identity");
      identities.add(key);
    }
    const current = resolved
      .filter((manifest) => manifest.cohort === "certified")
      .sort((left, right) => right.codexVersion.localeCompare(left.codexVersion, undefined, { numeric: true }))[0];
    if (!current) throw new Error("missing_certified_runtime_default");
    this.catalog = Object.freeze([...resolved]);
    this.defaultManifest = current;
  }

  async install(options: ResolveManagedCodexRuntimeOptions = {}): Promise<CodexRuntimeDetails> {
    const platform = platformKey(this.host.platform, this.host.arch);
    const requestedVersion = options.version ?? this.defaultManifest.codexVersion;
    if (!platform) return fail("CODEX_RUNTIME_PLATFORM_UNSUPPORTED", this.host.now(), "managed", requestedVersion);
    const descriptor = this.descriptorFor(requestedVersion, platform);
    if (!descriptor) return fail("CODEX_RUNTIME_PLATFORM_UNSUPPORTED", this.host.now(), "managed", requestedVersion);
    const key = `${descriptor.version}:${platform}:${descriptor.sha256}`;
    const existing = this.singleflight.get(key);
    if (existing) return existing;
    const pending = this.withMutation((root) => this.installOne(root, descriptor, options), true, options.signal)
      .catch(() => options.signal?.aborted ? this.cancelled(options, descriptor) : this.failed(options, descriptor, "CODEX_RUNTIME_INSTALL_FAILED"))
      .finally(() => this.singleflight.delete(key));
    this.singleflight.set(key, pending);
    return pending;
  }

  acquireLease(handle: string): ManagedRuntimeLease | null {
    const privateRecord = this.handles.get(handle);
    if (!privateRecord) return null;
    const generation = privateRecord.generation;
    this.leases.set(generation, (this.leases.get(generation) ?? 0) + 1);
    let released = false;
    return Object.freeze({ generation, release: () => {
      if (released) return;
      released = true;
      const count = this.leases.get(generation) ?? 0;
      if (count <= 1) this.leases.delete(generation); else this.leases.set(generation, count - 1);
    } });
  }

  inspect(handle: string): CodexRuntimeDetails | null {
    return this.handles.get(handle)?.details ?? null;
  }
  async revalidate(handle: string): Promise<boolean> {
    const record = this.handles.get(handle);
    if (!record) return false;
    try {
      const root = dirname(dirname(record.entrypoint));
      const owned = await this.ownedRoot(false);
      if (!inside(owned, root) || !(await this.hasOwnedRelease(owned, root, record.digest))) return false;
      const entrypoint = await validatePackage(root, record.descriptor);
      await requireExecutableMembers(root, record.descriptor);
      return safeEqualHex(record.descriptor.entrypointSha256, await digestFile(entrypoint));
    } catch { return false; }
  }

  async rollback(options: ResolveManagedCodexRuntimeOptions = {}): Promise<CodexRuntimeDetails | null> {
    return this.withMutation((root) => this.rollbackNow(root, options), false, options.signal).catch(() => null);
  }
  private async rollbackNow(root: string, options: ResolveManagedCodexRuntimeOptions): Promise<CodexRuntimeDetails | null> {
    const active = await this.readOwnedRecord(root, "active.json");
    const previous = await this.readOwnedRecord(root, "rollback.json");
    if (!active || !previous) return null;
    const descriptor = this.descriptorFor(previous.version, previous.platform);
    if (!descriptor || descriptor.version !== previous.version || descriptor.sha256 !== previous.digest) return null;
    try {
      const release = this.releasePath(root, previous.version, previous.platform, previous.digest);
      if (!(await this.hasOwnedRelease(root, release, previous.digest))) return null;
      this.emit(options, "rollback", 0, descriptor.archiveBytes);
      const entrypoint = await validatePackage(release, descriptor, undefined, options.signal);
      const digest = await digestFile(entrypoint, options.signal);
      if (options.signal?.aborted || !safeEqualHex(descriptor.entrypointSha256, digest) || !(await hasDarwinArchitecture(entrypoint, this.host.arch)) || !(await this.host.verifyDarwinSignature(entrypoint, descriptor.signature)) || !(await this.host.health(entrypoint, descriptor.version, options.signal))) return null;
      this.generation = Math.max(this.generation, active.generation, previous.generation);
      const next: ActiveRecord = Object.freeze({ ...previous, handle: this.host.randomHandle(), generation: ++this.generation });
      await this.writeOwnedRecord(root, "rollback.json", active);
      await this.writeOwnedRecord(root, "active.json", next);
      const details = this.ready("managed", descriptor, digest, next.generation, next.handle);
      this.generationDigests.set(next.generation, next.digest);
      this.handles.set(next.handle, { details, generation: next.generation, digest: next.digest, entrypoint, descriptor });
      this.emit(options, "ready", descriptor.archiveBytes, descriptor.archiveBytes);
      return details;
    } catch { this.emit(options, "failed", 0, descriptor.archiveBytes, "CODEX_RUNTIME_INSTALL_FAILED"); return null; }
  }

  /**
   * Admit the already-active managed runtime without contacting the network or
   * enumerating releases.  The active record is the sole filesystem selector.
   */
  async resolveActive(options: ResolveManagedCodexRuntimeOptions = {}): Promise<CodexRuntimeDetails> {
    const platform = platformKey(this.host.platform, this.host.arch);
    let selectedVersion = options.version ?? this.defaultManifest.codexVersion;
    if (!platform) return fail("CODEX_RUNTIME_PLATFORM_UNSUPPORTED", this.host.now(), "managed", selectedVersion);
    if (options.signal?.aborted) return fail("CODEX_RUNTIME_CANCELLED", this.host.now(), "managed", selectedVersion);
    try {
      let root: string;
      try {
        root = await this.ownedRoot(false);
      } catch (error) {
        if (error instanceof Error && error.message === "missing_runtime_root")
          return fail("CODEX_RUNTIME_NOT_FOUND", this.host.now(), "managed", selectedVersion);
        throw error;
      }
      const active = await this.readActiveRecordForResolution(root);
      if (active === "damaged") return fail("CODEX_RUNTIME_INSTALL_FAILED", this.host.now(), "managed", selectedVersion);
      if (!active) return fail("CODEX_RUNTIME_NOT_FOUND", this.host.now(), "managed", selectedVersion);
      selectedVersion = active.version;
      if (active.platform !== platform) return fail("CODEX_RUNTIME_INSTALL_FAILED", this.host.now(), "managed", selectedVersion);
      const descriptor = this.descriptorFor(active.version, active.platform);
      if (!descriptor || descriptor.version !== active.version || descriptor.platform !== active.platform || descriptor.sha256 !== active.digest)
        return fail("CODEX_RUNTIME_INSTALL_FAILED", this.host.now(), "managed", active.version);
      const release = this.releasePath(root, active.version, active.platform, active.digest);
      if (!(await this.hasOwnedRelease(root, release, active.digest))) return fail("CODEX_RUNTIME_INSTALL_FAILED", this.host.now(), "managed", active.version);
      const entrypoint = await validatePackage(release, descriptor, undefined, options.signal);
      const digest = await digestFile(entrypoint, options.signal);
      if (!safeEqualHex(descriptor.entrypointSha256, digest) || !(await hasDarwinArchitecture(entrypoint, this.host.arch)) || !(await this.host.verifyDarwinSignature(entrypoint, descriptor.signature)))
        return fail("CODEX_RUNTIME_INSTALL_FAILED", this.host.now(), "managed", active.version);
      const healthy = await this.host.health(entrypoint, descriptor.version, options.signal);
      if (options.signal?.aborted) return fail("CODEX_RUNTIME_CANCELLED", this.host.now(), "managed", active.version);
      if (!healthy) return fail("CODEX_RUNTIME_INSTALL_FAILED", this.host.now(), "managed", active.version);
      this.generation = Math.max(this.generation, active.generation);
      const handle = this.host.randomHandle();
      const details = this.ready("managed", descriptor, digest, active.generation, handle);
      this.generationDigests.set(active.generation, active.digest);
      this.handles.set(handle, { details, generation: active.generation, digest: active.digest, entrypoint, descriptor });
      return details;
    } catch (error) {
      return fail(aborted(error, options.signal) ? "CODEX_RUNTIME_CANCELLED" : "CODEX_RUNTIME_INSTALL_FAILED", this.host.now(), "managed", selectedVersion);
    }
  }

  async recoverStaging(): Promise<void> {
    return this.withMutation((root) => this.recoverStagingNow(root), true).catch(() => undefined);
  }
  private async recoverStagingNow(root: string): Promise<void> {
    const staging = join(root, "staging");
    try {
      await assertOwnedDescendant(root, staging, true);
      for (const item of await readdir(staging, { withFileTypes: true })) {
        if (!item.isDirectory() || !item.name.startsWith("nautilo-codex-")) continue;
        const path = join(staging, item.name);
        const nonce = item.name.slice("nautilo-codex-".length);
        await this.removeOwnedStaging(root, path, nonce);
      }
    } catch { /* An absent root is already recovered. */ }
    try {
      const state = join(root, "state");
      await assertOwnedDescendant(root, state, true);
      for (const item of await readdir(state, { withFileTypes: true }))
        if (item.isFile() && /^(active|rollback)\.json\.[A-Za-z0-9-]+\.tmp$/.test(item.name)) {
          await this.assertMutationLock(root);
          await rm(join(state, item.name), { force: true });
        }
    } catch { /* State recovery is limited to exact record-temp names. */ }
  }

  async cleanup(): Promise<void> {
    return this.withMutation((root) => this.cleanupNow(root), false).catch(() => undefined);
  }
  private async cleanupNow(root: string): Promise<void> {
    const active = await this.readOwnedRecord(root, "active.json");
    const rollback = await this.readOwnedRecord(root, "rollback.json");
    const retain = new Set([active?.digest, rollback?.digest].filter((value): value is string => Boolean(value)));
    for (const generation of this.leases.keys()) {
      const digest = this.generationDigests.get(generation);
      if (digest) retain.add(digest);
    }
    const base = join(root, "runtimes", "codex");
    try {
      await assertOwnedDescendant(root, base, true);
      for (const version of await readdir(base, { withFileTypes: true })) {
        if (!version.isDirectory() || !/^\d+\.\d+\.\d+$/.test(version.name)) continue;
        const versionPath = join(base, version.name);
        for (const platform of await readdir(versionPath, { withFileTypes: true })) {
          if (!platform.isDirectory() || !["darwin-arm64", "darwin-x64"].includes(platform.name)) continue;
          const platformPath = join(versionPath, platform.name);
          for (const digest of await readdir(platformPath, { withFileTypes: true })) {
            if (!digest.isDirectory() || !/^[a-f0-9]{64}$/.test(digest.name) || retain.has(digest.name)) continue;
            const candidate = join(platformPath, digest.name);
            await this.removeOwnedRelease(root, candidate, digest.name);
          }
        }
      }
    } catch { /* Cleanup is best-effort and never scans outside the owned tree. */ }
  }

  private async installOne(root: string, descriptor: CodexRuntimeReleaseDescriptor, options: ResolveManagedCodexRuntimeOptions): Promise<CodexRuntimeDetails> {
    const stagingParent = join(root, "staging");
    const staging = join(stagingParent, `nautilo-codex-${randomUUID()}`);
    const stagingNonce = staging.slice(staging.lastIndexOf("nautilo-codex-") + "nautilo-codex-".length);
    const archive = join(staging, `${descriptor.archiveName}.partial`);
    let received = 0;
    this.emit(options, "resolving", 0, descriptor.archiveBytes);
    if (options.signal?.aborted) return this.cancelled(options, descriptor);
    try {
      await mkdir(stagingParent, { recursive: true, mode: 0o700 });
      await assertOwnedDescendant(root, stagingParent, true);
      await mkdir(staging, { recursive: false, mode: 0o700 });
      await chmod(staging, 0o700);
      await writeFile(join(staging, ".nautilo-staging"), stagingNonce, { mode: 0o600, flag: "wx" });
      this.emit(options, "downloading", 0, descriptor.archiveBytes);
      const response = await this.host.fetch(descriptor.url, options.signal);
      if (
        response.status !== 200 ||
        !allowedDownloadUrl(response.url) ||
        response.contentLength !== descriptor.archiveBytes
      ) throw new Error("invalid_download_response");
      const output = await open(archive, "wx", 0o600);
      const hash = createHash("sha256");
      try {
        for await (const chunk of response.body) {
          if (options.signal?.aborted) throw new Error("cancelled");
          received += chunk.byteLength;
          if (received > descriptor.archiveBytes + MAX_ARCHIVE_OVERHEAD) throw new Error("download_overrun");
          hash.update(chunk);
          await writeAll(output, chunk);
          this.emit(options, "downloading", received, descriptor.archiveBytes);
        }
      } finally { await output.close(); }
      if (received !== descriptor.archiveBytes || !safeEqualHex(descriptor.sha256, hash.digest("hex")))
        throw new Error("archive_digest");
      this.emit(options, "verifying", received, descriptor.archiveBytes);
      const packageRoot = join(staging, "package");
      await mkdir(packageRoot, { mode: 0o700 });
      const members = await extractTarGz(archive, packageRoot, options.signal);
      if (options.signal?.aborted) return this.cancelled(options, descriptor);
      const entrypoint = await validatePackage(packageRoot, descriptor, members, options.signal);
      const entryDigest = await digestFile(entrypoint, options.signal);
      if (options.signal?.aborted) return this.cancelled(options, descriptor);
      if (!safeEqualHex(descriptor.entrypointSha256, entryDigest)) throw new Error("entrypoint_digest");
      if (!(await hasDarwinArchitecture(entrypoint, this.host.arch))) throw new Error("wrong_architecture");
      if (!(await this.host.verifyDarwinSignature(entrypoint, descriptor.signature)))
        return this.failed(options, descriptor, "CODEX_RUNTIME_SIGNATURE_INVALID", received);
      if (options.signal?.aborted) return this.cancelled(options, descriptor);
      await enableManagedExecutables(packageRoot, descriptor);
      if (!(await this.host.health(entrypoint, descriptor.version, options.signal)))
        return this.failed(options, descriptor, "CODEX_RUNTIME_UNHEALTHY", received);
      if (options.signal?.aborted) return this.cancelled(options, descriptor);
      this.emit(options, "staging", received, descriptor.archiveBytes);
      const finalRoot = join(root, "runtimes", "codex", descriptor.version, descriptor.platform, descriptor.sha256);
      if (!inside(root, finalRoot)) throw new Error("unsafe_release_path");
      await mkdir(dirname(finalRoot), { recursive: true, mode: 0o700 });
      await assertOwnedDescendant(root, dirname(finalRoot), true);
      await assertOwnedDescendant(root, packageRoot, true);
      if (!(await readExactRegularFile(join(staging, ".nautilo-staging"), stagingNonce))) throw new Error("unsafe_staging");
      await writeFile(join(packageRoot, ".nautilo-managed-release"), descriptor.sha256, { mode: 0o600, flag: "wx" });
      if (options.signal?.aborted) return this.cancelled(options, descriptor);
      await this.assertMutationLock(root);
      try { await rename(packageRoot, finalRoot); await fsyncDirectory(dirname(finalRoot)); } catch (error) {
        if (!(await this.hasOwnedRelease(root, finalRoot, descriptor.sha256)) || !(await this.isHealthyExisting(finalRoot, descriptor, options))) throw error;
      }
      // `packageRoot` belongs to staging and is removed in finally.  Every
      // admitted handle must instead point at the immutable published root,
      // including the verified-reuse path above.
      const admittedEntrypoint = await validatePackage(finalRoot, descriptor, undefined, options.signal);
      this.emit(options, "activating", received, descriptor.archiveBytes);
      if (options.signal?.aborted) return this.cancelled(options, descriptor);
      const previous = await this.readOwnedRecord(root, "active.json");
      this.generation = Math.max(this.generation, previous?.generation ?? 0, (await this.readOwnedRecord(root, "rollback.json"))?.generation ?? 0);
      const record: ActiveRecord = Object.freeze({ schemaVersion: 1, handle: this.host.randomHandle(), version: descriptor.version, platform: descriptor.platform, digest: descriptor.sha256, generation: ++this.generation });
      if (previous) await this.writeOwnedRecord(root, "rollback.json", previous);
      await this.writeOwnedRecord(root, "active.json", record);
      const details = this.ready("managed", descriptor, entryDigest, record.generation, record.handle);
      this.generationDigests.set(record.generation, record.digest);
      this.handles.set(details.handle!, { details, generation: record.generation, digest: record.digest, entrypoint: admittedEntrypoint, descriptor });
      this.emit(options, "ready", received, descriptor.archiveBytes);
      return details;
    } catch (error) {
      if (aborted(error, options.signal) || (error instanceof Error && error.message === "cancelled")) return this.cancelled(options, descriptor);
      const message = error instanceof Error ? error.message : "";
      const filesystem = Boolean(error && typeof error === "object" && "code" in error && ["EACCES", "EIO", "ENOSPC", "EPERM", "EROFS", "EEXIST", "ENOTEMPTY"].includes(String((error as { code?: unknown }).code)));
      const artifact = !filesystem && message !== "mutation_lock_lost";
      return this.failed(options, descriptor, artifact ? "CODEX_RUNTIME_ARTIFACT_INVALID" : "CODEX_RUNTIME_INSTALL_FAILED", received);
    } finally {
      // Staging is never active. Its own nonce marker authorizes this exact deletion.
      await this.removeOwnedStaging(root, staging, stagingNonce).catch(() => undefined);
    }
  }

  private ready(source: "managed", descriptor: CodexRuntimeReleaseDescriptor, entryDigest: string, _generation: number, handle = this.host.randomHandle()): CodexRuntimeDetails {
    return Object.freeze({ state: "ready", source, kind: "standalone", version: descriptor.version, checkedAt: this.host.now(), compatibility: "certified", executableFingerprint: `sha256:${entryDigest}`, features: { stableConversation: true, explicitSteer: true, codexApprovals: true, requestUserInput: true, collaborationMode: true }, handle });
  }
  private emit(options: ResolveManagedCodexRuntimeOptions, phase: CodexRuntimeInstallState["phase"], receivedBytes: number, totalBytes: number, code?: CodexRuntimeCode): void {
    const callback = options.onState;
    if (!callback) return;
    const state = Object.freeze({ phase, receivedBytes: Math.min(receivedBytes, totalBytes), totalBytes, canCancel: ["resolving", "downloading", "verifying", "staging"].includes(phase), ...(code ? { code } : {}) });
    const prior = this.progress.get(callback);
    if (prior?.phase === phase && state.receivedBytes < state.totalBytes && state.receivedBytes - prior.receivedBytes < 64 * 1024) return;
    this.progress.set(callback, state);
    try { callback(state); } catch { /* UI observers cannot affect verification. */ }
  }
  private cancelled(options: ResolveManagedCodexRuntimeOptions, descriptor: CodexRuntimeReleaseDescriptor): CodexRuntimeDetails {
    this.emit(options, "cancelled", 0, descriptor.archiveBytes, "CODEX_RUNTIME_CANCELLED");
    return fail("CODEX_RUNTIME_CANCELLED", this.host.now(), "managed", descriptor.version);
  }
  private failed(options: ResolveManagedCodexRuntimeOptions, descriptor: CodexRuntimeReleaseDescriptor, code: CodexRuntimeCode, receivedBytes = 0): CodexRuntimeDetails {
    this.emit(options, "failed", receivedBytes, descriptor.archiveBytes, code);
    return fail(code, this.host.now(), "managed", descriptor.version);
  }
  private async ownedRoot(create: boolean): Promise<string> {
    const lexical = resolve(this.host.runtimeRoot);
    let info: Awaited<ReturnType<typeof lstat>> | undefined;
    try { info = await lstat(lexical); } catch (error) { if (!missing(error)) throw error; }
    if (!info) {
      if (!create) throw new Error("missing_runtime_root");
      await mkdir(lexical, { recursive: true, mode: 0o700 });
      info = await lstat(lexical);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || (Number(info.mode) & 0o777) !== 0o700) throw new Error("unsafe_runtime_root");
    const root = await realpath(lexical);
    const marker = join(root, ROOT_MARKER_FILE);
    if (!(await readExactRegularFile(marker, ROOT_MARKER))) {
      // A fresh, empty root is safe to claim.  Any populated root without our
      // exact marker is foreign and must never be modified by this manager.
      const entries = await readdir(root);
      // Another manager may have claimed this empty root after our first
      // marker read but before this listing. Accept only that exact completed
      // claim; everything else remains foreign and fails closed.
      if (entries.length !== 0 && !(await readExactRegularFile(marker, ROOT_MARKER)))
        throw new Error("unowned_runtime_root");
      try { await writeFile(marker, ROOT_MARKER, { mode: 0o600, flag: "wx" }); }
      catch (error) {
        if (!missing(error) && !(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST")) throw error;
      }
      if (!(await readExactRegularFile(marker, ROOT_MARKER))) throw new Error("unowned_runtime_root");
    }
    return root;
  }

  private releasePath(root: string, version: string, platform: CodexRuntimePlatformKey, digest: string): string {
    return join(root, "runtimes", "codex", version, platform, digest);
  }

  private async hasOwnedRelease(root: string, release: string, digest: string): Promise<boolean> {
    try {
      await assertOwnedDescendant(root, release, true);
      return readExactRegularFile(join(release, ".nautilo-managed-release"), digest);
    } catch { return false; }
  }

  private async removeOwnedRelease(root: string, release: string, digest: string): Promise<void> {
    await this.assertMutationLock(root);
    if (!(await this.hasOwnedRelease(root, release, digest))) return;
    await this.assertMutationLock(root);
    await rm(release, { recursive: true, force: false });
  }

  private async removeOwnedStaging(root: string, staging: string, nonce: string): Promise<void> {
    await this.assertMutationLock(root);
    const expected = join(root, "staging", `nautilo-codex-${nonce}`);
    if (staging !== expected || !/^[0-9a-f-]{36}$/.test(nonce)) return;
    try {
      await assertOwnedDescendant(root, staging, true);
      if (!(await readExactRegularFile(join(staging, ".nautilo-staging"), nonce))) return;
      await this.assertMutationLock(root);
      await rm(staging, { recursive: true, force: false });
    } catch { /* A foreign or damaged staging directory is never removed. */ }
  }

  private async readOwnedRecord(root: string, name: "active.json" | "rollback.json"): Promise<ActiveRecord | null> {
    const file = join(root, "state", name);
    try { await assertOwnedDescendant(root, file); } catch { return null; }
    return this.readRecord(file);
  }

  /** Resolution distinguishes a genuinely absent active record from a damaged one. */
  private async readActiveRecordForResolution(root: string): Promise<ActiveRecord | "damaged" | null> {
    const file = join(root, "state", "active.json");
    try {
      await assertOwnedDescendant(root, file);
    } catch (error) {
      return missing(error) ? null : "damaged";
    }
    return await this.readRecord(file) ?? "damaged";
  }

  private async writeOwnedRecord(root: string, name: "active.json" | "rollback.json", record: ActiveRecord): Promise<void> {
    await this.assertMutationLock(root);
    const state = join(root, "state");
    await mkdir(state, { recursive: true, mode: 0o700 });
    await assertOwnedDescendant(root, state, true);
    await this.assertMutationLock(root);
    await this.writeRecord(root, join(state, name), record);
  }

  private async readRecord(file: string): Promise<ActiveRecord | null> {
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > 4 * 1024) return null;
      const value = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      return Object.keys(value).length === 6 && ["schemaVersion", "handle", "version", "platform", "digest", "generation"].every((key) => Object.hasOwn(value, key)) && value["schemaVersion"] === 1 && typeof value["handle"] === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value["handle"]) && typeof value["version"] === "string" && /^\d+\.\d+\.\d+$/.test(value["version"]) && (value["platform"] === "darwin-arm64" || value["platform"] === "darwin-x64") && typeof value["digest"] === "string" && /^[a-f0-9]{64}$/.test(value["digest"]) && Number.isSafeInteger(value["generation"]) && (value["generation"] as number) > 0 ? value as unknown as ActiveRecord : null;
    } catch { return null; }
  }
  private async writeRecord(root: string, file: string, record: ActiveRecord): Promise<void> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
      await fsyncFile(temp);
      await this.assertMutationLock(root);
      await rename(temp, file);
      await fsyncFile(file);
      await fsyncDirectory(dirname(file));
    } catch (error) {
      await this.assertMutationLock(root);
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  private async isHealthyExisting(path: string, descriptor: CodexRuntimeReleaseDescriptor, options: ResolveManagedCodexRuntimeOptions): Promise<boolean> {
    try {
      const entrypoint = await validatePackage(path, descriptor, undefined, options.signal);
      return safeEqualHex(descriptor.entrypointSha256, await digestFile(entrypoint, options.signal)) && await this.host.verifyDarwinSignature(entrypoint, descriptor.signature) && await this.host.health(entrypoint, descriptor.version, options.signal);
    } catch { return false; }
  }
  private async withMutation<T>(use: (root: string) => Promise<T>, create: boolean, signal?: AbortSignal): Promise<T> {
    const prior = this.mutationTail;
    let release: (() => void) | undefined;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    let root: string | undefined;
    let nonce: string | undefined;
    try {
      root = await this.ownedRoot(create);
      nonce = await this.acquireRootLock(root, signal);
      this.activeMutation = { root, nonce };
      return await use(root);
    } finally {
      this.activeMutation = undefined;
      if (root && nonce) await this.releaseRootLock(root, nonce);
      release?.();
    }
  }
  /** Re-checks the official lock immediately before a destructive/commit write. */
  private async assertMutationLock(root: string): Promise<void> {
    const active = this.activeMutation;
    if (!active || active.root !== root) throw new Error("mutation_lock_lost");
    const owner = await this.readLockOwner(root);
    if (!owner || owner.nonce !== active.nonce || owner.pid !== process.pid)
      throw new Error("mutation_lock_lost");
  }
  private async readLockOwner(root: string, lock = join(root, LOCK_DIRECTORY)): Promise<RuntimeLockOwner | null> {
    const ownerFile = join(lock, LOCK_OWNER_FILE);
    try {
      await assertOwnedDescendant(root, lock, true);
      const info = await lstat(ownerFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 512) return null;
      const value = JSON.parse(await readFile(ownerFile, "utf8")) as Record<string, unknown>;
      return Object.keys(value).length === 3 && value["schemaVersion"] === 1 && Number.isSafeInteger(value["pid"]) && (value["pid"] as number) > 0 && typeof value["nonce"] === "string" && /^[0-9a-f-]{36}$/.test(value["nonce"])
        ? value as unknown as RuntimeLockOwner
        : null;
    } catch { return null; }
  }
  private pidIsProvablyDead(pid: number): boolean {
    try { process.kill(pid, 0); return false; }
    catch (error) { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ESRCH"); }
  }
  private async waitForLock(signal: AbortSignal | undefined, milliseconds: number): Promise<void> {
    if (signal?.aborted) throw new Error("cancelled");
    await new Promise<void>((resolveWait, rejectWait) => {
      const timer = setTimeout(done, milliseconds);
      const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); rejectWait(new Error("cancelled")); };
      function done() { signal?.removeEventListener("abort", abort); resolveWait(); }
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  private async reclaimDeadLock(root: string, owner: RuntimeLockOwner): Promise<boolean> {
    const lock = join(root, LOCK_DIRECTORY);
    const quarantine = join(root, `${LOCK_DIRECTORY}.quarantine-${randomUUID()}`);
    try { await rename(lock, quarantine); }
    catch { return false; }
    const current = await this.readLockOwner(root, quarantine);
    if (current && current.nonce === owner.nonce && current.pid === owner.pid && this.pidIsProvablyDead(current.pid)) {
      await rm(quarantine, { recursive: true, force: false });
      return true;
    }
    // A replacement or live owner is never deleted.  Put it back only if no
    // contender acquired the official name while it was quarantined.
    try { await rename(quarantine, lock); } catch { /* Fail closed; leave quarantine intact. */ }
    return false;
  }
  private async acquireRootLock(root: string, signal?: AbortSignal): Promise<string> {
    const lock = join(root, LOCK_DIRECTORY);
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
      if (signal?.aborted) throw new Error("cancelled");
      const nonce = randomUUID();
      const candidate = join(root, `${LOCK_DIRECTORY}.candidate-${nonce}`);
      let candidateCreated = false;
      try {
        await mkdir(candidate, { mode: 0o700 });
        candidateCreated = true;
        await assertOwnedDescendant(root, candidate, true);
        const owner: RuntimeLockOwner = Object.freeze({ schemaVersion: 1, pid: process.pid, nonce });
        await writeFile(join(candidate, LOCK_OWNER_FILE), JSON.stringify(owner), { mode: 0o600, flag: "wx" });
        await rename(candidate, lock);
        return nonce;
      } catch (error) {
        // This generated name was created only by this attempt.  It is never
        // a shared lock, so an incomplete candidate cannot become permanent.
        if (candidateCreated) {
          const candidateOwner = await this.readLockOwner(root, candidate);
          if (candidateOwner?.nonce === nonce && candidateOwner.pid === process.pid)
            await rm(candidate, { recursive: true, force: false }).catch(() => undefined);
          else
            await rm(candidate, { recursive: false, force: false }).catch(() => undefined);
        }
        if (!alreadyExists(error)) throw error;
        const owner = await this.readLockOwner(root);
        if (owner && this.pidIsProvablyDead(owner.pid)) {
          await this.reclaimDeadLock(root, owner).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) throw new Error("runtime_lock_timeout");
        await this.waitForLock(signal, Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())));
      }
    }
  }
  private async releaseRootLock(root: string, nonce: string): Promise<void> {
    const owner = await this.readLockOwner(root);
    if (!owner || owner.nonce !== nonce || owner.pid !== process.pid) return;
    const lock = join(root, LOCK_DIRECTORY);
    await rm(lock, { recursive: true, force: false }).catch(() => undefined);
  }
  private descriptorFor(version: string, platform: CodexRuntimePlatformKey): CodexRuntimeReleaseDescriptor | null {
    return this.catalog.find((manifest) => manifest.cohort === "certified" && manifest.codexVersion === version)?.artifacts[platform] ?? null;
  }
  /** Supervisor-only internal registry; runtime details never contain this path. */
  internalLaunchTarget(handle: string): string | null {
    return this.handles.get(handle)?.entrypoint ?? null;
  }
}

/** Real Darwin adapters. The managed manager never invokes an external CLI. */
export function createNodeManagedRuntimeHost(runtimeRoot: string): ManagedRuntimeHost {
  return {
    platform: process.platform,
    arch: process.arch,
    runtimeRoot,
    async fetch(url, signal) {
      let target = url;
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        if (!allowedDownloadUrl(target)) throw new Error("unsafe_download_redirect");
        const response = await fetch(target, { redirect: "manual", ...(signal ? { signal } : {}) });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) throw new Error("missing_download_redirect");
          target = new URL(location, target).toString();
          continue;
        }
        if (!response.body || !allowedDownloadUrl(response.url)) throw new Error("empty_response");
        return { url: response.url, status: response.status, contentLength: Number(response.headers.get("content-length")) || null, body: response.body as unknown as AsyncIterable<Uint8Array> };
      }
      throw new Error("download_redirect_limit");
    },
    async verifyDarwinSignature(entrypoint, signature) {
      if (process.platform !== "darwin") return false;
      const verify = await runCommand("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", entrypoint]);
      const detail = await runCommand("/usr/bin/codesign", ["-d", "--verbose=4", entrypoint]);
      return verify.code === 0 && detail.code === 0 && detail.output.includes(`TeamIdentifier=${signature.teamId}`) && detail.output.includes(`Authority=${signature.publisherSubject}`) && /(?:Runtime Version=|flags=.*runtime)/i.test(detail.output);
    },
    async health(entrypoint, expectedVersion, signal) {
      if (signal?.aborted) return false;
      const root = await mkdtemp(join(tmpdir(), "nautilo-codex-health-"));
      const home = join(root, "home");
      const cwd = join(root, "cwd");
      try {
        await chmod(root, 0o700);
        await mkdir(home, { mode: 0o700 });
        await mkdir(cwd, { mode: 0o700 });
        const packageRoot = dirname(dirname(entrypoint));
        const env = { PATH: `${join(packageRoot, "codex-path")}:/usr/bin:/bin`, HOME: home, USERPROFILE: home, CODEX_HOME: home, TMPDIR: root, TMP: root, TEMP: root };
        const version = await runCommand(entrypoint, ["--version"], { cwd, env, ...(signal ? { signal } : {}) });
        if (version.code !== 0 || version.timedOut || version.outputLimited || !isManagedRuntimeVersionOutput(version.output, expectedVersion)) return false;
        return await initializeDirect(entrypoint, signal, cwd, env);
      } finally { await rm(root, { recursive: true, force: true }).catch(() => undefined); }
    },
    now: () => Date.now(),
    randomHandle: () => randomUUID().replaceAll("-", ""),
  };
}

/** The reviewed standalone artifact identifies its app-server entrypoint directly. */
export function isManagedRuntimeVersionOutput(output: string, expectedVersion: string): boolean {
  return output.trim() === `codex-app-server ${expectedVersion}`;
}

async function runCommand(command: string, argv: readonly string[], options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly signal?: AbortSignal } = {}): Promise<{ code: number | null; output: string; timedOut: boolean; outputLimited: boolean }> {
  const child = spawn(command, [...argv], { shell: false, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.env ? { env: options.env } : {}) });
  const output: Buffer[] = [];
  let bytes = 0;
  let timedOut = false;
  let outputLimited = false;
  const terminate = () => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { child.kill("SIGKILL"); } };
  const timer = setTimeout(() => { timedOut = true; terminate(); }, HEALTH_TIMEOUT_MS);
  const abort = () => terminate();
  options.signal?.addEventListener("abort", abort, { once: true });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => { if ((bytes += chunk.length) <= MAX_PROCESS_OUTPUT) output.push(Buffer.from(chunk)); else { outputLimited = true; terminate(); } });
  return new Promise((resolveResult) => {
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolveResult({ code, output: Buffer.concat(output).toString("utf8"), timedOut, outputLimited });
    };
    child.once("close", finish);
    child.once("error", () => finish(null));
  });
}

async function initializeDirect(entrypoint: string, signal: AbortSignal | undefined, cwd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const child = spawn(entrypoint, ["--listen", "stdio://"], { shell: false, stdio: ["pipe", "pipe", "pipe"], cwd, env, detached: process.platform !== "win32" });
  const stdout = new PassThrough();
  let outputBytes = 0;
  let outputLimited = false;
  const terminateTree = (signalName: NodeJS.Signals) => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signalName); else child.kill(signalName); } catch { child.kill(signalName); } };
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => { if ((outputBytes += chunk.byteLength) > MAX_PROCESS_OUTPUT) { outputLimited = true; terminateTree("SIGKILL"); } });
  child.stdout.pipe(stdout);
  const runtimeProcess: RuntimeProcess = { stdout, stdin: child.stdin, result: new Promise((resolveResult) => { child.once("close", (code) => resolveResult({ code, timedOut: false, outputLimited, stdout: new Uint8Array(), stderr: new Uint8Array() })); child.once("error", () => resolveResult({ code: null, timedOut: false, outputLimited, stdout: new Uint8Array(), stderr: new Uint8Array() })); }), terminate() { terminateTree("SIGTERM"); return Promise.resolve(); } };
  try {
    const client = new CodexRpcClient({ readable: runtimeProcess.stdout, writable: runtimeProcess.stdin, decoder: rpcRuntimeDecoder });
    await client.initialize({ clientName: "nautilo", clientTitle: "Nautilo", clientVersion: "1", experimentalApi: false }, signal ? { timeoutMs: HEALTH_TIMEOUT_MS, signal } : { timeoutMs: HEALTH_TIMEOUT_MS });
    await client.close();
    return true;
  } catch { return false; } finally {
    await runtimeProcess.terminate(100).catch(() => undefined);
    await Promise.race([runtimeProcess.result, new Promise((resolveResult) => setTimeout(resolveResult, 100))]);
    terminateTree("SIGKILL");
    await runtimeProcess.result.catch(() => undefined);
  }
}
