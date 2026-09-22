import { act, createElement } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

const listMock = mock(async () => ({
  servers: [
    {
      url: "https://alpha.example",
      name: "Alpha",
      description: "Primary workspace",
      iconUrl: "https://alpha.example/icon.png",
      connection: "live" as const,
      active: true,
      signedIn: true,
      notificationSummary: {
        state: "fresh" as const,
        unreadCount: 3,
        importantUnreadCount: 2,
      },
    },
    {
      url: "https://beta.example",
      iconUrl: "https://beta.example/icon.png",
      connection: "incompatible" as const,
      active: false,
      signedIn: false,
      notificationSummary: {
        state: "stale" as const,
        unreadCount: 4,
        importantUnreadCount: 1,
      },
    },
  ],
  aggregate: {
    unreadCount: 3,
    importantUnreadCount: 2,
    unavailableServerCount: 1,
  },
}));
const switchToMock = mock(async () => ({ ok: true as const }));
const addMock = mock(async () => ({ ok: true as const, url: "https://new.example" }));
const forgetMock = mock(async () => ({
  ok: true as const,
  fallbackFailed: false,
  landedEmpty: false,
}));
const unsubscribeMock = mock(() => {});

let panel: (typeof import("../../src/modes/servers/ServersPanel"))["ServersPanel"];
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
        switchTo: switchToMock,
        add: addMock,
        forget: forgetMock,
        onChanged: () => unsubscribeMock,
      },
    },
  }));
  ({ ServersPanel: panel } = await import("../../src/modes/servers/ServersPanel"));
});

beforeEach(() => {
  listMock.mockClear();
  switchToMock.mockClear();
  addMock.mockClear();
  forgetMock.mockClear();
  unsubscribeMock.mockClear();
});

afterAll(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  const globals = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(priorGlobals)) globals[key] = value;
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  mock.restore();
});

async function renderPanel(activeSession = true) {
  const container = happyWindow.document.createElement("div");
  happyWindow.document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(panel, { activeSession, onCollapse: () => {} }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

describe("ServersPanel", () => {
  test.each([false, true])("connects a second server with only one saved server (signedIn=%s)", async (signedIn) => {
    listMock.mockImplementationOnce(async () => ({
      servers: [{
        url: "https://alpha.example",
        iconUrl: "",
        connection: "live" as const,
        active: true,
        signedIn,
        notificationSummary: {
          state: "fresh" as const,
          unreadCount: 0,
          importantUnreadCount: 0,
        },
      }],
      aggregate: { unreadCount: 0, importantUnreadCount: 0, unavailableServerCount: 0 },
    }));
    const container = await renderPanel();
    expect(container.querySelectorAll('[data-testid="servers-panel-row"]')).toHaveLength(1);
    const connect = container.querySelector<HTMLButtonElement>('[data-testid="servers-panel-add"]');
    expect(connect).not.toBeNull();
    expect(connect?.textContent).toContain("Connect to server…");
    expect(connect?.disabled).toBe(false);

    await act(async () => {
      connect?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(addMock).toHaveBeenCalledTimes(1);
  });

  test("does not list or subscribe while inactive, then refreshes exactly once on activation", async () => {
    const container = await renderPanel(false);
    expect(listMock).not.toHaveBeenCalled();
    expect(unsubscribeMock).not.toHaveBeenCalled();

    await act(async () => {
      root?.render(createElement(panel, { activeSession: true, onCollapse: () => {} }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(unsubscribeMock).not.toHaveBeenCalled();

    await act(async () => root?.unmount());
    root = null;
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="servers-panel"]')).toBeNull();
  });

  test("shows non-active server attention while keeping active-server totals accessible", async () => {
    const container = await renderPanel();
    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("Primary workspace");
    expect(container.textContent).toContain("Active");
    expect(container.textContent).toContain("beta.example");
    expect(container.textContent).toContain("Server update required");
    expect(container.querySelector('[data-testid="servers-panel-row"][data-active="true"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="servers-panel-aggregate-attention"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="servers-panel-aggregate-summary"]')?.textContent,
    ).toBe("Servers: 3 unread messages, 2 important messages. 1 server is unavailable and excluded");
    const rows = container.querySelectorAll<HTMLElement>('[data-testid="servers-panel-row"]');
    const active = rows[0]!;
    const nonActive = rows[1]!;
    expect(active.querySelector('[data-testid="servers-panel-row-attention"]')).toBeNull();
    expect(active.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Alpha. Primary workspace. alpha.example. Active. Alpha: 3 unread messages, 2 important messages",
    );
    expect(nonActive.querySelector('[data-testid="servers-panel-row-attention"]')?.textContent).toBe("1");
    expect(
      nonActive.querySelector('[data-testid="servers-panel-row-attention"]')?.getAttribute("data-stale"),
    ).toBe("true");
    expect(nonActive.querySelector("button")?.getAttribute("aria-label")).toBe(
      "beta.example. Server update required. Last known — beta.example: 4 unread messages, 1 important message",
    );
    expect(container.textContent).toContain("Last known");
  });

  test("does not claim an inactive server requires sign-in when auth has not been loaded", async () => {
    listMock.mockImplementationOnce(async () => ({
      servers: [
        {
          url: "https://alpha.example", iconUrl: "", connection: "live" as const,
          active: true, signedIn: true,
          notificationSummary: { state: "fresh" as const, unreadCount: 0, importantUnreadCount: 0 },
        },
        {
          url: "https://beta.example", iconUrl: "", connection: "live" as const,
          active: false, signedIn: false,
          notificationSummary: { state: "fresh" as const, unreadCount: 0, importantUnreadCount: 0 },
        },
      ],
      aggregate: { unreadCount: 0, importantUnreadCount: 0, unavailableServerCount: 0 },
    }));
    const container = await renderPanel();
    const rows = container.querySelectorAll<HTMLElement>('[data-testid="servers-panel-row"]');
    expect(rows[0]?.textContent).toContain("Active");
    expect(rows[1]?.textContent).toContain("Live");
    expect(rows[1]?.textContent).not.toContain("Sign-in required");
  });

  test("connect footer adds and row click switches", async () => {
    const container = await renderPanel();
    const rows = container.querySelectorAll<HTMLElement>('[data-testid="servers-panel-row"]');
    await act(async () => {
      rows[1]?.querySelector("button")?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(switchToMock).toHaveBeenCalledWith("https://beta.example");
    // Main flips authority before resolving switchTo. The initiating renderer
    // is now inactive and must not issue a follow-up privileged list call.
    expect(listMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      (container.querySelector('[data-testid="servers-panel-add"]') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Connect to server…");
  });

  test("keeps the active row and surfaces typed switch failures", async () => {
    switchToMock.mockImplementationOnce(async () => ({ ok: false as const, reason: "incompatible" as const }));
    const container = await renderPanel();
    const rows = container.querySelectorAll<HTMLElement>('[data-testid="servers-panel-row"]');
    await act(async () => {
      rows[1]?.querySelector("button")?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-testid="servers-panel-row"][data-active="true"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("server update");
  });

  test("always renders hostname/URL as a visible line even when a description exists", async () => {
    const container = await renderPanel();
    const rows = container.querySelectorAll<HTMLElement>('[data-testid="servers-panel-row"]');
    // Alpha has a description ("Primary workspace"); its host must still render.
    const alpha = rows[0]!;
    expect(alpha.textContent).toContain("Primary workspace");
    expect(alpha.textContent).toContain("alpha.example");
    expect(
      alpha.querySelectorAll('[data-testid="servers-panel-row-host"]').length,
    ).toBe(1);
    // Beta has no description; its host line still renders.
    const beta = rows[1]!;
    expect(beta.textContent).toContain("beta.example");
    expect(
      beta.querySelectorAll('[data-testid="servers-panel-row-host"]').length,
    ).toBe(1);
  });

  test("contains the real Lantern House identity at the useful panel width and keeps full values discoverable", async () => {
    const lanternDescription = "A small crew of people and machine people building useful things together.";
    listMock.mockImplementationOnce(async () => ({
      servers: [
        {
          url: "https://lantern.example",
          name: "Lantern House",
          description: lanternDescription,
          iconUrl: "",
          connection: "live" as const,
          active: false,
          signedIn: true,
          notificationSummary: {
            state: "fresh" as const,
            unreadCount: 1,
            importantUnreadCount: 1,
          },
        },
      ],
      aggregate: { unreadCount: 1, importantUnreadCount: 1, unavailableServerCount: 0 },
    }));
    const container = await renderPanel();
    const panelElement = container.querySelector<HTMLElement>('[data-testid="servers-panel"]')!;
    const scroller = panelElement.querySelector<HTMLElement>(':scope > div')!;
    const row = panelElement.querySelector<HTMLElement>('[data-testid="servers-panel-row"]')!;
    const switchButton = row.querySelector<HTMLButtonElement>('button')!;
    const identity = row.querySelector<HTMLElement>('[data-testid="servers-panel-row-name"]')!.parentElement!;
    const name = row.querySelector<HTMLElement>('[data-testid="servers-panel-row-name"]')!;
    const description = row.querySelector<HTMLElement>('[data-testid="servers-panel-row-description"]')!;
    const host = row.querySelector<HTMLElement>('[data-testid="servers-panel-row-host"]')!;

    // Happy DOM does not perform text layout, so exercise the rendered
    // containment primitives that make Tailwind's `truncate` effective in a
    // real 360 px panel instead of relying on a source-text assertion.
    expect(panelElement.className).toContain("min-w-0");
    expect(scroller.className).toContain("min-w-0");
    expect(scroller.className).toContain("overflow-x-hidden");
    expect(row.className).toContain("min-w-0");
    expect(row.className).toContain("max-w-full");
    expect(switchButton.className).toContain("min-w-0");
    expect(identity.className).toContain("min-w-0");
    expect(identity.className).toContain("overflow-hidden");
    for (const field of [name, description, host]) {
      expect(field.className).toContain("truncate");
      expect(field.className).toContain("block");
    }

    expect(name.getAttribute("title")).toBe("Lantern House");
    expect(description.textContent).toBe(lanternDescription);
    expect(description.getAttribute("title")).toBe(lanternDescription);
    expect(host.getAttribute("title")).toBe("lantern.example");
    expect(switchButton.getAttribute("aria-label")).toBe(
      `Lantern House. ${lanternDescription}. lantern.example. Live. Lantern House: 1 unread message, 1 important message`,
    );
    expect(row.querySelector('[data-testid="servers-panel-row-attention"]')).not.toBeNull();
    expect(row.querySelector('[data-testid="servers-panel-overflow"]')).not.toBeNull();
  });

  test("uses a sibling overflow button and confirms Forget in a renderer modal", async () => {
    const container = await renderPanel();
    const row = container.querySelector('[data-testid="servers-panel-row"]')!;
    const overflow = row.querySelector<HTMLButtonElement>('[data-testid="servers-panel-overflow"]');
    expect(overflow).not.toBeNull();
    expect(row.querySelector("button button")).toBeNull();

    await act(async () => {
      overflow?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      (container.querySelector('[data-testid="servers-panel-forget-menu-item"]') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[role="dialog"]')?.textContent ?? "").toContain("saved sign-in");
    expect(container.querySelector('[role="dialog"]')?.textContent ?? "").toContain("browsing data");

    await act(async () => {
      (container.querySelector('[data-testid="servers-panel-forget-confirm"]') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(forgetMock).toHaveBeenCalledWith("https://alpha.example");
  });
});
