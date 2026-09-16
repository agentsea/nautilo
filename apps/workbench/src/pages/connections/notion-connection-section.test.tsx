import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ConnectedAppDescriptor } from "@nautilo/types";

const realUseAuth = await import("../../hooks/use-auth");
const realApi = await import("../../lib/api");
const realDesktop = await import("../../lib/desktop");
const openExternal = mock(async (_input: { url: string }) => undefined);
const startNotionConnection = mock(async () => ({
  status: "authorization_required" as const,
  providerId: "notion" as const,
  attemptId: "33333333-3333-4333-8333-333333333333",
  authorizationUrl: "https://authorization.example/notion",
  expiresAt: "2030-01-01T00:00:00.000Z",
}));
let descriptor: ConnectedAppDescriptor;
const listConnectedApps = mock(async () => ({
  status: "ok" as const,
  scopeRoomId: "77777777-7777-4777-8777-777777777777",
  apps: [descriptor],
}));
const inspectNotionConnection = mock(async () => ({
  status: "connecting" as const,
  providerId: "notion" as const,
  account: null,
  errorCode: null,
}));
const cancelNotionConnectionAttempt = mock(async () => ({
  status: "failed" as const,
  providerId: "notion" as const,
  account: null,
  errorCode: "authorization_restarted",
}));
const getNotionProviderSetup = mock(async () => ({
  providerId: "notion" as const,
  driverKind: "openconnector_local" as const,
  status: "setup_required" as const,
  callbackUrl: "http://127.0.0.1:3000/oauth/callback",
  oauthScopes: ["pages:read", "pages:write"],
  clientId: null,
  adminAuthenticationConfigured: false,
  lastErrorCode: null,
  lastVerifiedAt: null,
}));
const configureNotionProvider = mock(async () => getNotionProviderSetup());
const disconnectNotionConnection = mock(async () => ({ status: "disconnected" as const, providerId: "notion" as const }));
const startConnectedApp = mock(async (providerId: "notion" | "slack") => ({
  status: "authorization_required" as const,
  providerId,
  attemptId: "55555555-5555-4555-8555-555555555555",
  authorizationUrl: `https://authorization.example/${providerId}`,
  expiresAt: "2030-01-01T00:00:00.000Z",
}));
const inspectConnectedApp = mock(async (providerId: "notion" | "slack") => ({
  status: "connecting" as const,
  providerId,
  account: null,
  errorCode: null,
}));
const cancelConnectedAppAttempt = mock(async (providerId: "notion" | "slack") => ({
  status: "failed" as const,
  providerId,
  account: null,
  errorCode: "authorization_restarted",
}));
const getConnectedAppProviderSetup = mock(async (providerId: "notion" | "slack") => ({
  providerId,
  driverKind: "openconnector_local" as const,
  status: "setup_required" as const,
  callbackUrl: "http://127.0.0.1:3000/oauth/callback",
  oauthScopes: providerId === "slack" ? ["chat:write", "channels:read"] : ["pages:read", "pages:write"],
  clientId: null,
  adminAuthenticationConfigured: false,
  lastErrorCode: null,
  lastVerifiedAt: null,
}));
const configureConnectedAppProvider = mock(async (providerId: "notion" | "slack") =>
  getConnectedAppProviderSetup(providerId));
const disconnectConnectedApp = mock(async (providerId: "notion" | "slack") => ({
  status: "disconnected" as const,
  providerId,
}));

mock.module("../../hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { sessionUserId: "notion-test-viewer", userIdentity: null } }),
}));
mock.module("../../lib/api", () => ({
  apiClient: {
    listConnectedApps,
    startNotionConnection,
    inspectNotionConnection,
    cancelNotionConnectionAttempt,
    getNotionProviderSetup,
    configureNotionProvider,
    disconnectNotionConnection,
    startConnectedApp,
    inspectConnectedApp,
    cancelConnectedAppAttempt,
    getConnectedAppProviderSetup,
    configureConnectedAppProvider,
    disconnectConnectedApp,
  },
}));
mock.module("../../lib/desktop", () => ({
  isDesktop: true,
  desktopAPI: { browserControl: { openExternal } },
}));

const { ConnectedAppConnectionSection } = await import("./notion-connection-section");

function NotionConnectionSection(props: Omit<ComponentProps<typeof ConnectedAppConnectionSection>, "provider"> = {}) {
  return <ConnectedAppConnectionSection provider={descriptor} {...props} />;
}

function SlackConnectionSection(props: Omit<ComponentProps<typeof ConnectedAppConnectionSection>, "provider"> = {}) {
  return <ConnectedAppConnectionSection provider={descriptor} {...props} />;
}

function app(status: ConnectedAppDescriptor["status"]): ConnectedAppDescriptor {
  return {
    id: "notion",
    displayName: "Notion",
    description: "Search and read your workspace, and create pages with your approval.",
    searchTerms: ["workspace", "pages"],
    iconUrl: null,
    shortMark: "N",
    sortOrder: 20,
    lifecycle: "pilot",
    providerSetupUrl: "https://www.notion.so/profile/integrations",
    acceptsAdminToken: true,
    experimental: true,
    defaultEnabled: false,
    driverKind: "oomol_hosted",
    providerReady: true,
    providerSetupStatus: "managed",
    canManageProviderSetup: false,
    status,
    attemptId: null,
    account: status === "connected"
      ? { displayName: "Alex", username: "alex", email: null, avatarUrl: null, workspaceName: "Pilot Workspace", kind: "user" }
      : null,
    capabilities: [
      { operationId: "notion.search", label: "Search workspace", effect: "read", requiresApproval: false },
      { operationId: "notion.retrieve_page", label: "Read pages", effect: "read", requiresApproval: false },
      { operationId: "notion.create_page", label: "Create pages", effect: "write", requiresApproval: true },
    ],
    custodyLabel: "Credentials managed by Nautilo Cloud through OOMOL.",
    limitation: status === "connected" ? "Disconnect is temporarily managed by Nautilo Cloud." : null,
    lastErrorCode: null,
    revision: status === "connected" ? 0 : null,
  };
}

function slackApp(status: ConnectedAppDescriptor["status"]): ConnectedAppDescriptor {
  return {
    ...app(status),
    id: "slack",
    displayName: "Slack",
    description: "List and search conversations, read messages, and post with your approval.",
    searchTerms: ["conversations", "messages"],
    shortMark: "S",
    sortOrder: 30,
    providerSetupUrl: "https://api.slack.com/apps",
    account: status === "connected"
      ? { displayName: "Alex", username: "alex", email: null, avatarUrl: null, workspaceName: "Pilot Slack", kind: "user" }
      : null,
    capabilities: [
      { operationId: "slack.list_conversations", label: "List conversations", effect: "read", requiresApproval: false },
      { operationId: "slack.get_channel_messages", label: "Read recent messages", effect: "read", requiresApproval: false },
      { operationId: "slack.search_messages", label: "Search messages", effect: "read", requiresApproval: false },
      { operationId: "slack.post_message", label: "Post messages", effect: "write", requiresApproval: true },
    ],
  };
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  localStorage.clear();
  descriptor = app("not_connected");
  listConnectedApps.mockClear();
  startNotionConnection.mockClear();
  inspectNotionConnection.mockClear();
  cancelNotionConnectionAttempt.mockClear();
  getNotionProviderSetup.mockClear();
  configureNotionProvider.mockClear();
  disconnectNotionConnection.mockClear();
  startConnectedApp.mockClear();
  inspectConnectedApp.mockClear();
  cancelConnectedAppAttempt.mockClear();
  getConnectedAppProviderSetup.mockClear();
  configureConnectedAppProvider.mockClear();
  disconnectConnectedApp.mockClear();
  openExternal.mockClear();
});

describe("Slack connected-app reuse", () => {
  test("renders the curated Slack pack through the shared card/controller", async () => {
    descriptor = slackApp("connected");
    const onTryWithGenie = mock(async () => undefined);
    const view = render(<SlackConnectionSection presentation="detail" onTryWithGenie={onTryWithGenie} />);

    await view.findByText("Your Slack account");
    expect(view.getByText("List conversations")).toBeTruthy();
    expect(view.getByText("Read recent messages")).toBeTruthy();
    expect(view.getByText("Search messages")).toBeTruthy();
    expect(view.getByText("Post messages")).toBeTruthy();
    expect(view.getByText(/writes ask for approval and are never blindly retried/)).toBeTruthy();
  });

  test("uses the same administrator setup journey with Slack-specific metadata", async () => {
    descriptor = {
      ...slackApp("not_connected"),
      driverKind: "openconnector_local",
      providerReady: false,
      providerSetupStatus: "setup_required",
      canManageProviderSetup: true,
    };
    const view = render(<SlackConnectionSection presentation="detail" />);

    expect(await view.findByText("Server setup")).toBeTruthy();
    expect(view.getByText(/Register one Slack OAuth application/)).toBeTruthy();
    expect(view.getByRole("link", { name: "Open Slack setup" })).toBeTruthy();
    expect((await view.findByLabelText("OAuth scopes") as HTMLInputElement).value).toBe("chat:write channels:read");
    expect(getConnectedAppProviderSetup).toHaveBeenCalledWith("slack");
  });

  test("renders a catalog-supplied Canva provider through the shared setup drawer", async () => {
    descriptor = {
      ...slackApp("not_connected"),
      id: "canva",
      displayName: "Canva",
      description: "Find and manage approved Canva designs.",
      shortMark: "C",
      providerSetupUrl: "https://www.canva.com/developers/",
      capabilities: Array.from({ length: 13 }, (_, index) => ({
        operationId: `canva.operation_${index + 1}`,
        label: `Canva operation ${index + 1}`,
        effect: "read" as const,
        requiresApproval: false,
      })),
      driverKind: "openconnector_local",
      providerReady: false,
      providerSetupStatus: "setup_required",
      canManageProviderSetup: true,
    };
    getConnectedAppProviderSetup.mockImplementationOnce(async () => ({
      providerId: "canva",
      driverKind: "openconnector_local" as const,
      status: "setup_required" as const,
      callbackUrl: "http://127.0.0.1:3000/oauth/callback",
      oauthScopes: ["design:read", "design:write", "asset:read"],
      clientId: null,
      adminAuthenticationConfigured: false,
      lastErrorCode: null,
      lastVerifiedAt: null,
    }));
    const view = render(<ConnectedAppConnectionSection provider={descriptor} presentation="detail" />);

    expect(await view.findByText("Server setup")).toBeTruthy();
    expect(await view.findByDisplayValue("http://127.0.0.1:3000/oauth/callback")).toBeTruthy();
    expect((await view.findByLabelText("OAuth scopes") as HTMLInputElement).value).toBe("design:read design:write asset:read");
    expect(view.getByLabelText("Client ID")).toBeTruthy();
    expect(view.getByLabelText("Client secret")).toBeTruthy();
    expect(view.getByLabelText("OpenConnector admin token")).toBeTruthy();
    expect(view.getByRole("button", { name: "Save and verify" })).toBeTruthy();
  });
});

afterAll(() => {
  mock.module("../../hooks/use-auth", () => realUseAuth);
  mock.module("../../lib/api", () => realApi);
  mock.module("../../lib/desktop", () => realDesktop);
  cleanup();
});

describe("Notion connected-app card", () => {
  test("starts one durable attempt and opens OAuth in the OS default browser", async () => {
    const view = render(<NotionConnectionSection />);
    const connect = await view.findByRole("button", { name: "Connect Notion" });
    fireEvent.click(connect);
    await waitFor(() => expect(startConnectedApp).toHaveBeenCalledWith("notion"));
    expect(openExternal).toHaveBeenCalledWith({ url: "https://authorization.example/notion" });
    expect(view.getByText(/Finish signing in to Notion in your default browser/)).toBeTruthy();
    expect(view.getByText(/do not need to wait for this attempt to expire/)).toBeTruthy();
  });

  test("lets the Human terminate a stuck attempt and start over immediately", async () => {
    const view = render(<NotionConnectionSection />);
    fireEvent.click(await view.findByRole("button", { name: "Connect Notion" }));
    await waitFor(() => expect(startConnectedApp).toHaveBeenCalledTimes(1));

    fireEvent.click(await view.findByRole("button", { name: "Start over" }));

    await waitFor(() => expect(cancelConnectedAppAttempt).toHaveBeenCalledWith(
      "notion",
      "55555555-5555-4555-8555-555555555555",
    ));
    await waitFor(() => expect(startConnectedApp).toHaveBeenCalledTimes(2));
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  test("shows the full admitted pilot surface and honest custody limitation", async () => {
    descriptor = app("connected");
    const onTryWithGenie = mock(async () => undefined);
    const view = render(<NotionConnectionSection onTryWithGenie={onTryWithGenie} />);
    await view.findByText("Connected to Pilot Workspace as Alex");
    expect(view.getByText("Search workspace")).toBeTruthy();
    expect(view.getByText("Read pages")).toBeTruthy();
    expect(view.getByText("Create pages")).toBeTruthy();
    expect(view.getByText("Asks before writing")).toBeTruthy();
    expect(view.getByText("Credentials managed by Nautilo Cloud through OOMOL.")).toBeTruthy();
    expect(view.getByText("Disconnect is temporarily managed by Nautilo Cloud.")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Try with Genie" }));
    await waitFor(() => expect(onTryWithGenie).toHaveBeenCalledTimes(1));
  });

  test("morphs setup-required state between an ordinary user and an administrator", async () => {
    descriptor = {
      ...app("not_connected"),
      driverKind: "openconnector_local",
      providerReady: false,
      providerSetupStatus: "setup_required",
      canManageProviderSetup: false,
    };
    const ordinary = render(<NotionConnectionSection />);
    expect((await ordinary.findAllByText("Waiting for administrator")).length).toBeGreaterThan(0);
    expect(ordinary.getByText(/after an administrator finishes setup here/)).toBeTruthy();
    expect(ordinary.queryByLabelText("Client ID")).toBeNull();
    expect(ordinary.queryByRole("link", { name: "Open Notion setup" })).toBeNull();
    cleanup();

    descriptor = { ...descriptor, canManageProviderSetup: true };
    const administrator = render(<NotionConnectionSection />);
    expect((await administrator.findAllByText("Setup required")).length).toBeGreaterThan(0);
    expect(await administrator.findByDisplayValue("http://127.0.0.1:3000/oauth/callback")).toBeTruthy();
    expect(administrator.getByLabelText("Client ID")).toBeTruthy();
    expect(administrator.getByLabelText("Client secret")).toBeTruthy();
    expect(administrator.getByRole("button", { name: "Save and verify" })).toBeTruthy();
  });

  test("keeps managed provider configuration out of the personal detail", async () => {
    const view = render(<NotionConnectionSection presentation="detail" />);

    await view.findByText("Your Notion account");
    expect(view.getByRole("button", { name: "Connect Notion" })).toBeTruthy();
    expect(view.queryByText("Server setup")).toBeNull();
    expect(view.queryByLabelText("Client ID")).toBeNull();
    expect(view.queryByText(/OpenConnector/)).toBeNull();
  });

  test("shows configured local setup to an owner and reveals repair fields on demand", async () => {
    descriptor = {
      ...app("not_connected"),
      driverKind: "openconnector_local",
      providerSetupStatus: "ready",
      canManageProviderSetup: true,
    };
    const view = render(<NotionConnectionSection presentation="detail" />);

    await view.findByText("Your Notion account");
    expect(view.getByText("Server setup")).toBeTruthy();
    expect(view.getByText("Configured")).toBeTruthy();
    expect(view.queryByLabelText("Client secret")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Repair setup" }));
    expect(await view.findByLabelText("Client secret")).toBeTruthy();
    expect(view.getByRole("link", { name: "Open Notion setup" })).toBeTruthy();
  });

  test("lets an ordinary user connect on a ready local server without setup instructions", async () => {
    descriptor = {
      ...app("not_connected"),
      driverKind: "openconnector_local",
      providerSetupStatus: "ready",
      canManageProviderSetup: false,
      custodyLabel: "Credentials remain in this Nautilo server runtime.",
    };
    const view = render(<NotionConnectionSection presentation="detail" />);

    expect(await view.findByRole("button", { name: "Connect Notion" })).toBeTruthy();
    expect(view.queryByText("Server setup")).toBeNull();
    expect(view.queryByText(/OpenConnector/)).toBeNull();
    expect(view.queryByLabelText("Client ID")).toBeNull();
  });
});
