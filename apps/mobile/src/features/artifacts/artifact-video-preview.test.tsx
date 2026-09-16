import { beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { interruptMediaForRecording } from "@/lib/media-playback-interruption";

const browser = new Window();
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator, IS_REACT_ACT_ENVIRONMENT: true });

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  return { promise: new Promise<T>((done, fail) => { resolve = done; reject = fail; }), resolve, reject };
}

type ReadyFile = { kind: "ready"; fileUri: string; revision: number; cleanup(): void };
let accountId = "reader-a";
let speaking = false;
let localFile = true;
let cachePrepares = 0;
let playerCreates = 0;
let acquired: Array<Deferred<ReadyFile | { kind: "failed"; reason: string }>> = [];
let lifecycleListener: ((state: string) => void) | undefined;
let eventListener: ((event: { type: string; id?: string }) => void) | undefined;
let orderedCalls: string[] = [];
const subscribeEvents = (listener: typeof eventListener) => {
  eventListener = listener;
  return () => { if (eventListener === listener) eventListener = undefined; };
};

type Player = {
  status: string;
  duration: number;
  currentTime: number;
  loop: boolean;
  staysActiveInBackground: boolean;
  showNowPlayingNotification: boolean;
  allowsExternalPlayback: boolean;
  audioMixingMode: string;
  replaceAsync(source: unknown): Promise<void>;
  play(): void;
  pause(): void;
  release(): void;
  addListener(name: string, listener: (event: { status: string }) => void): { remove(): void };
  emit(status: string): void;
};
const players: Player[] = [];

const element = (tag: string) => ({ children, onPress }: { children?: unknown; onPress?: () => void }) => createElement(tag, { onClick: onPress }, children as never);
mock.module("react-native", () => ({
  ActivityIndicator: element("span"), Pressable: element("button"), Text: element("span"), View: element("div"),
  StyleSheet: { create: <T,>(styles: T) => styles },
}));
mock.module("expo-router", () => ({ useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]) }));
mock.module("expo-video", () => ({
  VideoView: ({ player }: { player: Player }) => createElement("video", { "data-player": players.indexOf(player) }),
  createVideoPlayer: () => {
    playerCreates += 1;
    const listeners: Array<(event: { status: string }) => void> = [];
    const player: Player = {
      status: "idle", duration: 60, currentTime: 0, loop: true, staysActiveInBackground: true,
      showNowPlayingNotification: true, allowsExternalPlayback: true, audioMixingMode: "mixWithOthers",
      replaceAsync: async (source) => { orderedCalls.push(`replace:${JSON.stringify(source)}`); },
      play: () => { orderedCalls.push("play"); },
      pause: () => { orderedCalls.push("pause"); },
      release: () => {
        if (document.querySelector(`video[data-player="${players.indexOf(player)}"]`)) orderedCalls.push("release-while-view-attached");
        orderedCalls.push("release");
      },
      addListener: (_name, listener) => { listeners.push(listener); return { remove: () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); } }; },
      emit: (status) => { player.status = status; for (const listener of [...listeners]) listener({ status }); },
    };
    players.push(player);
    return player;
  },
}));
mock.module("../../../modules/nautilo-file-export", () => ({
  isFileExportAvailable: () => true,
  default: { prepareExportCacheAsync: async () => { cachePrepares += 1; } },
}));
mock.module("@/providers/server-registry", () => ({ useServers: () => ({ activeServer: { id: "server-a", serverUrl: "https://test.invalid" } }) }));
mock.module("@/providers/auth", () => ({ useAuth: () => ({ viewer: { userId: accountId }, status: "signed-in" }) }));
mock.module("@/providers/artifact-events", () => ({ useArtifactEvents: () => ({ subscribe: subscribeEvents }) }));
mock.module("@/providers/voice", () => ({ useVoice: () => ({ speaking }) }));
mock.module("@/providers/theme", () => ({ useAppTheme: () => ({ color: { brand: { accent: "#fff" }, text: { foreground: "#fff" } } }) }));
mock.module("@/platform/app-lifecycle", () => ({
  appLifecycle: { currentState: () => "active", addEventListener: (_event: string, listener: (state: string) => void) => { lifecycleListener = listener; return { remove: () => { if (lifecycleListener === listener) lifecycleListener = undefined; } }; } },
}));
mock.module("@/lib/video-file-container", () => ({ isLocalVideoFile: () => localFile }));
mock.module("./artifact-original-access", () => ({ acquireAuthorizedArtifactOriginal: () => {
  const next = deferred<ReadyFile | { kind: "failed"; reason: string }>();
  acquired.push(next);
  return next.promise;
} }));

const { ArtifactVideoPreview } = await import("./artifact-video-preview.native");

async function mount(revision = 1) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = async (nextRevision = revision) => { await act(async () => { root.render(createElement(ArtifactVideoPreview, { artifactId: "artifact-a", revision: nextRevision })); }); };
  await render();
  return { host, render, close: async () => { await act(async () => { root.unmount(); await Promise.resolve(); }); host.remove(); } };
}
function ready(fileUri = "file:///cache/nautilo-exports/op/video.mp4", revision = 1): ReadyFile {
  return { kind: "ready", fileUri, revision, cleanup: () => { orderedCalls.push(`cleanup:${fileUri}`); } };
}
function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((node) => node.textContent === label);
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}

beforeEach(() => {
  accountId = "reader-a"; speaking = false; localFile = true; cachePrepares = playerCreates = 0;
  acquired = []; lifecycleListener = undefined; eventListener = undefined; orderedCalls = []; players.length = 0;
});

test("uses only a supported local progressive source, disables player cache, and never autoplays", async () => {
  const ui = await mount();
  try {
    expect(cachePrepares).toBe(1);
    expect(players).toHaveLength(0);
    await act(async () => { acquired[0].resolve(ready()); await Promise.resolve(); });
    expect(playerCreates).toBe(1);
    expect(orderedCalls).toContain('replace:{"uri":"file:///cache/nautilo-exports/op/video.mp4","contentType":"progressive","useCaching":false}');
    expect(orderedCalls).not.toContain("play");
    await act(async () => { players[0].emit("readyToPlay"); });
    expect(ui.host.querySelector("video")).not.toBeNull();
    expect(orderedCalls).not.toContain("play");
    const player = players[0];
    expect([player.loop, player.staysActiveInBackground, player.showNowPlayingNotification, player.allowsExternalPlayback, player.audioMixingMode]).toEqual([false, false, false, false, "auto"]);
  } finally { await ui.close(); }
});

test("cancelling delayed acquisition cleans its returned file and never publishes a stale player", async () => {
  const ui = await mount();
  try {
    await act(async () => { button(ui.host, "Cancel video preparation").click(); });
    expect(ui.host.textContent).toContain("Video preparation cancelled");
    await act(async () => { acquired[0].resolve(ready()); await Promise.resolve(); });
    expect(players).toHaveLength(0);
    expect(orderedCalls).toEqual(["cleanup:file:///cache/nautilo-exports/op/video.mp4"]);
  } finally { await ui.close(); }
});

test("detaches the committed video view before decoder release on error, source change and unmount", async () => {
  const ui = await mount();
  try {
    await act(async () => { acquired[0].resolve(ready()); });
    await act(async () => { players[0].emit("readyToPlay"); });
    expect(ui.host.querySelector("video")).not.toBeNull();
    await act(async () => { players[0].emit("error"); });
    expect(ui.host.querySelector("video")).toBeNull();
    expect(orderedCalls).not.toContain("release-while-view-attached");
    await act(async () => { button(ui.host, "Retry video").click(); });
    await act(async () => { acquired[1].resolve(ready()); });
    await act(async () => { players[1].emit("readyToPlay"); });
    await ui.render(2);
    expect(orderedCalls).not.toContain("release-while-view-attached");
    await act(async () => { acquired[2].resolve(ready(undefined, 2)); });
    await act(async () => { players[2].emit("readyToPlay"); });
  } finally { await ui.close(); }
  expect(orderedCalls).not.toContain("release-while-view-attached");
  expect(orderedCalls.filter((call) => call === "release")).toHaveLength(3);
});

test("revision and account changes fence old acquisition before it can publish", async () => {
  const ui = await mount(1);
  try {
    await ui.render(2);
    accountId = "reader-b";
    await ui.render(2);
    expect(acquired).toHaveLength(3);
    await act(async () => { acquired[0].resolve(ready()); acquired[1].resolve(ready()); await Promise.resolve(); });
    expect(players).toHaveLength(0);
    expect(orderedCalls).toEqual([
      "cleanup:file:///cache/nautilo-exports/op/video.mp4",
      "cleanup:file:///cache/nautilo-exports/op/video.mp4",
    ]);
    await act(async () => { acquired[2].resolve(ready(undefined, 2)); await Promise.resolve(); });
    expect(players).toHaveLength(1);
  } finally { await ui.close(); }
});

test("a reconnect detaches the ready player before release and restores position only after reacquisition", async () => {
  const ui = await mount();
  try {
    await act(async () => { acquired[0].resolve(ready()); });
    await act(async () => { players[0].emit("readyToPlay"); });
    players[0].currentTime = 12;
    await act(async () => { eventListener?.({ type: "reconnected" }); });
    expect(ui.host.querySelector("video")).toBeNull();
    expect(orderedCalls).not.toContain("release-while-view-attached");
    expect(acquired).toHaveLength(2);
    await act(async () => { acquired[1].resolve(ready()); });
    expect(players[1].currentTime).toBe(12);
    expect(orderedCalls).not.toContain("play");
  } finally { await ui.close(); }
});

test("pauses an owned player for backgrounding, microphone recording, and local voice output", async () => {
  const ui = await mount();
  try {
    await act(async () => { acquired[0].resolve(ready()); await Promise.resolve(); });
    expect(lifecycleListener).toBeDefined();
    await act(async () => { lifecycleListener?.("background"); interruptMediaForRecording(); });
    speaking = true;
    await ui.render();
    expect(orderedCalls.filter((call) => call === "pause")).toHaveLength(3);
  } finally { await ui.close(); }
});

test("releases the decoder before cleaning its file, rejects unsupported containers, and can retry a player error", async () => {
  const ui = await mount();
  try {
    await act(async () => { acquired[0].resolve(ready()); await Promise.resolve(); });
    await act(async () => { players[0].emit("error"); });
    expect(ui.host.textContent).toContain("could not play the video");
    await act(async () => { button(ui.host, "Retry video").click(); });
    await act(async () => { acquired[1].resolve(ready()); await Promise.resolve(); });
    await ui.close();
    expect(orderedCalls.indexOf("release")).toBeLessThan(orderedCalls.indexOf("cleanup:file:///cache/nautilo-exports/op/video.mp4"));

    localFile = false;
    const unsupported = await mount();
    try {
      await act(async () => { acquired[2].resolve(ready()); await Promise.resolve(); });
      expect(players).toHaveLength(2);
      expect(unsupported.host.textContent).toContain("container is not supported");
    } finally { await unsupported.close(); }
  } finally {
    // close is idempotent for this test's already-unmounted first host.
  }
});
