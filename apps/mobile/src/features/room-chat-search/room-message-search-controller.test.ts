import { describe, expect, test } from "bun:test";
import type { RoomMessageSearchOptions, RoomMessageSearchPage } from "@nautilo/types";

import { createRoomMessageSearchController } from "./room-message-search-controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function page(id: string, overrides: Partial<RoomMessageSearchPage> = {}): RoomMessageSearchPage {
  return {
    hits: [{
      messageId: id,
      createdAt: `2026-08-01T00:00:${id.padStart(2, "0")}.000Z`,
      role: "assistant",
      snippet: id,
    }],
    asOf: { createdAt: "2026-08-01T00:01:00.000Z", messageId: "60" },
    nextOlderCursor: { createdAt: `2026-08-01T00:00:${id.padStart(2, "0")}.000Z`, messageId: id },
    hasMoreOlder: false,
    ...overrides,
  };
}

const scope = { serverId: "server-1", roomId: "room-1", viewerActorId: "actor-1", viewerEpoch: 1 };

describe("D470 mobile Room-message search controller", () => {
  test("debounces one prefix/ignore-case request and selects the first hit", async () => {
    const calls: RoomMessageSearchOptions[] = [];
    const controller = createRoomMessageSearchController({
      debounceMs: 1,
      fetchPage: async (_scope, options) => { calls.push(options); return page("1"); },
    });
    controller.setScope(scope);
    controller.setQuery("launch");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toEqual([{
      roomId: "room-1",
      query: "launch",
      mode: "prefix",
      ignoreCase: true,
      limit: 20,
    }]);
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      selectedIndex: 0,
      selectedHit: { messageId: "1" },
    });
  });

  test("aborts and clears on query, Room, Server, or viewer-epoch changes", async () => {
    let aborted = false;
    const pending = deferred<RoomMessageSearchPage>();
    const controller = createRoomMessageSearchController({
      debounceMs: 0,
      fetchPage: (_scope, _options, signal) => {
        signal.addEventListener("abort", () => { aborted = true; });
        return pending.promise;
      },
    });
    controller.setScope(scope);
    controller.setQuery("old");
    await new Promise((resolve) => setTimeout(resolve, 1));
    controller.setScope({ ...scope, viewerEpoch: 2 });
    expect(aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ query: "", status: "idle", hits: [] });
    pending.resolve(page("1"));
    await Promise.resolve();
    expect(controller.getSnapshot().hits).toEqual([]);
  });

  test("moves through deduped frozen pages and caps memory at three pages", async () => {
    const calls: RoomMessageSearchOptions[] = [];
    let count = 0;
    const controller = createRoomMessageSearchController({
      debounceMs: 1000,
      fetchPage: async (_scope, options) => {
        calls.push(options);
        count += 1;
        if (count === 1) return page("1", { hasMoreOlder: true });
        if (count === 2) return page("2", { hits: [page("1").hits[0], page("2").hits[0]], hasMoreOlder: true });
        return page("3", { hasMoreOlder: true });
      },
    });
    controller.setScope(scope);
    controller.setQuery("launch");
    await controller.retry();
    await controller.moveOlder();
    expect(controller.getSnapshot().selectedHit?.messageId).toBe("2");
    await controller.moveOlder();
    expect(controller.getSnapshot()).toMatchObject({
      selectedHit: { messageId: "3" },
      pageLimitReached: true,
      hasOlder: false,
    });
    expect(calls[1]).toMatchObject({ cursor: { messageId: "1" }, asOf: { messageId: "60" } });
    expect(controller.moveNewer()).toBe(true);
    expect(controller.getSnapshot().selectedHit?.messageId).toBe("2");
  });

  test("coalesces repeated older loads and distinguishes offline recovery", async () => {
    const older = deferred<RoomMessageSearchPage>();
    let calls = 0;
    const controller = createRoomMessageSearchController({
      debounceMs: 1000,
      fetchPage: async () => {
        calls += 1;
        if (calls === 1) return page("1", { hasMoreOlder: true });
        if (calls === 2) return older.promise;
        throw new TypeError("Network request failed");
      },
    });
    controller.setScope(scope);
    controller.setQuery("launch");
    await controller.retry();
    const first = controller.moveOlder();
    expect(await controller.moveOlder()).toBe(false);
    expect(calls).toBe(2);
    older.resolve(page("2"));
    expect(await first).toBe(true);
    expect(await controller.retry()).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ status: "offline" });
  });
});
