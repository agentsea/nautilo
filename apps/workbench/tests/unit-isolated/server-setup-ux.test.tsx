import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { SetupStatusResponse } from "@nautilo/api-client/browser";
import { reapplyHappyDomGlobals } from "../bun-dom-preload";

mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({
    session: {
      state: "signed-in" as const,
      signIn: async () => {},
      signOut: async () => {},
      getAccessToken: async () => "token",
    },
    viewer: {
      role: "owner" as const,
      label: "Owner",
      userIdentity: "owner",
      sessionUserId: "owner-1",
      sessionActorId: "actor-1",
      isVerified: true,
      staleWhoami: false,
    },
    groups: [],
  }),
}));

mock.module("../../src/hooks/use-can", () => ({
  useCan: () => (capability: string) => capability === "invoke_agents",
}));

mock.module("../../src/lib/desktop", () => ({
  isDesktop: false,
  desktopAPI: null,
  getShellStateOnBoot: () => null,
}));

mock.module("../../src/lib/api", () => ({
  apiClient: {
    getSetupStatus: async () => readyStatus,
    getKeySummary: async () => ({ keys: [], hasLlm: true }),
    admin: { users: { list: async () => ({ users: [], nextCursor: null }) } },
    listMyInvites: async () => ({ invites: [] }),
  },
}));

const { GenieCustomizeSoftPrompt } = await import(
  "../../src/components/genie-customize-soft-prompt"
);
const { ServerGuideCompanion } = await import(
  "../../src/components/server-guide-companion"
);
const { FirstRunGate } = await import("../../src/components/first-run-gate");
const { ServerGuidePage } = await import("../../src/pages/help/server-guide-page");
const { beginServerGuideSession, endServerGuideSession } = await import(
  "../../src/lib/server-guide-session"
);

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

const readyStatus: SetupStatusResponse = {
  instanceId: "instance-1",
  serverUrl: "https://server.example.test",
  deploymentMode: "local-self-host",
  setupState: "ready",
  claimRequired: false,
  viewer: { genieCustomized: false },
};

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

describe("first-owner setup UX", () => {
  test("Skip for now dismisses in place instead of navigating to chat", async () => {
    const view = render(
      <MemoryRouter initialEntries={["/admin"]}>
        <LocationProbe />
        <GenieCustomizeSoftPrompt setupStatus={readyStatus} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(view.getByTestId("genie-soft-prompt")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Skip for now" }));
    expect(view.getByTestId("location").textContent).toBe("/admin");
    expect(view.queryByTestId("genie-soft-prompt")).toBeNull();
  });

  test("an active guide session suppresses the Genie prompt", async () => {
    beginServerGuideSession();
    const view = render(
      <MemoryRouter initialEntries={["/admin"]}>
        <GenieCustomizeSoftPrompt setupStatus={readyStatus} />
      </MemoryRouter>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.queryByTestId("genie-soft-prompt")).toBeNull();
  });

  test("the setup companion returns to the guide and ending setup immediately offers Genie customization", async () => {
    beginServerGuideSession();
    const view = render(
      <MemoryRouter initialEntries={["/admin#provider-credentials"]}>
        <LocationProbe />
        <ServerGuideCompanion />
      </MemoryRouter>,
    );
    expect(view.getByTestId("server-guide-companion")).toBeTruthy();
    expect(view.getByTestId("server-guide-companion").className).not.toContain("fixed");
    fireEvent.click(view.getByRole("button", { name: "Back to guide" }));
    await waitFor(() => expect(view.getByTestId("location").textContent).toBe("/help/server"));

    cleanup();
    const exitView = render(
      <MemoryRouter initialEntries={["/admin"]}>
        <ServerGuideCompanion />
        <GenieCustomizeSoftPrompt setupStatus={readyStatus} />
      </MemoryRouter>,
    );
    expect(exitView.queryByTestId("genie-soft-prompt")).toBeNull();
    fireEvent.click(exitView.getByRole("button", { name: "Exit setup" }));
    expect(exitView.queryByTestId("server-guide-companion")).toBeNull();
    await waitFor(() => expect(exitView.getByTestId("genie-soft-prompt")).toBeTruthy());
    endServerGuideSession();
  });

  test("ending a later guide session preserves an explicit Genie dismissal", async () => {
    const view = render(
      <MemoryRouter initialEntries={["/admin"]}>
        <GenieCustomizeSoftPrompt setupStatus={readyStatus} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(view.getByTestId("genie-soft-prompt")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Skip for now" }));
    act(() => {
      beginServerGuideSession();
      endServerGuideSession();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.queryByTestId("genie-soft-prompt")).toBeNull();
  });

  test("finishing the guide navigates to chat and invites an eligible owner without reload", async () => {
    const view = render(
      <MemoryRouter initialEntries={["/help/server"]}>
        <FirstRunGate>
          <Routes>
            <Route path="/help/server" element={<ServerGuidePage />} />
            <Route path="/" element={<main>Chat home</main>} />
          </Routes>
        </FirstRunGate>
      </MemoryRouter>,
    );

    const finish = await view.findByRole("button", { name: "I'm all set — take me to chat" });
    expect(view.queryByTestId("genie-soft-prompt")).toBeNull();
    fireEvent.click(finish);
    await waitFor(() => expect(view.getByText("Chat home")).toBeTruthy());
    await waitFor(() => expect(view.getByTestId("genie-soft-prompt")).toBeTruthy());
    expect(view.getByText(/personalize your Genie now/i)).toBeTruthy();
  });
});
