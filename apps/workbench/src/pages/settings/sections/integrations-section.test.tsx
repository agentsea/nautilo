import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { CapabilitySlug } from "@nautilo/types";

const realUseAuth = await import("../../../hooks/use-auth");
const realDesktop = await import("../../../lib/desktop");
const realFetch = globalThis.fetch;

let viewerCaps: CapabilitySlug[] = [];
let serverConfigured = true;
let serverProviderSetupStatus: "managed" | "setup_required" | "ready" = "ready";
let serverCanManageProviderSetup = false;
let serverClientId: string | undefined = "server-only-client-id…";
let desktopHealthy = true;
let desktopAccounts = ["human@example.com"];

const connectMock = mock(async () => ({ ok: true }));
const disconnectMock = mock(async () => ({ ok: true }));
const authStatusMock = mock(async () => ({
  healthy: desktopHealthy,
  connectedAccounts: desktopAccounts,
}));
const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
  const path = typeof input === "string" ? input : input.toString();
  if (path === "/api/integrations/google/status") {
    return Response.json({
      configured: serverConfigured,
      providerSetupStatus: serverProviderSetupStatus,
      canManageProviderSetup: serverCanManageProviderSetup,
      ...(serverCanManageProviderSetup && serverClientId
        ? { clientId: serverClientId }
        : {}),
    });
  }
  if (path === "/api/integrations/google/oauth-client" && init?.method === "POST") {
    serverConfigured = true;
    serverProviderSetupStatus = "ready";
    serverClientId = "uploaded-client…";
    return Response.json({ configured: true, clientId: serverClientId });
  }
  throw new Error(`Unexpected Google integration request: ${path}`);
});

mock.module("../../../hooks/use-auth", () => ({
  useAuth: () => ({
    viewer: {
      role: viewerCaps.includes("manage_connection_providers") ? "admin" : "member",
      label: "Google Test Viewer",
      userIdentity: null,
      sessionUserId: "google-test-viewer",
      sessionActorId: "google-test-actor",
      isVerified: true,
      capabilities: viewerCaps,
      features: { office: { enabled: false } },
      staleWhoami: false,
      displayName: "Google Test Viewer",
      handle: "google-test-viewer",
    },
    session: {
      state: "signed-in" as const,
      signIn: async () => {},
      signOut: async () => {},
      getAccessToken: async () => "token",
    },
  }),
}));

mock.module("../../../lib/desktop", () => ({
  isDesktop: true,
  desktopAPI: {
    googleWorkspace: {
      authStatus: authStatusMock,
      connect: connectMock,
      disconnect: disconnectMock,
    },
  },
}));

const { IntegrationsSection } = await import("./integrations-section");

afterAll(() => {
  mock.module("../../../hooks/use-auth", () => realUseAuth);
  mock.module("../../../lib/desktop", () => realDesktop);
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  viewerCaps = [];
  serverConfigured = true;
  serverProviderSetupStatus = "ready";
  serverCanManageProviderSetup = false;
  serverClientId = "server-only-client-id…";
  desktopHealthy = true;
  desktopAccounts = ["human@example.com"];
  authStatusMock.mockClear();
  connectMock.mockClear();
  disconnectMock.mockClear();
  fetchMock.mockClear();
});

describe("IntegrationsSection", () => {
  test("shows one coherent connected-account state without another email form", async () => {
    const view = render(<IntegrationsSection />);

    await waitFor(() => {
      expect(view.getByText("Connected")).toBeTruthy();
      expect(view.getByText("Your Google account")).toBeTruthy();
      expect(view.getByText("human@example.com")).toBeTruthy();
    });

    expect(view.queryByRole("button", { name: /client JSON/ })).toBeNull();
    expect(view.queryByText(/OAuth client server-only-client-id/)).toBeNull();
    expect(view.queryByLabelText("Google email to connect")).toBeNull();
    expect(view.queryByRole("button", { name: "Manage" })).toBeNull();
    expect(view.getByRole("button", { name: "Change account" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Disconnect" })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Change account" }));
    await waitFor(() => {
      expect(view.getByLabelText("Google email to connect")).toBeTruthy();
    });
  });

  test("shows a deliberate account form only when no Google account is connected", async () => {
    desktopHealthy = false;
    desktopAccounts = [];
    const view = render(<IntegrationsSection />);

    await waitFor(() => {
      expect(view.getByText("Connect your Google account")).toBeTruthy();
    });
    expect(view.getByLabelText("Google email to connect")).toBeTruthy();
    expect(view.getByRole("button", { name: "Continue with Google" })).toBeTruthy();
    expect(view.getByText(/does not need to match your Nautilo name or login/)).toBeTruthy();
  });

  test("reconnects the remembered account without asking for another email", async () => {
    desktopHealthy = false;
    connectMock.mockImplementationOnce(async () => {
      desktopHealthy = true;
      return { ok: true };
    });
    const view = render(<IntegrationsSection />);

    await waitFor(() => {
      expect(view.getByText("Reconnect required")).toBeTruthy();
      expect(view.getByText("Reconnect your Google account")).toBeTruthy();
    });
    expect(view.queryByLabelText("Google email to connect")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => {
      expect(connectMock).toHaveBeenCalledWith({ email: "human@example.com" });
      expect(view.getByText("Google Workspace connected.")).toBeTruthy();
      expect(view.getByText("Connected")).toBeTruthy();
    });
  });

  test("turns Desktop OAuth failure codes into useful recovery copy", async () => {
    desktopHealthy = false;
    connectMock.mockImplementationOnce(async () => ({
      ok: false,
      reason: "google_auth_timed_out",
    }));
    const view = render(<IntegrationsSection />);

    await waitFor(() => {
      expect(view.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    });
    fireEvent.click(view.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => {
      expect(view.getByText("Google sign-in timed out. Try connecting again.")).toBeTruthy();
    });
  });

  test("disconnects the account through the existing desktop bridge", async () => {
    desktopAccounts = [];
    disconnectMock.mockImplementationOnce(async () => {
      desktopHealthy = false;
      desktopAccounts = [];
      return { ok: true };
    });
    desktopAccounts = ["human@example.com"];
    const view = render(<IntegrationsSection />);

    await waitFor(() => {
      expect(view.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    });
    fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => {
      expect(disconnectMock).toHaveBeenCalledWith({ email: "human@example.com" });
      expect(view.getByText("Connect your Google account")).toBeTruthy();
    });
  });

  test("tells an ordinary Human to wait without exposing provider setup", async () => {
    serverConfigured = false;
    serverProviderSetupStatus = "setup_required";
    serverClientId = undefined;
    const view = render(<IntegrationsSection />);

    await waitFor(() => {
      expect(view.getByText("Waiting for administrator")).toBeTruthy();
    });
    expect(view.getByText(/after an administrator finishes setup here/)).toBeTruthy();
    expect(view.queryByRole("button", { name: "Choose JSON" })).toBeNull();
    expect(view.queryByText("Google OAuth client JSON")).toBeNull();
  });

  test("lets a self-hosted owner upload the provider-authoritative JSON", async () => {
    viewerCaps = ["manage_connection_providers"];
    serverConfigured = false;
    serverProviderSetupStatus = "setup_required";
    serverCanManageProviderSetup = true;
    serverClientId = undefined;
    const view = render(<IntegrationsSection />);

    await waitFor(() => {
      expect(view.getByRole("button", { name: "Choose JSON" })).toBeTruthy();
    });
    expect(view.getByText(/shared server configuration/)).toBeTruthy();
    expect(view.getByText(/JSON itself does not contain email addresses/)).toBeTruthy();

    const input = view.getByTestId("google-oauth-client-input");
    fireEvent.change(input, {
      target: { files: [new File(["not json"], "client.txt", { type: "text/plain" })] },
    });
    expect(view.getByText("Upload a Google OAuth client JSON file (.json).")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    fireEvent.change(input, {
      target: { files: [new File(["{}"], "client.json", { type: "application/json" })] },
    });
    await waitFor(() => {
      expect(view.getByText("Server setup")).toBeTruthy();
      expect(view.getByText("Configured")).toBeTruthy();
      expect(view.getByRole("button", { name: "Replace JSON" })).toBeTruthy();
    });

    const upload = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(upload?.[1]).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer token" },
    });
    expect(upload?.[1]?.body).toBeInstanceOf(FormData);
  });

  test("hides all provider configuration in a managed deployment", async () => {
    viewerCaps = ["manage_connection_providers"];
    serverConfigured = true;
    serverProviderSetupStatus = "managed";
    serverCanManageProviderSetup = false;
    const view = render(<IntegrationsSection presentation="detail" />);

    await view.findByText("Your Google account");
    expect(view.getByText("human@example.com")).toBeTruthy();
    expect(view.queryByText("Server setup")).toBeNull();
    expect(view.queryByRole("button", { name: "Replace JSON" })).toBeNull();
    expect(view.queryByText(/OAuth client server-only-client-id/)).toBeNull();
  });

  test("shows the admitted Google surface and local custody with the account", async () => {
    const view = render(<IntegrationsSection presentation="detail" />);

    await view.findByText("Your Google account");
    expect(view.getByText("Docs, Sheets, Drive, and Slides")).toBeTruthy();
    expect(view.getByText("Gmail")).toBeTruthy();
    expect(view.getByText("Calendar")).toBeTruthy();
    expect(view.getByText(/Google account authorization stays in this desktop runtime/)).toBeTruthy();
  });
});
