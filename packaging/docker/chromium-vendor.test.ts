import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHROMIUM_VENDOR_MANIFEST,
  vendorChromium,
  type ChromiumPlatform,
  type ChromiumVendorManifest,
} from "./chromium-vendor.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temporary(): { root: string; outputDir: string } {
  const root = mkdtempSync(join(tmpdir(), "chromium-vendor-test-"));
  roots.push(root);
  return { root, outputDir: join(root, "browser") };
}
interface FixtureEntry { readonly path: string; readonly content?: string; readonly mode?: number }
const ZIP_FIXTURE = `
import base64, io, json, sys, zipfile
output = io.BytesIO()
with zipfile.ZipFile(output, 'w') as archive:
    for entry in json.load(sys.stdin):
        item = zipfile.ZipInfo(entry['path'])
        item.create_system = 3
        item.external_attr = entry.get('mode', 0o100644) << 16
        archive.writestr(item, base64.b64decode(entry.get('content', '')))
sys.stdout.buffer.write(output.getvalue())
`;
function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function fixture(platform: ChromiumPlatform, extra: readonly FixtureEntry[] = [], machineOverride?: number): {
  archive: Buffer; manifest: ChromiumVendorManifest; executable: Buffer;
} {
  const executable = Buffer.alloc(64);
  executable.write("7f454c46", 0, "hex");
  executable[4] = 2;
  executable[5] = 1;
  executable.writeUInt16LE(machineOverride ?? (platform === "linux/amd64" ? 62 : 183), 18);
  const archiveRoot = CHROMIUM_VENDOR_MANIFEST.targets[platform].archiveRoot;
  const resources = ["LICENSE.headless_shell", "ABOUT", "deb.deps", "icudtl.dat",
    "headless_command_resources.pak", "headless_lib_data.pak", "headless_lib_strings.pak",
    "libEGL.so", "libGLESv2.so", "libvk_swiftshader.so", "libvulkan.so.1",
    "vk_swiftshader_icd.json", "v8_context_snapshot.bin", "locales/en-US.pak", "hyphen-data/en-us.hyb"];
  const entries: FixtureEntry[] = [
    { path: `${archiveRoot}/chrome-headless-shell`, content: executable.toString("base64"), mode: 0o100755 },
    ...resources.map((name) => ({ path: `${archiveRoot}/${name}`, content: Buffer.from(name).toString("base64") })),
    ...extra,
  ];
  const result = spawnSync("python3", ["-c", ZIP_FIXTURE], { input: JSON.stringify(entries) });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  const archive = result.stdout;
  return { archive, executable, manifest: {
    ...CHROMIUM_VENDOR_MANIFEST,
    targets: { ...CHROMIUM_VENDOR_MANIFEST.targets, [platform]: {
      ...CHROMIUM_VENDOR_MANIFEST.targets[platform], sha256: sha256(archive), size: archive.length,
      executableSha256: sha256(executable),
    } },
  } };
}
function fixtureFetch(archive: Buffer, observed?: (url: string) => void): typeof fetch {
  const runner = (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> => {
    observed?.(String(args[0]));
    return Promise.resolve(new Response(Uint8Array.from(archive), { status: 200 }));
  };
  return Object.assign(runner, { preconnect: fetch.preconnect });
}

test.each(["linux/amd64", "linux/arm64"] as const)("vendors the complete pinned resource tree for %s", async (platform) => {
  const { root, outputDir } = temporary();
  const selected = fixture(platform);
  let requests = 0;
  await vendorChromium({ platform, outputDir, manifest: selected.manifest,
    fetchImpl: fixtureFetch(selected.archive, (url) => {
      expect(url).toBe(selected.manifest.targets[platform].url);
      requests++;
    }) });
  expect(requests).toBe(1);
  expect(readFileSync(join(outputDir, "chrome-headless-shell")).toString("hex")).toBe(selected.executable.toString("hex"));
  expect(statSync(join(outputDir, "chrome-headless-shell")).mode & 0o777).toBe(0o755);
  for (const file of ["LICENSE.headless_shell", "ABOUT", "deb.deps", "locales/en-US.pak", "hyphen-data/en-us.hyb", "libEGL.so"]) {
    expect(readFileSync(join(outputDir, file), "utf8")).toBe(file);
  }
  expect(JSON.parse(readFileSync(join(outputDir, "artifact-manifest.json"), "utf8"))).toEqual({
    schemaVersion: 1, version: CHROMIUM_VENDOR_MANIFEST.version, platform,
    archiveSha256: selected.manifest.targets[platform].sha256,
    executableSha256: sha256(selected.executable), url: selected.manifest.targets[platform].url,
  });
  expect(readdirSync(root)).toEqual(["browser"]);
});

test("rejects an unsupported platform before fetching or writing", async () => {
  const { root, outputDir } = temporary();
  let requests = 0;
  await expect(vendorChromium({ platform: "linux/riscv64", outputDir,
    fetchImpl: fixtureFetch(Buffer.from("invalid"), () => { requests++; }) })).rejects.toThrow("requires linux/amd64 or linux/arm64");
  expect(requests).toBe(0);
  expect(readdirSync(root)).toEqual([]);
});

test("rejects a platform/URL contract mismatch before fetching", async () => {
  const { root, outputDir } = temporary();
  const selected = fixture("linux/arm64");
  const changed: ChromiumVendorManifest = { ...selected.manifest, targets: { ...selected.manifest.targets,
    "linux/arm64": { ...selected.manifest.targets["linux/arm64"], url: selected.manifest.targets["linux/amd64"].url } } };
  let requests = 0;
  await expect(vendorChromium({ platform: "linux/arm64", outputDir, manifest: changed,
    fetchImpl: fixtureFetch(selected.archive, () => { requests++; }) })).rejects.toThrow("Invalid Chromium artifact manifest");
  expect(requests).toBe(0);
  expect(readdirSync(root)).toEqual([]);
});

test("a download hash mismatch refuses even an unsafe archive before extraction", async () => {
  const { root, outputDir } = temporary();
  const selected = fixture("linux/amd64");
  const tampered = fixture("linux/amd64", [{ path: "../escape" }]);
  await expect(vendorChromium({ platform: "linux/amd64", outputDir, manifest: selected.manifest,
    fetchImpl: fixtureFetch(tampered.archive) })).rejects.toThrow("sha256 mismatch");
  expect(existsSync(outputDir)).toBe(false);
  expect(readdirSync(root)).toEqual([]);
});

test.each([
  ["absolute", "/outside", 0o100644],
  ["traversal", "chrome-headless-shell-linux64/../outside", 0o100644],
  ["backslash", "chrome-headless-shell-linux64/dir\\outside", 0o100644],
  ["wrong root", "another-root/file", 0o100644],
  ["symlink", "chrome-headless-shell-linux64/link", 0o120777],
  ["FIFO", "chrome-headless-shell-linux64/pipe", 0o010600],
  ["device", "chrome-headless-shell-linux64/device", 0o020600],
  ["duplicate", "chrome-headless-shell-linux64/ABOUT", 0o100644],
] as const)("rejects a hash-pinned ZIP containing %s entries without installing anything", async (_name, path, mode) => {
  const { root, outputDir } = temporary();
  const selected = fixture("linux/amd64", [{ path, mode }]);
  await expect(vendorChromium({ platform: "linux/amd64", outputDir, manifest: selected.manifest,
    fetchImpl: fixtureFetch(selected.archive) })).rejects.toThrow("Chromium ZIP extraction refused");
  expect(existsSync(outputDir)).toBe(false);
  expect(readdirSync(root)).toEqual([]);
});

test("rejects mismatched executable content after a verified archive", async () => {
  const { root, outputDir } = temporary();
  const selected = fixture("linux/amd64");
  const changed: ChromiumVendorManifest = { ...selected.manifest, targets: { ...selected.manifest.targets,
    "linux/amd64": { ...selected.manifest.targets["linux/amd64"], executableSha256: "0".repeat(64) } } };
  await expect(vendorChromium({ platform: "linux/amd64", outputDir, manifest: changed,
    fetchImpl: fixtureFetch(selected.archive) })).rejects.toThrow("executable hash");
  expect(readdirSync(root)).toEqual([]);
});

test("rejects wrong ELF architecture despite matching archive and executable hashes", async () => {
  const { root, outputDir } = temporary();
  const selected = fixture("linux/amd64", [], 183);
  await expect(vendorChromium({ platform: "linux/amd64", outputDir, manifest: selected.manifest,
    fetchImpl: fixtureFetch(selected.archive) })).rejects.toThrow("ELF architecture");
  expect(readdirSync(root)).toEqual([]);
});

test("rejects an archive size mismatch and preserves existing output", async () => {
  const { root, outputDir } = temporary();
  const selected = fixture("linux/amd64");
  const changed: ChromiumVendorManifest = { ...selected.manifest, targets: { ...selected.manifest.targets,
    "linux/amd64": { ...selected.manifest.targets["linux/amd64"], size: selected.archive.length + 1 } } };
  await expect(vendorChromium({ platform: "linux/amd64", outputDir, manifest: changed,
    fetchImpl: fixtureFetch(selected.archive) })).rejects.toThrow("archive size");
  expect(readdirSync(root)).toEqual([]);
  writeFileSync(outputDir, "keep existing bytes");
  await expect(vendorChromium({ platform: "linux/amd64", outputDir,
    fetchImpl: fixtureFetch(selected.archive) })).rejects.toThrow("refusing to overwrite");
  expect(readFileSync(outputDir, "utf8")).toBe("keep existing bytes");
});
