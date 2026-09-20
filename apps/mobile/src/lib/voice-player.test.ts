import { beforeEach, expect, mock, test } from "bun:test";

let releaseMode: (() => void) | undefined;
let deferMode = false;
const players: { removed: boolean; handler: (status: { isLoaded?: boolean; didJustFinish?: boolean }) => void }[] = [];
const deleted: string[] = [];
mock.module("expo-audio", () => ({
  setAudioModeAsync: () => deferMode ? new Promise<void>(resolve => { releaseMode = resolve; }) : Promise.resolve(),
  createAudioPlayer: () => {
    const state = { removed: false, handler: (_status: { isLoaded?: boolean; didJustFinish?: boolean }) => {} };
    players.push(state);
    return { play() {}, remove() { state.removed = true; }, addListener(_event: string, handler: typeof state.handler) { state.handler = handler; return { remove() {} }; } };
  },
}));
mock.module("expo-file-system", () => ({
  Paths: { cache: "cache" },
  File: class {
    uri: string;
    constructor(...parts: string[]) { this.uri = parts.join("/"); }
    create() {} write() {} delete() { deleted.push(this.uri); }
  },
}));
const { VoicePlayer } = await import("./voice-player");
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const sentence = (sentenceIndex: number) => ({ data: "AAE=", chunkIndex: 0, sentenceIndex, final: true });
beforeEach(() => { players.length = 0; deleted.length = 0; deferMode = false; releaseMode = undefined; });

test("Stop during audio-session setup cannot resurrect queued speech", async () => {
  deferMode = true;
  const player = new VoicePlayer(); player.setEnabled(true); player.handleAudioEvent(sentence(0));
  player.stop(); releaseMode?.(); await tick();
  expect(players).toHaveLength(0); expect(deleted).toHaveLength(1);
  deferMode = false; player.handleAudioEvent(sentence(1)); await tick();
  expect(players).toHaveLength(1); player.dispose();
});

test("Stop resolves an active file and a stale completion cannot stop the next reply", async () => {
  const player = new VoicePlayer(); player.setEnabled(true); player.handleAudioEvent(sentence(0)); await tick();
  const first = players[0]; player.stop(); player.handleAudioEvent(sentence(1)); await tick();
  expect(first.removed).toBe(true); expect(players).toHaveLength(2);
  first.handler({ didJustFinish: true }); await tick();
  expect(players[1].removed).toBe(false); expect(deleted).toHaveLength(1);
  players[1].handler({ didJustFinish: true }); await tick();
  expect(deleted).toHaveLength(2); player.dispose();
});
