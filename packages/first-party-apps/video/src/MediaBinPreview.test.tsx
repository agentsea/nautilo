import { afterEach, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { MediaBinPreview } from "./MediaBinPreview";
import type { NautiloAppBridge } from "./bridge";

let root: Root | undefined;
let win: Window;
const original = new Map<string, PropertyDescriptor | undefined>();
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  win?.close(); root = undefined;
  for (const [key, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  original.clear();
});

async function fixture(open?: NautiloAppBridge["media"], kind: "video" | "audio" = "video") {
  win = new Window();
  for (const [key, value] of Object.entries({ window: win, document: win.document, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let played = 0; let paused = 0; let starts = 0;
  Object.defineProperties(win.HTMLMediaElement.prototype, {
    play: { configurable: true, value: () => { played++; return Promise.resolve(); } },
    pause: { configurable: true, value: () => { paused++; } },
  });
  const requests: unknown[] = []; const closed: string[] = [];
  (win as unknown as { nautiloApp: unknown }).nautiloApp = { media: open ?? {
    openPreview: async (request: unknown) => { requests.push(request); return { kind: "ready", url: "https://media.invalid/source.mp4", revokeToken: "lease" }; },
    closePreview: async (token: string) => { closed.push(token); },
  } };
  const host = win.document.createElement("div"); win.document.body.append(host);
  root = createRoot(host as unknown as HTMLElement);
  const asset = { id: "source", kind, ref: "source.mp4", label: "Source video" };
  const render = async (enabled = true, active = false, timelinePlaying = false) => act(async () => {
    root?.render(createElement(MediaBinPreview, { asset: { ...asset }, enabled, active, timelinePlaying, onPlay: () => { starts++; } }));
    await Promise.resolve();
  });
  return { host, requests, closed, render, counts: () => ({ played, paused, starts }) };
}

test("media bin shows a source frame, plays only on request, and closes its lease when hidden", async () => {
  const h = await fixture(); await h.render(false);
  expect(h.requests).toEqual([]);
  await h.render();
  expect(h.requests).toEqual([{ ref: "source.mp4" }]);
  const video = h.host.querySelector("video")!;
  expect(video.src).toBe("https://media.invalid/source.mp4");
  expect(video.autoplay).toBe(false); expect(video.muted).toBe(true);
  expect(h.counts().played).toBe(0);
  await act(async () => h.host.querySelector("button")!.click());
  expect(h.counts()).toMatchObject({ played: 1, starts: 1 });
  await h.render(true, true);
  expect(video.controls).toBe(true);
  expect(h.requests).toHaveLength(1);
  expect(h.closed).toEqual([]);
  const before = h.counts().paused;
  await h.render(true, true, true);
  expect(h.counts().paused).toBeGreaterThan(before);
  await h.render(false);
  expect(h.closed).toEqual(["lease"]);
  expect(h.host.querySelector("video")).toBeNull();
});

test("late source replies after leaving the bin are released, not displayed", async () => {
  let resolve!: (result: { kind: "ready"; url: string; revokeToken: string }) => void;
  const closed: string[] = [];
  const h = await fixture({
    openPreview: () => new Promise((done) => { resolve = done; }),
    closePreview: async (token: string) => { closed.push(token); },
  } as unknown as NautiloAppBridge["media"]);
  await h.render(); await h.render(false);
  await act(async () => resolve({ kind: "ready", url: "https://media.invalid/late.mp4", revokeToken: "late" }));
  expect(closed).toEqual(["late"]);
  expect(h.host.querySelector("video")).toBeNull();
});

test("source preview failures stay in the card and retry without adding timeline media", async () => {
  let attempts = 0;
  const h = await fixture({
    openPreview: async () => ++attempts === 1 ? { kind: "unavailable", code: "source_unavailable" } : { kind: "ready", url: "https://media.invalid/source.mp4", revokeToken: "retry" },
    closePreview: async () => undefined,
  } as unknown as NautiloAppBridge["media"]);
  await h.render(); expect(h.host.textContent).toContain("Preview unavailable");
  await act(async () => h.host.querySelector("button")!.click());
  expect(attempts).toBe(2); expect(h.host.querySelector("video")).not.toBeNull();
  expect(h.counts().played).toBe(0);
});


test("saved reference previews use reference identity and retain their lease across prompt edits", async () => {
  const h = await fixture();
  const render = async (name: string, path: string) => act(async () => {
    root?.render(createElement(MediaBinPreview, {
      reference: { id: "ref_cast", name, mediaKind: "image", source: { kind: "workspace-artifact", artifactId: "saved-image", path, mimeType: "image/png", sizeBytes: 10 } },
      enabled: true, active: false, timelinePlaying: false, onPlay: () => undefined,
    }));
  });
  await render("Cast", "cast.png");
  expect(h.requests).toEqual([{ referenceId: "ref_cast" }]);
  expect(h.host.querySelector("img")?.alt).toBe("Cast");
  await render("Renamed cast", "cast.png");
  expect(h.requests).toHaveLength(1);
  expect(h.closed).toEqual([]);
  await render("Replacement", "new-cast.png");
  expect(h.requests).toHaveLength(2);
  expect(h.closed).toEqual(["lease"]);
});


test("audio cards render actual peaks, remain silent until played, and pause with the timeline", async () => {
  const h = await fixture({
    openPreview: async () => ({ kind: "ready", url: "https://media.invalid/voice.wav", revokeToken: "audio-lease", mimeType: "audio/wav", sizeBytes: 10,
      waveform: { peaks: [0, 0.25, 1, 0.5], samplesPerSecond: 2 } }),
    closePreview: async () => undefined,
  } as unknown as NautiloAppBridge["media"], "audio");
  await h.render();
  const audio = h.host.querySelector("audio")!;
  expect(audio).not.toBeNull();
  expect(audio.controls).toBe(true);
  expect(audio.autoplay).toBe(false);
  expect(audio.muted).toBe(false);
  expect(h.host.querySelector("video")).toBeNull();
  expect(h.host.querySelector('[aria-label="Audio waveform"] path')?.getAttribute("d")).toContain("v60");
  expect(h.counts().played).toBe(0);
  await act(async () => audio.dispatchEvent(new win.Event("play")));
  expect(h.counts().starts).toBe(1);
  await h.render(true, true);
  const before = h.counts().paused;
  await h.render(true, true, true);
  expect(h.counts().paused).toBeGreaterThan(before);
  await h.render(false);
  expect(h.host.querySelector("audio")).toBeNull();
});

test("saved audio references use the same waveform and playback preview", async () => {
  const h = await fixture({
    openPreview: async (request: unknown) => { h.requests.push(request); return { kind: "ready", url: "https://media.invalid/reference.wav", revokeToken: "reference-audio", mimeType: "audio/wav", sizeBytes: 10,
      waveform: { peaks: [0.1, 1, 0.4], samplesPerSecond: 2 } }; },
    closePreview: async () => undefined,
  } as unknown as NautiloAppBridge["media"]);
  await act(async () => {
    root?.render(createElement(MediaBinPreview, {
      reference: { id: "ref_audio", name: "Reference voice", mediaKind: "audio", source: { kind: "workspace-artifact", artifactId: "saved-audio", path: "voice.wav", mimeType: "audio/wav", sizeBytes: 10 } },
      enabled: true, active: false, timelinePlaying: false, onPlay: () => undefined,
    }));
    await Promise.resolve();
  });
  expect(h.requests).toEqual([{ referenceId: "ref_audio" }]);
  expect(h.host.querySelector('[aria-label="Audio waveform"]')).not.toBeNull();
  expect(h.host.querySelector('audio[aria-label="Preview Reference voice"]')).not.toBeNull();
});

test("audio remains playable when waveform data is unavailable", async () => {
  const h = await fixture(undefined, "audio");
  await h.render();
  expect(h.host.textContent).toContain("Waveform unavailable");
  expect(h.host.querySelector("audio")?.controls).toBe(true);
  expect(h.host.querySelector('[aria-label="Audio waveform"]')).toBeNull();
});
