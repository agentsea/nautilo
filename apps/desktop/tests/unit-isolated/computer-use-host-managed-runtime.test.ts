import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, test } from "bun:test";
import type { ComputerUseHostRelease } from "../../electron/computer-use-host-runtime/contracts.ts";
import { createManagedComputerUseHostRuntime } from "../../electron/computer-use-host-runtime/managed-runtime.ts";
import {
  MacosComputerUseHostAttestor,
  parseDesignatedRequirement,
  type MacosCommandRunner,
} from "../../electron/computer-use-host-runtime/macos-attestor.ts";
import { NodeComputerUseHostStorage } from "../../electron/computer-use-host-runtime/node-storage.ts";
import {
  OFFICIAL_COMPUTER_USE_HOST_POINTER_URL,
  OfficialComputerUseHostReleaseAuthority,
} from "../../electron/computer-use-host-runtime/official-release-authority.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function response(url: string, bytes: Uint8Array, status = 200, contentType = "application/json"): Response {
  const value = new Response(bytes, { status, headers: { "content-type": contentType, "content-length": String(bytes.byteLength) } });
  Object.defineProperty(value, "url", { value: url, configurable: false });
  return value;
}

function tar(name: string, bytes: Uint8Array, type = "0"): Uint8Array {
  const header = new Uint8Array(512); const write = (offset: number, length: number, value: string) => header.set(new TextEncoder().encode(value).slice(0, length), offset);
  write(0, 100, name); write(100, 8, "0000500\0"); write(108, 8, "0000000\0"); write(116, 8, "0000000\0");
  write(124, 12, `${bytes.byteLength.toString(8).padStart(11, "0")}\0`); write(136, 12, "00000000000\0"); header.fill(32, 148, 156);
  write(156, 1, type); write(257, 6, "ustar\0"); write(263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0); write(148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padded = Math.ceil(bytes.byteLength / 512) * 512; const output = new Uint8Array(512 + padded + 1024); output.set(header); output.set(bytes, 512);
  return gzipSync(output);
}

function release(archive: Uint8Array, memberBytes: Uint8Array, version = "0.2.0"): ComputerUseHostRelease {
  return {
    schemaVersion: 1,
    releaseId: `host-${version}`,
    version,
    pointerUrl: OFFICIAL_COMPUTER_USE_HOST_POINTER_URL,
    archive: {
      format: "tar.gz",
      url: `https://media.nautilo.ai/computer-use/host/v1/releases/${version}/host.tar.gz`,
      bytes: archive.byteLength,
      sha256: sha(archive),
    },
    entrypoint: "nautilo-computer-use-host",
    members: [{ path: "nautilo-computer-use-host", bytes: memberBytes.byteLength, sha256: sha(memberBytes), executable: true }],
    architectures: ["arm64", "x64"],
    signature: {
      teamId: "ABCDE12345",
      designatedRequirement: 'identifier "com.nautilo.desktop.computer-use-host" and anchor apple generic',
      notarized: true,
    },
  };
}

function trustedRunner(version = "0.1.0"): MacosCommandRunner {
  return async (command, argumentsValue) => {
    const path = argumentsValue.at(-1) ?? command; const desktop = path.endsWith("Nautilo");
    if (command === "/usr/bin/codesign" && argumentsValue[0] === "--verify") return { code: 0, stdout: "", stderr: "" };
    if (command === "/usr/bin/codesign" && argumentsValue[0] === "-dv") return {
      code: 0,
      stdout: "",
      stderr: `Identifier=${desktop ? "com.nautilo.desktop" : "com.nautilo.desktop.computer-use-host"}\nAuthority=Developer ID Application: Nautilo Test (ABCDE12345)\nTeamIdentifier=ABCDE12345\nRuntime Version=14.0.0\n`,
    };
    if (command === "/usr/bin/codesign" && argumentsValue[0] === "-dr") return {
      code: 0,
      stdout: 'designated => identifier "com.nautilo.desktop.computer-use-host" and anchor apple generic\n',
      stderr: `Executable=${path}\n`,
    };
    if (command === "/usr/bin/lipo") return { code: 0, stdout: "x86_64 arm64\n", stderr: "" };
    if (argumentsValue.length === 1 && argumentsValue[0] === "--health") return { code: 0, stdout: `${JSON.stringify({ schemaVersion: 1, component: "nautilo-computer-use-host", version, status: "ready" })}\n`, stderr: "" };
    return { code: 1, stdout: "", stderr: "rejected" };
  };
}

describe("managed Computer Use Host delivery", () => {
  test("propagates bootstrap cancellation into the initial macOS identity probes", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-host-cancel-")); roots.push(root);
    const resource = join(root, "tools-computer-use-host"); await mkdir(resource);
    const entrypoint = join(resource, "nautilo-computer-use-host"); await writeFile(entrypoint, "host"); await chmod(entrypoint, 0o755);
    await writeFile(join(resource, "manifest.json"), JSON.stringify({ schemaVersion: 2, binary: "nautilo-computer-use-host", version: "0.1.0", architectures: ["arm64", "x64"] }));
    let observedSignal: AbortSignal | undefined;
    const runtime = createManagedComputerUseHostRuntime({
      resourceDirectory: resource,
      runtimeRoot: join(root, "runtime"),
      desktopExecutable: "/Applications/Nautilo.app/Contents/MacOS/Nautilo",
      commandRunner: async (_command, _argumentsValue, signal) => await new Promise((resolve) => {
        observedSignal = signal;
        if (signal?.aborted) {
          resolve({ code: null, stdout: "", stderr: "aborted" });
          return;
        }
        signal?.addEventListener("abort", () => resolve({ code: null, stdout: "", stderr: "aborted" }), { once: true });
      }),
    });
    const controller = new AbortController();
    const bootstrap = runtime.bootstrap(controller.signal);
    controller.abort();
    expect(await bootstrap).toEqual({ state: "unavailable", code: "host_unavailable" });
    expect(observedSignal).toBe(controller.signal);
  });

  test("extracts only the canonical designated requirement from codesign diagnostics", () => {
    const requirement = 'identifier "com.nautilo.desktop.computer-use-host" and anchor apple generic';
    expect(parseDesignatedRequirement(`Executable=/tmp/host\ndesignated => ${requirement}\n`)).toBe(requirement);
    expect(parseDesignatedRequirement(`designated => ${requirement}\nExecutable=/tmp/host\n`)).toBe(requirement);
    expect(parseDesignatedRequirement(`designated => ${requirement}\ndesignated => ${requirement}\n`)).toBeNull();
  });

  test("resolves only the compiled same-origin pointer and digest-bound immutable release manifest", async () => {
    const binary = new TextEncoder().encode("managed-host"); const archive = tar("nautilo-computer-use-host", binary); const candidate = release(archive, binary);
    const manifest = new TextEncoder().encode(JSON.stringify(candidate));
    const manifestUrl = "https://media.nautilo.ai/computer-use/host/v1/releases/0.2.0/manifest.json";
    const pointer = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, manifestUrl, manifestBytes: manifest.byteLength, manifestSha256: sha(manifest) }));
    const calls: string[] = [];
    const authority = new OfficialComputerUseHostReleaseAuthority(async (url) => {
      calls.push(url); return url === OFFICIAL_COMPUTER_USE_HOST_POINTER_URL ? response(url, pointer) : response(url, manifest);
    });
    expect(await authority.resolveOfficialRelease(OFFICIAL_COMPUTER_USE_HOST_POINTER_URL)).toEqual(candidate);
    expect(calls).toEqual([OFFICIAL_COMPUTER_USE_HOST_POINTER_URL, manifestUrl]);
    const changed = Uint8Array.from(manifest); changed[0] ^= 1;
    const hostile = new OfficialComputerUseHostReleaseAuthority(async (url) => url === OFFICIAL_COMPUTER_USE_HOST_POINTER_URL ? response(url, pointer) : response(url, changed));
    expect(hostile.resolveOfficialRelease(OFFICIAL_COMPUTER_USE_HOST_POINTER_URL)).rejects.toThrow(/digest rejected/u);
    expect(authority.resolveOfficialRelease("https://evil.example/latest.json")).rejects.toThrow(/authority rejected/u);
  });

  test("admits only the exact Developer ID team, Host requirement, universal slices, publisher-attested notarization, and build version", async () => {
    const attestor = await MacosComputerUseHostAttestor.create({ desktopExecutable: "/Applications/Nautilo.app/Contents/MacOS/Nautilo", bundledEntrypoint: "/bundle/host", runner: trustedRunner("0.2.0") });
    const binary = new TextEncoder().encode("host"); const candidate = release(tar("nautilo-computer-use-host", binary), binary);
    expect(await attestor.verifyMacosRelease("/managed/host", candidate, ["arm64", "x64"])).toBeTrue();
    expect(await attestor.health("/managed/host", candidate)).toBeTrue();
    expect(await attestor.health("/managed/host", { ...candidate, version: "0.2.1" })).toBeFalse();
    expect(await attestor.verifyMacosRelease("/managed/host", { ...candidate, signature: { ...candidate.signature, teamId: "ZZZZZ99999" } }, ["arm64", "x64"])).toBeFalse();
  });

  test("downloads and extracts an exact archive into a marker-owned immutable digest root and rejects links", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-host-delivery-")); roots.push(root); const runtimeRoot = join(root, "runtime"); const bundle = join(root, "bundle"); await mkdir(bundle);
    const binary = new TextEncoder().encode("managed-host"); const archive = tar("nautilo-computer-use-host", binary); const candidate = release(archive, binary);
    const storage = new NodeComputerUseHostStorage({ runtimeRoot, bundledDirectory: bundle, officialPointerUrl: OFFICIAL_COMPUTER_USE_HOST_POINTER_URL, fetcher: async (url) => response(url, archive, 200, "application/gzip") });
    expect(await storage.ensurePrivateRoot()).toBeTrue(); const staged = await storage.downloadAndStage(candidate); const installed = await storage.publish(staged, candidate);
    expect(installed.root).toContain(`/releases/sha256-${candidate.archive.sha256}`);
    await storage.writeRecord("active", { schemaVersion: 1, generation: 1, source: "managed", releaseId: candidate.releaseId, version: candidate.version, archiveSha256: candidate.archive.sha256, releaseSha256: sha(JSON.stringify(candidate)) });
    expect((await storage.findRelease((await storage.readRecord("active"))!))?.releaseId).toBe(candidate.releaseId);
    expect(new Uint8Array(await readFile(join(installed.root, candidate.entrypoint)))).toEqual(binary);
    const linkArchive = tar("nautilo-computer-use-host", new Uint8Array(), "2"); const hostile = release(linkArchive, new Uint8Array());
    const hostileStorage = new NodeComputerUseHostStorage({ runtimeRoot: join(root, "hostile"), bundledDirectory: bundle, officialPointerUrl: OFFICIAL_COMPUTER_USE_HOST_POINTER_URL, fetcher: async (url) => response(url, linkArchive, 200, "application/gzip") });
    expect(hostileStorage.downloadAndStage(hostile)).rejects.toThrow(/unsafe archive/u);
  });

  test("recovers only nonce-marker-owned staging and leaves foreign collisions untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-host-recovery-")); roots.push(root); const runtimeRoot = join(root, "runtime"); const bundle = join(root, "bundle"); await mkdir(bundle);
    const storage = new NodeComputerUseHostStorage({ runtimeRoot, bundledDirectory: bundle, officialPointerUrl: OFFICIAL_COMPUTER_USE_HOST_POINTER_URL });
    expect(await storage.ensurePrivateRoot()).toBeTrue();
    const owned = "00000000-0000-4000-8000-000000000001"; const foreign = "00000000-0000-4000-8000-000000000002";
    await mkdir(join(runtimeRoot, "staging", owned)); await writeFile(join(runtimeRoot, "staging", owned, ".nautilo-computer-use-host-staging"), `${owned}\n`);
    await mkdir(join(runtimeRoot, "staging", foreign)); await writeFile(join(runtimeRoot, "staging", foreign, ".nautilo-computer-use-host-staging"), "wrong\n");
    await storage.recoverStaging();
    expect(lstat(join(runtimeRoot, "staging", owned))).rejects.toThrow();
    expect((await lstat(join(runtimeRoot, "staging", foreign))).isDirectory()).toBeTrue();
  });

  test("does not claim a pre-existing nonempty runtime root", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-host-foreign-root-")); roots.push(root); const runtimeRoot = join(root, "runtime"); const bundle = join(root, "bundle");
    await mkdir(runtimeRoot, { mode: 0o700 }); await mkdir(bundle); await writeFile(join(runtimeRoot, "foreign"), "do not claim");
    const storage = new NodeComputerUseHostStorage({ runtimeRoot, bundledDirectory: bundle, officialPointerUrl: OFFICIAL_COMPUTER_USE_HOST_POINTER_URL });
    expect(await storage.ensurePrivateRoot()).toBeFalse();
    expect(await readFile(join(runtimeRoot, "foreign"), "utf8")).toBe("do not claim");
  });

  test("boots the packaged Host offline into managed storage and never launches the mutable bundle path", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-host-production-")); roots.push(root); const resource = join(root, "tools-computer-use-host"); await mkdir(resource);
    const binary = new TextEncoder().encode("bundled-host"); const entrypoint = join(resource, "nautilo-computer-use-host"); await writeFile(entrypoint, binary); await chmod(entrypoint, 0o755);
    await writeFile(join(resource, "manifest.json"), JSON.stringify({ schemaVersion: 2, binary: "nautilo-computer-use-host", version: "0.1.0", architectures: ["arm64", "x64"] }));
    const runtime = createManagedComputerUseHostRuntime({
      resourceDirectory: resource,
      runtimeRoot: join(root, "runtime"),
      desktopExecutable: "/Applications/Nautilo.app/Contents/MacOS/Nautilo",
      commandRunner: trustedRunner(),
      fetcher: async (url) => response(url, new Uint8Array(), 404),
    });
    expect(await runtime.bootstrap()).toMatchObject({
      state: "ready",
      source: "bundled",
      generation: 1,
      remoteUpdateFailure: "host_pointer_untrusted",
    });
    const launch = runtime.acquireLaunch(); expect(launch?.entrypoint).toContain("/releases/sha256-"); expect(launch?.entrypoint).not.toBe(entrypoint);
    launch?.lease.release();
  });
});
