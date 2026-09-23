import { getClientActionBindingRegistry } from "./client-action-binding-registry";
import { splitSpeechText } from "./speech-text";
import { randomUUID } from "node:crypto";
import { DEFAULT_VOICE_KEY, VOICE_PCM_PACKET_BYTES, type ProfileVoices, type ServerEvent, type VoiceSentenceEvent } from "@nautilo/types";
import { eventBus } from "@nautilo/runtime";
import { getVoices, getServerSpeechModel, estimateSpeechCostUsd, type SpeechModel } from "@nautilo/agent";
import { log, warn } from "@nautilo/logger";
import { broadcast } from "./ws-publisher";
import { voiceDelivery, type VoiceAudience } from "./voice-delivery";
import { SpeechCapacity } from "./speech-capacity";
import { dialogueSpeechResponse, type DialogueSpeechRequest } from "./dialogue-speech";
import { safelyRecordProviderCost, type ServerProviderCostReceipt } from "../costs/provider-cost-recorder";
import { assertCanUseServerProviderCredentials } from "@nautilo/trust";

const VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 };
// Jessica is used only when the Genie has no usable voice assignment.
const DEFAULT_VOICE_ID = "cgSgspJ2msm6clMCkdW9";
const EMOJI_RE = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;
type AdmittedSentence = VoiceSentenceEvent & { userId: string; roomId: string; agentId: string; turnId: string };
type Turn = {
  key: string; userId: string; roomId: string; agentId: string; turnId: string;
  abort: AbortController; audience: VoiceAudience; voices: Promise<ProfileVoices>; model: Promise<SpeechModel>;
  queue: AdmittedSentence[]; terminal: boolean; busy: boolean; streamId: string; started: boolean; sequence: number;
  suggestions: Set<string>; settling: boolean; admittedAt: number; audioBytes: number;
};

export interface TtsServiceDependencies {
  admit(userId: string, roomId: string, turnId?: string): VoiceAudience | null;
  voices(agentId: string): Promise<ProfileVoices>;
  model(): SpeechModel;
  fetch(input: string, init: RequestInit): Promise<Response>;
  dialogue(request: DialogueSpeechRequest): Promise<Response>;
  apiKey(): string | undefined;
  assertCanUseServerProviderCredentials(
    humanUserId: string,
    origin?: string,
  ): Promise<void>;
  record(receipt: ServerProviderCostReceipt): Promise<void>;
  observe(metric: { streamId: string; stage: "admitted" | "first_audio" | "network_end" | "playback_end" | "aborted"; elapsedMs: number; audioBytes: number }): void;
}

/** One ordered lane per listener owner; provider and cancellation state is per turn. */
export class TtsService {
  private readonly turns = new Map<string, Turn>();
  private readonly runningUsers = new Set<string>();
  private readonly activeTurns = new Map<string, string>();
  private busListener: ((event: ServerEvent) => void) | null = null;
  private readonly deps: TtsServiceDependencies;
  private readonly capacity = new SpeechCapacity();
  private readonly receiptCapacity = new SpeechCapacity();
  private readonly pendingReceipts = new Set<Promise<void>>();
  private readonly pendingSynthesis = new Set<Promise<void>>();

  constructor(deps: Partial<TtsServiceDependencies> = {}) {
    this.deps = {
      admit: (userId, roomId, turnId) => voiceDelivery.admit(userId, roomId, turnId ? getClientActionBindingRegistry()?.inspectTurnSocket(turnId) : undefined),
      voices: agentId => getVoices(agentId),
      model: getServerSpeechModel,
      fetch: (...args) => fetch(...args),
      dialogue: dialogueSpeechResponse,
      apiKey: () => process.env["ELEVENLABS_API_KEY"]?.trim(),
      assertCanUseServerProviderCredentials,
      record: safelyRecordProviderCost,
      observe: metric => log(`[speech] ${JSON.stringify(metric)}`),
      ...deps,
    };
  }

  start(): void {
    if (this.busListener) return;
    this.busListener = event => {
      if (event.type === "voice.sentence") this.enqueue(event);
      else if (event.type === "voice.turn.end") this.finish(event.userId, event.turnId, event.outcome === "aborted", event.agentId);
    };
    eventBus.on(this.busListener);
  }

  /** No user argument is reserved for process shutdown, never a client command. */
  stop(userId?: string, turnId?: string): void {
    for (const turn of this.turns.values()) {
      if (userId !== undefined && turn.userId !== userId) continue;
      if (turnId !== undefined && turn.turnId !== turnId) continue;
      this.abort(turn, "stopped");
    }
  }

  async dispose(): Promise<void> {
    this.stop();
    if (this.busListener) eventBus.off(this.busListener);
    this.busListener = null;
    for (const turn of this.turns.values()) turn.audience.dispose();
    this.turns.clear();
    this.activeTurns.clear();
    await Promise.allSettled([...this.pendingSynthesis]);
    await this.flushCosts();
  }

  async flushCosts(): Promise<void> {
    while (this.pendingReceipts.size) await Promise.all([...this.pendingReceipts]);
  }

  enqueue(event: VoiceSentenceEvent): void {
    if (!event.userId || !event.roomId || !event.agentId || !event.turnId || !this.deps.apiKey()) return;
    const sentence = event as AdmittedSentence;
    const key = JSON.stringify([sentence.userId, sentence.agentId, sentence.turnId]);
    let turn = this.turns.get(key);
    if (!turn) {
      // Admission is at the first producer segment only. Enabling voice or
      // reconnecting during a response must not attach halfway through it.
      if (sentence.index !== 0) return;
      for (const previous of this.turns.values()) {
        if (previous.userId === sentence.userId && previous.roomId === sentence.roomId && previous.agentId === sentence.agentId) this.abort(previous, "stopped");
      }
      const audience = this.deps.admit(sentence.userId, sentence.roomId, sentence.turnId);
      if (!audience) return;
      turn = { key, userId: sentence.userId, roomId: sentence.roomId, agentId: sentence.agentId, turnId: sentence.turnId,
        audience, abort: new AbortController(), voices: this.deps.voices(sentence.agentId), model: (() => { try { return Promise.resolve(this.deps.model()); } catch (error) { return Promise.reject(error instanceof Error ? error : new Error("Speech model unavailable")); } })(), queue: [], terminal: false, busy: false, streamId: randomUUID(), started: false, sequence: 0, suggestions: new Set(), settling: false, admittedAt: performance.now(), audioBytes: 0 };
      void turn.voices.catch(() => {});
      void turn.model.catch(() => {});
      this.turns.set(key, turn);
      this.observe(turn, "admitted");
      const admitted = turn;
      audience.signal.addEventListener("abort", () => this.abort(admitted, "disconnected"), { once: true, signal: turn.abort.signal });
      if (audience.signal.aborted) this.abort(turn, "disconnected");
    }
    if (turn.abort.signal.aborted || turn.terminal || turn.roomId !== sentence.roomId || turn.agentId !== sentence.agentId) return;
    turn.queue.push(sentence);
    void this.drain(sentence.userId);
  }

  finish(userId: string, turnId: string, aborted: boolean, agentId?: string): void {
    for (const turn of this.turns.values()) {
      if (turn.userId !== userId || turn.turnId !== turnId || (agentId !== undefined && turn.agentId !== agentId)) continue;
      turn.terminal = true;
      if (aborted) this.abort(turn, "stopped");
      this.releaseIfDone(turn);
    }
    void this.drain(userId);
  }

  private abort(turn: Turn, reason: "stopped" | "disconnected" | "unavailable"): void {
    if (turn.abort.signal.aborted) return;
    if (turn.started) turn.audience.control({ type: "voice.stream.abort", streamId: turn.streamId, reason });
    turn.abort.abort();
    this.observe(turn, "aborted");
    turn.audience.dispose();
    turn.queue = [];
    if (this.activeTurns.get(turn.userId) === turn.key) this.activeTurns.delete(turn.userId);
    this.releaseIfDone(turn);
    void this.drain(turn.userId);
  }

  private releaseIfDone(turn: Turn): void {
    if (!turn.terminal || turn.busy || turn.queue.length > 0 || turn.settling) return;
    turn.settling = true;
    void (async () => {
      if (turn.started && !turn.abort.signal.aborted) {
        // Flush a short final buffer, then retain the user's playback lane until
        // the sink consumes it. Provider completion is not playback completion.
        turn.audience.control({ type: "voice.stream.end", streamId: turn.streamId, sequence: turn.sequence });
        this.observe(turn, "network_end");
        await turn.audience.drained();
        if (!turn.abort.signal.aborted && turn.audience.format === "pcm_24000") this.observe(turn, "playback_end");
      }
    })().finally(() => {
      turn.abort.abort();
      turn.audience.dispose();
      if (this.turns.get(turn.key) === turn) this.turns.delete(turn.key);
      if (this.activeTurns.get(turn.userId) === turn.key) this.activeTurns.delete(turn.userId);
      void this.drain(turn.userId);
    }).catch(() => warn("[tts] speech playback unavailable"));
  }

  private observe(turn: Turn, stage: Parameters<TtsServiceDependencies["observe"]>[0]["stage"]): void {
    // Durations share the server's monotonic clock. Playback acknowledgements
    // describe rendered samples, not measured acoustic onset at the speaker.
    try { this.deps.observe({ streamId: turn.streamId, stage, elapsedMs: performance.now() - turn.admittedAt, audioBytes: turn.audioBytes }); }
    catch { /* Observability must not interrupt speech. */ }
  }

  private async drain(userId: string): Promise<void> {
    if (this.runningUsers.has(userId)) return;
    this.runningUsers.add(userId);
    try {
      for (;;) {
        const active = this.activeTurns.get(userId);
        const turn = active ? this.turns.get(active) : [...this.turns.values()].find(candidate => candidate.userId === userId && candidate.queue.length > 0 && !candidate.abort.signal.aborted);
        if (!turn || turn.settling || turn.queue.length === 0) break;
        this.activeTurns.set(userId, turn.key);
        const sentence = turn.queue.shift()!;
        turn.busy = true;
        const synthesis = this.synthesize(turn, sentence);
        this.pendingSynthesis.add(synthesis);
        try { await synthesis; }
        catch {
          if (!turn.abort.signal.aborted) { this.abort(turn, "unavailable"); warn("[tts] speech generation unavailable"); }
        }
        finally { this.pendingSynthesis.delete(synthesis); turn.busy = false; this.releaseIfDone(turn); }
      }
    } finally { this.runningUsers.delete(userId); }
  }

  private async synthesize(turn: Turn, sentence: AdmittedSentence): Promise<void> {
    const text = sentence.text.replace(/<voice\s+lang=["'][^"']*["']\s*>|<\/voice\s*>/gi, "").replace(EMOJI_RE, "").trim();
    if (!text.replace(/\[.*?\]/g, "").trim()) return;
    const voices = await turn.voices.catch((): ProfileVoices => ({}));
    if (turn.abort.signal.aborted) return;
    const selected = voices[sentence.lang ?? DEFAULT_VOICE_KEY] ?? voices[DEFAULT_VOICE_KEY];
    const voiceId = selected?.voiceId && /^[a-zA-Z0-9]+$/.test(selected.voiceId)
      ? selected.voiceId : DEFAULT_VOICE_ID;
    const model = await turn.model;
    for (const part of splitSpeechText(text, model.speech.maxInputCharacters)) {
      if (turn.abort.signal.aborted) return;
      await this.synthesizePart(turn, sentence, part, voiceId, model);
    }
  }

  private async synthesizePart(turn: Turn, sentence: AdmittedSentence, text: string, voiceId: string, model: SpeechModel): Promise<void> {
    const voices = await turn.voices.catch((): ProfileVoices => ({}));
    if (sentence.lang && !voices[sentence.lang] && !turn.suggestions.has(sentence.lang)) {
      turn.suggestions.add(sentence.lang);
      broadcast({ type: "voice.suggestion", language: sentence.lang, userId: turn.userId, agentId: turn.agentId }, { kind: "user", userId: turn.userId });
    }
    const streamId = turn.streamId;
    const attemptId = randomUUID();
    let submitted = false;
    let accepted = false;
    let sequence = 0;
    let oddByte: number | null = null;
    const apiKey = this.deps.apiKey();
    if (!apiKey) throw new Error("Speech credentials unavailable");
    // Reserve bounded accounting capacity before incurring cost. Ordinary writes
    // run alongside playback/the next request; a stalled database backpressures
    // admission rather than creating an unbounded fire-and-forget queue.
    const releaseReceipt = await this.receiptCapacity.acquire(turn.abort.signal);
    let release: (() => void) | undefined;
    try {
      release = await this.capacity.acquire(turn.abort.signal);
      if (turn.abort.signal.aborted) return;
      await this.deps.assertCanUseServerProviderCredentials(
        turn.userId,
        "realtime_text_to_speech",
      );
      if (turn.abort.signal.aborted) return;
      submitted = true;
      const response = model.speech.transport === "elevenlabs-dialogue-http"
        ? await this.deps.dialogue({ text, voiceId, model: model.providerModelId, format: turn.audience.format, apiKey, signal: turn.abort.signal, onSubmitted: () => { submitted = true; } })
        : await this.deps.fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=${turn.audience.format}`, {
        method: "POST", headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: model.providerModelId, voice_settings: VOICE_SETTINGS }), signal: turn.abort.signal,
      });
      accepted = response.ok;
      this.capacity.observeMaximum(response.headers.get("maximum-concurrent-requests"));
      this.receiptCapacity.observeMaximum(response.headers.get("maximum-concurrent-requests"));
      if (!response.ok || !response.body) throw new Error("Speech provider unavailable");
      if (turn.abort.signal.aborted) { await response.body.cancel(); return; }
      if (!turn.started) {
        turn.audience.control({ type: "voice.stream.start", version: 1, streamId, turnId: turn.turnId, roomId: turn.roomId, agentId: turn.agentId,
          sampleRate: 24000, encoding: "pcm_s16le", channels: 1, model: model.id });
        turn.started = true;
      }
      log(`[speech] model=${model.id} transport=${model.speech.transport === "elevenlabs-dialogue-http" ? "dialogue_http" : "tts_http"} stream=${streamId}`);
      const reader = response.body.getReader();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done || turn.abort.signal.aborted) break;
          const value: unknown = next.value;
          if (!(value instanceof Uint8Array)) throw new Error("Invalid speech bytes");
          const firstAudio = turn.audioBytes === 0 && value.byteLength > 0;
          turn.audioBytes += value.byteLength;
          if (firstAudio) this.observe(turn, "first_audio");
          if (turn.audience.format === "mp3_44100_128") {
            turn.audience.legacy({ type: "voice.audio", turnId: turn.turnId, data: Buffer.from(value).toString("base64"), chunkIndex: sequence++, sentenceIndex: sentence.index, final: false, userId: turn.userId, roomId: turn.roomId });
          } else {
            let bytes = value;
            if (oddByte !== null) { const merged = new Uint8Array(bytes.length + 1); merged[0] = oddByte; merged.set(bytes, 1); bytes = merged; }
            oddByte = bytes.length % 2 ? bytes[bytes.length - 1]! : null;
            const evenLength = bytes.length - (oddByte === null ? 0 : 1);
            for (let offset = 0; offset < evenLength; offset += VOICE_PCM_PACKET_BYTES) {
              await turn.audience.audio({ streamId, sequence: turn.sequence++, pcm: bytes.slice(offset, Math.min(evenLength, offset + VOICE_PCM_PACKET_BYTES)) });
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (turn.abort.signal.aborted) return;
      if (oddByte !== null) throw new Error("Incomplete PCM sample");
      turn.audience.legacy({ type: "voice.audio", turnId: turn.turnId, data: "", chunkIndex: sequence, sentenceIndex: sentence.index, final: true, userId: turn.userId, roomId: turn.roomId });
    } finally {
      release?.();
      if (!submitted) releaseReceipt();
      else {
        const receipt = Promise.resolve().then(() => this.deps.record({
          identity: `elevenlabs:tts:${attemptId}`, userId: turn.userId, roomId: turn.roomId, agentId: turn.agentId,
          provider: "elevenlabs", operation: "text_to_speech",
          estimatedCostUsd: accepted ? estimateSpeechCostUsd(text, model) : null,
          evidenceState: accepted ? "estimated" : "unknown",
        })).catch(() => warn("[tts] speech cost receipt unavailable")).finally(() => {
          releaseReceipt(); this.pendingReceipts.delete(receipt);
        });
        this.pendingReceipts.add(receipt);
      }
    }
  }
}

let service: TtsService | null = null;
export function getTtsService(): TtsService { return service ??= new TtsService(); }
