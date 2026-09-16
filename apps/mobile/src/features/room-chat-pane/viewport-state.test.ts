import { describe, expect, test } from "bun:test";

import {
  createRoomChatViewportState,
  isAtInvertedLiveEdge,
  isRoomChatViewportAway,
  isViewportAtLiveEdge,
  leadingInsertedKeys,
  MAX_NEW_MESSAGE_COUNT,
  mayMarkRoomRead,
  maySettleLatestReturn,
  nextLatestScrollCommand,
  reduceRoomChatViewport,
  type RoomChatViewportEvent,
} from "./viewport-state";

describe("D528 reader-owned native viewport", () => {
  test("locks every event origin that may resume following", () => {
    const away = reduceRoomChatViewport(
      createRoomChatViewportState("server:viewer:room-a"),
      { type: "reader-scrolled-away", anchorKey: "msg:42" },
    );
    const inertEvents: RoomChatViewportEvent[] = [
      { type: "remote-human" },
      { type: "remote-agent-run" },
      { type: "stream-growth" },
      { type: "layout-growth" },
      { type: "history-prepend" },
      { type: "reconciliation" },
      { type: "reconnect" },
    ];
    for (const event of inertEvents) {
      expect(reduceRoomChatViewport(away, event)).toBe(away);
    }

    expect(reduceRoomChatViewport(away, {
      type: "return-requested",
      origin: "control",
    }).mode).toBe("returning");
    expect(reduceRoomChatViewport(away, {
      type: "return-requested",
      origin: "local-send",
    }).mode).toBe("returning");
    expect(reduceRoomChatViewport(away, { type: "reader-reached-live-edge" }).mode)
      .toBe("following");
  });

  test("keeps target navigation distinct until explicit live-edge recovery", () => {
    const initial = createRoomChatViewportState("scope-a");
    const pinned = reduceRoomChatViewport(initial, {
      type: "target-navigation",
      anchorKey: "msg:17",
    });
    expect(pinned).toMatchObject({ mode: "target-pinned", anchorKey: "msg:17" });
    expect(reduceRoomChatViewport(pinned, { type: "stream-growth" })).toBe(pinned);
    expect(reduceRoomChatViewport(pinned, { type: "return-requested", origin: "control" }))
      .toMatchObject({ mode: "returning", anchorKey: null, newMessageKeys: [] });
  });

  test("counts distinct new messages once and caps the signal", () => {
    let state = reduceRoomChatViewport(createRoomChatViewportState("scope-a"), {
      type: "reader-scrolled-away",
      anchorKey: "msg:old",
    });
    state = reduceRoomChatViewport(state, {
      type: "new-visible-messages",
      messageKeys: ["msg:stream-1", "msg:stream-1"],
      hasActivity: true,
    });
    state = reduceRoomChatViewport(state, {
      type: "new-visible-messages",
      messageKeys: ["msg:stream-1", ...Array.from({ length: 120 }, (_, i) => `msg:${i}`)],
    });
    expect(state.newMessageKeys[0]).toBe("msg:stream-1");
    expect(state.newMessageKeys).toHaveLength(MAX_NEW_MESSAGE_COUNT);
    expect(state.hasNewActivity).toBe(true);
  });

  test("recognizes only newest-first prefix insertion as live activity", () => {
    expect(leadingInsertedKeys(
      ["msg:5", "msg:4", "msg:3"],
      ["msg:6", "tool:t", "msg:5", "msg:4", "msg:3"],
    )).toEqual(["msg:6", "tool:t"]);
    expect(leadingInsertedKeys(
      ["msg:5", "msg:4", "msg:3"],
      ["msg:5", "msg:4", "msg:3", "msg:2"],
    )).toEqual([]);
    expect(leadingInsertedKeys(
      ["msg:5", "msg:4", "msg:3"],
      ["msg:6", "msg:4", "msg:3"],
    )).toEqual(["msg:6"]);
    expect(leadingInsertedKeys([], ["msg:5"])).toEqual([]);
  });

  test("resets anchors and activity across Room scope changes", () => {
    const away = reduceRoomChatViewport(createRoomChatViewportState("scope-a"), {
      type: "reader-scrolled-away",
      anchorKey: "msg:4",
    });
    const active = reduceRoomChatViewport(away, {
      type: "new-visible-messages",
      messageKeys: ["msg:5"],
    });
    expect(reduceRoomChatViewport(active, { type: "scope-changed", scopeKey: "scope-b" }))
      .toEqual(createRoomChatViewportState("scope-b"));
  });

  test("uses the bounded inverted-list live-edge threshold", () => {
    expect(isAtInvertedLiveEdge(0)).toBe(true);
    expect(isAtInvertedLiveEdge(24)).toBe(true);
    expect(isAtInvertedLiveEdge(24.01)).toBe(false);
  });

  test("shows return-to-latest only for deliberate away intent, not transient layout geometry", () => {
    expect(isRoomChatViewportAway("following")).toBe(false);
    expect(isRoomChatViewportAway("returning")).toBe(false);
    expect(isRoomChatViewportAway("reader-away")).toBe(true);
    expect(isRoomChatViewportAway("target-pinned")).toBe(true);
  });

  test("marks read only for an active, mounted, live-edge viewport in the current scope", () => {
    const eligible = {
      active: true,
      mounted: true,
      atLiveEdge: true,
      reportedScopeKey: "scope-a",
      currentScopeKey: "scope-a",
    };
    expect(mayMarkRoomRead(eligible)).toBe(true);
    for (const blocked of [
      { ...eligible, active: false },
      { ...eligible, mounted: false },
      { ...eligible, atLiveEdge: false },
      { ...eligible, reportedScopeKey: "scope-old" },
    ]) {
      expect(mayMarkRoomRead(blocked)).toBe(false);
    }
  });

  test("rejects prior-Room state and geometry before the new scope observes native layout", () => {
    const atLiveEdge = isViewportAtLiveEdge({
      currentScopeKey: "scope-b",
      stateScopeKey: "scope-a",
      geometryScopeKey: "scope-a",
      nativeAtLiveEdge: true,
      mode: "following",
    });
    expect(atLiveEdge).toBe(false);
    expect(mayMarkRoomRead({
      active: true,
      mounted: true,
      atLiveEdge,
      reportedScopeKey: "scope-b",
      currentScopeKey: "scope-b",
    })).toBe(false);

    expect(isViewportAtLiveEdge({
      currentScopeKey: "scope-b",
      stateScopeKey: "scope-b",
      geometryScopeKey: null,
      nativeAtLiveEdge: false,
      mode: "following",
    })).toBe(false);
  });

  test("keeps following intent but rejects measured off-edge geometry for reads", () => {
    const atLiveEdge = isViewportAtLiveEdge({
      currentScopeKey: "scope-a",
      stateScopeKey: "scope-a",
      geometryScopeKey: "scope-a",
      nativeAtLiveEdge: isAtInvertedLiveEdge(100),
      mode: "following",
    });
    expect(atLiveEdge).toBe(false);
    expect(mayMarkRoomRead({
      active: true,
      mounted: true,
      atLiveEdge,
      reportedScopeKey: "scope-a",
      currentScopeKey: "scope-a",
    })).toBe(false);
  });

  test("does not report a return as arrived while its native offset remains away", () => {
    const atLiveEdge = isViewportAtLiveEdge({
      currentScopeKey: "scope-a",
      stateScopeKey: "scope-a",
      geometryScopeKey: "scope-a",
      nativeAtLiveEdge: false,
      mode: "returning",
    });
    expect(atLiveEdge).toBe(false);
    expect(mayMarkRoomRead({
      active: true,
      mounted: true,
      atLiveEdge,
      reportedScopeKey: "scope-a",
      currentScopeKey: "scope-a",
    })).toBe(false);
  });

  test("issues each explicit local-send or control scroll exactly once when rows exist", () => {
    expect(nextLatestScrollCommand({
      appliedRequestId: 3,
      request: { id: 4, origin: "local-send" },
      hasRows: true,
    })).toEqual({ requestId: 4, origin: "local-send" });
    expect(nextLatestScrollCommand({
      appliedRequestId: 4,
      request: { id: 4, origin: "local-send" },
      hasRows: true,
    })).toBeNull();
    expect(nextLatestScrollCommand({
      appliedRequestId: 4,
      request: { id: 5, origin: "control" },
      hasRows: false,
    })).toBeNull();
  });

  test("does not replay a local-send scroll after reader-away and a remote row", () => {
    const request = { id: 8, origin: "local-send" as const };
    let appliedRequestId = 7;
    let scrollCalls = 0;
    const consume = (hasRows: boolean) => {
      const command = nextLatestScrollCommand({ appliedRequestId, request, hasRows });
      if (!command) return;
      appliedRequestId = command.requestId;
      scrollCalls += 1;
    };

    consume(true);
    let viewport = reduceRoomChatViewport(createRoomChatViewportState("scope-a"), {
      type: "reader-scrolled-away",
      anchorKey: "msg:older",
    });
    viewport = reduceRoomChatViewport(viewport, {
      type: "new-visible-messages",
      messageKeys: ["msg:remote"],
      hasActivity: true,
    });
    consume(true);

    expect(scrollCalls).toBe(1);
    expect(viewport).toMatchObject({
      mode: "reader-away",
      anchorKey: "msg:older",
      newMessageKeys: ["msg:remote"],
    });
  });

  test("settles local send only after its row commits while control can settle immediately", () => {
    expect(maySettleLatestReturn({
      origin: "local-send",
      contentCommitted: false,
      nativeAtLiveEdge: true,
    })).toBe(false);
    expect(maySettleLatestReturn({
      origin: "local-send",
      contentCommitted: true,
      nativeAtLiveEdge: false,
    })).toBe(false);
    expect(maySettleLatestReturn({
      origin: "local-send",
      contentCommitted: true,
      nativeAtLiveEdge: true,
    })).toBe(true);
    expect(maySettleLatestReturn({
      origin: "control",
      contentCommitted: false,
      nativeAtLiveEdge: true,
    })).toBe(true);
  });
});
