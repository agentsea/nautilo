import { act } from "react";
import type { ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { PROFILE_AVATAR_URL, type AgentProfileResponse } from "@nautilo/types";

const profileResponse: AgentProfileResponse = {
  viewerRole: "owner",
  agent: {
    name: "Jeannie",
    language: "en",
    voices: { default: { voiceId: "voice-1", voiceName: "Voice" } },
    avatar: { kind: "generated", path: "avatar.png" },
    avatarUrl: PROFILE_AVATAR_URL,
    defaultModel: null,
    personality: { prompt: null, tone: null, motherAnswer: null },
    privacySpectrum: null,
    workLifeMode: null,
    soulFile: "Generated soul",
    onboardingCompleted: true,
    welcomeMessageSent: true,
    agentIdentity: "agent-1",
    publicProfile: false,
    fallback: { enabled: false, chain: [] },
  },
};

let authProviderLatchedToken: string | null = null;
let accessTokenAvailable = true;
let authCredentialGeneration = 0;
const authSession = {
  state: "signed-in" as const,
  signIn: async () => {},
  signOut: async () => {},
  // Model AuthProvider's public session getter: token acquisition and
  // api-client latching happen before ProfileProvider sees the token.
  // ProfileProvider must consume that canonical path rather than call
  // apiClient.setToken itself.
  getAccessToken: async () => {
    authProviderLatchedToken = accessTokenAvailable ? "token" : null;
    return authProviderLatchedToken;
  },
};
const authViewer = {
  role: "owner" as const,
  label: "Operator",
  userIdentity: "user-1",
  sessionUserId: "user-1",
  sessionActorId: "actor-1",
  isVerified: true,
  staleWhoami: false,
};
const apiStub = {
  setToken: mock(() => undefined),
  getProfile: mock(async () => {
    if (authProviderLatchedToken !== "token") {
      throw new Error("Profile request was not authenticated by AuthProvider");
    }
    return profileResponse;
  }),
};

let resolveAvatarFetch: ((response: Response) => void) | null = null;
const fetchStub = mock(() => new Promise<Response>((resolve) => {
  resolveAvatarFetch = resolve;
}));

let happyWindow: Window;
let root: Root | null = null;
const priorGlobals: Record<string, unknown> = {};
let originalConsoleError: typeof console.error;

beforeAll(() => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  originalConsoleError = console.error;
  console.error = (...args: Parameters<typeof console.error>) => {
    const [first] = args;
    if (typeof first === "string" && first.includes("not wrapped in act")) return;
    originalConsoleError(...args);
  };
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "localStorage",
    "sessionStorage",
    "fetch",
    "URL",
  ] as const) {
    priorGlobals[key] = (globalThis as Record<string, unknown>)[key];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    localStorage: happyWindow.localStorage,
    sessionStorage: happyWindow.sessionStorage,
    fetch: fetchStub,
    URL: happyWindow.URL,
  });
  Object.defineProperty(happyWindow.URL, "createObjectURL", {
    value: () => "blob:avatar",
    configurable: true,
  });
  Object.defineProperty(happyWindow.URL, "revokeObjectURL", {
    value: () => undefined,
    configurable: true,
  });

  mock.module("../../src/hooks/use-auth", () => ({
    AuthProvider: ({ children }: { children: ReactNode }) => children,
    computeViewerOnWhoamiFailure: (prev: Record<string, unknown>) =>
      prev["staleWhoami"] === true ? prev : { ...prev, staleWhoami: true },
    computeViewerOnNullToken: (cached: Record<string, unknown> | null) =>
      cached
        ? { ...cached, sessionActorId: null, staleWhoami: true }
        : {
            role: "guest",
            label: "Guest",
            userIdentity: null,
            sessionUserId: null,
            sessionActorId: null,
            isVerified: false,
            staleWhoami: false,
          },
    useAuth: () => ({
      session: authSession,
      viewer: authViewer,
      credentialGeneration: authCredentialGeneration,
      viewerGeneration: 0,
    }),
  }));

  mock.module("../../src/lib/api", () => ({
    apiClient: apiStub,
  }));

  mock.module("../../src/lib/desktop", () => ({
    isDesktop: false,
    desktopAPI: null,
  }));
});

beforeEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  apiStub.setToken.mockClear();
  apiStub.getProfile.mockClear();
  authProviderLatchedToken = null;
  accessTokenAvailable = true;
  authCredentialGeneration = 0;
  fetchStub.mockClear();
  resolveAvatarFetch = null;
});

afterAll(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  console.error = originalConsoleError;
  const g = globalThis as Record<string, unknown>;
  for (const key of Object.keys(priorGlobals)) {
    if (priorGlobals[key] === undefined) {
      delete g[key];
    } else {
      g[key] = priorGlobals[key];
    }
  }
  mock.restore();
});

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

describe("ProfileProvider avatar loading", () => {
  test("profile content becomes available while avatar fetch is still pending", async () => {
    const { ProfileProvider, useProfile } = await import("../../src/contexts/profile-context");
    const host = happyWindow.document.createElement("div");

    function Probe() {
      const profile = useProfile();
      return (
        <div
          data-loading={String(profile.loading)}
          data-avatar-loading={String(profile.avatarLoading)}
          data-name={profile.agent?.name ?? ""}
        />
      );
    }

    root = createRoot(host);
    act(() => {
      root!.render(
        <ProfileProvider>
          <Probe />
        </ProfileProvider>,
      );
    });

    await waitFor(() => {
      const probe = host.querySelector("div");
      expect(probe?.getAttribute("data-loading")).toBe("false");
      expect(probe?.getAttribute("data-name")).toBe("Jeannie");
      expect(resolveAvatarFetch).toBeTypeOf("function");
    });

    expect(authProviderLatchedToken).toBe("token");
    expect(apiStub.setToken).not.toHaveBeenCalled();
    expect(apiStub.getProfile).toHaveBeenCalled();
    expect(fetchStub).toHaveBeenCalled();
  });

  test("credential generation refetches a profile when sign-in event preceded mount", async () => {
    const { ProfileProvider, useProfile } = await import("../../src/contexts/profile-context");
    const host = happyWindow.document.createElement("div");

    function Probe() {
      const profile = useProfile();
      return <div data-name={profile.agent?.name ?? ""} />;
    }

    accessTokenAvailable = false;
    root = createRoot(host);
    act(() => {
      root!.render(
        <ProfileProvider>
          <Probe />
        </ProfileProvider>,
      );
    });
    await waitFor(() => expect(apiStub.getProfile).not.toHaveBeenCalled());

    // Electron can finish sign-in before ProfileProvider's DOM transition
    // listener is mounted. AuthProvider's generation is durable React state,
    // so changing it must independently trigger the authenticated refetch.
    accessTokenAvailable = true;
    authCredentialGeneration = 1;
    act(() => {
      root!.render(
        <ProfileProvider>
          <Probe />
        </ProfileProvider>,
      );
    });

    await waitFor(() => {
      expect(host.querySelector("div")?.getAttribute("data-name")).toBe("Jeannie");
      expect(apiStub.getProfile).toHaveBeenCalledTimes(1);
    });
  });
});
