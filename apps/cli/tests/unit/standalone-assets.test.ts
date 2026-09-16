import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { setHostPortLivenessProbeExecutableForProcess } from "@nautilo/config";

import {
  createStandaloneAssetManifest,
  parseStandaloneAssetManifest,
  resolveStandaloneAssets,
  STANDALONE_RUNTIME_ASSET_PATHS,
  verifyStandaloneAssetManifest,
} from "../../src/lib/standalone-assets.ts";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nautilo-standalone-assets-"));
  roots.push(root);
  return root;
}

function writeRuntimeAssets(root: string): void {
  for (const assetPath of STANDALONE_RUNTIME_ASSET_PATHS) {
    const path = join(root, assetPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${assetPath}\n`, {
      mode: assetPath.endsWith(".sh") || assetPath.endsWith("host-port-probe") ? 0o755 : 0o644,
    });
  }
}

afterEach(() => {
  setHostPortLivenessProbeExecutableForProcess(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("standalone server-admin assets", () => {
  test("seals and verifies the exact runtime asset allowlist", () => {
    const root = makeRoot();
    writeRuntimeAssets(root);
    const manifest = createStandaloneAssetManifest({
      assetRoot: root,
      version: "0.1.0",
      source: "a".repeat(40),
      platform: "darwin-arm64",
    });

    expect(manifest.assets.map((asset) => asset.path)).toEqual([
      "bin/host-port-probe",
      "deploy/compose-driver/templates/docker-compose.yml",
      "infra/postgres-init.sh",
    ]);
    expect(verifyStandaloneAssetManifest(root, manifest)).toEqual(manifest);
  });

  test("fails closed on tamper, missing, unexpected, symlink, and mode drift", () => {
    const root = makeRoot();
    writeRuntimeAssets(root);
    const manifest = createStandaloneAssetManifest({
      assetRoot: root,
      version: "0.1.0",
      source: "b".repeat(40),
      platform: "darwin-arm64",
    });
    const compose = join(root, "deploy/compose-driver/templates/docker-compose.yml");

    writeFileSync(compose, "tampered\n");
    expect(() => verifyStandaloneAssetManifest(root, manifest)).toThrow(/integrity check failed/);
    writeRuntimeAssets(root);

    rmSync(compose);
    expect(() => verifyStandaloneAssetManifest(root, manifest)).toThrow(/missing or unexpected/);
    writeRuntimeAssets(root);

    writeFileSync(join(root, "unexpected.txt"), "unexpected\n");
    expect(() => verifyStandaloneAssetManifest(root, manifest)).toThrow(/missing or unexpected/);
    rmSync(join(root, "unexpected.txt"));

    rmSync(compose);
    symlinkSync(join(root, "bin/host-port-probe"), compose);
    expect(() => verifyStandaloneAssetManifest(root, manifest)).toThrow(/rejects symlink/);
    rmSync(compose);
    writeFileSync(compose, "deploy/compose-driver/templates/docker-compose.yml\n", { mode: 0o600 });
    chmodSync(compose, 0o600);
    expect(() => verifyStandaloneAssetManifest(root, manifest)).toThrow(/mode check failed/);
  });

  test("rejects traversal, duplicate, absolute, and malformed manifest entries", () => {
    const root = makeRoot();
    writeRuntimeAssets(root);
    const manifest = createStandaloneAssetManifest({
      assetRoot: root,
      version: "0.1.0",
      source: "c".repeat(40),
      platform: "darwin-arm64",
    });
    const invalid = structuredClone(manifest) as { assets: Array<{ path: string }> };
    invalid.assets[0]!.path = "../escape";
    expect(() => parseStandaloneAssetManifest(invalid)).toThrow(/safe relative POSIX path/);

    const duplicate = structuredClone(manifest) as { assets: Array<{ path: string }> };
    duplicate.assets[1]!.path = duplicate.assets[0]!.path;
    expect(() => parseStandaloneAssetManifest(duplicate)).toThrow(/duplicate asset path/);

    const absolute = structuredClone(manifest) as { assets: Array<{ path: string }> };
    absolute.assets[0]!.path = "/absolute";
    expect(() => parseStandaloneAssetManifest(absolute)).toThrow(/safe relative POSIX path/);

    const badSource = structuredClone(manifest) as { source: string };
    badSource.source = "not-a-source";
    expect(() => parseStandaloneAssetManifest(badSource)).toThrow(/40-character git commit ID/);

    const badVersion = structuredClone(manifest) as { version: string };
    badVersion.version = "release/0.1.0";
    expect(() => parseStandaloneAssetManifest(badVersion)).toThrow(/strict semver-compatible/);

    const numericPrerelease = structuredClone(manifest) as { version: string };
    numericPrerelease.version = "0.1.0-1";
    expect(parseStandaloneAssetManifest(numericPrerelease).version).toBe("0.1.0-1");

    const leadingZeroPrerelease = structuredClone(manifest) as { version: string };
    leadingZeroPrerelease.version = "0.1.0-01";
    expect(() => parseStandaloneAssetManifest(leadingZeroPrerelease)).toThrow(
      /strict semver-compatible/,
    );

    const badPlatform = structuredClone(manifest) as { platform: string };
    badPlatform.platform = "linux-arm64";
    expect(() => parseStandaloneAssetManifest(badPlatform)).toThrow(/unsupported platform/);

    const extra = structuredClone(manifest) as { assets: Array<Record<string, unknown>> };
    extra.assets.push({
      path: "extra.txt",
      size: 0,
      sha256: "0".repeat(64),
      mode: 0o644,
    });
    expect(() => verifyStandaloneAssetManifest(root, extra)).toThrow(/frozen runtime allowlist/);
  });

  test("compiled execution selects only verified sibling share assets and cannot use a checkout fallback", () => {
    const root = makeRoot();
    const bundle = join(root, "nautilo-cli-0.1.0-darwin-arm64");
    const assetRoot = join(bundle, "share/nautilo");
    const executable = join(bundle, "bin/nautilo");
    writeRuntimeAssets(assetRoot);
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, "binary placeholder\n", { mode: 0o755 });
    const manifest = createStandaloneAssetManifest({
      assetRoot,
      version: "0.1.0",
      source: "d".repeat(40),
      platform: "darwin-arm64",
    });
    writeFileSync(join(bundle, "artifact-manifest.json"), `${JSON.stringify(manifest)}\n`);

    const resolved = resolveStandaloneAssets({
      compiled: true,
      execPath: executable,
      moduleDir: process.cwd(),
    });
    expect(resolved.source).toBe("standalone");
    expect(resolved.assetRoot).toBe(assetRoot);
    expect(resolved.templateDir).toBe(join(assetRoot, "deploy/compose-driver/templates"));

    rmSync(join(bundle, "artifact-manifest.json"));
    expect(() => resolveStandaloneAssets({ compiled: true, execPath: executable, moduleDir: process.cwd() })).toThrow(
      /Standalone artifact manifest is unreadable/,
    );
  });
});
