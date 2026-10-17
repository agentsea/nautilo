import { expect, test as bunTest } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  attestBolterRuntime,
  createBolterConnectionDirectories,
  productionBolterPlatform,
  provisionLatestBolterRuntime,
  type BolterInstalledRuntime,
} from "../../electron/bolter-bridge/runtime";

// Bolter is unsupported on Windows (the CLI contract refuses win32); runtime
// provisioning relies on POSIX permission bits.
const test = bunTest.skipIf(process.platform === "win32");

const currentVersion = "0c6d0991397a532bfb5ab97096a00c6cc9710f1d";
const newerVersion = "1".repeat(40);
const platform = "darwin-arm64" as const;
const latestFor = (target: "darwin-arm64" | "darwin-amd64") => `https://bolter.chat/bolter-agent/${target}`;
const immutableFor = (version: string, target: "darwin-arm64" | "darwin-amd64") =>
  `https://cdn.bolter.chat/bolter-agent/${version}/${target}`;
const latest = latestFor(platform);
const immutable = (version: string) => immutableFor(version, platform);

function macho(payload = "synthetic build", cpu = 0x0100000c): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cpu, 4);
  return Buffer.concat([header, Buffer.from(payload)]);
}
function response(url: string, init?: ResponseInit, body: Buffer | null = null): Response {
  const value = new Response(body, init);
  Object.defineProperties(value, { url: { value: url }, redirected: { value: false } });
  return value;
}
function head(version: string, location = immutable(version), target: "darwin-arm64" | "darwin-amd64" = platform): Response {
  return response(latestFor(target), { status: 302, headers: { location } });
}
function artifact(version: string, bytes: Buffer, target: "darwin-arm64" | "darwin-amd64" = platform): Response {
  return response(immutableFor(version, target), { status: 200, headers: { "content-length": String(bytes.length) } }, bytes);
}
function provider(version: string, bytes: Buffer, calls?: string[], target: "darwin-arm64" | "darwin-amd64" = platform): typeof fetch {
  return ((url, init) => {
    const requested = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    calls?.push(`${init?.method ?? "GET"} ${requested}`);
    return Promise.resolve(init?.method === "HEAD" ? head(version, immutableFor(version, target), target) : artifact(version, bytes, target));
  }) as typeof fetch;
}
async function fixture() {
  const parent = await mkdtemp(join(await realpath("/tmp"), "nb-runtime-"));
  await chmod(parent, 0o700);
  const directory = join(parent, "runtime"); await mkdir(directory, { mode: 0o700 });
  return { parent, directory, remove: () => rm(parent, { recursive: true, force: true }) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}
async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt++) {
    if (await predicate()) return;
    await new Promise<void>(resolveResult => setTimeout(resolveResult, 1));
  }
  throw new Error("Timed out waiting for Bolter acquisition state.");
}
const scope = { serverId: "synthetic-server", userId: "synthetic-human", connectionId: "synthetic-connection" };

test("production platform names match the provider contract", () => {
  expect(productionBolterPlatform("darwin", "arm64")).toBe("darwin-arm64");
  expect(productionBolterPlatform("darwin", "x64")).toBe("darwin-amd64");
  expect(productionBolterPlatform("darwin", "ia32")).toBeUndefined();
  expect(productionBolterPlatform("win32", "x64")).toBeUndefined();
});

test("latest acquisition records immutable bytes and reuses the same version after a fresh HEAD", async () => {
  const f = await fixture();
  const bytes = macho();
  const calls: string[] = [];
  let inspections = 0;
  const providerFetch = provider(currentVersion, bytes, calls);
  const checkedFetch = ((url, init) => {
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe(init?.method === "HEAD" ? "manual" : "error");
    return providerFetch(url, init);
  }) as typeof fetch;
  const options = { directory: f.directory, platform, isCurrent: () => true, fetch: checkedFetch,
    inspectVersion: async (_path: string, version: string) => { inspections++; return version === currentVersion; } };
  try {
    const first = await provisionLatestBolterRuntime(options);
    expect(first.version).toBe(currentVersion);
    expect(first.artifact).toEqual({ url: immutable(currentVersion), bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(await readFile(first.executable)).toEqual(bytes);
    expect((await lstat(first.executable)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(f.directory, "releases", platform, currentVersion, "receipt.json"))).mode & 0o777).toBe(0o600);
    expect((await provisionLatestBolterRuntime(options)).executable).toBe(first.executable);
    expect(calls).toEqual([`HEAD ${latest}`, `GET ${immutable(currentVersion)}`, `HEAD ${latest}`]);
    expect(inspections).toBe(4);
  } finally { await f.remove(); }
});

test("a newer provider build is installed beside the attested cached build", async () => {
  const f = await fixture();
  let version = currentVersion;
  const fetcher = ((url, init) => Promise.resolve(init?.method === "HEAD" ? head(version) : artifact(version, macho(version)))) as typeof fetch;
  try {
    const first = await provisionLatestBolterRuntime({ directory: f.directory, platform, isCurrent: () => true, fetch: fetcher,
      inspectVersion: async (_path, inspected) => inspected === version });
    version = newerVersion;
    const second = await provisionLatestBolterRuntime({ directory: f.directory, platform, isCurrent: () => true, fetch: fetcher,
      inspectVersion: async (_path, inspected) => inspected === version });
    expect(first.version).toBe(currentVersion);
    expect(second.version).toBe(newerVersion);
    expect(first.executable).not.toBe(second.executable);
    expect((await readdir(join(f.directory, "releases", platform))).sort()).toEqual([currentVersion, newerVersion].sort());
  } finally { await f.remove(); }
});

test("native and Rosetta artifacts of the same version use separate attested caches", async () => {
  const f = await fixture();
  const amd64 = "darwin-amd64" as const;
  try {
    const arm = await provisionLatestBolterRuntime({ directory: f.directory, platform, isCurrent: () => true,
      fetch: provider(currentVersion, macho()), inspectVersion: async () => true });
    const intel = await provisionLatestBolterRuntime({ directory: f.directory, platform: amd64, isCurrent: () => true,
      fetch: provider(currentVersion, macho("synthetic Rosetta build", 0x01000007), undefined, amd64), inspectVersion: async () => true });
    expect(arm.executable).toBe(join(f.directory, "releases", platform, currentVersion, "bolter-agent"));
    expect(intel.executable).toBe(join(f.directory, "releases", amd64, currentVersion, "bolter-agent"));
    expect(arm.artifact.url).toBe(immutableFor(currentVersion, platform));
    expect(intel.artifact.url).toBe(immutableFor(currentVersion, amd64));
    expect(await attestBolterRuntime({ directory: f.directory, runtime: arm, isCurrent: () => true,
      inspectVersion: async () => true })).toBeTrue();
    expect(await attestBolterRuntime({ directory: f.directory, runtime: intel, isCurrent: () => true,
      inspectVersion: async () => true })).toBeTrue();
  } finally { await f.remove(); }
});

test("attestation is local and rejects byte, receipt, path, permission and authority drift", async () => {
  for (const kind of ["bytes", "receipt", "path", "permissions", "stale"] as const) {
    const f = await fixture();
    let current = true;
    try {
      const installed = await provisionLatestBolterRuntime({ directory: f.directory, platform, isCurrent: () => current,
        fetch: provider(currentVersion, macho()), inspectVersion: async () => true });
      let runtime: BolterInstalledRuntime = installed;
      if (kind === "bytes") await writeFile(runtime.executable, macho("tampered"), { mode: 0o700 });
      if (kind === "receipt") await writeFile(join(f.directory, "releases", platform, currentVersion, "receipt.json"), "{}\n", { mode: 0o600 });
      if (kind === "path") runtime = { ...runtime, executable: join(f.directory, "elsewhere") };
      if (kind === "permissions") await chmod(runtime.executable, 0o755);
      if (kind === "stale") current = false;
      expect(await attestBolterRuntime({ directory: f.directory, runtime, isCurrent: () => current,
        inspectVersion: async () => true })).toBeFalse();
    } finally { await f.remove(); }
  }
});

test("foreign, malformed and cross-platform latest redirects fail before artifact download", async () => {
  const redirects = [
    `http://cdn.bolter.chat/bolter-agent/${currentVersion}/${platform}`,
    `https://cdn.bolter.chat.example.com/bolter-agent/${currentVersion}/${platform}`,
    `https://cdn.bolter.chat/bolter-agent/${currentVersion}/darwin-amd64`,
    `https://cdn.bolter.chat/bolter-agent/${currentVersion}/${platform}?download=1`,
    `https://cdn.bolter.chat/bolter-agent/${"A".repeat(40)}/${platform}`,
  ];
  for (const location of redirects) {
    const f = await fixture();
    let gets = 0;
    try {
      const fetcher = ((_url, init) => {
        if (init?.method === "HEAD") return Promise.resolve(head(currentVersion, location));
        gets++; return Promise.resolve(artifact(currentVersion, macho()));
      }) as typeof fetch;
      await Promise.resolve(expect(provisionLatestBolterRuntime({ directory: f.directory, platform, isCurrent: () => true, fetch: fetcher,
        inspectVersion: async () => true })).rejects.toThrow("unavailable"));
      expect(gets).toBe(0);
      expect(await readdir(f.directory)).toEqual([]);
    } finally { await f.remove(); }
  }
});

test("partial downloads, wrong architecture and failed version inspection leave no published build", async () => {
  for (const kind of ["partial", "architecture", "version"] as const) {
    const f = await fixture();
    const bytes = kind === "architecture" ? Buffer.from("not a Mach-O") : macho();
    try {
      const fetcher = ((url, init) => {
        if (init?.method === "HEAD") return Promise.resolve(head(currentVersion));
        const length = kind === "partial" ? bytes.length + 1 : bytes.length;
        const requested = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        return Promise.resolve(response(requested, { status: 200, headers: { "content-length": String(length) } }, bytes));
      }) as typeof fetch;
      await Promise.resolve(expect(provisionLatestBolterRuntime({ directory: f.directory, platform, isCurrent: () => true, fetch: fetcher,
        inspectVersion: async () => kind !== "version" })).rejects.toThrow("unavailable"));
      expect(await readdir(join(f.directory, "releases", platform))).toEqual([]);
    } finally { await f.remove(); }
  }
});

test("an existing unsafe release is never overwritten", async () => {
  const f = await fixture();
  const releases = join(f.directory, "releases");
  const platformRoot = join(releases, platform);
  const release = join(platformRoot, currentVersion);
  const original = Buffer.from("preserve me");
  try {
    await mkdir(releases, { mode: 0o700 }); await mkdir(platformRoot, { mode: 0o700 }); await mkdir(release, { mode: 0o700 });
    await writeFile(join(release, "bolter-agent"), original, { mode: 0o700 });
    let gets = 0;
    const fetcher = ((_url, init) => {
      if (init?.method === "HEAD") return Promise.resolve(head(currentVersion));
      gets++; return Promise.resolve(artifact(currentVersion, macho()));
    }) as typeof fetch;
    await Promise.resolve(expect(provisionLatestBolterRuntime({ directory: f.directory, platform, isCurrent: () => true, fetch: fetcher,
      inspectVersion: async () => true })).rejects.toThrow("unavailable"));
    expect(gets).toBe(0);
    expect(await readFile(join(release, "bolter-agent"))).toEqual(original);
  } finally { await f.remove(); }
});

test("a concurrent exact publication is adopted while an invalid winner is preserved and rejected", async () => {
  for (const kind of ["exact", "invalid"] as const) {
    const f = await fixture();
    const bytes = macho();
    const release = join(f.directory, "releases", platform, currentVersion);
    let raced = false;
    try {
      const request = provisionLatestBolterRuntime({ directory: f.directory, platform, isCurrent: () => true,
        fetch: provider(currentVersion, bytes), inspectVersion: async executable => {
          if (!raced && executable.includes(".staging-")) {
            raced = true;
            await mkdir(release, { mode: 0o700 });
            if (kind === "exact") {
              await copyFile(executable, join(release, "bolter-agent"));
              await chmod(join(release, "bolter-agent"), 0o700);
              const receipt = { version: currentVersion, platform, artifact: { url: immutable(currentVersion),
                sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length } };
              await writeFile(join(release, "receipt.json"), JSON.stringify(receipt) + "\n", { mode: 0o600 });
            }
          }
          return true;
        } });
      if (kind === "exact") {
        expect((await request).executable).toBe(join(release, "bolter-agent"));
        expect(await readdir(join(f.directory, "releases", platform))).toEqual([currentVersion]);
      } else {
        await Promise.resolve(expect(request).rejects.toThrow("unavailable"));
        expect(await readdir(release)).toEqual([]);
        expect(await readdir(join(f.directory, "releases", platform))).toEqual([currentVersion]);
      }
    } finally { await f.remove(); }
  }
});

test("stale authority stops acquisition and concurrent callers share one download", async () => {
  const staleFixture = await fixture();
  let current = true;
  let gets = 0;
  try {
    const fetcher = ((_url, init) => {
      if (init?.method === "HEAD") { current = false; return Promise.resolve(head(currentVersion)); }
      gets++; return Promise.resolve(artifact(currentVersion, macho()));
    }) as typeof fetch;
    await Promise.resolve(expect(provisionLatestBolterRuntime({ directory: staleFixture.directory, platform, isCurrent: () => current,
      fetch: fetcher, inspectVersion: async () => true })).rejects.toThrow("unavailable"));
    expect(gets).toBe(0);
  } finally { await staleFixture.remove(); }

  const concurrentFixture = await fixture();
  const calls: string[] = [];
  try {
    const options = { directory: concurrentFixture.directory, platform, isCurrent: () => true,
      fetch: provider(currentVersion, macho(), calls), inspectVersion: async () => true };
    const [first, second] = await Promise.all([provisionLatestBolterRuntime(options), provisionLatestBolterRuntime(options)]);
    expect(first).toEqual(second);
    expect(calls).toEqual([`HEAD ${latest}`, `GET ${immutable(currentVersion)}`]);
  } finally { await concurrentFixture.remove(); }
});

test("an aborted caller promptly cancels a hanging latest request when it is the final waiter", async () => {
  const f = await fixture();
  const caller = new AbortController();
  const started = deferred<AbortSignal>();
  try {
    const fetcher = ((_url, init) => {
      started.resolve(init!.signal!);
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;
    const request = provisionLatestBolterRuntime({ directory: f.directory, platform, isCurrent: () => true,
      signal: caller.signal, fetch: fetcher, inspectVersion: async () => true });
    const sharedSignal = await started.promise;
    caller.abort();
    await Promise.resolve(expect(request).rejects.toThrow("unavailable"));
    expect(sharedSignal.aborted).toBeTrue();
    expect(await readdir(f.directory)).toEqual([]);
  } finally { await f.remove(); }
});

test("an immediate retry starts a fresh acquisition after the last waiter cancels", async () => {
  const f = await fixture();
  const caller = new AbortController();
  const started = deferred<void>();
  const bytes = macho();
  const nextFetch = provider(currentVersion, bytes);
  let requests = 0;
  try {
    const fetcher = ((url, init) => {
      if (++requests === 1) { started.resolve(); return new Promise<Response>(() => undefined); }
      return nextFetch(url, init);
    }) as typeof fetch;
    const first = provisionLatestBolterRuntime({ directory: f.directory, platform, isCurrent: () => true,
      signal: caller.signal, fetch: fetcher, inspectVersion: async () => true });
    const firstResult = first.then(() => "resolved", () => "rejected");
    await started.promise;
    caller.abort();
    const retry = provisionLatestBolterRuntime({ directory: f.directory, platform, isCurrent: () => true,
      fetch: fetcher, inspectVersion: async () => true });
    expect(await firstResult).toBe("rejected");
    expect((await retry).version).toBe(currentVersion);
    expect(requests).toBe(3);
  } finally { caller.abort(); await f.remove(); }
});

test("one concurrent caller can abort while the remaining waiter publishes a valid cache", async () => {
  const f = await fixture();
  const firstController = new AbortController();
  const secondController = new AbortController();
  const bytes = macho();
  const calls: string[] = [];
  let sharedSignal: AbortSignal | undefined;
  try {
    const providerFetch = provider(currentVersion, bytes, calls);
    const fetcher = ((url, init) => { sharedSignal = init?.signal ?? undefined; return providerFetch(url, init); }) as typeof fetch;
    const first = provisionLatestBolterRuntime({ directory: f.directory, platform, isCurrent: () => true,
      signal: firstController.signal, fetch: fetcher, inspectVersion: async () => true });
    const firstResult = first.then(() => "resolved", () => "rejected");
    const second = provisionLatestBolterRuntime({ directory: f.directory, platform, isCurrent: () => true,
      signal: secondController.signal, fetch: fetcher, inspectVersion: async () => true });
    firstController.abort();
    expect(await firstResult).toBe("rejected");
    const installed = await second;
    expect(sharedSignal?.aborted).toBeFalse();
    expect(calls).toEqual([`HEAD ${latest}`, `GET ${immutable(currentVersion)}`]);
    expect(await attestBolterRuntime({ directory: f.directory, runtime: installed, isCurrent: () => true,
      inspectVersion: async () => true })).toBeTrue();
  } finally { firstController.abort(); secondController.abort(); await f.remove(); }
});

test("canceling every waiter aborts a stalled body read and removes staging", async () => {
  const f = await fixture();
  const firstController = new AbortController();
  const secondController = new AbortController();
  const bytes = macho();
  const getStarted = deferred<void>();
  let bodyCanceled = false;
  let sharedSignal: AbortSignal | undefined;
  try {
    const fetcher = ((url, init) => {
      sharedSignal = init?.signal ?? undefined;
      if (init?.method === "HEAD") return Promise.resolve(head(currentVersion));
      getStarted.resolve();
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(bytes); },
        cancel() { bodyCanceled = true; },
      });
      const artifactResponse = new Response(body, { status: 200, headers: { "content-length": String(bytes.length + 1) } });
      Object.defineProperties(artifactResponse, {
        url: { value: typeof url === "string" ? url : url instanceof URL ? url.href : url.url },
        redirected: { value: false },
      });
      return Promise.resolve(artifactResponse);
    }) as typeof fetch;
    const options = { directory: f.directory, platform, isCurrent: () => true, fetch: fetcher, inspectVersion: async () => true };
    const first = provisionLatestBolterRuntime({ ...options, signal: firstController.signal });
    const second = provisionLatestBolterRuntime({ ...options, signal: secondController.signal });
    const firstResult = first.then(() => "resolved", () => "rejected");
    const secondResult = second.then(() => "resolved", () => "rejected");
    await getStarted.promise;
    await waitFor(async () => (await readdir(join(f.directory, "releases", platform))).some(name => name.startsWith(".staging-")));
    firstController.abort(); secondController.abort();
    expect(await Promise.all([firstResult, secondResult])).toEqual(["rejected", "rejected"]);
    expect(sharedSignal?.aborted).toBeTrue();
    await waitFor(async () => bodyCanceled && (await readdir(join(f.directory, "releases", platform))).length === 0);
  } finally { firstController.abort(); secondController.abort(); await f.remove(); }
});

test("cancellation interrupts silent version inspection and removes unpublished staging", async () => {
  const f = await fixture();
  const caller = new AbortController();
  const inspectionStarted = deferred<AbortSignal>();
  try {
    const request = provisionLatestBolterRuntime({ directory: f.directory, platform, isCurrent: () => true,
      signal: caller.signal, fetch: provider(currentVersion, macho()),
      inspectVersion: async (_path, _version, _current, signal) => {
        if (!signal) return false;
        inspectionStarted.resolve(signal);
        return new Promise<boolean>(resolveResult => {
          if (signal.aborted) resolveResult(false);
          else signal.addEventListener("abort", () => resolveResult(false), { once: true });
        });
      } });
    const sharedSignal = await inspectionStarted.promise;
    caller.abort();
    await Promise.resolve(expect(request).rejects.toThrow("unavailable"));
    expect(sharedSignal.aborted).toBeTrue();
    await waitFor(async () => (await readdir(join(f.directory, "releases", platform))).length === 0);
  } finally { caller.abort(); await f.remove(); }
});

test("local attestation passes its caller signal through version inspection", async () => {
  const f = await fixture();
  const caller = new AbortController();
  const inspectionStarted = deferred<AbortSignal>();
  try {
    const installed = await provisionLatestBolterRuntime({ directory: f.directory, platform, isCurrent: () => true,
      fetch: provider(currentVersion, macho()), inspectVersion: async () => true });
    const attestation = attestBolterRuntime({ directory: f.directory, runtime: installed, isCurrent: () => true,
      signal: caller.signal, inspectVersion: async (_path, _version, _current, signal) => {
        if (!signal) return false;
        inspectionStarted.resolve(signal);
        return new Promise<boolean>(resolveResult => {
          if (signal.aborted) resolveResult(false);
          else signal.addEventListener("abort", () => resolveResult(false), { once: true });
        });
      } });
    expect(await inspectionStarted.promise).toBe(caller.signal);
    caller.abort();
    expect(await attestation).toBeFalse();
  } finally { caller.abort(); await f.remove(); }
});

test("credential directories remain private and scoped to opaque coordinates", async () => {
  const f = await fixture();
  try {
    const first = await createBolterConnectionDirectories(f.directory, scope, "synthetic-handle");
    expect(await createBolterConnectionDirectories(f.directory, scope, "synthetic-handle")).toEqual(first);
    expect((await createBolterConnectionDirectories(f.directory, { ...scope, userId: "other-human" }, "synthetic-handle")).home).not.toBe(first.home);
    expect(first.home).not.toContain(scope.userId);
    expect((await lstat(first.home)).mode & 0o777).toBe(0o700);
    await rm(first.home, { recursive: true }); await symlink(f.parent, first.home);
    await Promise.resolve(expect(createBolterConnectionDirectories(f.directory, scope, "synthetic-handle")).rejects.toThrow("unavailable"));
  } finally { await f.remove(); }
});
