import { describe, test, expect, beforeEach } from "bun:test";
import { VoicePlayer } from "./voice-player";

describe("VoicePlayer", () => {
  let statusUpdates: boolean[];
  let player: VoicePlayer;

  beforeEach(() => {
    statusUpdates = [];
    player = new VoicePlayer((playing) => statusUpdates.push(playing));
  });

  test("starts disabled", () => {
    expect(player.isEnabled()).toBe(false);
  });

  test("setEnabled toggles state", () => {
    player.setEnabled(true);
    expect(player.isEnabled()).toBe(true);
    player.setEnabled(false);
    expect(player.isEnabled()).toBe(false);
  });

  test("handleAudioEvent is ignored when disabled", () => {
    // Should not throw or queue anything when disabled
    player.handleAudioEvent({
      data: btoa("fake-audio"),
      chunkIndex: 0,
      sentenceIndex: 0,
      final: true,
    });
    // No status change expected since player is disabled
    expect(statusUpdates).toHaveLength(0);
  });

  test("stop clears queue and resets state", () => {
    player.setEnabled(true);
    player.stop();
    expect(player.isEnabled()).toBe(true);
    // Stop should not disable, just clear playback
  });

  test("a provider failure stops the turn without switching voice off", async () => {
    player.setEnabled(true);
    player.handleStreamEvent({ type: "voice.stream.start", version: 1, streamId: "stream-a", turnId: "turn-a", roomId: "room-a", agentId: "agent-a", sampleRate: 24000, encoding: "pcm_s16le", channels: 1, model: "eleven_v3_conversational" });
    player.handleStreamEvent({ type: "voice.stream.abort", streamId: "stream-a", reason: "unavailable" });
    await Promise.resolve();
    expect(player.isEnabled()).toBe(true);
    expect(player.currentTurnId()).toBeNull();
  });

  test("setEnabled(false) calls stop internally", () => {
    player.setEnabled(true);
    // Queue a chunk
    player.handleAudioEvent({
      data: btoa("fake"),
      chunkIndex: 0,
      sentenceIndex: 0,
      final: false,
    });
    player.setEnabled(false);
    expect(player.isEnabled()).toBe(false);
  });

  test("buffers chunks per sentence index", () => {
    player.setEnabled(true);
    // Send non-final chunk — should buffer, not play
    player.handleAudioEvent({
      data: btoa("chunk1"),
      chunkIndex: 0,
      sentenceIndex: 0,
      final: false,
    });
    // New sentence index resets buffer
    player.handleAudioEvent({
      data: btoa("chunk2"),
      chunkIndex: 0,
      sentenceIndex: 1,
      final: false,
    });
    // No status change until final + decode succeeds
    player.stop();
  });

  test("does not resume a sentence whose first chunk was discarded", () => {
    player.setEnabled(true);
    const state = player as unknown as {
      acceptingSentence: boolean;
      chunkBuffers: Uint8Array[];
    };

    player.handleAudioEvent({
      data: btoa("late-chunk"),
      chunkIndex: 2,
      sentenceIndex: 0,
      final: false,
    });
    expect(state.acceptingSentence).toBe(false);
    expect(state.chunkBuffers).toHaveLength(0);

    player.handleAudioEvent({
      data: btoa("first-chunk"),
      chunkIndex: 0,
      sentenceIndex: 1,
      final: false,
    });
    expect(state.acceptingSentence).toBe(true);
    expect(state.chunkBuffers).toHaveLength(1);

    player.stop();
    expect(state.acceptingSentence).toBe(false);
    expect(state.chunkBuffers).toHaveLength(0);
  });

  for (const stage of ["resume", "decode"] as const) {
    test(`Stop while ${stage} is pending cannot resurrect legacy audio`, async () => {
      const original = globalThis.AudioContext;
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      let sources = 0;
      let reached = false;
      class Context {
        state = stage === "resume" ? "suspended" : "running";
        destination = {};
        async resume() { reached = true; await pending; this.state = "running"; }
        async decodeAudioData() { reached = true; if (stage === "decode") await pending; return {}; }
        createBufferSource() { sources++; throw new Error("Stale audio source created"); }
        async close() { this.state = "closed"; }
      }
      globalThis.AudioContext = Context as unknown as typeof AudioContext;
      try {
        player.setEnabled(true);
        player.handleAudioEvent({ turnId: "turn", data: btoa("audio"), chunkIndex: 0, sentenceIndex: 0, final: true });
        await Bun.sleep(0); expect(reached).toBe(true);
        player.stop(); release(); await Bun.sleep(0);
        expect(sources).toBe(0);
        expect(statusUpdates.at(-1)).toBe(false);
        player.dispose();
      } finally { globalThis.AudioContext = original; release(); }
    });
  }
});
