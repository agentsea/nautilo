import { beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { ChatItem } from "@/lib/messages";
import { useRoomChatViewport } from "./use-room-chat-viewport";

const browser = new Window();
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const stream = (
  key = "streaming:turn-1",
): Extract<ChatItem, { kind: "message" }> => ({
  kind: "message",
  id: key,
  presentationKey: key,
  role: "assistant",
  text: "answer",
  createdAt: "2026-09-09T00:00:00.000Z",
  turnId: "turn-1",
});
const keyExtractor = (item: ChatItem) =>
  item.kind === "tool" ? `tool:${item.toolCallId}` : `msg:${item.presentationKey ?? item.id}`;
const scrollEvent = (offset: number) => ({
  nativeEvent: { contentOffset: { y: offset } },
}) as never;

let items: ChatItem[];
let scopeKey: string;
let request: { id: number; origin: "control" | "local-send"; awaitContentCommit: boolean };
let current: ReturnType<typeof useRoomChatViewport>;
const scrollCalls: Array<{ offset: number; animated: boolean }> = [];
const listRef = {
  current: { scrollToOffset: (input: { offset: number; animated: boolean }) => scrollCalls.push(input) },
} as never;

function Harness() {
  current = useRoomChatViewport({
    scopeKey,
    renderItems: items,
    keyExtractor,
    listRef,
    latestRequest: request,
    onHumanReachedLiveEdge: () => {},
  });
  return null;
}

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = async () => {
    await act(async () => root.render(createElement(Harness)));
  };
  await render();
  return {
    render,
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

async function becomeReaderAway(offset: number) {
  await act(async () => {
    current.onScrollBeginDrag();
    current.onScroll(scrollEvent(offset));
    current.onMomentumScrollEnd(scrollEvent(offset));
  });
  expect(current.state.mode).toBe("reader-away");
}

beforeEach(() => {
  items = [stream()];
  scopeKey = "scope-a";
  request = { id: 0, origin: "control", awaitContentCommit: false };
  scrollCalls.length = 0;
});

test("moves the native anchor past row zero only while the reader is away", async () => {
  const ui = await mount();
  try {
    expect(current.maintainVisibleContentPosition).toEqual({
      minIndexForVisible: 0,
      autoscrollToTopThreshold: 24,
    });
    await becomeReaderAway(205);
    expect(current.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 1 });

    items = [{ ...stream(), text: "answer\nwith another streamed line" }];
    await ui.render();
    items = [{ ...stream(), id: "42", turnId: undefined, status: "sent" }];
    await ui.render();

    expect(current.state.mode).toBe("reader-away");
    expect(current.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 1 });
    expect(scrollCalls).toEqual([]);
  } finally {
    await ui.close();
  }
});

test("keeps native reader anchoring active throughout drag and momentum", async () => {
  const ui = await mount();
  try {
    await act(async () => {
      current.onScrollBeginDrag();
      current.onScroll(scrollEvent(100));
    });
    expect(current.state.mode).toBe("reader-away");
    expect(current.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 1 });

    await act(async () => {
      current.onScrollEndDrag(scrollEvent(100));
      current.onMomentumScrollBegin();
    });
    items = [{ ...stream(), text: "answer grows during momentum" }];
    await ui.render();
    expect(current.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 1 });
    expect(scrollCalls).toEqual([]);

    await act(async () => current.onMomentumScrollEnd(scrollEvent(100)));
    expect(current.state.mode).toBe("reader-away");
    expect(current.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 1 });
  } finally {
    await ui.close();
  }
});

test("uses the same native reader anchor for an explicitly pinned target", async () => {
  const ui = await mount();
  try {
    await act(async () => current.pinTarget("msg:older"));
    expect(current.state).toMatchObject({
      mode: "target-pinned",
      anchorKey: "msg:older",
    });
    expect(current.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 1 });
  } finally {
    await ui.close();
  }
});

test("keeps inserted live rows native-anchored only until an explicit return arrives", async () => {
  const ui = await mount();
  try {
    await becomeReaderAway(100);
    items = [stream("streaming:turn-2"), ...items];
    await ui.render();

    expect(current.state.mode).toBe("reader-away");
    expect(current.newMessageCount).toBe(1);
    expect(current.hasNewActivity).toBe(true);
    expect(current.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 1 });
    expect(scrollCalls).toEqual([]);

    request = { id: 1, origin: "control", awaitContentCommit: false };
    await ui.render();
    expect(current.state.mode).toBe("returning");
    expect(current.maintainVisibleContentPosition).toEqual({
      minIndexForVisible: 0,
      autoscrollToTopThreshold: 24,
    });
    expect(scrollCalls).toEqual([{ offset: 0, animated: true }]);

    await act(async () => current.onScroll(scrollEvent(0)));
    expect(current.state.mode).toBe("following");
    expect(current.newMessageCount).toBe(0);

    items = [stream("streaming:turn-3"), ...items];
    await ui.render();
    expect(current.state.mode).toBe("following");
    expect(current.newMessageCount).toBe(0);
    expect(current.maintainVisibleContentPosition).toEqual({
      minIndexForVisible: 0,
      autoscrollToTopThreshold: 24,
    });
    expect(scrollCalls).toEqual([{ offset: 0, animated: true }]);
  } finally {
    await ui.close();
  }
});

test("restores the live-edge native policy when the reader scrolls back to zero", async () => {
  const ui = await mount();
  try {
    await becomeReaderAway(100);
    expect(current.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 1 });

    await act(async () => {
      current.onScrollBeginDrag();
      current.onScroll(scrollEvent(0));
      current.onMomentumScrollEnd(scrollEvent(0));
    });

    expect(current.state.mode).toBe("following");
    expect(current.maintainVisibleContentPosition).toEqual({
      minIndexForVisible: 0,
      autoscrollToTopThreshold: 24,
    });
    expect(scrollCalls).toEqual([]);
  } finally {
    await ui.close();
  }
});

test("returns control and local sends to the live-edge native policy", async () => {
  const ui = await mount();
  try {
    await becomeReaderAway(100);
    request = { id: 1, origin: "control", awaitContentCommit: false };
    await ui.render();
    expect(current.state.mode).toBe("returning");
    expect(current.maintainVisibleContentPosition).toEqual({
      minIndexForVisible: 0,
      autoscrollToTopThreshold: 24,
    });
    expect(scrollCalls).toEqual([{ offset: 0, animated: true }]);

    await becomeReaderAway(100);
    scrollCalls.length = 0;
    request = { id: 2, origin: "local-send", awaitContentCommit: true };
    await ui.render();
    expect(current.state.mode).toBe("returning");
    expect(current.maintainVisibleContentPosition).toEqual({
      minIndexForVisible: 0,
      autoscrollToTopThreshold: 24,
    });
    expect(scrollCalls).toEqual([]);
  } finally {
    await ui.close();
  }
});

test("does not carry native reader anchoring into another Room scope", async () => {
  const ui = await mount();
  try {
    await becomeReaderAway(100);
    expect(current.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 1 });

    scopeKey = "scope-b";
    await ui.render();
    expect(current.state).toMatchObject({
      scopeKey: "scope-b",
      mode: "following",
    });
    expect(current.maintainVisibleContentPosition).toEqual({
      minIndexForVisible: 0,
      autoscrollToTopThreshold: 24,
    });
    expect(scrollCalls).toEqual([]);
  } finally {
    await ui.close();
  }
});
