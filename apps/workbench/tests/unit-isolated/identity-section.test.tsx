import { act } from "react";
import type { ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

let happyWindow: Window;

const harness = {
  isVerified: true,
  displayName: "Operator",
  handle: "operator",
  label: "Operator",
  staleWhoami: false,
};

let whoamiCallCount = 0;

const priorGlobals: Record<string, unknown> = {};
let root: Root | null = null;

beforeAll(() => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  for (const k of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "localStorage",
    "sessionStorage",
  ] as const) {
    priorGlobals[k] = (globalThis as Record<string, unknown>)[k];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    localStorage: happyWindow.localStorage,
    sessionStorage: happyWindow.sessionStorage,
  });
  Object.defineProperty(happyWindow, "event", {
    value: undefined,
    configurable: true,
    writable: true,
  });

  mock.module("../../src/hooks/use-auth", () => ({
    AuthProvider: ({ children }: { children: ReactNode }) => children,
    computeViewerOnWhoamiFailure: (prev: { staleWhoami?: boolean } & Record<string, unknown>) =>
      prev?.staleWhoami ? prev : { ...prev, staleWhoami: true },
    computeViewerOnNullToken: (cached: Record<string, unknown> | null) =>
      cached
        ? { ...cached, staleWhoami: true }
        : {
            role: "guest", label: "Guest", userIdentity: null, sessionUserId: null,
            isVerified: false, staleWhoami: false, displayName: null, handle: null,
          },
    useAuth: () => ({
      session: {
        state: "signed-in" as const,
        signIn: async () => {},
        signOut: async () => {},
        getAccessToken: async () => "token",
      },
      viewer: {
        role: "owner" as const,
        label: harness.label,
        userIdentity: "u",
        sessionUserId: "user-1",
        sessionActorId: "actor-1",
        isVerified: harness.isVerified,
        staleWhoami: harness.staleWhoami,
        displayName: harness.displayName,
        handle: harness.handle,
        capabilities: [],
        features: { office: { enabled: false } },
      },
      groups: [],
      credentialGeneration: 1,
      viewerGeneration: 1,
    }),
  }));

  mock.module("../../src/hooks/use-profile", () => ({
    useProfile: () => ({
      response: null,
      agent: null,
      avatarSrc: "",
      avatarLoading: false,
      avatarError: null,
      loading: false,
      error: null,
      refresh: async () => {},
    }),
  }));

  mock.module("../../src/lib/api", () => ({
    apiClient: {
      whoami: async () => {
        whoamiCallCount += 1;
        throw new Error("IdentitySection must not call whoami");
      },
    },
  }));

  mock.module("../../src/components/avatar/AvatarUploader", () => ({
    AvatarUploader: () => <div data-testid="avatar-uploader">Avatar uploader</div>,
  }));
});

beforeEach(async () => {
  whoamiCallCount = 0;
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
});

afterAll(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
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

async function renderIdentitySection(): Promise<string> {
  const { IdentitySection } = await import(
    "../../src/pages/settings/sections/identity-section"
  );
  const container = happyWindow.document.createElement("div");
  root = createRoot(container);
  await act(async () => {
    root!.render(<IdentitySection />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container.innerHTML;
}

describe("IdentitySection", () => {
  test("renders heading and human identity fields from AuthViewer (no whoami)", async () => {
    harness.isVerified = true;
    harness.displayName = "Operator";
    harness.handle = "operator";
    harness.label = "Operator";
    harness.staleWhoami = false;
    const html = await renderIdentitySection();
    expect(whoamiCallCount).toBe(0);
    expect(html).toContain('data-testid="identity-section"');
    expect(html).toContain("Your identity");
    expect(html).toContain("This changes how YOU appear to others");
    expect(html).toContain("Operator");
    expect(html).toContain("@operator");
    expect(html).toContain('data-testid="avatar-uploader"');
  });

  test("renders guest placeholder when viewer is not verified", async () => {
    harness.isVerified = false;
    const html = await renderIdentitySection();
    expect(whoamiCallCount).toBe(0);
    expect(html).toContain("Guest");
    expect(html).not.toContain("@operator");
  });

  test("shows loading copy for stale verified viewer without identity fields yet", async () => {
    harness.isVerified = true;
    harness.staleWhoami = true;
    harness.displayName = null;
    harness.handle = null;
    harness.label = "Operator";
    const html = await renderIdentitySection();
    expect(whoamiCallCount).toBe(0);
    expect(html).toContain("Loading…");
  });
});
