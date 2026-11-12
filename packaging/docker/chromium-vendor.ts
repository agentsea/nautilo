import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fetchAndVerifyVendoredBinary } from "../../packages/config/src/vendored-binary-fetch.ts";
import manifest from "./chromium-artifacts.json";

export type ChromiumPlatform = "linux/amd64" | "linux/arm64";
export interface ChromiumArtifact {
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
  readonly archiveRoot: string;
  readonly executableSha256: string;
}
export interface ChromiumVendorManifest {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly targets: Readonly<Record<ChromiumPlatform, ChromiumArtifact>>;
}

function platformKey(value: string): ChromiumPlatform {
  if (value === "linux/amd64" || value === "linux/arm64") return value;
  throw new Error("Chromium vendor requires linux/amd64 or linux/arm64.");
}

function validateManifest(value: typeof manifest): ChromiumVendorManifest {
  if (value.schemaVersion !== 1 || !/^\d+\.\d+\.\d+\.\d+$/.test(value.version)) {
    throw new Error("Invalid Chromium artifact manifest version.");
  }
  for (const platform of ["linux/amd64", "linux/arm64"] as const) {
    const artifact = value.targets[platform];
    const upstreamPlatform = platform === "linux/amd64" ? "linux64" : "linux-arm64";
    const root = `chrome-headless-shell-${upstreamPlatform}`;
    if (artifact.archiveRoot !== root ||
      artifact.url !== `https://storage.googleapis.com/chrome-for-testing-public/${value.version}/${upstreamPlatform}/${root}.zip` ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) || !/^[a-f0-9]{64}$/.test(artifact.executableSha256) ||
      !Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
      throw new Error(`Invalid Chromium artifact manifest for ${platform}.`);
    }
  }
  return { schemaVersion: 1, version: value.version, targets: value.targets };
}

// Stable-channel metadata: https://googlechromelabs.github.io/chrome-for-testing/
// Archive and executable hashes bind the exact bytes, not a mutable channel.
export const CHROMIUM_VENDOR_MANIFEST: ChromiumVendorManifest = validateManifest(manifest);

// Python's standard ZIP parser is build tooling only. Validate every entry
// before writing any bytes; never use ZipFile.extract/all or archive modes.
const EXTRACT_ZIP = `
import pathlib, shutil, stat, sys, zipfile
archive, destination, expected_root = sys.argv[1:]
root = pathlib.Path(destination)
try:
    with zipfile.ZipFile(archive) as bundle:
        selected = []
        seen = set()
        for item in bundle.infolist():
            name = item.filename
            if not name or name.startswith('/') or '\\\\' in name:
                raise ValueError('absolute or backslash archive path')
            parts = name.rstrip('/').split('/')
            if any(part in ('', '.', '..') for part in parts) or parts[0] != expected_root:
                raise ValueError('unsafe archive path or unexpected archive root')
            mode = item.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ValueError('symlink or special archive entry')
            if item.is_dir() and kind == stat.S_IFREG or not item.is_dir() and kind == stat.S_IFDIR:
                raise ValueError('inconsistent archive entry type')
            if len(parts) == 1:
                if item.is_dir():
                    continue
                raise ValueError('archive root is not a directory')
            relative = pathlib.Path(*parts[1:])
            if relative in seen:
                raise ValueError('duplicate archive entry')
            seen.add(relative)
            selected.append((item, relative, mode))
        root.mkdir()
        for item, relative, mode in selected:
            target = root / relative
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                target.chmod(0o755)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(item) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o755 if mode & 0o111 else 0o644)
except Exception as error:
    print('Chromium ZIP extraction refused: ' + str(error), file=sys.stderr)
    sys.exit(1)
`;

export async function vendorChromium(input: {
  readonly platform: string;
  readonly outputDir: string;
  readonly fetchImpl?: typeof fetch;
  /** Synthetic pinned fixtures for unit tests; production uses the source manifest. */
  readonly manifest?: ChromiumVendorManifest;
}): Promise<void> {
  const platform = platformKey(input.platform);
  const selectedManifest = validateManifest(input.manifest ?? CHROMIUM_VENDOR_MANIFEST);
  const artifact = selectedManifest.targets[platform];
  const output = resolve(input.outputDir);
  if (existsSync(output)) throw new Error("Chromium vendor output already exists; refusing to overwrite it.");
  mkdirSync(dirname(output), { recursive: true });
  const temporary = mkdtempSync(join(dirname(output), ".chromium-vendor-"));
  try {
    const archive = join(temporary, "archive.zip");
    const downloaded = await fetchAndVerifyVendoredBinary({
      url: artifact.url, sha256: artifact.sha256, destPath: archive, executable: false,
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    });
    if (downloaded.size !== artifact.size) throw new Error("Chromium archive size does not match the pinned manifest.");
    const staged = join(temporary, "installed");
    const extraction = spawnSync("python3", ["-c", EXTRACT_ZIP, archive, staged, artifact.archiveRoot], { encoding: "utf8" });
    if (extraction.status !== 0) throw new Error(extraction.stderr || "Chromium ZIP extraction failed.");
    // Keep the complete archive payload. These files are required by the
    // rendering runtime and its redistribution notices, not optional caches.
    for (const file of ["chrome-headless-shell", "LICENSE.headless_shell", "ABOUT", "deb.deps",
      "icudtl.dat", "headless_command_resources.pak", "headless_lib_data.pak", "headless_lib_strings.pak",
      "libEGL.so", "libGLESv2.so", "libvk_swiftshader.so", "libvulkan.so.1", "vk_swiftshader_icd.json",
      "v8_context_snapshot.bin"]) {
      if (!existsSync(join(staged, file)) || !lstatSync(join(staged, file)).isFile()) {
        throw new Error(`Chromium archive is missing required file ${file}.`);
      }
    }
    if ((lstatSync(join(staged, "chrome-headless-shell")).mode & 0o111) === 0) {
      throw new Error("Chromium archive executable lacks its execute permission.");
    }
    const executable = readFileSync(join(staged, "chrome-headless-shell"));
    if (createHash("sha256").update(executable).digest("hex") !== artifact.executableSha256) {
      throw new Error("Chromium executable hash does not match the pinned manifest.");
    }
    const machine = platform === "linux/amd64" ? 62 : 183;
    if (executable.length < 20 || executable.subarray(0, 4).toString("hex") !== "7f454c46" ||
      executable[4] !== 2 || executable[5] !== 1 || executable.readUInt16LE(18) !== machine) {
      throw new Error("Chromium executable ELF architecture does not match its selected platform.");
    }
    writeFileSync(join(staged, "artifact-manifest.json"), JSON.stringify({
      schemaVersion: 1, version: selectedManifest.version, platform,
      archiveSha256: artifact.sha256, executableSha256: artifact.executableSha256, url: artifact.url,
    }, null, 2) + "\n", { mode: 0o644 });
    renameSync(staged, output);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 4) throw new Error("Usage: chromium-vendor.ts <linux/amd64|linux/arm64> <output-directory>");
    await vendorChromium({ platform: process.argv[2]!, outputDir: process.argv[3]! });
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : "Chromium vendoring failed."}\n`);
    process.exitCode = 1;
  }
}
