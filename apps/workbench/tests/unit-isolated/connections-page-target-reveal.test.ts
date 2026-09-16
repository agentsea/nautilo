import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, useEffect } from "react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

let resolveMcpLoad: ((servers: []) => void) | null = null;
const fetchMcpServers = mock(() => new Promise<[]>(resolve => { resolveMcpLoad = resolve; }));

mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { isVerified: true } }),
}));
mock.module("../../src/contexts/room-navigation-context", () => ({
  useRoomNavigation: () => ({ refreshRooms: async () => undefined, setActiveRoom: () => undefined }),
}));
mock.module("../../src/lib/api", () => ({
  apiClient: {
    listConnectedApps: async () => ({
      status: "ok",
      scopeRoomId: "77777777-7777-4777-8777-777777777777",
      apps: [],
    }),
    listConnectedWebAccounts: async () => ({ accounts: [] }),
  },
}));
mock.module("../../src/lib/mcp-servers-api", () => ({
  fetchMcpServers,
  fetchMcpServerTools: async () => [],
  deleteMcpServer: async () => undefined,
  checkLocalMcpServer: async () => undefined,
  setMcpServerEnabled: async () => undefined,
  setMcpServerToolEnabled: async () => undefined,
}));
mock.module("../../src/pages/connections/github-cli-connection-section", () => ({
  GitHubCliConnectionSection: () => null,
}));
mock.module("../../src/pages/settings/sections/integrations-section", () => ({
  IntegrationsSection: () => null,
}));
mock.module("../../src/pages/connections/notion-connection-section", () => ({
  ConnectedAppConnectionSection: () => null,
}));

const { ConnectionsPage } = await import("../../src/pages/connections/connections-page");

let navigateTo: ReturnType<typeof useNavigate> | null = null;
const focusedAnchorIds: string[] = [];
const focusDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus");
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);
const scrolledAnchorIds: string[] = [];

function NavigationCapture() {
  const navigate = useNavigate();
  useEffect(() => { navigateTo = navigate; }, [navigate]);
  return null;
}

function renderConnections(entry: string) {
  return render(createElement(
    MemoryRouter,
    { initialEntries: [entry] },
    createElement(NavigationCapture),
    createElement(ConnectionsPage),
  ));
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  navigateTo = null;
  focusedAnchorIds.length = 0;
  scrolledAnchorIds.length = 0;
  resolveMcpLoad = null;
  fetchMcpServers.mockClear();
  fetchMcpServers.mockImplementation(() => new Promise<[]>(resolve => { resolveMcpLoad = resolve; }));
  Object.defineProperty(HTMLElement.prototype, "focus", {
    configurable: true,
    value(this: HTMLElement) { focusedAnchorIds.push(this.id); },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value(this: HTMLElement) { scrolledAnchorIds.push(this.id); },
  });
});

afterAll(() => {
  if (focusDescriptor) Object.defineProperty(HTMLElement.prototype, "focus", focusDescriptor);
  else delete (HTMLElement.prototype as Partial<HTMLElement>)["focus"];
  if (scrollIntoViewDescriptor) {
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollIntoView",
      scrollIntoViewDescriptor,
    );
  } else {
    delete (HTMLElement.prototype as Partial<HTMLElement>)["scrollIntoView"];
  }
  mock.restore();
  cleanup();
});

describe("Connections target reveals", () => {
  test.each([
    ["/connections#local-mcp", "local-mcp"],
  ])("focuses %s without waiting for unrelated MCP loading", async (entry, anchorId) => {
    const view = renderConnections(entry);
    expect(view.getByText("Loading local MCPs…")).toBeTruthy();
    await waitFor(() => expect(focusedAnchorIds).toContain(anchorId));

    resolveMcpLoad?.([]);
    await view.findByRole("heading", { name: "Connections" });
  });

  test("opens and focuses Google in the fixed inspector without scrolling the catalogue", async () => {
    const view = renderConnections("/connections#apps-and-accounts");
    resolveMcpLoad?.([]);
    await view.findByRole("heading", { name: "Connections" });

    fireEvent.click(view.getByRole("button", { name: "Google Workspace, Checking" }));
    await view.findByRole("complementary", {
      name: "Google Workspace connection details",
    });

    expect(scrolledAnchorIds).not.toContain("google");
    expect(focusedAnchorIds).toContain("google");
  });

  test.each([
    ["/connections#ssh", "ssh"],
    ["/connections#codex", "codex"],
  ])("uses Router navigation to focus repeated %s reveals", async (href, anchorId) => {
    const view = renderConnections("/connections");
    resolveMcpLoad?.([]);
    await view.findByRole("heading", { name: "Connections" });
    await waitFor(() => expect(navigateTo).not.toBeNull());

    await act(async () => { navigateTo?.(href); });
    await waitFor(() => expect(focusedAnchorIds.filter(id => id === anchorId)).toHaveLength(1));
    await act(async () => { navigateTo?.(href); });
    await waitFor(() => expect(focusedAnchorIds.filter(id => id === anchorId)).toHaveLength(2));
  });

  test("keeps the focused SSH reveal visibly ringed", async () => {
    const view = renderConnections("/connections#ssh");
    resolveMcpLoad?.([]);
    await view.findByRole("heading", { name: "Connections" });
    const ssh = view.getByTestId("structured-ssh-connection");
    expect(ssh.className).toContain("focus:ring-2");
    expect(ssh.className).toContain("focus:ring-accent");
  });
});
