import { describe, expect, test } from "bun:test";
import type { RoomMessageSearchControls } from "../../src/adapters/runtime-contexts";
import {
  captureRoomFindFocusRestoreTarget,
  moveRoomFindSelection,
  roomFindEscapeIntent,
  roomFindKeyDirection,
  roomFindOrdinal,
  reconcileRoomFindSelection,
  roomFindSelectionForHit,
  roomFindTotalLabel,
  shouldOwnRoomFindShortcut,
} from "../../src/components/rooms/room-transcript-find-navigation";

function search(pageIndex = 0, hits = ["a", "b"], hasMoreOlder = false): RoomMessageSearchControls {
  return {
    roomId: "room", query: "find", mode: "prefix", status: "ready", generation: 1, asOf: null,
    currentPageIndex: pageIndex,
    pages: [{ index: pageIndex, page: { hits: hits.map((messageId) => ({ messageId, createdAt: "", role: "assistant", snippet: "" })), asOf: null, nextOlderCursor: null, hasMoreOlder } }],
    hits: hits.map((messageId) => ({ messageId, createdAt: "", role: "assistant", snippet: "" })),
    hasMoreOlder, canLoadNewer: pageIndex > 0, error: null,
    setQuery: () => {}, setMode: () => {}, loadOlder: async () => false, loadNewer: async () => false, clear: () => {},
  };
}

describe("D430 Room find navigation model", () => {
  test("uses stable absolute newest-first ordinals and truthful N+ totals", () => {
    expect(roomFindOrdinal(3, 2)).toBe(63);
    const selected = { messageId: "x", pageIndex: 3, indexInPage: 2, ordinal: 63 };
    expect(roomFindTotalLabel({ selection: selected, search: search(3, ["x"], true) })).toBe("80+");
    const terminalSelection = { messageId: "y", pageIndex: 3, indexInPage: 1, ordinal: 62 };
    expect(roomFindTotalLabel({ selection: terminalSelection, search: search(3, ["x", "y"], false) })).toBe("62");
  });

  test("moves within page without requesting and never wraps", async () => {
    const state = search();
    let calls = 0;
    state.loadOlder = async () => { calls += 1; return false; };
    const selected = roomFindSelectionForHit(state, "a")!;
    await expect(moveRoomFindSelection({ selection: selected, direction: "older", getSearch: () => state })).resolves.toMatchObject({ kind: "selected", selection: { messageId: "b", ordinal: 2 } });
    const end = roomFindSelectionForHit(state, "b")!;
    await expect(moveRoomFindSelection({ selection: end, direction: "older", getSearch: () => state })).resolves.toEqual({ kind: "boundary", direction: "older" });
    await expect(moveRoomFindSelection({ selection: selected, direction: "newer", getSearch: () => state })).resolves.toEqual({ kind: "boundary", direction: "newer" });
    expect(calls).toBe(0);
  });

  test("calls exactly one explicit older operation at a page boundary and preserves selection identity", async () => {
    const before = search(0, ["a", "b"], true);
    const after = search(1, ["c", "d"], false);
    let calls = 0;
    before.loadOlder = async () => { calls += 1; return true; };
    const end = roomFindSelectionForHit(before, "b")!;
    await expect(moveRoomFindSelection({ selection: end, direction: "older", getSearch: () => calls ? after : before })).resolves.toMatchObject({ kind: "selected", selection: { messageId: "c", pageIndex: 1, ordinal: 21 } });
    expect(calls).toBe(1);
  });

  test("calls exactly one explicit newer operation at a page boundary", async () => {
    const before = search(1, ["c", "d"], false);
    const after = search(0, ["a", "b"], true);
    let calls = 0;
    before.loadNewer = async () => { calls += 1; return true; };
    const start = roomFindSelectionForHit(before, "c")!;
    await expect(moveRoomFindSelection({ selection: start, direction: "newer", getSearch: () => calls ? after : before })).resolves.toMatchObject({ kind: "selected", selection: { messageId: "b", pageIndex: 0, ordinal: 2 } });
    expect(calls).toBe(1);
  });

  test("empty result sets have no selection or request", async () => {
    const state = search(0, [], false);
    let calls = 0;
    state.loadOlder = async () => { calls += 1; return true; };
    await expect(moveRoomFindSelection({ selection: null, direction: "older", getSearch: () => state })).resolves.toEqual({ kind: "unavailable" });
    expect(calls).toBe(0);
  });

  test("query or generation reset clears selection while retained hits keep stable identity", () => {
    const state = search();
    const selected = roomFindSelectionForHit(state, "b")!;
    expect(reconcileRoomFindSelection({ previousGeneration: 1, generation: 1, query: "find", selection: selected, search: state })).toMatchObject({ messageId: "b", ordinal: 2 });
    expect(reconcileRoomFindSelection({ previousGeneration: 1, generation: 2, query: "find", selection: selected, search: state })).toBeNull();
    expect(reconcileRoomFindSelection({ previousGeneration: 1, generation: 1, query: " ", selection: selected, search: state })).toBeNull();
    // Closing and reopening does not create a new query generation; it selects
    // the current first result without a request when no prior selection exists.
    expect(reconcileRoomFindSelection({ previousGeneration: 1, generation: 1, query: "find", selection: null, search: state })).toMatchObject({ messageId: "a", ordinal: 1 });
  });

  test("owns Cmd/Ctrl+F only in the conversation, maps directions, and preserves Escape focus", () => {
    expect(shouldOwnRoomFindShortcut({ key: "f", ctrlKey: true, metaKey: false, altKey: false, defaultPrevented: false, insideConversation: true, browserGuestFocused: false })).toBe(true);
    expect(shouldOwnRoomFindShortcut({ key: "f", ctrlKey: false, metaKey: true, altKey: false, defaultPrevented: false, insideConversation: true, browserGuestFocused: false })).toBe(true);
    expect(shouldOwnRoomFindShortcut({ key: "f", ctrlKey: false, metaKey: true, altKey: true, defaultPrevented: false, insideConversation: true, browserGuestFocused: false })).toBe(false);
    expect(shouldOwnRoomFindShortcut({ key: "f", ctrlKey: true, metaKey: false, altKey: false, defaultPrevented: true, insideConversation: true, browserGuestFocused: false })).toBe(false);
    expect(shouldOwnRoomFindShortcut({ key: "f", ctrlKey: true, metaKey: false, altKey: false, defaultPrevented: false, insideConversation: true, browserGuestFocused: true })).toBe(false);
    expect(shouldOwnRoomFindShortcut({ key: "f", ctrlKey: true, metaKey: false, altKey: false, defaultPrevented: false, insideConversation: false, browserGuestFocused: false })).toBe(false);
    expect(roomFindKeyDirection({ key: "Enter", shiftKey: false, snippetListOwnsFocus: false })).toBe("older");
    expect(roomFindKeyDirection({ key: "Enter", shiftKey: true, snippetListOwnsFocus: false })).toBe("newer");
    expect(roomFindKeyDirection({ key: "ArrowUp", shiftKey: false, snippetListOwnsFocus: true })).toBe("newer");
    expect(roomFindKeyDirection({ key: "ArrowDown", shiftKey: false, snippetListOwnsFocus: false })).toBeNull();
    expect(roomFindEscapeIntent(false)).toBe("close-and-restore-focus");
    expect(roomFindEscapeIntent(true)).toBeNull();
  });

  test("focus restoration helper is safe without a browser document", () => {
    expect(captureRoomFindFocusRestoreTarget(null, null)).toBeNull();
  });
});
