import type { VoiceWorkletStatus } from "./voice-worklet";
/**
 * Browser-side voice player for server-streamed TTS audio.
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

import type { VoicePlaybackEvent } from "@nautilo/types";

type VoiceAudioEvent = {
  turnId?: string;
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
  private generation = 0;
  private worklet: AudioWorkletNode | null = null;
  private workletReady: Promise<void> | null = null;
  private streamId: string | null = null;
  private turnId: string | null = null;
  private silencedTurnId: string | null = null;
  private voiceEvents: VoicePlaybackEvent[] = [];
  private voiceBytes = 0;
  private resolvePlaying: (() => void) | null = null;
  private resourceGeneration = 0;
  private streamReceivedAt = 0;
  private onsetReported = false;

  constructor(onStatusChange?: StatusCallback, private readonly sendVoice?: (event: Record<string, unknown>) => void, private readonly onUnavailable?: () => void) {
    this.onStatusChange = onStatusChange ?? null;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.stop();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  currentTurnId(): string | null { return this.turnId; }

  handleStreamEvent(event: VoicePlaybackEvent): void {
    if (!this.enabled || (event.type === "voice.stream.start" && event.turnId === this.silencedTurnId)) return;
    if (event.type === "voice.stream.start") {
      this.stop();
      this.streamId = event.streamId;
      this.turnId = event.turnId;
      this.streamReceivedAt = performance.now();
      this.onsetReported = false;
    }
    if (event.streamId !== this.streamId) return;
    if (event.type === "voice.stream.abort") {
      // A failed provider turn must not change the user's voice preference.
      // Only a local playback-device failure detaches this listener.
      this.stop();
      return;
    }
    if (this.worklet) { this.postVoiceEvent(event); return; }
    if (event.type === "voice.stream.data") this.voiceBytes += event.pcm.length;
    if (this.voiceBytes > 24000 * 2 * 4) { this.failStreaming(); return; }
    this.voiceEvents.push(event);
    const generation = this.generation;
    void this.prepareWorklet().catch(() => { if (generation === this.generation) this.failStreaming(); });
  }

  private failStreaming(): void {
    this.stop();
    this.enabled = false;
    this.sendVoice?.({ type: "voice.listen", version: 1, roomId: null, enabled: false });
    this.onUnavailable?.();
  }

  private postVoiceEvent(event: VoicePlaybackEvent): void {
    if (event.type === "voice.stream.start") this.worklet?.port.postMessage({ type: "start", streamId: event.streamId });
    else if (event.type === "voice.stream.end") this.worklet?.port.postMessage({ type: "end", streamId: event.streamId });
    else if (event.type === "voice.stream.data") {
      const pcm = event.pcm.slice().buffer;
      this.worklet?.port.postMessage({ type: "audio", streamId: event.streamId, pcm }, [pcm]);
    }
  }

  private prepareWorklet(): Promise<void> {
    if (this.worklet) return Promise.resolve();
    if (this.workletReady) return this.workletReady;
    const resources = this.resourceGeneration;
    const pending = (async () => {
      const ctx = await this.getContext();
      if (!ctx) throw new Error("Audio unavailable");
      if (resources !== this.resourceGeneration) return;
      if (ctx.state !== "running") throw new Error("Audio suspended");
      const { default: url } = await import("./voice-worklet.ts?worker&url");
      await ctx.audioWorklet.addModule(url);
      if (resources !== this.resourceGeneration) return;
      const node = new AudioWorkletNode(ctx, "nautilo-voice", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = ({ data }: MessageEvent<VoiceWorkletStatus>) => {
        if (node !== this.worklet) return;
        if (data.type === "playing") {
          if (this.streamId === data.streamId) {
            this.setPlaying(data.playing === true);
            if (data.playing && !this.onsetReported) {
              this.onsetReported = true;
              console.debug("[speech]", { streamId: data.streamId, stage: "render_started", elapsedMs: performance.now() - this.streamReceivedAt });
            }
          }
        }
        else if (data.streamId === this.streamId && data.type === "consumed") {
          this.sendVoice?.({ type: "voice.consumed", streamId: data.streamId, samples: data.samples });
          if (data.final) console.debug("[speech]", { streamId: data.streamId, stage: "render_ended", elapsedMs: performance.now() - this.streamReceivedAt, samples: data.samples, underruns: data.underruns });
        }
        else if (data.streamId === this.streamId && data.type === "error") this.failStreaming();
      };
      node.connect(ctx.destination);
      node.onprocessorerror = () => { if (this.worklet === node) this.failStreaming(); };
      this.worklet = node;
      ctx.onstatechange = () => {
        if (ctx === this.ctx && this.streamId && ctx.state !== "running") this.failStreaming();
      };
      const queued = this.voiceEvents;
      this.voiceEvents = [];
      this.voiceBytes = 0;
      for (const event of queued) if (event.streamId === this.streamId) this.postVoiceEvent(event);
    })().finally(() => { if (this.workletReady === pending) this.workletReady = null; });
    this.workletReady = pending;
    return pending;
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
    if (!this.enabled || (event.turnId && event.turnId === this.silencedTurnId)) return;
    if (event.turnId && event.turnId !== this.turnId && event.chunkIndex === 0) {
      this.stop();
      this.turnId = event.turnId;
    }

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

  /** Silence this turn locally even if more of its audio is already in transit. */
  stopTalking(): void {
    if (this.turnId) this.silencedTurnId = this.turnId;
    this.stop();
  }

  stop(): void {
    this.generation++;
    this.streamId = null;
    this.turnId = null;
    this.voiceEvents = [];
    this.voiceBytes = 0;
    this.worklet?.port.postMessage({ type: "stop" });
    this.resolvePlaying?.();
    this.resolvePlaying = null;
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

  dispose(): void {
    this.stop();
    this.resourceGeneration++;
    this.workletReady = null;
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.port.close();
      this.worklet.disconnect();
      this.worklet = null;
    }
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) ctx.onstatechange = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    const generation = this.generation;
    this.setPlaying(true);

    while (this.playbackQueue.length > 0 && generation === this.generation) {
      const buffer = this.playbackQueue.shift()!;
      await this.playSentence(buffer, generation);
    }

    if (generation === this.generation) {
      this.draining = false;
      this.setPlaying(false);
    }
  }

  private async playSentence(buffer: ArrayBuffer, generation: number): Promise<void> {
    const ctx = await this.getContext();
    if (!ctx || generation !== this.generation || !this.enabled) return;

    try {
      // decodeAudioData detaches the passed buffer; pass a copy so
      // callers that retain a reference aren't surprised.
      const audioBuffer = await ctx.decodeAudioData(buffer.slice(0));
      if (generation !== this.generation || !this.enabled) return;

      // Second state check — an AudioContext can transition to suspended
      // between getContext() and here if the window loses focus during the
      // decode. source.start() on a suspended context plays silently.
      if (ctx.state === "suspended") {
        try { await ctx.resume(); } catch { /* ignore */ }
      }
      if (generation !== this.generation || !this.enabled) return;

      return new Promise<void>((resolve) => {
        this.resolvePlaying = resolve;
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
