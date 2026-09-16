import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createGunzip } from "node:zlib";
import type {
  ComputerUseHostMember,
  ComputerUseHostRecord,
  ComputerUseHostRelease,
  ComputerUseHostStagedArtifact,
  ComputerUseHostStorage,
} from "./contracts.ts";
import { parseComputerUseHostRelease } from "./official-release-authority.ts";

const ROOT_MARKER_NAME = ".nautilo-computer-use-host-root";
const ROOT_MARKER = "nautilo-computer-use-host-root-v1\n";
const STAGING_MARKER = ".nautilo-computer-use-host-staging";
const RELEASE_MARKER = ".nautilo-computer-use-host-release";
const RELEASE_MANIFEST = "release.json";
const MAX_PATH_BYTES = 1024;
const MAX_ARCHIVE_ENTRIES = 4096;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const MAX_MEMBER_BYTES = 512 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9-]{36}$/u;

type FetchLike = (input: string, init: Readonly<{ redirect: "error"; signal?: AbortSignal }>) => Promise<Response>;
type FileHandle = Awaited<ReturnType<typeof open>>;

function contained(root: string, candidate: string): boolean {
  const result = relative(root, resolve(candidate));
  return result !== "" && !result.startsWith(`..${sep}`) && result !== "..";
}
function safePath(value: string, directory = false): boolean {
  const normalized = directory ? value.replace(/\/$/u, "") : value;
  return normalized.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_PATH_BYTES && !value.includes("\0")
    && !value.startsWith("/") && !normalized.split("/").some((part) => part === "" || part === "." || part === "..");
}
function sameDigest(left: string, right: string): boolean {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
async function digestFile(path: string, signal?: AbortSignal): Promise<string> {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(path, { highWaterMark: 64 * 1024 }) as AsyncIterable<Uint8Array>) {
    if (signal?.aborted) throw new Error("cancelled"); digest.update(bytes);
  }
  return digest.digest("hex");
}
async function exactTextFile(path: string, expected: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() && info.size === Buffer.byteLength(expected) && await readFile(path, "utf8") === expected;
  } catch { return false; }
}
async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await file.write(bytes, offset, bytes.byteLength - offset);
    if (result.bytesWritten <= 0) throw new Error("short write"); offset += result.bytesWritten;
  }
}
function tarString(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0); return new TextDecoder().decode(bytes.slice(0, nul < 0 ? bytes.length : nul));
}
function tarNumber(bytes: Uint8Array): number | null {
  const value = tarString(bytes).trim(); return /^[0-7]*$/u.test(value) ? Number.parseInt(value || "0", 8) : null;
}

/** Closed tar.gz reader: regular files/directories only; no PAX, GNU links, devices, or duplicate/folded paths. */
async function extractTarGz(archive: string, destination: string, expected: ReadonlyMap<string, ComputerUseHostMember>, signal?: AbortSignal): Promise<void> {
  let pending = new Uint8Array(); let current: { remaining: number; padding: number; file: FileHandle; member: ComputerUseHostMember } | null = null;
  let entries = 0; let expanded = 0; let zeros = 0; let complete = false;
  const seen = new Set<string>(); const folded = new Set<string>();
  const input = createReadStream(archive, { highWaterMark: 64 * 1024 }).pipe(createGunzip());
  try {
    for await (const chunk of input as AsyncIterable<Uint8Array>) {
      if (signal?.aborted) throw new Error("cancelled");
      const combined = new Uint8Array(pending.byteLength + chunk.byteLength); combined.set(pending); combined.set(chunk, pending.byteLength); pending = combined;
      while (pending.byteLength > 0) {
        if (current !== null) {
          if (current.remaining > 0) {
            const take = Math.min(current.remaining, pending.byteLength); await writeAll(current.file, pending.slice(0, take));
            current.remaining -= take; pending = pending.slice(take); if (current.remaining > 0) continue; await current.file.close();
          }
          const take = Math.min(current.padding, pending.byteLength); current.padding -= take; pending = pending.slice(take);
          if (current.padding > 0) continue; current = null; continue;
        }
        if (pending.byteLength < 512) break;
        const header = pending.slice(0, 512); pending = pending.slice(512);
        if (header.every((byte) => byte === 0)) { zeros += 1; if (zeros === 2) { complete = true; if (!pending.every((byte) => byte === 0)) throw new Error("tar trailer"); pending = new Uint8Array(); } continue; }
        if (zeros !== 0 || complete) throw new Error("tar trailer");
        const prefix = tarString(header.slice(345, 500)); const name = `${prefix ? `${prefix}/` : ""}${tarString(header.slice(0, 100))}`;
        const type = header[156] ?? 0; const size = tarNumber(header.slice(124, 136)); const checksum = tarNumber(header.slice(148, 156));
        const calculated = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
        const directory = type === 53;
        if (size === null || checksum !== calculated || ![0, 48, 53].includes(type) || !safePath(name, directory)
          || size > MAX_MEMBER_BYTES || ++entries > MAX_ARCHIVE_ENTRIES || (expanded += size) > MAX_EXPANDED_BYTES) throw new Error("unsafe archive");
        const normalized = directory ? name.replace(/\/$/u, "") : name;
        if (seen.has(normalized) || folded.has(normalized.toLowerCase())) throw new Error("duplicate archive path");
        seen.add(normalized); folded.add(normalized.toLowerCase());
        const target = join(destination, normalized); if (!contained(destination, target)) throw new Error("archive escape");
        if (directory) { if (size !== 0) throw new Error("directory payload"); await mkdir(target, { recursive: true, mode: 0o700 }); continue; }
        const member = expected.get(normalized); if (member === undefined || member.bytes !== size) throw new Error("unexpected archive member");
        await mkdir(dirname(target), { recursive: true, mode: 0o700 }); const file = await open(target, "wx", 0o600);
        if (size === 0) { await file.close(); current = null; } else current = { remaining: size, padding: Math.ceil(size / 512) * 512 - size, file, member };
      }
    }
    if (current !== null || pending.byteLength !== 0 || !complete || [...expected.keys()].some((path) => !seen.has(path))) throw new Error("truncated archive");
  } finally { await current?.file.close().catch(() => undefined); }
}

function parseRecord(value: unknown): ComputerUseHostRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>; const keys = Object.keys(item).sort();
  if (keys.join(",") !== "archiveSha256,generation,releaseId,releaseSha256,schemaVersion,source,version" || item["schemaVersion"] !== 1
    || !Number.isSafeInteger(item["generation"]) || Number(item["generation"]) <= 0
    || (item["source"] !== "bundled" && item["source"] !== "managed") || typeof item["releaseId"] !== "string"
    || typeof item["version"] !== "string" || typeof item["archiveSha256"] !== "string" || !SHA256.test(item["archiveSha256"])
    || typeof item["releaseSha256"] !== "string" || !SHA256.test(item["releaseSha256"])) return null;
  return item as unknown as ComputerUseHostRecord;
}

export interface NodeComputerUseHostStorageOptions {
  readonly runtimeRoot: string;
  readonly bundledDirectory: string;
  readonly officialPointerUrl: string;
  readonly expectedUid?: number;
  readonly fetcher?: FetchLike;
}

export class NodeComputerUseHostStorage implements ComputerUseHostStorage {
  private canonicalRoot: string | null = null;
  private readonly fetcher: FetchLike;
  constructor(private readonly options: NodeComputerUseHostStorageOptions) { this.fetcher = options.fetcher ?? fetch; }

  async ensurePrivateRoot(): Promise<boolean> {
    try {
      const root = resolve(this.options.runtimeRoot); if (root !== this.options.runtimeRoot || dirname(root) === root) return false;
      await mkdir(root, { recursive: true, mode: 0o700 }); const info = await lstat(root); const uid = this.options.expectedUid ?? process.getuid?.();
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || (uid !== undefined && info.uid !== uid)) return false;
      // macOS aliases /var to /private/var. The final requested leaf was
      // already lstat-attested as a real directory; canonicalize trusted
      // descendants without rejecting that platform-owned parent alias.
      const canonical = await realpath(root);
      const marker = join(root, ROOT_MARKER_NAME);
      const existing = await readdir(root);
      if (!existing.includes(ROOT_MARKER_NAME) && existing.length !== 0) return false;
      try { await writeFile(marker, ROOT_MARKER, { flag: "wx", mode: 0o600 }); } catch (error) { if (!((error as { code?: unknown }).code === "EEXIST")) throw error; }
      if (!(await exactTextFile(marker, ROOT_MARKER))) return false;
      if ((await readdir(root)).some((name) => ![ROOT_MARKER_NAME, "releases", "staging", "records"].includes(name))) return false;
      for (const name of ["releases", "staging", "records"]) {
        const path = join(root, name); await mkdir(path, { recursive: true, mode: 0o700 }); const child = await lstat(path);
        if (!child.isDirectory() || child.isSymbolicLink() || (child.mode & 0o777) !== 0o700 || (uid !== undefined && child.uid !== uid)
          || !contained(canonical, await realpath(path))) return false;
      }
      this.canonicalRoot = canonical; return true;
    } catch { return false; }
  }

  async recoverStaging(): Promise<void> {
    const root = await this.root(); const stagingRoot = join(root, "staging");
    for (const name of await readdir(stagingRoot)) {
      if (!UUID.test(name)) continue;
      const path = join(stagingRoot, name); const info = await lstat(path).catch(() => null);
      if (info?.isDirectory() && !info.isSymbolicLink() && await exactTextFile(join(path, STAGING_MARKER), `${name}\n`)) {
        await rm(path, { recursive: true, force: true });
      }
    }
  }

  async readRecord(kind: "active" | "rollback"): Promise<ComputerUseHostRecord | null> {
    try {
      const path = join(await this.root(), "records", `${kind}.json`); const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) return null;
      return parseRecord(JSON.parse(await readFile(path, "utf8")));
    } catch { return null; }
  }

  async findRelease(record: ComputerUseHostRecord): Promise<ComputerUseHostRelease | null> {
    try {
      const root = this.releaseRoot(await this.root(), record.archiveSha256);
      if (!(await exactTextFile(join(root, RELEASE_MARKER), `${record.archiveSha256}\n`))) return null;
      const info = await lstat(join(root, RELEASE_MANIFEST)); if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) return null;
      const release = parseComputerUseHostRelease(JSON.parse(await readFile(join(root, RELEASE_MANIFEST), "utf8")), this.options.officialPointerUrl, true);
      return release !== null && sameDigest(record.releaseSha256, createHash("sha256").update(JSON.stringify(release)).digest("hex")) ? release : null;
    } catch { return null; }
  }

  async openInstalled(release: ComputerUseHostRelease): Promise<ComputerUseHostStagedArtifact> {
    const root = this.releaseRoot(await this.root(), release.archive.sha256);
    if (!(await exactTextFile(join(root, RELEASE_MARKER), `${release.archive.sha256}\n`))) throw new Error("release marker rejected");
    return await this.inspectPayload(root, release, release.archive.bytes, release.archive.sha256);
  }

  async stageBundled(release: ComputerUseHostRelease): Promise<ComputerUseHostStagedArtifact> {
    if (release.archive.format !== "bare" || release.members.length !== 1) throw new Error("bundled release rejected");
    const stage = await this.createStage(); const payload = join(stage, "payload"); const sourceRoot = await realpath(this.options.bundledDirectory);
    const member = release.members[0]!; const source = join(sourceRoot, member.path); if (!contained(sourceRoot, source)) throw new Error("bundled path rejected");
    const info = await lstat(source); if (!info.isFile() || info.isSymbolicLink() || info.size !== member.bytes) throw new Error("bundled member rejected");
    await mkdir(dirname(join(payload, member.path)), { recursive: true, mode: 0o700 }); await copyFile(source, join(payload, member.path));
    await chmod(join(payload, member.path), member.executable ? 0o500 : 0o400);
    return await this.inspectPayload(payload, release, info.size, await digestFile(source));
  }

  async downloadAndStage(release: ComputerUseHostRelease, signal?: AbortSignal): Promise<ComputerUseHostStagedArtifact> {
    if (release.archive.format !== "tar.gz") throw new Error("managed archive rejected");
    const stage = await this.createStage(); const archive = join(stage, "archive.partial"); const payload = join(stage, "payload");
    const response = await this.fetcher(release.archive.url, { redirect: "error", ...(signal ? { signal } : {}) });
    const lengthText = response.headers.get("content-length"); const length = lengthText === null ? null : Number(lengthText);
    if (!response.ok || response.status !== 200 || response.url !== release.archive.url || length !== release.archive.bytes || !response.body) throw new Error("download rejected");
    type Reader = { read(): Promise<{ done: true } | { done: false; value: Uint8Array }>; releaseLock(): void };
    const output = await open(archive, "wx", 0o600); const digest = createHash("sha256"); let bytes = 0;
    const reader = response.body.getReader() as unknown as Reader;
    try {
      for (;;) { if (signal?.aborted) throw new Error("cancelled"); const item = await reader.read(); if (item.done) break;
        bytes += item.value.byteLength; if (bytes > release.archive.bytes) throw new Error("archive overrun"); digest.update(item.value); await writeAll(output, item.value); }
    } finally { reader.releaseLock(); await output.close(); }
    const archiveDigest = digest.digest("hex"); if (bytes !== release.archive.bytes || !sameDigest(archiveDigest, release.archive.sha256)) throw new Error("archive digest rejected");
    await mkdir(payload, { mode: 0o700 }); await extractTarGz(archive, payload, new Map(release.members.map((member) => [member.path, member])), signal);
    for (const member of release.members) await chmod(join(payload, member.path), member.executable ? 0o500 : 0o400);
    return await this.inspectPayload(payload, release, bytes, archiveDigest, signal);
  }

  async publish(staged: ComputerUseHostStagedArtifact, release: ComputerUseHostRelease): Promise<ComputerUseHostStagedArtifact> {
    const root = await this.root(); const payload = resolve(staged.root); const stage = dirname(payload); const name = stage.slice(stage.lastIndexOf(sep) + 1);
    if (!contained(join(root, "staging"), stage) || !UUID.test(name) || !(await exactTextFile(join(stage, STAGING_MARKER), `${name}\n`))) throw new Error("staging ownership rejected");
    await writeFile(join(payload, RELEASE_MANIFEST), `${JSON.stringify(release)}\n`, { flag: "wx", mode: 0o400 });
    await writeFile(join(payload, RELEASE_MARKER), `${release.archive.sha256}\n`, { flag: "wx", mode: 0o400 });
    await chmod(payload, 0o700);
    const destination = this.releaseRoot(root, release.archive.sha256);
    try { await rename(payload, destination); } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : null;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      // Crash recovery: an exact previously published digest root wins. A
      // foreign or partial collision is never deleted or overwritten.
      const installed = await this.inspectPayload(destination, release, staged.archiveBytes, staged.archiveSha256);
      if (!(await exactTextFile(join(destination, RELEASE_MARKER), `${release.archive.sha256}\n`))) throw error;
      await rm(stage, { recursive: true, force: true }); return installed;
    }
    await rm(stage, { recursive: true, force: true });
    return await this.inspectPayload(destination, release, staged.archiveBytes, staged.archiveSha256);
  }

  async writeRecord(kind: "active" | "rollback", record: ComputerUseHostRecord): Promise<void> {
    if (parseRecord(record) === null) throw new Error("record rejected"); const root = await this.root(); const path = join(root, "records", `${kind}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
  }

  private async createStage(): Promise<string> {
    const root = await this.root(); const id = randomUUID(); const stage = join(root, "staging", id);
    await mkdir(stage, { mode: 0o700 }); await writeFile(join(stage, STAGING_MARKER), `${id}\n`, { flag: "wx", mode: 0o600 });
    return stage;
  }
  private async root(): Promise<string> { if (this.canonicalRoot === null && !(await this.ensurePrivateRoot())) throw new Error("root rejected"); return this.canonicalRoot!; }
  private releaseRoot(root: string, digest: string): string { if (!SHA256.test(digest)) throw new Error("digest rejected"); return join(root, "releases", `sha256-${digest}`); }
  private async inspectPayload(root: string, release: ComputerUseHostRelease, archiveBytes: number, archiveSha256: string, signal?: AbortSignal): Promise<ComputerUseHostStagedArtifact> {
    const info = await lstat(root); if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) throw new Error("payload root rejected");
    await this.assertExactTree(root, release);
    const actual: ComputerUseHostMember[] = [];
    for (const member of release.members) {
      const path = join(root, member.path); if (!contained(root, path)) throw new Error("member escape"); const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== member.bytes || Boolean(stat.mode & 0o111) !== Boolean(member.executable)) throw new Error("member metadata rejected");
      const digest = await digestFile(path, signal); if (!sameDigest(digest, member.sha256)) throw new Error("member digest rejected"); actual.push({ ...member });
    }
    return Object.freeze({ archiveBytes, archiveSha256, root, members: Object.freeze(actual) });
  }

  private async assertExactTree(root: string, release: ComputerUseHostRelease): Promise<void> {
    const allowedFiles = new Set(release.members.map((member) => member.path));
    const installed = await exactTextFile(join(root, RELEASE_MARKER), `${release.archive.sha256}\n`);
    if (installed) { allowedFiles.add(RELEASE_MARKER); allowedFiles.add(RELEASE_MANIFEST); }
    const allowedDirectories = new Set<string>();
    for (const path of allowedFiles) {
      const parts = path.split("/"); for (let index = 1; index < parts.length; index += 1) allowedDirectories.add(parts.slice(0, index).join("/"));
    }
    const pending: string[] = [""];
    while (pending.length > 0) {
      const parent = pending.pop()!;
      for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
        const path = parent ? `${parent}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw new Error("payload link rejected");
        if (entry.isDirectory()) { if (!allowedDirectories.has(path)) throw new Error("unexpected payload directory"); pending.push(path); continue; }
        if (!entry.isFile() || !allowedFiles.has(path)) throw new Error("unexpected payload member");
      }
    }
  }
}
