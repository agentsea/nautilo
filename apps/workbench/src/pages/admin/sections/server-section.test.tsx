/**
 * D220 Phase 2 — ServerSection edit flow (server profile).
 */
import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  act,
  within,
} from "@testing-library/react";
import type { CapabilitySlug } from "@nautilo/types";

const realUseCan = await import("../../../hooks/use-can");

let mockCaps: CapabilitySlug[] = ["read_server_settings", "manage_server_operations"];

const profileState = {
  profile: {
    name: "Test Server",
    description: "A demo instance",
    descriptionVisibility: "members" as const,
    icon: { kind: "preset" as const, id: "server-default" },
  },
};

const updateServerProfileMock = mock(async (patch: Record<string, unknown>) => {
  profileState.profile = {
    ...profileState.profile,
    ...(patch.name !== undefined ? { name: patch.name as string } : {}),
    ...(patch.description !== undefined
      ? { description: patch.description as string | null }
      : {}),
    ...(patch.descriptionVisibility !== undefined
      ? { descriptionVisibility: patch.descriptionVisibility as "public" | "members" }
      : {}),
  };
  return profileState.profile;
});
let contextLimit = 50;
let minimumFullTurns = 1;
let maxRoomContextPercent = 50;
let stenographerPriorConversationLimit = 10;
let passiveRecallEnabled = true;
let reflectionSleepEnabled = false;
let researchProvider: "auto" | "duckduckgo_html" = "auto";
const updateResearchProviderMock = mock(async (provider: "auto" | "duckduckgo_html") => {
  researchProvider = provider;
  return {
    provider: researchProvider,
    tavilyConfigured: false,
    desktopReaderAvailable: true,
    keylessSearchAvailable: true,
  };
});
const setServerContextMock = mock(async (patch: {
  recentConversationLimit?: number;
  minimumFullTurns?: number;
  maxRoomContextPercent?: number;
  stenographerPriorConversationLimit?: number;
  passiveRecallEnabled?: boolean;
  reflectionSleepEnabled?: boolean;
}) => {
  contextLimit = patch.recentConversationLimit ?? contextLimit;
  minimumFullTurns = patch.minimumFullTurns ?? minimumFullTurns;
  maxRoomContextPercent = patch.maxRoomContextPercent ?? maxRoomContextPercent;
  stenographerPriorConversationLimit =
    patch.stenographerPriorConversationLimit ?? stenographerPriorConversationLimit;
  passiveRecallEnabled = patch.passiveRecallEnabled ?? passiveRecallEnabled;
  reflectionSleepEnabled = patch.reflectionSleepEnabled ?? reflectionSleepEnabled;
  return {
    recentConversationLimit: contextLimit,
    minimumFullTurns,
    maxRoomContextPercent,
    stenographerPriorConversationLimit,
    passiveRecallEnabled,
    reflectionSleepEnabled,
  };
});

mock.module("../../../hooks/use-can", () => ({
  useCan: () => (cap: CapabilitySlug) => mockCaps.includes(cap),
}));

mock.module("../../../hooks/use-auth", () => ({
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

mock.module("../../../contexts/posture-context", () => ({
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

mock.module("../../../lib/api", () => ({
  apiClient: {
    getServerProfile: async () => profileState.profile,
    updateServerProfile: updateServerProfileMock,
    getResearchProvider: async () => ({
      provider: researchProvider,
      tavilyConfigured: false,
      desktopReaderAvailable: true,
      keylessSearchAvailable: true,
    }),
    updateResearchProvider: updateResearchProviderMock,
    admin: {
      serverContext: {
        get: async () => ({
          recentConversationLimit: contextLimit,
          minimumFullTurns,
          maxRoomContextPercent,
          stenographerPriorConversationLimit,
          passiveRecallEnabled,
          reflectionSleepEnabled,
        }),
        set: setServerContextMock,
      },
      stenographerStatus: {
        get: async () => {
          throw new Error("not needed in this test");
        },
      },
    },
  },
}));

const { ServerSection } = await import("./server-section");
const { SearchSection } = await import("./search-section");
const { StenographerSection } = await import("./stenographer-section");

afterAll(() => {
  mock.module("../../../hooks/use-can", () => realUseCan);
});

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  mockCaps = ["read_server_settings", "manage_server_operations"];
  profileState.profile = {
    name: "Test Server",
    description: "A demo instance",
    descriptionVisibility: "members",
    icon: { kind: "preset", id: "server-default" },
  };
  updateServerProfileMock.mockClear();
  setServerContextMock.mockClear();
  updateResearchProviderMock.mockClear();
  contextLimit = 50;
  minimumFullTurns = 1;
  maxRoomContextPercent = 50;
  stenographerPriorConversationLimit = 10;
  passiveRecallEnabled = true;
  reflectionSleepEnabled = false;
  researchProvider = "auto";
});

describe("ServerSection", () => {
  test("shows edit form for manage_server_operations and saves profile patch", async () => {
    const view = render(<ServerSection />);

    await waitFor(() => {
      expect(view.getByText("Test Server")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(view.getByTestId("server-edit-button"));
    });

    const form = view.getByTestId("server-edit-form");
    expect(form).toBeTruthy();
    expect((view.getByTestId("server-name-input") as HTMLInputElement).value).toBe(
      "Test Server",
    );
    expect((view.getByTestId("server-description-input") as HTMLTextAreaElement).value).toBe(
      "A demo instance",
    );

    await act(async () => {
      fireEvent.change(view.getByTestId("server-name-input"), {
        target: { value: "Renamed Server" },
      });
      fireEvent.change(view.getByTestId("server-description-input"), {
        target: { value: "Updated description" },
      });
      fireEvent.click(view.getByTestId("server-description-visibility-toggle"));
    });
    expect(view.getByText("Show description to non-members")).toBeTruthy();

    await act(async () => {
      fireEvent.click(
        within(view.getByTestId("server-edit-form")).getByRole("button", {
          name: "Save",
        }),
      );
    });

    await waitFor(() => {
      expect(updateServerProfileMock).toHaveBeenCalledTimes(1);
    });

    expect(updateServerProfileMock.mock.calls[0]?.[0]).toEqual({
      reviewed: true,
      name: "Renamed Server",
      description: "Updated description",
      descriptionVisibility: "public",
    });

    await waitFor(() => {
      expect(view.getByTestId("server-save-success")).toBeTruthy();
      expect(view.getByText("Renamed Server")).toBeTruthy();
    });
  });

  test("saving an unchanged profile records an explicit review", async () => {
    const view = render(<ServerSection />);
    await waitFor(() => expect(view.getByText("Test Server")).toBeTruthy());
    fireEvent.click(view.getByTestId("server-edit-button"));
    fireEvent.click(
      within(view.getByTestId("server-edit-form")).getByRole("button", { name: "Save" }),
    );
    await waitFor(() => expect(updateServerProfileMock).toHaveBeenCalledWith({ reviewed: true }));
    expect(view.getByTestId("server-save-success").textContent)
      .toContain("reviewed and saved");
  });

  test("save button uses shared primary Button styling", async () => {
    const view = render(<ServerSection />);

    await waitFor(() => {
      expect(view.getByText("Test Server")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(view.getByTestId("server-edit-button"));
    });

    const saveButton = within(view.getByTestId("server-edit-form")).getByRole("button", {
      name: "Save",
    });
    expect(saveButton.className).not.toContain("text-primary-foreground");
    expect(saveButton.className).toContain("text-[var(--on-primary)]");
  });

  test("read-only when manage_server_operations is absent", async () => {
    mockCaps = ["read_server_settings"];

    const view = render(<ServerSection />);

    await waitFor(() => {
      expect(view.getByText("Test Server")).toBeTruthy();
    });

    expect(view.queryByTestId("server-edit-button")).toBeNull();
    expect(view.queryByTestId("server-edit-form")).toBeNull();
    expect(view.queryByTestId("context-retention-card")).toBeNull();
    expect(view.queryByRole("heading", { name: "Web research (server-wide)" })).toBeNull();
  });

  test("saves the server-wide web-research provider without surfacing credentials", async () => {
    const view = render(<SearchSection />);
    await waitFor(() => {
      expect(view.getByRole("heading", { name: "Web research (server-wide)" })).toBeTruthy();
    });

    expect(view.getByText(/API keys and other credentials remain separate/i)).toBeTruthy();
    await act(async () => {
      fireEvent.click(view.getByRole("radio", { name: /DuckDuckGo only/ }));
      fireEvent.click(view.getByRole("button", { name: "Save" }));
    });

    await waitFor(() => {
      expect(updateResearchProviderMock).toHaveBeenCalledWith("duckduckgo_html");
    });
  });

  test("saves a valid server-wide recent conversation limit", async () => {
    const view = render(<StenographerSection />);

    await waitFor(() => {
      expect((view.getByTestId("recent-conversation-limit-input") as HTMLInputElement).value)
        .toBe("50");
    });

    await act(async () => {
      fireEvent.input(view.getByTestId("recent-conversation-limit-input"), {
        target: { value: "75" },
      });
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Save context retention" }));
    });

    await waitFor(() => {
      expect(setServerContextMock).toHaveBeenCalledWith({
        recentConversationLimit: 75,
        minimumFullTurns: 1,
        maxRoomContextPercent: 50,
        stenographerPriorConversationLimit: 10,
      });
      expect(view.getByTestId("context-retention-success")).toBeTruthy();
    });
  });

  test("rejects a context limit outside 10–100 before transport", async () => {
    const view = render(<StenographerSection />);
    await waitFor(() => {
      expect(view.getByTestId("recent-conversation-limit-input")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.input(view.getByTestId("recent-conversation-limit-input"), {
        target: { value: "9" },
      });
    });

    expect(
      view.getByText("Enter whole numbers within each setting’s displayed range."),
    ).toBeTruthy();
    expect(setServerContextMock).not.toHaveBeenCalled();
  });

  test("saves complete-turn and model-window Room context policy together", async () => {
    const view = render(<StenographerSection />);
    await waitFor(() => {
      expect(view.getByTestId("minimum-full-turns-input")).toBeTruthy();
      expect(view.getByTestId("max-room-context-percent-input")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.input(view.getByTestId("minimum-full-turns-input"), {
        target: { value: "3" },
      });
      fireEvent.input(view.getByTestId("max-room-context-percent-input"), {
        target: { value: "65" },
      });
    });
    await waitFor(() => {
      expect(
        (view.getByRole("button", {
          name: "Save context retention",
        }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Save context retention" }));
    });

    await waitFor(() => {
      expect(setServerContextMock).toHaveBeenCalledWith({
        recentConversationLimit: 50,
        minimumFullTurns: 3,
        maxRoomContextPercent: 65,
        stenographerPriorConversationLimit: 10,
      });
    });
  });

  test("saves the Stenographer prior-context window with the Room context policy", async () => {
    const view = render(<StenographerSection />);
    await waitFor(() => {
      expect(view.getByTestId("stenographer-prior-conversation-limit-input"))
        .toBeTruthy();
    });

    await act(async () => {
      fireEvent.input(
        view.getByTestId("stenographer-prior-conversation-limit-input"),
        { target: { value: "25" } },
      );
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Save context retention" }));
    });

    await waitFor(() => {
      expect(setServerContextMock).toHaveBeenCalledWith({
        recentConversationLimit: 50,
        minimumFullTurns: 1,
        maxRoomContextPercent: 50,
        stenographerPriorConversationLimit: 25,
      });
    });
  });
});
