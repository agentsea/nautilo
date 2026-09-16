import { describe, expect, test, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

let roomNavState: {
  status: string;
} = { status: "ready" };
let totals: { unreadCount: number; importantUnreadCount: number } | null = {
  unreadCount: 0,
  importantUnreadCount: 0,
};

mock.module("../../src/contexts/room-navigation-context", () => ({
  useRoomNavigation: () => roomNavState,
}));
mock.module("../../src/notifications/notification-state-context", () => ({
  useNotificationState: () => ({
    snapshot: totals ? { totals } : null,
  }),
}));

const { RoomRail } = await import("../../src/components/navigation-rail/RoomRail");

function render(): string {
  return renderToStaticMarkup(<RoomRail state="inactive" onToggle={() => {}} />);
}

describe("RoomRail notification attention (M238)", () => {
  test("renders a dot for ambient unread without an important count", () => {
    roomNavState = { status: "ready" };
    totals = { unreadCount: 3, importantUnreadCount: 0 };
    const html = render();
    expect(html).toContain('data-testid="room-rail-unread-dot"');
    expect(html).toContain('data-unread="true"');
    expect(html).not.toContain("room-rail-important-count");
    expect(html).toContain("Rooms: 3 unread messages, 0 important messages");
  });

  test("renders a capped important count while exposing exact totals", () => {
    roomNavState = { status: "ready" };
    totals = { unreadCount: 120, importantUnreadCount: 100 };
    const html = render();
    expect(html).not.toContain("room-rail-unread-dot");
    expect(html).toContain('data-testid="room-rail-important-count"');
    expect(html).toContain(">99+<");
    expect(html).toContain("Rooms: 120 unread messages, 100 important messages");
  });

  test("hides attention when totals are zero or unavailable", () => {
    roomNavState = { status: "ready" };
    totals = { unreadCount: 0, importantUnreadCount: 0 };
    const html = render();
    expect(html).not.toContain("room-rail-unread-dot");
    totals = null;
    expect(render()).not.toContain("room-rail-unread-dot");
  });

  test("renders nothing until the store is ready", () => {
    roomNavState = { status: "loading" };
    totals = { unreadCount: 5, importantUnreadCount: 1 };
    expect(render()).toBe("");
  });
});
