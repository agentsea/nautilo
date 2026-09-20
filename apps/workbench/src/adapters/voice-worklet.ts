import { VoicePcmQueue } from "./voice-pcm-queue";

export type VoiceWorkletCommand =
  | { type: "start" | "end"; streamId: string }
  | { type: "stop" }
  | { type: "audio"; streamId: string; pcm: ArrayBuffer };
export type VoiceWorkletStatus =
  | { type: "playing"; streamId: string; playing: boolean }
  | { type: "consumed"; streamId: string; samples: number; underruns: number; final: boolean }
  | { type: "error"; streamId: string };

declare const sampleRate: number;
declare abstract class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class VoiceProcessor extends AudioWorkletProcessor {
  private queue: VoicePcmQueue | null = null;
  private streamId = "";
  private reported = 0;
  private playing = false;
  constructor() {
    super();
    this.port.onmessage = ({ data }: MessageEvent<VoiceWorkletCommand>) => {
      if (data.type === "start") {
        this.streamId = data.streamId;
        // Eighty milliseconds starts the qualified lab path. The four-second
        // source queue is paired with server consumption credits, not reply size.
        this.queue = new VoicePcmQueue(24000, sampleRate, 1920, 24000 * 4);
        this.reported = 0;
      } else if (data.type === "stop") {
        this.queue = null;
        this.playing = false;
        this.port.postMessage({ type: "playing", streamId: this.streamId, playing: false });
      } else if (data.streamId === this.streamId && this.queue) {
        if (data.type === "audio" && !this.queue.write(new Uint8Array(data.pcm))) {
          this.port.postMessage({ type: "error", streamId: this.streamId });
          this.queue = null;
        } else if (data.type === "end") this.queue.finish();
      }
    };
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0];
    if (!output) return true;
    output.fill(0);
    const queue = this.queue;
    if (!queue) return true;
    const before = queue.consumed;
    queue.render(output);
    if (queue.consumed > before && !this.playing) {
      this.playing = true;
      this.port.postMessage({ type: "playing", streamId: this.streamId, playing: true });
    }
    if (queue.consumed - this.reported >= 2400 || queue.done) {
      this.reported = queue.consumed;
      this.port.postMessage({ type: "consumed", streamId: this.streamId, samples: queue.consumed, underruns: queue.underruns, final: queue.done });
    }
    if (queue.done) {
      this.queue = null;
      this.playing = false;
      this.port.postMessage({ type: "playing", streamId: this.streamId, playing: false });
    }
    return true;
  }
}
registerProcessor("nautilo-voice", VoiceProcessor);
