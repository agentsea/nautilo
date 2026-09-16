import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { McpServer } from "../../src/lib/mcp-servers-api";

let createCalls = 0;
let sendCalls = 0;
let refreshRoomCalls = 0;
let openRoomCalls = 0;
let createFailure: Error | null = null;
let refreshRoomFailure: Error | null = null;
let listedServers: McpServer[] = [];

mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { isVerified: true } }),
}));
mock.module("../../src/contexts/room-navigation-context", () => ({
  useRoomNavigation: () => ({
    refreshRooms: async () => {
      refreshRoomCalls += 1;
      if (refreshRoomFailure) throw refreshRoomFailure;
    },
    setActiveRoom: () => { openRoomCalls += 1; },
  }),
}));
mock.module("../../src/lib/api", () => ({
  apiClient: {
    listConnectedApps: async () => ({
      status: "ok",
      scopeRoomId: "77777777-7777-4777-8777-777777777777",
      apps: [],
    }),
    listConnectedWebAccounts: async () => ({ accounts: [] }),
    createRoom: async () => {
      createCalls += 1;
      if (createFailure) throw createFailure;
      return { id: "genie-room" };
    },
    sendRoomMessage: async () => { sendCalls += 1; },
  },
}));
mock.module("../../src/lib/mcp-servers-api", () => ({
  fetchMcpServers: async () => listedServers,
  fetchMcpServerTools: async () => [],
  deleteMcpServer: async () => undefined,
  checkLocalMcpServer: async () => undefined,
  setMcpServerEnabled: async () => undefined,
  setMcpServerToolEnabled: async () => undefined,
}));
mock.module("../../src/pages/connections/codex-connection-section", () => ({ CodexConnectionSection: () => null }));
mock.module("../../src/pages/connections/claude-connection-section", () => ({ ClaudeConnectionSection: () => null }));
mock.module("../../src/pages/connections/github-cli-connection-section", () => ({ GitHubCliConnectionSection: () => null }));
mock.module("../../src/pages/connections/notion-connection-section", () => ({
  ConnectedAppConnectionSection: () => null,
}));
mock.module("../../src/pages/settings/sections/integrations-section", () => ({ IntegrationsSection: () => null }));

const {
  ConnectionsPage,
  LocalMcpRow,
  sendConnectedAppTestToGenie,
} = await import("../../src/pages/connections/connections-page");

const revealedAnchorIds: string[] = [];
const focusDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus");
const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

const server: McpServer = {
  id: "mcp-1",
  name: "github",
  host: "relay-test",
  transportKind: "stdio",
  transport: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
  envPassthrough: ["GITHUB_TOKEN"],
  envLiteral: null,
  authRef: null,
  namespaceId: null,
  includeTools: null,
  excludeTools: null,
  enabled: true,
  trustTier: "standard",
  createdAt: "2026-08-08T10:00:00.000Z",
  updatedAt: "2026-08-08T10:00:00.000Z",
  health: "error",
  lastCheckStatus: "needs_attention",
  lastCheckFailureCode: "missing_environment",
  lastCheckMissingEnvironment: ["GITHUB_TOKEN"],
  lastCheckedAt: "2026-08-08T10:05:00.000Z",
};

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  createCalls = 0;
  sendCalls = 0;
  refreshRoomCalls = 0;
  openRoomCalls = 0;
  createFailure = null;
  refreshRoomFailure = null;
  listedServers = [];
  revealedAnchorIds.length = 0;
  Object.defineProperty(HTMLElement.prototype, "focus", {
    configurable: true,
    value(this: HTMLElement) { revealedAnchorIds.push(this.id); },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value(this: HTMLElement) { revealedAnchorIds.push(this.id); },
  });
});

afterAll(() => {
  if (focusDescriptor) Object.defineProperty(HTMLElement.prototype, "focus", focusDescriptor);
  if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollDescriptor);
  mock.restore();
});

describe("LocalMcpRow recovery", () => {
  test("sends a connected-app test into the exact Room that owns its connection", async () => {
    const sent: Array<{ roomId: string; content: string }> = [];
    const opened: string[] = [];
    await sendConnectedAppTestToGenie({
      provider: {
        displayName: "Canva",
        capabilities: [
          {
            operationId: "canva.list_designs",
            label: "List designs",
            effect: "read",
            requiresApproval: false,
          },
        ],
      } as never,
      scopeRoomId: "77777777-7777-4777-8777-777777777777",
      sendMessage: async (roomId, body) => { sent.push({ roomId, content: body.content }); },
      roomNavigation: {
        refreshRooms: async () => undefined,
        setActiveRoom: (roomId) => { opened.push(roomId); },
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.roomId).toBe("77777777-7777-4777-8777-777777777777");
    expect(sent[0]?.content).toContain("canva.list_designs");
    expect(opened).toEqual(["77777777-7777-4777-8777-777777777777"]);
  });

  test("uses one MCP section heading without a redundant inner title", async () => {
    const view = render(
      <MemoryRouter><ConnectionsPage /></MemoryRouter>,
    );

    expect(await view.findByRole("heading", { name: "MCP servers" })).toBeTruthy();
    expect(await view.findByRole("heading", { name: "Websites" })).toBeTruthy();
    expect(view.getByTestId("website-catalogue-bluesky")).toBeTruthy();
    expect(view.queryByRole("button", { name: /^Websites,/ })).toBeNull();
    expect(view.queryByRole("heading", { name: "MCPs on this machine" })).toBeNull();
    expect(view.getByText("Personal MCP connections available through this desktop.")).toBeTruthy();
  });

  test.each([
    ["/connections#google", "google"],
    ["/connections#local-mcp", "local-mcp"],
  ])("focuses %s after the Connections page completes async loading", async (entry, anchorId) => {
    const view = render(
      <MemoryRouter initialEntries={[entry]}>
        <ConnectionsPage />
      </MemoryRouter>,
    );

    await view.findByRole("heading", { name: "Connections" });
    await waitFor(() => expect(revealedAnchorIds).toContain(anchorId));
  });

  test("shows safe persistent failure evidence and exposes both recovery actions", () => {
    const onCheck = mock(() => undefined);
    const onFix = mock(() => undefined);
    const view = render(
      <LocalMcpRow
        server={server}
        busy={false}
        onToggle={() => undefined}
        onRemove={() => undefined}
        onCheck={onCheck}
        onFix={onFix}
        onChanged={() => undefined}
      />,
    );

    expect(view.getByText("Needs attention")).toBeTruthy();
    expect(view.getByText("Missing environment variables on this machine: GITHUB_TOKEN.")).toBeTruthy();
    expect(view.getByText(/^Checked /)).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Check again" }));
    fireEvent.click(view.getByRole("button", { name: "Fix with Genie" }));

    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(onFix).toHaveBeenCalledTimes(1);
  });

  test("shows a retry path after prerequisites become ready", () => {
    const view = render(
      <LocalMcpRow
        server={{
          ...server,
          lastCheckStatus: "ready",
          lastCheckFailureCode: null,
          lastCheckMissingEnvironment: [],
        }}
        busy={false}
        onToggle={() => undefined}
        onRemove={() => undefined}
        onCheck={() => undefined}
        onFix={() => undefined}
        onChanged={() => undefined}
      />,
    );

    expect(view.getByText("Prerequisites ready")).toBeTruthy();
    expect(view.getByText(/required launcher and environment/i)).toBeTruthy();
    expect(view.getByRole("button", { name: "Fix with Genie" })).toBeTruthy();
  });

  test("ready/null persisted evidence can explicitly launch Fix with Genie", async () => {
    listedServers = [{ ...server, lastCheckStatus: "ready", lastCheckFailureCode: null, lastCheckMissingEnvironment: [] }];
    const view = render(
      <MemoryRouter><ConnectionsPage /></MemoryRouter>,
    );
    fireEvent.click(await view.findByRole("button", { name: "Fix with Genie" }));
    await waitFor(() => expect(openRoomCalls).toBe(1));
    expect(createCalls).toBe(1);
    expect(sendCalls).toBe(1);
  });

  test("only the explicit setup button creates, sends, refreshes, and opens one Room despite a double click", async () => {
    const view = render(
      <MemoryRouter><ConnectionsPage /></MemoryRouter>,
    );
    const button = await view.findByRole("button", { name: "Set up with Genie" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(openRoomCalls).toBe(1));
    expect(createCalls).toBe(1);
    expect(sendCalls).toBe(1);
    expect(refreshRoomCalls).toBe(1);
  });

  test("shows fixed retryable and actionable partial-send feedback without replaying", async () => {
    const secret = "sk-do-not-echo-abcdefghijk";
    createFailure = new Error(secret);
    const normal = render(<MemoryRouter><ConnectionsPage /></MemoryRouter>);
    fireEvent.click(await normal.findByRole("button", { name: "Set up with Genie" }));
    await waitFor(() => expect(normal.getByRole("alert").textContent).toBe("Could not start Genie setup. Try again."));
    expect(normal.getByRole("alert").textContent).not.toContain(secret);
    expect(createCalls).toBe(1);
    expect(sendCalls).toBe(0);
    normal.unmount();

    createFailure = null;
    refreshRoomFailure = new Error(secret);
    const partial = render(<MemoryRouter><ConnectionsPage /></MemoryRouter>);
    fireEvent.click(await partial.findByRole("button", { name: "Set up with Genie" }));
    await waitFor(() => expect(partial.getByRole("alert").textContent).toBe(
      "Message sent to Genie, but the Room could not open. Refresh your Rooms list to find it; do not resend.",
    ));
    expect(partial.getByRole("alert").textContent).not.toContain(secret);
    expect(createCalls).toBe(2);
    expect(sendCalls).toBe(1);
    expect(openRoomCalls).toBe(0);
  });
});
