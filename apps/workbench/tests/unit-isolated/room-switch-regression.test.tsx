import "../bun-dom-preload";

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, useImperativeHandle, useState, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type RoomDetail = {
  members: Array<{ actorId: string; kind: "user" | "agent"; displayName: string }>;
};

const getRoomCalls: string[] = [];
const roomDetails: Record<string, RoomDetail> = {
  a: { members: [{ actorId: "actor-a", kind: "user", displayName: "Alice" }] },
  b: { members: [{ actorId: "actor-b", kind: "agent", displayName: "Genie" }] },
};

mock.module("../../src/lib/api", () => ({
  apiClient: {
    getRoom: async (roomId: string): Promise<RoomDetail> => {
      getRoomCalls.push(roomId);
      await Promise.resolve();
      return roomDetails[roomId] ?? { members: [] };
    },
  },
}));

const { useRoomMembers, resetRoomMembersCacheForTests } = await import(
  "../../src/modes/rooms/shape/use-room-members"
);
const {
  isConversationInitialHistoryBusy,
  selectCurrentConversationInitialHistoryState,
  shouldRenderConversationEmptyState,
} = await import("../../src/components/conversation");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "customElements",
    "MutationObserver",
    "localStorage",
    "sessionStorage",
    "location",
    "__NAUTILO_HAPPY_DOM_WINDOW__",
  ]) {
    Reflect.deleteProperty(globalThis, key);
  }
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

type HarnessApi = { setRoomId: (roomId: string) => void };

function Harness({ ref }: { ref: Ref<HarnessApi> }) {
  const [roomId, setRoomId] = useState("a");
  useImperativeHandle(ref, () => ({ setRoomId }), []);
  const { members, loading } = useRoomMembers(roomId);
  return (
    <div>
      <span data-testid="room-id">{roomId}</span>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="members">{members.map((m) => m.displayName).join(",")}</span>
    </div>
  );
}

function text(host: HTMLElement, testId: string): string {
  return host.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("room switching regression", () => {
  let root: Root | null = null;
  let host: HTMLElement;
  let api: HarnessApi | null = null;

  beforeEach(() => {
    resetRoomMembersCacheForTests();
    getRoomCalls.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    host.remove();
    api = null;
  });

  test("returning to a seen room does not enter loading/skeleton state", async () => {
    await act(async () => {
      root?.render(<Harness ref={(value) => (api = value)} />);
    });
    await flush();
    expect(text(host, "room-id")).toBe("a");
    expect(text(host, "loading")).toBe("false");
    expect(text(host, "members")).toBe("Alice");

    await act(async () => {
      api?.setRoomId("b");
    });
    await flush();
    expect(text(host, "room-id")).toBe("b");
    expect(text(host, "loading")).toBe("false");
    expect(text(host, "members")).toBe("Genie");

    await act(async () => {
      api?.setRoomId("a");
    });

    // Load-bearing assertion: pre-fix, switching back sets loading=true and
    // clears members while /api/rooms/:id refetches, which makes ActiveRoom
    // render RoomShapeSkeleton and remount the composer (audible mic beep).
    expect(text(host, "room-id")).toBe("a");
    expect(text(host, "loading")).toBe("false");
    expect(text(host, "members")).toBe("Alice");
    expect(getRoomCalls).toEqual(["a", "b", "a"]);
  });

  test("room composer does not warm microphone on mount", () => {
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
    const legacyComposer = readFileSync(`${repoRoot}src/components/conversation.tsx`, "utf8");

    // Load-bearing assertion: a mount-time `speech.warmUp()` calls
    // getUserMedia({audio:true}) when mic permission is already granted.
    // Room switches remount room chrome in some paths, producing a macOS mic
    // activation beep. Mic access must stay behind explicit mic gestures.
    expect(legacyComposer).not.toContain("speech.warmUp()");
  });

  test("room selection installs a cache-first transcript projection before history fetches", () => {
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
    const runtimeSource = readFileSync(`${repoRoot}src/adapters/nautilo-runtime.tsx`, "utf8");
    const hydrationStart = runtimeSource.indexOf("// select/cache/fence in the layout phase");
    const hydrationEnd = runtimeSource.indexOf("const isCurrent = (): boolean =>", hydrationStart);
    expect(hydrationStart).toBeGreaterThanOrEqual(0);
    expect(hydrationEnd).toBeGreaterThan(hydrationStart);
    const hydrationBlock = runtimeSource.slice(hydrationStart, hydrationEnd);

    expect(hydrationBlock).toContain("useLayoutEffect(() => {");
    expect(hydrationBlock).toContain("readActiveRoom(cacheScope)");
    expect(hydrationBlock).toContain("messagesRef.current = cached ? [...cached.messages] : []");
    expect(hydrationBlock).toContain("setRoomInitialHydrationState(initialState)");
    expect(hydrationBlock).toContain("flush();");
    expect(hydrationBlock.indexOf("readActiveRoom(cacheScope)")).toBeLessThan(
      hydrationBlock.indexOf("messagesRef.current = cached ? [...cached.messages] : []"),
    );
    expect(hydrationBlock).not.toContain("if (roomChanged) {");
  });

  test("authenticated Room empty chrome waits for an exact authoritative empty state", () => {
    const scope = {
      origin: "https://server.example",
      viewerKey: "viewer-a",
      viewerGeneration: 4,
      roomId: "room-a",
      generation: 9,
    } as const;
    const authenticatedRoom = {
      isAuthenticatedRoom: true,
      currentScope: scope,
    } as const;

    expect(shouldRenderConversationEmptyState({
      ...authenticatedRoom,
      initialHistoryState: { kind: "empty", scope },
    })).toBe(true);

    for (const initialHistoryState of [
      null,
      { kind: "unresolved", scope },
      { kind: "syncing", scope },
      { kind: "ready", scope },
      { kind: "recoverable-error", scope, retainsCachedFrame: false },
      { kind: "access-terminal-error", scope, reason: "unauthorized" },
      { kind: "empty", scope: { ...scope, roomId: "room-b" } },
      { kind: "empty", scope: { ...scope, origin: "https://other.example" } },
      { kind: "empty", scope: { ...scope, viewerKey: "viewer-b" } },
      { kind: "empty", scope: { ...scope, viewerGeneration: 5 } },
    ] as const) {
      expect(shouldRenderConversationEmptyState({
        ...authenticatedRoom,
        initialHistoryState,
      })).toBe(false);
    }

    expect(shouldRenderConversationEmptyState({
      isAuthenticatedRoom: false,
      currentScope: null,
      initialHistoryState: null,
    })).toBe(true);
  });

  test("only unresolved authenticated Room history marks the transcript busy", () => {
    const scope = {
      origin: "https://server.example",
      viewerKey: "viewer-a",
      viewerGeneration: 4,
      roomId: "room-a",
      generation: 9,
    } as const;
    const authenticatedRoom = {
      isAuthenticatedRoom: true,
      currentScope: scope,
    } as const;

    for (const initialHistoryState of [
      null,
      { kind: "unresolved", scope },
      { kind: "syncing", scope },
      { kind: "ready", scope: { ...scope, roomId: "room-b" } },
      { kind: "ready", scope: { ...scope, origin: "https://other.example" } },
      { kind: "ready", scope: { ...scope, viewerGeneration: 5 } },
    ] as const) {
      expect(isConversationInitialHistoryBusy({
        ...authenticatedRoom,
        initialHistoryState,
      })).toBe(true);
    }

    for (const initialHistoryState of [
      { kind: "ready", scope },
      { kind: "empty", scope },
      { kind: "recoverable-error", scope, retainsCachedFrame: false },
      { kind: "access-terminal-error", scope, reason: "not-found" },
    ] as const) {
      expect(isConversationInitialHistoryBusy({
        ...authenticatedRoom,
        initialHistoryState,
      })).toBe(false);
    }
  });

  test("the presentation surface receives null for any stale initial-history scope", () => {
    const scope = {
      origin: "https://server.example",
      viewerKey: "viewer-a",
      viewerGeneration: 4,
      roomId: "room-a",
      generation: 9,
    } as const;
    const ready = { kind: "ready", scope } as const;

    expect(selectCurrentConversationInitialHistoryState({
      currentScope: scope,
      initialHistoryState: ready,
    })).toBe(ready);

    for (const currentScope of [
      { ...scope, origin: "https://other.example" },
      { ...scope, viewerKey: "viewer-b" },
      { ...scope, viewerGeneration: 5 },
      { ...scope, roomId: "room-b" },
      null,
    ] as const) {
      expect(selectCurrentConversationInitialHistoryState({
        currentScope,
        initialHistoryState: ready,
      })).toBeNull();
    }
  });

  test("conversation wires one initial-history surface inside the relative transcript owner", () => {
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
    const conversationSource = readFileSync(`${repoRoot}src/components/conversation.tsx`, "utf8");

    expect(conversationSource).toContain('className="relative flex min-h-0 flex-1 flex-col"');
    expect(conversationSource).toContain("<RoomInitialHistorySurface");
    expect(conversationSource).toContain('aria-busy={initialHistoryBusy ? "true" : undefined}');
    expect(conversationSource).toContain("state={surfaceInitialHistoryState}");
  });
});
