import { z } from "zod";

export const VOICE_STREAM_PROTOCOL = 1 as const;
export const VOICE_PCM_SAMPLE_RATE = 24_000;
/** A wire packet contains at most one second of mono PCM16, not a whole reply. */
export const VOICE_PCM_PACKET_BYTES = VOICE_PCM_SAMPLE_RATE * 2;

const identity = {
  streamId: z.uuid(),
  turnId: z.string().min(1),
  roomId: z.string().min(1),
  agentId: z.string().min(1),
};
export const voiceStreamControlSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("voice.stream.start"),
    version: z.literal(VOICE_STREAM_PROTOCOL),
    ...identity,
    sampleRate: z.literal(VOICE_PCM_SAMPLE_RATE),
    encoding: z.literal("pcm_s16le"),
    channels: z.literal(1),
    model: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal("voice.stream.end"),
    streamId: z.uuid(),
    sequence: z.number().int().nonnegative().max(0xffffffff),
  }).strict(),
  z.object({
    type: z.literal("voice.stream.abort"),
    streamId: z.uuid(),
    reason: z.enum(["stopped", "superseded", "unavailable", "disconnected", "overflow", "invalid_audio"]),
  }).strict(),
]);
export type VoiceStreamControl = z.infer<typeof voiceStreamControlSchema>;
export type VoiceStreamStart = Extract<VoiceStreamControl, { type: "voice.stream.start" }>;
export type VoicePcmFrame = Readonly<{ streamId: string; sequence: number; pcm: Uint8Array }>;
export type VoicePlaybackEvent = VoiceStreamControl | (VoicePcmFrame & { type: "voice.stream.data" });

export const voiceListenerSchema = z.object({
  type: z.literal("voice.listen"),
  version: z.literal(VOICE_STREAM_PROTOCOL),
  roomId: z.string().min(1).nullable(),
  enabled: z.boolean(),
}).strict();
export type VoiceListener = z.infer<typeof voiceListenerSchema>;

// Fixed header: four-byte magic/version, UUID ASCII (36), sequence u32,
// payload length u32. A length-bound copy keeps views of large buffers out.
const HEADER_BYTES = 48;
const MAGIC = 0x4e565301;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeVoicePcmFrame(frame: VoicePcmFrame): Uint8Array {
  if (!UUID.test(frame.streamId) || !Number.isInteger(frame.sequence) || frame.sequence < 0 || frame.sequence > 0xffffffff ||
      frame.pcm.byteLength === 0 || frame.pcm.byteLength > VOICE_PCM_PACKET_BYTES || frame.pcm.byteLength % 2 !== 0) {
    throw new Error("Invalid voice PCM frame");
  }
  const out = new Uint8Array(HEADER_BYTES + frame.pcm.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC);
  for (let i = 0; i < 36; i++) out[4 + i] = frame.streamId.charCodeAt(i);
  view.setUint32(40, frame.sequence);
  view.setUint32(44, frame.pcm.byteLength);
  out.set(frame.pcm, HEADER_BYTES);
  return out;
}

export function decodeVoicePcmFrame(input: ArrayBuffer | Uint8Array): VoicePcmFrame | null {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength <= HEADER_BYTES || bytes.byteLength > HEADER_BYTES + VOICE_PCM_PACKET_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(44);
  if (view.getUint32(0) !== MAGIC || length !== bytes.byteLength - HEADER_BYTES || length % 2 !== 0) return null;
  let streamId = "";
  for (let i = 0; i < 36; i++) streamId += String.fromCharCode(bytes[4 + i]!);
  if (!UUID.test(streamId)) return null;
  return { streamId, sequence: view.getUint32(40), pcm: bytes.slice(HEADER_BYTES) };
}

/** Per-connection ingress; a reconnect constructs a fresh instance. */
export class VoiceStreamIngress {
  private active: { start: VoiceStreamStart; sequence: number } | null = null;
  private ended: string | null = null;

  reset(): void { this.active = null; this.ended = null; }

  control(value: unknown): VoiceStreamControl | null {
    const parsed = voiceStreamControlSchema.safeParse(value);
    if (!parsed.success) return null;
    const event = parsed.data;
    if (event.type === "voice.stream.start") {
      // The server must terminate the previous stream before starting another.
      if (this.active !== null) return null;
      this.ended = null;
      this.active = { start: event, sequence: 0 };
      return event;
    }
    // End seals the network stream; Stop may still cancel its queued playback.
    if (event.type === "voice.stream.abort" && this.active === null && this.ended === event.streamId) {
      this.ended = null;
      return event;
    }
    if (this.active?.start.streamId !== event.streamId) return null;
    if (event.type === "voice.stream.end" && event.sequence !== this.active.sequence) return null;
    this.ended = event.type === "voice.stream.end" ? event.streamId : null;
    this.active = null;
    return event;
  }

  data(value: ArrayBuffer | Uint8Array): VoicePcmFrame | null {
    const frame = decodeVoicePcmFrame(value);
    if (!frame || !this.active || frame.streamId !== this.active.start.streamId || frame.sequence !== this.active.sequence) return null;
    this.active.sequence++;
    return frame;
  }
}
