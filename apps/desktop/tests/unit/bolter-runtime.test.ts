import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  attestBolterRuntime,
  createBolterConnectionDirectories,
  productionBolterPlatform,
  provisionLatestBolterRuntime,
  type BolterInstalledRuntime,
} from "../../electron/bolter-bridge/runtime";

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
