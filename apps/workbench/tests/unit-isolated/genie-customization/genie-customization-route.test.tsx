import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { reapplyHappyDomGlobals } from "../../bun-dom-preload";

const createAdapter = mock(() => ({ api: {}, dispose: mock(() => {}) }));
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
};
let profileState = {
  response: OWNER_PROFILE,
  loading: false,
  error: null as Error | null,
  refresh: async () => {},
};
mock.module("@nautilo/genie-customization-ui", () => ({
  GenieCustomizationApp: () => <div>Shared Genie wizard</div>,
}));
mock.module("../../../src/hooks/use-auth", () => ({
  useAuth: () => ({ session: { getAccessToken: async () => "token" } }),
}));
mock.module("../../../src/hooks/use-profile", () => ({
  useProfile: () => profileState,
}));
mock.module("../../../src/genie-customization/workbench-onboarding-api", () => ({
  createWorkbenchOnboardingApi: createAdapter,
}));

const { GenieCustomizationRoute, parseCustomizeGenieStartAt } = await import(
  "../../../src/genie-customization/genie-customization-route"
);

afterEach(() => {
  cleanup();
  createAdapter.mockClear();
  profileState = { response: OWNER_PROFILE, loading: false, error: null, refresh: async () => {} };
});

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
    const initialApi = createAdapter.mock.results[0]?.value.api;
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
    expect(createAdapter.mock.results[0]?.value.api).toBe(initialApi);
    expect(createAdapter.mock.calls[0]?.[0]?.getCanonicalProfile()).toEqual({ ok: true, data: OWNER_PROFILE });
  });
});
