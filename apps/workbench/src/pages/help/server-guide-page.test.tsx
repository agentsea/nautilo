import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { SetupStatusResponse } from "@nautilo/api-client/browser";
import type { KeyReport, KeyStatus } from "@nautilo/config-guard";
import type { CapabilitySlug } from "@nautilo/types";
import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";

const realUseCan = await import("../../hooks/use-can");

let mockCaps: CapabilitySlug[] = [
  "read_server_settings",
  "manage_connection_providers",
  "manage_members",
];

let setupStatus: SetupStatusResponse;
let setupStatusFails = false;
let keySummaryFails = false;
let keySummaryPromise: Promise<{ keys: KeyReport[]; hasLlm: boolean }> | null = null;
let keyReports: KeyReport[] = [];
const getSetupStatusMock = mock(async () => {
  if (setupStatusFails) throw new Error("offline");
  return setupStatus;
});
const getKeySummaryMock = mock(async () => {
  if (keySummaryPromise) return keySummaryPromise;
  if (keySummaryFails) throw new Error("key endpoint offline");
  return { keys: keyReports, hasLlm: true };
});

function keyReport(id: string, name: string, status: KeyStatus, masked: string | null = null): KeyReport {
  return {
    id,
    name,
    envVar: `${id.toUpperCase()}_API_KEY`,
    category: "llm",
    purpose: `${name} access`,
    required: false,
    signupUrl: "https://provider.example.test",
    formatHint: "Provider key",
    status,
    masked,
    hint: null,
  };
}

mock.module("../../hooks/use-can", () => ({
  useCan: () => (cap: CapabilitySlug) => mockCaps.includes(cap),
}));

mock.module("../../lib/api", () => ({
  apiClient: {
    getSetupStatus: getSetupStatusMock,
    getKeySummary: getKeySummaryMock,
    admin: { users: { list: async () => ({ users: [], nextCursor: null }) } },
    listMyInvites: async () => ({ invites: [] }),
  },
}));

const { ServerGuidePage } = await import("./server-guide-page");
const { isServerGuideCompleted, isServerGuideSessionActive, endServerGuideSession } = await import(
  "../../lib/server-guide-session"
);

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

afterAll(() => {
  mock.module("../../hooks/use-can", () => realUseCan);
});

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  mockCaps = ["read_server_settings", "manage_connection_providers", "manage_members"];
  setupStatusFails = false;
  keySummaryFails = false;
  keySummaryPromise = null;
  keyReports = [
    keyReport("openai", "OpenAI", "verified", "sk-secret-mask"),
    keyReport("elevenlabs", "ElevenLabs", "missing"),
    keyReport("tavily", "Tavily", "present"),
  ];
  setupStatus = {
    instanceId: "instance-1",
    serverUrl: "https://server.example.test",
    deploymentMode: "local-self-host",
    setupState: "ready",
    claimRequired: false,
    providers: {
      hasLlm: true,
      hasVoice: true,
      hasSearch: true,
      hasConversion: true,
      managedByCloud: false,
    },
    serverProfile: {
      name: "Server",
      icon: { kind: "preset", id: "legacy-default" },
      reviewedAt: null,
    },
  };
  getSetupStatusMock.mockClear();
  getKeySummaryMock.mockClear();
  localStorage.clear();
  endServerGuideSession();
});

describe("ServerGuidePage", () => {
  test("renders the checked-in administrator journey in its fixed order", async () => {
    const view = render(
      <MemoryRouter>
        <ServerGuidePage />
      </MemoryRouter>,
    );

    expect(view.getByTestId("server-guide-page")).toBeTruthy();
    await waitFor(() => expect(isServerGuideSessionActive()).toBe(true));
    expect(view.getByRole("heading", { name: "Finish setting up your server" })).toBeTruthy();
    expect(within(view.getByRole("list", { name: "Server setup steps" }))
      .getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("Configure server"),
      expect.stringContaining("API Keys"),
      expect.stringContaining("Invite team"),
      expect.stringContaining("Get Desktop"),
      expect.stringContaining("I'm all set — take me to chat"),
    ]);
    expect(view.getByRole("link", { name: "Configure server" }).getAttribute("href"))
      .toBe("/admin#server");
    expect(view.getByRole("link", { name: "API Keys" }).getAttribute("href"))
      .toBe("/admin#provider-credentials");
    expect(view.getByRole("link", { name: "Invite team" }).getAttribute("href"))
      .toBe("/admin#invites");
    expect(view.getByRole("link", { name: "Get Desktop" }).getAttribute("href"))
      .toBe("https://nautilo.ai/download");
    expect(view.getByRole("link", { name: "Get Desktop" }).getAttribute("target"))
      .toBe("_blank");
    expect(view.getByRole("link", { name: "Get Desktop" }).getAttribute("rel"))
      .toContain("noopener");
    expect(view.queryByRole("link", { name: "Use web" })).toBeNull();
    expect(view.getByRole("button", { name: "I'm all set — take me to chat" })).toBeTruthy();
    await waitFor(() => expect(view.getByTestId("server-guide-application-url").textContent)
      .toBe("https://server.example.test"));
    const desktopStep = view.getByTestId("server-guide-action-get-desktop");
    expect(desktopStep.textContent).toContain("enter this address in the Server URL field");
    expect(desktopStep.textContent).toContain("choose Connect, then continue through secure sign-in");
    await waitFor(() => expect(view.getByTestId("provider-key-coverage")).toBeTruthy());
    expect(view.getByTestId("server-guide-progress-configure-server").textContent)
      .toContain("Review needed");
    expect(view.getByTestId("server-guide-progress-configure-providers").textContent)
      .toContain("Models ready");
  });

  test("refreshes durable progress when the guide regains focus", async () => {
    const view = render(
      <MemoryRouter>
        <ServerGuidePage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(view.getByTestId("server-guide-progress-configure-server").textContent)
      .toContain("Review needed"));
    setupStatus = {
      ...setupStatus,
      serverProfile: {
        ...setupStatus.serverProfile!,
        reviewedAt: "2026-08-10T20:00:00.000Z",
      },
    };
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(view.getByTestId("server-guide-progress-configure-server").textContent)
      .toContain("Reviewed"));
    expect(getSetupStatusMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(getKeySummaryMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("does not turn unavailable management permissions into a dead or misleading link", async () => {
    mockCaps = [];
    const view = render(
      <MemoryRouter>
        <ServerGuidePage />
      </MemoryRouter>,
    );

    expect(view.queryByRole("link", { name: "Configure server" })).toBeNull();
    expect(view.queryByRole("link", { name: "API Keys" })).toBeNull();
    expect(view.queryByRole("link", { name: "Invite team" })).toBeNull();
    expect(view.getByTestId("server-guide-unavailable-configure-server")).toBeTruthy();
    expect(view.getByTestId("server-guide-unavailable-configure-providers")).toBeTruthy();
    expect(view.getByTestId("server-guide-unavailable-invite-team")).toBeTruthy();
    expect(view.getByRole("link", { name: "Get Desktop" })).toBeTruthy();
    expect(view.getByRole("button", { name: "I'm all set — take me to chat" })).toBeTruthy();
    expect(view.getByTestId("server-guide-key-coverage-not-permitted").textContent)
      .toContain("Ask a server administrator");
    expect(view.queryByRole("link", { name: "Manage API keys" })).toBeNull();
    expect(getKeySummaryMock).not.toHaveBeenCalled();
    await waitFor(() => expect(view.getByTestId("server-guide-progress-configure-providers").textContent)
      .toContain("Models ready"));
  });

  test("copies the exact application URL, including its scheme and non-default port", async () => {
    setupStatus = {
      ...setupStatus,
      serverUrl: "http://localhost:6201",
    };
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => { copied = value; } },
    });
    const view = render(
      <MemoryRouter>
        <ServerGuidePage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(view.getByTestId("server-guide-application-url").textContent)
      .toBe("http://localhost:6201"));
    expect(view.getByText(/localhost address works only when Desktop is on the computer running the server/i))
      .toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Copy URL" }));
    await waitFor(() => expect(copied).toBe("http://localhost:6201"));
    expect(view.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  test("finishes the guide and enters chat without claiming provider readiness", async () => {
    setupStatus = {
      ...setupStatus,
      providers: { ...setupStatus.providers!, hasLlm: false },
    };
    const view = render(
      <MemoryRouter initialEntries={["/help/server"]}>
        <LocationProbe />
        <ServerGuidePage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(isServerGuideSessionActive()).toBe(true));
    expect(view.getByTestId("server-guide-progress-configure-providers").textContent)
      .toContain("Setup needed");
    fireEvent.click(view.getByRole("button", { name: "I'm all set — take me to chat" }));
    await waitFor(() => expect(view.getByTestId("location").textContent).toBe("/"));
    expect(isServerGuideSessionActive()).toBe(false);
    expect(isServerGuideCompleted("instance-1")).toBe(true);
    expect(setupStatus.providers?.hasLlm).toBe(false);
  });

  test("an explicit revisit after completion does not reactivate setup navigation", async () => {
    const first = render(
      <MemoryRouter initialEntries={["/help/server"]}>
        <LocationProbe />
        <ServerGuidePage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(isServerGuideSessionActive()).toBe(true));
    fireEvent.click(first.getByRole("button", { name: "I'm all set — take me to chat" }));
    await waitFor(() => expect(isServerGuideCompleted("instance-1")).toBe(true));
    cleanup();

    const revisit = render(
      <MemoryRouter initialEntries={["/help/server"]}>
        <ServerGuidePage />
      </MemoryRouter>,
    );
    expect(revisit.getByTestId("server-guide-page")).toBeTruthy();
    await waitFor(() => expect(getSetupStatusMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(isServerGuideSessionActive()).toBe(false);
  });

  test("maps configured key reports through the shared provider coverage table without showing masks", async () => {
    const view = render(
      <MemoryRouter>
        <ServerGuidePage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(view.getByTestId("provider-key-coverage")).toBeTruthy());
    expect(view.getByRole("img", { name: "Chat: supporting API key configured" })).toBeTruthy();
    expect(view.getByRole("img", { name: "Image generation: supporting API key configured" })).toBeTruthy();
    expect(view.getByRole("img", { name: "Text-to-speech: no supporting API key configured" })).toBeTruthy();
    expect(view.getByRole("img", { name: "Web search: supporting API key configured" })).toBeTruthy();
    expect(view.getAllByLabelText("OpenAI: API key configured")).toHaveLength(3);
    expect(view.getAllByLabelText("ElevenLabs: API key not configured")).toHaveLength(2);
    expect(view.getByRole("link", { name: "Manage API keys" }).getAttribute("href"))
      .toBe("/admin#provider-credentials");
    expect(view.getByTestId("server-guide-page").textContent).not.toContain("sk-secret-mask");
  });

  test("shows loading without fabricating missing coverage", async () => {
    keySummaryPromise = new Promise(() => {});
    const view = render(
      <MemoryRouter>
        <ServerGuidePage />
      </MemoryRouter>,
    );

    expect(view.getByTestId("server-guide-key-coverage-loading")).toBeTruthy();
    expect(view.queryByTestId("provider-key-coverage")).toBeNull();
    expect(view.getByRole("link", { name: "Manage API keys" })).toBeTruthy();
    await waitFor(() => expect(view.getByTestId("server-guide-progress-configure-providers").textContent)
      .toContain("Models ready"));
  });

  test("keeps setup progress usable when key coverage is unavailable", async () => {
    keySummaryFails = true;
    const view = render(
      <MemoryRouter>
        <ServerGuidePage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(view.getByTestId("server-guide-key-coverage-unavailable")).toBeTruthy());
    expect(view.queryByTestId("provider-key-coverage")).toBeNull();
    expect(view.getByTestId("server-guide-progress-configure-providers").textContent)
      .toContain("Models ready");
    expect(view.getByRole("link", { name: "Configure server" })).toBeTruthy();
  });

  test("shows key coverage independently when setup status is unavailable", async () => {
    setupStatusFails = true;
    const view = render(
      <MemoryRouter>
        <ServerGuidePage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(view.getByTestId("provider-key-coverage")).toBeTruthy());
    expect(view.getByRole("link", { name: "Configure server" })).toBeTruthy();
    expect(view.getByTestId("server-guide-progress-configure-providers").textContent)
      .toContain("Setup needed");
  });

  test("refreshes key status after provider keys are saved and ignores an older response", async () => {
    let resolveInitial!: (value: { keys: KeyReport[]; hasLlm: boolean }) => void;
    keySummaryPromise = new Promise((resolve) => {
      resolveInitial = resolve;
    });
    const view = render(
      <MemoryRouter>
        <ServerGuidePage />
      </MemoryRouter>,
    );

    expect(view.getByTestId("server-guide-key-coverage-loading")).toBeTruthy();
    keySummaryPromise = Promise.resolve({
      keys: [keyReport("openai", "OpenAI", "verified")],
      hasLlm: true,
    });
    act(() => window.dispatchEvent(new Event("nautilo:provider-keys-saved")));
    await waitFor(() => expect(view.getAllByLabelText("OpenAI: API key configured")).toHaveLength(3));

    await act(async () => {
      resolveInitial({
        keys: [keyReport("openai", "OpenAI", "missing")],
        hasLlm: false,
      });
      await Promise.resolve();
    });
    expect(view.getAllByLabelText("OpenAI: API key configured")).toHaveLength(3);
    expect(getKeySummaryMock).toHaveBeenCalledTimes(2);
  });

  test("removes coverage and its admin link immediately when provider permissions are lost", async () => {
    let resolveInitial!: (value: { keys: KeyReport[]; hasLlm: boolean }) => void;
    keySummaryPromise = new Promise((resolve) => {
      resolveInitial = resolve;
    });
    const view = render(
      <MemoryRouter>
        <ServerGuidePage />
      </MemoryRouter>,
    );

    mockCaps = [];
    view.rerender(
      <MemoryRouter>
        <ServerGuidePage />
      </MemoryRouter>,
    );
    expect(view.getByTestId("server-guide-key-coverage-not-permitted")).toBeTruthy();
    expect(view.queryByRole("link", { name: "Manage API keys" })).toBeNull();

    await act(async () => {
      resolveInitial({ keys: keyReports, hasLlm: true });
      await Promise.resolve();
    });
    expect(view.queryByTestId("provider-key-coverage")).toBeNull();
  });

  test("allows owners with manage_server_settings to load coverage and open the key editor", async () => {
    mockCaps = ["manage_server_settings"];
    const view = render(
      <MemoryRouter>
        <ServerGuidePage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(view.getByTestId("provider-key-coverage")).toBeTruthy());
    expect(getKeySummaryMock).toHaveBeenCalledTimes(1);
    expect(view.getByRole("link", { name: "Manage API keys" }).getAttribute("href"))
      .toBe("/admin#provider-credentials");
  });
});
