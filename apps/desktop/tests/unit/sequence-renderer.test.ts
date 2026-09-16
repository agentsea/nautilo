import { afterEach, describe, expect, test } from "bun:test";
import { execFile, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { buildSequenceFfmpegArgs, renderSequence, type SequenceRenderPlan } from "../../electron/sequence-renderer.ts";
import { normalizeVideoExportSettings, videoExportDimensions } from "@nautilo/types";
import { testFfmpegPath, testH264EncoderArgs } from "../helpers/test-ffmpeg";

const exec = promisify(execFile);
const ffmpeg = testFfmpegPath();
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true }))); });
async function root(): Promise<string> { const value = await fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-sequence-renderer-")); roots.push(value); return value; }

const PLAN: SequenceRenderPlan = {
  version: 1, durationSec: 4, width: 320, height: 180, frameRate: { numerator: 30, denominator: 1 },
  layers: [
    { clipId: "cut-a", kind: "video", trackKind: "video", mediaId: "a", timelineStartSec: 0, durationSec: 1, sourceInSec: 0, visual: true, gain: 0.5 },
    { clipId: "cut-b", kind: "video", trackKind: "video", mediaId: "b", timelineStartSec: 2, durationSec: 1, sourceInSec: 0, visual: true, gain: 0 },
    { clipId: "music", kind: "audio", trackKind: "music", mediaId: "music", timelineStartSec: 0, durationSec: 4, sourceInSec: 0, visual: false, gain: 0.25 },
  ],
};

describe("sequence renderer", () => {
  test("export profiles reach the encoder and short real MP4s preserve resolution and project rate", async () => {
    const dir = await root();
    for (const [resolution, quality, audioBitrateKbps] of [["720p", "smaller", 128], ["1080p", "balanced", 192], ["4k", "high", 320], ["720p", "custom", 192]] as const) {
      const exportSettings = normalizeVideoExportSettings({ resolution, quality, audioBitrateKbps, ...(quality === "custom" ? { videoBitrateKbps: 2250 } : {}) })!;
      const plan: SequenceRenderPlan = { version: 1, durationSec: 0.1, ...videoExportDimensions(exportSettings), frameRate: { numerator: 30000, denominator: 1001 }, layers: [], exportSettings };
      const output = path.join(dir, quality + ".mp4");
      const built = buildSequenceFfmpegArgs(plan, new Map(), output)!;
      expect(built).not.toBeNull();
      expect(built.args[built.args.indexOf("-b:a") + 1]).toBe(audioBitrateKbps + "k");
      expect(built.args.includes("-crf")).toBe(process.platform !== "darwin" && quality !== "custom");
      expect(built.args.includes("-b:v")).toBe(process.platform === "darwin" || quality === "custom");
      expect(await renderSequence(plan, { ffmpegPath: ffmpeg, sources: new Map(), outputPath: output })).toMatchObject({ status: "succeeded" });
      const { stderr } = await exec(ffmpeg, ["-hide_banner", "-i", output, "-vf", "showinfo", "-frames:v", "1", "-f", "null", "-"]);
      expect(stderr).toContain("Video: h264");
      expect(stderr).toContain("Audio: aac");
      expect(stderr).toContain(`s:${plan.width}x${plan.height}`);
      expect(stderr).toContain("frame_rate: 30000/1001");
    }
    expect(buildSequenceFfmpegArgs({ ...PLAN, layers: [], exportSettings: { quality: "custom", videoBitrateKbps: -1 } } as unknown as SequenceRenderPlan, new Map(), "/never.mp4")).toBeNull();
  }, 30_000);

  test("fades survive a mid-ramp source trim in real exported pixels and PCM", async () => {
    const dir = await root(); const input = path.join(dir, "fade-source.mp4"); const output = path.join(dir, "fade.mp4");
    await exec(ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=white:s=160x90:r=30:d=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=48000", ...testH264EncoderArgs, "-pix_fmt", "yuv420p", "-c:a", "aac", input]);
    const plan: SequenceRenderPlan = { version: 1, durationSec: 1.5, width: 160, height: 90, frameRate: { numerator: 30, denominator: 1 }, layers: [
      { clipId: "fade", kind: "video", trackKind: "video", mediaId: "v", timelineStartSec: 0, durationSec: 1.5, sourceInSec: 0.5, visual: true, gain: 1, fades: { videoIn: { startSec: 0, durationSec: 1 }, audioIn: { startSec: 0, durationSec: 1 }, videoOut: { startSec: 1, durationSec: 1 }, audioOut: { startSec: 1, durationSec: 1 } } },
    ] };
    const sources = new Map([["v", { canonicalPath: input, format: "mp4" as const, hasVideo: true, hasAudio: true }]]);
    expect(await renderSequence(plan, { ffmpegPath: ffmpeg, sources, outputPath: output })).toMatchObject({ status: "succeeded" });
    const pixel = (time: number) => (spawnSync(ffmpeg, ["-v", "error", "-ss", String(time), "-i", output, "-frames:v", "1", "-vf", "crop=2:2:80:40,format=rgb24", "-f", "rawvideo", "pipe:1"]).stdout as Buffer)[0]!;
    const initial = pixel(0); const peak = pixel(0.5); const late = pixel(1.3);
    expect(initial).toBeGreaterThan(100); expect(initial).toBeLessThan(155);
    expect(peak).toBeGreaterThan(235); expect(late).toBeLessThan(75);
    const pcm = spawnSync(ffmpeg, ["-v", "error", "-i", output, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"]).stdout as Buffer;
    const rms = (from: number, to: number) => { let sum = 0; const start = Math.floor(from * 48000); const stop = Math.floor(to * 48000); for (let i = start; i < stop; i++) sum += pcm.readFloatLE(i * 4) ** 2; return Math.sqrt(sum / (stop - start)); };
    expect(rms(0.02, 0.07) / rms(0.48, 0.53)).toBeGreaterThan(0.4);
    expect(rms(0.02, 0.07) / rms(0.48, 0.53)).toBeLessThan(0.7);
    expect(rms(1.35, 1.4) / rms(0.48, 0.53)).toBeLessThan(0.25);
    expect(buildSequenceFfmpegArgs({ ...plan, layers: [{ ...plan.layers[0]!, fades: { videoIn: { startSec: -1, durationSec: 1 } } }] }, sources, output)).toBeNull();
  }, 30_000);

  test("synthetic text never becomes FFmpeg syntax and only native PNGs can supply it", () => {
    const text = "x';movie=/private/file; [v] </script> {\\pos(0,0)}";
    const plan: SequenceRenderPlan = { ...PLAN, layers: [{ clipId: "t", kind: "caption", trackKind: "caption", timelineStartSec: 1, durationSec: 2, sourceInSec: 0, visual: true, gain: 0, text }] };
    expect(buildSequenceFfmpegArgs(plan, new Map(), "/out.mp4")).toBeNull();
    const built = buildSequenceFfmpegArgs(plan, new Map(), "/out.mp4", new Map([[0, { canonicalPath: "/private/generated.png", format: "png", hasVideo: true, hasAudio: false }]]));
    expect(built).not.toBeNull();
    expect(built!.args).toContain("/private/generated.png");
    expect(built!.args.join(" ")).not.toContain(text);
    expect(built!.args.join(" ")).toContain("gte(t,1)*lt(t,3)");
    expect(buildSequenceFfmpegArgs({ ...plan, layers: [{ ...plan.layers[0]!, mediaId: "injected" }] }, new Map(), "/out.mp4")).toBeNull();
  });

  test("raster cancellation and overflow leave no private text files or running FFmpeg", async () => {
    const plan: SequenceRenderPlan = { ...PLAN, layers: [{ clipId: "t", kind: "text", trackKind: "overlay", timelineStartSec: 0, durationSec: 2, sourceInSec: 0, visual: true, gain: 0, text: "Title" }] };
    const controller = new AbortController(); let rasterPath = ""; let spawned = false;
    const result = await renderSequence(plan, { ffmpegPath: "/managed/ffmpeg", sources: new Map(), outputPath: "/not-created.mp4", signal: controller.signal,
      rasterizeText: async (input) => { rasterPath = input.outputPath; await fsp.writeFile(rasterPath, "raster"); controller.abort(); },
      spawn: (() => { spawned = true; throw new Error("unexpected"); }) as never,
    });
    expect(result).toEqual({ status: "cancelled" });
    expect(spawned).toBe(false);
    expect(await fsp.access(path.dirname(rasterPath)).then(() => true, () => false)).toBe(false);
    const failed = await renderSequence(plan, { ffmpegPath: "/managed/ffmpeg", sources: new Map(), outputPath: "/not-created.mp4", rasterizeText: async () => { throw new Error("text_overflow"); } });
    expect(failed).toEqual({ status: "failed", code: "text_overflow" });
  });
  test("builds fixed argv from host paths and reports absent optional video audio", () => {
    const built = buildSequenceFfmpegArgs(PLAN, new Map([
      ["a", { canonicalPath: "/host/a.mp4", format: "mp4", hasVideo: true, hasAudio: false }],
      ["b", { canonicalPath: "/host/b.mp4", format: "mp4", hasVideo: true, hasAudio: false }],
      ["music", { canonicalPath: "/host/music.wav", format: "wav", hasVideo: false, hasAudio: true }],
    ]), "/host/output.mp4");
    expect(built).not.toBeNull();
    expect(built!.warnings).toEqual([{ code: "missing_audio_stream", mediaId: "a", clipId: "cut-a" }]);
    expect(built!.args).toContain("-filter_complex");
    expect(built!.args.join(" ")).toContain("aresample=48000,volume=0.25,adelay=0S:all=1");
    expect(JSON.stringify(PLAN)).not.toContain("/host/");
  });

  test("fails before spawn for an unauthorized or stream-incompatible source", async () => {
    let spawned = false;
    const result = await renderSequence(PLAN, { ffmpegPath: "/managed/ffmpeg", sources: new Map(), outputPath: "/private/output.mp4", spawn: (() => { spawned = true; throw new Error("no"); }) as never });
    expect(result).toEqual({ status: "failed", code: "source_unavailable" });
    expect(spawned).toBe(false);
    expect(buildSequenceFfmpegArgs({ ...PLAN, path: "/tmp/injected" } as SequenceRenderPlan, new Map(), "/private/output.mp4")).toBeNull();
    for (const layer of [null, 3, "clip"]) expect(buildSequenceFfmpegArgs({ ...PLAN, layers: [layer] } as unknown as SequenceRenderPlan, new Map(), "/private/output.mp4")).toBeNull();
  });

  test("kills the child and waits for closure before reporting cancellation", async () => {
    let child!: Child;
    class Child extends EventEmitter {
      stderr = new EventEmitter();
      signal: NodeJS.Signals | undefined;
      kill(signal?: NodeJS.Signals | number): boolean { this.signal = signal as NodeJS.Signals | undefined; return true; }
    }
    const controller = new AbortController();
    const pending = renderSequence(PLAN, {
      ffmpegPath: "/managed/ffmpeg", outputPath: "/private/output.mp4", signal: controller.signal,
      sources: new Map([["a", { canonicalPath: "/a", format: "mp4", hasVideo: true, hasAudio: false }], ["b", { canonicalPath: "/b", format: "mp4", hasVideo: true, hasAudio: false }], ["music", { canonicalPath: "/m", format: "wav", hasVideo: false, hasAudio: true }]]),
      spawn: (() => (child = new Child())) as never,
    });
    let settled = false;
    void pending.then(() => { settled = true; });
    controller.abort();
    await Promise.resolve();
    expect(child.signal).toBe("SIGKILL");
    expect(settled).toBe(false);
    child.emit("close", null, "SIGKILL");
    expect(await pending).toEqual({ status: "cancelled" });
  });

  test("cancellation during deferred output-header validation cannot report success", async () => {
    const controller = new AbortController(); let release!: (value: Uint8Array) => void;
    const pendingHeader = new Promise<Uint8Array>((resolve) => { release = resolve; });
    class Child extends EventEmitter { stderr = new EventEmitter(); kill(): boolean { return true; } }
    const result = renderSequence(PLAN, {
      ffmpegPath: "/managed/ffmpeg", outputPath: "/private/output.mp4", signal: controller.signal,
      sources: new Map([["a", { canonicalPath: "/a", format: "mp4", hasVideo: true, hasAudio: false }], ["b", { canonicalPath: "/b", format: "mp4", hasVideo: true, hasAudio: false }], ["music", { canonicalPath: "/m", format: "wav", hasVideo: false, hasAudio: true }]]),
      spawn: (() => { const child = new Child(); queueMicrotask(() => child.emit("close", 0, null)); return child; }) as never,
      stat: (async () => ({ isFile: () => true, size: 24 })) as never,
      readHeader: async () => pendingHeader,
    });
    await new Promise((resolve) => setTimeout(resolve, 0)); controller.abort();
    release(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]));
    expect(await result).toEqual({ status: "cancelled" });
  });

  test("renders generated cuts, a black gap, mixed audio, and an overlay into one MP4", async () => {
    const dir = await root();
    const a = path.join(dir, "a.mp4"); const b = path.join(dir, "b.mp4"); const overlay = path.join(dir, "overlay.png"); const music = path.join(dir, "music.wav"); const output = path.join(dir, "out.mp4");
    await exec(ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=red:s=160x90:r=30000/1001:d=0.4", "-f", "lavfi", "-i", "color=green:s=160x90:r=30000/1001:d=0.4", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0", ...testH264EncoderArgs, "-pix_fmt", "yuv420p", a]);
    await exec(ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=blue:s=160x90:r=30000/1001:d=0.3", ...testH264EncoderArgs, "-pix_fmt", "yuv420p", b]);
    await exec(ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=yellow@0.5:s=40x40:d=0.1,format=rgba", "-frames:v", "1", overlay]);
    await exec(ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1:sample_rate=48000", music]);
    const onset = 1001 / 30_000;
    const integrationPlan: SequenceRenderPlan = { version: 1, durationSec: 0.7, width: 160, height: 90, frameRate: { numerator: 30_000, denominator: 1_001 }, layers: [
      { clipId: "trimmed-green", kind: "video", trackKind: "video", mediaId: "a", timelineStartSec: 0, durationSec: 0.2, sourceInSec: 0.4, visual: true, gain: 0 },
      { clipId: "blue", kind: "video", trackKind: "video", mediaId: "b", timelineStartSec: 0.4, durationSec: 0.2, sourceInSec: 0, visual: true, gain: 0 },
      { clipId: "alpha", kind: "image", trackKind: "overlay", mediaId: "overlay", timelineStartSec: 0.45, durationSec: 0.1, sourceInSec: 0, visual: true, gain: 0 },
      { clipId: "music", kind: "audio", trackKind: "music", mediaId: "music", timelineStartSec: onset, durationSec: 0.1, sourceInSec: 0, visual: false, gain: 0.25 },
    ] };
    const progress: number[] = [];
    const result = await renderSequence(integrationPlan, { ffmpegPath: ffmpeg, outputPath: output, sources: new Map([
      ["a", { canonicalPath: a, format: "mp4", hasVideo: true, hasAudio: false }], ["b", { canonicalPath: b, format: "mp4", hasVideo: true, hasAudio: false }], ["overlay", { canonicalPath: overlay, format: "png", hasVideo: true, hasAudio: false }], ["music", { canonicalPath: music, format: "wav", hasVideo: false, hasAudio: true }],
    ]), onProgress: (value) => progress.push(value) });
    expect(result).toMatchObject({ status: "succeeded", warnings: [] });
    expect(progress.every((value, index) => index === 0 || value > progress[index - 1]!)).toBe(true);
    const inspected = await exec(ffmpeg, ["-hide_banner", "-i", output, "-f", "null", "-"]).catch((error: { stderr?: string }) => ({ stderr: error.stderr ?? "" }));
    expect(inspected.stderr).toContain("Video:");
    expect(inspected.stderr).toContain("Audio:");
    expect(inspected.stderr).toMatch(/Duration:\s*00:00:00\.7\d/u);
    const pixel = (seconds: number, x = 2, y = 2): number[] => [...(spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", String(seconds), "-i", output, "-frames:v", "1", "-vf", `crop=1:1:${x}:${y},format=rgb24`, "-f", "rawvideo", "pipe:1"]).stdout as Buffer).subarray(0, 3)];
    const green = pixel(0.1); const black = pixel(0.3); const blue = pixel(0.42); const cornerUnderOverlay = pixel(0.5); const blended = pixel(0.5, 80, 45);
    expect(green[1]!).toBeGreaterThan(green[0]! + 40); // proves sourceIn skipped red
    expect(Math.max(...black)).toBeLessThan(18);
    expect(blue[2]!).toBeGreaterThan(blue[0]! + 80);
    expect(cornerUnderOverlay[2]!).toBeGreaterThan(cornerUnderOverlay[0]! + 60);
    expect(blended[0]!).toBeGreaterThan(60); expect(blended[1]!).toBeGreaterThan(60); expect(blended[2]!).toBeGreaterThan(40); // alpha yellow over blue
    const pcm = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", output, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"]).stdout as Buffer;
    const samples = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4));
    const rms = (from: number, to: number) => Math.sqrt([...samples.subarray(Math.floor(from * 48_000), Math.floor(to * 48_000))].reduce((sum, value) => sum + value * value, 0) / Math.max(1, Math.floor((to - from) * 48_000)));
    expect(rms(0, 0.02)).toBeLessThan(0.001);
    expect(rms(0.05, 0.11)).toBeGreaterThan(0.01); expect(rms(0.05, 0.11)).toBeLessThan(0.04); // normalized 0.25 gain
    expect(rms(0.18, 0.25)).toBeLessThan(0.001);
  }, 30_000);
});
