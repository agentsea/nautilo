/**
 * Browser-side voice player for server-streamed TTS audio (D021 Phase 3).
 *
 * Buffers per-sentence audio chunks, concatenates them into a single
 * MP3 byte stream, and plays sentences sequentially through a queue.
 *
 * Chunking note: the server base64-encodes each HTTP read() chunk
 * independently. Each of those base64 strings may carry `=` padding
 * when its byte length is not a multiple of 3. We therefore decode
 * each chunk to bytes on arrival and concatenate the *bytes*, never
 * the base64 strings — concatenating padded base64 produces an
 * invalid input that atob() rejects and decodeAudioData() never sees.
 */

type VoiceAudioEvent = {
  data: string;
  chunkIndex: number;
  sentenceIndex: number;
  final: boolean;
};

type StatusCallback = (playing: boolean) => void;

export class VoicePlayer {
  private ctx: AudioContext | null = null;
  private playing = false;
  private enabled = false;
  private onStatusChange: StatusCallback | null = null;

  private currentSentenceIndex = -1;
  private acceptingSentence = false;
  private chunkBuffers: Uint8Array[] = [];
  private playbackQueue: ArrayBuffer[] = [];
  private draining = false;
  private currentSource: AudioBufferSourceNode | null = null;

  constructor(onStatusChange?: StatusCallback) {
    this.onStatusChange = onStatusChange ?? null;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.stop();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Create and resume the AudioContext synchronously inside a user
   * gesture handler (e.g. the "Voice On" click). Chromium requires a
   * transient user activation to allow audio playback; if we defer
   * context creation to the first audio chunk (which can arrive many
   * seconds after the click), the activation window has expired,
   * resume() silently rejects, and source.start() plays into a
   * suspended context. Calling prime() from the click handler
   * captures a live activation.
   *
   * Safe to call multiple times.
   */
  async prime(): Promise<void> {
    if (typeof window === "undefined") return;
    if (!this.ctx || this.ctx.state === "closed") {
      try {
        this.ctx = new AudioContext();
      } catch {
        return;
      }
    }
    if (this.ctx.state === "suspended") {
      try { await this.ctx.resume(); } catch { /* no gesture available */ }
    }
  }

  handleAudioEvent(event: VoiceAudioEvent): void {
    if (!this.enabled) return;

    // A sentence is admitted only from its first data chunk. If this client
    // was outside the Room (or voice-off) when chunk 0 arrived, later chunks
    // must not assemble a truncated "voice from nowhere" after navigation.
    if (event.chunkIndex === 0 && event.data) {
      this.currentSentenceIndex = event.sentenceIndex;
      this.chunkBuffers = [];
      this.acceptingSentence = true;
    }
    if (!this.acceptingSentence || event.sentenceIndex !== this.currentSentenceIndex) return;

    if (event.data) {
      try {
        this.chunkBuffers.push(base64ToBytes(event.data));
      } catch {
        // Malformed base64 — skip this chunk rather than corrupting the sentence
      }
    }

    if (event.final && this.chunkBuffers.length > 0) {
      const combined = concatBytes(this.chunkBuffers);
      this.chunkBuffers = [];
      // combined is always a fresh Uint8Array we allocated, so .buffer is
      // an ArrayBuffer — but TS 5.9 widens to ArrayBufferLike and decodeAudioData
      // only accepts ArrayBuffer. Cast defensively.
      const slice = combined.buffer.slice(
        combined.byteOffset,
        combined.byteOffset + combined.byteLength,
      ) as ArrayBuffer;
      this.playbackQueue.push(slice);
      if (!this.draining) {
        void this.drainQueue();
      }
    }
    if (event.final) this.acceptingSentence = false;
  }

  stop(): void {
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch { /* already stopped */ }
      this.currentSource = null;
    }
    this.playbackQueue = [];
    this.chunkBuffers = [];
    this.currentSentenceIndex = -1;
    this.acceptingSentence = false;
    this.draining = false;
    this.setPlaying(false);
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.setPlaying(true);

    while (this.playbackQueue.length > 0) {
      const buffer = this.playbackQueue.shift()!;
      await this.playSentence(buffer);
    }

    this.draining = false;
    this.setPlaying(false);
  }

  private async playSentence(buffer: ArrayBuffer): Promise<void> {
    const ctx = await this.getContext();
    if (!ctx) return;

    try {
      // decodeAudioData detaches the passed buffer; pass a copy so
      // callers that retain a reference aren't surprised.
      const audioBuffer = await ctx.decodeAudioData(buffer.slice(0));

      // Second state check — an AudioContext can transition to suspended
      // between getContext() and here if the window loses focus during the
      // decode. source.start() on a suspended context plays silently.
      if (ctx.state === "suspended") {
        try { await ctx.resume(); } catch { /* ignore */ }
      }

      return new Promise<void>((resolve) => {
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        this.currentSource = source;

        source.onended = () => {
          if (this.currentSource === source) {
            this.currentSource = null;
          }
          resolve();
        };

        source.start(0);
      });
    } catch {
      // Skip undecodable audio
    }
  }

  private async getContext(): Promise<AudioContext | null> {
    if (!this.ctx || this.ctx.state === "closed") {
      try {
        this.ctx = new AudioContext();
      } catch {
        return null;
      }
    }
    // CRITICAL: AudioContext can enter "suspended" state at any time
    // (Chromium autoplay policy, window focus loss, idle suspension).
    // `void ctx.resume()` fires-and-forgets; we must AWAIT the resume
    // before source.start() or audio plays silently into a paused context.
    if (this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch {
        // Resume can fail without a user gesture. Return the ctx anyway —
        // the next user interaction will re-trigger this path.
      }
    }
    return this.ctx;
  }

  private setPlaying(value: boolean): void {
    if (this.playing !== value) {
      this.playing = value;
      this.onStatusChange?.(value);
    }
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
