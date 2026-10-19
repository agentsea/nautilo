import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { reapplyHappyDomGlobals } from "../../bun-dom-preload";

type AdapterOptions = {
  startAt: string | null;
  getAccessToken: () => Promise<string | null>;
  getCanonicalProfile: () => unknown;
  onCancel: () => void;
  onOpenVoiceFundingRecovery: (recovery: { href: string; [key: string]: string }) => void;
  onComplete: () => Promise<void>;
};

const createAdapter = mock((options: AdapterOptions) => ({
  api: {
    complete: options.onComplete,
    cancel: async () => options.onCancel(),
  },
  dispose: mock(() => {}),
}));
const listRooms = mock(async () => ({ rooms: [] }));
const getAccessToken = mock(async () => "token");
const OWNER_PROFILE = {
  viewerRole: "owner" as const,
  agent: {
    name: "Genie",
    language: "en" as const,
    workLifeMode: null,
    privacySpectrum: 50,
    personality: { prompt: null, motherAnswer: null },
    voices: {},
    avatar: { kind: "preset" as const, id: "avatar-01" },
    soulFile: null,
    onboardingCompleted: false,
  },
  ownedAgents: [{ agentId: "owned-genie", handle: "genie", displayName: "Genie" }],
};
let profileState = {
  response: OWNER_PROFILE,
  loading: false,
  error: null as Error | null,
  refresh: async () => {},
};
let authState = {
  session: { getAccessToken },
  viewer: { sessionUserId: "viewer-user", sessionActorId: "viewer-actor" },
};
mock.module("@nautilo/genie-customization-ui", () => ({
  GenieCustomizationApp: ({ api }: { api: { complete: () => Promise<void>; cancel: () => Promise<void> } }) => (
    <div>
      <div>Shared Genie wizard</div>
      <button type="button" onClick={() => void api.complete()}>Complete wizard</button>
      <button type="button" onClick={() => void api.cancel()}>Cancel wizard</button>
    </div>
  ),
}));
mock.module("../../../src/hooks/use-auth", () => ({
  useAuth: () => authState,
}));
mock.module("../../../src/hooks/use-profile", () => ({
  useProfile: () => profileState,
}));
mock.module("../../../src/genie-customization/workbench-onboarding-api", () => ({
  createWorkbenchOnboardingApi: createAdapter,
}));
mock.module("../../../src/lib/api", () => ({
  apiClient: { listRooms },
}));

const { GenieCustomizationRoute, parseCustomizeGenieStartAt } = await import(
  "../../../src/genie-customization/genie-customization-route"
);

afterEach(() => {
  cleanup();
  createAdapter.mockClear();
  listRooms.mockClear();
  listRooms.mockImplementation(async () => ({ rooms: [] }));
  getAccessToken.mockClear();
  profileState = { response: OWNER_PROFILE, loading: false, error: null, refresh: async () => {} };
  authState = {
    session: { getAccessToken },
    viewer: { sessionUserId: "viewer-user", sessionActorId: "viewer-actor" },
  };
});

function LocationProbe(): React.ReactElement {
  const location = useLocation();
  return <output aria-label="Current path">{location.pathname}</output>;
}

function personalRoom(id = "personal") {
  return {
    id,
    label: "Human · Genie",
    type: "private",
    kind: "private" as const,
    graphThreadId: "app:default",
    createdAt: "2026-01-01T00:00:00.000Z",
    memberCount: 2,
    roster: [
      { actorId: "viewer-actor", kind: "user" as const, userId: "viewer-user", displayName: "Human" },
      { actorId: "genie-actor", kind: "agent" as const, agentId: "owned-genie", displayName: "Genie" },
    ],
  };
}

describe("Genie customization route", () => {
  test("accepts only the two supported deep-link targets", () => {
    expect(parseCustomizeGenieStartAt("?startAt=personality")).toBe("personality");
    expect(parseCustomizeGenieStartAt("?startAt=avatar")).toBe("avatar");
    expect(parseCustomizeGenieStartAt("?startAt=voice")).toBeNull();
    expect(parseCustomizeGenieStartAt("?startAt=avatar&startAt=personality")).toBe("avatar");
  });

  test("mounts the shared wizard inside the authenticated route with its validated target", () => {
    reapplyHappyDomGlobals();
    const view = render(
      <MemoryRouter initialEntries={["/customize-genie?startAt=avatar"]}>
        <GenieCustomizationRoute />
      </MemoryRouter>,
    );
    expect(view.getByRole("main", { name: "Customize your Genie" })).toBeTruthy();
    expect(view.getByText("Shared Genie wizard")).toBeTruthy();
    expect(createAdapter).toHaveBeenCalledWith(expect.objectContaining({ startAt: "avatar" }));
    const options = createAdapter.mock.calls[0]?.[0];
    expect(options?.getCanonicalProfile()).toEqual({ ok: true, data: OWNER_PROFILE });
  });

  test("opens a verified voice repair route without replacing the in-progress wizard", () => {
    reapplyHappyDomGlobals();
    const open = mock(() => null);
    window.open = open as typeof window.open;
    const view = render(<MemoryRouter><GenieCustomizationRoute /></MemoryRouter>);
    const options = createAdapter.mock.calls[0]?.[0];

    options?.onOpenVoiceFundingRecovery({
      errorCode: "personal_credential_stale",
      repairAction: "replace_provider_credential",
      href: "/settings#personal-provider-keys",
    });

    expect(open).toHaveBeenCalledWith(
      "/settings#personal-provider-keys",
      "_blank",
      "noopener,noreferrer",
    );
    expect(view.getByText("Shared Genie wizard")).toBeTruthy();
  });

  test("holds the route at a loading gate until ProfileProvider is settled", () => {
    profileState = { ...profileState, response: null as never, loading: true };
    reapplyHappyDomGlobals();
    const view = render(<MemoryRouter><GenieCustomizationRoute /></MemoryRouter>);

    expect(view.getByText("Loading your Genie…")).toBeTruthy();
    expect(createAdapter).not.toHaveBeenCalled();
  });

  test("fails closed for a canonical profile error instead of mounting the wizard", () => {
    profileState = { ...profileState, response: null as never, error: new Error("raw server detail") };
    reapplyHappyDomGlobals();
    const view = render(<MemoryRouter><GenieCustomizationRoute /></MemoryRouter>);

    expect(view.getByText("Couldn’t load your Genie profile. Please try again.")).toBeTruthy();
    expect(createAdapter).not.toHaveBeenCalled();
  });

  test("fails closed when the initial profile settles without a response", () => {
    profileState = { ...profileState, response: null as never };
    reapplyHappyDomGlobals();
    const view = render(<MemoryRouter><GenieCustomizationRoute /></MemoryRouter>);

    expect(view.getByText("Couldn’t load your Genie profile. Please try again.")).toBeTruthy();
    expect(createAdapter).not.toHaveBeenCalled();
  });

  test("keeps the same wizard and adapter through a profile.updated refresh", () => {
    reapplyHappyDomGlobals();
    const view = render(<MemoryRouter><GenieCustomizationRoute /></MemoryRouter>);
    const initialWizard = view.getByText("Shared Genie wizard");
    const refreshedProfile = {
      ...OWNER_PROFILE,
      agent: { ...OWNER_PROFILE.agent, avatar: { kind: "library" as const, id: "generated-avatar" } },
    };

    // ProfileProvider receives profile.updated, begins its refresh, then
    // publishes a new response object after the generated photo is committed.
    profileState = { ...profileState, loading: true };
    view.rerender(<MemoryRouter><GenieCustomizationRoute /></MemoryRouter>);
    expect(view.getByText("Shared Genie wizard")).toBe(initialWizard);
    expect(createAdapter).toHaveBeenCalledTimes(1);

    profileState = { ...profileState, loading: false, response: refreshedProfile };
    view.rerender(<MemoryRouter><GenieCustomizationRoute /></MemoryRouter>);
    expect(view.getByText("Shared Genie wizard")).toBe(initialWizard);
    expect(createAdapter).toHaveBeenCalledTimes(1);
    expect(createAdapter.mock.calls[0]?.[0]?.getCanonicalProfile()).toEqual({ ok: true, data: OWNER_PROFILE });
  });

  test("opens the existing Personal chat after first customization without reading credentials", async () => {
    reapplyHappyDomGlobals();
    const refresh = mock(async () => {});
    profileState = { ...profileState, refresh };
    listRooms.mockImplementation(async () => ({ rooms: [personalRoom()] }));
    const view = render(
      <MemoryRouter initialEntries={["/public-room", "/customize-genie"]} initialIndex={1}>
        <GenieCustomizationRoute />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.click(view.getByRole("button", { name: "Complete wizard" }));

    await waitFor(() => expect(view.getByLabelText("Current path").textContent).toBe("/rooms/personal"));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(listRooms).toHaveBeenCalledTimes(1);
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  test("opens Personal chat after the StrictMode effect probe", async () => {
    reapplyHappyDomGlobals();
    listRooms.mockImplementation(async () => ({ rooms: [personalRoom("strict-room")] }));
    const view = render(
      <StrictMode>
        <MemoryRouter initialEntries={["/customize-genie"]}>
          <GenieCustomizationRoute />
          <LocationProbe />
        </MemoryRouter>
      </StrictMode>,
    );

    fireEvent.click(view.getByRole("button", { name: "Complete wizard" }));
    await waitFor(() => expect(view.getByLabelText("Current path").textContent).toBe("/rooms/strict-room"));
  });

  test("uses the opening incomplete profile even when refresh publishes completion", async () => {
    reapplyHappyDomGlobals();
    profileState = {
      ...profileState,
      refresh: async () => {
        profileState = {
          ...profileState,
          response: { ...OWNER_PROFILE, agent: { ...OWNER_PROFILE.agent, onboardingCompleted: true } },
        };
      },
    };
    listRooms.mockImplementation(async () => ({ rooms: [personalRoom("opening-profile-room")] }));
    const view = render(
      <MemoryRouter initialEntries={["/customize-genie"]}>
        <GenieCustomizationRoute />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.click(view.getByRole("button", { name: "Complete wizard" }));

    await waitFor(() => expect(view.getByLabelText("Current path").textContent).toBe("/rooms/opening-profile-room"));
  });

  test("returns to the opening origin for repeat customization and cancel", async () => {
    reapplyHappyDomGlobals();
    const completedProfile = {
      ...OWNER_PROFILE,
      agent: { ...OWNER_PROFILE.agent, onboardingCompleted: true },
    };
    profileState = { ...profileState, response: completedProfile };
    const completeView = render(
      <MemoryRouter initialEntries={["/origin", "/customize-genie"]} initialIndex={1}>
        <GenieCustomizationRoute />
        <LocationProbe />
      </MemoryRouter>,
    );
    fireEvent.click(completeView.getByRole("button", { name: "Complete wizard" }));
    await waitFor(() => expect(completeView.getByLabelText("Current path").textContent).toBe("/origin"));
    expect(listRooms).not.toHaveBeenCalled();
    completeView.unmount();

    profileState = { ...profileState, response: OWNER_PROFILE };
    const cancelView = render(
      <MemoryRouter initialEntries={["/origin", "/customize-genie"]} initialIndex={1}>
        <GenieCustomizationRoute />
        <LocationProbe />
      </MemoryRouter>,
    );
    fireEvent.click(cancelView.getByRole("button", { name: "Cancel wizard" }));
    await waitFor(() => expect(cancelView.getByLabelText("Current path").textContent).toBe("/origin"));
  });

  test("returns a direct repeat-customization entry to the app root", async () => {
    reapplyHappyDomGlobals();
    profileState = {
      ...profileState,
      response: { ...OWNER_PROFILE, agent: { ...OWNER_PROFILE.agent, onboardingCompleted: true } },
    };
    const view = render(
      <MemoryRouter initialEntries={["/customize-genie"]}>
        <GenieCustomizationRoute />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.click(view.getByRole("button", { name: "Complete wizard" }));
    await waitFor(() => expect(view.getByLabelText("Current path").textContent).toBe("/"));
  });

  test("shows a sanitized recovery action and retries room opening without completing again", async () => {
    reapplyHappyDomGlobals();
    const refresh = mock(async () => {});
    profileState = { ...profileState, refresh };
    listRooms.mockImplementationOnce(async () => ({ rooms: [] }));
    const view = render(
      <MemoryRouter initialEntries={["/customize-genie"]}>
        <GenieCustomizationRoute />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.click(view.getByRole("button", { name: "Complete wizard" }));
    const alert = await view.findByRole("alert");
    expect(alert.textContent).toContain("Your Genie was saved, but we couldn’t open your Personal chat.");
    expect(alert.textContent).not.toContain("personal room unavailable");
    expect(view.getByText("Shared Genie wizard")).toBeTruthy();

    let finishRetry: ((value: { rooms: ReturnType<typeof personalRoom>[] }) => void) | undefined;
    listRooms.mockImplementationOnce(() => new Promise((resolve) => { finishRetry = resolve; }));
    fireEvent.click(view.getByRole("button", { name: "Retry opening Personal chat" }));
    expect(view.getByRole("alert")).toBeTruthy();
    expect((view.getByRole("button", { name: "Opening Personal chat…" }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(listRooms).toHaveBeenCalledTimes(2));
    await act(async () => finishRetry?.({ rooms: [personalRoom("retry-room")] }));
    await waitFor(() => expect(view.getByLabelText("Current path").textContent).toBe("/rooms/retry-room"));
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(listRooms).toHaveBeenCalledTimes(2);
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  test("surfaces refresh and room-list failures through the same recovery state", async () => {
    reapplyHappyDomGlobals();
    profileState = { ...profileState, refresh: async () => { throw new Error("secret refresh detail"); } };
    const refreshView = render(<MemoryRouter><GenieCustomizationRoute /></MemoryRouter>);
    fireEvent.click(refreshView.getByRole("button", { name: "Complete wizard" }));
    expect((await refreshView.findByRole("alert")).textContent).not.toContain("secret refresh detail");
    expect(listRooms).not.toHaveBeenCalled();
    refreshView.unmount();

    profileState = { ...profileState, refresh: async () => {} };
    listRooms.mockImplementationOnce(async () => { throw new Error("secret list detail"); });
    const listView = render(<MemoryRouter><GenieCustomizationRoute /></MemoryRouter>);
    fireEvent.click(listView.getByRole("button", { name: "Complete wizard" }));
    expect((await listView.findByRole("alert")).textContent).not.toContain("secret list detail");
    expect(listView.getByText("Shared Genie wizard")).toBeTruthy();
  });

  test("fences navigation when the viewer changes while completion refreshes", async () => {
    reapplyHappyDomGlobals();
    let finishRefresh: (() => void) | undefined;
    profileState = {
      ...profileState,
      refresh: () => new Promise<void>((resolve) => { finishRefresh = resolve; }),
    };
    listRooms.mockImplementation(async () => ({ rooms: [personalRoom()] }));
    const view = render(
      <MemoryRouter initialEntries={["/customize-genie"]}>
        <GenieCustomizationRoute />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.click(view.getByRole("button", { name: "Complete wizard" }));
    authState = {
      ...authState,
      viewer: { sessionUserId: "other-user", sessionActorId: "other-actor" },
    };
    view.rerender(
      <MemoryRouter initialEntries={["/customize-genie"]}>
        <GenieCustomizationRoute />
        <LocationProbe />
      </MemoryRouter>,
    );
    await act(async () => finishRefresh?.());
    expect(view.getByLabelText("Current path").textContent).toBe("/customize-genie");
    expect(listRooms).not.toHaveBeenCalled();
  });

  test("does not navigate when completion is cancelled while the room list is pending", async () => {
    reapplyHappyDomGlobals();
    let finishList: ((value: { rooms: ReturnType<typeof personalRoom>[] }) => void) | undefined;
    listRooms.mockImplementationOnce(() => new Promise((resolve) => { finishList = resolve; }));
    const view = render(
      <MemoryRouter initialEntries={["/origin", "/customize-genie"]} initialIndex={1}>
        <GenieCustomizationRoute />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.click(view.getByRole("button", { name: "Complete wizard" }));
    await waitFor(() => expect(listRooms).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByRole("button", { name: "Cancel wizard" }));
    await waitFor(() => expect(view.getByLabelText("Current path").textContent).toBe("/origin"));
    await act(async () => finishList?.({ rooms: [personalRoom("late-room")] }));
    expect(view.getByLabelText("Current path").textContent).toBe("/origin");
  });
});
