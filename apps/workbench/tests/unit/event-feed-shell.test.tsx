import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventFeedBell } from "../../src/layouts/event-feed-bell";
import { reapplyHappyDomGlobals } from "../bun-dom-preload";

beforeEach(reapplyHappyDomGlobals);
afterEach(cleanup);

describe("EventFeedBell", () => {
  test("quiet uses a crossed-out bell and omits the numbered badge regardless of unread count", () => {
    const onClick = mock(() => {});
    const view = render(<EventFeedBell buttonRef={{ current: null }} open={false} unreadCount={123} quiet onClick={onClick} />);
    const bell = view.getByRole("button", { name: "Events, quiet" });
    expect(bell.querySelector("span")).toBeNull();
    expect(bell.querySelector(".lucide-bell-off")).not.toBeNull();
    expect(view.queryByText("123")).toBeNull();
    fireEvent.click(bell);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  test("announces the full unread count and omits a zero badge", () => {
    const onClick = mock(() => {});
    const { getByRole, queryByText, rerender } = render(
      <EventFeedBell
        buttonRef={{ current: null }}
        open={false}
        unreadCount={0}
        onClick={onClick}
      />,
    );

    expect(getByRole("button", { name: "Events, 0 unread events" })).toBeTruthy();
    expect(queryByText("0")).toBeNull();

    rerender(
      <EventFeedBell
        buttonRef={{ current: null }}
        open
        unreadCount={123}
        onClick={onClick}
      />,
    );
    const button = getByRole("button", { name: "Events, 123 unread events" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const badge = queryByText("123");
    expect(badge).toBeTruthy();
    expect(badge?.classList.contains("bg-accent")).toBe(true);
    expect(badge?.classList.contains("text-white")).toBe(true);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("event-feed shell placement", () => {
  const source = readFileSync(
    join(import.meta.dir, "../../src/layouts/workbench-shell.tsx"),
    "utf8",
  );

  test("the one bell lives in shared shell chrome before the work-surface branch", () => {
    expect(source.match(/<EventFeedBell/g)).toHaveLength(1);
    expect(source.indexOf("<EventFeedBell")).toBeLessThan(
      source.indexOf("{workSurfaceOwnsMain ?"),
    );
  });

  test("narrow Events overlays an inert mounted content owner", () => {
    expect(source).toContain('inert={eventsOpen && bp !== "desktop"}');
    expect(source).toContain('className="absolute inset-0 z-40 bg-background"');
    expect(source).toContain('<DrawerShell title="Events" actions={<EventFeedQuietControl />} onClose={closeEvents}>');
  });

  test("Events owns trailing geometry without changing persisted collapse state", () => {
    expect(source).toContain("const trailingDrawerOpen = drawerOpen || eventsOpen");
    expect(source).toContain("drawerOpen: trailingDrawerOpen");
    const eventStateBlock = source.slice(
      source.indexOf("const eventFeed = useEventFeed()"),
      source.indexOf("const browserModeViewerKey"),
    );
    expect(eventStateBlock).not.toContain("panelSizes.setCollapsed");
  });
});
