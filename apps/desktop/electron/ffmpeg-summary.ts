import { spawn } from "node:child_process";

export interface FfmpegSummary { durationSec: number | null; frameRate: number | null; hasVideo: boolean; hasAudio: boolean }
const WORDS = ["Duration", "Stream", "Video", "Audio", "fps"] as const;

/** Incremental lexer: retains recognized keywords and numeric values, never log
 * lines or metadata text. A huge comment cannot exhaust a buffer or hide a later
 * stream summary. Numeric overflow fails that field, not the entire diagnostic. */
export class FfmpegSummaryParser {
  readonly result: FfmpegSummary = { durationSec: null, frameRate: null, hasVideo: false, hasAudio: false };
  private kind: "word" | "number" | null = null;
  private word: string | null = "";
  private number = 0;
  private fraction = 0;
  private dot = false;
  private first = true;
  private stream = false;
  private video = false;
  private firstVideo = false;
  private previousNumber: number | null = null;
  private durationState = 0;
  private hours = 0;
  private minutes = 0;
  push(text: string): void {
    for (const character of text) {
      if (character >= "0" && character <= "9") {
        if (this.kind === "word") { this.word = null; continue; }
        if (this.kind !== "number") { this.kind = "number"; this.number = 0; this.fraction = 0; this.dot = false; }
        const digit = character.charCodeAt(0) - 48;
        if (this.dot) { this.fraction *= 0.1; this.number += digit * this.fraction; }
        else this.number = this.number * 10 + digit;
        continue;
      }
      if (character === "." && this.kind === "number" && !this.dot) { this.dot = true; this.fraction = 1; continue; }
      if (/[A-Za-z_]/u.test(character)) {
        if (this.kind === "number") this.flush();
        if (this.kind !== "word") { this.kind = "word"; this.word = ""; }
        if (this.word !== null) {
          const candidate = this.word + character;
          this.word = WORDS.some(word => word.startsWith(candidate)) ? candidate : null;
        }
        continue;
      }
      this.flush();
      if (character === "\n" || character === "\r") {
        this.first = true; this.stream = false; this.video = false; this.firstVideo = false; this.previousNumber = null; this.durationState = 0;
      } else if (!/\s/u.test(character)) this.token(character);
    }
  }
  finish(): FfmpegSummary { this.flush(); return { ...this.result }; }
  private flush(): void {
    if (this.kind !== null) this.token(this.kind === "number" ? this.number : this.word ?? "");
    this.kind = null; this.word = "";
  }
  private token(value: string | number): void {
    const first = this.first; this.first = false;
    if (first && value === "Duration") this.durationState = 1;
    else if (this.durationState) {
      if (this.durationState % 2 === 1 && value === ":") this.durationState++;
      else if (typeof value === "number" && Number.isFinite(value)) {
        if (this.durationState === 2) { this.hours = value; this.durationState = 3; }
        else if (this.durationState === 4) { this.minutes = value; this.durationState = 5; }
        else if (this.durationState === 6) {
          const duration = this.hours * 3600 + this.minutes * 60 + value;
          if (Number.isSafeInteger(this.hours) && Number.isInteger(this.minutes) && this.minutes < 60 && value < 60 && duration > 0 && Number.isFinite(duration) && this.result.durationSec === null) this.result.durationSec = duration;
          this.durationState = 0;
        } else this.durationState = 0;
      } else this.durationState = 0;
    }
    if (first && value === "Stream") this.stream = true;
    if (this.stream && value === "Video") {
      this.firstVideo = !this.result.hasVideo; this.result.hasVideo = true; this.video = true;
    }
    if (this.stream && value === "Audio") this.result.hasAudio = true;
    if (this.video && this.firstVideo && value === "fps" && this.previousNumber !== null && Number.isFinite(this.previousNumber) && this.previousNumber > 0) this.result.frameRate = this.previousNumber;
    this.previousNumber = typeof value === "number" ? value : null;
  }
}

/** No wall-clock or diagnostic-size cutoff. Only the owning operation can cancel;
 * completion waits for the child to close so no decoder survives cancellation. */
export async function runFfmpegSummary(binary: string, args: string[], options: { signal?: AbortSignal; spawn?: typeof spawn } = {}): Promise<FfmpegSummary | null> {
  if (options.signal?.aborted) return null;
  return new Promise(resolve => {
    const parser = new FfmpegSummaryParser();
    const child = (options.spawn ?? spawn)(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    const abort = () => { child.kill("SIGKILL"); };
    let settled = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true; options.signal?.removeEventListener("abort", abort);
      resolve(success && !options.signal?.aborted ? parser.finish() : null);
    };
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => parser.push(text));
    child.once("error", () => finish(false));
    child.once("close", code => finish(code === 0));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
