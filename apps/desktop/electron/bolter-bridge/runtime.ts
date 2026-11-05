import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { renameWithWindowsRetry } from "@nautilo/config/private-filesystem";
import { dirname, isAbsolute, join, resolve } from "node:path";
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

export interface BolterInstalledRuntime {
  readonly executable: string;
  readonly version: string;
  readonly artifact: { readonly url: string; readonly sha256: string; readonly bytes: number };
}

type BolterProductionPlatform = "darwin-arm64" | "darwin-amd64";
interface BolterRuntimeProvisioning {
  readonly directory: string;
  readonly platform: BolterProductionPlatform;
  readonly isCurrent: () => boolean;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly inspectVersion?: typeof inspectBolterVersion;
}
interface BolterRuntimeAttestation {
  readonly directory: string;
  readonly runtime: BolterInstalledRuntime;
  readonly isCurrent: () => boolean;
  readonly signal?: AbortSignal;
  readonly inspectVersion?: typeof inspectBolterVersion;
}
interface BolterReceipt {
  readonly version: string;
  readonly platform: BolterProductionPlatform;
  readonly artifact: BolterInstalledRuntime["artifact"];
}

interface AcquisitionWaiter { readonly isCurrent: () => boolean; readonly signal?: AbortSignal }
interface AcquisitionFlight {
  readonly controller: AbortController;
  readonly waiters: Set<AcquisitionWaiter>;
  promise: Promise<BolterInstalledRuntime>;
  completed: boolean;
}

const acquisitions = new Map<string, AcquisitionFlight>();
const versionPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;

function immutableUrl(version: string, platform: BolterProductionPlatform): string {
  return `https://cdn.bolter.chat/bolter-agent/${version}/${platform}`;
}
function latestUrl(platform: BolterProductionPlatform): string {
  return `https://bolter.chat/bolter-agent/${platform}`;
}
function freezeRuntime(receipt: BolterReceipt, executable: string): BolterInstalledRuntime {
  return Object.freeze({ executable, version: receipt.version, artifact: Object.freeze({ ...receipt.artifact }) });
}
function receiptBytes(receipt: BolterReceipt): Buffer {
  return Buffer.from(JSON.stringify(receipt) + "\n");
}
function receiptFor(runtime: BolterInstalledRuntime, platform: BolterProductionPlatform): BolterReceipt {
  return Object.freeze({ version: runtime.version, platform, artifact: Object.freeze({ ...runtime.artifact }) });
}
function platformFromRuntime(runtime: BolterInstalledRuntime): BolterProductionPlatform | undefined {
  for (const platform of ["darwin-arm64", "darwin-amd64"] as const) {
    if (runtime.artifact.url === immutableUrl(runtime.version, platform)) return platform;
  }
  return undefined;
}

function waiterIsCurrent(waiter: AcquisitionWaiter): boolean {
  if (waiter.signal?.aborted) return false;
  try { return waiter.isCurrent(); } catch { return false; }
}
function flightIsCurrent(flight: AcquisitionFlight): boolean {
  let current = false;
  for (const waiter of flight.waiters) {
    if (waiterIsCurrent(waiter)) current = true;
    else flight.waiters.delete(waiter);
  }
  if (!current && !flight.completed) flight.controller.abort();
  return current;
}
function releaseWaiter(flight: AcquisitionFlight, waiter: AcquisitionWaiter): void {
  flight.waiters.delete(waiter);
  if (!flight.completed) flightIsCurrent(flight);
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => undefined); return Promise.reject(unavailable()); }
  return new Promise<T>((resolveResult, rejectResult) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); rejectResult(unavailable()); };
    signal.addEventListener("abort", aborted, { once: true });
    void operation.then(resolveResult, rejectResult).finally(() => signal.removeEventListener("abort", aborted));
  });
}
function awaitFlight(flight: AcquisitionFlight, waiter: AcquisitionWaiter): Promise<BolterInstalledRuntime> {
  if (!waiterIsCurrent(waiter)) { releaseWaiter(flight, waiter); return Promise.reject(unavailable()); }
  const signal = waiter.signal;
  if (!signal) return flight.promise.finally(() => releaseWaiter(flight, waiter));
  return new Promise<BolterInstalledRuntime>((resolveResult, rejectResult) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      releaseWaiter(flight, waiter);
      action();
    };
    const aborted = () => finish(() => rejectResult(unavailable()));
    signal.addEventListener("abort", aborted, { once: true });
    void flight.promise.then(
      runtime => finish(() => resolveResult(runtime)),
      error => finish(() => rejectResult(error instanceof Error ? error : unavailable())),
    );
    if (signal.aborted) aborted();
  });
}

async function digestFile(path: string, artifact: BolterInstalledRuntime["artifact"]): Promise<boolean> {
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

async function matchesMachO(path: string, platform: BolterProductionPlatform): Promise<boolean> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.readUInt32LE(0) !== 0xfeedfacf) return false;
    return header.readUInt32LE(4) === (platform === "darwin-arm64" ? 0x0100000c : 0x01000007);
  } finally { await file.close(); }
}

/** Version stdout is matched incrementally to the exact resolved version; diagnostics are discarded. */
function inspectBolterVersion(executable: string, version: string, isCurrent: () => boolean,
  signal?: AbortSignal): Promise<boolean> {
  try {
    if (signal?.aborted || !isCurrent()) return Promise.resolve(false);
    const child = spawn(executable, ["version"], { shell: false, env: { PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"], ...(signal ? { signal } : {}) });
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

async function readReceipt(path: string, expected: BolterReceipt): Promise<boolean> {
  try {
    const expectedBytes = receiptBytes(expected);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || !owned(stat) || stat.nlink !== 1 || (stat.mode & 0o177) !== 0 || stat.size !== expectedBytes.length) return false;
      const actual = await readFile(file);
      const after = await lstat(path);
      return same(stat, after) && after.isFile() && !after.isSymbolicLink() && actual.equals(expectedBytes);
    } finally { await file.close(); }
  } catch { return false; }
}

/** Local-only verification of the immutable receipt, executable bytes, version and private paths. */
export async function attestBolterRuntime(input: BolterRuntimeAttestation): Promise<boolean> {
  try {
    if (input.signal?.aborted || !input.isCurrent() || !versionPattern.test(input.runtime.version)
      || !digestPattern.test(input.runtime.artifact.sha256)
      || !Number.isSafeInteger(input.runtime.artifact.bytes) || input.runtime.artifact.bytes <= 0) return false;
    const platform = platformFromRuntime(input.runtime);
    if (!platform) return false;
    const root = await directory(input.directory);
    const releases = join(input.directory, "releases");
    const releasesStat = await directory(releases);
    const platformRoot = join(releases, platform);
    const platformStat = await directory(platformRoot);
    const release = join(platformRoot, input.runtime.version);
    const releaseStat = await directory(release);
    const executable = join(release, "bolter-agent");
    if (input.runtime.executable !== executable
      || !await readReceipt(join(release, "receipt.json"), receiptFor(input.runtime, platform))
      || !await digestFile(executable, input.runtime.artifact)
      || !await matchesMachO(executable, platform)
      || !await (input.inspectVersion ?? inspectBolterVersion)(executable, input.runtime.version, input.isCurrent, input.signal)
      || input.signal?.aborted || !input.isCurrent() || !same(root, await directory(input.directory))
      || !same(releasesStat, await directory(releases))
      || !same(platformStat, await directory(platformRoot))
      || !same(releaseStat, await directory(release))) return false;
    return true;
  } catch { return false; }
}

async function acquireLatestBolterRuntime(options: BolterRuntimeProvisioning): Promise<BolterInstalledRuntime> {
  let staging: string | null = null;
  try {
    if (!options.isCurrent()) throw unavailable();
    const root = await directory(options.directory);
    const parent = await lstat(dirname(options.directory));
    if (!parent.isDirectory() || parent.isSymbolicLink() || !owned(parent) || (parent.mode & 0o022) !== 0) throw unavailable();
    const check = async () => {
      if (!options.isCurrent() || !same(root, await directory(options.directory))
        || !same(parent, await lstat(dirname(options.directory)))) throw unavailable();
    };
    const mutableUrl = latestUrl(options.platform);
    const signal = options.signal;
    if (!signal) throw unavailable();
    const head = await abortable((options.fetch ?? fetch)(mutableUrl,
      { method: "HEAD", credentials: "omit", redirect: "manual", signal }), signal);
    const location = head.headers.get("location");
    const match = location?.match(/^https:\/\/cdn\.bolter\.chat\/bolter-agent\/([a-f0-9]{40})\/(darwin-(?:arm64|amd64))$/u);
    if (head.status !== 302 || head.redirected || head.url !== mutableUrl || !match || match[2] !== options.platform) throw unavailable();
    const version = match[1]!;
    const url = immutableUrl(version, options.platform);
    if (location !== url) throw unavailable();
    await check();

    const releases = await childDirectory(options.directory, "releases");
    const releasesStat = await directory(releases);
    const platformRoot = await childDirectory(releases, options.platform);
    const platformStat = await directory(platformRoot);
    const release = join(platformRoot, version);
    const executable = join(release, "bolter-agent");
    let releaseExists = false;
    try { await lstat(release); releaseExists = true; }
    catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw unavailable();
    }
    if (releaseExists) {
      try {
        const receiptPath = join(release, "receipt.json");
        const receiptStat = await lstat(receiptPath);
        if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || !owned(receiptStat) || receiptStat.nlink !== 1 || (receiptStat.mode & 0o177) !== 0) throw unavailable();
        const parsed = JSON.parse(await readFile(receiptPath, "utf8")) as Partial<BolterReceipt>;
        const artifact = parsed.artifact;
        if (parsed.version !== version || parsed.platform !== options.platform || !artifact
          || artifact.url !== url || !digestPattern.test(artifact.sha256 ?? "")
          || !Number.isSafeInteger(artifact.bytes) || (artifact.bytes ?? 0) <= 0) throw unavailable();
        const runtime = freezeRuntime({ version, platform: options.platform, artifact }, executable);
        if (!await attestBolterRuntime({ directory: options.directory, runtime, isCurrent: options.isCurrent,
          signal, inspectVersion: options.inspectVersion ?? inspectBolterVersion })) throw unavailable();
        return runtime;
      } catch { throw unavailable(); }
    }

    const response = await abortable((options.fetch ?? fetch)(url, { credentials: "omit", redirect: "error", signal }), signal);
    const contentLength = response.headers.get("content-length");
    const expectedBytes = contentLength && /^[1-9][0-9]*$/u.test(contentLength) ? Number(contentLength) : Number.NaN;
    if (!response.ok || !response.body || response.redirected || response.url !== url
      || !Number.isSafeInteger(expectedBytes)) throw unavailable();
    await check();
    staging = join(platformRoot, `.staging-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    const stagedExecutable = join(staging, "bolter-agent");
    const file = await open(stagedExecutable, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o700);
    const reader = response.body.getReader();
    let bytes = 0;
    const hash = createHash("sha256");
    try {
      while (true) {
        const chunk = await abortable(reader.read(), signal);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (!options.isCurrent() || bytes > expectedBytes) throw unavailable();
        hash.update(chunk.value);
        await file.writeFile(chunk.value);
      }
      if (bytes !== expectedBytes) throw unavailable();
      await file.sync();
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); await file.close(); }
    if (!await matchesMachO(stagedExecutable, options.platform)) throw unavailable();
    const artifact = Object.freeze({ url, sha256: hash.digest("hex"), bytes });
    if (!await (options.inspectVersion ?? inspectBolterVersion)(stagedExecutable, version, options.isCurrent, signal)) throw unavailable();
    await check();
    const receipt: BolterReceipt = Object.freeze({ version, platform: options.platform, artifact });
    const receiptFile = await open(join(staging, "receipt.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await receiptFile.writeFile(receiptBytes(receipt)); await receiptFile.sync(); }
    finally { await receiptFile.close(); }
    const stagingHandle = await open(staging, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await stagingHandle.sync(); } finally { await stagingHandle.close(); }
    await check();
    if (!same(releasesStat, await directory(releases))) throw unavailable();
    if (!same(platformStat, await directory(platformRoot))) throw unavailable();
    let destinationExists = false;
    try { await lstat(release); destinationExists = true; }
    catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw unavailable(); }
    await check();
    const runtime = freezeRuntime(receipt, executable);
    if (destinationExists) {
      if (!await attestBolterRuntime({ directory: options.directory, runtime, isCurrent: options.isCurrent,
        signal, inspectVersion: options.inspectVersion ?? inspectBolterVersion })) throw unavailable();
    } else {
      try { await renameWithWindowsRetry(staging, release); staging = null; }
      catch (error) {
        if (!error || typeof error !== "object" || !("code" in error)
          || (error.code !== "EEXIST" && error.code !== "ENOTEMPTY")) throw unavailable();
        if (!await attestBolterRuntime({ directory: options.directory, runtime, isCurrent: options.isCurrent,
          signal, inspectVersion: options.inspectVersion ?? inspectBolterVersion })) throw unavailable();
      }
    }
    if (staging) { await rm(staging, { recursive: true, force: true }); staging = null; }
    const platformHandle = await open(platformRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { if (!same(platformStat, await platformHandle.stat())) throw unavailable(); await platformHandle.sync(); }
    finally { await platformHandle.close(); }
    await check();
    if (!same(releasesStat, await directory(releases))) throw unavailable();
    if (!same(platformStat, await directory(platformRoot))) throw unavailable();
    return runtime;
  } catch { throw unavailable(); }
  finally { if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined); }
}

/** Resolves the provider's current build and acquires its immutable artifact without account access. */
export async function provisionLatestBolterRuntime(input: BolterRuntimeProvisioning): Promise<BolterInstalledRuntime> {
  const callerCurrent = () => !input.signal?.aborted && input.isCurrent();
  const options = Object.freeze({ ...input, isCurrent: callerCurrent });
  try {
    if (!options.isCurrent()) throw unavailable();
    const key = `${resolve(options.directory)}\0${options.platform}`;
    const waiter: AcquisitionWaiter = { isCurrent: input.isCurrent, ...(input.signal ? { signal: input.signal } : {}) };
    let flight = acquisitions.get(key);
    // A fresh caller must not inherit a canceled flight while its staging cleanup completes.
    if (flight?.controller.signal.aborted) flight = undefined;
    if (!flight) {
      const controller = new AbortController();
      const created: AcquisitionFlight = { controller, waiters: new Set([waiter]), completed: false,
        promise: Promise.resolve().then(() => acquireLatestBolterRuntime(Object.freeze({ ...options,
          signal: controller.signal, isCurrent: () => flightIsCurrent(created) }))) };
      flight = created;
      acquisitions.set(key, flight);
      const tracked = flight;
      void flight.promise.finally(() => {
        tracked.completed = true;
        if (acquisitions.get(key) === tracked) acquisitions.delete(key);
      }).catch(() => undefined);
    } else {
      flight.waiters.add(waiter);
    }
    const runtime = await awaitFlight(flight, waiter);
    if (!await attestBolterRuntime({ directory: options.directory, runtime, isCurrent: options.isCurrent,
      ...(input.signal ? { signal: input.signal } : {}), inspectVersion: options.inspectVersion ?? inspectBolterVersion })) throw unavailable();
    return runtime;
  } catch { throw unavailable(); }
}

export function productionBolterPlatform(platform: NodeJS.Platform, arch: string): "darwin-arm64" | "darwin-amd64" | undefined {
  if (platform !== "darwin") return undefined;
  if (arch === "arm64") return "darwin-arm64";
  if (arch === "x64") return "darwin-amd64";
  return undefined;
}
