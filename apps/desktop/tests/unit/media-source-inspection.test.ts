import sharp from "sharp";
import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { copyMediaSnapshot, detectMediaFormat, inspectMediaSource, mediaInputArguments, readPickedMediaFile } from "../../electron/media-source-inspection.ts";
import { probeSequenceSource } from "../../electron/sequence-export-host";
import { testFfmpegPath, testH264EncoderArgs } from "../helpers/test-ffmpeg";

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-media-inspection-"));
  roots.push(root);
  return root;
}

const ffmpeg = testFfmpegPath();

describe("media source inspection", () => {
  test("picked-file reads obey the exact byte envelope and reject invalid envelopes", async () => {
    const root = await fixtureRoot();
    const source = path.join(root, "picked");
    await fsp.writeFile(source, "four");
    expect(await readPickedMediaFile(source, 4)).toEqual(Buffer.from("four"));
    expect(await readPickedMediaFile(source, 3)).toBeNull();
    for (const limit of [0, -1, NaN, Infinity, 2.5]) expect(await readPickedMediaFile(source, limit)).toBeNull();
    const symlink = path.join(root, "link");
    await fsp.symlink(source, symlink);
    expect(await readPickedMediaFile(symlink, 4).catch(() => null)).toBeNull();
  });

  test("snapshot streams multiple chunks, refuses symlinks and preserves an existing destination", async () => {
    const root = await fsp.realpath(await fixtureRoot());
    const source = path.join(root, "picked");
    const snapshot = path.join(root, "snapshot");
    const content = Buffer.alloc(700_000, 19);
    await fsp.writeFile(source, content);
    expect(await copyMediaSnapshot(source, snapshot)).toBe(true);
    expect(await fsp.readFile(snapshot)).toEqual(content);
    await fsp.writeFile(source, "changed");
    expect(await copyMediaSnapshot(source, snapshot)).toBe(false);
    expect(await fsp.readFile(snapshot)).toEqual(content);
    const symlink = path.join(root, "link");
    await fsp.symlink(source, symlink);
    expect(await copyMediaSnapshot(symlink, path.join(root, "refused"))).toBe(false);
    expect(await fsp.access(path.join(root, "refused")).then(() => true, () => false)).toBe(false);
  });

  test("aborted snapshots publish no partial file", async () => {
    const root = await fsp.realpath(await fixtureRoot());
    const source = path.join(root, "source");
    const destination = path.join(root, "snapshot");
    await fsp.writeFile(source, "media");
    const controller = new AbortController(); controller.abort();
    expect(await copyMediaSnapshot(source, destination, { signal: controller.signal })).toBe(false);
    expect(await fsp.access(destination).then(() => true, () => false)).toBe(false);
  });

  test("uses forced local decoders and never enables network playlist protocols", () => {
    for (const format of ["mp4", "wav", "mp3", "png", "jpeg", "webp"] as const) {
      const args = mediaInputArguments(format);
      expect(args).toContain("-protocol_whitelist");
      expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("file,pipe");
      expect(args).toContain("-f");
      expect(args).not.toContain("http");
      expect(args).not.toContain("https");
      expect(args).not.toContain("concat");
    }
  });

  test("rejects playlists, unknown bytes, and truncated recognized headers", async () => {
    const root = await fixtureRoot();
    const cases: Array<[string, Uint8Array | string]> = [
      ["hostile.m3u8", "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://example.invalid/media.mp4\n"],
      ["unknown.bin", "not media"],
      ["truncated.mp4", Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from("ftypisom")])],
      ["truncated.png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
      ["truncated.jpg", Buffer.from([0xff, 0xd8, 0xff])],
      ["truncated.wav", Buffer.from("RIFF\0\0\0\0WAVE")],
    ];
    for (const [name, bytes] of cases) {
      const source = path.join(root, name);
      await fsp.writeFile(source, bytes);
      expect(await inspectMediaSource(ffmpeg, source)).toBeNull();
    }
  });

  test("classifies generated video, audio, and still-image formats from bytes", async () => {
    const root = await fixtureRoot();
    const video = path.join(root, "video.data");
    const wav = path.join(root, "audio.data");
    const mp3 = path.join(root, "music.data");
    const m4a = path.join(root, "voice.data");
    const png = path.join(root, "png.data");
    const jpeg = path.join(root, "jpeg.data");
    const webp = path.join(root, "webp.data");

    await exec(ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=red:s=32x24:r=24000/1001:d=0.25", ...testH264EncoderArgs, "-pix_fmt", "yuv420p", "-f", "mp4", video]);
    await exec(ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.35", "-f", "wav", wav]);
    await exec(ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=550:duration=0.4", "-f", "mp3", mp3]);
    await exec(ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=660:duration=0.45", "-c:a", "aac", "-f", "mp4", m4a]);
    await exec(ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=blue:s=32x24", "-frames:v", "1", "-c:v", "png", "-f", "image2", png]);
    await exec(ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=green:s=32x24", "-frames:v", "1", "-c:v", "mjpeg", "-f", "image2", jpeg]);
    // Production needs WebP decoding, not a WebP encoder; create that input independently.
    await sharp({ create: { width: 32, height: 24, channels: 3, background: "yellow" } }).webp().toFile(webp);

    expect(await inspectMediaSource(ffmpeg, video)).toMatchObject({ mediaKind: "video", mimeType: "video/mp4", extension: "mp4", frameRate: { numerator: 24_000, denominator: 1_001 } });
    expect(await inspectMediaSource(ffmpeg, wav)).toMatchObject({ mediaKind: "audio", mimeType: "audio/wav", extension: "wav" });
    expect(await inspectMediaSource(ffmpeg, mp3)).toMatchObject({ mediaKind: "audio", mimeType: "audio/mpeg", extension: "mp3" });
    const inspectedM4a = await inspectMediaSource(ffmpeg, m4a);
    expect(inspectedM4a).toMatchObject({ mediaKind: "audio", mimeType: "audio/mp4", extension: "m4a" });
    expect(inspectedM4a?.durationSec).toBeGreaterThan(0.4);
    expect(inspectedM4a?.durationSec).toBeLessThan(0.6);
    expect(await inspectMediaSource(ffmpeg, png)).toEqual({ mediaKind: "image", mimeType: "image/png", extension: "png" });
    expect(await inspectMediaSource(ffmpeg, jpeg)).toEqual({ mediaKind: "image", mimeType: "image/jpeg", extension: "jpg" });
    expect(await inspectMediaSource(ffmpeg, webp)).toEqual({ mediaKind: "image", mimeType: "image/webp", extension: "webp" });
    expect(await detectMediaFormat(jpeg)).toBe("jpeg");
  }, 30_000);

  test("inspects a HEVC video with audio without the zero-frame encoder EOF failure", async () => {
    const root = await fixtureRoot();
    const source = path.join(root, "generated-hevc.mp4");
    const encoder = process.platform === "darwin"
      ? ["-c:v", "hevc_videotoolbox", "-allow_sw", "1"] : ["-c:v", "libx265"];
    await exec(ffmpeg, ["-hide_banner", "-f", "lavfi", "-i", "color=c=blue:s=128x128:r=24:d=0.5",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", ...encoder,
      "-c:a", "aac", "-tag:v", "hvc1", "-shortest", source]);
    expect(await inspectMediaSource(ffmpeg, source)).toMatchObject({ mediaKind: "video", mimeType: "video/mp4",
      durationSec: expect.any(Number), frameRate: { numerator: 24, denominator: 1 } });
    expect(await probeSequenceSource(ffmpeg, source, "mp4", "video")).toEqual({ hasVideo: true, hasAudio: true });
  }, 30_000);

  test("a pre-aborted inspection never invokes FFmpeg", async () => {
    const root = await fixtureRoot();
    const source = path.join(root, "source.wav");
    await fsp.writeFile(source, Buffer.from("RIFF\0\0\0\0WAVE"));
    const controller = new AbortController();
    controller.abort();
    expect(await inspectMediaSource("/definitely/not/ffmpeg", source, { signal: controller.signal })).toBeNull();
  });
});
