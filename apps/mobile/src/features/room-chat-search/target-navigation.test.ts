import { describe, expect, test } from "bun:test";
import type { ChatItem } from "@/lib/messages";
import type { RoomMessagesAroundPage } from "@nautilo/types";

import { createTranscriptTargetNavigator } from "./target-navigation";
import {
  mergeTranscriptWindow,
  targetToRestoreAfterLatestReload,
} from "./transcript-window";

function message(id: string): ChatItem {
  return { kind: "message", id, role: "assistant", text: id, createdAt: `2026-08-01T00:00:${id.padStart(2, "0")}.000Z` };
}

function page(id: string): RoomMessagesAroundPage {
  return {
    messages: [{ id, role: "assistant", content: id, createdAt: `2026-08-01T00:00:${id.padStart(2, "0")}.000Z` }],
    target: { messageId: id, createdAt: `2026-08-01T00:00:${id.padStart(2, "0")}.000Z` },
    includedToolCallCompanion: false,
    hasOlder: true,
    hasNewer: true,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("D470 transcript target navigation", () => {
  test("loaded targets avoid around reads; unloaded repeated activations share one", async () => {
    let items: readonly ChatItem[] = [message("2")];
    let fetches = 0;
    const pending = deferred<RoomMessagesAroundPage>();
    const focused: string[] = [];
    const navigator = createTranscriptTargetNavigator({
      getItems: () => items,
      fetchAround: async () => { fetches += 1; return pending.promise; },
      hydrate: async (value) => value.messages.map((row) => message(row.id)),
      apply: (next) => { items = next; },
      focus: (id) => focused.push(id),
      fail: () => undefined,
    });
    navigator.setScope("server:viewer:room");
    expect(await navigator.activate("2")).toBe(true);
    expect(fetches).toBe(0);
    const first = navigator.activate("1");
    const repeated = navigator.activate("1");
    expect(fetches).toBe(1);
    pending.resolve(page("1"));
    expect(await first).toBe(true);
    expect(await repeated).toBe(true);
    expect(items.map((item) => item.kind === "message" ? item.id : item.toolCallId)).toEqual(["1", "2"]);
    expect(focused).toEqual(["2", "1"]);
  });

  test("a scope change discards a late around response", async () => {
    let items: readonly ChatItem[] = [];
    const pending = deferred<RoomMessagesAroundPage>();
    const navigator = createTranscriptTargetNavigator({
      getItems: () => items,
      fetchAround: () => pending.promise,
      hydrate: async (value) => value.messages.map((row) => message(row.id)),
      apply: (next) => { items = next; },
      focus: () => undefined,
      fail: () => undefined,
    });
    navigator.setScope("old");
    const activation = navigator.activate("1");
    navigator.setScope("new");
    pending.resolve(page("1"));
    expect(await activation).toBe(false);
    expect(items).toEqual([]);
  });

  test("a changed search cancels a late target without leaving the Room scope", async () => {
    let items: readonly ChatItem[] = [];
    const pending = deferred<RoomMessagesAroundPage>();
    let fetches = 0;
    const failures: string[] = [];
    const navigator = createTranscriptTargetNavigator({
      getItems: () => items,
      fetchAround: (id) => {
        fetches += 1;
        return fetches === 1 ? pending.promise : Promise.resolve(page(id));
      },
      hydrate: async (value) => value.messages.map((row) => message(row.id)),
      apply: (next) => { items = next; },
      focus: () => undefined,
      fail: (failure) => failures.push(failure),
    });
    navigator.setScope("server:viewer:room");
    const stale = navigator.activate("1");
    navigator.cancel();
    pending.resolve(page("1"));
    expect(await stale).toBe(false);
    expect(items).toEqual([]);
    expect(failures).toEqual([]);

    expect(await navigator.activate("2")).toBe(true);
    expect(items.some((item) => item.kind === "message" && item.id === "2")).toBe(true);
  });

  test("a latest-page reload rehydrates and preserves the historical target", async () => {
    let items: readonly ChatItem[] = [message("8"), message("9")];
    let window = mergeTranscriptWindow({
      current: items,
      hydrated: [message("2")],
      targetMessageId: "2",
      hasOlder: true,
      hasNewer: true,
    }).window;
    const restore = targetToRestoreAfterLatestReload(window);
    items = [message("8"), message("9")];
    let fetches = 0;
    const navigator = createTranscriptTargetNavigator({
      getItems: () => items,
      fetchAround: async (id) => { fetches += 1; return page(id); },
      hydrate: async (value) => value.messages.map((row) => message(row.id)),
      apply: (next, nextWindow) => { items = next; window = nextWindow; },
      focus: () => undefined,
      fail: () => undefined,
    });
    navigator.setScope("server:viewer:room");
    expect(restore).toBe("2");
    expect(await navigator.activate(restore!)).toBe(true);
    expect(fetches).toBe(1);
    expect(window).toMatchObject({ mode: "historical", targetMessageId: "2", targetFound: true });
    expect(items.some((item) => item.kind === "message" && item.id === "2")).toBe(true);
  });
});
