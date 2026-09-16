import { describe, expect, test } from "bun:test";
import { parseFfmpegVideoMetadata } from "../../electron/ffmpeg-media-metadata.ts";

describe("parseFfmpegVideoMetadata", () => {
  test("reads duration and integer frame rate from the managed FFmpeg summary", () => {
    const parsed = parseFfmpegVideoMetadata(`
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'fixture.mp4':
  Duration: 00:01:02.97, start: 0.000000, bitrate: 111 kb/s
  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 480x268, 106 kb/s, 30 fps, 30 tbr, 15360 tbn
`);
    expect(parsed).toEqual({
      durationSec: 62.97,
      frameRate: { numerator: 30, denominator: 1 },
    });
  });

  test("restores common fractional display rates to their rational grid", () => {
    const parsed = parseFfmpegVideoMetadata(`
  Duration: 00:00:10.00, start: 0.000000, bitrate: 500 kb/s
  Stream #0:0: Video: h264, yuv420p, 1920x1080, 29.97 fps, 29.97 tbr, 90k tbn
`);
    expect(parsed?.frameRate).toEqual({ numerator: 30_000, denominator: 1_001 });
  });

  test("fails closed for missing video and malformed duration", () => {
    expect(parseFfmpegVideoMetadata("Duration: 00:00:02.00\nStream #0:0: Audio: aac, 48kHz")).toBeNull();
    expect(parseFfmpegVideoMetadata("Duration: 00:99:02.00\nStream #0:0: Video: h264, 30 fps,")).toBeNull();
    expect(parseFfmpegVideoMetadata("x".repeat(256 * 1_024 + 1))).toBeNull();
  });

  test("retains valid metadata after diagnostics larger than the old buffer and accepts high frame rates", () => {
    expect(parseFfmpegVideoMetadata(`comment: ${"x".repeat(1024 * 1024)}\nDuration: 00:00:03.00\nStream #0:0: Video: h264, 2000 fps,`)).toEqual({
      durationSec: 3, frameRate: { numerator: 2000, denominator: 1 },
    });
    expect(parseFfmpegVideoMetadata("Duration: 00:00:03.00\nStream #0:0: Video: h264, 9007199254740992 fps,")).toBeNull();
  });
});
