import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { VoicePlayer } from "../../src/adapters/voice-player";
import type { VoiceWorkletStatus } from "../../src/adapters/voice-worklet";

mock.module("../../src/adapters/voice-worklet.ts?worker&url", () => ({ default: "voice-worklet.js" }));
const originalContext = globalThis.AudioContext;
const originalNode = globalThis.AudioWorkletNode;
let node: FakeNode;
class FakeNode {
  port = { onmessage: null as ((event: { data: VoiceWorkletStatus }) => void) | null, postMessage() {}, close() {} };
  constructor() { node = this; }
  connect() {}
  disconnect() {}
  emit(data: VoiceWorkletStatus) { this.port.onmessage?.({ data }); }
}
class FakeContext {
  state = "running";
  audioWorklet = { addModule: async () => {} };
  destination = {};
  close() { return Promise.resolve(); }
}
let player: VoicePlayer;
let stoppable: boolean[];
const start = (streamId = "stream-a", turnId = "turn-a") => ({
  type: "voice.stream.start" as const, version: 1 as const, streamId, turnId,
  roomId: "room-a", agentId: "genie-a", sampleRate: 24000 as const,
  encoding: "pcm_s16le" as const, channels: 1 as const, model: "speech-model",
});
beforeAll(() => {
  globalThis.AudioContext = FakeContext as unknown as typeof AudioContext;
  globalThis.AudioWorkletNode = FakeNode as unknown as typeof AudioWorkletNode;
});
beforeEach(() => {
  stoppable = [];
  player = new VoicePlayer(undefined, undefined, undefined, value => stoppable.push(value));
  player.setEnabled(true);
});
afterEach(() => player.dispose());
afterAll(() => {
  globalThis.AudioContext = originalContext;
  globalThis.AudioWorkletNode = originalNode;
  mock.restore();
});

test("stream is stoppable before sound, through gaps, and until the sink finishes", async () => {
  player.handleStreamEvent(start());
  expect(player.canStopTalking()).toBe(true);
  await Bun.sleep(0);
  node.emit({ type: "playing", streamId: "stream-a", playing: true });
  node.emit({ type: "playing", streamId: "stream-a", playing: false });
  expect(player.canStopTalking()).toBe(true);
  player.handleStreamEvent({ type: "voice.stream.end", streamId: "stream-a", sequence: 0 });
  expect(player.canStopTalking()).toBe(true);
  node.emit({ type: "consumed", streamId: "stream-a", samples: 10, underruns: 0, final: true });
  expect(player.canStopTalking()).toBe(false);
  expect(player.currentTurnId()).toBeNull();
  expect(stoppable).toEqual([true, false]);
});

test("stop in a sentence gap rejects late audio and leaves the next reply enabled", async () => {
  player.handleStreamEvent(start());
  await Bun.sleep(0);
  node.emit({ type: "playing", streamId: "stream-a", playing: false });
  player.stopTalking();
  expect(player.canStopTalking()).toBe(false);
  player.handleStreamEvent(start());
  player.handleStreamEvent({ type: "voice.stream.data", streamId: "stream-a", sequence: 0, pcm: new Uint8Array(2) });
  node.emit({ type: "playing", streamId: "stream-a", playing: true });
  expect(player.canStopTalking()).toBe(false);
  player.handleStreamEvent(start("stream-b", "turn-b"));
  expect(player.canStopTalking()).toBe(true);
  node.emit({ type: "consumed", streamId: "stream-a", samples: 10, underruns: 0, final: true });
  expect(player.currentTurnId()).toBe("turn-b");
  expect(player.canStopTalking()).toBe(true);
  expect(player.isEnabled()).toBe(true);
});

test("abort, voice off, and navigation clear stoppability even before playback", async () => {
  player.handleStreamEvent(start());
  await Bun.sleep(0);
  player.handleStreamEvent({ type: "voice.stream.abort", streamId: "stream-a", reason: "unavailable" });
  expect(player.canStopTalking()).toBe(false);
  expect(player.isEnabled()).toBe(true);
  player.handleStreamEvent(start("stream-b", "turn-b"));
  player.setEnabled(false);
  expect(player.canStopTalking()).toBe(false);
  player.setEnabled(true);
  player.handleStreamEvent(start("stream-c", "turn-c"));
  player.stop();
  expect(player.canStopTalking()).toBe(false);
});
