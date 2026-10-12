import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBolterConnectionDirectories, productionBolterArtifact, provisionBolterRuntime } from "../../electron/bolter-bridge/runtime";
import { BOLTER_CLI_RELEASE, getBolterProductionDecoders } from "../../electron/bolter-bridge/production-contract";
import { decodeBolterIdentities } from "../../electron/bolter-bridge/cli-contract";

const version = "0".repeat(40);
const bytes = Buffer.from("Synthetic executable bytes");
const artifact = { url: "https://bolter.chat/bolter-agent/darwin-arm64", bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex") };
async function fixture() {
  const parent = await mkdtemp(join(await realpath("/tmp"), "nb-runtime-"));
  await chmod(parent, 0o700);
  const directory = join(parent, "runtime"); await mkdir(directory, { mode: 0o700 });
  return { parent, directory, remove: () => rm(parent, { recursive: true, force: true }) };
}
const providerFetch = (() => Promise.resolve(new Response(bytes))) as typeof fetch;
const scope = { serverId: "synthetic-server", userId: "synthetic-human", connectionId: "synthetic-connection" };

test("production contract exposes version-qualified decoders without runtime admission", () => {
  const decoders = getBolterProductionDecoders(BOLTER_CLI_RELEASE.version);
  expect(decodeBolterIdentities({ agents: [], harness: "codex" }, BOLTER_CLI_RELEASE.version, decoders)).toEqual({ ok: true, value: [] });
  expect(decodeBolterIdentities({ agents: [{ id: "synthetic" }], harness: "codex" }, BOLTER_CLI_RELEASE.version, decoders).ok).toBe(false);
  for (const decoder of [decoders?.identity, decoders?.receiveItem, decoders?.receipt]) expect(decoder).toBeFunction();
  expect(getBolterProductionDecoders("other-version")).toBeUndefined();
  expect(productionBolterArtifact("win32", "x64")).toBeUndefined();
  expect(productionBolterArtifact("darwin", "arm64")?.sha256).toHaveLength(64);
});

test("provisioning pins exact bytes and version, reuses valid artifacts, and never reads account config", async () => {
  const f = await fixture();
  try {
    let fetches = 0; let inspections = 0;
    const options = { directory: f.directory, artifact, version, isCurrent: () => true,
      fetch: ((url, init) => { expect(url).toBe(artifact.url); expect(init?.credentials).toBe("omit"); fetches++; return providerFetch(url, init); }) as typeof fetch,
      inspectVersion: () => { inspections++; return Promise.resolve(true); } };
    const executable = await provisionBolterRuntime(options);
    expect(await readFile(executable)).toEqual(bytes);
    expect((await lstat(executable)).mode & 0o777).toBe(0o700);
    expect(await provisionBolterRuntime(options)).toBe(executable);
    expect(fetches).toBe(1); expect(inspections).toBe(2);
  } finally { await f.remove(); }
});

test("bad bytes, stale acquisition, unsafe directories and artifact symlinks fail closed", async () => {
  for (const kind of ["digest", "size", "stale", "permissions", "symlink"] as const) {
    const f = await fixture();
    let current = true; let inspected = false;
    try {
      if (kind === "permissions") await chmod(f.directory, 0o755);
      if (kind === "symlink") {
        const release = join(f.directory, version); await mkdir(release, { mode: 0o700 });
        const target = join(f.parent, "synthetic-target"); await writeFile(target, bytes, { mode: 0o700 });
        await symlink(target, join(release, "bolter-agent"));
      }
      const request = provisionBolterRuntime({ directory: f.directory, artifact, version, isCurrent: () => current,
        fetch: (() => { if (kind === "stale") current = false;
          return Promise.resolve(new Response(kind === "digest" ? Buffer.alloc(bytes.length) : kind === "size" ? Buffer.concat([bytes, bytes]) : bytes)); }) as typeof fetch,
        inspectVersion: () => { inspected = true; return Promise.resolve(true); } });
      await Promise.resolve(expect(request).rejects.toThrow("unavailable"));
      expect(inspected).toBe(false);
      if (kind !== "permissions") expect((await readdir(join(f.directory, version))).some(name => name.startsWith(".download-"))).toBe(false);
    } finally { await f.remove(); }
  }
});

test("credential directories are stable only for exact owned scope and opaque home handle", async () => {
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
