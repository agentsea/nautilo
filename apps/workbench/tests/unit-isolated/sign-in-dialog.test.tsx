import { act } from "react";
import * as React from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mock as bunMock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

type AuthSessionState = "unknown" | "signed-out" | "signing-in" | "signed-in";

type ScopeMismatchIssue = {
  kind: "scope-mismatch";
  expected: {
    instanceId: string;
    serverUrl: string;
    logtoEndpoint: string;
    workbenchAppId: string;
  };
  disk: {
    instanceId: string;
    serverUrl: string;
    logtoEndpoint: string;
    workbenchAppId: string;
  } | null;
};

const mockSession = {
  state: "signed-out" as AuthSessionState,
  issue: undefined as ScopeMismatchIssue | undefined,
};

const signOutMock = bunMock(async () => {});
const signInMock = bunMock(async () => {});
const openPickerMock = bunMock(async () => {});
const consumeNoticeMock = bunMock(async () => null as null | {
  kind: "env-pinned-auth-cleared";
  expected: { instanceId: string; serverUrl: string; logtoEndpoint: string; workbenchAppId: string };
  disk: { instanceId: string; serverUrl: string; logtoEndpoint: string; workbenchAppId: string } | null;
});
let desktopSwitchAvailable = false;
let desktopInProcessSwitchAvailable = false;

const AuthContext = React.createContext<{
  session: {
    state: AuthSessionState;
    issue?: ScopeMismatchIssue;
    signIn: () => Promise<void>;
    signOut: () => Promise<void>;
    getAccessToken: () => Promise<string | null>;
  };
  viewer: {
    role: "guest";
    label: string;
    userIdentity: null;
    sessionUserId: null;
    isVerified: boolean;
  };
} | null>(null);

function MockAuthProvider({ children }: { children: React.ReactNode }) {
  const value = React.useMemo(
    () => ({
      session: {
        get state(): AuthSessionState {
          return mockSession.state;
        },
        get issue(): ScopeMismatchIssue | undefined {
          return mockSession.issue;
        },
        signIn: signInMock,
        signOut: signOutMock,
        getAccessToken: async () => null,
      },
      viewer: {
        role: "guest" as const,
        label: "Guest",
        userIdentity: null,
        sessionUserId: null,
        isVerified: false,
      },
    }),
    [],
  );
  return React.createElement(AuthContext.Provider, { value }, children);
}

function mockUseAuth() {
  const v = React.useContext(AuthContext);
  if (!v) {
    throw new Error("useAuth must be used within <AuthProvider>");
  }
  return v;
}

let SignInDialog: (typeof import("../../src/components/sign-in-dialog"))["SignInDialog"];

const priorGlobals: Record<string, unknown> = {};
let happyWindow: Window;
let clientRoot: Root | null = null;

beforeAll(async () => {
  happyWindow = new Window({ url: "https://upgrade.example.test/" });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  for (const k of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "localStorage",
    "sessionStorage",
    "location",
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
    location: happyWindow.location,
  });

  mock.module("../../src/lib/api", () => ({
    apiClient: {
      getHealth: async () => ({
        status: "ok",
        serverUrl: "https://upgrade.example.test",
      }),
    },
  }));

  mock.module("../../src/lib/desktop", () => ({
    isDesktop: true,
    desktopAPI: {
      auth: {
        consumeNotice: consumeNoticeMock,
      },
      get servers() {
        return desktopSwitchAvailable
          ? {
              openPicker: openPickerMock,
              ...(desktopInProcessSwitchAvailable
                ? {
                    list: async () => ({
                      servers: [],
                      aggregate: {
                        unreadCount: 0,
                        importantUnreadCount: 0,
                        unavailableServerCount: 0,
                      },
                    }),
                    switchTo: async () => ({ ok: true as const }),
                    add: async () => ({ ok: false as const, reason: "cancelled" as const }),
                    close: async () => ({ ok: true as const }),
                    onChanged: () => () => {},
                    onNavigateHome: () => () => {},
                  }
                : {}),
            }
          : undefined;
      },
    },
    canSwitchDesktopServer: () => desktopSwitchAvailable,
    canSwitchDesktopServerInProcess: () => desktopInProcessSwitchAvailable,
    getShellStateOnBoot: () => {
      if (typeof window === "undefined") return null;
      const api = (window as unknown as { nautiloDesktop?: { shellStateOnBoot?: () => unknown } })
        .nautiloDesktop;
      if (!api?.shellStateOnBoot) return null;
      try {
        return api.shellStateOnBoot() ?? null;
      } catch {
        return null;
      }
    },
    computeInitialLastOpenAtSeed: (input: {
      hasEverBeenOpen: boolean;
      shellStateOnBoot: unknown;
      now: number;
    }) => {
      const base = input.hasEverBeenOpen ? input.now : null;
      if (input.shellStateOnBoot != null && input.shellStateOnBoot !== "live" && base === null) {
        return input.now;
      }
      return base;
    },
  }));

  mock.module("../../src/hooks/use-auth", () => ({
    AuthProvider: MockAuthProvider,
    useAuth: mockUseAuth,
    computeViewerOnWhoamiFailure: (prev: { staleWhoami?: boolean } & Record<string, unknown>) =>
      prev?.staleWhoami ? prev : { ...prev, staleWhoami: true },
    computeViewerOnNullToken: (cached: Record<string, unknown> | null) =>
      cached
        ? { ...cached, staleWhoami: true }
        : {
            role: "guest",
            label: "Guest",
            userIdentity: null,
            sessionUserId: null,
            isVerified: false,
            staleWhoami: false,
          },
  }));

  ({ SignInDialog } = await import("../../src/components/sign-in-dialog"));
});

beforeEach(() => {
  mockSession.state = "signed-out";
  mockSession.issue = undefined;
  desktopSwitchAvailable = false;
  desktopInProcessSwitchAvailable = false;
  signOutMock.mockClear();
  signInMock.mockClear();
  openPickerMock.mockClear();
  consumeNoticeMock.mockReset();
  consumeNoticeMock.mockImplementation(async () => null);
});

afterAll(async () => {
  if (clientRoot) {
    await act(async () => {
      clientRoot!.unmount();
    });
    clientRoot = null;
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

function renderDialogStatic(): string {
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(MockAuthProvider, null, React.createElement(SignInDialog)),
    ),
  );
}

async function renderDialogClient(initialEntry = "/"): Promise<HTMLElement> {
  const container = happyWindow.document.createElement("div");
  happyWindow.document.body.replaceChildren(container);
  clientRoot = createRoot(container);
  await act(async () => {
    clientRoot!.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: [initialEntry] },
        React.createElement(MockAuthProvider, null, React.createElement(SignInDialog)),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

describe("SignInDialog", () => {
  test("renders Sign in, 'I have an invite', and 'Forgot password?' (M106)", () => {
    const html = renderDialogStatic();
    expect(html).toContain('data-testid="sign-in-dialog"');
    expect(html).toContain('data-testid="sign-in-submit"');
    expect(html).toContain('data-testid="sign-in-i-have-an-invite"');
    expect(html).toContain('data-testid="sign-in-forgot-password"');
    expect(html).toContain("Sign in");
    expect(html).toContain("I have an invite");
    expect(html).toContain("Forgot password?");
  });

  test("does NOT render the legacy 'Open server home' link", () => {
    const html = renderDialogStatic();
    expect(html).not.toContain("Open server home");
  });

  test("shows Redirecting and disables Sign in / invite / forgot affordances when signing-in", () => {
    mockSession.state = "signing-in";
    const html = renderDialogStatic();
    expect(html).toContain("Redirecting");
    const disabledButtonCount = (html.match(/<button[^>]*\bdisabled(?:=|\s|>)/g) ?? []).length;
    expect(disabledButtonCount).toBeGreaterThanOrEqual(3);
  });

  test("password-updated banner not present on first render", () => {
    const html = renderDialogStatic();
    expect(html).not.toContain("Password updated. Sign in with your new password.");
  });

  test("renders active server URL above the primary action (3F)", () => {
    const html = renderDialogStatic();
    expect(html).toContain('data-testid="sign-in-active-server"');
    expect(html).toContain("https://upgrade.example.test");
  });

  test("shows pre-auth Switch server affordance when desktop switch bridge is available", () => {
    desktopSwitchAvailable = true;
    const html = renderDialogStatic();
    expect(html).toContain('data-testid="sign-in-switch-server"');
    expect(html).toContain("Not the right server? Switch server…");
  });

  test("pre-auth Switch server affordance is hidden without desktop switch bridge", () => {
    desktopSwitchAvailable = false;
    const html = renderDialogStatic();
    expect(html).not.toContain('data-testid="sign-in-switch-server"');
  });

  test("mismatch recovery names current and saved servers in plain language", () => {
    mockSession.issue = {
      kind: "scope-mismatch",
      expected: {
        instanceId: "default",
        serverUrl: "https://upgrade.example.test",
        logtoEndpoint: "https://auth.example",
        workbenchAppId: "wb",
      },
      disk: {
        instanceId: "default",
        serverUrl: "https://old.nautilo.example",
        logtoEndpoint: "https://auth.example",
        workbenchAppId: "wb",
      },
    };
    const html = renderDialogStatic();
    expect(html).toContain('data-testid="stale-auth-recovery"');
    expect(html).toContain("https://upgrade.example.test");
    expect(html).toContain("https://old.nautilo.example");
    expect(html).not.toContain("paired");
  });

  test("Choose another server is hidden without desktop switch bridge", () => {
    mockSession.issue = {
      kind: "scope-mismatch",
      expected: {
        instanceId: "default",
        serverUrl: "https://upgrade.example.test",
        logtoEndpoint: "https://auth.example",
        workbenchAppId: "wb",
      },
      disk: null,
    };
    desktopSwitchAvailable = false;
    const html = renderDialogStatic();
    expect(html).not.toContain('data-testid="choose-another-server"');
  });

  test("Choose another server appears when desktop switch bridge is available", () => {
    mockSession.issue = {
      kind: "scope-mismatch",
      expected: {
        instanceId: "default",
        serverUrl: "https://upgrade.example.test",
        logtoEndpoint: "https://auth.example",
        workbenchAppId: "wb",
      },
      disk: null,
    };
    desktopSwitchAvailable = true;
    const html = renderDialogStatic();
    expect(html).toContain('data-testid="choose-another-server"');
  });

  test("clear action transitions to post-clear sign-in CTA", async () => {
    mockSession.issue = {
      kind: "scope-mismatch",
      expected: {
        instanceId: "default",
        serverUrl: "https://upgrade.example.test",
        logtoEndpoint: "https://auth.example",
        workbenchAppId: "wb",
      },
      disk: {
        instanceId: "default",
        serverUrl: "https://old.nautilo.example",
        logtoEndpoint: "https://auth.example",
        workbenchAppId: "wb",
      },
    };
    const container = await renderDialogClient();
    const clearBtn = container.querySelector('[data-testid="clear-stale-auth"]');
    expect(clearBtn).not.toBeNull();
    await act(async () => {
      (clearBtn as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(container.innerHTML).toContain('data-testid="stale-auth-cleared-banner"');
    expect(container.innerHTML).not.toContain('data-testid="stale-auth-recovery"');
  });

  test("Choose another server calls servers.openPicker", async () => {
    mockSession.issue = {
      kind: "scope-mismatch",
      expected: {
        instanceId: "default",
        serverUrl: "https://upgrade.example.test",
        logtoEndpoint: "https://auth.example",
        workbenchAppId: "wb",
      },
      disk: null,
    };
    desktopSwitchAvailable = true;
    const container = await renderDialogClient();
    const switchBtn = container.querySelector('[data-testid="choose-another-server"]');
    expect(switchBtn).not.toBeNull();
    await act(async () => {
      (switchBtn as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(openPickerMock).toHaveBeenCalledTimes(1);
  });

  test("pre-auth Switch server calls servers.openPicker", async () => {
    desktopSwitchAvailable = true;
    const container = await renderDialogClient();
    const switchBtn = container.querySelector('[data-testid="sign-in-switch-server"]');
    expect(switchBtn).not.toBeNull();
    await act(async () => {
      (switchBtn as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(openPickerMock).toHaveBeenCalledTimes(1);
  });

  test("pre-auth Switch server uses the token-preserving in-process switcher", async () => {
    desktopSwitchAvailable = true;
    desktopInProcessSwitchAvailable = true;
    const container = await renderDialogClient();
    const switchBtn = container.querySelector('[data-testid="sign-in-switch-server"]');
    expect(switchBtn).not.toBeNull();
    await act(async () => {
      (switchBtn as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-testid="server-switcher-overlay"]')).not.toBeNull();
    expect(openPickerMock).not.toHaveBeenCalled();
  });

  test("renders env-pinned auto-clear notice", async () => {
    consumeNoticeMock.mockImplementation(async () => ({
      kind: "env-pinned-auth-cleared",
      expected: {
        instanceId: "",
        serverUrl: "https://upgrade.example.test",
        logtoEndpoint: "https://auth.upgrade.example.test",
        workbenchAppId: "dev-desktop",
      },
      disk: {
        instanceId: "",
        serverUrl: "https://nautilo.example.test",
        logtoEndpoint: "https://auth.nautilo.example.test",
        workbenchAppId: "test-desktop",
      },
    }));
    const container = await renderDialogClient();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.innerHTML).toContain('data-testid="auth-auto-clear-notice"');
    expect(container.innerHTML).toContain("https://nautilo.example.test");
    expect(container.innerHTML).toContain("https://upgrade.example.test");
  });

  test("captures the exact protected guide destination immediately before normal sign-in", async () => {
    signInMock.mockClear();
    happyWindow.sessionStorage.clear();
    const container = await renderDialogClient("/help/server");
    const button = container.querySelector<HTMLButtonElement>('[data-testid="sign-in-submit"]');
    if (!button) throw new Error("sign-in action did not render");
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(signInMock).toHaveBeenCalledTimes(1);
    expect(happyWindow.sessionStorage.getItem("nautilo.authReturn.v1")).toBe(
      JSON.stringify({ version: 1, destination: "server-guide" }),
    );
  });
});
