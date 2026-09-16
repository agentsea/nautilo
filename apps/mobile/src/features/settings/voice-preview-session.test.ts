/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { VoicePreviewSession, type VoicePreviewPlatform } from "./voice-preview-session";

function blob(): Blob { return new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" }); }

function fakePlatform() {
  const calls: string[] = [];
  let listener: ((status: { didJustFinish: boolean; error?: string | null }) => void) | null = null;
  const platform: VoicePreviewPlatform = {
    createFile: () => ({ uri: "file:///preview.mp3", write: () => calls.push("write"), delete: () => calls.push("delete") }),
    createPlayer: () => ({
      play: () => calls.push("play"), pause: () => calls.push("pause"), remove: () => calls.push("remove"),
      addListener: (_event, next) => { listener = next; return { remove: () => calls.push("unsubscribe") }; },
    }),
  };
  return { platform, calls, finish: () => listener?.({ didJustFinish: true }), fail: () => listener?.({ didJustFinish: false, error: "native failure" }) };
}

describe("VoicePreviewSession", () => {
  test("plays one preview and releases its player and cache file on completion", async () => {
    const fake = fakePlatform();
    const preview = new VoicePreviewSession(fake.platform);
    await preview.play("voice-a", async () => blob());
    expect(preview.getSnapshot()).toMatchObject({ status: "playing", voiceId: "voice-a" });
    fake.finish();
    expect(preview.getSnapshot()).toMatchObject({ status: "idle", voiceId: null });
    expect(fake.calls).toEqual(["write", "play", "unsubscribe", "pause", "remove", "delete"]);
  });

  test("accepts native byte payloads without depending on Blob.arrayBuffer", async () => {
    const fake = fakePlatform();
    const preview = new VoicePreviewSession(fake.platform);
    await preview.play("voice-bytes", async () => new Uint8Array([1, 2, 3]));
    expect(preview.getSnapshot()).toMatchObject({ status: "playing", voiceId: "voice-bytes" });
    expect(fake.calls.slice(0, 2)).toEqual(["write", "play"]);
  });

  test("cancels a pending request without creating native resources", async () => {
    const fake = fakePlatform();
    let resolve!: (value: Blob) => void;
    const pending = new Promise<Blob>((done) => { resolve = done; });
    const preview = new VoicePreviewSession(fake.platform);
    const task = preview.play("voice-a", () => pending);
    preview.stop();
    resolve(blob());
    await task;
    expect(preview.getSnapshot().status).toBe("idle");
    expect(fake.calls).toEqual([]);
  });

  test("reports playback failures and releases resources", async () => {
    const fake = fakePlatform();
    const preview = new VoicePreviewSession(fake.platform);
    await preview.play("voice-a", async () => blob());
    fake.fail();
    expect(preview.getSnapshot()).toMatchObject({ status: "error", error: "Could not play this voice preview." });
    expect(fake.calls).toContain("remove");
    expect(fake.calls).toContain("delete");
  });

  test("backs off after a 429 and resumes after the bounded delay", async () => {
    const fake = fakePlatform();
    let now = 100;
    const preview = new VoicePreviewSession(fake.platform, () => now);
    await preview.play("voice-a", async () => { throw Object.assign(new Error("limited"), { status: 429 }); });
    expect(preview.getSnapshot()).toMatchObject({ status: "rate-limited", retryAt: 30100 });
    await preview.play("voice-b", async () => blob());
    expect(fake.calls).toEqual([]);
    now = 30100;
    await preview.play("voice-b", async () => blob());
    expect(fake.calls).toContain("play");
  });

  test("dispose stops active playback and releases all resources", async () => {
    const fake = fakePlatform();
    const preview = new VoicePreviewSession(fake.platform);
    await preview.play("voice-a", async () => blob());
    preview.dispose();
    expect(fake.calls).toEqual(["write", "play", "unsubscribe", "pause", "remove", "delete"]);
  });
});
