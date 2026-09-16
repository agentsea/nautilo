import { describe, expect, test } from "bun:test";
import type { ChatSearchOptions, ChatSearchPage } from "@nautilo/types";

import {
  createChatSearchController,
  validateChatSearchQuery,
} from "./chat-search-controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function page(
  id: string,
  options: Partial<ChatSearchPage> = {},
): ChatSearchPage {
  return {
    conversations: [{
      room: {
        id: `room-${id}`,
        label: `Room ${id}`,
        type: "chat",
        graphThreadId: `thread-${id}`,
        createdAt: "2026-08-01T00:00:00.000Z",
        memberCount: 2,
        kind: "private",
        roster: [],
      },
      matchedBy: "label",
    }],
    conversationsTruncated: false,
    messages: [{
      roomId: `room-${id}`,
      roomLabel: `Room ${id}`,
      roomKind: "private",
      messageId: id,
      createdAt: `2026-08-01T00:00:${id.padStart(2, "0")}.000Z`,
      role: "assistant",
      snippet: `result ${id}`,
    }],
    messageAsOf: { createdAt: "2026-08-01T00:01:00.000Z", messageId: "60" },
    nextOlderMessageCursor: {
      createdAt: `2026-08-01T00:00:${id.padStart(2, "0")}.000Z`,
      messageId: id,
    },
    hasMoreOlderMessages: false,
    ...options,
  };
}

const scopeA = { serverId: "server-a", viewerActorId: "actor-a", viewerEpoch: 1 };
const scopeB = { serverId: "server-b", viewerActorId: "actor-b", viewerEpoch: 1 };

describe("D470 mobile Chats-search controller", () => {
  test("validates the same bounded human query shape before issuing HTTP", () => {
    expect(validateChatSearchQuery("  launch plan  ")).toEqual({
      ok: true,
      query: "launch plan",
    });
    expect(validateChatSearchQuery("---")).toMatchObject({ ok: false });
    expect(validateChatSearchQuery("a ".repeat(17))).toMatchObject({ ok: false });
    expect(validateChatSearchQuery("x".repeat(257))).toMatchObject({ ok: false });
  });

  test("uses one prefix/ignore-case request after debounce and exposes both sections", async () => {
    const calls: ChatSearchOptions[] = [];
    const controller = createChatSearchController({
      debounceMs: 1,
      fetchPage: async (_scope, options) => {
        calls.push(options);
        return page("1");
      },
    });
    controller.setScope(scopeA);
    controller.setQuery("launch");
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(calls).toEqual([{ query: "launch", mode: "prefix", ignoreCase: true, limit: 20 }]);
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      conversations: [{ room: { id: "room-1" } }],
      messages: [{ messageId: "1" }],
    });
  });

  test("clears immediately and discards a late response after query or identity change", async () => {
    const first = deferred<ChatSearchPage>();
    const controller = createChatSearchController({
      debounceMs: 0,
      fetchPage: () => first.promise,
    });
    controller.setScope(scopeA);
    controller.setQuery("old query");
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(controller.getSnapshot().status).toBe("loading");

    controller.setQuery("new query");
    expect(controller.getSnapshot()).toMatchObject({
      query: "new query",
      status: "debouncing",
      conversations: [],
      messages: [],
    });
    controller.setScope(scopeB);
    expect(controller.getSnapshot()).toMatchObject({ scope: scopeB, status: "idle", query: "" });
    first.resolve(page("1"));
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({ scope: scopeB, status: "idle", messages: [] });
  });

  test("aborts the previous fetch as soon as the query changes", async () => {
    let aborted = false;
    const pending = deferred<ChatSearchPage>();
    const controller = createChatSearchController({
      debounceMs: 0,
      fetchPage: (_scope, _options, signal) => {
        signal.addEventListener("abort", () => { aborted = true; });
        return pending.promise;
      },
    });
    controller.setScope(scopeA);
    controller.setQuery("first");
    await new Promise((resolve) => setTimeout(resolve, 1));
    controller.setQuery("second");
    expect(aborted).toBe(true);
    pending.resolve(page("1"));
  });

  test("fences a refreshed viewer even when the Server and Actor IDs are unchanged", async () => {
    let aborted = false;
    const pending = deferred<ChatSearchPage>();
    const controller = createChatSearchController({
      debounceMs: 0,
      fetchPage: (_scope, _options, signal) => {
        signal.addEventListener("abort", () => { aborted = true; });
        return pending.promise;
      },
    });
    controller.setScope(scopeA);
    controller.setQuery("launch");
    await new Promise((resolve) => setTimeout(resolve, 1));

    const refreshed = { ...scopeA, viewerEpoch: 2 };
    controller.setScope(refreshed);
    expect(aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      scope: refreshed,
      query: "",
      status: "idle",
      messages: [],
    });
    pending.resolve(page("1"));
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({ scope: refreshed, messages: [] });
  });

  test("pages with frozen cursor/asOf, dedupes rows, and stops after three pages", async () => {
    const calls: unknown[] = [];
    let call = 0;
    const controller = createChatSearchController({
      debounceMs: 1000,
      fetchPage: async (_scope, options) => {
        calls.push(options);
        call += 1;
        if (call === 1) return page("1", { hasMoreOlderMessages: true });
        if (call === 2) {
          return page("2", {
            conversations: [],
            messages: [page("1").messages[0], page("2").messages[0]],
            hasMoreOlderMessages: true,
          });
        }
        return page("3", { conversations: [], hasMoreOlderMessages: true });
      },
    });
    controller.setScope(scopeA);
    controller.setQuery("launch");
    expect(await controller.retry()).toBe(true);
    expect(await controller.loadOlder()).toBe(true);
    expect(await controller.loadOlder()).toBe(true);
    expect(await controller.loadOlder()).toBe(false);

    expect(calls).toHaveLength(3);
    expect(calls[1]).toMatchObject({
      cursor: { messageId: "1" },
      asOf: { messageId: "60" },
    });
    expect(controller.getSnapshot()).toMatchObject({
      messages: [{ messageId: "1" }, { messageId: "2" }, { messageId: "3" }],
      hasMoreOlderMessages: false,
      pageLimitReached: true,
    });
  });

  test("coalesces repeated older loads and guards only the active navigation transition", async () => {
    const older = deferred<ChatSearchPage>();
    let call = 0;
    const controller = createChatSearchController({
      debounceMs: 1000,
      navigationGuardMs: 1,
      fetchPage: async () => {
        call += 1;
        return call === 1 ? page("1", { hasMoreOlderMessages: true }) : older.promise;
      },
    });
    controller.setScope(scopeA);
    controller.setQuery("launch");
    await controller.retry();
    const first = controller.loadOlder();
    const repeated = controller.loadOlder();
    expect(call).toBe(2);
    expect(await repeated).toBe(false);
    older.resolve(page("2"));
    expect(await first).toBe(true);
    expect(controller.claimNavigation("message:room-2:2")).toBe(true);
    expect(controller.claimNavigation("message:room-2:2")).toBe(false);
    expect(controller.claimNavigation("message:room-3:3")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(controller.claimNavigation("message:room-2:2")).toBe(true);
  });

  test("shows offline failures distinctly and keeps retry recoverable", async () => {
    let fail = true;
    const controller = createChatSearchController({
      debounceMs: 1000,
      fetchPage: async () => {
        if (fail) throw new TypeError("Network request failed");
        return page("1");
      },
    });
    controller.setScope(scopeA);
    controller.setQuery("launch");
    expect(await controller.retry()).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      status: "offline",
      error: "Check your connection, then try again.",
    });
    fail = false;
    expect(await controller.retry()).toBe(true);
    expect(controller.getSnapshot().status).toBe("ready");
  });

  test("converges cached conversation and message labels without another search", async () => {
    const controller = createChatSearchController({ debounceMs: 1000, fetchPage: async () => page("1") });
    controller.setScope(scopeA);
    controller.setQuery("launch");
    await controller.retry();

    controller.applyRoomProjection({ roomId: "room-1", label: "Renamed chat" });
    expect(controller.getSnapshot()).toMatchObject({
      conversations: [{ room: { label: "Renamed chat" } }],
      messages: [{ roomLabel: "Renamed chat" }],
    });
    controller.applyRoomProjection({ roomId: "room-1", removed: true });
    expect(controller.getSnapshot()).toMatchObject({ conversations: [], messages: [] });
  });
});
