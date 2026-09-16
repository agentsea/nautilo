import { act, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { configure, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

const recoverPasswordWithCode = mock(() =>
  Promise.resolve({
    ok: true as const,
    sessionId: "sess-1",
    sessionToken: "tok-1",
    resetUrl: "https://auth.example/reset-password?identifier=email&login_hint=alice%40nautilo.local",
    email: "alice@nautilo.local",
  }),
);

const getRecoveryRelayCode = mock(() =>
  Promise.resolve({ status: "pending" as const }),
);

const windowOpenMock = mock(() => null);
const signInMock = mock(() => Promise.resolve());

let happyWindow: Window;
let root: Root | null = null;
const priorGlobals: Record<string, unknown> = {};

const DIALOG_SOURCE = join(
  import.meta.dir,
  "../../src/components/forgot-password-dialog.tsx",
);

beforeAll(async () => {
  happyWindow = new Window({ url: "https://nautilo.example.test/" });
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
  happyWindow.open = windowOpenMock as typeof happyWindow.open;
  configure({
    document: happyWindow.document,
    window: happyWindow as unknown as Window & typeof globalThis,
  });

  mock.module("../../src/lib/api", () => ({
    apiClient: { recoverPasswordWithCode, getRecoveryRelayCode },
  }));
  mock.module("../../src/lib/desktop", () => ({
    isDesktop: false,
    desktopAPI: null,
    canSwitchDesktopServer: () => false,
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
    AuthProvider: ({ children }: { children: ReactNode }) => children,
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
    useAuth: () => ({
      session: {
        state: "signed-out" as const,
        signIn: signInMock,
        signOut: async () => {},
        getAccessToken: async () => null,
      },
      viewer: {
        role: "guest" as const,
        label: "Guest",
        userIdentity: null,
        sessionUserId: null,
        isVerified: false,
        staleWhoami: false,
      },
    }),
  }));
});

beforeEach(() => {
  recoverPasswordWithCode.mockClear();
  getRecoveryRelayCode.mockClear();
  windowOpenMock.mockClear();
  signInMock.mockClear();
  recoverPasswordWithCode.mockImplementation(() =>
    Promise.resolve({
      ok: true as const,
      sessionId: "sess-1",
      sessionToken: "tok-1",
          resetUrl: "https://auth.example/reset-password?identifier=email&login_hint=alice%40nautilo.local",
      email: "alice@nautilo.local",
    }),
  );
  getRecoveryRelayCode.mockImplementation(() =>
    Promise.resolve({ status: "pending" as const }),
  );
  happyWindow.document.body.replaceChildren();
  root = null;
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
});

afterAll(() => {
  for (const [k, v] of Object.entries(priorGlobals)) {
    if (v === undefined) {
      delete (globalThis as Record<string, unknown>)[k];
    } else {
      (globalThis as Record<string, unknown>)[k] = v;
    }
  }
  mock.restore();
});

async function flush(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
}

async function flushUntil(predicate: () => boolean, maxTicks = 120): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await flush();
  }
}

async function mountDialog(onClose = () => {}) {
  const { ForgotPasswordDialog } = await import("../../src/components/forgot-password-dialog");
  const host = happyWindow.document.createElement("div");
  happyWindow.document.body.append(host);
  root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    root?.render(
      <ForgotPasswordDialog
        onClose={onClose}
        testDefaults={{ handle: "alice", recoveryCode: "recovery-secret" }}
      />,
    );
  });
  return host;
}

describe("ForgotPasswordDialog (M120)", () => {
  test("isValidResetUrl accepts https and localhost http", async () => {
    const { isValidResetUrl } = await import("../../src/components/forgot-password-dialog");
    expect(isValidResetUrl("")).toBe(false);
    expect(isValidResetUrl("   ")).toBe(false);
    expect(isValidResetUrl("http://example.com/x")).toBe(false);
    expect(isValidResetUrl("not a url")).toBe(false);
    expect(isValidResetUrl("https://auth.example/reset?x=1")).toBe(true);
    expect(isValidResetUrl("http://localhost:3000/reset")).toBe(true);
    expect(isValidResetUrl("http://localhost")).toBe(true);
    expect(isValidResetUrl("http://localhost/foo")).toBe(true);
  });

  test("SSR smoke: title and both tab labels", async () => {
    const { ForgotPasswordDialog } = await import("../../src/components/forgot-password-dialog");
    const html = renderToStaticMarkup(<ForgotPasswordDialog onClose={() => {}} />);
    expect(html).toContain("Reset password");
    expect(html).toContain("Use a recovery code");
    expect(html).toContain("I have a reset URL");
    expect(html).not.toContain("New password");
  });

  test("M120 source: Tab A uses relay recover + poll (no newPassword)", () => {
    const src = readFileSync(DIALOG_SOURCE, "utf8");
    expect(src).toContain("recoverPasswordWithCode");
    expect(src).toContain("getRecoveryRelayCode");
    expect(src).toContain('data-testid="recovery-relay-code"');
    expect(src).not.toContain("newPassword");
    expect(src).not.toContain("confirmNewPassword");
    expect(src).toContain("openResetUrl");
    expect(src).toContain('window.open(res.resetUrl, "_blank", "noopener,noreferrer")');
    expect(src).toContain("Sign in with new password");
    expect(src).toContain("return here to sign in to Nautilo");
  });

  test("Tab A submits handle and recoveryCode only, then shows relay code", async () => {
    getRecoveryRelayCode.mockImplementation(() =>
      Promise.resolve({ status: "ready", code: "LOGTO-99" }),
    );

    const onClose = mock(() => {});
    const host = await mountDialog(onClose);
    const form = host.querySelector("form");
    expect(form).not.toBeNull();
    await act(async () => {
      fireEvent.submit(form!);
    });

    await flushUntil(
      () => host.querySelector('[data-testid="recovery-relay-code"]') != null,
    );

    expect(recoverPasswordWithCode).toHaveBeenCalledWith({
      handle: "alice",
      recoveryCode: "recovery-secret",
    });
    expect(recoverPasswordWithCode.mock.calls[0]?.[0]).not.toHaveProperty("newPassword");
    expect(windowOpenMock).toHaveBeenCalledWith(
      "https://auth.example/reset-password?identifier=email&login_hint=alice%40nautilo.local",
      "_blank",
      "noopener,noreferrer",
    );
    expect(getRecoveryRelayCode).toHaveBeenCalledWith({
      sessionId: "sess-1",
      sessionToken: "tok-1",
    });

    const relay = host.querySelector('[data-testid="recovery-relay-code"]');
    expect(relay?.textContent).toBe("LOGTO-99");
    expect(host.textContent).toContain("alice@nautilo.local");
    expect(host.textContent).toContain(
      "request a verification code for",
    );
    expect(host.textContent).toContain("return here to sign in to Nautilo");

    const signInButton = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Sign in with new password",
    );
    expect(signInButton).toBeTruthy();
    await act(async () => {
      fireEvent.click(signInButton!);
    });
    expect(onClose).toHaveBeenCalled();
    expect(signInMock).toHaveBeenCalled();
  });
});
