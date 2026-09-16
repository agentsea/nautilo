#!/usr/bin/env bun
/** Pin prebuilt LGPL FFmpeg, its libraries/notices, and complete source inputs. */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAndVerifyVendoredBinary } from "@nautilo/config/vendored-binary-fetch";
import { DESKTOP_DARWIN_PLATFORM_KEYS } from "../electron/tool-runtimes-manifest";
import { digest, ffmpegDistribution, ffmpegManifest, verifyFfmpegDistribution } from "./ffmpeg-distribution";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../vendor/ffmpeg");
const log = (message: string): void => { process.stdout.write(`[vendor-ffmpeg] ${message}\n`); };

async function main(): Promise<void> {
  try { await verifyFfmpegDistribution(root); log(`verified cache (${ffmpegManifest.version})`); return; } catch { /* Rebuild incomplete or stale cache from pinned inputs. */ }
  // This directory is generated exclusively by this script. Remove obsolete
  // runtime and license files so an earlier nonfree artifact cannot ride along.
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const key of DESKTOP_DARWIN_PLATFORM_KEYS) {
    const artifact = ffmpegManifest.artifacts[key];
    if (!artifact?.url || !artifact.sha256 || !artifact.binarySha256) throw new Error(`Incomplete FFmpeg pin: ${key}`);
    const arch = key === "darwin-arm64" ? "arm64" : "x64";
    const temporary = mkdtempSync(join(tmpdir(), "nautilo-ffmpeg-vendor-"));
    try {
      const archive = join(temporary, "archive.zip");
      await fetchAndVerifyVendoredBinary({ url: artifact.url, sha256: artifact.sha256, destPath: archive, executable: false, minBytes: 1 });
      const extracted = join(temporary, "extracted");
      // The exact ZIP is hash-verified before extraction. Only declared files
      // enter the app; no pkgconfig metadata or incidental executables ship.
      execFileSync("unzip", ["-q", archive, "-d", extracted]);
      for (const file of [...ffmpegDistribution.binaries, ...ffmpegDistribution.notices].filter(file => file.path.startsWith(`${arch}/`))) {
        const source = realpathSync(join(extracted, file.member));
        if (!source.startsWith(realpathSync(extracted) + sep)) throw new Error(`FFmpeg archive member escapes its root: ${file.member}`);
        if (digest(readFileSync(source)) !== file.sha256) throw new Error(`FFmpeg archive member checksum mismatch: ${file.member}`);
        mkdirSync(dirname(join(root, file.path)), { recursive: true });
        // Materialize library aliases as ordinary files with the same bytes.
        // @rpath names/layout remain intact; each shipped path has its own pin.
        copyFileSync(source, join(root, file.path));
      }
    } finally { rmSync(temporary, { recursive: true, force: true }); }
    log(`verified ${key} executable, libraries and notices`);
  }
  for (const source of ffmpegDistribution.sources) {
    await fetchAndVerifyVendoredBinary({ url: source.url, sha256: source.sha256, destPath: join(root, source.path), executable: false, minBytes: 1, log });
  }
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ ffmpeg: ffmpegManifest }, null, 2) + "\n");
  writeFileSync(join(root, "distribution.json"), JSON.stringify(ffmpegDistribution, null, 2) + "\n");
  writeFileSync(join(root, "PROVENANCE.md"), readFileSync(new URL("../FFMPEG.md", import.meta.url)));
  writeFileSync(join(root, ".version"), ffmpegManifest.version);
  await verifyFfmpegDistribution(root);
  log(`ready: LGPL FFmpeg ${ffmpegManifest.version}, licenses and corresponding source`);
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
