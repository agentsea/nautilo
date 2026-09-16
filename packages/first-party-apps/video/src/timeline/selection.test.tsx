import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { createEmptyProject, type Sequence } from "../edl";
import { moveClip } from "../commands";
import { createDefaultManifest, parseVideoHtml, serializeVideoHtml } from "../video-document";
import { Timeline } from "./Timeline";

const sequence: Sequence = {
  id: "selection-fixture",
  frameRate: { numerator: 30, denominator: 1 },
  durationSec: 4,
  tracks: [{
    id: "track-video",
    kind: "video",
    order: 0,
    clips: [
      { id: "clip-a", kind: "video", trackId: "track-video", timelineStartSec: 0, durationSec: 2, props: {} },
      { id: "clip-b", kind: "video", trackId: "track-video", timelineStartSec: 2, durationSec: 2, props: {} },
    ],
  }],
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let testWindow: Window | null = null;
const globalKeys = ["window", "document", "HTMLElement", "Event", "MouseEvent", "PointerEvent", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();

function installDom(): Window {
  const window = new Window();
  for (const key of globalKeys) originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
  });
  Object.defineProperties(window.HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: () => undefined },
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: { configurable: true, value: () => undefined },
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  testWindow = window;
  return window;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  testWindow?.close();
  for (const key of globalKeys) {
    const descriptor = originalGlobals.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originalGlobals.clear();
  root = null;
  host = null;
  testWindow = null;
});

describe("timeline clip selection", () => {
  test("a separated range retains a draggable playhead and Escape restores it without moving the range", async () => {
    const win = installDom();
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    function Harness() {
      const [playheadSec, setPlayheadSec] = useState(2);
      return createElement(Timeline, {
        sequence, selectedClipId: null, playheadSec, onScrub: setPlayheadSec,
        onSelectClip: () => undefined, onMoveClip: () => undefined,
        onTrimLeft: () => undefined, onTrimRight: () => undefined,
      });
    }
    await act(async () => root?.render(createElement(Harness)));
    const ruler = document.querySelector<HTMLElement>(".video-ruler")!;
    Object.defineProperty(ruler, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 400, height: 32 }) });
    const handle = document.querySelector<HTMLElement>(".video-ruler__playhead-handle")!;
    const out = document.querySelector('[aria-label="Range out handle"]')!;
    await act(async () => out.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as unknown as Event));
    expect(document.querySelector(".video-ruler__playhead-handle") === handle).toBe(true);
    const rangeLabel = document.querySelector(".video-ruler__range")!.getAttribute("aria-label");
    const pointer = (type: string, x: number) => handle.dispatchEvent(new win.PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, clientY: 10, altKey: true }) as unknown as Event);
    await act(async () => { pointer("pointerdown", 96); pointer("pointermove", 144); });
    expect(Number(handle.getAttribute("aria-valuenow"))).toBeCloseTo(2 + 1 / 30);
    await act(async () => win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(handle.getAttribute("aria-valuenow")).toBe("2");
    expect(document.querySelector(".video-ruler__range")!.getAttribute("aria-label")).toBe(rangeLabel);
    await act(async () => { pointer("pointerdown", 96); pointer("pointermove", 144); pointer("pointerup", 144); });
    expect(Number(handle.getAttribute("aria-valuenow"))).toBeCloseTo(2 + 1 / 30);
    expect(document.querySelector(".video-ruler__range")!.getAttribute("aria-label")).toBe(rangeLabel);
    const x = (2 + 1 / 30) * 48;
    await act(async () => { pointer("pointerdown", x); pointer("pointerup", x); });
    expect(document.querySelector(".video-ruler__range")!.getAttribute("aria-label")).toBe("Selected timeline range 2.03 to 2.03 seconds");
    await act(async () => { pointer("pointerdown", x); pointer("pointermove", 144); pointer("pointerup", 144); });
    expect(handle.getAttribute("aria-valuenow")).toBe("3");
  });

  test("hide/show crosses the eye, dims the scrollable lane and disables clip editing without hiding recovery", async () => {
    const win = installDom();
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    const selected: Array<string | null> = [];
    function Harness() {
      const [current, setCurrent] = useState(sequence);
      return createElement(Timeline, {
        sequence: current, selectedClipId: "clip-a", playheadSec: 0,
        onSelectClip: (id) => selected.push(id), onScrub: () => undefined,
        onMoveClip: () => undefined, onTrimLeft: () => undefined, onTrimRight: () => undefined,
        onUpdateTrack: (id, patch) => setCurrent((value) => ({ ...value, tracks: value.tracks.map((track) => track.id === id ? { ...track, ...patch } : track) })),
      });
    }
    await act(async () => root?.render(createElement(Harness)));
    const eye = document.querySelector<HTMLButtonElement>(".video-track__visibility")!;
    const shownIcon = eye.innerHTML;
    await act(async () => eye.click());
    expect(eye.getAttribute("aria-label")).toBe("Show Video track");
    expect(eye.getAttribute("aria-pressed")).toBe("true");
    expect(eye.innerHTML).not.toBe(shownIcon);
    const lane = document.querySelector(".video-track__lane")!;
    expect(lane.closest(".video-track--hidden")).not.toBeNull();
    expect(lane.getAttribute("aria-label")).toContain("excluded from editing");
    const clip = document.querySelector<HTMLElement>(".video-clip")!;
    expect(clip.getAttribute("aria-disabled")).toBe("true");
    expect(clip.classList.contains("video-clip--selected")).toBe(false);
    await act(async () => clip.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event));
    expect(selected).toEqual([]);
    const scroller = document.querySelector(".video-timeline__scroller")!;
    scroller.scrollLeft = 400;
    expect(lane.closest(".video-track--hidden")).not.toBeNull();
    await act(async () => eye.click());
    expect(document.querySelector(".video-track--hidden")).toBeNull();
    expect(eye.innerHTML).toBe(shownIcon);
    expect(clip.getAttribute("aria-disabled")).toBe("false");
  });
  test("playback ticks retain a fixed readout slot and never change the adjacent live instructions", async () => {
    installDom();
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    const longSequence = { ...sequence, durationSec: 1020, tracks: sequence.tracks.map((track) => ({ ...track, locked: true })) };
    let expectedWidth: string | undefined;
    let expectedHelp: string | null | undefined;
    for (const playheadSec of [0, 1.11, 3.88, 9.99, 10, 99.99, 100, 999.99, 1000]) {
      await act(async () => root?.render(createElement(Timeline, {
        sequence: longSequence, selectedClipId: null, playheadSec,
        onSelectClip: () => undefined, onScrub: () => undefined,
        onMoveClip: () => undefined, onTrimLeft: () => undefined, onTrimRight: () => undefined,
        onClipboardAction: () => false,
      })));
      const readout = document.querySelector(".video-timeline__range-readout") as HTMLElement;
      const help = document.querySelector(".video-timeline__scope-help")!;
      expectedWidth ??= readout.style.inlineSize;
      expectedHelp ??= help.textContent;
      expect(readout.textContent).toContain(`${playheadSec.toFixed(2)}–${playheadSec.toFixed(2)}`);
      expect(readout.style.inlineSize).toBe(expectedWidth);
      expect(readout.closest("[aria-live]")).toBeNull();
      expect(help.textContent).toBe(expectedHelp);
      expect(help.textContent).not.toContain("Excludes locked");
      expect(help.getAttribute("aria-live")).toBe("polite");
    }
  });

  test("right-click selects the clip and exposes canonical Delete clip without starting a drag", async () => {
    const window = installDom();
    const separated: string[] = [];
    const deleted: string[] = [];
    const selections: string[] = [];
    const moves: string[] = [];
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => root?.render(createElement(Timeline, {
      sequence: { ...sequence, tracks: sequence.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => ({ ...clip, mediaId: "source" })) })) },
      selectedClipId: null, playheadSec: 0, onSelectClip: (clipId) => selections.push(clipId ?? ""), onScrub: () => undefined,
      onMoveClip: ({ clipId }) => moves.push(clipId), onTrimLeft: () => undefined, onTrimRight: () => undefined,
      onSeparateAudio: (clipId) => separated.push(clipId),
      onDeleteClip: (clipId) => deleted.push(clipId),
    })));
    const clip = document.querySelector('[aria-label^="video clip clip-a"]') as HTMLElement;
    await act(async () => {
      clip.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 2 }) as unknown as Event);
      clip.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 20 }) as unknown as Event);
    });
    expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(["Delete clip", "Separate audio"]);
    expect(selections.at(-1)).toBe("clip-a");
    expect(moves).toEqual([]);
    await act(async () => ([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === "Delete clip") as HTMLButtonElement).click());
    expect(deleted).toEqual(["clip-a"]);
    expect(separated).toEqual([]);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await act(async () => clip.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, shiftKey: true, key: "F10" }) as unknown as Event));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await act(async () => document.querySelector('[role="menu"]')?.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }) as unknown as Event));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(deleted).toHaveLength(1);
  });

  test("a locked clip has no context delete target", async () => {
    const window = installDom();
    const deleted: string[] = [];
    const lockedSequence = { ...sequence, tracks: sequence.tracks.map((track) => ({ ...track, locked: true })) };
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => root?.render(createElement(Timeline, {
      sequence: lockedSequence, selectedClipId: "clip-a", playheadSec: 0,
      onSelectClip: () => undefined, onScrub: () => undefined,
      onMoveClip: () => undefined, onTrimLeft: () => undefined, onTrimRight: () => undefined,
      onDeleteClip: (clipId) => deleted.push(clipId),
    })));
    const clip = document.querySelector('[aria-label^="video clip clip-a"]') as HTMLElement;
    await act(async () => clip.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 20 }) as unknown as Event));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(deleted).toEqual([]);
  });

  test("track names are labels until rename; Escape never commits a draft", async () => {
    const window = installDom();
    const updates: unknown[] = [];
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => root?.render(createElement(Timeline, {
      sequence, selectedClipId: null, playheadSec: 0, onSelectClip: () => undefined, onScrub: () => undefined,
      onMoveClip: () => undefined, onTrimLeft: () => undefined, onTrimRight: () => undefined,
      onUpdateTrack: (id, patch) => updates.push({ id, patch }),
    })));
    expect(document.querySelector(".video-track__rename")).toBeNull();
    await act(async () => document.querySelector(".video-track__name")?.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }) as unknown as Event));
    const input = document.querySelector(".video-track__rename") as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => input.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }) as unknown as Event));
    expect(document.querySelector(".video-track__rename")).toBeNull();
    expect(updates).toEqual([]);
  });

  test("keeps locked clips selectable while blocking move and trim gestures", async () => {
    const window = installDom();
    const selections: string[] = [];
    const moves: string[] = [];
    const trims: string[] = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(Timeline, {
        sequence: { ...sequence, tracks: sequence.tracks.map((track) => ({ ...track, locked: true })) },
        selectedClipId: null,
        playheadSec: 0,
        onSelectClip: (clipId) => { if (clipId) selections.push(clipId); },
        onScrub: () => undefined,
        onMoveClip: (request) => moves.push(request.clipId),
        onTrimLeft: (request) => trims.push(request.clipId),
        onTrimRight: (request) => trims.push(request.clipId),
      }));
    });

    const clip = document.querySelector('[aria-label^="video clip clip-a"]') as HTMLElement;
    const handle = document.querySelector('[aria-label="Trim clip start by one frame"]') as HTMLElement;
    expect(clip.getAttribute("aria-disabled")).toBe("true");
    expect(handle.tabIndex).toBe(-1);
    await act(async () => {
      clip.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 10, clientY: 10 }) as unknown as Event);
      clip.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 40, clientY: 10 }) as unknown as Event);
      clip.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 40, clientY: 10 }) as unknown as Event);
      handle.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }) as unknown as Event);
    });
    expect(selections).toEqual(["clip-a"]);
    expect(moves).toEqual([]);
    expect(trims).toEqual([]);
  });

  test("forwards Shift, Meta, and Ctrl additive selection from a mounted clip", async () => {
    const window = installDom();
    const selections: Array<[string | null, boolean | undefined, boolean | undefined]> = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(Timeline, {
        sequence,
        selectedClipId: null,
        selectedClipIds: new Set<string>(),
        playheadSec: 0,
        onSelectClip: (clipId, additive, preserveSelection) => selections.push([clipId, additive, preserveSelection]),
        onScrub: () => undefined,
        onMoveClip: () => undefined,
        onTrimLeft: () => undefined,
        onTrimRight: () => undefined,
      }));
    });

    const clip = document.querySelector('[aria-label^="video clip clip-a"]') as HTMLElement;
    expect(clip).toBeTruthy();
    for (const modifier of ["shiftKey", "metaKey", "ctrlKey"] as const) {
      await act(async () => {
        clip.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerId: selections.length + 1, clientX: 10, clientY: 10, [modifier]: true }) as unknown as Event);
        clip.dispatchEvent(new window.PointerEvent("pointercancel", { bubbles: true, pointerId: selections.length }) as unknown as Event);
      });
    }

    expect(selections).toEqual([
      ["clip-a", true, false],
      ["clip-a", true, false],
      ["clip-a", true, false],
    ]);
  });

  test("preserves a selected group without a click-move, moves on drag, and cancels with Escape", async () => {
    const window = installDom();
    const selections: Array<[string | null, boolean | undefined, boolean | undefined]> = [];
    const moves: Array<{ clipId: string; timelineStartSec: number }> = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(Timeline, {
        sequence,
        selectedClipId: "clip-a",
        selectedClipIds: new Set(["clip-a", "clip-b"]),
        playheadSec: 0,
        onSelectClip: (clipId, additive, preserveSelection) => selections.push([clipId, additive, preserveSelection]),
        onScrub: () => undefined,
        onMoveClip: (request) => moves.push(request),
        onTrimLeft: () => undefined,
        onTrimRight: () => undefined,
      }));
    });

    const clip = document.querySelector('[aria-label^="video clip clip-a"]') as HTMLElement;
    await act(async () => {
      clip.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 10, clientY: 10 }) as unknown as Event);
      clip.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 10, clientY: 10 }) as unknown as Event);
    });
    expect(selections).toEqual([["clip-a", false, true]]);
    expect(moves).toEqual([]);

    await act(async () => {
      clip.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 2, clientX: 10, clientY: 10 }) as unknown as Event);
      clip.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, pointerId: 2, clientX: 30, clientY: 10 }) as unknown as Event);
      clip.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerId: 2, clientX: 30, clientY: 10 }) as unknown as Event);
    });
    expect(moves).toHaveLength(1);
    expect(moves[0]?.clipId).toBe("clip-a");
    expect(moves[0]?.timelineStartSec).toBeGreaterThan(0);

    await act(async () => {
      clip.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 3, clientX: 10, clientY: 10 }) as unknown as Event);
      clip.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, pointerId: 3, clientX: 30, clientY: 10 }) as unknown as Event);
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(moves).toHaveLength(1);

    await act(async () => {
      clip.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 4, clientX: 10, clientY: 10, shiftKey: true }) as unknown as Event);
      clip.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, pointerId: 4, clientX: 30, clientY: 10, shiftKey: true }) as unknown as Event);
      clip.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerId: 4, clientX: 30, clientY: 10, shiftKey: true }) as unknown as Event);
    });
    expect(selections.at(-1)).toEqual(["clip-a", true, false]);
    expect(moves).toHaveLength(1);
  });

  test("pointer docking saves an exact non-grid clip boundary with zero gap", async () => {
    const win = installDom();
    const neighborEnd = 9.766666666666667 + 4.013333333333334;
    const seq: Sequence = { ...sequence, durationSec: 20, tracks: [{ ...sequence.tracks[0]!, clips: [
      { ...sequence.tracks[0]!.clips[0]!, timelineStartSec: 9.766666666666667, durationSec: 4.013333333333334 },
      { ...sequence.tracks[0]!.clips[1]!, timelineStartSec: 14.089208984374999, durationSec: 3.27 },
    ] }] };
    let committed: ReturnType<typeof moveClip> | undefined;
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => root?.render(createElement(Timeline, {
      sequence: seq, selectedClipId: "clip-b", selectedClipIds: new Set(["clip-b"]), playheadSec: 0,
      onSelectClip: () => undefined, onScrub: () => undefined,
      onTrimLeft: () => undefined, onTrimRight: () => undefined,
      onMoveClip: request => { committed = moveClip({ ...createEmptyProject(), sequences: [seq] }, request); },
    })));
    const moving = document.querySelector('[aria-label^="video clip clip-b"]')!;
    const x = (neighborEnd - seq.tracks[0]!.clips[1]!.timelineStartSec) * 48 + 3;
    const pointer = (type: string, clientX: number) => moving.dispatchEvent(new win.PointerEvent(type, { bubbles: true, pointerId: 1, clientX, clientY: 10 }) as unknown as Event);
    await act(async () => { pointer("pointerdown", 0); pointer("pointermove", x); });
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Clip end");
    await act(async () => pointer("pointerup", x));
    expect(committed?.ok).toBe(true);
    if (!committed?.ok) throw new Error(committed?.error ?? "No move was committed");
    const reopened = parseVideoHtml(serializeVideoHtml(createDefaultManifest(), committed.project));
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error("Saved document did not reopen");
    const clips = reopened.document.project.sequences[0]!.tracks[0]!.clips;
    expect(clips.find(clip => clip.id === "clip-b")!.timelineStartSec - neighborEnd).toBe(0);
    expect(clips.find(clip => clip.id === "clip-b")!.durationSec).toBe(3.27);
  });

  test("excludes the prior group and additive anchor from the mounted drag snap index", async () => {
    const window = installDom();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(Timeline, {
        sequence,
        selectedClipId: "clip-b",
        selectedClipIds: new Set(["clip-b"]),
        playheadSec: 0,
        onSelectClip: () => undefined,
        onScrub: () => undefined,
        onMoveClip: () => undefined,
        onTrimLeft: () => undefined,
        onTrimRight: () => undefined,
      }));
    });

    const clip = document.querySelector('[aria-label^="video clip clip-a"]') as HTMLElement;
    await act(async () => {
      clip.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 0, clientY: 10, shiftKey: true }) as unknown as Event);
      clip.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 96, clientY: 10, shiftKey: true }) as unknown as Event);
    });
    // Both selected clips are excluded; the trailing edge can still dock to
    // the independent sequence-end guide.
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Sequence end");
    await act(async () => {
      clip.dispatchEvent(new window.PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }) as unknown as Event);
    });
  });

  test("keeps Shift on a trim handle for ripple preview rather than additive deselection", async () => {
    const window = installDom();
    const selections: Array<[string | null, boolean | undefined, boolean | undefined]> = [];
    const trims: string[] = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(Timeline, {
        sequence,
        selectedClipId: "clip-a",
        selectedClipIds: new Set(["clip-a"]),
        playheadSec: 0,
        onSelectClip: (clipId, additive, preserveSelection) => selections.push([clipId, additive, preserveSelection]),
        onScrub: () => undefined,
        onMoveClip: () => undefined,
        onTrimLeft: (request) => trims.push(request.clipId),
        onTrimRight: () => undefined,
      }));
    });

    const handle = document.querySelector('[aria-label="Trim clip start by one frame"]') as HTMLElement;
    await act(async () => {
      handle.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 10, clientY: 10, shiftKey: true }) as unknown as Event);
      handle.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 20, clientY: 10, shiftKey: true }) as unknown as Event);
    });
    expect(selections).toEqual([["clip-a", false, false]]);
    expect(trims).toEqual(["clip-a"]);
  });
});
