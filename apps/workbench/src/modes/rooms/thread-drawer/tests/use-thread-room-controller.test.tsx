import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiError } from "@nautilo/api-client/browser";
import { reapplyHappyDomGlobals } from "../../../../../tests/bun-dom-preload";
import type { ThreadDetailResponse } from "@nautilo/types";
import {
  useThreadRoomController,
  type ThreadRoomApi,
} from "../use-thread-room-controller";
import {
  ThreadRoomEventRouterContext,
  type ThreadRoomRegistration,
} from "../../../../adapters/runtime-contexts";
import { setCurrentFolder, setWorkspacePath } from "../../../../adapters/file-context-ref";

const detail: ThreadDetailResponse = {
  parentRoomId: "parent-a",
  subthreadRoomId: "child-a",
  anchor: { id: "42", role: "user", content: "root", createdAt: "2026-01-01T00:00:00.000Z" },
  summary: { replyCount: 0, lastReplyAt: null, summaryRevision: 0 },
};

function createApi(): ThreadRoomApi & Record<string, ReturnType<typeof mock>> {
  return {
    getThreadDetail: mock(async () => detail),
    getRoom: mock(async () => ({
      id: "child-a",
      label: "Thread",
      type: "group",
      graphThreadId: "graph-child-a",
      createdAt: "2026-01-01T00:00:00.000Z",
      kind: "subthread" as const,
      parentRoomId: "parent-a",
      threadRootMessageId: 42,
      conductorMode: "standard" as const,
      members: [],
    })),
    readRoomMessages: mock(async () => ({ messages: [] })),
    readRoomMessagesAround: mock(async () => ({
      target: { messageId: "42", createdAt: "2026-01-01T00:00:00.000Z" },
      messages: [detail.anchor],
      includedToolCallCompanion: false,
      hasOlder: false,
      hasNewer: false,
    })),
    getRoomActiveJobs: mock(async () => ({ jobIds: ["job-a"] })),
    sendRoomMessage: mock(async () => ({ messageId: 99, jobId: "job-a" })),
    stopRoom: mock(async () => ({ stopped: true })),
    markRoomRead: mock(async () => ({ marked: 0 })),
  };
}

const threadCoordinates = {
  parentRoomId: "parent-a",
  anchorMessageId: 42,
} as const;

describe("useThreadRoomController", () => {
  beforeEach(() => {
    reapplyHappyDomGlobals();
    setCurrentFolder(null);
    setWorkspacePath(null);
  });

  test("hydrates canonical child state without marking it read until the surface asks", async () => {
    const api = createApi();
    const { result } = renderHook(() => useThreadRoomController({
      roomId: "child-a", ...threadCoordinates, visible: true, connected: true, api,
    }));

    await waitFor(() => expect(result.current.state.phase).toBe("ready"));
    expect(api.getThreadDetail).toHaveBeenCalledWith("child-a");
    expect(api.getRoom).not.toHaveBeenCalled();
    expect(api.readRoomMessagesAround).not.toHaveBeenCalled();
    expect(api.readRoomMessages).toHaveBeenCalledWith("child-a");
    expect(api.markRoomRead).not.toHaveBeenCalled();
    await act(async () => {
      expect(await result.current.markRead()).toBe(true);
    });
    expect(api.markRoomRead).toHaveBeenCalledWith("child-a");
  });

  test("hydrates a protected anchor through the shared around-message operation", async () => {
    const api = createApi();
    api.getThreadDetail.mockRejectedValueOnce(new ApiError(
      409,
      "Protected Subthread anchor hydration is not supported",
    ));
    api.readRoomMessagesAround.mockResolvedValueOnce({
      target: { messageId: "42", createdAt: "2026-01-01T00:00:00.000Z" },
      messages: [{
        ...detail.anchor,
        content: "protected root",
        replyCount: 3,
        lastReplyAt: "2026-01-01T00:03:00.000Z",
        summaryRevision: 7,
      }],
      includedToolCallCompanion: false,
      hasOlder: true,
      hasNewer: true,
    });
    const { result } = renderHook(() => useThreadRoomController({
      roomId: "child-a", ...threadCoordinates, visible: true, connected: true, api,
    }));

    await waitFor(() => expect(result.current.state.phase).toBe("ready"));
    expect(api.getRoom).toHaveBeenCalledWith("child-a");
    expect(api.readRoomMessagesAround).toHaveBeenCalledWith({
      roomId: "parent-a",
      messageId: "42",
    });
    expect(result.current.state.anchor).toMatchObject({
      id: "42",
      content: "protected root",
      replyCount: 3,
      summaryRevision: 7,
    });
    expect(result.current.state.detail?.summary).toEqual({
      replyCount: 3,
      lastReplyAt: "2026-01-01T00:03:00.000Z",
      summaryRevision: 7,
    });
  });

  test("fails closed when protected child coordinates do not match the open drawer", async () => {
    const api = createApi();
    api.getThreadDetail.mockRejectedValueOnce(new ApiError(
      409,
      "Protected Subthread anchor hydration is not supported",
    ));
    api.getRoom.mockResolvedValueOnce({
      ...(await api.getRoom("child-a")),
      parentRoomId: "different-parent",
    });
    api.getRoom.mockClear();
    const { result } = renderHook(() => useThreadRoomController({
      roomId: "child-a", ...threadCoordinates, visible: true, connected: true, api,
    }));

    await waitFor(() => expect(result.current.state.phase).toBe("error"));
    expect(result.current.state.error).toBe(
      "Protected thread coordinates do not match the requested conversation.",
    );
    expect(api.readRoomMessagesAround).not.toHaveBeenCalled();
  });

  test("fails closed when protected history omits or duplicates the exact anchor", async () => {
    for (const messages of [[], [detail.anchor, detail.anchor]]) {
      const api = createApi();
      api.getThreadDetail.mockRejectedValueOnce(new ApiError(
        409,
        "Protected Subthread anchor hydration is not supported",
      ));
      api.readRoomMessagesAround.mockResolvedValueOnce({
        target: { messageId: "42", createdAt: "2026-01-01T00:00:00.000Z" },
        messages,
        includedToolCallCompanion: false,
        hasOlder: false,
        hasNewer: false,
      });
      const { result, unmount } = renderHook(() => useThreadRoomController({
        roomId: "child-a", ...threadCoordinates, visible: true, connected: true, api,
      }));

      await waitFor(() => expect(result.current.state.phase).toBe("error"));
      expect(result.current.state.error).toBe("Protected thread anchor is unavailable.");
      unmount();
    }
  });

  test("fails closed when protected reconciliation withholds the exact anchor", async () => {
    const api = createApi();
    api.getThreadDetail.mockRejectedValueOnce(new ApiError(
      409,
      "Protected Subthread anchor hydration is not supported",
    ));
    api.readRoomMessagesAround.mockResolvedValueOnce({
      target: { messageId: "42", createdAt: "2026-01-01T00:00:00.000Z" },
      messages: [{
        ...detail.anchor,
        content: "Encrypted history is unavailable on this device.",
        historyUnavailable: true,
      }],
      includedToolCallCompanion: false,
      hasOlder: false,
      hasNewer: false,
    });
    const { result } = renderHook(() => useThreadRoomController({
      roomId: "child-a", ...threadCoordinates, visible: true, connected: true, api,
    }));

    await waitFor(() => expect(result.current.state.phase).toBe("error"));
    expect(result.current.state.error).toBe("Protected thread anchor is unavailable.");
  });

  test("ignores a protected hydration completion after switching child Rooms", async () => {
    let resolveOldRoom!: (room: Awaited<ReturnType<ThreadRoomApi["getRoom"]>>) => void;
    const oldRoom = new Promise<Awaited<ReturnType<ThreadRoomApi["getRoom"]>>>((resolve) => {
      resolveOldRoom = resolve;
    });
    const api = createApi();
    api.getThreadDetail.mockImplementation(async (roomId: string) => {
      if (roomId === "child-a") throw new ApiError(
        409,
        "Protected Subthread anchor hydration is not supported",
      );
      return {
        parentRoomId: "parent-b",
        subthreadRoomId: "child-b",
        anchor: { id: "84", role: "user", content: "new root", createdAt: "2026-01-02T00:00:00.000Z" },
        summary: { replyCount: 0, lastReplyAt: null, summaryRevision: 0 },
      };
    });
    api.getRoom.mockImplementation(async (roomId: string) => {
      if (roomId === "child-a") return oldRoom;
      throw new Error("unexpected room lookup");
    });
    const { result, rerender } = renderHook(
      ({ roomId, parentRoomId, anchorMessageId }) => useThreadRoomController({
        roomId,
        parentRoomId,
        anchorMessageId,
        visible: true,
        connected: true,
        api,
      }),
      { initialProps: { roomId: "child-a", parentRoomId: "parent-a", anchorMessageId: 42 } },
    );

    rerender({ roomId: "child-b", parentRoomId: "parent-b", anchorMessageId: 84 });
    await waitFor(() => expect(result.current.state.roomId).toBe("child-b"));
    await waitFor(() => expect(result.current.state.phase).toBe("ready"));
    resolveOldRoom({
      id: "child-a",
      label: "Old thread",
      type: "group",
      graphThreadId: "graph-child-a",
      createdAt: "2026-01-01T00:00:00.000Z",
      kind: "subthread",
      parentRoomId: "parent-a",
      threadRootMessageId: 42,
      conductorMode: "standard",
      members: [],
    });
    await act(async () => { await Promise.resolve(); });

    expect(result.current.state.roomId).toBe("child-b");
    expect(result.current.state.anchor?.content).toBe("new root");
  });

  test("reconnect rehydrates and explicit stop targets only the child", async () => {
    const api = createApi();
    const { result, rerender } = renderHook(
      ({ connected }) => useThreadRoomController({ roomId: "child-a", ...threadCoordinates, visible: true, connected, api }),
      { initialProps: { connected: false } },
    );
    expect(api.getThreadDetail).not.toHaveBeenCalled();

    rerender({ connected: true });
    await waitFor(() => expect(result.current.state.phase).toBe("ready"));
    await act(async () => { await result.current.stop(); });
    expect(api.stopRoom).toHaveBeenCalledTimes(1);
    expect(api.stopRoom).toHaveBeenCalledWith("child-a");
  });

  test("null file context is explicit, and a failed send retains its draft without stopping jobs on close", async () => {
    const api = createApi();
    api.sendRoomMessage.mockRejectedValueOnce(new Error("offline"));
    const { result, rerender } = renderHook(
      ({ roomId }) => useThreadRoomController({ roomId, ...threadCoordinates, visible: true, connected: true, api }),
      { initialProps: { roomId: "child-a" as string | null } },
    );
    await waitFor(() => expect(result.current.state.phase).toBe("ready"));
    act(() => result.current.setDraft("retry me"));
    await act(async () => { await result.current.send(); });
    expect(api.sendRoomMessage).toHaveBeenCalledWith("child-a", {
      content: "retry me",
      currentFolder: null,
      currentFolderRelayId: null,
      workspacePath: null,
    });
    expect(result.current.state.draft).toBe("retry me");
    expect(result.current.state.send.status).toBe("error");

    rerender({ roomId: null });
    await waitFor(() => expect(result.current.state.phase).toBe("closed"));
    expect(api.stopRoom).not.toHaveBeenCalled();
  });

  test("snapshots the populated current folder and sender relay immediately before a child send", async () => {
    const api = createApi();
    setCurrentFolder("/Users/casey/Projects/kentauros", "relay-casey");
    setWorkspacePath("/Users/casey/Documents/Nautilo");
    const { result } = renderHook(() => useThreadRoomController({
      roomId: "child-a", ...threadCoordinates, visible: true, connected: true, api,
    }));

    await waitFor(() => expect(result.current.state.phase).toBe("ready"));
    await act(async () => { await result.current.sendText("read the spec"); });

    expect(api.sendRoomMessage).toHaveBeenCalledWith("child-a", {
      content: "read the spec",
      currentFolder: "/Users/casey/Projects/kentauros",
      currentFolderRelayId: "relay-casey",
      workspacePath: "/Users/casey/Documents/Nautilo",
    });
  });

  test("sends a quote reply only to the current child Room and preserves its file context", async () => {
    const api = createApi();
    setCurrentFolder("/Users/casey/Projects/kentauros", "relay-casey");
    setWorkspacePath("/Users/casey/Documents/Nautilo");
    const { result } = renderHook(() => useThreadRoomController({
      roomId: "child-a", ...threadCoordinates, visible: true, connected: true, api,
    }));

    await waitFor(() => expect(result.current.state.phase).toBe("ready"));
    await act(async () => {
      await result.current.sendText("quoted child reply", { replyToMessageId: 42 });
    });

    expect(api.sendRoomMessage).toHaveBeenCalledWith("child-a", {
      content: "quoted child reply",
      currentFolder: "/Users/casey/Projects/kentauros",
      currentFolderRelayId: "relay-casey",
      workspacePath: "/Users/casey/Documents/Nautilo",
      replyToMessageId: 42,
    });
    expect(api.sendRoomMessage).not.toHaveBeenCalledWith("parent-a", expect.anything());
  });

  test("forwards room audience intent on a child Room send", async () => {
    const api = createApi();
    const { result } = renderHook(() => useThreadRoomController({
      roomId: "child-a", ...threadCoordinates, visible: true, connected: true, api,
    }));
    await waitFor(() => expect(result.current.state.phase).toBe("ready"));

    await act(async () => {
      await result.current.sendText("Hello @everyone", { mentionEveryone: true });
    });

    expect(api.sendRoomMessage).toHaveBeenCalledWith("child-a", {
      content: "Hello @everyone",
      currentFolder: null,
      currentFolderRelayId: null,
      workspacePath: null,
      mentionEveryone: true,
    });
  });

  test("uses a fresh file-context snapshot for every child send while the drawer stays open", async () => {
    const api = createApi();
    const { result } = renderHook(() => useThreadRoomController({
      roomId: "child-a", ...threadCoordinates, visible: true, connected: true, api,
    }));

    await waitFor(() => expect(result.current.state.phase).toBe("ready"));
    setCurrentFolder("/Users/casey/Projects/first", "relay-first");
    setWorkspacePath("/Users/casey/Documents/Nautilo-first");
    await act(async () => { await result.current.sendText("first"); });
    setCurrentFolder("/Users/casey/Projects/second", "relay-second");
    setWorkspacePath("/Users/casey/Documents/Nautilo-second");
    await act(async () => { await result.current.sendText("second"); });

    expect(api.sendRoomMessage).toHaveBeenNthCalledWith(1, "child-a", {
      content: "first",
      currentFolder: "/Users/casey/Projects/first",
      currentFolderRelayId: "relay-first",
      workspacePath: "/Users/casey/Documents/Nautilo-first",
    });
    expect(api.sendRoomMessage).toHaveBeenNthCalledWith(2, "child-a", {
      content: "second",
      currentFolder: "/Users/casey/Projects/second",
      currentFolderRelayId: "relay-second",
      workspacePath: "/Users/casey/Documents/Nautilo-second",
    });
  });

  test("allows a later explicit child read after inbound child data", async () => {
    const api = createApi();
    const { result } = renderHook(() => useThreadRoomController({ roomId: "child-a", ...threadCoordinates, visible: true, connected: true, api }));
    await waitFor(() => expect(result.current.state.phase).toBe("ready"));
    await act(async () => {
      await result.current.markRead();
    });
    expect(api.markRoomRead).toHaveBeenCalledTimes(1);
    act(() => result.current.ingestEvent({
      type: "message.new", laneKey: "room:child-a", messageId: "100", role: "ai", content: "new child reply",
    }));
    expect(api.markRoomRead).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.markRead();
    });
    expect(api.markRoomRead).toHaveBeenCalledTimes(2);
    expect(api.markRoomRead).toHaveBeenLastCalledWith("child-a");
  });

  test("refuses an explicit read while hidden and permits it once visible", async () => {
    const api = createApi();
    const { result, rerender } = renderHook(
      ({ visible }) => useThreadRoomController({ roomId: "child-a", ...threadCoordinates, visible, connected: true, api }),
      { initialProps: { visible: false } },
    );
    await waitFor(() => expect(result.current.state.phase).toBe("ready"));
    expect(api.markRoomRead).not.toHaveBeenCalled();
    act(() => result.current.ingestEvent({
      type: "message.new", laneKey: "room:child-a", messageId: "101", role: "ai", content: "hidden child reply",
    }));
    expect(api.markRoomRead).not.toHaveBeenCalled();
    await act(async () => {
      expect(await result.current.markRead()).toBe(false);
    });
    rerender({ visible: true });
    await act(async () => {
      expect(await result.current.markRead()).toBe(true);
    });
    expect(api.markRoomRead).toHaveBeenCalledWith("child-a");
  });

  test("registers one child ingest handler with the provider and unregisters on close", async () => {
    const api = createApi();
    let registration: ThreadRoomRegistration | null = null;
    const wrapper = ({ children }: PropsWithChildren) => (
      <ThreadRoomEventRouterContext.Provider value={{
        registerThreadRoom: (next) => {
          registration = next;
          return () => {
            if (registration === next) registration = null;
          };
        },
      }}>
        {children}
      </ThreadRoomEventRouterContext.Provider>
    );
    const { result, unmount } = renderHook(
      () => useThreadRoomController({ roomId: "child-a", ...threadCoordinates, visible: true, connected: true, api }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.state.phase).toBe("ready"));
    expect(registration?.roomId).toBe("child-a");
    act(() => registration?.ingestEvent(
      { type: "message.new", laneKey: "room:child-a", messageId: "99", role: "user", content: "live" },
      (laneKey) => laneKey === "room:child-a" ? "child-a" : null,
    ));
    expect(result.current.state.messages).toEqual([
      expect.objectContaining({ id: "99", content: "live" }),
    ]);

    unmount();
    expect(registration).toBeNull();
  });
});
