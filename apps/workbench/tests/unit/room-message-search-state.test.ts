import { describe, expect, test } from "bun:test";
import type {
  RoomMessageSearchCursor,
  RoomMessageSearchOptions,
  RoomMessageSearchPage,
} from "@nautilo/types";
import { createRoomMessageSearchController } from "../../src/adapters/room-search-state";

const asOf: RoomMessageSearchCursor = {
  createdAt: "2026-01-05T00:00:00.000Z",
  messageId: "50",
};

function cursor(id: string): RoomMessageSearchCursor {
  return { createdAt: `2026-01-${id.padStart(2, "0")}T00:00:00.000Z`, messageId: id };
}

function page(args: {
  id: string;
  nextOlderCursor?: RoomMessageSearchCursor | null;
  hasMoreOlder?: boolean;
  pageAsOf?: RoomMessageSearchCursor | null;
}): RoomMessageSearchPage {
  return {
    hits: [{
      messageId: args.id,
      createdAt: "2026-01-05T00:00:00.000Z",
      role: "assistant",
      snippet: `hit-${args.id}`,
    }],
    asOf: args.pageAsOf === undefined ? asOf : args.pageAsOf,
    nextOlderCursor: args.nextOlderCursor ?? null,
    hasMoreOlder: args.hasMoreOlder ?? false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settleDebounce(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("D430 Room message search state", () => {
  test("empty and invalid input clear memory-only results without a request", async () => {
    const calls: RoomMessageSearchOptions[] = [];
    const controller = createRoomMessageSearchController({
      debounceMs: 0,
      fetchPage: async (options) => {
        calls.push(options);
        return page({ id: "unexpected" });
      },
    });

    controller.setRoomId("room-a");
    controller.setQuery("!!!");
    await settleDebounce();
    expect(calls).toEqual([]);
    expect(controller.getSnapshot()).toMatchObject({
      roomId: "room-a",
      status: "invalid",
      hits: [],
      pages: [],
    });

    controller.setQuery(" ");
    await settleDebounce();
    expect(calls).toEqual([]);
    expect(controller.getSnapshot().status).toBe("idle");
  });

  test("query generations ignore stale successes and errors while permitting one in-flight request per generation", async () => {
    const pending: Array<ReturnType<typeof deferred<RoomMessageSearchPage>>> = [];
    const controller = createRoomMessageSearchController({
      debounceMs: 0,
      fetchPage: () => {
        const next = deferred<RoomMessageSearchPage>();
        pending.push(next);
        return next.promise;
      },
    });

    controller.setRoomId("room-a");
    controller.setQuery("first");
    await settleDebounce();
    controller.setQuery("second");
    await settleDebounce();
    expect(pending).toHaveLength(2);

    pending[0]!.resolve(page({ id: "stale" }));
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({ query: "second", hits: [] });

    pending[1]!.resolve(page({ id: "fresh" }));
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({
      query: "second",
      status: "ready",
      hits: [{ messageId: "fresh" }],
    });

    controller.setQuery("third");
    await settleDebounce();
    controller.setQuery("fourth");
    await settleDebounce();
    expect(pending).toHaveLength(4);
    pending[2]!.reject(new Error("obsolete"));
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({ query: "fourth", status: "loading" });
    pending[3]!.resolve(page({ id: "fourth" }));
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({ query: "fourth", status: "ready" });
  });

  test("Room switch clears the old query, issues no new request, and rejects late completions", async () => {
    let activeRoomId: string | null = "room-a";
    const first = deferred<RoomMessageSearchPage>();
    const second = deferred<RoomMessageSearchPage>();
    let calls = 0;
    const controller = createRoomMessageSearchController({
      debounceMs: 0,
      getActiveRoomId: () => activeRoomId,
      fetchPage: () => (calls++ === 0 ? first.promise : second.promise),
    });

    controller.setRoomId("room-a");
    controller.setQuery("launch");
    await settleDebounce();
    activeRoomId = "room-b";
    controller.setRoomId("room-b");
    await settleDebounce();
    expect(calls).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({
      roomId: "room-b",
      query: "",
      status: "idle",
      hits: [],
      pages: [],
    });

    first.resolve(page({ id: "room-a" }));
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({ roomId: "room-b", query: "", hits: [] });

    controller.setQuery("launch");
    await settleDebounce();
    expect(calls).toBe(2);
    second.resolve(page({ id: "room-b" }));
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({
      roomId: "room-b",
      status: "ready",
      hits: [{ messageId: "room-b" }],
    });
  });

  test("a successful zero-hit page has a distinct empty status", async () => {
    const controller = createRoomMessageSearchController({
      debounceMs: 0,
      fetchPage: async () => ({
        hits: [],
        asOf,
        nextOlderCursor: null,
        hasMoreOlder: false,
      }),
    });
    controller.setRoomId("room-a");
    controller.setQuery("absent");
    await settleDebounce();
    expect(controller.getSnapshot()).toMatchObject({ status: "empty", hits: [] });
  });

  test("Ignore case defaults on and changing it starts an isolated query generation", async () => {
    const calls: RoomMessageSearchOptions[] = [];
    const controller = createRoomMessageSearchController({
      debounceMs: 0,
      fetchPage: async (options) => {
        calls.push(options);
        return page({ id: options.ignoreCase === false ? "case-sensitive" : "ignore-case" });
      },
    });
    controller.setRoomId("room-a");
    controller.setQuery("Dark");
    await settleDebounce();
    expect(controller.getSnapshot().ignoreCase).toBe(true);
    expect(calls[0]).toMatchObject({ ignoreCase: true });

    controller.setIgnoreCase(false);
    await settleDebounce();
    expect(controller.getSnapshot()).toMatchObject({
      ignoreCase: false,
      hits: [{ messageId: "case-sensitive" }],
    });
    expect(calls[1]).toMatchObject({ ignoreCase: false });
  });

  test("freezes asOf, retains three pages, and refetches an evicted newer page from its saved cursor", async () => {
    const calls: RoomMessageSearchOptions[] = [];
    const responses: Array<ReturnType<typeof deferred<RoomMessageSearchPage>>> = [];
    const controller = createRoomMessageSearchController({
      debounceMs: 0,
      fetchPage: (options) => {
        calls.push(options);
        const next = deferred<RoomMessageSearchPage>();
        responses.push(next);
        return next.promise;
      },
    });

    controller.setRoomId("room-a");
    controller.setQuery("launch");
    await settleDebounce();
    responses[0]!.resolve(page({ id: "0", nextOlderCursor: cursor("40"), hasMoreOlder: true }));
    await Promise.resolve();

    const loadOne = controller.loadOlder();
    expect(await controller.loadOlder()).toBe(false);
    responses[1]!.resolve(page({ id: "1", nextOlderCursor: cursor("30"), hasMoreOlder: true }));
    await loadOne;
    const loadTwo = controller.loadOlder();
    responses[2]!.resolve(page({ id: "2", nextOlderCursor: cursor("20"), hasMoreOlder: true }));
    await loadTwo;
    const loadThree = controller.loadOlder();
    responses[3]!.resolve(page({ id: "3", nextOlderCursor: cursor("10"), hasMoreOlder: true }));
    await loadThree;

    expect(calls).toHaveLength(4);
    expect(calls[1]).toMatchObject({ cursor: cursor("40"), asOf });
    expect(calls[2]).toMatchObject({ cursor: cursor("30"), asOf });
    expect(calls[3]).toMatchObject({ cursor: cursor("20"), asOf });
    expect(controller.getSnapshot()).toMatchObject({
      asOf,
      currentPageIndex: 3,
      pages: [{ index: 0 }, { index: 2 }, { index: 3 }],
    });

    await controller.loadNewer();
    expect(controller.getSnapshot().currentPageIndex).toBe(2);
    const refetch = controller.loadNewer();
    expect(calls).toHaveLength(5);
    expect(calls[4]).toMatchObject({ cursor: cursor("40"), asOf });
    responses[4]!.resolve(page({ id: "1-refetched", nextOlderCursor: cursor("30"), hasMoreOlder: true }));
    await refetch;
    expect(controller.getSnapshot()).toMatchObject({
      currentPageIndex: 1,
      hits: [{ messageId: "1-refetched" }],
    });
  });
});
