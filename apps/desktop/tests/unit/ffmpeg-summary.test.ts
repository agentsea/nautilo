import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { FfmpegSummaryParser, runFfmpegSummary } from "../../electron/ffmpeg-summary";

const summary = "  Duration: 00:01:02.97, start: 0\n  Stream #0:0: Video: h264, 1920x1080, 29.97 fps, 90k tbn\n  Stream #0:1: Audio: aac, 48000 Hz\n";

function childHarness() {
  const child = new EventEmitter() as EventEmitter & { stderr: PassThrough; kill: (signal: string) => boolean };
  child.stderr = new PassThrough();
  const kills: string[] = [];
  child.kill = signal => { kills.push(signal); return true; };
  const calls: unknown[][] = [];
  const launch = ((...args: unknown[]) => { calls.push(args); return child; }) as unknown as typeof spawn;
  return { child, calls, kills, launch };
}

describe("streaming FFmpeg inspection", () => {
  test("parses identically across every chunk boundary", () => {
    for (let split = 0; split <= summary.length; split++) {
      const parser = new FfmpegSummaryParser();
      parser.push(summary.slice(0, split));
      parser.push(summary.slice(split));
      const result = parser.finish();
      expect(result.durationSec).toBeCloseTo(62.97);
      expect(result.frameRate).toBeCloseTo(29.97);
      expect(result.hasVideo).toBe(true);
      expect(result.hasAudio).toBe(true);
    }
  });

  test("ignores huge metadata tokens and overflowing numbers without losing subsequent streams", () => {
    const parser = new FfmpegSummaryParser();
    parser.push("comment: ");
    for (let i = 0; i < 512; i++) parser.push("x".repeat(1024));
    parser.push("\ncomment: ");
    for (let i = 0; i < 512; i++) parser.push("9".repeat(1024));
    parser.push("\n" + summary);
    expect(parser.finish()).toMatchObject({ hasVideo: true, hasAudio: true });
    expect(parser.finish().durationSec).toBeCloseTo(62.97);
  });

  test("has no automatic timeout/buffer kill and waits for the owned child to close on cancellation", async () => {
    const { child, calls, kills, launch } = childHarness();
    const controller = new AbortController();
    let settled = false;
    const result = runFfmpegSummary("ffmpeg", ["-i", "clip.mp4"], { spawn: launch, signal: controller.signal }).then(value => { settled = true; return value; });
    expect(calls).toEqual([["ffmpeg", ["-i", "clip.mp4"], { stdio: ["ignore", "ignore", "pipe"] }]]);
    child.stderr.write(summary);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(kills).toEqual([]);
    controller.abort();
    expect(kills).toEqual(["SIGKILL"]);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", null);
    expect(await result).toBeNull();
    child.stderr.destroy();
  });

  test("returns measured metadata only on successful completion and never spawns after cancellation", async () => {
    for (const exitCode of [0, 1]) {
      const { child, launch } = childHarness();
      const result = runFfmpegSummary("ffmpeg", [], { spawn: launch });
      child.stderr.write(summary);
      child.emit("close", exitCode);
      if (exitCode === 0) expect(await result).toMatchObject({ hasVideo: true, hasAudio: true });
      else expect(await result).toBeNull();
      child.stderr.destroy();
    }
    const { launch, calls } = childHarness();
    const controller = new AbortController(); controller.abort();
    expect(await runFfmpegSummary("ffmpeg", [], { spawn: launch, signal: controller.signal })).toBeNull();
    expect(calls).toEqual([]);
  });
});
