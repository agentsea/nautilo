import { expect, test } from "bun:test";
import { VoiceStreamPlayer } from "./voice-stream-player";
import type { NativePcmSink, PcmStatus } from "../../modules/nautilo-voice-pcm";
import type { VoiceStreamStart } from "@nautilo/types";

const start: VoiceStreamStart = { type: "voice.stream.start", version: 1, streamId: "11111111-1111-4111-8111-111111111111", turnId: "turn", roomId: "room", agentId: "agent", sampleRate: 24000, encoding: "pcm_s16le", channels: 1, model: "elevenlabs:eleven_v3" };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(begin: () => Promise<void> = async () => {}) {
  const calls: string[] = []; const credits: number[] = []; let failures = 0;
  let status!: (event: PcmStatus) => void;
  const sink: NativePcmSink = {
    begin: async id => { calls.push(`begin:${id}`); await begin(); },
    write: async (_id, bytes) => { calls.push(`write:${bytes.length}`); },
    finish: async () => { calls.push("finish"); }, stop: async id => { calls.push(`stop:${id}`); },
    addListener: (_event, handler) => { status = handler; return { remove() {} }; },
  };
  const player = new VoiceStreamPlayer(sink, { status() {}, consumed: (_id, samples) => credits.push(samples), failure: () => failures++ });
  return { player, calls, credits, status: (consumedSamples: number, ended = false) => status({ streamId: start.streamId, consumedSamples, playing: !ended, ended }), failures: () => failures };
}
test("native playback receives PCM before final and credits only rendered samples", async () => {
  const f = fixture(); f.player.handle(start);
  f.player.handle({ type: "voice.stream.data", streamId: start.streamId, sequence: 0, pcm: new Uint8Array(4800) });
  await tick(); expect(f.calls).toContain("write:4800"); expect(f.calls).not.toContain("finish"); expect(f.credits).toEqual([]);
  f.status(1200); expect(f.credits).toEqual([1200]);
  f.player.handle({ type: "voice.stream.end", streamId: start.streamId, sequence: 1 }); await tick();
  expect(f.player.turnId).toBe("turn"); f.status(2400, true); expect(f.player.turnId).toBeUndefined();
  f.player.dispose();
});
test("stop during native begin fences queued audio and stale playback callbacks", async () => {
  let release!: () => void; const f = fixture(() => new Promise(resolve => { release = resolve; }));
  f.player.handle(start); await tick();
  f.player.handle({ type: "voice.stream.data", streamId: start.streamId, sequence: 0, pcm: new Uint8Array(4800) });
  f.player.stop(); release(); await tick(); f.status(2400);
  expect(f.calls.filter(c => c.startsWith("write"))).toEqual([]); expect(f.credits).toEqual([]); expect(f.calls).toContain(`stop:${start.streamId}`);
  f.player.dispose();
});
test("bounds pending bridge audio and rejects reordered frames", async () => {
  const f = fixture(); f.player.handle(start);
  for (let i = 0; i < 5; i++) f.player.handle({ type: "voice.stream.data", streamId: start.streamId, sequence: i, pcm: new Uint8Array(48000) });
  await tick(); expect(f.failures()).toBe(1); expect(f.player.turnId).toBeUndefined();
  f.player.handle(start); f.player.handle({ type: "voice.stream.data", streamId: start.streamId, sequence: 2, pcm: new Uint8Array(2) });
  expect(f.failures()).toBe(2); f.player.dispose();
});
