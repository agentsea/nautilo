import { VOICE_PCM_PACKET_BYTES, type VoicePlaybackEvent, type VoiceStreamStart } from "@nautilo/types";
import type { NativePcmSink, PcmStatus } from "../../modules/nautilo-voice-pcm";

/** Native audio ownership is scoped to one admitted stream, including async bridge calls. */
export class VoiceStreamPlayer {
  private active: VoiceStreamStart | null = null;
  private sequence = 0;
  private submitted = 0;
  private consumed = 0;
  private ended = false;
  private serial: Promise<void> = Promise.resolve();
  private readonly subscription: { remove(): void };

  constructor(private readonly sink: NativePcmSink, private readonly callbacks: {
    status(playing: boolean): void;
    consumed(streamId: string, samples: number): void;
    failure(): void;
  }) {
    this.subscription = sink.addListener("status", status => this.onStatus(status));
  }

  get turnId(): string | undefined { return this.active?.turnId; }

  handle(event: VoicePlaybackEvent): void {
    if (event.type === "voice.stream.start") {
      this.stop();
      this.active = event;
      this.sequence = this.submitted = this.consumed = 0;
      this.ended = false;
      this.schedule(event.streamId, () => this.sink.begin(event.streamId));
    } else if (event.streamId === this.active?.streamId) {
      if (event.type === "voice.stream.abort") this.stop();
      else if (event.type === "voice.stream.end") {
        if (event.sequence !== this.sequence || this.ended) { this.fail(); return; }
        this.ended = true;
        this.schedule(event.streamId, () => this.sink.finish(event.streamId));
      } else {
        if (this.ended || event.sequence !== this.sequence || event.pcm.length === 0 || event.pcm.length % 2 !== 0 ||
            event.pcm.length > VOICE_PCM_PACKET_BYTES || (this.submitted - this.consumed) * 2 + event.pcm.length > VOICE_PCM_PACKET_BYTES * 4) {
          this.fail(); return;
        }
        this.sequence++;
        this.submitted += event.pcm.length / 2;
        this.schedule(event.streamId, () => this.sink.write(event.streamId, event.pcm));
      }
    }
  }

  stop(): void {
    const id = this.active?.streamId;
    this.active = null;
    this.callbacks.status(false);
    // Queue after a pending begin/write, before any replacement begin. Old
    // continuations inspect identity before touching the sink.
    if (id) this.serial = this.serial.then(() => this.sink.stop(id)).catch(() => {});
  }

  dispose(): void { this.stop(); this.subscription.remove(); }

  private schedule(id: string, operation: () => Promise<void>): void {
    this.serial = this.serial.then(async () => {
      if (this.active?.streamId === id) await operation();
    }).catch(() => { if (this.active?.streamId === id) this.fail(); });
  }
  private fail(): void { this.stop(); this.callbacks.failure(); }
  private onStatus(status: PcmStatus): void {
    if (status.streamId !== this.active?.streamId) return;
    if (status.error || !Number.isSafeInteger(status.consumedSamples) || status.consumedSamples < this.consumed || status.consumedSamples > this.submitted) {
      this.fail(); return;
    }
    this.consumed = status.consumedSamples;
    this.callbacks.consumed(status.streamId, this.consumed);
    this.callbacks.status(status.playing);
    if (status.ended) {
      if (!this.ended || this.consumed !== this.submitted) { this.fail(); return; }
      this.active = null;
      this.callbacks.status(false);
    }
  }
}
