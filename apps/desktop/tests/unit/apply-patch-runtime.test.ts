import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveApplyPatchDesktopRuntime,
  resolveElectronApplyPatchDesktopRuntime,
} from "../../electron/apply-patch-runtime";
import { hasExpectedDesignatedRequirement } from "../../scripts/verify-apply-patch-signature";
import {
  parseBuildMode,
  platformKeyForHostArch,
  platformKeysForBuild,
  verifySourceBuiltApplyPatchCandidate,
} from "../../scripts/build-apply-patch";
import { getApplyPatchDesktopManifestEntry, parseToolRuntimesManifest } from "../../electron/tool-runtimes-manifest";

const desktopRoot = join(import.meta.dir, "../..");

function versionJson(entry: ReturnType<typeof getApplyPatchDesktopManifestEntry>): string {
  return JSON.stringify({ runtime_version: entry.version, protocol: entry.protocol, upstream_revision: entry.provenance.upstreamRevision, nautilo_extraction_revision: entry.provenance.nautiloExtractionRevision, provenance: { format: entry.provenance.format, upstream_revision: entry.provenance.upstreamRevision, license_sha256: entry.provenance.licenseSha256, notice_sha256: entry.provenance.noticeSha256 } });
}

function sourceBuildReceipt(hashes: Partial<Record<"darwin-arm64" | "darwin-x64", string>>): string {
  const raw = JSON.parse(readFileSync(join(desktopRoot, "vendor/tool-runtimes.manifest.json"), "utf8")) as { "apply-patch": { artifacts: Record<string, Record<string, unknown>> } };
  for (const [platformKey, sha256] of Object.entries(hashes)) raw["apply-patch"].artifacts[platformKey]!.sha256 = sha256;
  return JSON.stringify({ "apply-patch": raw["apply-patch"] });
}

test("Darwin source resolution requires a generated local source-build receipt", () => {
  const resolution = resolveApplyPatchDesktopRuntime({
    resourcesPath: null,
    devVendorRoot: join(tmpdir(), `d448-missing-build-output-${Date.now()}`),
    platform: "darwin",
    arch: "arm64",
  });
  expect(resolution).toEqual({
    ok: false,
    code: "runtime_unavailable",
    reason: "MANIFEST_MISSING",
    message: "Nautilo apply-patch runtime manifest is unavailable.",
  });
});

test("source-build mode has explicit host and universal target plans", () => {
  expect(parseBuildMode([])).toBe("host");
  expect(parseBuildMode(["universal"])).toBe("universal");
  expect(() => parseBuildMode(["release-asset"])).toThrow(/usage/);
  expect(platformKeyForHostArch("arm64")).toBe("darwin-arm64");
  expect(platformKeyForHostArch("x64")).toBe("darwin-x64");
  expect(() => platformKeyForHostArch("ia32")).toThrow(/support/);
  expect(platformKeysForBuild("host", "arm64")).toEqual(["darwin-arm64"]);
  expect(platformKeysForBuild("universal", "arm64")).toEqual(["darwin-arm64", "darwin-x64"]);
});

test("designated requirement parser accepts codesign team clause variants only with all required bindings", () => {
  expect(hasExpectedDesignatedRequirement('designated => anchor apple generic and identifier "nautilo-apply-patch" and certificate leaf[subject.OU] = "ABCDE12345"', "ABCDE12345")).toBe(true);
  expect(hasExpectedDesignatedRequirement('anchor apple generic and identifier "nautilo-apply-patch" and certificate leaf[subject.OU] = ABCDE12345', "ABCDE12345")).toBe(true);
  expect(hasExpectedDesignatedRequirement('identifier "nautilo-apply-patch" and certificate leaf[subject.OU] = "ABCDE12345"', "ABCDE12345")).toBe(false);
});

test("source-build verifier checks both Darwin architectures and rejects wrong arch or provenance without executing bytes", () => {
  const base = getApplyPatchDesktopManifestEntry(parseToolRuntimesManifest(readFileSync(join(desktopRoot, "vendor/tool-runtimes.manifest.json"), "utf8")));
  for (const [platformKey, cpu] of [["darwin-arm64", 0x0100000c], ["darwin-x64", 0x01000007]] as const) {
    const path = join(tmpdir(), `d448-candidate-${platformKey}-${Date.now()}`); const bytes = Buffer.alloc(100_000); bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(cpu, 4); writeFileSync(path, bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const entry = getApplyPatchDesktopManifestEntry(parseToolRuntimesManifest(sourceBuildReceipt({ [platformKey]: sha })));
    expect(verifySourceBuiltApplyPatchCandidate(path, platformKey, sha, versionJson(entry), entry).sha256).toBe(sha);
  }
  const wrongPath = join(tmpdir(), `d448-candidate-wrong-${Date.now()}`); const wrongBytes = Buffer.alloc(100_000); wrongBytes.writeUInt32LE(0xfeedfacf, 0); wrongBytes.writeUInt32LE(0x01000007, 4); writeFileSync(wrongPath, wrongBytes);
  const wrongSha = createHash("sha256").update(wrongBytes).digest("hex");
  const x64Entry = getApplyPatchDesktopManifestEntry(parseToolRuntimesManifest(sourceBuildReceipt({ "darwin-x64": wrongSha })));
  expect(() => verifySourceBuiltApplyPatchCandidate(wrongPath, "darwin-arm64", wrongSha, versionJson(base), base)).toThrow(/source-build SHA/);
  expect(() => verifySourceBuiltApplyPatchCandidate(wrongPath, "darwin-x64", wrongSha, "{}", x64Entry)).toThrow(/version/);
});

test("source-build receipts and signed-package verification use distinct integrity boundaries", () => {
  const buildScript = readFileSync(join(desktopRoot, "scripts/build-apply-patch.ts"), "utf8");
  const signatureScript = readFileSync(join(desktopRoot, "scripts/verify-apply-patch-signature.ts"), "utf8");
  expect(buildScript).toContain("candidate source-build SHA-256 mismatch");
  expect(buildScript).toContain('rustBuildCommand("cargo"), ["build"');
  expect(buildScript).toContain("--locked");
  expect(buildScript).toContain("rustup");
  expect(buildScript).not.toMatch(/fetchAndVerifyVendoredBinary|releaseAssetBearerTokenFile|GITHUB_TOKEN|Authorization/);
  expect(signatureScript).toContain("--verify");
  expect(signatureScript).toContain("--strict");
  expect(signatureScript).toContain("-r-");
  expect(signatureScript).toContain("APPLE_TEAM_ID");
  expect(signatureScript).toContain('identifier "nautilo-apply-patch"');
  expect(signatureScript).toContain("stapler");
  expect(signatureScript).toContain("spctl");
  expect(signatureScript).not.toContain("sha256");
});

test("generated source-build receipts require executable Mach-O bytes and exact injected version identity", () => {
  const root = join(tmpdir(), `d448-apply-patch-${Date.now()}`);
  const binary = join(root, "apply-patch", "darwin-arm64", "nautilo-apply-patch");
  mkdirSync(join(binary, ".."), { recursive: true });
  const bytes = Buffer.alloc(100_000); bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x0100000c, 4);
  writeFileSync(binary, bytes); chmodSync(binary, 0o755);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const receipt = sourceBuildReceipt({ "darwin-arm64": sha });
  mkdirSync(join(root, "apply-patch"), { recursive: true });
  writeFileSync(join(root, "apply-patch", "runtime-manifest.json"), receipt);
  const entry = getApplyPatchDesktopManifestEntry(parseToolRuntimesManifest(receipt));
  const ok = resolveApplyPatchDesktopRuntime({ resourcesPath: null, devVendorRoot: root, platform: "darwin", arch: "arm64", versionJsonRunner: () => versionJson(entry) });
  expect(ok.ok).toBe(true);
  const electronDev = resolveApplyPatchDesktopRuntime({
    isPackaged: false,
    resourcesPath: join(root, "electron-framework-resources"),
    devVendorRoot: root,
    platform: "darwin",
    arch: "arm64",
    versionJsonRunner: () => versionJson(entry),
  });
  expect(electronDev).toMatchObject({ ok: true, origin: "source", integrity: "pristine-byte-sha256" });
  expect(resolveElectronApplyPatchDesktopRuntime({
    isPackaged: null,
    resourcesPath: join(root, "electron-framework-resources"),
    devVendorRoot: root,
    platform: "darwin",
    arch: "arm64",
    versionJsonRunner: () => versionJson(entry),
  })).toMatchObject({ ok: false, reason: "PACKAGING_STATE_UNAVAILABLE" });
  const resources = join(root, "resources", "tools-apply-patch");
  mkdirSync(join(resources, "darwin-arm64"), { recursive: true });
  writeFileSync(join(resources, "runtime-manifest.json"), receipt);
  writeFileSync(join(resources, "darwin-arm64", "nautilo-apply-patch"), bytes);
  chmodSync(join(resources, "darwin-arm64", "nautilo-apply-patch"), 0o755);
  const packaged = resolveApplyPatchDesktopRuntime({ resourcesPath: join(root, "resources"), devVendorRoot: root, platform: "darwin", arch: "arm64", versionJsonRunner: () => versionJson(entry) });
  expect(packaged).toMatchObject({ ok: true, origin: "packaged", integrity: "package-signature-boundary" });
  const wrong = resolveApplyPatchDesktopRuntime({ resourcesPath: null, devVendorRoot: root, platform: "darwin", arch: "arm64", versionJsonRunner: () => "{}" });
  expect(wrong).toMatchObject({ ok: false, reason: "VERSION_HANDSHAKE_FAILED" });
});
