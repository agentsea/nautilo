import { afterEach, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { ProgramPreview } from "./ProgramPreview";
import { createEmptyProject } from "./edl";
import type { NautiloAppBridge } from "./bridge";
import { renderTextCompositionMarkup } from "./text-composition";
import { setCutTransition } from "./commands";

let root: Root | undefined;
let testWindow: Window | undefined;
const original = new Map<string, PropertyDescriptor | undefined>();

test("transition preview prepares both decoders, blends opacity/audio and applies swipe geometry", async () => {
  const state = await fixture();
  const project = structuredClone(state.project);
  project.media.forEach((media) => { media.durationSec = 10; });
  project.sequences[0]!.tracks[0]!.clips[1]!.timelineStartSec = 2;
  const changed = setCutTransition(project, { clipId: "b", kind: "crossfade", durationSec: 1, direction: "left" });
  if (!changed.ok) throw new Error(changed.error);
  await state.render(0, changed.project);
  const videos = [...state.host.querySelectorAll("video")];
  expect(videos).toHaveLength(2);
  expect(videos[1]!.style.visibility).toBe("hidden"); expect(videos[1]!.volume).toBe(0);
  await state.render(2, changed.project);
  expect(state.host.querySelectorAll("video")).toHaveLength(2);
  expect(videos[0]!.style.opacity).toBe("1"); expect(videos[1]!.style.opacity).toBe("0.5");
  expect(videos[0]!.volume).toBe(0.5); expect(videos[1]!.volume).toBe(0.5);
  const swiped = setCutTransition(changed.project, { clipId: "b", kind: "swipe", durationSec: 1, direction: "up" });
  if (!swiped.ok) throw new Error(swiped.error);
  await state.render(2, swiped.project);
  expect(state.host.querySelectorAll("video")[1]!.style.clipPath).toBe("inset(50% 0 0 0)");
  await state.render(2.5, swiped.project);
  expect(state.host.querySelectorAll("video")).toHaveLength(1);
  expect(state.host.querySelector("video")!.style.clipPath).toBe("inset(0% 0 0 0)");
});

test("synthetic preview shares export markup, edits immediately, and respects cut, end and hidden tracks", async () => {
  const state = await fixture();
  const project = structuredClone(state.project);
  for (const track of project.sequences[0]!.tracks) track.clips = [];
  const track = project.sequences[0]!.tracks[2]!;
  const text = "Hello <img src=x>\nمرحبا 日本語 🎬";
  track.clips = [{ id: "caption", trackId: track.id, kind: "caption", timelineStartSec: 1, durationSec: 1, props: { text } }];
  await state.render(0, project);
  expect(state.host.querySelector("[data-text-content]")).toBeNull();
  await state.render(1, project);
  expect(state.host.querySelector("[data-text-content]")!.textContent).toBe(text);
  const expected = state.win.document.createElement("div"); expected.innerHTML = renderTextCompositionMarkup("caption", text);
  expect(state.host.querySelector("[data-clip-id=caption]")!.firstElementChild.innerHTML).toBe(expected.innerHTML);
  expect(state.host.querySelector("img")).toBeNull();
  const edited = structuredClone(project); edited.sequences[0]!.tracks[2]!.clips[0]!.props["text"] = "Edited\nSecond line";
  await state.render(1.5, edited);
  expect(state.host.querySelector("[data-text-content]")!.textContent).toBe("Edited\nSecond line");
  await state.render(2, edited);
  expect(state.host.querySelector("[data-text-content]")).toBeNull();
  edited.sequences[0]!.tracks[2]!.hidden = true;
  await state.render(1, structuredClone(edited));
  expect(state.host.querySelector("[data-text-content]")).toBeNull();
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  testWindow?.close();
  for (const [key, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  original.clear(); root = undefined; testWindow = undefined;
});

async function fixture(failFirst = false) {
  const win = new Window(); testWindow = win;
  for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  const opened: string[] = []; const closed: string[] = []; const readiness: boolean[] = [];
  const bridge = { media: {
    openPreview: async (request: { ref: string } | { mediaId: string }) => {
      const authority = "ref" in request ? request.ref : `media:${request.mediaId}`;
      opened.push(authority);
      if (failFirst && opened.length === 1) return { kind: "unavailable", code: "source_unavailable" };
      return { kind: "ready", url: `https://media.invalid/${authority}`, revokeToken: authority };
    },
    closePreview: async (token: string) => { closed.push(token); },
  } } as unknown as NautiloAppBridge;
  (win as unknown as { nautiloApp: NautiloAppBridge }).nautiloApp = bridge;
  const project = createEmptyProject(); const sequence = project.sequences[0]!;
  sequence.durationSec = 5;
  project.media = [{ id: "m-a", kind: "video", ref: "a.mp4" }, { id: "m-b", kind: "video", ref: "b.mp4" }];
  sequence.tracks[0]!.clips = [
    { id: "a", kind: "video", trackId: sequence.tracks[0]!.id, mediaId: "m-a", timelineStartSec: 0, durationSec: 2, sourceInSec: 3, props: {} },
    { id: "b", kind: "video", trackId: sequence.tracks[0]!.id, mediaId: "m-b", timelineStartSec: 3, durationSec: 2, sourceInSec: 1, props: {} },
  ];
  const host = win.document.createElement("div"); win.document.body.append(host);
  root = createRoot(host as unknown as HTMLElement);
  const onReadyChange = (ready: boolean) => { readiness.push(ready); };
  const clockRef = { current: null as (() => number | null) | null };
  const render = async (timeSec: number, nextProject = project, playing = false) => {
    await act(async () => { root!.render(createElement(ProgramPreview, { project: nextProject, timeSec, playing, onReadyChange, clockRef })); });
  };
  await render(0);
  return { win, host, project, opened, closed, readiness, render, clockRef };
}

test("native playback drives the timeline without repeated corrective seeks or loading flashes", async () => {
  const state = await fixture();
  const video = state.host.querySelector("video")!;
  let mediaTime = 3;
  const seeks: number[] = [];
  Object.defineProperties(video, {
    readyState: { configurable: true, get: () => 4 },
    seeking: { configurable: true, get: () => false },
    currentTime: { configurable: true, get: () => mediaTime, set: (time: number) => { seeks.push(time); mediaTime = time; } },
  });
  await act(async () => { video.dispatchEvent(new state.win.Event("canplay")); });
  await state.render(0, state.project, true);
  state.readiness.length = 0;
  for (let frame = 1; frame <= 30; frame += 1) {
    mediaTime = 3 + frame / 30;
    // Native playback is ahead of the previous React clock render by several frames.
    await state.render(Math.max(0, frame / 30 - 0.1), state.project, true);
    expect(state.clockRef.current?.()).toBeCloseTo(frame / 30);
    expect(state.host.textContent).not.toContain("Loading");
  }
  expect(seeks).toEqual([]);
  expect(state.readiness).not.toContain(false);
  // A genuine buffer stall still blocks the shared clock and is disclosed.
  await act(async () => { video.dispatchEvent(new state.win.Event("waiting")); });
  expect(state.readiness.at(-1)).toBe(false);
  expect(state.clockRef.current?.()).toBeNull();
  expect(state.host.textContent).toContain("Loading");
  await act(async () => { video.dispatchEvent(new state.win.Event("canplay")); });
  expect(state.readiness.at(-1)).toBe(true);
  // An edit to the source trim is not ordinary playback and must still seek.
  const trimmed = structuredClone(state.project);
  trimmed.sequences[0]!.tracks[0]!.clips[0]!.sourceInSec = 4;
  await state.render(0.9, trimmed, true);
  expect(seeks.at(-1)).toBe(4.9);
  await state.render(0.25, state.project, false);
  expect(seeks.at(-1)).toBe(3.25);
});

test("starting a selected-range replay seeks the existing decoder back to IN", async () => {
  const state = await fixture();
  const video = state.host.querySelector("video")!;
  let mediaTime = 3;
  const seeks: number[] = [];
  Object.defineProperties(video, {
    readyState: { configurable: true, get: () => 4 },
    seeking: { configurable: true, get: () => false },
    currentTime: { configurable: true, get: () => mediaTime, set: (time: number) => { seeks.push(time); mediaTime = time; } },
  });
  await act(async () => video.dispatchEvent(new state.win.Event("canplay")));
  await state.render(1.5, state.project, false);
  expect(mediaTime).toBe(4.5);
  await act(async () => video.dispatchEvent(new state.win.Event("canplay")));
  seeks.length = 0;
  await state.render(0.5, state.project, true);
  expect(seeks).toEqual([3.5]);
  expect(state.host.querySelector("video") === video).toBe(true);
});

test("adjoining continuous source slices keep the same decoder without reload or flash", async () => {
  const state = await fixture();
  const project = structuredClone(state.project);
  project.sequences[0]!.tracks[0]!.clips[1] = { ...project.sequences[0]!.tracks[0]!.clips[0]!, id: "second-slice", timelineStartSec: 2, durationSec: 3, sourceInSec: 5 };
  await state.render(0, project);
  const video = state.host.querySelector("video")!;
  let mediaTime = 3;
  const seeks: number[] = [];
  Object.defineProperties(video, {
    readyState: { configurable: true, get: () => 4 },
    seeking: { configurable: true, get: () => false },
    currentTime: { configurable: true, get: () => mediaTime, set: (time: number) => { seeks.push(time); mediaTime = time; } },
  });
  await act(async () => video.dispatchEvent(new state.win.Event("canplay")));
  await state.render(0, project, true);
  state.readiness.length = 0;
  mediaTime = 5;
  await state.render(2, project, true);
  expect(state.host.querySelector("video")).toBe(video);
  expect(state.opened).toEqual(["a.mp4"]);
  expect(state.closed).toEqual([]);
  expect(seeks).toEqual([]);
  expect(state.readiness).not.toContain(false);
  expect(state.host.textContent).not.toContain("Loading");
});

test("adjoining different sources preload silently and hold the outgoing frame if the successor is late", async () => {
  const state = await fixture();
  const project = structuredClone(state.project);
  project.sequences[0]!.tracks[0]!.clips[1]!.timelineStartSec = 2;
  await state.render(0, project);
  const [first, next] = [...state.host.querySelectorAll("video")];
  expect(state.opened).toEqual(["a.mp4", "b.mp4"]);
  expect(next!.style.visibility).toBe("hidden");
  expect(next!.muted).toBe(true);
  Object.defineProperties(first!, { readyState: { configurable: true, get: () => 4 }, currentTime: { configurable: true, get: () => 3 } });
  await act(async () => first!.dispatchEvent(new state.win.Event("canplay")));
  await state.render(0, project, true);
  expect(state.readiness.at(-1)).toBe(true); // pending standby never stalls current media
  await state.render(2, project, true);
  expect(first!.isConnected).toBe(true);
  expect(first!.style.visibility).toBe("visible");
  expect(next!.style.visibility).toBe("hidden");
  expect(state.host.textContent).not.toContain("Loading");
  expect(state.readiness.at(-1)).toBe(false);
  await act(async () => { next!.dispatchEvent(new state.win.Event("loadedmetadata")); next!.dispatchEvent(new state.win.Event("canplay")); });
  expect(first!.isConnected).toBe(false);
  expect(next!.style.visibility).toBe("visible");
  expect(state.closed).toEqual(["a.mp4"]);
  expect(state.readiness.at(-1)).toBe(true);
});

test("a genuine one-frame gap clears the prior picture rather than holding or joining it", async () => {
  const state = await fixture();
  const project = structuredClone(state.project);
  project.sequences[0]!.tracks[0]!.clips[1]!.timelineStartSec = 2 + 1 / 30;
  await state.render(0, project, true);
  expect(state.host.querySelectorAll("video").length).toBe(1);
  await state.render(2, project, true);
  expect(state.host.querySelectorAll("video").length).toBe(0);
  expect(state.closed).toEqual(["a.mp4"]);
});

test("the native clock clamps at composition boundaries and falls back in gaps", async () => {
  const state = await fixture();
  const video = state.host.querySelector("video")!;
  Object.defineProperties(video, {
    readyState: { configurable: true, get: () => 4 },
    currentTime: { configurable: true, get: () => 3 },
  });
  await act(async () => { video.dispatchEvent(new state.win.Event("canplay")); });
  const project = structuredClone(state.project);
  const track = project.sequences[0]!.tracks[2]!;
  track.clips = [{ id: "short-title", trackId: track.id, kind: "caption", timelineStartSec: 0.5, durationSec: 0.1, props: { text: "Title" } }];
  await state.render(0, project, true);
  Object.defineProperty(video, "currentTime", { configurable: true, get: () => 4 });
  expect(state.clockRef.current?.()).toBe(0.5);
  await state.render(0.5, project, true);
  expect(state.clockRef.current?.()).toBe(0.6);
  await state.render(0.6, project, true);
  Object.defineProperty(video, "ended", { configurable: true, get: () => true });
  expect(state.clockRef.current?.()).toBe(2);
  await state.render(2, project, true);
  expect(state.clockRef.current?.()).toBeNull();
});

test("program cuts open the active source, preserve source trim, release URLs, and gate buffering", async () => {
  const state = await fixture();
  expect(state.opened).toEqual(["a.mp4"]);
  expect(state.readiness.at(-1)).toBe(false);
  const video = state.host.querySelector("video")!;
  await act(async () => { video.dispatchEvent(new state.win.Event("loadedmetadata")); video.dispatchEvent(new state.win.Event("canplay")); });
  expect(video.currentTime).toBe(3);
  expect(state.readiness.at(-1)).toBe(true);
  await act(async () => { video.dispatchEvent(new state.win.Event("waiting")); });
  expect(state.readiness.at(-1)).toBe(false);
  await state.render(2);
  expect(state.host.querySelectorAll("video").length).toBe(0);
  expect(state.closed).toEqual(["a.mp4"]);
  expect(state.readiness.at(-1)).toBe(true);
  await state.render(3);
  expect(state.opened).toEqual(["a.mp4", "b.mp4"]);
  expect(state.readiness.at(-1)).toBe(false);
  await state.render(5);
  expect(state.closed).toEqual(["a.mp4", "b.mp4"]);
});

test("source failure is visible and retry reopens the active source", async () => {
  const state = await fixture(true);
  expect(state.host.textContent).toContain("source_unavailable");
  expect(state.readiness.at(-1)).toBe(false);
  const retry = state.host.querySelector("button")!;
  expect(retry.textContent).toBe("Retry preview");
  await act(async () => { retry.click(); });
  expect(state.opened).toEqual(["a.mp4", "a.mp4"]);
  expect(state.host.textContent).not.toContain("source_unavailable");
});

test("same-source seek lowers readiness before assigning the target and ignores an obsolete seek completion", async () => {
  const state = await fixture();
  const video = state.host.querySelector("video")!;
  let mediaTime = 3;
  let seeking = false;
  const readinessAtSeek: Array<boolean | undefined> = [];
  Object.defineProperties(video, {
    readyState: { configurable: true, get: () => 4 },
    seeking: { configurable: true, get: () => seeking },
    currentTime: { configurable: true, get: () => mediaTime, set: (time: number) => { readinessAtSeek.push(state.readiness.at(-1)); mediaTime = time; seeking = true; } },
  });
  await act(async () => { video.dispatchEvent(new state.win.Event("canplay")); });
  expect(state.readiness.at(-1)).toBe(true);
  await state.render(1);
  expect(readinessAtSeek).toEqual([false]);
  expect(mediaTime).toBe(4);
  await state.render(1.5);
  expect(mediaTime).toBe(4.5);
  // A stale event cannot unblock a newer unfinished seek.
  await act(async () => { video.dispatchEvent(new state.win.Event("seeked")); });
  expect(state.readiness.at(-1)).toBe(false);
  seeking = false;
  await act(async () => { video.dispatchEvent(new state.win.Event("seeked")); });
  expect(state.readiness.at(-1)).toBe(true);
  expect(state.opened).toEqual(["a.mp4"]);
});

test("retired retry events cannot unblock a replacement and each preview lease closes once", async () => {
  const state = await fixture();
  const retired = state.host.querySelector("video")!;
  await act(async () => { retired.dispatchEvent(new state.win.Event("error")); });
  await act(async () => { state.host.querySelector("button")!.click(); });
  expect(state.opened).toEqual(["a.mp4", "a.mp4"]);
  expect(state.closed).toEqual(["a.mp4"]);
  await act(async () => { retired.dispatchEvent(new state.win.Event("canplay")); retired.dispatchEvent(new state.win.Event("seeked")); });
  expect(state.readiness.at(-1)).toBe(false);
  await state.render(5);
  expect(state.closed).toEqual(["a.mp4", "a.mp4"]);
});

test("canonical save projections do not regenerate an unchanged media preview", async () => {
  const state = await fixture();
  const next = structuredClone(state.project);
  next.metadata = { ...next.metadata, title: "Changed title" };
  await state.render(0, next);
  expect(state.opened).toEqual(["a.mp4"]);
  expect(state.closed).toEqual([]);
});

test("durable Workspace images use the revocable host preview instead of a ref byte read", async () => {
  const state = await fixture();
  const project = structuredClone(state.project);
  project.media[0] = {
    id: "m-a",
    kind: "image",
    ref: "media/still.webp",
    lifecycle: "durable",
    source: { kind: "workspace-artifact", artifactId: "artifact-image", path: "media/still.webp" },
  };
  project.sequences[0]!.tracks[0]!.clips[0] = {
    id: "a",
    kind: "image",
    trackId: project.sequences[0]!.tracks[0]!.id,
    mediaId: "m-a",
    timelineStartSec: 0,
    durationSec: 2,
    props: {},
  };
  await state.render(0, project);
  expect(state.opened.at(-1)).toBe("media:m-a");
  expect(state.host.querySelector("img")).not.toBeNull();
});
