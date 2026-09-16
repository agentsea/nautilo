import { reapplyHappyDomGlobals } from "../../../../../tests/bun-dom-preload";
import { render, fireEvent, waitFor } from "@testing-library/react";
import {
  describe,
  it,
  expect,
  mock,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";

beforeEach(() => {
  reapplyHappyDomGlobals();
});

let findExistingResult: string | null = null;
let createFailureStatus: number | null = null;
let subthreadsByAnchor = new Map<
  string,
  { unreadCount: number; importantUnreadCount: number }
>();
const originalFetch = globalThis.fetch;
const fetchMock = mock<typeof fetch>();

describe("ParentMessageReplyAffordance", () => {
  let ParentMessageReplyAffordance: typeof import("../components/ParentMessageReplyAffordance").ParentMessageReplyAffordance;
  let DrawerProvider: typeof import("../drawer-state.tsx").DrawerProvider;
  let useDrawer: typeof import("../drawer-state.tsx").useDrawer;

  beforeAll(async () => {
    mock.module("../../../../notifications/notification-state-context", () => ({
      useNotificationState: () => ({ subthreadsByAnchor }),
    }));
    ({ ParentMessageReplyAffordance } = await import("../components/ParentMessageReplyAffordance"));
    ({ DrawerProvider, useDrawer } = await import("../drawer-state.tsx"));
  });

  beforeEach(() => {
    findExistingResult = null;
    createFailureStatus = null;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") {
        return createFailureStatus
          ? new Response("unavailable", { status: createFailureStatus })
          : new Response(JSON.stringify({ subthreadRoomId: "stub-thread" }), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            });
      }
      return new Response(
        JSON.stringify({
          subthreads: findExistingResult
            ? [{ id: findExistingResult, anchorMessageId: url.endsWith("/subthreads") ? 123 : 0 }]
            : [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock;
    subthreadsByAnchor = new Map();
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
    reapplyHappyDomGlobals();
  });

  it("preserves message density when reply count is 0", () => {
    const { container } = render(
      <DrawerProvider>
        <ParentMessageReplyAffordance
          parentRoomId="room-123"
          messageId={123}
          replyCount={0}
        />
      </DrawerProvider>,
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders singular 'reply' for count of 1", () => {
    const { getByText } = render(
      <DrawerProvider>
        <ParentMessageReplyAffordance
          messageId={123}
          parentRoomId="room-123"
          replyCount={1}
        />
      </DrawerProvider>,
    );

    expect(getByText(/1 reply/)).toBeTruthy();
  });

  it("renders plural 'replies' for count > 1", () => {
    const { getByText } = render(
      <DrawerProvider>
        <ParentMessageReplyAffordance
          messageId={123}
          parentRoomId="room-123"
          replyCount={5}
        />
      </DrawerProvider>,
    );

    expect(getByText(/5 replies/)).toBeTruthy();
  });

  it("appends eligible unread and important segments without replacing live replies", () => {
    subthreadsByAnchor = new Map([
      [
        "room-123\u0000123",
        { unreadCount: 3, importantUnreadCount: 1 },
      ],
    ]);
    const { getByText } = render(
      <DrawerProvider>
        <ParentMessageReplyAffordance
          parentRoomId="room-123"
          messageId={123}
          replyCount={12}
        />
      </DrawerProvider>,
    );
    expect(getByText("12 replies · 3 unread · 1 important")).toBeTruthy();
  });

  it("calls findExistingSubthread when clicked", async () => {
    findExistingResult = "thread-456";

    const { getByText } = render(
      <DrawerProvider>
        <ParentMessageReplyAffordance
          messageId={123}
          parentRoomId="room-123"
          replyCount={3}
        />
      </DrawerProvider>,
    );

    fireEvent.click(getByText(/3 replies/));

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/rooms/room-123/subthreads");
  });

  it("opens the integrated drawer from a visible existing-thread action", async () => {
    findExistingResult = "existing-thread";
    function DrawerProbe() {
      const drawer = useDrawer();
      return <output data-testid="drawer-kind">{drawer.current.kind}</output>;
    }
    const { getByRole, getByTestId } = render(
      <DrawerProvider>
        <ParentMessageReplyAffordance
          messageId={123}
          parentRoomId="personal-room"
          replyCount={4}
        />
        <DrawerProbe />
      </DrawerProvider>,
    );

    fireEvent.click(getByRole("button", { name: "Open 4 replies in thread" }));
    await waitFor(() => expect(getByTestId("drawer-kind").textContent).toBe("thread"));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/rooms/personal-room/subthreads",
    );
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it("shows actionable feedback when the thread API rejects the click", async () => {
    findExistingResult = null;
    createFailureStatus = 404;
    const { getByRole } = render(
      <DrawerProvider>
        <ParentMessageReplyAffordance
          messageId={321}
          parentRoomId="personal-room"
          replyCount={2}
        />
      </DrawerProvider>,
    );

    fireEvent.click(getByRole("button", { name: "Open 2 replies in thread" }));

    await waitFor(() =>
      expect(getByRole("alert").textContent).toContain(
        "This thread isn't available to you",
      ),
    );
  });

  it("suppresses a dead action when no persisted parent Room exists", () => {
    const { container } = render(
      <DrawerProvider>
        <ParentMessageReplyAffordance
          parentRoomId={null}
          messageId={123}
          replyCount={0}
        />
      </DrawerProvider>,
    );
    expect(container.firstChild).toBeNull();
  });
});
