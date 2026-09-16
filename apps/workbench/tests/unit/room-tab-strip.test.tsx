import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RoomTabStrip } from "../../src/components/rooms/room-tab-strip";
import {
  fixtureWorkbenchRoom,
  FIXTURE_LONG_LABEL_ROOM,
} from "./test-room-fixtures";

describe("RoomTabStrip", () => {
  test("marks active tab with aria-current", () => {
    const rooms = [
      fixtureWorkbenchRoom({ id: "r1", label: "One" }),
      fixtureWorkbenchRoom({ id: "r2", label: "Two" }),
    ];
    const html = renderToStaticMarkup(
      <RoomTabStrip
        rooms={rooms}
        activeRoomId="r2"
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
      />,
    );
    expect(html).toContain("Rooms");
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("Open chat Two");
  });

  test("truncation class on label", () => {
    const html = renderToStaticMarkup(
      <RoomTabStrip
        rooms={[FIXTURE_LONG_LABEL_ROOM]}
        activeRoomId={FIXTURE_LONG_LABEL_ROOM.id}
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
      />,
    );
    expect(html).toContain("room-tab-strip-label-truncate");
  });

  test("loading shows muted copy", () => {
    const html = renderToStaticMarkup(
      <RoomTabStrip
        rooms={[]}
        activeRoomId={null}
        loading
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
      />,
    );
    expect(html).toContain("Loading rooms");
  });

  test("error + retry", () => {
    const html = renderToStaticMarkup(
      <RoomTabStrip
        rooms={[]}
        activeRoomId={null}
        errorMessage="offline"
        onRetry={() => {}}
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
      />,
    );
    expect(html).toContain("offline");
    expect(html).toContain("Retry");
  });

  test("Rooms search affordance when panel callbacks provided", () => {
    const html = renderToStaticMarkup(
      <RoomTabStrip
        rooms={[fixtureWorkbenchRoom({ id: "r1", label: "One" })]}
        activeRoomId="r1"
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
        roomsPanelOpen={true}
        onRoomsPanelOpenChange={() => {}}
        roomsPanel={<span>panel-body</span>}
      />,
    );
    expect(html).toContain("Open rooms list");
    expect(html).toContain("panel-body");
  });

  test("uses fixed grid shell with only tab rail scrollable", () => {
    const html = renderToStaticMarkup(
      <RoomTabStrip
        rooms={[
          fixtureWorkbenchRoom({ id: "r1", label: "One" }),
          fixtureWorkbenchRoom({ id: "r2", label: "Two" }),
        ]}
        activeRoomId="r1"
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
        roomsPanelOpen={false}
        onRoomsPanelOpenChange={() => {}}
      />,
    );
    expect(html).toContain("grid-cols-[auto_minmax(0,1fr)_auto]");
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("room-tab-strip-scrollbar-none");
    expect(html).toContain("New chat");
  });

  test("open tabs are draggable when reorder callback is provided", () => {
    const html = renderToStaticMarkup(
      <RoomTabStrip
        rooms={[fixtureWorkbenchRoom({ id: "r1", label: "One" })]}
        activeRoomId="r1"
        onSelect={() => {}}
        onClose={() => {}}
        onReorder={() => {}}
        onNew={() => {}}
      />,
    );
    expect(html).toContain('draggable="true"');
  });

  test("D110 compact rail keeps tabs and uses icon-only room picker", () => {
    const html = renderToStaticMarkup(
      <RoomTabStrip
        rooms={[
          fixtureWorkbenchRoom({ id: "r1", label: "Alpha" }),
          fixtureWorkbenchRoom({ id: "r2", label: "Beta" }),
        ]}
        activeRoomId="r1"
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
        compact
        roomsPanelOpen={false}
        onRoomsPanelOpenChange={() => {}}
        roomsPanel={<span>panel</span>}
      />,
    );
    expect(html).toContain("grid-cols-[minmax(0,1fr)_auto]");
    expect(html).not.toContain("grid-cols-[auto_minmax(0,1fr)_auto]");
    expect(html).toContain("Open chat Alpha");
    expect(html).toContain("Open chat Beta");
    expect(html).toContain("lucide-history");
    expect(html).not.toContain(">Rooms<");
  });

  test("D110 compact rail preserves tab-strip order before picker and new-chat controls", () => {
    const html = renderToStaticMarkup(
      <RoomTabStrip
        rooms={[
          fixtureWorkbenchRoom({ id: "r1", label: "Problem with your voice messages" }),
          fixtureWorkbenchRoom({ id: "r2", label: "hello" }),
        ]}
        activeRoomId="r1"
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
        compact
        roomsPanelOpen={false}
        onRoomsPanelOpenChange={() => {}}
        roomsPanel={<span>panel</span>}
      />,
    );
    const firstTab = html.indexOf("Open chat Problem with your voice messages");
    const secondTab = html.indexOf("Open chat hello");
    const picker = html.indexOf("lucide-history");
    const newChat = html.indexOf("New chat");

    expect(firstTab).toBeGreaterThan(-1);
    expect(secondTab).toBeGreaterThan(firstTab);
    expect(picker).toBeGreaterThan(secondTab);
    expect(newChat).toBeGreaterThan(picker);
    expect(html).not.toContain("Current room:");
  });

  test("renders the transcript Search entry in default and compact toolbars", () => {
    const common = {
      rooms: [fixtureWorkbenchRoom({ id: "r1", label: "One" })],
      activeRoomId: "r1",
      onSelect: () => {},
      onClose: () => {},
      onNew: () => {},
      onSearchOpen: () => {},
    };
    const defaultHtml = renderToStaticMarkup(<RoomTabStrip {...common} searchOpen />);
    const compactHtml = renderToStaticMarkup(
      <RoomTabStrip
        {...common}
        compact
        roomsPanelOpen={false}
        onRoomsPanelOpenChange={() => {}}
      />,
    );

    expect(defaultHtml).toContain('aria-label="Search this room"');
    expect(defaultHtml).toContain('aria-pressed="true"');
    expect(defaultHtml).toContain('aria-expanded="true"');
    expect(compactHtml).toContain('aria-label="Search this room"');
    expect(compactHtml).toContain("lucide-search");
  });
});
