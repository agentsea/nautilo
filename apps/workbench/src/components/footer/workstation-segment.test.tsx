import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

const seed = mock(async () => ({
  ok: true as const,
  data: {
    id: "developer-workstation",
    revision: 1,
    name: "Developer Workstation",
    protectedPolicyVersion: 1,
    networkMode: "host",
    discoveryProviders: [],
    environmentKeys: [],
    capabilities: [],
  },
}));
const profiles = mock(async () => ({
  ok: true as const,
  data: {
    profiles: [{
      id: "developer-workstation",
      revision: 1,
      name: "Developer Workstation",
      protectedPolicyVersion: 1,
      networkMode: "host",
      capabilities: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
    revision: 1,
  },
}));
let activeProfile: { profileId: string; profileRevision: number } | null = null;
let serverSession: {
  confirmed: boolean;
  session: { profileId: string; profileRevision: number } | null;
} = { confirmed: true, session: null };
let capabilities = ["use_workstation"];
const active = mock(async () => activeProfile === null
  ? { ok: true as const, data: null }
  : {
      ok: true as const,
      data: {
        ...activeProfile,
        protectedPolicyVersion: 1,
        networkMode: "host" as const,
        capabilities: [],
        compiledAt: "2026-01-01T00:00:00.000Z",
      },
    });
const serverStatus = mock(async () => serverSession);
const selectActiveProfile = mock(async () => ({
  ok: true as const,
  data: {
    summary: {
      profileId: "developer-workstation",
      profileRevision: 1,
      protectedPolicyVersion: 1,
      networkMode: "host" as const,
      capabilities: [],
      compiledAt: "2026-01-01T00:00:00.000Z",
    },
    outcome: "activated",
  },
}));
const deactivateActiveProfile = mock(async () => ({
  ok: true as const,
  data: { cleared: 1, skipped: [] },
}));
mock.module("../../lib/desktop", () => ({
  isDesktop: true,
  desktopAPI: {
    workstationProfiles: {
      getSeedDescriptor: seed,
      listProfiles: profiles,
      getActiveProfileSummary: active,
      getServerSessionStatus: serverStatus,
      selectActiveProfile,
      deactivateActiveProfile,
    },
  },
}));
mock.module("../../hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { sessionUserId: "user-1" } }),
}));
mock.module("../../hooks/use-can", () => ({
  useCan: () => (capability: string) => capabilities.includes(capability),
}));

const { WorkstationSegment } = await import("./workstation-segment");
const { publishWorkstationProfileChanged } = await import("../../lib/workstation-profile-events");

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.hash}`}</output>;
}

function renderSegment() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <WorkstationSegment />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function acknowledgeReview(revision = 1): void {
  window.localStorage.setItem(
    `nautilo.workstation-profile-review.user-1.developer-workstation.${revision}`,
    "acknowledged",
  );
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  window.localStorage.clear();
  activeProfile = null;
  serverSession = { confirmed: true, session: null };
  capabilities = ["use_workstation"];
  seed.mockClear();
  profiles.mockClear();
  active.mockClear();
  serverStatus.mockClear();
  selectActiveProfile.mockClear();
  deactivateActiveProfile.mockClear();
});

afterAll(() => {
  mock.restore();
});

describe("WorkstationSegment", () => {
  test("does not render or inspect workstation profiles without use_workstation", () => {
    capabilities = [];

    const view = renderSegment();

    expect(view.queryByRole("button")).toBeNull();
    expect(seed).not.toHaveBeenCalled();
    expect(profiles).not.toHaveBeenCalled();
    expect(active).not.toHaveBeenCalled();
    expect(serverStatus).not.toHaveBeenCalled();
  });

  test("shows On only when local and confirmed server selectors match", async () => {
    acknowledgeReview();
    activeProfile = { profileId: "developer-workstation", profileRevision: 1 };
    serverSession = {
      confirmed: true,
      session: { profileId: "developer-workstation", profileRevision: 1 },
    };

    const view = renderSegment();
    await waitFor(() => {
      expect(view.getByRole("button", { name: /disable developer workstation immediately/i }).textContent)
        .toBe("Workstation: On");
    });
  });

  test("refreshes when Settings changes the authoritative profile session", async () => {
    acknowledgeReview();
    const view = renderSegment();
    await view.findByRole("button", { name: /enable developer workstation with your pin/i });

    activeProfile = { profileId: "developer-workstation", profileRevision: 1 };
    serverSession = {
      confirmed: true,
      session: { profileId: "developer-workstation", profileRevision: 1 },
    };
    publishWorkstationProfileChanged("settings");

    await waitFor(() => {
      expect(view.getByRole("button", { name: /disable developer workstation immediately/i }).textContent)
        .toBe("Workstation: On");
    });
  });

  test("shows Off, never On, when the server confirms there is no active session", async () => {
    acknowledgeReview();
    activeProfile = { profileId: "developer-workstation", profileRevision: 1 };
    serverSession = { confirmed: true, session: null };

    const view = renderSegment();
    await waitFor(() => {
      expect(view.getByRole("button", { name: /enable developer workstation with your pin/i }).textContent)
        .toBe("Workstation: Off");
    });
    expect(view.queryByText("Workstation: On")).toBeNull();
  });

  test("shows Unavailable and does not enable when server status is unconfirmed", async () => {
    acknowledgeReview();
    serverSession = { confirmed: false, session: null };

    const view = renderSegment();
    await waitFor(() => {
      const button = view.getByRole("button", { name: /server status could not be checked/i });
      expect(button.textContent).toBe("Workstation: Unavailable");
      expect(button.hasAttribute("disabled")).toBe(true);
    });
  });

  test("opens the own-PIN dialog from a reviewed ready profile", async () => {
    acknowledgeReview();
    const view = renderSegment();

    await waitFor(() => {
      expect(view.getByRole("button", { name: /enable developer workstation with your pin/i }).textContent)
        .toBe("Workstation: Off");
    });
    fireEvent.click(view.getByRole("button", { name: /enable developer workstation with your pin/i }));
    expect(view.getByRole("heading", { name: "Enable Developer Workstation" })).toBeTruthy();
  });

  test("routes a revision-mismatched profile to Workstation Settings for an update", async () => {
    profiles.mockResolvedValueOnce({
      ok: true as const,
      data: {
        profiles: [{
          id: "developer-workstation",
          revision: 1,
          name: "Developer Workstation",
          protectedPolicyVersion: 1,
          networkMode: "host",
          capabilities: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }],
        revision: 1,
      },
    });
    seed.mockResolvedValueOnce({
      ok: true as const,
      data: {
        id: "developer-workstation",
        revision: 2,
        name: "Developer Workstation",
        protectedPolicyVersion: 1,
        networkMode: "host",
        discoveryProviders: [],
        environmentKeys: [],
        capabilities: [],
      },
    });
    const view = renderSegment();

    await waitFor(() => {
      expect(view.getByRole("button", { name: /update developer workstation in settings/i }).textContent)
        .toBe("Workstation: Update needed");
    });
    fireEvent.click(view.getByRole("button", { name: /update developer workstation in settings/i }));
    expect(view.getByTestId("location").textContent).toBe("/settings#workstation-access");
  });

  test("routes initial or incomplete setup to Workstation Settings", async () => {
    const view = renderSegment();

    await waitFor(() => {
      expect(view.getByRole("button", { name: /set up developer workstation in settings/i }).textContent)
        .toBe("Workstation: Set up");
    });
    fireEvent.click(view.getByRole("button", { name: /set up developer workstation in settings/i }));
    expect(view.getByTestId("location").textContent).toBe("/settings#workstation-access");
  });

  test("uses the locked unavailable label when status cannot be checked", async () => {
    seed.mockRejectedValueOnce(new Error("status failed"));
    const view = renderSegment();

    await waitFor(() => {
      expect(view.getByRole("button", { name: /status could not be checked/i }).textContent)
        .toBe("Workstation: Unavailable");
    });
  });

  test("uses the locked checking label while the status read is in flight", async () => {
    const view = renderSegment();
    expect(view.getByText("Workstation: Checking…")).toBeTruthy();
    await waitFor(() => {
      expect(view.getByText("Workstation: Set up")).toBeTruthy();
    });
  });

  test("disables a confirmed active session through the narrow bridge", async () => {
    acknowledgeReview();
    activeProfile = { profileId: "developer-workstation", profileRevision: 1 };
    serverSession = {
      confirmed: true,
      session: { profileId: "developer-workstation", profileRevision: 1 },
    };
    const view = renderSegment();

    await waitFor(() => {
      expect(view.getByRole("button", { name: /disable developer workstation immediately/i }))
        .toBeTruthy();
    });
    fireEvent.click(view.getByRole("button", { name: /disable developer workstation immediately/i }));
    await waitFor(() => {
      expect(deactivateActiveProfile).toHaveBeenCalledTimes(1);
    });
  });
});
