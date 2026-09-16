import { describe, expect, test } from "bun:test";
import { inspectReferenceAudio } from "../../src/media-generation/reference-audio-metadata";

export function referenceWavFixture(durationSeconds = 3): Uint8Array {
  const sampleRate = 8_000;
  const dataLength = sampleRate * durationSeconds;
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset);
  write(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); write(8, "WAVE");
  write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  write(36, "data"); view.setUint32(40, dataLength, true); bytes.fill(128, 44);
  return bytes;
}

export function referenceVbrMp3Fixture(frameCount = 116): Uint8Array {
  const frames: Uint8Array[] = [];
  for (let index = 0; index < frameCount; index++) {
    const bitrateIndex = index % 2 === 0 ? 9 : 10; // 128/160 kbps MPEG-1 Layer III
    const header = (0x7ff << 21) | (3 << 19) | (1 << 17) | (1 << 16) | (bitrateIndex << 12);
    const bitrate = bitrateIndex === 9 ? 128 : 160;
    const frame = new Uint8Array(Math.floor(144_000 * bitrate / 44_100));
    new DataView(frame.buffer).setUint32(0, header >>> 0);
    frames.push(frame);
  }
  const bytes = new Uint8Array(frames.reduce((sum, frame) => sum + frame.byteLength, 0));
  let offset = 0;
  for (const frame of frames) { bytes.set(frame, offset); offset += frame.byteLength; }
  return bytes;
}

describe("Seedance audio reference byte metadata", () => {
  test("measures WAV bytes and normalizes x-wav only for provider transport", () => {
    const bytes = referenceWavFixture(3);
    expect(inspectReferenceAudio(bytes, "audio/x-wav")).toEqual({ durationSeconds: 3, providerMimeType: "audio/wav" });
    expect(() => inspectReferenceAudio(bytes, "audio/mpeg")).toThrow();
  });

  test("measures variable-bitrate MP3 from every authorized frame", () => {
    const inspected = inspectReferenceAudio(referenceVbrMp3Fixture(), "audio/mpeg");
    expect(inspected.providerMimeType).toBe("audio/mpeg");
    expect(inspected.durationSeconds).toBeCloseTo(116 * 1_152 / 44_100, 12);
  });

  test("rejects truncated and structurally inconsistent content", () => {
    const wav = referenceWavFixture();
    expect(() => inspectReferenceAudio(wav.subarray(0, wav.length - 1), "audio/wav")).toThrow();
    const mp3 = referenceVbrMp3Fixture();
    mp3[mp3.length - 1] = 1;
    expect(() => inspectReferenceAudio(mp3.subarray(0, mp3.length - 1), "audio/mpeg")).toThrow();
  });
});
