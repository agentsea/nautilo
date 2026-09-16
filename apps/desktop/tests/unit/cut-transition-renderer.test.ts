import { expect, test } from "bun:test";
import { execFile, spawnSync } from "node:child_process";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { createEmptyProject } from "../../../../packages/first-party-apps/video/src/edl";
import { setCutTransition } from "../../../../packages/first-party-apps/video/src/commands";
import { buildSequenceRenderPlan } from "../../../../packages/first-party-apps/video/src/render-plan";
import { renderSequence } from "../../electron/sequence-renderer";
import { testFfmpegPath, testH264EncoderArgs } from "../helpers/test-ffmpeg";

test("real crossfade and all swipe directions render both sources, fixed duration, and blended embedded audio", async () => {
  const ffmpeg = testFfmpegPath();
  const root = await fsp.mkdtemp(path.join(tmpdir(), "nautilo-cut-transition-"));
  try {
    const exec = promisify(execFile);
    const project = createEmptyProject();
    project.media = ["a", "b"].map((id) => ({ id, kind: "video", ref: `${id}.mp4`, durationSec: 3 }));
    project.sequences[0]!.durationSec = 2;
    project.sequences[0]!.tracks = [{ id: "lane", kind: "video", order: 0, clips: [
      { id: "a", kind: "video", trackId: "lane", mediaId: "a", timelineStartSec: 0, durationSec: 1, sourceInSec: 0, props: {} },
      { id: "b", kind: "video", trackId: "lane", mediaId: "b", timelineStartSec: 1, durationSec: 1, sourceInSec: 1, props: {} },
    ] }];
    const sources = new Map();
    for (const [id, color] of [["a", "red"], ["b", "blue"]]) {
      const input = path.join(root, `${id}.mp4`);
      await exec(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", `color=${color}:s=160x90:r=30:d=3`, "-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=48000", ...testH264EncoderArgs, "-pix_fmt", "yuv420p", "-c:a", "aac", input]);
      sources.set(id, { canonicalPath: input, format: "mp4", hasVideo: true, hasAudio: true });
    }
    for (const mode of ["crossfade", "left", "right", "up", "down"] as const) {
      const applied = setCutTransition(project, { clipId: "b", kind: mode === "crossfade" ? "crossfade" : "swipe", direction: mode === "crossfade" ? "left" : mode, durationSec: 1 });
      if (!applied.ok) throw new Error(applied.error);
      const built = buildSequenceRenderPlan(applied.project, undefined, { width: 160, height: 90 });
      if (!built.ok) throw new Error(built.error.code);
      const output = path.join(root, `${mode}.mp4`);
      expect(await renderSequence(built.plan, { ffmpegPath: ffmpeg, sources, outputPath: output })).toMatchObject({ status: "succeeded" });
      const pixel = (time: number, x: number, y: number) => {
        const result = spawnSync(ffmpeg, ["-v", "error", "-ss", String(time), "-i", output, "-frames:v", "1", "-vf", `crop=2:2:${x}:${y},format=rgb24`, "-f", "rawvideo", "pipe:1"]);
        expect(result.status).toBe(0); return [...result.stdout.subarray(0, 3)];
      };
      expect(pixel(0.2, 30, 30)[0]!).toBeGreaterThan(220);
      expect(pixel(1.8, 30, 30)[2]!).toBeGreaterThan(220);
      if (mode === "crossfade") {
        const middle = pixel(1, 80, 40);
        expect(middle[0]!).toBeGreaterThan(90); expect(middle[2]!).toBeGreaterThan(90); expect(middle[1]!).toBeLessThan(20);
        const pcm = spawnSync(ffmpeg, ["-v", "error", "-i", output, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"]).stdout;
        const rms = (time: number) => { let sum = 0; const start = Math.round(time * 48000); for (let i = start; i < start + 2400; i++) sum += pcm.readFloatLE(i * 4) ** 2; return Math.sqrt(sum / 2400); };
        expect(pcm.length / 4 / 48000).toBeGreaterThanOrEqual(2); expect(pcm.length / 4 / 48000).toBeLessThan(2.05);
        expect(rms(0.98) / rms(0.2)).toBeGreaterThan(0.8); expect(rms(0.98) / rms(0.2)).toBeLessThan(1.2);
      } else {
        const incoming = mode === "left" ? [130, 40] : mode === "right" ? [30, 40] : mode === "up" ? [80, 70] : [80, 20];
        const outgoing = mode === "left" ? [30, 40] : mode === "right" ? [130, 40] : mode === "up" ? [80, 20] : [80, 70];
        expect(pixel(1, incoming[0]!, incoming[1]!)[2]!).toBeGreaterThan(210);
        expect(pixel(1, outgoing[0]!, outgoing[1]!)[0]!).toBeGreaterThan(210);
      }
    }
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
}, 30_000);
