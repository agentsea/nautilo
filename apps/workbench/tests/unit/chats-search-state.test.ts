import { describe, expect, test } from "bun:test";
import type {
  ChatSearchConversationHit,
  ChatSearchMessageHit,
  ChatSearchOptions,
  ChatSearchPage,
  RoomMessageSearchCursor,
} from "@nautilo/types";
import { createChatsSearchController } from "../../src/adapters/chats-search-state";

const asOf: RoomMessageSearchCursor = {
  createdAt: "2026-01-31T00:00:00.000Z",
  messageId: "50",
};

function cursor(id: string): RoomMessageSearchCursor {
  return { createdAt: `2026-01-${id.padStart(2, "0")}T00:00:00.000Z`, messageId: id };
}

function conversation(id: string): ChatSearchConversationHit {
  return {
    room: { id, label: `room-${id}` } as ChatSearchConversationHit["room"],
    matchedBy: "label",
  };
}

function message(id: string): ChatSearchMessageHit {
  return {
    messageId: id,
    createdAt: "2026-01-31T00:00:00.000Z",
    role: "assistant",
    snippet: `hit-${id}`,
    roomId: "room-a",
    roomLabel: "Room A",
    roomKind: "private",
  };
}

function page(args: {
  id?: string;
  conversationId?: string;
  pageAsOf?: RoomMessageSearchCursor | null;
  nextOlder?: RoomMessageSearchCursor | null;
  hasMore?: boolean;
  truncated?: boolean;
} = {}): ChatSearchPage {
  return {
    conversations: args.conversationId ? [conversation(args.conversationId)] : [],
    conversationsTruncated: args.truncated ?? false,
    messages: args.id ? [message(args.id)] : [],
    messageAsOf: args.pageAsOf === undefined ? asOf : args.pageAsOf,
    nextOlderMessageCursor: args.nextOlder ?? null,
    hasMoreOlderMessages: args.hasMore ?? false,
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

const scopeA = { serverKey: "https://one.example", viewerKey: "actor-a", viewerGeneration: 1 };

describe("D470 Chats-wide search state", () => {
  test("uses the 200 ms default debounce and clears stale display immediately", async () => {
    const calls: ChatSearchOptions[] = [];
    const controller = createChatsSearchController({
      fetchPage: async (options) => {
        calls.push(options);
        return page({ id: "one" });
      },
    });
    controller.setScope(scopeA);
    controller.setQuery("launch");
    expect(controller.getSnapshot()).toMatchObject({ status: "debouncing", messages: [] });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(calls).toEqual([]);
    await new Promise<void>((resolve) => setTimeout(resolve, 130));
    expect(calls).toHaveLength(1);
    expect(controller.getSnapshot()).toMatchObject({ status: "ready", messages: [{ messageId: "one" }] });
    controller.dispose();
  });

  test("validates without a request and never exposes the previous query while debouncing", async () => {
    const calls: ChatSearchOptions[] = [];
    const controller = createChatsSearchController({
      debounceMs: 0,
      fetchPage: async (options) => {
        calls.push(options);
        return page({ id: options.query });
      },
    });
    controller.setScope(scopeA);
    controller.setQuery("first");
    await settleDebounce();
    expect(controller.getSnapshot().messages).toHaveLength(1);

    controller.setQuery("second");
    expect(controller.getSnapshot()).toMatchObject({
      query: "second",
      status: "debouncing",
      conversations: [],
      messages: [],
      pages: [],
    });
    await settleDebounce();

    controller.setQuery("!!!");
    await settleDebounce();
    expect(calls).toHaveLength(2);
    expect(controller.getSnapshot()).toMatchObject({ status: "invalid", messages: [] });
    controller.dispose();
  });

  test("aborts and rejects stale query, Server, and viewer generations", async () => {
    const pending: Array<ReturnType<typeof deferred<ChatSearchPage>>> = [];
    const signals: AbortSignal[] = [];
    const controller = createChatsSearchController({
      debounceMs: 0,
      fetchPage: (_options, signal) => {
        signals.push(signal);
        const next = deferred<ChatSearchPage>();
        pending.push(next);
        return next.promise;
      },
    });
    controller.setScope(scopeA);
    controller.setQuery("first");
    await settleDebounce();
    controller.setQuery("second");
    expect(signals[0]!.aborted).toBe(true);
    expect(controller.getSnapshot().messages).toEqual([]);
    await settleDebounce();
    pending[0]!.resolve(page({ id: "stale-query" }));
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({ query: "second", status: "loading", messages: [] });

    controller.setScope({ ...scopeA, serverKey: "https://two.example" });
    expect(signals[1]!.aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ query: "", status: "idle", pages: [] });
    pending[1]!.resolve(page({ id: "stale-server" }));
    await Promise.resolve();
    expect(controller.getSnapshot().messages).toEqual([]);

    controller.setScope({ ...scopeA, viewerGeneration: 2 });
    expect(controller.getSnapshot()).toMatchObject({ query: "", status: "idle" });
    controller.dispose();
  });

  test("freezes D470 messageAsOf, replaces Conversations, and bounds cached Message pages to three", async () => {
    const calls: ChatSearchOptions[] = [];
    const controller = createChatsSearchController({
      debounceMs: 0,
      fetchPage: async (options) => {
        calls.push(options);
        const id = options.cursor?.messageId ?? "0";
        const nextById: Record<string, RoomMessageSearchCursor | null> = {
          "0": cursor("40"),
          "40": cursor("30"),
          "30": cursor("20"),
          "20": cursor("10"),
        };
        return page({
          id,
          conversationId: `c-${id}`,
          truncated: id === "0",
          nextOlder: nextById[id] ?? null,
          hasMore: nextById[id] !== null,
        });
      },
    });
    controller.setScope(scopeA);
    controller.setQuery("launch");
    await settleDebounce();
    expect(controller.getSnapshot()).toMatchObject({
      conversations: [{ room: { id: "c-0" } }],
      conversationsTruncated: true,
      messageAsOf: asOf,
    });

    await controller.loadOlderMessages();
    await controller.loadOlderMessages();
    await controller.loadOlderMessages();
    expect(calls[1]).toMatchObject({ cursor: cursor("40"), asOf });
    expect(calls[2]).toMatchObject({ cursor: cursor("30"), asOf });
    expect(calls[3]).toMatchObject({ cursor: cursor("20"), asOf });
    expect(controller.getSnapshot()).toMatchObject({
      currentMessagePageIndex: 3,
      pages: [{ index: 0 }, { index: 2 }, { index: 3 }],
      conversations: [{ room: { id: "c-20" } }],
      conversationsTruncated: false,
    });

    await controller.loadNewerMessages();
    await controller.loadNewerMessages();
    expect(calls.at(-1)).toMatchObject({ cursor: cursor("40"), asOf });
    expect(controller.getSnapshot()).toMatchObject({
      currentMessagePageIndex: 1,
      messages: [{ messageId: "40" }],
    });
    controller.dispose();
  });

  test("retries the exact failed page, and clear/dispose abort pending work", async () => {
    let calls = 0;
    const signals: AbortSignal[] = [];
    const controller = createChatsSearchController({
      debounceMs: 0,
      fetchPage: async (_options, signal) => {
        calls += 1;
        signals.push(signal);
        if (calls === 1) throw new Error("offline");
        if (calls === 2) return page({ id: "retry" });
        return new Promise<ChatSearchPage>(() => {});
      },
    });
    controller.setScope(scopeA);
    controller.setQuery("launch");
    await settleDebounce();
    expect(controller.getSnapshot().status).toBe("error");
    expect(await controller.retry()).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ status: "ready", messages: [{ messageId: "retry" }] });

    controller.setQuery("pending");
    await settleDebounce();
    controller.clear();
    expect(signals[2]!.aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ query: "", status: "idle", messages: [] });

    controller.setQuery("dispose");
    await settleDebounce();
    controller.dispose();
    expect(signals[3]!.aborted).toBe(true);
    expect(await controller.retry()).toBe(false);
  });
});
