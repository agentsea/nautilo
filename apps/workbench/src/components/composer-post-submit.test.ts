import { describe, expect, mock, test } from "bun:test";
import { applyComposerPostSubmit } from "./composer-post-submit";

/**
 * Regression suite for the mic-button-never-comes-back bug.
 *
 * Symptom (operator-reproduced multiple times, most recently
 * 2026-05-16T18:54Z during Stack 19 Phase 6 live smoke): in
 * `conversation.tsx`, the mic icon next to the composer is gated on
 * `showMic = speech.isSupported && !hasText`. `hasText` is local
 * React state updated only via the textarea's `onChange` handler.
 * `composerRuntime.reset()` clears the textarea programmatically,
 * which DOES NOT fire `onChange`, so `hasText` stays `true` forever
 * after the first send and the mic button never re-appears.
 *
 * The fix is a one-line manual `setHasText(false)` after
 * `composerRuntime.reset()` succeeds. This file pins that contract
 * via the `applyComposerPostSubmit` helper, so a future refactor
 * that drops the line trips this suite immediately.
 *
 * Historical context: the operator quote 2026-05-16 explicitly
 * says this bug "keeps regressing" — meaning the manual reset has
 * been added and dropped multiple times. The point of THIS test
 * file is to make dropping it loud + obvious in CI.
 */

describe("applyComposerPostSubmit (mic-button regression pin)", () => {
  test("REGRESSION: sent=true MUST call resetHasText(false) \u2014 mic gate would stay stuck otherwise", async () => {
    const resetComposerRuntime = mock(() => undefined);
    const resetHasText = mock((_n: false) => undefined);
    const drafts = new Map<string, string>([["room-1", "draft text"]]);
    await applyComposerPostSubmit(
      { sent: true, activeRoomId: "room-1" },
      { draftsByRoom: drafts, resetComposerRuntime, resetHasText },
    );
    // Load-bearing assertion. If this fails, the mic button regression
    // is back. Read `composer-post-submit.ts` module header before
    // "fixing" by deleting the test.
    expect(resetHasText).toHaveBeenCalledTimes(1);
    expect(resetHasText.mock.calls[0]).toEqual([false]);
  });

  test("REGRESSION: order is composerRuntime.reset() THEN resetHasText(false) \u2014 not swapped", async () => {
    const callOrder: string[] = [];
    const resetComposerRuntime = mock(() => {
      callOrder.push("composerRuntime.reset");
    });
    const resetHasText = mock((_n: false) => {
      callOrder.push("setHasText(false)");
    });
    await applyComposerPostSubmit(
      { sent: true, activeRoomId: "room-1" },
      { draftsByRoom: new Map(), resetComposerRuntime, resetHasText },
    );
    expect(callOrder).toEqual([
      "composerRuntime.reset",
      "setHasText(false)",
    ]);
  });

  test("sent=true with active room clears the draft for that room", async () => {
    const drafts = new Map<string, string>([
      ["room-1", "draft for room-1"],
      ["room-2", "draft for room-2"],
    ]);
    await applyComposerPostSubmit(
      { sent: true, activeRoomId: "room-1" },
      {
        draftsByRoom: drafts,
        resetComposerRuntime: () => undefined,
        resetHasText: () => undefined,
      },
    );
    expect(drafts.get("room-1")).toBe("");
    expect(drafts.get("room-2")).toBe("draft for room-2");
  });

  test("sent=true with activeRoomId=null skips draft step but STILL resets composer + hasText", async () => {
    const resetComposerRuntime = mock(() => undefined);
    const resetHasText = mock((_n: false) => undefined);
    await applyComposerPostSubmit(
      { sent: true, activeRoomId: null },
      {
        draftsByRoom: new Map([["other-room", "x"]]),
        resetComposerRuntime,
        resetHasText,
      },
    );
    expect(resetComposerRuntime).toHaveBeenCalledTimes(1);
    expect(resetHasText).toHaveBeenCalledTimes(1);
  });

  test("sent=false: NONE of the cleanups fire (composer keeps user's text on a failed send)", async () => {
    const resetComposerRuntime = mock(() => undefined);
    const resetHasText = mock((_n: false) => undefined);
    const drafts = new Map<string, string>([["room-1", "original draft"]]);
    await applyComposerPostSubmit(
      { sent: false, activeRoomId: "room-1" },
      { draftsByRoom: drafts, resetComposerRuntime, resetHasText },
    );
    expect(resetComposerRuntime).toHaveBeenCalledTimes(0);
    expect(resetHasText).toHaveBeenCalledTimes(0);
    expect(drafts.get("room-1")).toBe("original draft");
  });

  test("awaits an async resetComposerRuntime before firing resetHasText", async () => {
    const callOrder: string[] = [];
    const resetComposerRuntime = mock(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            callOrder.push("composerRuntime.reset (resolved)");
            resolve();
          }, 5),
        ),
    );
    const resetHasText = mock((_n: false) => {
      callOrder.push("setHasText(false)");
    });
    await applyComposerPostSubmit(
      { sent: true, activeRoomId: "room-1" },
      { draftsByRoom: new Map(), resetComposerRuntime, resetHasText },
    );
    expect(callOrder).toEqual([
      "composerRuntime.reset (resolved)",
      "setHasText(false)",
    ]);
  });

  test("draftsByRoom omitted: resetComposerRuntime + resetHasText still fire", async () => {
    const resetComposerRuntime = mock(() => undefined);
    const resetHasText = mock((_n: false) => undefined);
    await applyComposerPostSubmit(
      { sent: true, activeRoomId: "room-1" },
      { resetComposerRuntime, resetHasText },
    );
    expect(resetComposerRuntime).toHaveBeenCalledTimes(1);
    expect(resetHasText).toHaveBeenCalledTimes(1);
  });
});
