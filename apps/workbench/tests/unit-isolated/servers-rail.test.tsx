import { act, createElement } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import type {
  DesktopServerListEntry,
  DesktopServerListResult,
} from "../../src/lib/desktop";

const activeServer: DesktopServerListEntry = {
  url: "https://alpha.example",
  name: "Alpha",
  iconUrl: "https://alpha.example/icon.png",
  connection: "live" as const,
  active: true,
  signedIn: true,
  notificationSummary: {
    state: "fresh" as const,
    unreadCount: 5,
    importantUnreadCount: 3,
  },
};
const inactiveServer: DesktopServerListEntry = {
  url: "https://beta.example",
  name: "Beta",
  iconUrl: "https://beta.example/icon.png",
  connection: "live" as const,
  active: false,
  signedIn: true,
  notificationSummary: {
    state: "fresh" as const,
    unreadCount: 4,
    importantUnreadCount: 2,
  },
};
let listResult: DesktopServerListResult = {
  servers: [activeServer, inactiveServer],
  aggregate: {
    unreadCount: 9,
    importantUnreadCount: 5,
    unavailableServerCount: 0,
  },
};
const listMock = mock(async () => listResult);

beforeEach(() => {
  listResult = {
    servers: [
      activeServer,
      inactiveServer,
    ],
    aggregate: {
      unreadCount: 9,
      importantUnreadCount: 5,
      unavailableServerCount: 0,
    },
  };
});

let ServersRail: (typeof import("../../src/components/navigation-rail/ServersRail"))["ServersRail"];
let happyWindow: Window;
let root: Root | null = null;
const priorGlobals: Record<string, unknown> = {};

beforeAll(async () => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) {
    priorGlobals[key] = (globalThis as Record<string, unknown>)[key];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
  });
  mock.module("../../src/lib/desktop", () => ({
    desktopAPI: {
      servers: {
        list: listMock,
        onChanged: () => () => {},
      },
    },
  }));
  ({ ServersRail } = await import("../../src/components/navigation-rail/ServersRail"));
});

afterAll(async () => {
  if (root) await act(async () => root?.unmount());
  const globals = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(priorGlobals)) globals[key] = value;
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  mock.restore();
});

describe("ServersRail", () => {
  test("keeps other-server totals in the open rail aria-label without showing a duplicate badge", async () => {
    const container = happyWindow.document.createElement("div");
    happyWindow.document.body.replaceChildren(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(ServersRail, { state: "open", onToggle: () => {} }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="servers-rail-toggle"]');
    expect(toggle?.className).toContain("h-9");
    expect(toggle?.className).toContain("bg-[var(--primary-muted)]");
    expect(toggle?.querySelector('[data-testid="servers-rail-attention"]')).toBeNull();
    expect(toggle?.title).toBe("Switch server — Alpha");
    expect(toggle?.querySelector("img")?.className).toContain("h-4");
    expect(toggle?.getAttribute("aria-label")).toContain(
      "Other servers: 4 unread messages, 2 important messages",
    );
  });

  test("does not show a closed-rail badge for unread on only the active server", async () => {
    listResult = {
      servers: [activeServer],
      aggregate: {
        unreadCount: 5,
        importantUnreadCount: 3,
        unavailableServerCount: 0,
      },
    };
    const container = happyWindow.document.createElement("div");
    happyWindow.document.body.replaceChildren(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(ServersRail, { state: "collapsed", onToggle: () => {} }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="servers-rail-toggle"]');
    expect(toggle?.querySelector('[data-testid="servers-rail-attention"]')).toBeNull();
    expect(toggle?.getAttribute("aria-label")).toContain(
      "Other servers: 0 unread messages, 0 important messages",
    );
  });

  test("shows other-server attention when the servers rail is closed", async () => {
    const container = happyWindow.document.createElement("div");
    happyWindow.document.body.replaceChildren(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(ServersRail, { state: "collapsed", onToggle: () => {} }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="servers-rail-toggle"]');
    expect(toggle?.getAttribute("aria-label")).toContain(
      "Other servers: 4 unread messages, 2 important messages",
    );
    expect(
      toggle?.querySelector('[data-testid="servers-rail-attention"]')?.textContent,
    ).toBe("2");
  });

  test("excludes stale other-server counts while exposing unavailable context", async () => {
    listResult = {
      servers: [
        activeServer,
        {
          ...inactiveServer,
          notificationSummary: {
            state: "stale",
            unreadCount: 4,
            importantUnreadCount: 2,
          },
        },
      ],
      aggregate: {
        unreadCount: 5,
        importantUnreadCount: 3,
        unavailableServerCount: 1,
      },
    };
    const container = happyWindow.document.createElement("div");
    happyWindow.document.body.replaceChildren(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(ServersRail, { state: "collapsed", onToggle: () => {} }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="servers-rail-toggle"]');
    expect(toggle?.querySelector('[data-testid="servers-rail-attention"]')).toBeNull();
    expect(toggle?.getAttribute("aria-label")).toContain(
      "Other servers: 0 unread messages, 0 important messages. 1 server is unavailable and excluded",
    );
  });
});
