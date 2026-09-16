import { expect, test } from "bun:test";
import { WaveformReducer, inspectMediaWaveform } from "../../electron/media-waveform";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { testFfmpegPath } from "../helpers/test-ffmpeg";

test("native waveform reduction spans arbitrary chunk boundaries and retains peaks from both channels", () => {
  const pcm = Buffer.alloc(960 * 4 + 8);
  pcm.writeFloatLE(-0.8, 4); pcm.writeFloatLE(0.4, 960 * 4);
  const reducer = new WaveformReducer();
  for (let offset = 0; offset < pcm.length; offset += 17) reducer.push(pcm.subarray(offset, offset + 17));
  const wave = reducer.finish();
  expect(wave.samplesPerSecond).toBe(100);
  expect(wave.peaks).toHaveLength(2);
  expect(wave.peaks[0]).toBeCloseTo(0.8);
  expect(wave.peaks[1]).toBeCloseTo(0.4);
});
test("waveform cancellation does not start a decoder", async () => {
  const abort = new AbortController(); abort.abort();
  expect(await inspectMediaWaveform("/not-a-program", "/unused", abort.signal)).toBeNull();
});

const ffmpeg = testFfmpegPath();
test("a real short audio file produces non-silent native peaks", async () => {
  const root = await mkdtemp(join(tmpdir(), "waveform-real-test-"));
  try {
    const source = join(root, "tone.wav");
    const generated = spawnSync(ffmpeg, ["-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi",
      "-i", "sine=frequency=440:duration=0.2", source], { stdio: "ignore" });
    expect(generated.status).toBe(0);
    const result = await inspectMediaWaveform(ffmpeg, source, new AbortController().signal);
    expect(result?.peaks.length).toBe(20);
    expect(Math.max(...result!.peaks)).toBeGreaterThan(0.05);
    expect(result!.peaks.every(Number.isFinite)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
