/**
 * D220 Phase 1 — AdminPage route reachability + advisory gate behavior.
 */
import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import type { CapabilitySlug } from "@nautilo/types";

const realUseCan = await import("../../hooks/use-can");

let mockCaps: CapabilitySlug[] = ["read_server_settings"];
let mockManagedByCloud = false;

mock.module("../../hooks/use-can", () => ({
  useCan: () => (cap: CapabilitySlug) => mockCaps.includes(cap),
}));

mock.module("../../hooks/use-auth", () => ({
  useAuth: () => ({
    session: {
      state: "signed-in" as const,
      signIn: async () => {},
      signOut: async () => {},
      getAccessToken: async () => "token",
    },
    viewer: {
      role: "admin" as const,
      label: "Admin",
      userIdentity: "u",
      sessionUserId: "user-1",
      sessionActorId: "actor-1",
      isVerified: true,
      capabilities: mockCaps,
      staleWhoami: false,
    },
    groups: [],
  }),
}));

mock.module("../../contexts/posture-context", () => ({
  usePosture: () => ({
    posture: {
      securityLevel: "standard",
      deploymentMode: "local-self-host",
      backend: { kind: "bubblewrap", procSupported: true },
      networkPolicy: { mode: "isolated" },
      writablePaths: [],
      readOnlyPaths: [],
      capabilities: [],
    },
    loading: false,
    error: null,
    refresh: async () => {},
  }),
  canManageServerSecurity: () => true,
}));

mock.module("../../lib/api", () => ({
  apiClient: {
    getSetupStatus: async () => ({ providers: { managedByCloud: mockManagedByCloud } }),
    getServerProfile: async () => ({
      name: "Test Server",
      description: "A demo instance",
      icon: { kind: "preset" as const, id: "server-default" },
    }),
    getResearchProvider: async () => ({ provider: "auto" as const }),
    listInvites: async () => ({
      invites: [],
      page: {
        returned: 0,
        complete: true,
        hasMore: false,
        nextCursor: null,
        continuationAvailable: true,
      },
    }),
    listInvitableRooms: async () => [],
    createInvite: async () => { throw new Error("not used"); },
    revokeInvite: async () => { throw new Error("not used"); },
    listContentReports: async () => ({ reports: [], nextCursor: null }),
    actOnContentReport: async () => ({ reportId: "11111111-1111-4111-8111-111111111111", status: "closed" as const }),
    admin: {
      encryptionTransition: {
        get: async () => await new Promise<never>(() => {}),
        update: async () => { throw new Error("not used"); },
      },
    },
  },
}));

mock.module("../../lib/mcp-servers-api", () => ({
  fetchMcpServers: async () => [],
  fetchMcpServerTools: async () => [],
  createMcpServer: async () => { throw new Error("not used"); },
  updateMcpServer: async () => { throw new Error("not used"); },
  deleteMcpServer: async () => {},
  setMcpServerEnabled: async () => { throw new Error("not used"); },
  setMcpServerToolEnabled: async () => { throw new Error("not used"); },
}));

mock.module("../../lib/costs-api", () => ({
  fetchCostsSummary: async () => ({
    range: "30d",
    generatedAt: "2026-09-02T00:00:00.000Z",
    pricingVersion: "test",
    providerPricingVersion: "test",
    providerCoverage: [],
    totals: {
      calls: 0,
      providerOperations: 0,
      unknownProviderOperations: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      actualCostUsd: 0,
      totalCostUsd: 0,
    },
    byModel: [],
    byCallType: [],
    byProvider: [],
    byUser: [],
    timeSeries: [],
  }),
}));

const { AdminPage, adminSectionForHash } = await import("./admin-page");

afterAll(() => {
  mock.module("../../hooks/use-can", () => realUseCan);
});

beforeEach(() => {
  reapplyHappyDomGlobals();
  // AdminPage mirrors SettingsPage's IntersectionObserver scroll-spy.
  class MockIntersectionObserver {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).IntersectionObserver = MockIntersectionObserver;
  // happy-dom does not provide this browser-only scroll method.
  HTMLElement.prototype.scrollIntoView = () => {};
  cleanup();
  mockCaps = ["read_server_settings"];
  mockManagedByCloud = false;
});

describe("AdminPage", () => {
  test("resolves only known Admin hashes", () => {
    expect(adminSectionForHash("#server")).toBe("server");
    expect(adminSectionForHash("#stenographer")).toBe("stenographer");
    expect(adminSectionForHash("#reflection")).toBe("reflection");
    expect(adminSectionForHash("#search")).toBe("search");
    expect(adminSectionForHash("#costs")).toBe("costs");
    expect(adminSectionForHash("#invites")).toBe("invites");
    expect(adminSectionForHash("#reports")).toBe("reports");
    expect(adminSectionForHash("#encryption")).toBe("encryption");
    expect(adminSectionForHash("#unknown")).toBeNull();
    expect(adminSectionForHash("")).toBeNull();
  });

  test("renders the admin shell and section nav when the viewer holds an admin cap", () => {
    const view = render(
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>,
    );

    expect(view.getByTestId("admin-page")).toBeTruthy();
    expect(view.getByRole("heading", { name: "Server admin" })).toBeTruthy();
    expect(view.getByRole("navigation", { name: "Server admin sections" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Server" })).toBeTruthy();
    expect(view.getByTestId("admin-server-section")).toBeTruthy();
    expect(view.getByRole("button", { name: "Stenographer" })).toBeTruthy();
    expect(view.getByTestId("admin-stenographer-section")).toBeTruthy();
    expect(view.getByRole("button", { name: "Reflection" })).toBeTruthy();
    expect(view.getByTestId("admin-reflection-section")).toBeTruthy();
    expect(view.getByRole("button", { name: "Search" })).toBeTruthy();
    expect(view.getByTestId("admin-search-section")).toBeTruthy();
    expect(view.getByRole("button", { name: "Encryption" })).toBeTruthy();
    expect(view.getByTestId("admin-encryption-section")).toBeTruthy();
    expect(view.queryByTestId("access-control-entry-card")).toBeNull();
  });

  test("keeps the Server section reachable with server-settings authority alone", () => {
    mockCaps = ["manage_server_settings"];
    const view = render(
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>,
    );

    expect(view.getByRole("button", { name: "Server" })).toBeTruthy();
    expect(view.getByTestId("admin-server-section")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Google integrations" })).toBeNull();
  });

  test.each(["manage_server_settings", "manage_connection_providers"] as const)("shows API Keys to a self-managed viewer with %s", async (capability) => {
    mockCaps = [capability];
    const view = render(
      <MemoryRouter initialEntries={["/admin#provider-credentials"]}>
        <AdminPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(view.getByRole("button", { name: "API Keys" })).toBeTruthy();
    });
    expect(view.getByText(/Add or change API keys for this server/)).toBeTruthy();
  });

  test("fails closed for API Keys on cloud-managed deployments", async () => {
    mockCaps = ["manage_server_settings"];
    mockManagedByCloud = true;
    const view = render(
      <MemoryRouter initialEntries={["/admin#provider-credentials"]}>
        <AdminPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(view.getByRole("button", { name: "Server" })).toBeTruthy();
    });
    expect(view.queryByRole("button", { name: "API Keys" })).toBeNull();
    expect(view.container.querySelector("#provider-credentials")).toBeNull();
  });

  test("moves Costs into Server admin for billing managers", () => {
    mockCaps = ["manage_billing"];
    const view = render(
      <MemoryRouter initialEntries={["/admin#costs"]}>
        <AdminPage />
      </MemoryRouter>,
    );

    expect(view.getByRole("button", { name: "Costs" })).toBeTruthy();
    expect(view.container.querySelector("#costs")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Server" })).toBeNull();
  });

  test("keeps the approved server, provider, model, and service order", async () => {
    mockCaps = ["read_server_settings", "manage_server_settings", "manage_billing", "manage_members"];
    const view = render(
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      const labels = within(view.getByRole("navigation", { name: "Server admin sections" }))
        .getAllByRole("button")
        .map((button) => button.textContent);
      expect(labels.slice(0, 9)).toEqual([
        "Server",
        "API Keys",
        "Search",
        "Costs",
        "Models",
        "Memory",
        "Stenographer",
        "Reflection",
        "Users",
      ]);
    });
  });

  test("shows Access control in normal Admin navigation for an RBAC manager", () => {
    mockCaps = ["manage_members"];
    const view = render(
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>,
    );

    expect(view.queryByTestId("access-control-entry-card")).toBeNull();
    expect(within(view.getByRole("navigation", { name: "Server admin sections" }))
      .getByRole("link", { name: "Access control" }).getAttribute("href"))
      .toBe("/admin/access-control");
  });

  test("lets a custom Group-only manager reach Admin and Access control", () => {
    mockCaps = ["manage_groups"];
    const view = render(
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>,
    );

    expect(view.getByTestId("admin-page")).toBeTruthy();
    expect(view.queryAllByRole("button")).toHaveLength(0);
    expect(view.getByRole("link", { name: "Access control" }).getAttribute("href"))
      .toBe("/admin/access-control");
  });

  test("lets a content moderator reach only the Reports admin section", async () => {
    mockCaps = ["moderate_content_reports"];
    const view = render(
      <MemoryRouter initialEntries={["/admin#reports"]}>
        <AdminPage />
      </MemoryRouter>,
    );

    expect(view.getByRole("button", { name: "Reports" })).toBeTruthy();
    expect(view.getByTestId("admin-reports-section")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Server" })).toBeNull();
    await waitFor(() => expect(view.getByText("No open reports.")).toBeTruthy());
  });

  test("honors an allowed Admin hash after its scroll container mounts", async () => {
    mockCaps = ["manage_members"];
    const view = render(
      <MemoryRouter initialEntries={["/admin#invites"]}>
        <AdminPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(view.getByRole("button", { name: "Invites" }).getAttribute("aria-current"))
        .toBe("true");
    });
  });

  test("preserves scroll on permission refresh but honors subsequent navigation", async () => {
    const scroll = mock(() => {});
    HTMLElement.prototype.scrollIntoView = scroll;
    let navigate: ReturnType<typeof useNavigate>;
    function Page() {
      navigate = useNavigate();
      return <AdminPage />;
    }
    const tree = () => <MemoryRouter initialEntries={["/admin#encryption"]}><Page /></MemoryRouter>;
    const view = render(tree());
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
    mockCaps = [...mockCaps];
    view.rerender(tree());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(scroll).toHaveBeenCalledTimes(1);
    act(() => navigate("/admin#server"));
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(2));
    act(() => navigate("/admin#encryption"));
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(3));
  });

  test("shows server MCP administration only with server-security authority", () => {
    mockCaps = ["manage_server_security"];
    const view = render(
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>,
    );

    expect(view.getByRole("button", { name: "Server MCPs" })).toBeTruthy();
    expect(view.getByTestId("admin-official-mcps-section")).toBeTruthy();
    expect(view.getByText(/Nautilo does not install server dependencies/)).toBeTruthy();
    expect(view.queryByRole("button", { name: "Add server MCP" })).toBeNull();
  });

  test("shows Security then Encryption as separate navigation sections", () => {
    mockCaps = ["manage_server_security", "read_server_settings"];
    const view = render(
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>,
    );

    const navLabels = within(view.getByRole("navigation", { name: "Server admin sections" }))
      .getAllByRole("button")
      .map((button) => button.textContent);

    expect(navLabels.slice(-2)).toEqual(["Security", "Encryption"]);
    expect(view.queryByRole("button", { name: "Security ▸" })).toBeNull();
    expect(view.getByTestId("admin-security-section")).toBeTruthy();
    expect(view.getByTestId("admin-encryption-section")).toBeTruthy();
  });

  test("lets the dedicated Direct Mac policy manager reach Security without broader owner security authority", () => {
    mockCaps = ["manage_uncontained_host_commands"];
    const view = render(
      <MemoryRouter initialEntries={["/admin#security"]}>
        <AdminPage />
      </MemoryRouter>,
    );

    expect(view.getByRole("button", { name: "Security" })).toBeTruthy();
    expect(view.getByTestId("admin-security-section")).toBeTruthy();
    expect(view.getByRole("button", { name: "Manage server posture" })).toBeTruthy();
    expect(view.queryByRole("link", { name: "Open in Settings" })).toBeNull();
    expect(view.queryByRole("button", { name: "Server MCPs" })).toBeNull();
  });

  test("renders access-denied when the viewer holds no admin caps", () => {
    mockCaps = [];

    const view = render(
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>,
    );

    expect(view.getByTestId("admin-access-denied")).toBeTruthy();
    expect(view.getByText("You don't have access to server admin.")).toBeTruthy();
    expect(view.queryByTestId("admin-page")).toBeNull();
  });
});
