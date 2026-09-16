import { spawn } from "node:child_process";
import { detectMediaFormat, mediaInputArguments } from "./media-source-inspection";

/** Display samples, not an audio/time admission limit. Every decoded frame contributes. */
const SAMPLES_PER_SECOND = 100;
const PCM_SAMPLE_RATE = 48_000;
const CHANNELS = 2;
export interface MediaWaveform { peaks: number[]; samplesPerSecond: number }

/** Incremental stereo float PCM reduction; never retains decoded audio. */
export class WaveformReducer {
  private tail = Buffer.alloc(0);
  private samples = 0;
  private peak = 0;
  private readonly peaks: number[] = [];
  push(chunk: Buffer): void {
    const bytes = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
    const complete = bytes.length - bytes.length % 4;
    for (let offset = 0; offset < complete; offset += 4) {
      const sample = bytes.readFloatLE(offset);
      if (Number.isFinite(sample)) this.peak = Math.max(this.peak, Math.min(1, Math.abs(sample)));
      this.samples++;
      if (this.samples === PCM_SAMPLE_RATE / SAMPLES_PER_SECOND * CHANNELS) {
        this.peaks.push(this.peak); this.samples = 0; this.peak = 0;
      }
    }
    this.tail = Buffer.from(bytes.subarray(complete));
  }
  finish(): MediaWaveform {
    return { peaks: this.samples ? [...this.peaks, this.peak] : this.peaks, samplesPerSecond: SAMPLES_PER_SECOND };
  }
}

/** Private, already-inspected snapshot only. Cancellation kills the owned decoder. */
export async function inspectMediaWaveform(ffmpegPath: string, sourcePath: string, signal: AbortSignal): Promise<MediaWaveform | null> {
  if (signal.aborted) return null;
  const format = await detectMediaFormat(sourcePath).catch(() => null);
  if (!format || signal.aborted) return null;
  return await new Promise((resolve) => {
    const reducer = new WaveformReducer();
    const child = spawn(ffmpegPath, ["-hide_banner", "-nostdin", "-loglevel", "error", "-threads", "1",
      ...mediaInputArguments(format), "-i", sourcePath, "-map", "0:a:0", "-vn", "-ac", String(CHANNELS), "-ar", String(PCM_SAMPLE_RATE),
      "-f", "f32le", "pipe:1"], { stdio: ["ignore", "pipe", "ignore"] });
    let settled = false;
    const abort = () => { child.kill("SIGKILL"); };
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true; signal.removeEventListener("abort", abort);
      const waveform = success && !signal.aborted ? reducer.finish() : null;
      resolve(waveform?.peaks.length ? waveform : null);
    };
    child.stdout.on("data", (chunk: Buffer) => reducer.push(chunk));
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
