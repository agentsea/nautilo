import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import type { ArtifactDto } from "@nautilo/api-client/browser";
import type { EventFeedListOptions, EventFeedPage, EventFeedPreference, RoomDetailResponse } from "@nautilo/types";
import { reapplyHappyDomGlobals } from "../../tests/bun-dom-preload";

const ROOM_ID = "22222222-2222-4222-8222-222222222222";
const ARTIFACT_ID = "77777777-7777-4777-8777-777777777777";
let viewerUserId = "33333333-3333-4333-8333-333333333333";
let viewerActorId = "44444444-4444-4444-8444-444444444444";
let viewerGeneration = 1;
let credentialGeneration = 1;

function event(id: string, readAt: string | null = null) {
  return {
    id,
    type: "room.member_joined" as const,
    actorKind: "human" as const,
    actorId: viewerActorId,
    data: { roomId: ROOM_ID, userId: viewerUserId },
    createdAt: "2026-09-09T09:00:00.000Z",
    readAt,
  };
}

function artifactEvent(id: string, artifactId = ARTIFACT_ID) {
  return {
    id,
    type: "artifact.shared" as const,
    actorKind: "human" as const,
    actorId: viewerActorId,
    actorDisplayName: "Mara",
    data: { artifactId, destination: { kind: "person" as const, userId: viewerUserId } },
    createdAt: "2026-09-09T09:00:00.000Z",
    readAt: null,
  };
}

function artifact(id: string, path: string): ArtifactDto {
  return {
    id,
    artifactId: `public/${id}`,
    path,
    mimeType: "text/markdown",
    size: 42,
    revision: 1,
    updatedAt: "2026-09-09T09:00:00.000Z",
    createdAt: "2026-09-09T09:00:00.000Z",
    namespaceIds: [],
    canWrite: false,
  };
}

let listEventFeed: (options: EventFeedListOptions) => Promise<EventFeedPage>;
let getEventFeedUnreadCount: () => Promise<{ unreadCount: number }>;
let preference: EventFeedPreference;
let getEventFeedPreference: () => Promise<EventFeedPreference>;
let setEventFeedPreference: (value: EventFeedPreference) => Promise<EventFeedPreference>;
let wsState = "open";
let setEventFeedReadState: (eventId: string, read: boolean) => Promise<{
  eventId: string;
  readAt: string | null;
  changed: boolean;
}>;
let markAllEventFeedRead: () => Promise<{ updatedCount: number }>;
let getRoom: (roomId: string) => Promise<RoomDetailResponse>;
let getWorkspaceArtifact: (artifactId: string) => Promise<ArtifactDto | null>;

mock.module("../lib/api", () => ({
  apiClient: {
    listEventFeed: (options: EventFeedListOptions) => listEventFeed(options),
    getEventFeedUnreadCount: () => getEventFeedUnreadCount(),
    getEventFeedPreference: () => getEventFeedPreference(),
    setEventFeedPreference: (value: EventFeedPreference) => setEventFeedPreference(value),
    setEventFeedReadState: (eventId: string, read: boolean) => setEventFeedReadState(eventId, read),
    markAllEventFeedRead: () => markAllEventFeedRead(),
    listDirectoryHumans: async () => [],
    getRoom: (roomId: string) => getRoom(roomId),
    getWorkspaceArtifact: (artifactId: string) => getWorkspaceArtifact(artifactId),
  },
}));

mock.module("../hooks/use-auth", () => ({
  useAuth: () => ({
    viewerGeneration,
    credentialGeneration,
    viewer: { sessionUserId: viewerUserId, sessionActorId: viewerActorId },
  }),
}));

mock.module("../adapters/runtime-contexts", () => ({
  useWsStateContext: () => ({ state: wsState, lastOpenAt: Date.now() }),
}));

const { EventFeedProvider, useEventFeed } = await import("./event-feed-context");
const { EventFeedPanel } = await import("./EventFeedPanel");
const { EventFeedQuietControl } = await import("./EventFeedQuietControl");
const { EventFeedBell } = await import("../layouts/event-feed-bell");
const { publishEventFeedChanged } = await import("./event-feed-change-bus");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  viewerUserId = "33333333-3333-4333-8333-333333333333";
  viewerActorId = "44444444-4444-4444-8444-444444444444";
  viewerGeneration = 1;
  credentialGeneration = 1;
  listEventFeed = async () => ({ events: [event("event-1")], nextCursor: null });
  getEventFeedUnreadCount = async () => ({ unreadCount: 1 });
  preference = { mode: "active" };
  wsState = "open";
  getEventFeedPreference = async () => preference;
  setEventFeedPreference = async (value) => { preference = value; return value; };
  setEventFeedReadState = async (eventId, read) => ({
    eventId,
    readAt: read ? "2026-09-09T10:00:00.000Z" : null,
    changed: true,
  });
  markAllEventFeedRead = async () => ({ updatedCount: 0 });
  getRoom = async () => { throw new Error("unavailable"); };
  getWorkspaceArtifact = async () => null;
});

afterEach(() => cleanup());

describe("EventFeedProvider", () => {
  test("custom time stays open on invalid input, saves an absolute deadline, and returns focus", async () => {
    const writes = mock(async (value: EventFeedPreference) => { preference = value; return value; });
    setEventFeedPreference = writes;
    const view = render(<EventFeedProvider><EventFeedQuietControl /></EventFeedProvider>);
    fireEvent.click(view.getByRole("button", { name: "Quiet events" }));
    const choose = await waitFor(() => {
      const button = view.getByRole("button", { name: "Choose a time…" }) as HTMLButtonElement;
      expect(button.disabled).toBe(false); return button;
    });
    fireEvent.click(choose);
    const input = view.getByLabelText("Resume Events");
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "2000-01-01T12:00" } });
    fireEvent.submit(input.closest("form")!);
    expect(view.getByRole("alert").textContent).toContain("future");
    expect(writes).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "2099-01-01T12:00" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(writes).toHaveBeenCalledWith({ mode: "snoozed", until: new Date("2099-01-01T12:00").toISOString() });
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Quiet" }));
  });

  test("Escape dismisses the menu without closing its enclosing Events drawer", async () => {
    const closeDrawer = mock(() => {});
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) closeDrawer(); };
    window.addEventListener("keydown", listener);
    try {
      const view = render(<EventFeedProvider><EventFeedQuietControl /></EventFeedProvider>);
      fireEvent.click(view.getByRole("button", { name: "Quiet events" }));
      const dialog = view.getByRole("dialog");
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(view.queryByRole("dialog")).toBeNull();
      expect(closeDrawer).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(view.getByRole("button", { name: "Quiet events" }));
      fireEvent.click(view.getByRole("button", { name: "Quiet events" }));
      fireEvent.pointerDown(document.body);
      expect(view.queryByRole("dialog")).toBeNull();
    } finally { window.removeEventListener("keydown", listener); }
  });

  test("quiet removes the numbered badge, switches to a crossed-out bell, keeps unread history, and resumes", async () => {
    function Controls() {
      const feed = useEventFeed();
      return <>
        <EventFeedBell buttonRef={{ current: null }} open onClick={() => {}}
          unreadCount={feed.quietPreference === null ? null : feed.unreadCount} quiet={feed.quiet} />
        <EventFeedQuietControl />
        <EventFeedPanel onOpenRoom={() => {}} onOpenArtifact={() => {}} />
      </>;
    }
    const view = render(<EventFeedProvider><Controls /></EventFeedProvider>);
    await waitFor(() => expect(view.getByRole("button", { name: "Events, 1 unread event" }).textContent).toBe("1"));
    fireEvent.click(view.getByRole("button", { name: "Quiet events" }));
    fireEvent.click(view.getByRole("button", { name: "Until I turn it back on" }));
    const bell = await waitFor(() => view.getByRole("button", { name: "Events, quiet" }));
    expect(bell.querySelector("span")).toBeNull();
    expect(bell.querySelector(".lucide-bell-off")).not.toBeNull();
    expect(view.getByRole("button", { name: "Mark read" })).toBeDefined();
    expect(view.getByText("Quiet until you resume")).toBeDefined();
    expect(view.queryByRole("dialog", { name: "Quiet events" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(view.getByRole("button", { name: "Events, 1 unread event" }).textContent).toBe("1"));
    expect(view.getByRole("button", { name: "Mark read" })).toBeDefined();
  });

  test("reconciles another session's preference hint without changing unread state", async () => {
    const { result } = renderHook(() => useEventFeed(), { wrapper: EventFeedProvider });
    await waitFor(() => expect(result.current.quietPreference).toEqual({ mode: "active" }));
    preference = { mode: "quiet" };
    act(() => publishEventFeedChanged());
    await waitFor(() => expect(result.current.quiet).toBe(true));
    expect(result.current.unreadCount).toBe(1);
    expect(result.current.events[0]?.readAt).toBeNull();
  });

  test("expires a timed snooze without writing preferences or marking history read", async () => {
    const start = Date.now();
    const until = start + 3_600_000;
    const clock = spyOn(Date, "now").mockReturnValue(start);
    preference = { mode: "snoozed", until: new Date(until).toISOString() };
    const writes = mock(async (value: EventFeedPreference) => value);
    setEventFeedPreference = writes;
    try {
      const { result } = renderHook(() => useEventFeed(), { wrapper: EventFeedProvider });
      await waitFor(() => expect(result.current.quiet).toBe(true));
      clock.mockReturnValue(until);
      act(() => window.dispatchEvent(new Event("focus")));
      expect(result.current.quiet).toBe(false);
      expect(writes).not.toHaveBeenCalled();
      expect(result.current.unreadCount).toBe(1);
    } finally { clock.mockRestore(); }
  });

  test("rejects duplicate clicks while saving and never claims an unconfirmed update", async () => {
    const pending = deferred<EventFeedPreference>();
    const writes = mock(() => pending.promise);
    setEventFeedPreference = writes;
    const { result } = renderHook(() => useEventFeed(), { wrapper: EventFeedProvider });
    await waitFor(() => expect(result.current.quietPreference).not.toBeNull());
    let first!: Promise<boolean>;
    act(() => { first = result.current.setQuietPreference({ mode: "quiet" }); });
    expect(result.current.quiet).toBe(false);
    await act(async () => expect(await result.current.setQuietPreference({ mode: "quiet" })).toBe(false));
    pending.reject(new Error("offline"));
    await act(async () => expect(await first).toBe(false));
    expect(writes).toHaveBeenCalledTimes(1);
    expect(result.current.quiet).toBe(false);
    expect(result.current.preferenceError).toContain("Could not confirm");
    expect(result.current.savingPreference).toBe(false);
  });

  test("reads back a committed update after a lost response", async () => {
    setEventFeedPreference = async (value) => { preference = value; throw new Error("lost response"); };
    const { result } = renderHook(() => useEventFeed(), { wrapper: EventFeedProvider });
    await waitFor(() => expect(result.current.quietPreference).not.toBeNull());
    await act(async () => expect(await result.current.setQuietPreference({ mode: "quiet" })).toBe(false));
    expect(result.current.quiet).toBe(true);
    expect(result.current.preferenceError).toContain("Could not confirm");
  });

  test("does not let a preference read from a failed feed refresh undo a newer save", async () => {
    const oldRead = deferred<EventFeedPreference>();
    getEventFeedPreference = () => oldRead.promise;
    listEventFeed = async () => { throw new Error("feed unavailable"); };
    const { result } = renderHook(() => useEventFeed(), { wrapper: EventFeedProvider });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    await act(async () => expect(await result.current.setQuietPreference({ mode: "quiet" })).toBe(true));
    await act(async () => oldRead.resolve({ mode: "active" }));
    expect(result.current.quiet).toBe(true);
  });

  test("fences preference responses on viewer changes and restores per-user defaults", async () => {
    const pending = deferred<EventFeedPreference>();
    getEventFeedPreference = () => pending.promise;
    const { result, rerender } = renderHook(() => useEventFeed(), { wrapper: EventFeedProvider });
    await waitFor(() => expect(result.current.refreshing).toBe(true));
    viewerUserId = "55555555-5555-4555-8555-555555555555";
    viewerGeneration += 1;
    getEventFeedPreference = async () => ({ mode: "active" });
    rerender();
    await waitFor(() => expect(result.current.quietPreference).toEqual({ mode: "active" }));
    await act(async () => pending.resolve({ mode: "quiet" }));
    expect(result.current.quiet).toBe(false);
  });

  test("preference failure keeps history available and retry recovers; disconnected changes do not write", async () => {
    getEventFeedPreference = async () => { throw new Error("unavailable"); };
    const writes = mock(async (value: EventFeedPreference) => value);
    setEventFeedPreference = writes;
    const { result, rerender } = renderHook(() => useEventFeed(), { wrapper: EventFeedProvider });
    await waitFor(() => expect(result.current.preferenceError).not.toBeNull());
    expect(result.current.events).toHaveLength(1);
    expect(result.current.quietPreference).toBeNull();
    getEventFeedPreference = async () => ({ mode: "quiet" });
    await act(async () => result.current.refresh());
    expect(result.current.quiet).toBe(true);
    wsState = "closed";
    rerender();
    await act(async () => expect(await result.current.setQuietPreference({ mode: "active" })).toBe(false));
    expect(writes).not.toHaveBeenCalled();
  });

  test("refreshes the already-loaded page depth without dropping older rows or resetting its cursor", async () => {
    let phase: "initial" | "refresh" = "initial";
    const firstPage = Array.from({ length: 50 }, (_, index) => event(`event-${String(index + 1).padStart(2, "0")}`));
    listEventFeed = async ({ cursor }) => {
      if (phase === "initial") {
        return cursor === "page-2"
          ? { events: [event("event-51")], nextCursor: "page-3" }
          : { events: firstPage, nextCursor: "page-2" };
      }
      return cursor === "refresh-page-2"
        ? { events: [event("event-51", "2026-09-09T10:00:00.000Z")], nextCursor: "refresh-page-3" }
        : { events: firstPage, nextCursor: "refresh-page-2" };
    };
    const { result } = renderHook(() => useEventFeed(), { wrapper: EventFeedProvider });
    await waitFor(() => expect(result.current.events).toHaveLength(50));
    await act(async () => result.current.loadMore());
    expect(result.current.events).toHaveLength(51);
    phase = "refresh";
    await act(async () => result.current.refresh());
    expect(result.current.events).toHaveLength(51);
    expect(result.current.events[50]?.readAt).not.toBeNull();
    expect(result.current.nextCursor).toBe("refresh-page-3");
  });

  test("serializes rapid mutations and keeps confirmed state unchanged after failure", async () => {
    listEventFeed = async () => ({ events: [event("event-1"), event("event-2")], nextCursor: null });
    const mutation = deferred<{ eventId: string; readAt: string | null; changed: boolean }>();
    let mutationCalls = 0;
    setEventFeedReadState = () => {
      mutationCalls += 1;
      return mutation.promise;
    };
    const { result } = renderHook(() => useEventFeed(), { wrapper: EventFeedProvider });
    await waitFor(() => expect(result.current.events).toHaveLength(2));
    let first!: Promise<void>;
    act(() => {
      first = result.current.setReadState("event-1", true);
      void result.current.setReadState("event-2", true);
    });
    await waitFor(() => expect(mutationCalls).toBe(1));
    await act(async () => {
      mutation.reject(new Error("save failed"));
      await first;
    });
    expect(result.current.events.every((item) => item.readAt === null)).toBe(true);
    expect(result.current.unreadCount).toBe(1);
    expect(result.current.mutationFailure?.message).toBe("save failed");
  });

  test("publishes a successful read only from the authoritative follow-up", async () => {
    let readCommitted = false;
    listEventFeed = async () => ({
      events: [event("event-1", readCommitted ? "2026-09-09T10:00:00.000Z" : null)],
      nextCursor: null,
    });
    getEventFeedUnreadCount = async () => ({ unreadCount: readCommitted ? 0 : 1 });
    setEventFeedReadState = async (eventId) => {
      readCommitted = true;
      return { eventId, readAt: "2026-09-09T10:00:00.000Z", changed: true };
    };
    const { result } = renderHook(() => useEventFeed(), { wrapper: EventFeedProvider });
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    await act(async () => result.current.setReadState("event-1", true));
    expect(result.current.events[0]?.readAt).not.toBeNull();
    expect(result.current.unreadCount).toBe(0);
  });

  test("clears protected feed state on identity switch while ignoring the old in-flight response", async () => {
    const oldPage = deferred<EventFeedPage>();
    const oldCount = deferred<{ unreadCount: number }>();
    let calls = 0;
    listEventFeed = async () => {
      calls += 1;
      return calls === 1 ? oldPage.promise : { events: [event("new-user-event")], nextCursor: null };
    };
    getEventFeedUnreadCount = () => calls === 1 ? oldCount.promise : Promise.resolve({ unreadCount: 1 });
    const { result, rerender } = renderHook(() => useEventFeed(), { wrapper: EventFeedProvider });
    await waitFor(() => expect(calls).toBe(1));
    viewerGeneration = 2;
    viewerUserId = "55555555-5555-4555-8555-555555555555";
    viewerActorId = "66666666-6666-4666-8666-666666666666";
    rerender();
    await waitFor(() => expect(result.current.events[0]?.id).toBe("new-user-event"));
    oldPage.resolve({ events: [event("old-user-event")], nextCursor: null });
    oldCount.resolve({ unreadCount: 9 });
    await act(async () => { await oldPage.promise; });
    expect(result.current.events.map((item) => item.id)).toEqual(["new-user-event"]);
    expect(result.current.unreadCount).toBe(1);
  });

  test("retains provider UI state across same-user credential refresh", async () => {
    const { result, rerender } = renderHook(() => useEventFeed(), { wrapper: EventFeedProvider });
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    act(() => result.current.setScrollTop(84));
    await act(async () => {
      credentialGeneration = 2;
      rerender();
    });
    expect(result.current.scrollTop).toBe(84);
  });

  test("prevents older metadata hydration from restoring a newly unavailable Room name", async () => {
    const oldRoom = deferred<RoomDetailResponse>();
    const revokedRoom = deferred<RoomDetailResponse>();
    let roomCalls = 0;
    getRoom = () => {
      roomCalls += 1;
      return roomCalls === 1 ? oldRoom.promise : revokedRoom.promise;
    };
    const { result } = renderHook(() => useEventFeed(), { wrapper: EventFeedProvider });
    await waitFor(() => expect(roomCalls).toBe(1));
    await act(async () => result.current.refresh());
    await waitFor(() => expect(roomCalls).toBe(2));
    revokedRoom.reject(new Error("forbidden"));
    await waitFor(() => expect(result.current.roomsById.get(ROOM_ID)).toBeNull());
    oldRoom.resolve({
      id: ROOM_ID,
      label: "Secret Room",
      type: "group",
      graphThreadId: "thread",
      createdAt: "2026-09-09T08:00:00.000Z",
      kind: "group",
      conductorMode: "standard",
      members: [],
    });
    await act(async () => { await oldRoom.promise; });
    expect(result.current.roomsById.get(ROOM_ID)).toBeNull();
  });

  test("accepts a pending head and preserves the loaded older range on the next refresh", async () => {
    const head = Array.from({ length: 50 }, (_, index) => ({
      ...event(`event-${String(index + 1).padStart(2, "0")}`),
      createdAt: `2026-09-09T09:${String(59 - index).padStart(2, "0")}:00.000Z`,
    }));
    const older = { ...event("event-51"), createdAt: "2026-09-09T08:00:00.000Z" };
    const newest = { ...event("event-new"), createdAt: "2026-09-09T10:00:00.000Z" };
    let phase: "initial" | "new" = "initial";
    listEventFeed = async ({ cursor }) => {
      if (phase === "initial") {
        return cursor === "page-2"
          ? { events: [older], nextCursor: "page-3" }
          : { events: head, nextCursor: "page-2" };
      }
      return cursor === "new-page-2"
        ? { events: [head[49]!, older], nextCursor: "new-page-3" }
        : { events: [newest, ...head.slice(0, 49)], nextCursor: "new-page-2" };
    };
    getEventFeedUnreadCount = async () => ({ unreadCount: 52 });
    const { result } = renderHook(() => useEventFeed(), { wrapper: EventFeedProvider });
    await waitFor(() => expect(result.current.events).toHaveLength(50));
    await act(async () => result.current.loadMore());
    phase = "new";
    await act(async () => result.current.refresh());
    expect(result.current.pendingNewEvents).toBe(true);
    expect(result.current.events[0]?.id).toBe("event-01");
    act(() => result.current.showPendingNewEvents());
    expect(result.current.events.map((item) => item.id)).toContain("event-51");
    await act(async () => result.current.refresh());
    expect(result.current.events).toHaveLength(52);
    expect(result.current.events.map((item) => item.id)).toContain("event-51");
    expect(result.current.nextCursor).toBe("new-page-3");
  });

  test("mark-all replaces a pending head with the authoritative snapshot and keeps a concurrent event unread", async () => {
    const old = event("event-old");
    const newlyPending = { ...event("event-new"), createdAt: "2026-09-09T10:00:00.000Z" };
    const concurrent = { ...event("event-concurrent"), createdAt: "2026-09-09T11:00:00.000Z" };
    const readAt = "2026-09-09T10:30:00.000Z";
    let phase: "initial" | "pending" | "marked" = "initial";
    listEventFeed = async () => {
      if (phase === "initial") return { events: [old], nextCursor: null };
      if (phase === "pending") return { events: [newlyPending, old], nextCursor: null };
      return {
        events: [concurrent, { ...newlyPending, readAt }, { ...old, readAt }],
        nextCursor: null,
      };
    };
    getEventFeedUnreadCount = async () => ({ unreadCount: phase === "marked" ? 1 : phase === "pending" ? 2 : 1 });
    markAllEventFeedRead = async () => {
      phase = "marked";
      return { updatedCount: 2 };
    };
    const { result } = renderHook(() => useEventFeed(), { wrapper: EventFeedProvider });
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    phase = "pending";
    await act(async () => result.current.refresh());
    expect(result.current.pendingNewEvents).toBe(true);
    await act(async () => result.current.markAllRead());
    expect(result.current.unreadCount).toBe(1);
    act(() => result.current.showPendingNewEvents());
    expect(result.current.events.find((item) => item.id === "event-concurrent")?.readAt).toBeNull();
    expect(result.current.events.find((item) => item.id === "event-new")?.readAt).toBe(readAt);
    expect(result.current.events.find((item) => item.id === "event-old")?.readAt).toBe(readAt);
  });

  test("renders an unread entry without marking it read until the explicit control is used", async () => {
    const mutationCalls: boolean[] = [];
    let readCommitted = false;
    listEventFeed = async () => ({
      events: [event("event-1", readCommitted ? "2026-09-09T10:00:00.000Z" : null)],
      nextCursor: null,
    });
    getEventFeedUnreadCount = async () => ({ unreadCount: readCommitted ? 0 : 1 });
    setEventFeedReadState = async (eventId, read) => {
      mutationCalls.push(read);
      readCommitted = read;
      return {
        eventId,
        readAt: read ? "2026-09-09T10:00:00.000Z" : null,
        changed: true,
      };
    };
    const view = render(
      <EventFeedProvider>
        <EventFeedPanel onOpenRoom={() => {}} onOpenArtifact={() => {}} />
      </EventFeedProvider>,
    );
    await waitFor(() => expect(view.getByRole("list", { name: "Events" })).toBeTruthy());
    expect(mutationCalls).toEqual([]);
    fireEvent.click(view.getByRole("button", { name: "Mark read" }));
    await waitFor(() => expect(mutationCalls).toEqual([true]));
    await waitFor(() => expect(view.getByRole("button", { name: "Mark unread" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Mark unread" }));
    await waitFor(() => expect(mutationCalls).toEqual([true, false]));
    await waitFor(() => expect(view.getByRole("button", { name: "Mark read" })).toBeTruthy());
  });

  test("hydrates same-name Artifacts by internal UUID and opens the selected exact object", async () => {
    const firstId = ARTIFACT_ID;
    const secondId = "88888888-8888-4888-8888-888888888888";
    listEventFeed = async () => ({ events: [artifactEvent("event-a", firstId), artifactEvent("event-b", secondId)], nextCursor: null });
    getWorkspaceArtifact = async (id) => artifact(id, "reports/Same name.md");
    let readMutationCalls = 0;
    setEventFeedReadState = async (eventId, read) => {
      readMutationCalls += 1;
      return { eventId, readAt: read ? "2026-09-09T10:00:00.000Z" : null, changed: true };
    };
    const opened: ArtifactDto[] = [];
    const view = render(
      <EventFeedProvider>
        <EventFeedPanel onOpenRoom={() => {}} onOpenArtifact={(value) => opened.push(value)} />
      </EventFeedProvider>,
    );

    await waitFor(() => expect(view.getAllByRole("button", { name: "Open Same name.md" })).toHaveLength(2));
    fireEvent.click(view.getAllByRole("button", { name: "Open Same name.md" })[1]!);
    await waitFor(() => expect(opened.map((value) => value.id)).toEqual([secondId]));
    expect(readMutationCalls).toBe(0);
  });

  test("reauthorizes the exact Artifact on click and does not open after intervening revocation", async () => {
    listEventFeed = async () => ({ events: [artifactEvent("event-a")], nextCursor: null });
    let accessible = true;
    getWorkspaceArtifact = async (id) => accessible ? artifact(id, "private/Plans.md") : null;
    let readMutationCalls = 0;
    setEventFeedReadState = async (eventId, read) => {
      readMutationCalls += 1;
      return { eventId, readAt: read ? "2026-09-09T10:00:00.000Z" : null, changed: true };
    };
    const opened: ArtifactDto[] = [];
    const view = render(
      <EventFeedProvider>
        <EventFeedPanel onOpenRoom={() => {}} onOpenArtifact={(value) => opened.push(value)} />
      </EventFeedProvider>,
    );
    const open = await waitFor(() => view.getByRole("button", { name: "Open Plans.md" }));
    accessible = false;
    fireEvent.click(open);

    await waitFor(() => expect(view.getByText("Artifact unavailable")).toBeTruthy());
    expect(opened).toEqual([]);
    expect(readMutationCalls).toBe(0);
  });

  test("hydrates a person share without looking up or exposing a sender Room", async () => {
    listEventFeed = async () => ({ events: [artifactEvent("event-a")], nextCursor: null });
    let roomCalls = 0;
    getRoom = async () => {
      roomCalls += 1;
      throw new Error("a person share must not need a Room");
    };
    getWorkspaceArtifact = async (id) => artifact(id, "shared/For you.md");
    const { result } = renderHook(() => useEventFeed(), { wrapper: EventFeedProvider });

    await waitFor(() => expect(result.current.artifactsById.get(ARTIFACT_ID)?.id).toBe(ARTIFACT_ID));
    expect(roomCalls).toBe(0);
    expect(result.current.roomsById.size).toBe(0);
  });

  test("prevents stale Artifact hydration from restoring a label after access is revoked", async () => {
    listEventFeed = async () => ({ events: [artifactEvent("event-a")], nextCursor: null });
    const oldArtifact = deferred<ArtifactDto | null>();
    const revokedArtifact = deferred<ArtifactDto | null>();
    let artifactCalls = 0;
    getWorkspaceArtifact = () => {
      artifactCalls += 1;
      return artifactCalls === 1 ? oldArtifact.promise : revokedArtifact.promise;
    };
    const { result } = renderHook(() => useEventFeed(), { wrapper: EventFeedProvider });
    await waitFor(() => expect(artifactCalls).toBe(1));
    await act(async () => result.current.refresh());
    await waitFor(() => expect(artifactCalls).toBe(2));
    revokedArtifact.resolve(null);
    await waitFor(() => expect(result.current.artifactsById.get(ARTIFACT_ID)).toBeNull());
    oldArtifact.resolve(artifact(ARTIFACT_ID, "private/Plans.md"));
    await act(async () => { await oldArtifact.promise; });
    expect(result.current.artifactsById.get(ARTIFACT_ID)).toBeNull();
  });

  test("clears Artifact labels immediately on a content-free access invalidation hint", async () => {
    listEventFeed = async () => ({ events: [artifactEvent("event-a")], nextCursor: null });
    const reauthorization = deferred<ArtifactDto | null>();
    let artifactCalls = 0;
    getWorkspaceArtifact = async (id) => {
      artifactCalls += 1;
      return artifactCalls === 1 ? artifact(id, "private/Plans.md") : reauthorization.promise;
    };
    const { result } = renderHook(() => useEventFeed(), { wrapper: EventFeedProvider });
    await waitFor(() => expect(result.current.artifactsById.get(ARTIFACT_ID)?.path).toBe("private/Plans.md"));

    act(() => publishEventFeedChanged());

    expect(result.current.artifactsById.size).toBe(0);
    await waitFor(() => expect(artifactCalls).toBe(2));
    reauthorization.resolve(null);
    await waitFor(() => expect(result.current.artifactsById.get(ARTIFACT_ID)).toBeNull());
  });

  test("discards a stale successful click authorization when a revoke hint arrives in flight", async () => {
    listEventFeed = async () => ({ events: [artifactEvent("event-a")], nextCursor: null });
    const staleClick = deferred<ArtifactDto | null>();
    let artifactCalls = 0;
    getWorkspaceArtifact = async (id) => {
      artifactCalls += 1;
      if (artifactCalls === 1) return artifact(id, "private/Plans.md");
      if (artifactCalls === 2) return staleClick.promise;
      return null;
    };
    const opened: ArtifactDto[] = [];
    const view = render(
      <EventFeedProvider>
        <EventFeedPanel onOpenRoom={() => {}} onOpenArtifact={(value) => opened.push(value)} />
      </EventFeedProvider>,
    );
    const open = await waitFor(() => view.getByRole("button", { name: "Open Plans.md" }));
    fireEvent.click(open);
    await waitFor(() => expect(artifactCalls).toBe(2));

    act(() => publishEventFeedChanged());
    expect(view.queryByRole("button", { name: "Open Plans.md" })).toBeNull();
    staleClick.resolve(artifact(ARTIFACT_ID, "private/Plans.md"));

    await act(async () => { await staleClick.promise; });
    await waitFor(() => expect(artifactCalls).toBe(3));
    expect(opened).toEqual([]);
    expect(view.queryByRole("button", { name: "Open Plans.md" })).toBeNull();
  });

  test("applies category filters to list reads while mark-all remains global", async () => {
    const requests: EventFeedListOptions[] = [];
    listEventFeed = async (options) => {
      requests.push(options);
      return { events: [], nextCursor: null };
    };
    let markAllCalls = 0;
    markAllEventFeedRead = async () => {
      markAllCalls += 1;
      return { updatedCount: 2 };
    };
    getEventFeedUnreadCount = async () => ({ unreadCount: 2 });
    const { result } = renderHook(() => useEventFeed(), { wrapper: EventFeedProvider });
    await waitFor(() => expect(requests).toHaveLength(1));
    act(() => result.current.setCategory("artifacts"));
    await waitFor(() => expect(requests.at(-1)?.types).toEqual(["artifact.added", "artifact.shared"]));
    await act(async () => result.current.markAllRead());
    expect(markAllCalls).toBe(1);
  });
});
