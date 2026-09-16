import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  CodexRuntimeMetadataStore,
  validateCodexRuntimeReleaseManifest,
  type CodexRuntimeReleaseManifest,
  type ManagedRuntimeHost,
} from "../../electron/codex-runtime/index.ts";
import {
  CodexManagedRuntimeManager,
  createNodeManagedRuntimeHost,
  isManagedRuntimeVersionOutput,
} from "../../electron/codex-runtime/acquisition.ts";
import { CodexRuntimeManager, resolveCodexRuntimeLaunchSpecForSupervisor } from "../../electron/codex-runtime/facade.ts";

const encoder = new TextEncoder();
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;
function paxRecord(value: string): Uint8Array {
  let length = value.length + 3;
  while (true) {
    const encoded = encoder.encode(`${length} ${value}\n`);
    if (encoded.byteLength === length) return encoded;
    length = encoded.byteLength;
  }
}

test("accepts only the reviewed app-server entrypoint's exact version label", () => {
  expect(isManagedRuntimeVersionOutput("codex-app-server 0.146.0\n", "0.146.0")).toBeTrue();
  expect(isManagedRuntimeVersionOutput("codex-cli 0.146.0\n", "0.146.0")).toBeFalse();
  expect(isManagedRuntimeVersionOutput("codex-app-server 0.146.1\n", "0.146.0")).toBeFalse();
});
test("keeps the isolated health home alive through app-server initialization", async () => withRoot(async (root) => {
  const packageRoot = join(root, "package");
  const bin = join(packageRoot, "bin");
  const entrypoint = join(bin, "codex-app-server");
  await mkdir(bin, { recursive: true });
  await writeFile(entrypoint, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "codex-app-server 0.146.0"
  exit 0
fi
if [ ! -d "$CODEX_HOME" ]; then
  exit 42
fi
IFS= read -r request
echo '{"id":"c-1","result":{"userAgent":"health-test","codexHome":"'"$CODEX_HOME"'","platformFamily":"unix","platformOs":"macos"}}'
IFS= read -r initialized
`, { mode: 0o700 });
  await chmod(entrypoint, 0o700);
  expect(await createNodeManagedRuntimeHost(join(root, "managed")).health(entrypoint, "0.146.0")).toBeTrue();
}));
function tar(entries: Readonly<Record<string, Uint8Array>>, pax?: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  const append = (name: string, content: Uint8Array, type = 0x30) => {
    const header = new Uint8Array(512);
    header.set(encoder.encode(name), 0);
    header.set(encoder.encode(octal(0o600, 8)), 100);
    header.set(encoder.encode(octal(content.byteLength, 12)), 124);
    header.fill(0x20, 148, 156);
    header[156] = type;
    header.set(encoder.encode("ustar\0"), 257);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.set(encoder.encode(octal(sum, 8)), 148);
    chunks.push(header, content, new Uint8Array(Math.ceil(content.byteLength / 512) * 512 - content.byteLength));
  };
  for (const [name, content] of Object.entries(entries)) {
    if (pax) append("././@PaxHeader", paxRecord(pax), 120);
    append(name, content);
  }
  chunks.push(new Uint8Array(1024));
  return gzipSync(Buffer.concat(chunks.map((value) => Buffer.from(value))));
}
function fixture(version = "0.139.0", architecture: "arm64" | "x64" = "arm64", extra?: string, pax?: string): { archive: Uint8Array; manifest: CodexRuntimeReleaseManifest } {
  // Real Darwin executables use the little-endian MH_CIGAM_64 byte layout.
  const entry = architecture === "arm64" ? new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]) : new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]);
  const includesCodeModeHost = version.localeCompare("0.146.0", undefined, { numeric: true }) >= 0;
  const entries = {
    "codex-package.json": encoder.encode(JSON.stringify({ layoutVersion: 1, version, target: "aarch64-apple-darwin", variant: "codex-app-server", entrypoint: "bin/codex-app-server", pathDir: "codex-path", resourcesDir: "codex-resources" })),
    "bin/codex-app-server": entry,
    ...(includesCodeModeHost ? { "bin/codex-code-mode-host": entry } : {}),
    "codex-path/rg": encoder.encode("rg"),
    "codex-resources/zsh/bin/zsh": encoder.encode("zsh"),
    ...(extra ? { [`codex-resources/${extra}`]: encoder.encode(extra) } : {}),
  };
  const requiredMembers = Object.fromEntries(Object.entries(entries).filter(([name]) => !extra || name !== `codex-resources/${extra}`).map(([name, bytes]) => [name, { bytes: bytes.byteLength, sha256: sha(bytes) }]));
  const executableMembers = ["bin/codex-app-server", ...(includesCodeModeHost ? ["bin/codex-code-mode-host"] : []), "codex-path/rg", "codex-resources/zsh/bin/zsh"];
  const archive = tar(entries, pax);
  return {
    archive,
    manifest: {
      schemaVersion: 1,
      cohort: "certified",
      codexVersion: version,
      releaseTag: `rust-v${version}`,
      sourceRepo: "openai/codex",
      artifacts: {
        "darwin-arm64": {
          platform: "darwin-arm64", version, releaseTag: `rust-v${version}`, url: `https://github.com/openai/codex/releases/download/rust-v${version}/codex-app-server-package-aarch64-apple-darwin.tar.gz`, archiveName: "codex-app-server-package-aarch64-apple-darwin.tar.gz", archiveBytes: archive.byteLength, sha256: sha(archive), entrypointSha256: sha(entry),
          package: { layoutVersion: 1, version, target: "aarch64-apple-darwin", variant: "codex-app-server", entrypoint: "bin/codex-app-server", pathDir: "codex-path", resourcesDir: "codex-resources", requiredMembers, executableMembers },
          signature: { kind: "macos-codesign", teamId: "2DC432GLL2", publisherSubject: "Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)" },
        },
        "darwin-x64": { platform: "darwin-x64", version, releaseTag: `rust-v${version}`, url: `https://github.com/openai/codex/releases/download/rust-v${version}/codex-app-server-package-x86_64-apple-darwin.tar.gz`, archiveName: "codex-app-server-package-x86_64-apple-darwin.tar.gz", archiveBytes: 1, sha256: "0".repeat(64), entrypointSha256: "0".repeat(64), package: { layoutVersion: 1, version, target: "x86_64-apple-darwin", variant: "codex-app-server", entrypoint: "bin/codex-app-server", pathDir: "codex-path", resourcesDir: "codex-resources", requiredMembers, executableMembers }, signature: { kind: "macos-codesign", teamId: "2DC432GLL2", publisherSubject: "Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)" } },
      },
    },
  };
}
async function* chunks(value: Uint8Array): AsyncIterable<Uint8Array> { yield value.slice(0, 12); yield value.slice(12); }
async function withRoot<T>(use: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "nautilo-codex-acquisition-test-"));
  try { return await use(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function host(root: string, archives: Readonly<Record<string, Uint8Array>> | Uint8Array): ManagedRuntimeHost {
  let handles = 0;
  return { platform: "darwin", arch: "arm64", runtimeRoot: root, now: () => 1, randomHandle: () => `opaque-handle-${String(++handles).padStart(12, "0")}`, async fetch(url) { const archive = archives instanceof Uint8Array ? archives : archives[url]; if (!archive) throw new Error("unexpected_url"); return { url, status: 200, contentLength: archive.byteLength, body: chunks(archive) }; }, async verifyDarwinSignature() { return true; }, async health() { return true; } };
}
function forArchive(manifest: CodexRuntimeReleaseManifest, archive: Uint8Array): CodexRuntimeReleaseManifest {
  return { ...manifest, artifacts: { ...manifest.artifacts, "darwin-arm64": { ...manifest.artifacts["darwin-arm64"], archiveBytes: archive.byteLength, sha256: sha(archive) } } };
}
function checksum(header: Uint8Array): void {
  header.fill(0x20, 148, 156);
  header.set(encoder.encode(octal(header.reduce((total, byte) => total + byte, 0), 8)), 148);
}
function mutateArchive(archive: Uint8Array, mutate: (raw: Uint8Array) => void): Uint8Array {
  const raw = new Uint8Array(gunzipSync(archive)); mutate(raw); return gzipSync(raw);
}

describe("Codex managed runtime acquisition", () => {
  test("rejects unknown manifest fields and altered entrypoint digests", () => {
    const { manifest } = fixture();
    expect(validateCodexRuntimeReleaseManifest({ ...manifest, unexpected: true })).toBeNull();
    expect(validateCodexRuntimeReleaseManifest({ ...manifest, artifacts: { ...manifest.artifacts, "darwin-arm64": { ...manifest.artifacts["darwin-arm64"], entrypointSha256: "z".repeat(64) } } })).toBeNull();
    const mutable = structuredClone(manifest);
    const admitted = validateCodexRuntimeReleaseManifest(mutable);
    mutable.artifacts["darwin-arm64"].url = "https://github.com/evil/payload";
    expect(admitted?.artifacts["darwin-arm64"].url).toBe(manifest.artifacts["darwin-arm64"].url);
  });
  test("requires the reviewed 0.146 package member set, including code-mode host", () => {
    const { manifest } = fixture("0.146.0");
    expect(validateCodexRuntimeReleaseManifest(manifest)).not.toBeNull();
    const missingHost = structuredClone(manifest);
    const packageInfo = missingHost.artifacts["darwin-arm64"].package;
    delete (packageInfo.requiredMembers as Record<string, unknown>)["bin/codex-code-mode-host"];
    (packageInfo.executableMembers as string[]).splice(packageInfo.executableMembers.indexOf("bin/codex-code-mode-host"), 1);
    expect(validateCodexRuntimeReleaseManifest(missingHost)).toBeNull();
  });
  test("requires Apple's exact OpenAI publisher subject", () => {
    const { manifest } = fixture("0.146.0");
    expect(validateCodexRuntimeReleaseManifest(manifest)).not.toBeNull();
    const missingPunctuation = structuredClone(manifest);
    missingPunctuation.artifacts["darwin-arm64"].signature.publisherSubject =
      "Developer ID Application: OpenAI OpCo LLC (2DC432GLL2)";
    expect(validateCodexRuntimeReleaseManifest(missingPunctuation)).toBeNull();
  });
  test("accepts only the bounded local mtime PAX records used by the reviewed release", async () => withRoot(async (root) => {
    const valid = fixture("0.139.0", "arm64", undefined, "mtime=1785288481.7491367");
    expect((await new CodexManagedRuntimeManager(host(root, valid.archive), valid.manifest).install()).state).toBe("ready");
  }));
  test("rejects a PAX path override even when the archive digest is reviewed", async () => withRoot(async (root) => {
    const hostile = fixture("0.139.0", "arm64", undefined, "path=outside");
    expect(await new CodexManagedRuntimeManager(host(root, hostile.archive), hostile.manifest).install()).toMatchObject({ state: "unavailable", code: "CODEX_RUNTIME_ARTIFACT_INVALID" });
  }));
  test("persists a managed standalone snapshot without a handle or schema identity", async () => withRoot(async (root) => {
    const store = new CodexRuntimeMetadataStore(join(root, "managed.json"));
    await store.save({ state: "ready", source: "managed", kind: "standalone", version: "0.139.0", checkedAt: 1, compatibility: "certified", executableFingerprint: `sha256:${"a".repeat(64)}`, features: { stableConversation: true, explicitSteer: true, codexApprovals: true, requestUserInput: true, collaborationMode: true }, handle: "opaque-handle-never-persisted" });
    const loaded = await store.load();
    expect(loaded).toMatchObject({ source: "managed", kind: "standalone", executableFingerprint: `sha256:${"a".repeat(64)}` });
    expect(JSON.stringify(loaded)).not.toContain("handle");
    expect(JSON.stringify(loaded)).not.toContain("schemaFingerprint");
    await store.save({ state: "unavailable", code: "CODEX_RUNTIME_ARTIFACT_INVALID", source: "managed", version: "0.139.0", checkedAt: 2 });
    expect(await store.load()).toMatchObject({ code: "CODEX_RUNTIME_ARTIFACT_INVALID", source: "managed", version: "0.139.0" });
  }));
  test("installs a fully verified artifact side-by-side and writes only opaque active state", async () => withRoot(async (root) => {
    const { archive, manifest } = fixture();
    const states: string[] = [];
    const manager = new CodexManagedRuntimeManager(host(root, archive), manifest);
    const result = await manager.install({ onState: (state) => states.push(state.phase) });
    expect(result).toMatchObject({ state: "ready", source: "managed", compatibility: "certified" });
    expect(states).toEqual(["resolving", "downloading", "downloading", "verifying", "staging", "activating", "ready"]);
    const active = await readFile(join(root, "state", "active.json"), "utf8");
    expect(active).toContain("opaque");
    expect(active).not.toContain("codex-app-server");
    expect(manager.acquireLease("not-an-opaque-runtime-handle")).toBeNull();
    const lease = manager.acquireLease(result.handle!);
    expect(lease?.generation).toBeGreaterThan(0);
    lease?.release();
    expect(await readFile(join(root, "runtimes", "codex", "0.139.0", "darwin-arm64", manifest.artifacts["darwin-arm64"].sha256, "bin", "codex-app-server"))).toEqual(new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]));
    for (const member of manifest.artifacts["darwin-arm64"].package.executableMembers)
      expect((await stat(join(root, "runtimes", "codex", "0.139.0", "darwin-arm64", manifest.artifacts["darwin-arm64"].sha256, member))).mode & 0o777).toBe(0o700);
  }));
  test("binds a reused release handle to its published command after staging cleanup", async () => withRoot(async (root) => {
    const { archive, manifest } = fixture();
    // The first manager publishes the immutable release. A fresh manager then
    // takes the EEXIST/reuse path, which previously retained its staging path.
    await new CodexManagedRuntimeManager(host(root, archive), manifest).install();
    const managed = new CodexManagedRuntimeManager(host(root, archive), manifest);
    const facade = new CodexRuntimeManager({} as never, managed);
    const resolved = await facade.installManaged();
    expect(resolved.state).toBe("ready");
    expect(await facade.revalidate(resolved.handle!)).toBeTrue();
    await managed.cleanup();
    const launch = resolveCodexRuntimeLaunchSpecForSupervisor(facade, resolved.handle!);
    const published = join(root, "runtimes", "codex", manifest.codexVersion, "darwin-arm64", manifest.artifacts["darwin-arm64"].sha256, "bin", "codex-app-server");
    expect(launch).toEqual({ command: await realpath(published), argv: ["--listen", "stdio://"], pathEntries: [join(dirname(dirname(await realpath(published))), "codex-path")] });
    expect(launch?.command).not.toContain(`${join(root, "staging")}/`);
    expect(await Bun.file(launch!.command).exists()).toBeTrue();
  }));
  test("never activates a corrupt archive and leaves no partial staging", async () => withRoot(async (root) => {
    const { archive, manifest } = fixture();
    const corrupted = archive.slice(); corrupted[0] ^= 1;
    const manager = new CodexManagedRuntimeManager(host(root, corrupted), manifest);
    expect((await manager.install()).code).toBe("CODEX_RUNTIME_ARTIFACT_INVALID");
    expect(await Bun.file(join(root, "state", "active.json")).exists()).toBeFalse();
    expect(await Bun.file(join(root, "staging", "nautilo-codex-forged")).exists()).toBeFalse();
  }));
  test("treats a corrupt pre-existing immutable destination as a local install failure", async () => withRoot(async (root) => {
    const { archive, manifest } = fixture();
    const manager = new CodexManagedRuntimeManager(host(root, archive), manifest);
    // Claim the owned root without creating a release, then emulate a
    // conflicting destination that cannot be treated as a verified artifact.
    await manager.recoverStaging();
    const descriptor = manifest.artifacts["darwin-arm64"];
    const destination = join(root, "runtimes", "codex", descriptor.version, descriptor.platform, descriptor.sha256);
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await writeFile(join(destination, "foreign"), "corrupt");
    expect(await manager.install()).toMatchObject({ code: "CODEX_RUNTIME_INSTALL_FAILED", source: "managed", version: descriptor.version });
  }));
  test("refuses an unsupported managed platform before network", async () => withRoot(async (root) => {
    const { archive, manifest } = fixture();
    let fetched = 0;
    const unsupported = new CodexManagedRuntimeManager({ ...host(root, archive), platform: "linux", async fetch() { fetched += 1; throw new Error("must not fetch"); } }, manifest);
    expect((await unsupported.install()).code).toBe("CODEX_RUNTIME_PLATFORM_UNSUPPORTED");
    expect(fetched).toBe(0);
  }));
  test("cancellation has a stable result and does not call the health seam", async () => withRoot(async (root) => {
    const { archive, manifest } = fixture();
    const controller = new AbortController(); controller.abort();
    let health = 0;
    const manager = new CodexManagedRuntimeManager({ ...host(root, archive), async health() { health += 1; return true; } }, manifest);
    expect((await manager.install({ signal: controller.signal })).code).toBe("CODEX_RUNTIME_CANCELLED");
    expect(health).toBe(0);
  }));
  test("admits candidate data for review but never selects it for acquisition", async () => withRoot(async (root) => {
    const certified = fixture();
    const candidate = structuredClone(fixture("0.140.0").manifest);
    candidate.cohort = "candidate";
    let fetched = 0;
    const manager = new CodexManagedRuntimeManager({ ...host(root, certified.archive), async fetch() { fetched += 1; throw new Error("candidate must not fetch"); } }, [certified.manifest, candidate]);
    expect((await manager.install({ version: "0.140.0" })).code).toBe("CODEX_RUNTIME_PLATFORM_UNSUPPORTED");
    expect(fetched).toBe(0);
  }));
  test("rejects a correctly hashed wrong-architecture artifact and a failed native signature before health", async () => withRoot(async (root) => {
    const wrong = fixture("0.139.0", "x64");
    let health = 0;
    const wrongManager = new CodexManagedRuntimeManager({ ...host(root, wrong.archive), async health() { health += 1; return true; } }, wrong.manifest);
    expect((await wrongManager.install()).code).toBe("CODEX_RUNTIME_ARTIFACT_INVALID");
    expect(health).toBe(0);
    const valid = fixture();
    const signatureManager = new CodexManagedRuntimeManager({ ...host(root, valid.archive), async verifyDarwinSignature() { return false; } }, valid.manifest);
    expect((await signatureManager.install()).code).toBe("CODEX_RUNTIME_SIGNATURE_INVALID");
  }));
  test("retains completed download evidence when the native health check fails", async () => withRoot(async (root) => {
    const { archive, manifest } = fixture();
    const states: Array<{ phase: string; receivedBytes: number; totalBytes: number; code?: string }> = [];
    const manager = new CodexManagedRuntimeManager({
      ...host(root, archive),
      async health() { return false; },
    }, manifest);
    expect(await manager.install({ onState: (state) => states.push(state) })).toMatchObject({
      code: "CODEX_RUNTIME_UNHEALTHY",
    });
    expect(states.at(-1)).toEqual({
      phase: "failed",
      receivedBytes: archive.byteLength,
      totalBytes: archive.byteLength,
      canCancel: false,
      code: "CODEX_RUNTIME_UNHEALTHY",
    });
  }));
  test("contains observer failures and mid-download cancellation", async () => withRoot(async (root) => {
    const { archive, manifest } = fixture();
    const manager = new CodexManagedRuntimeManager(host(root, archive), manifest);
    expect((await manager.install({ onState() { throw new Error("observer"); } })).state).toBe("ready");
    const controller = new AbortController();
    async function* interrupted() { yield archive.slice(0, 12); controller.abort(); yield archive.slice(12); }
    const cancelled = new CodexManagedRuntimeManager({ ...host(root, archive), async fetch(url) { return { url, status: 200, contentLength: archive.byteLength, body: interrupted() }; } }, manifest);
    expect((await cancelled.install({ signal: controller.signal })).code).toBe("CODEX_RUNTIME_CANCELLED");
  }));
  test("rejects traversal, link, checksum, and truncated tar inputs before health", async () => withRoot(async (root) => {
    const base = fixture();
    const cases = [
      mutateArchive(base.archive, (raw) => { raw.fill(0, 0, 100); raw.set(encoder.encode("../escape")); checksum(raw); }),
      mutateArchive(base.archive, (raw) => { raw[156] = 50; checksum(raw); }),
      mutateArchive(base.archive, (raw) => { raw[0] ^= 1; }),
      base.archive.slice(0, base.archive.byteLength - 12),
    ];
    for (const archive of cases) {
      let health = 0;
      const manager = new CodexManagedRuntimeManager({ ...host(root, archive), async health() { health += 1; return true; } }, forArchive(base.manifest, archive));
      const result = await manager.install();
      expect(result).toMatchObject({ code: "CODEX_RUNTIME_ARTIFACT_INVALID", source: "managed", version: "0.139.0" });
      expect(JSON.stringify(result)).not.toContain(root);
      expect(health).toBe(0);
    }
  }));
  test("rejects a hostile redirect and never repairs managed executable modes during revalidation", async () => withRoot(async (root) => {
    const first = fixture();
    const packageRoot = join(root, "runtimes", "codex", "0.139.0", "darwin-arm64", first.manifest.artifacts["darwin-arm64"].sha256);
    const manager = new CodexManagedRuntimeManager(host(root, first.archive), first.manifest);
    const installed = await manager.install();
    const members = first.manifest.artifacts["darwin-arm64"].package.executableMembers;
    for (const member of members) await chmod(join(packageRoot, member), 0o400);
    expect(await manager.revalidate(installed.handle!)).toBeFalse();
    for (const member of members) expect((await stat(join(packageRoot, member))).mode & 0o777).toBe(0o400);
    const hostile = new CodexManagedRuntimeManager({ ...host(root, first.archive), async fetch() { return { url: "https://evil.example/payload", status: 200, contentLength: first.archive.byteLength, body: chunks(first.archive) }; } }, first.manifest);
    expect((await hostile.install()).code).toBe("CODEX_RUNTIME_ARTIFACT_INVALID");
  }));
  test("rejects managed member tampering and unknown tree entries before active resolution", async () => withRoot(async (root) => {
    const { archive, manifest } = fixture();
    const packageRoot = join(root, "runtimes", "codex", "0.139.0", "darwin-arm64", manifest.artifacts["darwin-arm64"].sha256);
    let health = 0;
    const manager = new CodexManagedRuntimeManager({ ...host(root, archive), async health() { health += 1; return true; } }, manifest);
    await manager.install();
    await writeFile(join(packageRoot, "codex-path", "rg"), "tampered");
    expect(await manager.resolveActive()).toMatchObject({ code: "CODEX_RUNTIME_INSTALL_FAILED", source: "managed", version: "0.139.0" });
    expect(health).toBe(1); // managed install only
    await writeFile(join(packageRoot, "codex-path", "rg"), "rg");
    await mkdir(join(packageRoot, "foreign"));
    expect((await manager.resolveActive()).code).toBe("CODEX_RUNTIME_INSTALL_FAILED");
    expect(health).toBe(1);
  }));
  test("retains leased old release through three catalog installs and rolls back by exact identity", async () => withRoot(async (root) => {
    const v1 = fixture("0.139.0");
    const v2 = fixture("0.140.0");
    const v3 = fixture("0.141.0");
    const archives = {
      [v1.manifest.artifacts["darwin-arm64"].url]: v1.archive,
      [v2.manifest.artifacts["darwin-arm64"].url]: v2.archive,
      [v3.manifest.artifacts["darwin-arm64"].url]: v3.archive,
    };
    const manager = new CodexManagedRuntimeManager(host(root, archives), [v1.manifest, v2.manifest, v3.manifest]);
    const first = await manager.install({ version: "0.139.0" });
    const lease = manager.acquireLease(first.handle!);
    expect(lease).not.toBeNull();
    const second = await manager.install({ version: "0.140.0" });
    const third = await manager.install({ version: "0.141.0" });
    expect(second.handle).not.toBe(third.handle);
    await manager.cleanup();
    const pathFor = (manifest: CodexRuntimeReleaseManifest) => join(root, "runtimes", "codex", manifest.codexVersion, "darwin-arm64", manifest.artifacts["darwin-arm64"].sha256);
    const firstPath = pathFor(v1.manifest);
    const secondPath = pathFor(v2.manifest);
    const thirdPath = pathFor(v3.manifest);
    const entryAt = (path: string) => Bun.file(join(path, "bin", "codex-app-server"));
    expect(await entryAt(firstPath).exists()).toBeTrue();
    expect(await entryAt(secondPath).exists()).toBeTrue();
    expect(await entryAt(thirdPath).exists()).toBeTrue();
    lease?.release();
    await manager.cleanup();
    expect(await entryAt(firstPath).exists()).toBeFalse();
    const rolled = await manager.rollback();
    expect(rolled?.version).toBe("0.140.0");
    expect(rolled?.handle).not.toBe(second.handle);
    await writeFile(join(thirdPath, ".nautilo-managed-release"), "tampered");
    expect(await manager.rollback()).toBeNull();
  }));
  test("refuses a symlink runtime root and a changed root ownership marker", async () => withRoot(async (root) => {
    const { archive, manifest } = fixture();
    const target = join(root, "target");
    const linked = join(root, "linked");
    const managedRoot = join(root, "managed");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linked);
    expect((await new CodexManagedRuntimeManager(host(linked, archive), manifest).install()).code).toBe("CODEX_RUNTIME_INSTALL_FAILED");
    const manager = new CodexManagedRuntimeManager(host(managedRoot, archive), manifest);
    expect((await manager.install()).state).toBe("ready");
    await writeFile(join(managedRoot, ".nautilo-managed-root"), "forged\n");
    expect((await manager.resolveActive()).code).toBe("CODEX_RUNTIME_INSTALL_FAILED");
  }));
  test("serializes mutations from separate managers through the root lock", async () => withRoot(async (root) => {
    const { archive, manifest } = fixture();
    let inFetch = 0;
    let maximum = 0;
    const delayed = { ...host(root, archive), async fetch(url: string) {
      inFetch += 1; maximum = Math.max(maximum, inFetch);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 35));
      inFetch -= 1;
      return { url, status: 200, contentLength: archive.byteLength, body: chunks(archive) };
    } };
    const [first, second] = await Promise.all([
      new CodexManagedRuntimeManager(delayed, manifest).install(),
      new CodexManagedRuntimeManager(delayed, manifest).install(),
    ]);
    expect(first.state).toBe("ready");
    expect(second.state).toBe("ready");
    expect(maximum).toBe(1);
  }));
  test("reclaims only a provably dead lock and leaves a live lock alone until cancellation", async () => withRoot(async (root) => {
    const { archive, manifest } = fixture();
    const seed = new CodexManagedRuntimeManager(host(root, archive), manifest);
    await seed.install();
    const lock = join(root, ".nautilo-mutation-lock");
    const staleNonce = "00000000-0000-4000-8000-000000000001";
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner.json"), JSON.stringify({ schemaVersion: 1, pid: 999999999, nonce: staleNonce }), { mode: 0o600 });
    expect((await new CodexManagedRuntimeManager(host(root, archive), manifest).install()).state).toBe("ready");
    expect(await Bun.file(lock).exists()).toBeFalse();
    const liveNonce = "00000000-0000-4000-8000-000000000002";
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner.json"), JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce: liveNonce }), { mode: 0o600 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    expect((await new CodexManagedRuntimeManager(host(root, archive), manifest).install({ signal: controller.signal })).code).toBe("CODEX_RUNTIME_CANCELLED");
    expect(await readFile(join(lock, "owner.json"), "utf8")).toContain(liveNonce);
    await rm(lock, { recursive: true, force: true });
  }));
  test("recovery does not delete record temps after its mutation lock is lost", async () => withRoot(async (root) => {
    const { archive, manifest } = fixture();
    const manager = new CodexManagedRuntimeManager(host(root, archive), manifest);
    await manager.recoverStaging();
    const temporary = join(root, "state", "active.json.recovery-test.tmp");
    await mkdir(join(root, "state"), { recursive: true, mode: 0o700 });
    await writeFile(temporary, "orphan");
    const internal = manager as unknown as {
      activeMutation: { readonly root: string; readonly nonce: string } | undefined;
      recoverStagingNow(root: string): Promise<void>;
    };
    internal.activeMutation = { root, nonce: "00000000-0000-4000-8000-000000000003" };
    await internal.recoverStagingNow(root);
    expect(await Bun.file(temporary).exists()).toBeTrue();
    internal.activeMutation = undefined;
  }));
  test("resolves only the exact active release offline and fails closed on tampering", async () => withRoot(async (root) => {
    const { archive, manifest } = fixture();
    const installed = await new CodexManagedRuntimeManager(host(root, archive), manifest).install();
    let fetched = 0;
    const offline = new CodexManagedRuntimeManager({ ...host(root, archive), async fetch() { fetched += 1; throw new Error("offline"); } }, manifest);
    expect((await offline.resolveActive()).state).toBe("ready");
    expect(fetched).toBe(0);
    const digest = manifest.artifacts["darwin-arm64"].sha256;
    const release = join(root, "runtimes", "codex", installed.version!, "darwin-arm64", digest);
    await writeFile(join(release, ".nautilo-managed-release"), "tampered");
    expect((await offline.resolveActive()).code).toBe("CODEX_RUNTIME_INSTALL_FAILED");
    await writeFile(join(root, "state", "active.json"), JSON.stringify({ schemaVersion: 1, handle: "opaque-handle-000000000000", version: installed.version, platform: "darwin-arm64", digest, generation: 1, forged: true }));
    expect((await offline.resolveActive()).code).toBe("CODEX_RUNTIME_INSTALL_FAILED");
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await offline.resolveActive({ signal: cancelled.signal })).toMatchObject({ code: "CODEX_RUNTIME_CANCELLED", source: "managed", version: "0.139.0" });
  }));
  test("distinguishes genuinely absent roots and records from malformed or tampered runtime state", async () => withRoot(async (root) => {
    const { archive, manifest } = fixture();
    const missing = new CodexManagedRuntimeManager(host(root, archive), manifest);
    expect((await missing.resolveActive()).code).toBe("CODEX_RUNTIME_NOT_FOUND");
    await missing.recoverStaging();
    expect((await missing.resolveActive()).code).toBe("CODEX_RUNTIME_NOT_FOUND");
    await mkdir(join(root, "state"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "state", "active.json"), "{ malformed");
    expect((await missing.resolveActive()).code).toBe("CODEX_RUNTIME_INSTALL_FAILED");
    await rm(join(root, "state", "active.json"));
    const installed = await missing.install();
    await writeFile(join(root, "state", "active.json"), JSON.stringify({ schemaVersion: 1, handle: "opaque-handle-000000000000", version: installed.version, platform: "darwin-arm64", digest: manifest.artifacts["darwin-arm64"].sha256, generation: 1, forged: true }));
    expect((await missing.resolveActive()).code).toBe("CODEX_RUNTIME_INSTALL_FAILED");
  }));
});
