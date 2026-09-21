import { describe, expect, test } from "bun:test";
import { decodeVoicePcmFrame, encodeVoicePcmFrame, VoiceStreamIngress, type VoiceStreamStart } from "../../src/voice-stream";

const streamId = "11111111-1111-4111-8111-111111111111";
const start: VoiceStreamStart = { type: "voice.stream.start", version: 1, streamId, turnId: "turn-a", roomId: "room-a", agentId: "agent-a", sampleRate: 24000, channels: 1, encoding: "pcm_s16le", model: "eleven_v3" };
const packet = (sequence = 0) => encodeVoicePcmFrame({ streamId, sequence, pcm: new Uint8Array([0, 1, 255, 127]) });

describe("speech stream protocol", () => {
  test("round-trips only bounded, exact-length PCM packets including offset views", () => {
    const frame = packet();
    const envelope = new Uint8Array(frame.length + 10);
    envelope.set(frame, 5);
    expect(decodeVoicePcmFrame(envelope.subarray(5, 5 + frame.length))?.pcm).toEqual(new Uint8Array([0, 1, 255, 127]));
    expect(decodeVoicePcmFrame(frame.subarray(0, frame.length - 1))).toBeNull();
    frame[0] = 0;
    expect(decodeVoicePcmFrame(frame)).toBeNull();
    expect(() => encodeVoicePcmFrame({ streamId, sequence: 0, pcm: new Uint8Array(1) })).toThrow();
    expect(() => encodeVoicePcmFrame({ streamId, sequence: -1, pcm: new Uint8Array(2) })).toThrow();
  });
  test("rejects stale, duplicate, reordered and unauthenticated-generation audio", () => {
    const ingress = new VoiceStreamIngress();
    expect(ingress.data(packet())).toBeNull();
    expect(ingress.control(start)).toEqual(start);
    expect(ingress.control(start)).toBeNull();
    expect(ingress.data(packet(1))).toBeNull();
    expect(ingress.data(packet(0))?.sequence).toBe(0);
    expect(ingress.data(packet(0))).toBeNull();
    expect(ingress.control({ type: "voice.stream.end", streamId, sequence: 2 })).toBeNull();
    expect(ingress.control({ type: "voice.stream.end", streamId, sequence: 1 })?.type).toBe("voice.stream.end");
    expect(ingress.data(packet(1))).toBeNull();
    ingress.control(start);
    ingress.reset();
    expect(ingress.data(packet())).toBeNull();
  });
  test("requires the negotiated format and safe control shape", () => {
    const ingress = new VoiceStreamIngress();
    expect(ingress.control({ ...start, sampleRate: 44100 })).toBeNull();
    expect(ingress.control({ ...start, userId: "spoof" })).toBeNull();
    expect(ingress.control({ ...start, model: "" })).toBeNull();
  });
  test("new catalog model IDs do not require a client model-name release", () => {
    expect(new VoiceStreamIngress().control({ ...start, model: "elevenlabs:synthetic-future" })?.type).toBe("voice.stream.start");
  });
  test("Stop after network end cancels only the still-draining playback stream", () => {
    const ingress = new VoiceStreamIngress(); ingress.control(start);
    ingress.control({ type: "voice.stream.end", streamId, sequence: 0 });
    const abort = { type: "voice.stream.abort", streamId, reason: "stopped" } as const;
    expect(ingress.control(abort)).toEqual(abort);
    expect(ingress.control(abort)).toBeNull();
    ingress.control({ ...start, streamId: "22222222-2222-4222-8222-222222222222" });
    expect(ingress.control(abort)).toBeNull();
  });
});
