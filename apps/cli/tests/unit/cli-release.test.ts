import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalCliReleaseBytes, installStableCliRelease, parseAndVerifyCliReleaseManifest, rollbackCliRelease, type CliInstallRoots, type CliReleaseManifestBody, type SignedCliReleaseManifest } from "../../src/lib/cli-release.ts";

const source = "a".repeat(40);
function target(platform: "darwin-arm64" | "darwin-x64", version = "0.1.0") {
  const prefix = `https://media.nautilo.ai/cli/releases/${version}`;
  return {
    platform,
    archive: { filename: `nautilo-cli-${version}-${platform}.tar.gz`, url: `${prefix}/nautilo-cli-${version}-${platform}.tar.gz`, size: 1, sha256: "b".repeat(64), sha512: "c".repeat(128) },
    evidence: { filename: `nautilo-cli-${version}-${platform}.evidence.tar.gz`, url: `${prefix}/nautilo-cli-${version}-${platform}.evidence.tar.gz`, size: 1, sha256: "d".repeat(64) },
    installer: { filename: `install-nautilo-${platform}`, url: `${prefix}/install-nautilo-${platform}`, size: 1, sha256: "e".repeat(64) },
  } as const;
}
function signed(version = "0.1.0"): { value: SignedCliReleaseManifest; publicKey: string } {
  const pair = generateKeyPairSync("ed25519");
  const manifest: CliReleaseManifestBody = { schemaVersion: 1, channel: "stable", version, source, targets: [target("darwin-arm64", version), target("darwin-x64", version)] };
  const signature = sign(null, canonicalCliReleaseBytes(manifest as never), pair.privateKey).toString("base64");
  return { value: { manifest, signature: { algorithm: "ed25519", keyId: "test-key", value: signature } }, publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
}

describe("signed CLI release", () => {
  test("accepts only an exact signed two-platform manifest under an explicit trust root", () => {
    const fixture = signed();
    expect(parseAndVerifyCliReleaseManifest(fixture.value, { "test-key": fixture.publicKey }).manifest.version).toBe("0.1.0");
    expect(() => parseAndVerifyCliReleaseManifest(fixture.value, {})).toThrow(/not trusted/);
    const tampered = structuredClone(fixture.value) as unknown as { manifest: { source: string } };
    tampered.manifest.source = "f".repeat(40);
    expect(() => parseAndVerifyCliReleaseManifest(tampered, { "test-key": fixture.publicKey })).toThrow(/invalid/);
  });

  test("rejects public-origin drift, extra keys, and incomplete targets", () => {
    const fixture = signed();
    const origin = structuredClone(fixture.value) as unknown as { manifest: { targets: Array<{ archive: { url: string } }> } };
    origin.manifest.targets[0]!.archive.url = "https://example.com/cli/releases/0.1.0/file";
    expect(() => parseAndVerifyCliReleaseManifest(origin, { "test-key": fixture.publicKey })).toThrow(/artifact/);
    const extra = structuredClone(fixture.value) as unknown as { manifest: Record<string, unknown> };
    extra.manifest["latest"] = true;
    expect(() => parseAndVerifyCliReleaseManifest(extra, { "test-key": fixture.publicKey })).toThrow(/body/);
  });
});

function archive(root: string, version: string): Buffer {
  const bundle = `nautilo-cli-${version}-darwin-arm64`;
  const bundleRoot = join(root, bundle);
  mkdirSync(join(bundleRoot, "bin"), { recursive: true });
  writeFileSync(join(bundleRoot, "bin", "nautilo"), `#!/bin/sh\nprintf 'nautilo ${version} (api 0.1.0)\\n'\n`);
  chmodSync(join(bundleRoot, "bin", "nautilo"), 0o755);
  writeFileSync(join(bundleRoot, "artifact-manifest.json"), "{}\n");
  const path = join(root, `${bundle}.tar.gz`);
  const result = Bun.spawnSync(["tar", "-czf", path, "-C", root, bundle], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("fixture archive failed");
  return readFileSync(path);
}
function installManifest(bytes: Buffer, version: string): SignedCliReleaseManifest {
  const base = target("darwin-arm64", version);
  const arm = { ...base, archive: { ...base.archive, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), sha512: createHash("sha512").update(bytes).digest("hex") } };
  return { manifest: { schemaVersion: 1, channel: "stable", version, source, targets: [arm, target("darwin-x64", version)] }, signature: { algorithm: "ed25519", keyId: "test", value: "AA==" } };
}

describe("CLI install transaction", () => {
  test("activates verified bytes atomically, preserves one prior version, and rolls back", async () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-cli-release-test-"));
    const roots: CliInstallRoots = { share: join(root, "share"), bin: join(root, "bin") };
    try {
      const first = archive(root, "0.1.0");
      await installStableCliRelease({ roots, platform: "darwin-arm64", manifest: installManifest(first, "0.1.0"), fetchArchive: async () => first });
      expect(readlinkSync(join(roots.share, "current"))).toContain("0.1.0");
      const second = archive(root, "0.1.1");
      await installStableCliRelease({ roots, platform: "darwin-arm64", manifest: installManifest(second, "0.1.1"), fetchArchive: async () => second });
      expect(readlinkSync(join(roots.share, "previous"))).toContain("0.1.0");
      expect(rollbackCliRelease(roots).version).toBe("0.1.0");
      expect(readlinkSync(join(roots.share, "previous"))).toContain("0.1.1");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("rejects digest drift without changing an installed version", async () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-cli-release-test-"));
    const roots: CliInstallRoots = { share: join(root, "share"), bin: join(root, "bin") };
    try {
      const bytes = archive(root, "0.1.0");
      const manifest = installManifest(bytes, "0.1.0");
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(installStableCliRelease({ roots, platform: "darwin-arm64", manifest, fetchArchive: async () => Buffer.from("wrong") })).rejects.toThrow(/wrong size|wrong digest/);
      expect(() => readlinkSync(join(roots.share, "current"))).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
