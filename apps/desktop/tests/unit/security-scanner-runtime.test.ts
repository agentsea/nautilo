import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import {
  PRODUCTION_SECURITY_SCANNER_MANIFEST,
  SecurityScannerRuntimeManager,
  semgrepOfflineScanArguments,
  validateSecurityScannerManifest,
  type SecurityScannerManifest,
} from "../../electron/security-scanner-runtime/index.ts";

const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const binary = new TextEncoder().encode("not-a-real-gitleaks-binary\n");
const digest = sha256(binary);
const notices = Object.freeze({
  url: "https://github.com/gitleaks/gitleaks/blob/master/LICENSE",
  sha256: "1".repeat(64),
  bytes: 1_000,
});

function tarGz(members: readonly { readonly name: string; readonly bytes: Uint8Array }[], trailing = new Uint8Array()): Uint8Array {
  const encoder = new TextEncoder();
  const blocks: Uint8Array[] = [];
  for (const member of members) {
    const header = new Uint8Array(512);
    const write = (offset: number, value: string) => header.set(encoder.encode(value), offset);
    write(0, member.name);
    write(100, "0000700\0");
    write(108, "0000000\0");
    write(116, "0000000\0");
    write(124, `${member.bytes.byteLength.toString(8).padStart(11, "0")}\0`);
    write(136, "00000000000\0");
    header[156] = 48;
    write(257, "ustar\0");
    header.fill(32, 148, 156);
    const checksum = header.reduce((total, byte) => total + byte, 0);
    write(148, `${checksum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header, member.bytes, new Uint8Array((512 - member.bytes.byteLength % 512) % 512));
  }
  blocks.push(new Uint8Array(1_024), trailing);
  const total = blocks.reduce((sum, block) => sum + block.byteLength, 0);
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) { tar.set(block, offset); offset += block.byteLength; }
  return gzipSync(tar);
}

function manifest(overrides: Partial<Record<string, unknown>> = {}): SecurityScannerManifest {
  return {
    schemaVersion: 1,
    allowedDownloadHosts: ["media.nautilo.ai"],
    allowedDownloadPrefixes: { "media.nautilo.ai": ["/security-scanners/"] },
    artifacts: [{
      component: "gitleaks",
      kind: "engine",
      version: "1.0.0",
      platform: "darwin-arm64",
      url: "https://media.nautilo.ai/security-scanners/gitleaks.bin",
      archiveBytes: binary.byteLength,
      sha256: digest,
      format: "binary",
      entrypoint: "bin/gitleaks",
      entrypointSha256: digest,
      license: "MIT",
      source: "https://github.com/gitleaks/gitleaks",
      notices,
    }],
    ...overrides,
  } as SecurityScannerManifest;
}

async function* chunks(value: Uint8Array): AsyncIterable<Uint8Array> { yield value; }

describe("D560 managed security-scanner runtime", () => {
  test("ships one exact media.nautilo.ai identity per supported component and macOS architecture", () => {
    const production = validateSecurityScannerManifest(PRODUCTION_SECURITY_SCANNER_MANIFEST);
    expect(production).not.toBeNull();
    expect(production?.artifacts).toHaveLength(10);
    for (const platform of ["darwin-arm64", "darwin-x64"] as const) {
      expect(production?.artifacts
        .filter((artifact) => artifact.platform === platform)
        .map((artifact) => `${artifact.component}:${artifact.kind}`)
        .sort()).toEqual([
          "gitleaks:engine",
          "osv-scanner:engine",
          "semgrep-nautilo-rules:rules",
          "semgrep:engine",
          "trivy:engine",
        ]);
    }
    expect(production?.artifacts.every((artifact) => artifact.url.startsWith("https://media.nautilo.ai/security-scanners/v1/"))).toBeTrue();
    expect(production?.artifacts.find((artifact) => artifact.component === "semgrep")?.license).toBe("LGPL-2.1-or-later");
    expect(production?.artifacts.find((artifact) => artifact.kind === "rules")?.license).toBe("MIT");
  });

  test("fails closed on a malformed manifest and requires bounded notices provenance", () => {
    expect(validateSecurityScannerManifest({ ...manifest(), allowedDownloadHosts: ["*"] })).toBeNull();
    expect(validateSecurityScannerManifest({
      ...manifest(),
      artifacts: [{ ...manifest().artifacts[0]!, kind: "rules", entrypoint: "bin/semgrep", entrypointSha256: digest }],
    })).toBeNull();
    const engine = manifest().artifacts[0]!;
    const { entrypoint: _entrypoint, entrypointSha256: _entrypointSha256, ...binaryRules } = engine;
    expect(validateSecurityScannerManifest({ ...manifest(), artifacts: [{ ...binaryRules, kind: "rules" }] })).toBeNull();
    expect(validateSecurityScannerManifest({
      ...manifest(),
      artifacts: [{ ...manifest().artifacts[0]!, url: "https://evil.example/security-scanners/gitleaks.bin" }],
    })).toBeNull();
    const artifact = manifest().artifacts[0]!;
    const { notices: _missingNotices, ...missingNotices } = artifact;
    expect(validateSecurityScannerManifest({ ...manifest(), artifacts: [missingNotices] })).toBeNull();
    expect(validateSecurityScannerManifest({ ...manifest(), artifacts: [{ ...artifact, notices: { ...notices, unexpected: true } }] })).toBeNull();
  });

  test("downloads only a manifest-approved response, verifies exact bytes, reuses the exact release, and activates atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-scanner-test-"));
    let fetches = 0;
    const manager = new SecurityScannerRuntimeManager({
      platform: "darwin",
      arch: "arm64",
      runtimeRoot: root,
      async fetch() {
        fetches += 1;
        return { url: "https://media.nautilo.ai/security-scanners/gitleaks.bin", status: 200, contentLength: binary.byteLength, body: chunks(binary) };
      },
      async health(path, version) {
        return version === "1.0.0" && (Number((await stat(path)).mode) & 0o100) !== 0 && Buffer.compare(await readFile(path), binary) === 0;
      },
      now: () => 123,
    }, manifest());
    try {
      const [first, concurrent] = await Promise.all([
        manager.install("gitleaks", "engine"),
        manager.install("gitleaks", "engine"),
      ]);
      expect(fetches).toBe(1);
      expect(first.details).toMatchObject({ state: "ready", component: "gitleaks", generation: 1, fingerprint: `sha256:${digest}` });
      expect(concurrent.internalPath).toBe(first.internalPath);
      expect(first.internalPath).toContain("releases/gitleaks/engine/1.0.0/darwin-arm64");
      const reused = await manager.install("gitleaks", "engine");
      expect(reused.details.generation).toBe(2);
      expect(fetches).toBe(1);
      const active = await manager.resolveActive("gitleaks", "engine");
      expect(active.details).toMatchObject({ state: "ready", generation: 2 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects a redirect/response host outside the reviewed host and retains no active release", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-scanner-test-"));
    const manager = new SecurityScannerRuntimeManager({
      platform: "darwin", arch: "arm64", runtimeRoot: root,
      async fetch() { return { url: "https://evil.example/security-scanners/gitleaks.bin", status: 200, contentLength: binary.byteLength, body: chunks(binary) }; },
      async health() { return true; }, now: () => 1,
    }, manifest());
    try {
      expect((await manager.install("gitleaks", "engine")).details.code).toBe("SECURITY_SCANNER_ARTIFACT_INVALID");
      expect((await manager.resolveActive("gitleaks", "engine")).details.code).toBe("SECURITY_SCANNER_NOT_FOUND");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("does not turn an omitted version into an unreviewed latest selector", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-scanner-test-"));
    const v2 = { ...manifest().artifacts[0]!, version: "2.0.0" };
    const manager = new SecurityScannerRuntimeManager({
      platform: "darwin", arch: "arm64", runtimeRoot: root,
      async fetch() { throw new Error("must not fetch an ambiguous default"); },
      async health() { return true; }, now: () => 1,
    }, manifest({ artifacts: [manifest().artifacts[0]!, v2] }));
    try {
      expect((await manager.install("gitleaks", "engine")).details.code).toBe("SECURITY_SCANNER_NOT_FOUND");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("keeps the prior healthy generation active when a replacement artifact fails verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-scanner-test-"));
    const v2 = { ...manifest().artifacts[0]!, version: "2.0.0", sha256: "0".repeat(64), entrypointSha256: "0".repeat(64) };
    const manager = new SecurityScannerRuntimeManager({
      platform: "darwin", arch: "arm64", runtimeRoot: root,
      async fetch() { return { url: "https://media.nautilo.ai/security-scanners/gitleaks.bin", status: 200, contentLength: binary.byteLength, body: chunks(binary) }; },
      async health(path) { return Buffer.compare(await readFile(path), binary) === 0; }, now: () => 1,
    }, manifest({ artifacts: [manifest().artifacts[0]!, v2] }));
    try {
      expect((await manager.install("gitleaks", "engine", { version: "1.0.0" })).details.state).toBe("ready");
      expect((await manager.install("gitleaks", "engine", { version: "2.0.0" })).details.code).toBe("SECURITY_SCANNER_ARTIFACT_INVALID");
      expect((await manager.resolveActive("gitleaks", "engine")).details).toMatchObject({ state: "ready", version: "1.0.0", generation: 1 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("installs rule content as a distinct non-executable identity and resolves its payload directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-scanner-test-"));
    const rules = tarGz([{ name: "rules/unsafe-input.yml", bytes: new TextEncoder().encode("rules: []\n") }]);
    const ruleArtifact = {
      component: "semgrep-nautilo-rules",
      kind: "rules" as const,
      version: "1.0.0",
      platform: "darwin-arm64" as const,
      url: "https://media.nautilo.ai/security-scanners/semgrep-rules.tar.gz",
      archiveBytes: rules.byteLength,
      sha256: sha256(rules),
      format: "tar.gz" as const,
      license: "MIT",
      source: "https://github.com/nautilo/security-rules",
      notices,
    };
    let healthCalls = 0;
    const manager = new SecurityScannerRuntimeManager({
      platform: "darwin", arch: "arm64", runtimeRoot: root,
      async fetch() { return { url: ruleArtifact.url, status: 200, contentLength: rules.byteLength, body: chunks(rules) }; },
      async health() { healthCalls += 1; return true; }, now: () => 1,
    }, manifest({ artifacts: [ruleArtifact] }));
    try {
      const installed = await manager.install("semgrep-nautilo-rules", "rules");
      expect(installed.details).toMatchObject({ state: "ready", kind: "rules", generation: 1 });
      expect(installed.internalPath).toContain("releases/semgrep-nautilo-rules/rules/1.0.0/darwin-arm64");
      expect((await stat(installed.internalPath!)).isDirectory()).toBeTrue();
      expect(healthCalls).toBe(0);
      expect((await manager.resolveActive("semgrep-nautilo-rules", "rules")).internalPath).toBe(installed.internalPath);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects content after the two-block tar terminator", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-scanner-test-"));
    const archive = tarGz([{ name: "bin/gitleaks", bytes: binary }], new TextEncoder().encode("trailing"));
    const artifact = { ...manifest().artifacts[0]!, format: "tar.gz" as const, archiveBytes: archive.byteLength, sha256: sha256(archive) };
    const manager = new SecurityScannerRuntimeManager({
      platform: "darwin", arch: "arm64", runtimeRoot: root,
      async fetch() { return { url: artifact.url, status: 200, contentLength: archive.byteLength, body: chunks(archive) }; },
      async health() { return true; }, now: () => 1,
    }, manifest({ artifacts: [artifact] }));
    try {
      expect((await manager.install("gitleaks", "engine")).details.code).toBe("SECURITY_SCANNER_ARTIFACT_INVALID");
      expect((await manager.resolveActive("gitleaks", "engine")).details.code).toBe("SECURITY_SCANNER_NOT_FOUND");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("accepts all-zero tar padding after the terminator", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-scanner-test-"));
    const archive = tarGz([{ name: "bin/gitleaks", bytes: binary }], new Uint8Array(1_024));
    const artifact = { ...manifest().artifacts[0]!, format: "tar.gz" as const, archiveBytes: archive.byteLength, sha256: sha256(archive) };
    const manager = new SecurityScannerRuntimeManager({
      platform: "darwin", arch: "arm64", runtimeRoot: root,
      async fetch() { return { url: artifact.url, status: 200, contentLength: archive.byteLength, body: chunks(archive) }; },
      async health() { return true; }, now: () => 1,
    }, manifest({ artifacts: [artifact] }));
    try {
      expect((await manager.install("gitleaks", "engine")).details.state).toBe("ready");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("uses only fixed offline Semgrep arguments and preserves repository ignore semantics", () => {
    expect(semgrepOfflineScanArguments({ localRulesPath: "/managed/rules", targetPath: "/workspace" })).toEqual([
      "scan", "--config", "/managed/rules", "--metrics=off", "--disable-version-check", "--json", "/workspace",
    ]);
    expect(() => semgrepOfflineScanArguments({ localRulesPath: "/managed/../rules", targetPath: "/workspace" })).toThrow("semgrep_requires_local_absolute_paths");
  });
});
