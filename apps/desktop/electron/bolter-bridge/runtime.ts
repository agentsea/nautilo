import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BOLTER_CLI_RELEASE, type BolterCliArtifact } from "./production-contract";
import type { BolterSpoolScope } from "./inbox-spool";

const unavailable = () => new Error("Bolter runtime is unavailable.");
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
function owned(stat: Stats): boolean { return !process.getuid || stat.uid === process.getuid(); }
async function directory(path: string): Promise<Stats> {
  if (!isAbsolute(path)) throw unavailable();
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) || (stat.mode & 0o077) !== 0
    || await realpath(path) !== resolve(path)) throw unavailable();
  return stat;
}
async function childDirectory(parent: string, name: string): Promise<string> {
  const before = await directory(parent);
  const path = join(parent, name);
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw unavailable(); }
  await directory(path);
  if (!same(before, await directory(parent))) throw unavailable();
  return path;
}
export interface BolterConnectionDirectories { readonly home: string; readonly handover: string; readonly spool: string }
export async function createBolterPrivateRoot(parent: string, name: "bolter" | "runtime" | "connections"): Promise<string> {
  try {
    const before = await lstat(parent);
    if (!before.isDirectory() || before.isSymbolicLink() || !owned(before) || (before.mode & 0o022) !== 0
      || await realpath(parent) !== resolve(parent)) throw unavailable();
    const path = join(parent, name);
    try { await mkdir(path, { mode: 0o700 }); } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw unavailable();
    }
    await directory(path);
    if (!same(before, await lstat(parent))) throw unavailable();
    return path;
  } catch { throw unavailable(); }
}

/** Opaque handles are hashed coordinates; no server field can choose a local path. */
export async function createBolterConnectionDirectories(root: string, scope: BolterSpoolScope,
  homeHandle: string): Promise<BolterConnectionDirectories> {
  try {
    if (![scope.serverId, scope.userId, scope.connectionId, homeHandle].every(value => typeof value === "string" && value.trim().length > 0)) throw unavailable();
    const coordinates = JSON.stringify([scope.serverId, scope.userId, scope.connectionId, homeHandle]);
    const connection = await childDirectory(root, createHash("sha256").update(coordinates).digest("hex"));
    return Object.freeze({ home: await childDirectory(connection, "home"), handover: await childDirectory(connection, "handover"),
      spool: await childDirectory(connection, "spool") });
  } catch { throw unavailable(); }
}

async function digestFile(path: string, artifact: BolterCliArtifact): Promise<boolean> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !owned(stat) || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size !== artifact.bytes) return false;
    const hash = createHash("sha256");
    for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes as Buffer);
    const after = await lstat(path);
    return same(stat, after) && after.isFile() && !after.isSymbolicLink() && hash.digest("hex") === artifact.sha256;
  } finally { await file.close(); }
}

/** Version stdout is matched incrementally to exact pinned bytes; diagnostics are discarded. */
export function inspectBolterVersion(executable: string, version: string, isCurrent: () => boolean): Promise<boolean> {
  try {
    if (!isCurrent()) return Promise.resolve(false);
    const child = spawn(executable, ["version"], { shell: false, env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
    const expected = Buffer.from(version + "\n");
    let offset = 0;
    let valid = true;
    const stop = () => { valid = false; try { child.kill("SIGTERM"); } catch { /* Wait for actual close. */ } };
    child.stderr.resume();
    child.on("error", stop);
    child.stdout.on("error", stop);
    child.stderr.on("error", stop);
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        if (!isCurrent() || !valid || !chunk.equals(expected.subarray(offset, offset + chunk.length))) { stop(); return; }
        offset += chunk.length;
      } catch { stop(); }
    });
    return new Promise(resolveResult => child.once("close", code => {
      try { resolveResult(valid && code === 0 && offset === expected.length && isCurrent()); }
      catch { resolveResult(false); }
    }));
  } catch { return Promise.resolve(false); }
}

export interface BolterRuntimeProvisioning {
  readonly directory: string;
  readonly artifact: BolterCliArtifact;
  readonly version: string;
  readonly isCurrent: () => boolean;
  readonly fetch?: typeof fetch;
  readonly inspectVersion?: typeof inspectBolterVersion;
}
/** Explicit acquisition only; it never runs login, reads account config, or installs a service. */
export async function provisionBolterRuntime(input: BolterRuntimeProvisioning): Promise<string> {
  const options = Object.freeze({ ...input, artifact: Object.freeze({ ...input.artifact }) });
  let temporary: string | null = null;
  try {
    const { artifact, version } = options;
    if (!/^[a-f0-9]{40}$/u.test(version) || !/^[a-f0-9]{64}$/u.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || new URL(artifact.url).origin !== "https://bolter.chat"
      || !options.isCurrent()) throw unavailable();
    const initial = await directory(options.directory);
    const parent = await lstat(dirname(options.directory));
    if (!parent.isDirectory() || parent.isSymbolicLink() || !owned(parent) || (parent.mode & 0o022) !== 0) throw unavailable();
    const release = await childDirectory(options.directory, version);
    const releaseStat = await directory(release);
    const check = async () => {
      if (!options.isCurrent() || !same(initial, await directory(options.directory))
        || !same(parent, await lstat(dirname(options.directory))) || !same(releaseStat, await directory(release))) throw unavailable();
    };
    const executable = join(release, "bolter-agent");
    let valid = false;
    try { valid = await digestFile(executable, artifact); }
    catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw unavailable(); }
    if (!valid) {
      // An existing incompatible or replaced artifact is never silently overwritten.
      try { await lstat(executable); throw unavailable(); }
      catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw unavailable(); }
      const response = await (options.fetch ?? fetch)(artifact.url, { credentials: "omit", redirect: "follow" });
      if (!response.ok || !response.body || !["https://bolter.chat", "https://cdn.bolter.chat"].includes(new URL(response.url || artifact.url).origin)) throw unavailable();
      await check();
      temporary = join(release, `.download-${randomUUID()}`);
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o700);
      const reader = response.body.getReader();
      let bytes = 0;
      const hash = createHash("sha256");
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (!options.isCurrent() || bytes > artifact.bytes) throw unavailable();
          hash.update(chunk.value); await file.writeFile(chunk.value);
        }
        if (bytes !== artifact.bytes || hash.digest("hex") !== artifact.sha256) throw unavailable();
        await file.sync();
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); await file.close(); }
      await check();
      await rename(temporary, executable); temporary = null;
      const handle = await open(release, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { if (!same(releaseStat, await handle.stat())) throw unavailable(); await handle.sync(); }
      finally { await handle.close(); }
    }
    await check();
    if (!await digestFile(executable, artifact) || !await (options.inspectVersion ?? inspectBolterVersion)(executable, version, options.isCurrent)) throw unavailable();
    await check();
    return executable;
  } catch { throw unavailable(); }
  finally { if (temporary) await unlink(temporary).catch(() => undefined); }
}

export function productionBolterArtifact(platform: NodeJS.Platform, arch: string): BolterCliArtifact | undefined {
  return platform === "darwin" && (arch === "arm64" || arch === "x64") ? BOLTER_CLI_RELEASE.artifacts[`darwin-${arch}`] : undefined;
}
