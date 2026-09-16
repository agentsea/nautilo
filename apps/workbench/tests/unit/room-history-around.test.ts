import { describe, expect, test } from "bun:test";
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { RoomMessagesAroundPage } from "@nautilo/types";
import {
  createRoomHistoryAroundController,
  mergeRoomMessagesAround,
  nextMountedHistoryPrioritySelection,
  mountedRoomHistoryPrioritySelection,
  mountedRoomHistoryRefreshRequest,
  mountedRoomHistoryRefreshTarget,
  mountedRoomHistoryRefreshTargetState,
  nextMountedUnavailableHistorySelection,
  replaceRefreshedRoomMessage,
} from "../../src/adapters/room-history-around";
import { restoreSessionMessages } from "../../src/adapters/session-rehydrate";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function aroundPage(targetId: string, options?: Partial<RoomMessagesAroundPage>): RoomMessagesAroundPage {
  return {
    messages: [
      {
        id: "5",
        role: "assistant",
        content: "invocation",
        toolCalls: '[{"id":"call-1","name":"lookup","args":{"query":"launch"}}]',
        createdAt: "2026-01-01T00:00:05.000Z",
      },
      {
        id: targetId,
        role: "tool",
        content: "result",
        toolCalls: null,
        toolName: "lookup",
        createdAt: "2026-01-01T00:00:06.000Z",
      },
    ],
    target: { createdAt: "2026-01-01T00:00:06.000Z", messageId: targetId },
    includedToolCallCompanion: true,
    hasOlder: true,
    hasNewer: true,
    ...options,
  };
}

function text(id: string, label: string): ThreadMessageLike {
  return { id, role: "assistant", content: [{ type: "text", text: label }] };
}

describe("D430 around-message history controller", () => {
  test("refreshes a mounted child Message through its active parent Room", () => {
    expect(mountedRoomHistoryRefreshRequest(
      "parent-room",
      [text("27", "mounted child row")],
      { roomId: "child-room", messageId: 27, revision: 0 },
    )).toEqual({ roomId: "parent-room", messageId: "27", limit: 50 });
    expect(mountedRoomHistoryRefreshRequest(
      "other-room",
      [text("99", "unrelated row")],
      { roomId: "child-room", messageId: 27, revision: 0 },
    )).toBeNull();
    expect(mountedRoomHistoryPrioritySelection(
      "parent-room",
      [{ ...text("27", "mounted child row"), metadata: {
        custom: { editRevision: 3, historyUnavailable: true },
      } }],
      { roomId: "child-room", messageId: 27, revision: 3 },
    )).toEqual({ roomId: "parent-room", messageId: 27, revision: 3 });
    expect(mountedRoomHistoryPrioritySelection(
      "parent-room",
      [text("28", "different mounted row")],
      { roomId: "child-room", messageId: 27, revision: 3 },
    )).toBeNull();
  });
  test("mounted Fallback content retains visible urgency while stale revisions are rejected", () => {
    const ordinary = { ...text("27", "ordinary Fallback content"), metadata: {
      custom: { editRevision: 3 },
    } };
    expect(mountedRoomHistoryPrioritySelection(
      "parent-room", [ordinary], { roomId: "child-room", messageId: 27, revision: 3 },
    )).toEqual({ roomId: "parent-room", messageId: 27, revision: 3 });
    expect(mountedRoomHistoryPrioritySelection(
      "parent-room", [ordinary], { roomId: "child-room", messageId: 27, revision: 2 },
    )).toBeNull();
  });
  test("hands a completed Fallback row to one different mounted adapter hint", () => {
    const refreshed = { ...text("27", "opened Fallback content"), metadata: {
      custom: { editRevision: 3 },
    } };
    const next = { ...text("28", "ordinary Fallback content"), metadata: {
      custom: { editRevision: 4 },
    } };

    expect(nextMountedHistoryPrioritySelection(
      "parent-room",
      [refreshed, next],
      { roomId: "child-room", messageId: 27, revision: 3 },
      { roomId: "child-room", messageId: 28, revision: 4 },
    )).toEqual({ roomId: "parent-room", messageId: 28, revision: 4 });
    expect(nextMountedHistoryPrioritySelection(
      "parent-room",
      [refreshed, next],
      { roomId: "parent-room", messageId: 28, revision: 4 },
      { roomId: "child-room", messageId: 28, revision: 4 },
    )).toBeNull();
  });

  test("rejects completed, stale and offscreen adapter hints before Strict continuation", () => {
    const refreshed = { ...text("27", "opened"), metadata: {
      custom: { editRevision: 3 },
    } };
    const strict = { ...text("28", "unavailable"), metadata: {
      custom: { editRevision: 4, historyUnavailable: true },
    } };
    const mounted = [refreshed, strict];
    const completed = { roomId: "child-room", messageId: 27, revision: 3 };

    for (const hint of [
      completed,
      { roomId: "child-room", messageId: 28, revision: 2 },
      { roomId: "child-room", messageId: 29, revision: 0 },
    ]) {
      expect(nextMountedHistoryPrioritySelection(
        "parent-room",
        mounted,
        completed,
        hint,
      )).toEqual({ roomId: "parent-room", messageId: 28, revision: 4 });
    }
  });
  test("loaded targets make zero HTTP calls", async () => {
    let calls = 0;
    const controller = createRoomHistoryAroundController({
      fetchPage: async () => {
        calls += 1;
        return aroundPage("7");
      },
      getActiveRoomId: () => "room-a",
      isMessageLoaded: (id) => id === "7",
      onPage: () => {},
    });
    controller.setRoomId("room-a");

    expect(await controller.load("7")).toBe(false);
    expect(calls).toBe(0);
  });

  test("coalesces an unloaded target and records an explicit non-continuity range", async () => {
    const pending = deferred<RoomMessagesAroundPage>();
    let calls = 0;
    const pages: RoomMessagesAroundPage[] = [];
    const controller = createRoomHistoryAroundController({
      fetchPage: async () => {
        calls += 1;
        return pending.promise;
      },
      getActiveRoomId: () => "room-a",
      isMessageLoaded: () => false,
      onPage: (page) => pages.push(page),
    });
    controller.setRoomId("room-a");

    const first = controller.load("7");
    const same = controller.load("7");
    expect(first).toBe(same);
    expect(calls).toBe(1);
    pending.resolve(aroundPage("7"));
    expect(await first).toBe(true);
    expect(pages).toHaveLength(1);
    expect(controller.getSnapshot()).toMatchObject({
      loadingMessageId: null,
      ranges: [{
        target: { messageId: "7" },
        messageIds: ["5", "7"],
        includedToolCallCompanion: true,
        hasOlder: true,
        hasNewer: true,
      }],
    });
  });

  test("late Room responses cannot merge after a switch", async () => {
    let activeRoom = "room-a";
    const pending = deferred<RoomMessagesAroundPage>();
    let applied = 0;
    const controller = createRoomHistoryAroundController({
      fetchPage: async () => pending.promise,
      getActiveRoomId: () => activeRoom,
      isMessageLoaded: () => false,
      onPage: () => { applied += 1; },
    });
    controller.setRoomId("room-a");
    const request = controller.load("7");
    activeRoom = "room-b";
    controller.setRoomId("room-b");
    pending.resolve(aroundPage("7"));

    expect(await request).toBe(false);
    expect(applied).toBe(0);
    expect(controller.getSnapshot()).toMatchObject({ roomId: "room-b", ranges: [] });
  });

  test("a missing/deleted target failure clears loading and a retry makes one new request", async () => {
    let calls = 0;
    const first = deferred<RoomMessagesAroundPage>();
    const controller = createRoomHistoryAroundController({
      fetchPage: () => {
        calls += 1;
        return calls === 1 ? first.promise : Promise.resolve(aroundPage("7"));
      },
      getActiveRoomId: () => "room-a",
      isMessageLoaded: () => false,
      onPage: () => {},
    });
    controller.setRoomId("room-a");

    const failed = controller.load("7");
    expect(controller.getSnapshot().loadingMessageId).toBe("7");
    first.reject(new Error("Not found"));
    expect(await failed).toBe(false);
    expect(controller.getSnapshot().loadingMessageId).toBeNull();

    expect(await controller.load("7")).toBe(true);
    expect(calls).toBe(2);
    expect(controller.getSnapshot().loadingMessageId).toBeNull();
  });

  test("merges chronological around rows by id without replacing live, optimistic, or tail objects", () => {
    const live = text("7", "live stream object");
    const optimistic = text("optimistic-1", "optimistic");
    const tail = text("99", "latest tail");
    const invocation = text("5", "assistant tool invocation");
    const result = mergeRoomMessagesAround(
      [live, optimistic, tail],
      [invocation, text("7", "stale snapshot tool result")],
    );

    expect(result.map((message) => String(message.id))).toEqual(["5", "7", "optimistic-1", "99"]);
    expect(result[1]).toBe(live);
    expect(result[2]).toBe(optimistic);
    expect(result[3]).toBe(tail);
  });

  test("keeps a live row that arrives while the around request is pending", async () => {
    const pending = deferred<RoomMessagesAroundPage>();
    const live = text("7", "live stream object");
    const tail = text("99", "latest tail");
    let mounted: ThreadMessageLike[] = [];
    const controller = createRoomHistoryAroundController({
      fetchPage: async () => pending.promise,
      getActiveRoomId: () => "room-a",
      isMessageLoaded: (id) => mounted.some((message) => String(message.id) === id),
      onPage: (page) => {
        const restored = restoreSessionMessages(page.messages);
        mounted = mergeRoomMessagesAround(mounted, restored);
      },
    });
    controller.setRoomId("room-a");

    const request = controller.load("7");
    mounted = [live, tail];
    pending.resolve(aroundPage("7"));
    expect(await request).toBe(true);
    expect(mounted.map((message) => String(message.id))).toEqual(["5", "7", "99"]);
    expect(mounted[1]).toBe(live);
    expect(mounted[2]).toBe(tail);
  });

  test("retains a supplied assistant tool-call companion while restoring the target ToolCard", () => {
    const restored = restoreSessionMessages(aroundPage("7").messages);
    expect(restored).toHaveLength(2);
    expect(restored[0]).toMatchObject({ id: "5" });
    expect(restored[1]).toMatchObject({
      id: "7",
      content: [{
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "lookup",
        args: { query: "launch" },
        result: "result",
      }],
    });
  });

  test("refreshes one repaired row without dropping loaded history or the live tail", () => {
    const older = text("1", "loaded older row");
    const mountedNeighbor = text("5", "encrypted neighboring row");
    const target = text("7", "encrypted history unavailable");
    const draft = text("optimistic-1", "draft");
    const tail = text("99", "live tail");
    const refreshed = text("7", "opened payload");
    const refreshedNeighbor = text("5", "opened neighboring payload");

    const result = replaceRefreshedRoomMessage(
      [older, mountedNeighbor, target, draft, tail],
      [text("4", "offscreen neighbor"), refreshedNeighbor, refreshed],
      "7",
    );

    expect(result).toEqual([older, mountedNeighbor, refreshed, draft, tail]);
    expect(result[0]).toBe(older);
    expect(result[1]).toBe(mountedNeighbor);
    expect(result[3]).toBe(draft);
    expect(result[4]).toBe(tail);
    expect(result.some((message) => String(message.id) === "4")).toBe(false);
  });

  test("rejects a late exact-row refresh after the mounted target changes", async () => {
    const selection = { roomId: "room-a", messageId: 7, revision: 2 };
    const pending = deferred<void>();
    const initialTarget: ThreadMessageLike = {
      ...text("7", "encrypted history unavailable"),
      metadata: { custom: { editRevision: 2, historyUnavailable: true } },
    };
    let mounted = [initialTarget];
    const expectedTarget = mountedRoomHistoryRefreshTarget(mounted, selection);
    expect(expectedTarget?.projection).toBe(initialTarget);

    const mayCommit = (async () => {
      await pending.promise;
      return expectedTarget !== null
        ? mountedRoomHistoryRefreshTargetState(mounted, selection, expectedTarget)
        : "ignored";
    })();
    mounted = [{
      ...text("7", "same revision with a newer live projection"),
      metadata: { custom: { editRevision: 2 } },
    }];
    pending.resolve();

    expect(await mayCommit).toBe("ignored");
    expect(mountedRoomHistoryRefreshRequest("room-a", mounted, selection)).not.toBeNull();
    mounted = [{
      ...text("7", "newer edit"),
      metadata: { custom: { editRevision: 3 } },
    }];
    expect(mountedRoomHistoryRefreshRequest("room-a", mounted, selection)).toBeNull();
  });

  test("retries a late reread when the exact replacement projection is still unavailable", () => {
    const selection = { roomId: "room-a", messageId: 7, revision: 2 };
    const initialTarget: ThreadMessageLike = {
      ...text("7", "encrypted history unavailable"),
      metadata: { custom: { editRevision: 2, historyUnavailable: true } },
    };
    const expectedTarget = mountedRoomHistoryRefreshTarget([initialTarget], selection);
    const replacement: ThreadMessageLike = {
      ...initialTarget,
      metadata: { custom: { editRevision: 2, historyUnavailable: true, reaction: "new" } },
    };

    expect(expectedTarget).not.toBeNull();
    expect(mountedRoomHistoryRefreshTargetState(
      [replacement],
      selection,
      expectedTarget!,
    )).toBe("retry");
  });

  test("continues through mounted older pages and ignores an unavailable offscreen neighbor", () => {
    const unavailable = (id: string, revision: number): ThreadMessageLike => ({
      id,
      role: "assistant",
      content: [{ type: "text", text: "Encrypted history is unavailable on this device." }],
      metadata: { custom: { editRevision: revision, historyUnavailable: true } },
    });
    const mounted = Array.from({ length: 100 }, (_, index) => unavailable(String(index + 1), index));
    const refreshedAround = [
      unavailable("101", 100),
      ...Array.from({ length: 50 }, (_, index) => text(String(index + 1), `opened ${index + 1}`)),
    ];

    const merged = replaceRefreshedRoomMessage(mounted, refreshedAround, "25");

    expect(merged).toHaveLength(100);
    expect(merged.some((message) => String(message.id) === "101")).toBe(false);
    expect(nextMountedUnavailableHistorySelection("room-a", merged, "25")).toEqual({
      roomId: "room-a",
      messageId: 1,
      revision: 0,
    });
  });

  test("does not continue when the target stayed unavailable", () => {
    const unavailable: ThreadMessageLike = {
      id: "7",
      role: "assistant",
      content: [{ type: "text", text: "Encrypted history is unavailable on this device." }],
      metadata: { custom: { historyUnavailable: true } },
    };
    expect(nextMountedUnavailableHistorySelection("room-a", [unavailable], "7")).toBeNull();
  });

  test("removes an opened empty assistant projection and continues with the next mounted row", () => {
    const target: ThreadMessageLike = {
      id: "7",
      role: "assistant",
      content: [{ type: "text", text: "Encrypted history is unavailable on this device." }],
      metadata: { custom: { editRevision: 0, historyUnavailable: true } },
    };
    const next: ThreadMessageLike = {
      id: "8",
      role: "system",
      content: [{ type: "text", text: "Encrypted history is unavailable on this device." }],
      metadata: { custom: { editRevision: 2, historyUnavailable: true } },
    };
    const draft = text("optimistic-1", "draft");

    const merged = replaceRefreshedRoomMessage(
      [target, next, draft],
      [],
      "7",
      { removeUnavailableTargetWhenAbsent: true },
    );

    expect(merged).toEqual([next, draft]);
    expect(merged[1]).toBe(draft);
    expect(nextMountedUnavailableHistorySelection(
      "room-a",
      merged,
      "7",
      { refreshedTargetRemoved: true },
    )).toEqual({ roomId: "room-a", messageId: 8, revision: 2 });
    expect(replaceRefreshedRoomMessage(
      [target, draft],
      [],
      "7",
    )).toEqual([target, draft]);
  });

  test("literal user text is not treated as unavailable history", () => {
    const literal = text("9", "Encrypted history is unavailable on this device.");
    expect(nextMountedUnavailableHistorySelection(
      "room-a",
      [text("7", "opened"), literal],
      "7",
    )).toBeNull();
  });

  test("restoration carries typed unavailable markers for Tool and system rows", () => {
    const restored = restoreSessionMessages([
      {
        id: "6",
        role: "assistant",
        content: "invocation",
        toolCalls: '[{"id":"call-1","name":"lookup","args":{}}]',
      },
      {
        id: "7",
        role: "tool",
        content: "Encrypted history is unavailable on this device.",
        toolName: "lookup",
        editRevision: 3,
        historyUnavailable: true,
      },
      {
        id: "8",
        role: "system",
        content: "Encrypted history is unavailable on this device.",
        editRevision: 4,
        historyUnavailable: true,
      },
    ]);

    expect(restored[1]?.metadata?.custom).toMatchObject({
      editRevision: 3,
      historyUnavailable: true,
    });
    expect(restored[2]?.metadata?.custom).toMatchObject({
      editRevision: 4,
      historyUnavailable: true,
    });
    expect(nextMountedUnavailableHistorySelection("room-a", restored, "6")).toEqual({
      roomId: "room-a",
      messageId: 7,
      revision: 3,
    });
  });

  test("dispose invalidates a late completion before it can merge", async () => {
    const pending = deferred<RoomMessagesAroundPage>();
    let applied = 0;
    const controller = createRoomHistoryAroundController({
      fetchPage: async () => pending.promise,
      getActiveRoomId: () => "room-a",
      isMessageLoaded: () => false,
      onPage: () => { applied += 1; },
    });
    controller.setRoomId("room-a");
    const request = controller.load("7");
    controller.dispose();
    pending.resolve(aroundPage("7"));

    expect(await request).toBe(false);
    expect(applied).toBe(0);
  });
});
