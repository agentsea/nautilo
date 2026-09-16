import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createGunzip } from "node:zlib";
import type {
  ResolveSecurityScannerOptions,
  SecurityScannerArtifact,
  SecurityScannerComponentKind,
  SecurityScannerInstallState,
  SecurityScannerInstallation,
  SecurityScannerManifest,
  SecurityScannerRuntimeCode,
  SecurityScannerRuntimeHost,
} from "./contracts.ts";
import { platformForSecurityScanner, validateSecurityScannerManifest } from "./manifest.ts";

const ROOT_MARKER_FILE = ".nautilo-security-scanner-root";
const ROOT_MARKER = "nautilo-security-scanner-root-v1\n";
const RELEASE_MARKER = ".nautilo-security-scanner-release";
const MAX_ARCHIVE_OVERHEAD = 64 * 1024;
const MAX_ARCHIVE_ENTRIES = 4_096;
const MAX_MEMBER_BYTES = 256 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 768 * 1024 * 1024;
const MAX_PATH_BYTES = 1_024;

interface ActiveRecord {
  readonly schemaVersion: 1;
  readonly component: string;
  readonly kind: SecurityScannerComponentKind;
  readonly version: string;
  readonly platform: string;
  readonly digest: string;
  readonly generation: number;
}

const missing = (error: unknown): boolean => Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
const safeEqualHex = (left: string, right: string): boolean => {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};
const inside = (root: string, candidate: string): boolean => {
  const absolute = resolve(candidate);
  return absolute === root || absolute.startsWith(`${root}${sep}`);
};
const safePart = (value: string): boolean => /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value) && !value.includes("..");
const aborted = (signal?: AbortSignal): boolean => Boolean(signal?.aborted);
const allZero = (bytes: Uint8Array): boolean => bytes.every((byte) => byte === 0);

async function readExactRegularFile(path: string, expected: string, maxBytes = 4 * 1024): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() && info.size <= maxBytes && (await readFile(path, "utf8")) === expected;
  } catch { return false; }
}

async function digestFile(path: string, signal?: AbortSignal): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 }) as AsyncIterable<Uint8Array>) {
    if (aborted(signal)) throw new Error("cancelled");
    digest.update(chunk);
  }
  return digest.digest("hex");
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await file.write(bytes, offset, bytes.byteLength - offset);
    if (result.bytesWritten <= 0) throw new Error("short_write");
    offset += result.bytesWritten;
  }
}

function tarString(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0);
  return new TextDecoder().decode(bytes.slice(0, nul < 0 ? bytes.length : nul));
}
function tarSize(bytes: Uint8Array): number | null {
  const raw = tarString(bytes).trim();
  return /^[0-7]*$/.test(raw) ? Number.parseInt(raw || "0", 8) : null;
}
function safeTarPath(value: string, directory = false): boolean {
  const normalized = directory ? value.replace(/\/$/, "") : value;
  return Boolean(normalized) && Buffer.byteLength(value, "utf8") <= MAX_PATH_BYTES && !value.includes("\0") && !value.startsWith("/") && !normalized.split("/").some((part) => !part || part === "." || part === "..");
}

/** Strict small tar reader: no links, devices, global headers, PAX, or duplicate paths. */
async function extractTarGz(archive: string, destination: string, signal?: AbortSignal): Promise<ReadonlySet<string>> {
  let pending = new Uint8Array();
  let member: { remaining: number; padding: number; file?: Awaited<ReturnType<typeof open>> } | undefined;
  let entries = 0;
  let expanded = 0;
  let complete = false;
  let zeroBlocks = 0;
  const paths = new Set<string>();
  const folded = new Set<string>();
  const input = createReadStream(archive, { highWaterMark: 64 * 1024 }).pipe(createGunzip());
  try {
    for await (const chunk of input as AsyncIterable<Uint8Array>) {
      if (aborted(signal)) throw new Error("cancelled");
      if (complete && chunk.byteLength > 0) {
        if (!allZero(chunk)) throw new Error("invalid_tar_trailer");
        continue;
      }
      const combined = new Uint8Array(pending.byteLength + chunk.byteLength);
      combined.set(pending); combined.set(chunk, pending.byteLength); pending = combined;
      if (expanded + pending.byteLength > MAX_EXPANDED_BYTES + MAX_MEMBER_BYTES) throw new Error("archive_limit");
      while (pending.byteLength > 0) {
        if (member) {
          if (member.remaining > 0) {
            const take = Math.min(member.remaining, pending.byteLength);
            if (member.file) await writeAll(member.file, pending.slice(0, take));
            member.remaining -= take; pending = pending.slice(take);
            if (member.remaining > 0) continue;
            await member.file?.close();
          }
          const take = Math.min(member.padding, pending.byteLength);
          member.padding -= take; pending = pending.slice(take);
          if (member.padding > 0) continue;
          member = undefined;
          continue;
        }
        if (pending.byteLength < 512) break;
        const header = pending.slice(0, 512); pending = pending.slice(512);
        if (header.every((byte) => byte === 0)) {
          zeroBlocks += 1;
          if (zeroBlocks === 2) {
            if (pending.byteLength !== 0 && !allZero(pending)) throw new Error("invalid_tar_trailer");
            pending = new Uint8Array();
            complete = true;
            break;
          }
          continue;
        }
        if (zeroBlocks) throw new Error("invalid_tar_trailer");
        const name = `${tarString(header.slice(345, 500)) ? `${tarString(header.slice(345, 500))}/` : ""}${tarString(header.slice(0, 100))}`;
        const type = header[156] || 0;
        const size = tarSize(header.slice(124, 136));
        const checksum = tarSize(header.slice(148, 156));
        const calculated = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
        const isDirectory = type === 53;
        if (checksum !== calculated || size === null || size > MAX_MEMBER_BYTES || ![0, 48, 53].includes(type) || !safeTarPath(name, isDirectory)) throw new Error("unsafe_archive");
        if (++entries > MAX_ARCHIVE_ENTRIES || (expanded += size) > MAX_EXPANDED_BYTES) throw new Error("archive_limit");
        const normalized = isDirectory ? name.replace(/\/$/, "") : name;
        if (paths.has(normalized) || folded.has(normalized.toLowerCase())) throw new Error("duplicate_archive_member");
        paths.add(normalized); folded.add(normalized.toLowerCase());
        const target = join(destination, normalized);
        if (!inside(destination, target)) throw new Error("unsafe_archive");
        if (isDirectory) {
          if (size !== 0) throw new Error("unsafe_archive");
          await mkdir(target, { recursive: false, mode: 0o700 });
          continue;
        }
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const output = await open(target, "wx", 0o600);
        if (size === 0) await output.close(); else member = { remaining: size, padding: Math.ceil(size / 512) * 512 - size, file: output };
      }
    }
    if (member || pending.byteLength !== 0 || !complete) throw new Error("truncated_archive");
    return paths;
  } finally { await member?.file?.close().catch(() => undefined); }
}

export class SecurityScannerRuntimeManager {
  private readonly manifest: SecurityScannerManifest;
  private readonly singleflight = new Map<string, Promise<SecurityScannerInstallation>>();
  private mutationTail: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(private readonly host: SecurityScannerRuntimeHost, manifest: SecurityScannerManifest) {
    const verified = validateSecurityScannerManifest(manifest);
    if (!verified) throw new Error("invalid_security_scanner_manifest");
    this.manifest = verified;
  }

  async install(component: string, kind: SecurityScannerComponentKind, options: ResolveSecurityScannerOptions = {}): Promise<SecurityScannerInstallation> {
    const platform = platformForSecurityScanner(this.host.platform, this.host.arch);
    const candidates = platform
      ? this.manifest.artifacts.filter((artifact) => artifact.component === component && artifact.kind === kind && artifact.platform === platform && (options.version === undefined || artifact.version === options.version))
      : [];
    // Omitted version is permitted only when the release manifest has one
    // unambiguous reviewed identity.  It must never mean "download latest".
    const descriptor = options.version === undefined && candidates.length !== 1 ? undefined : candidates[0];
    if (!platform || !descriptor) return this.unavailable(component, kind, !platform ? "SECURITY_SCANNER_PLATFORM_UNSUPPORTED" : "SECURITY_SCANNER_NOT_FOUND", options.version);
    const key = `${descriptor.component}:${descriptor.kind}:${descriptor.version}:${descriptor.platform}:${descriptor.sha256}`;
    const present = this.singleflight.get(key);
    if (present) return present;
    const pending = this.withMutation(() => this.installOne(descriptor, options))
      .catch(() => this.unavailable(component, kind, aborted(options.signal) ? "SECURITY_SCANNER_CANCELLED" : "SECURITY_SCANNER_INSTALL_FAILED", descriptor.version))
      .finally(() => this.singleflight.delete(key));
    this.singleflight.set(key, pending);
    return pending;
  }

  /** Resolve strictly from the active record.  This never contacts the network. */
  async resolveActive(component: string, kind: SecurityScannerComponentKind, options: ResolveSecurityScannerOptions = {}): Promise<SecurityScannerInstallation> {
    if (aborted(options.signal)) return this.unavailable(component, kind, "SECURITY_SCANNER_CANCELLED", options.version);
    try {
      const root = await this.ownedRoot(false);
      const active = await this.readActive(root, component, kind);
      if (!active) return this.unavailable(component, kind, "SECURITY_SCANNER_NOT_FOUND", options.version);
      const descriptor = this.manifest.artifacts.find((artifact) => artifact.component === component && artifact.kind === kind && artifact.version === active.version && artifact.platform === active.platform && artifact.sha256 === active.digest);
      if (!descriptor) return this.unavailable(component, kind, "SECURITY_SCANNER_ARTIFACT_INVALID", active.version);
      const release = this.releasePath(root, descriptor);
      const internalPath = await this.validateRelease(root, release, descriptor, options.signal);
      if (internalPath === null) return this.unavailable(component, kind, "SECURITY_SCANNER_ARTIFACT_INVALID", descriptor.version);
      if (descriptor.kind === "engine" && !(await this.host.health(internalPath, descriptor.version, options.signal))) return this.unavailable(component, kind, "SECURITY_SCANNER_UNHEALTHY", descriptor.version);
      return this.ready(descriptor, active.generation, internalPath);
    } catch { return this.unavailable(component, kind, "SECURITY_SCANNER_INSTALL_FAILED", options.version); }
  }

  private async installOne(descriptor: SecurityScannerArtifact, options: ResolveSecurityScannerOptions): Promise<SecurityScannerInstallation> {
    const root = await this.ownedRoot(true);
    const release = this.releasePath(root, descriptor);
    const reusable = await this.validateRelease(root, release, descriptor, options.signal);
    if (reusable !== null && (descriptor.kind === "rules" || await this.host.health(reusable, descriptor.version, options.signal))) {
      return this.activate(root, descriptor, reusable, options);
    }
    const staging = join(root, "staging", `scanner-${randomUUID()}`);
    const nonce = staging.slice(staging.lastIndexOf("scanner-") + "scanner-".length);
    const archive = join(staging, "artifact.partial");
    let received = 0;
    try {
      this.emit(options, "resolving", 0, descriptor.archiveBytes);
      if (aborted(options.signal)) throw new Error("cancelled");
      await mkdir(dirname(staging), { recursive: true, mode: 0o700 });
      await this.assertOwnedDescendant(root, dirname(staging), true);
      await mkdir(staging, { recursive: false, mode: 0o700 });
      await writeFile(join(staging, ".staging"), nonce, { flag: "wx", mode: 0o600 });
      this.emit(options, "downloading", 0, descriptor.archiveBytes);
      const response = await this.host.fetch(descriptor.url, options.signal);
      if (!this.allowedResponse(response.url) || response.status !== 200 || response.contentLength !== descriptor.archiveBytes) throw new Error("invalid_download_response");
      const output = await open(archive, "wx", 0o600);
      const hash = createHash("sha256");
      try {
        for await (const bytes of response.body) {
          if (aborted(options.signal)) throw new Error("cancelled");
          received += bytes.byteLength;
          if (received > descriptor.archiveBytes + MAX_ARCHIVE_OVERHEAD) throw new Error("download_overrun");
          hash.update(bytes); await writeAll(output, bytes);
          this.emit(options, "downloading", received, descriptor.archiveBytes);
        }
      } finally { await output.close(); }
      if (received !== descriptor.archiveBytes || !safeEqualHex(descriptor.sha256, hash.digest("hex"))) throw new Error("archive_digest");
      this.emit(options, "verifying", received, descriptor.archiveBytes);
      const payload = join(staging, "payload");
      await mkdir(payload, { mode: 0o700 });
      if (descriptor.format === "binary") {
        if (descriptor.kind !== "engine" || !descriptor.entrypoint) throw new Error("binary_rules_forbidden");
        const entrypoint = join(payload, descriptor.entrypoint);
        if (!inside(payload, entrypoint)) throw new Error("unsafe_entrypoint");
        await mkdir(dirname(entrypoint), { recursive: true, mode: 0o700 });
        await rename(archive, entrypoint);
      } else {
        await extractTarGz(archive, payload, options.signal);
      }
      const entrypoint = await this.validatePayload(payload, descriptor, options.signal);
      if (descriptor.kind === "engine") {
        if (!entrypoint) throw new Error("engine_missing_entrypoint");
        await chmod(entrypoint, 0o700);
        if (!(await this.host.health(entrypoint, descriptor.version, options.signal))) {
          this.emit(options, "failed", received, descriptor.archiveBytes, "SECURITY_SCANNER_UNHEALTHY");
          return this.unavailable(descriptor.component, descriptor.kind, "SECURITY_SCANNER_UNHEALTHY", descriptor.version);
        }
      }
      if (aborted(options.signal)) throw new Error("cancelled");
      this.emit(options, "staging", received, descriptor.archiveBytes);
      await mkdir(dirname(release), { recursive: true, mode: 0o700 });
      await this.assertOwnedDescendant(root, dirname(release), true);
      await writeFile(join(payload, RELEASE_MARKER), descriptor.sha256, { flag: "wx", mode: 0o600 });
      await rename(payload, release);
      const admitted = await this.validateRelease(root, release, descriptor, options.signal);
      if (admitted === null) throw new Error("released_payload_invalid");
      return this.activate(root, descriptor, admitted, options, received);
    } catch (error) {
      const code: SecurityScannerRuntimeCode = aborted(options.signal) || (error instanceof Error && error.message === "cancelled") ? "SECURITY_SCANNER_CANCELLED" : error instanceof Error && /archive|tar|trailer|download|entrypoint|payload|unsafe/.test(error.message) ? "SECURITY_SCANNER_ARTIFACT_INVALID" : "SECURITY_SCANNER_INSTALL_FAILED";
      this.emit(options, code === "SECURITY_SCANNER_CANCELLED" ? "cancelled" : "failed", received, descriptor.archiveBytes, code);
      return this.unavailable(descriptor.component, descriptor.kind, code, descriptor.version);
    } finally {
      // This deletion is bounded to the exact, nonce-owned staging directory.
      if (/^[0-9a-f-]{36}$/.test(nonce) && await readExactRegularFile(join(staging, ".staging"), nonce)) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async activate(root: string, descriptor: SecurityScannerArtifact, internalPath: string | null, options: ResolveSecurityScannerOptions, received = 0): Promise<SecurityScannerInstallation> {
    if (aborted(options.signal)) return this.unavailable(descriptor.component, descriptor.kind, "SECURITY_SCANNER_CANCELLED", descriptor.version);
    this.emit(options, "activating", received, descriptor.archiveBytes);
    const previous = await this.readActive(root, descriptor.component, descriptor.kind);
    this.generation = Math.max(this.generation, previous?.generation ?? 0);
    const record: ActiveRecord = Object.freeze({ schemaVersion: 1, component: descriptor.component, kind: descriptor.kind, version: descriptor.version, platform: descriptor.platform, digest: descriptor.sha256, generation: ++this.generation });
    await this.writeActive(root, record);
    this.emit(options, "ready", descriptor.archiveBytes, descriptor.archiveBytes);
    return this.ready(descriptor, record.generation, internalPath);
  }

  private ready(descriptor: SecurityScannerArtifact, generation: number, internalPath: string | null): SecurityScannerInstallation {
    return Object.freeze({ details: Object.freeze({ state: "ready", component: descriptor.component, kind: descriptor.kind, version: descriptor.version, platform: descriptor.platform, fingerprint: `sha256:${descriptor.sha256}`, generation, checkedAt: this.host.now() }), internalPath });
  }
  private unavailable(component: string, kind: SecurityScannerComponentKind, code: SecurityScannerRuntimeCode, version?: string): SecurityScannerInstallation {
    return Object.freeze({ details: Object.freeze({ state: "unavailable", component, kind, code, ...(version ? { version } : {}), checkedAt: this.host.now() }), internalPath: null });
  }
  private emit(options: ResolveSecurityScannerOptions, phase: SecurityScannerInstallState["phase"], receivedBytes: number, totalBytes: number, code?: SecurityScannerRuntimeCode): void {
    try { options.onState?.(Object.freeze({ phase, receivedBytes: Math.min(receivedBytes, totalBytes), totalBytes, canCancel: ["resolving", "downloading", "verifying", "staging"].includes(phase), ...(code ? { code } : {}) })); } catch { /* observer isolation */ }
  }
  private allowedResponse(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && this.manifest.allowedDownloadHosts.includes(parsed.hostname) && this.manifest.allowedDownloadPrefixes[parsed.hostname]?.some((prefix) => parsed.pathname.startsWith(prefix)) === true;
    } catch { return false; }
  }
  private async withMutation<T>(work: () => Promise<T>): Promise<T> {
    const prior = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolveMutation) => { release = resolveMutation; });
    await prior;
    try { return await work(); } finally { release(); }
  }
  private async ownedRoot(create: boolean): Promise<string> {
    const lexical = resolve(this.host.runtimeRoot);
    let info: Awaited<ReturnType<typeof lstat>> | undefined;
    try { info = await lstat(lexical); } catch (error) { if (!missing(error)) throw error; }
    if (!info) {
      if (!create) throw new Error("missing_root");
      await mkdir(lexical, { recursive: true, mode: 0o700 }); info = await lstat(lexical);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || (Number(info.mode) & 0o777) !== 0o700) throw new Error("unsafe_root");
    const root = await realpath(lexical);
    const marker = join(root, ROOT_MARKER_FILE);
    if (!(await readExactRegularFile(marker, ROOT_MARKER))) {
      if ((await readdir(root)).length !== 0) throw new Error("foreign_root");
      await writeFile(marker, ROOT_MARKER, { flag: "wx", mode: 0o600 });
    }
    if (!(await readExactRegularFile(marker, ROOT_MARKER))) throw new Error("foreign_root");
    return root;
  }
  private async assertOwnedDescendant(root: string, candidate: string, directory = false): Promise<void> {
    if (!inside(root, candidate)) throw new Error("unsafe_managed_path");
    let current = root;
    for (const part of relative(root, candidate).split(sep).filter(Boolean)) {
      if (!safePart(part)) throw new Error("unsafe_managed_path");
      current = join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink() || (current !== candidate && !info.isDirectory()) || (current === candidate && directory && !info.isDirectory())) throw new Error("unsafe_managed_path");
    }
  }
  private releasePath(root: string, descriptor: SecurityScannerArtifact): string {
    return join(root, "releases", descriptor.component, descriptor.kind, descriptor.version, descriptor.platform, descriptor.sha256);
  }
  private activePath(root: string, component: string, kind: SecurityScannerComponentKind): string {
    return join(root, "active", `${component}-${kind}.json`);
  }
  private async validatePayload(payload: string, descriptor: SecurityScannerArtifact, signal?: AbortSignal): Promise<string> {
    if ((await lstat(payload)).isSymbolicLink()) throw new Error("unsafe_payload");
    const expected = descriptor.kind === "engine" ? descriptor.entrypoint : undefined;
    const entrypoint = expected ? join(payload, expected) : null;
    if (expected && (!entrypoint || !inside(payload, entrypoint))) throw new Error("unsafe_entrypoint");
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (aborted(signal)) throw new Error("cancelled");
        const path = join(directory, entry.name);
        const info = await lstat(path);
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error("unsafe_payload");
        if (info.isDirectory()) await walk(path);
      }
    };
    await walk(payload);
    if (descriptor.kind === "rules") return payload;
    if (!entrypoint || !descriptor.entrypointSha256) throw new Error("engine_missing_entrypoint");
    const info = await lstat(entrypoint);
    if (!info.isFile() || info.isSymbolicLink() || !safeEqualHex(descriptor.entrypointSha256, await digestFile(entrypoint, signal))) throw new Error("invalid_entrypoint");
    return entrypoint;
  }
  private async validateRelease(root: string, release: string, descriptor: SecurityScannerArtifact, signal?: AbortSignal): Promise<string | null> {
    try {
      await this.assertOwnedDescendant(root, release, true);
      if (!(await readExactRegularFile(join(release, RELEASE_MARKER), descriptor.sha256))) return null;
      return this.validatePayload(release, descriptor, signal);
    } catch { return null; }
  }
  private async readActive(root: string, component: string, kind: SecurityScannerComponentKind): Promise<ActiveRecord | null> {
    try {
      const path = this.activePath(root, component, kind);
      await this.assertOwnedDescendant(root, path);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4_096) return null;
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length !== 7 || record["schemaVersion"] !== 1 || record["component"] !== component || record["kind"] !== kind || typeof record["version"] !== "string" || typeof record["platform"] !== "string" || typeof record["digest"] !== "string" || !/^[a-f0-9]{64}$/.test(record["digest"]) || !Number.isSafeInteger(record["generation"]) || Number(record["generation"]) < 1) return null;
      return record as unknown as ActiveRecord;
    } catch { return null; }
  }
  private async writeActive(root: string, record: ActiveRecord): Promise<void> {
    const destination = this.activePath(root, record.component, record.kind);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await this.assertOwnedDescendant(root, dirname(destination), true);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  }
}

const HEALTH_TIMEOUT_MS = 10_000;
const HEALTH_OUTPUT_BYTES = 4 * 1024;

async function scannerVersionOutput(entrypoint: string, signal?: AbortSignal): Promise<string | null> {
  const name = entrypoint.slice(entrypoint.lastIndexOf("/") + 1);
  const argv = name === "gitleaks" ? ["version"] : name === "semgrep-core" ? ["-version"] : ["--version"];
  return await new Promise((resolveOutput) => {
    if (signal?.aborted) { resolveOutput(null); return; }
    const child = spawn(entrypoint, argv, {
      cwd: dirname(entrypoint),
      detached: process.platform !== "win32",
      env: { PATH: "/usr/bin:/bin", HOME: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let limited = false;
    const terminate = () => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { child.kill("SIGKILL"); }
    };
    const collect = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > HEALTH_OUTPUT_BYTES) { limited = true; terminate(); return; }
      chunks.push(chunk);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(terminate, HEALTH_TIMEOUT_MS);
    timer.unref?.();
    const abort = () => terminate();
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolveOutput(null); });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolveOutput(code === 0 && !limited && !signal?.aborted ? Buffer.concat(chunks).toString("utf8") : null);
    });
  });
}

/** Real Electron-main host. The manifest remains the only artifact authority. */
export function createNodeSecurityScannerRuntimeHost(runtimeRoot: string): SecurityScannerRuntimeHost {
  return {
    platform: process.platform,
    arch: process.arch,
    runtimeRoot,
    async fetch(url, signal) {
      const response = await fetch(url, { redirect: "error", ...(signal ? { signal } : {}) });
      if (!response.body) throw new Error("empty_security_scanner_response");
      const contentLength = response.headers.get("content-length");
      return {
        url: response.url,
        status: response.status,
        contentLength: contentLength === null ? null : Number(contentLength),
        body: response.body as unknown as AsyncIterable<Uint8Array>,
      };
    },
    async health(entrypoint, expectedVersion, signal) {
      const output = await scannerVersionOutput(entrypoint, signal);
      if (output === null || /\p{Cc}/u.test(output.replace(/[\r\n\t]/g, ""))) return false;
      const escaped = expectedVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:^|[^0-9A-Za-z])${escaped}(?:$|[^0-9A-Za-z])`).test(output);
    },
    now: () => Date.now(),
  };
}
