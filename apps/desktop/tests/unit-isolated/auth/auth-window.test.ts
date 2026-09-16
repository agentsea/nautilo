/**
 * M101 — `openAuthWindow` titles + `onClose` semantics (Electron mocked).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { NAUTILO_DESIGN_TOKENS } from "@nautilo/config/design-tokens";

type OpenAuthWindowFn = typeof import("../../../electron/auth/auth-window").openAuthWindow;

let openAuthWindow: OpenAuthWindowFn;
let lastFakeWindow: FakeBrowserWindow | null = null;
const fakeNativeTheme = {
  themeSource: "system" as "system" | "light" | "dark",
  shouldUseDarkColors: false,
};

class FakeBrowserWindow {
  opts: Record<string, unknown>;
  private readonly closedListeners: Array<() => void> = [];
  private readonly pageTitleUpdatedListeners: Array<(
    event: { preventDefault: () => void },
  ) => void> = [];
  private readonly navigationListeners: Array<(_event: unknown, url: string) => void> = [];
  closeCount = 0;
  focusCount = 0;

  constructor(opts: Record<string, unknown>) {
    this.opts = opts;
    lastFakeWindow = this;
  }

  once(ev: string, fn: () => void) {
    if (ev === "ready-to-show") queueMicrotask(fn);
  }

  setMenuBarVisibility() {}

  show() {}

  focus() {
    this.focusCount += 1;
  }

  isVisible() {
    return true;
  }

  on(ev: string, fn: () => void) {
    if (ev === "closed") this.closedListeners.push(fn);
    if (ev === "page-title-updated") {
      this.pageTitleUpdatedListeners.push(
        fn as (event: { preventDefault: () => void }) => void,
      );
    }
  }

  webContents = {
    on: (ev: string, fn: (_event: unknown, url: string) => void) => {
      if (ev === "did-navigate") this.navigationListeners.push(fn);
    },
    executeJavaScript: () => Promise.resolve(undefined),
    setWindowOpenHandler: () => {},
  };

  loadURL() {}

  isDestroyed() {
    return false;
  }

  /** Simulate the user closing the window (no prior `closeAuthSurface`). */
  emitUserClosed() {
    for (const fn of this.closedListeners) fn();
  }

  /** What `closeAuthSurface` invokes — same as real `BrowserWindow#close`. */
  close() {
    this.closeCount += 1;
    for (const fn of this.closedListeners) fn();
  }

  emitNavigate(url: string) {
    for (const fn of this.navigationListeners) fn({}, url);
  }

  emitPageTitleUpdated() {
    const preventDefault = mock(() => {});
    for (const fn of this.pageTitleUpdatedListeners) fn({ preventDefault });
    return preventDefault;
  }
}

beforeAll(async () => {
  mock.module("electron", () => ({
    BrowserWindow: FakeBrowserWindow,
    nativeTheme: fakeNativeTheme,
  }));
  lastFakeWindow = null;
  ({ openAuthWindow } = await import("../../../electron/auth/auth-window"));
});

afterAll(() => {
  mock.restore();
});

describe("openAuthWindow", () => {
  const fakeParent = {} as NonNullable<
    Parameters<OpenAuthWindowFn>[0]["parent"]
  >;

  test("window title matches kind (default sign-in)", () => {
    lastFakeWindow = null;
    openAuthWindow({
      parent: null,
      url: "https://logto.test/oidc/auth",
    });
    expect(lastFakeWindow?.opts["title"]).toBe("Sign in to Nautilo");
  });

  test("uses the Workbench theme for hosted auth and restores the prior native theme", () => {
    fakeNativeTheme.themeSource = "system";
    lastFakeWindow = null;
    const handle = openAuthWindow({
      parent: null,
      url: "https://logto.test/oidc/auth",
      theme: "dark",
    });

    expect(fakeNativeTheme.themeSource).toBe("dark");
    expect(lastFakeWindow?.opts["backgroundColor"]).toBe(
      NAUTILO_DESIGN_TOKENS.semantic.dark.surface.background.$value,
    );

    handle.closeAuthSurface();
    expect(fakeNativeTheme.themeSource).toBe("system");
  });

  test("hosted page titles cannot replace the trusted native title", () => {
    lastFakeWindow = null;
    openAuthWindow({
      parent: null,
      url: "https://logto.test/oidc/auth",
    });

    const preventDefault = lastFakeWindow!.emitPageTitleUpdated();

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(lastFakeWindow?.opts["title"]).toBe("Sign in to Nautilo");
  });

  test("sign-in keeps parent grouping without modal sheet chrome", () => {
    lastFakeWindow = null;
    openAuthWindow({
      parent: fakeParent,
      url: "https://logto.test/oidc/auth",
      kind: "sign-in",
    });
    expect(lastFakeWindow?.opts["parent"]).toBe(fakeParent);
    expect(lastFakeWindow?.opts["modal"]).toBeUndefined();
  });

  test("candidate sign-in uses only its supplied ephemeral partition", () => {
    lastFakeWindow = null;
    openAuthWindow({
      parent: null,
      url: "https://logto.test/oidc/auth",
      partition: "candidate:d514-b",
    });
    expect((lastFakeWindow?.opts["webPreferences"] as Record<string, unknown>)?.["partition"])
      .toBe("candidate:d514-b");
  });

  test("ordinary sign-in leaves the default session partition unspecified", () => {
    lastFakeWindow = null;
    openAuthWindow({ parent: null, url: "https://logto.test/oidc/auth" });
    expect((lastFakeWindow?.opts["webPreferences"] as Record<string, unknown>)?.["partition"])
      .toBeUndefined();
  });

  test("step-up remains modal on parent", () => {
    lastFakeWindow = null;
    openAuthWindow({
      parent: fakeParent,
      url: "https://logto.test/oidc/auth",
      kind: "step-up",
    });
    expect(lastFakeWindow?.opts["parent"]).toBe(fakeParent);
    expect(lastFakeWindow?.opts["modal"]).toBe(true);
  });

  test("title for step-up, account-page, forgot-password, invite-redeem", () => {
    const kinds = [
      ["step-up", "Verify it's you"],
      ["account-page", "Update your account"],
      ["forgot-password", "Reset your password"],
      ["invite-redeem", "Accept your Nautilo invite"],
    ] as const;
    for (const [kind, title] of kinds) {
      lastFakeWindow = null;
      openAuthWindow({
        parent: null,
        url: "https://example.com",
        kind,
      });
      expect(lastFakeWindow?.opts["title"]).toBe(title);
    }
  });

  test("onClose closedByUser: true when closed without closeAuthSurface", () => {
    lastFakeWindow = null;
    let result: { closedByUser: boolean } | undefined;
    openAuthWindow({
      parent: null,
      url: "https://example.com",
      kind: "step-up",
      onClose: (r) => {
        result = r;
      },
    });
    lastFakeWindow!.emitUserClosed();
    expect(result).toEqual({ closedByUser: true });
  });

  test("onClose closedByUser: false when closeAuthSurface ran first", () => {
    lastFakeWindow = null;
    let result: { closedByUser: boolean } | undefined;
    const { closeAuthSurface } = openAuthWindow({
      parent: null,
      url: "https://example.com",
      kind: "step-up",
      onClose: (r) => {
        result = r;
      },
    });
    closeAuthSurface();
    expect(result).toEqual({ closedByUser: false });
  });

  test("forgot-password auth window closes when Logto lands on sign-in", () => {
    lastFakeWindow = null;
    const fakeParentWithFocus = { focus: mock(() => {}) } as unknown as NonNullable<
      Parameters<OpenAuthWindowFn>[0]["parent"]
    >;
    openAuthWindow({
      parent: fakeParentWithFocus,
      url: "https://logto.test/reset-password?app_id=workbench",
      kind: "forgot-password",
    });

    lastFakeWindow!.emitNavigate("https://logto.test/sign-in?app_id=workbench");

    expect(lastFakeWindow?.closeCount).toBe(1);
    expect(fakeParentWithFocus.focus).toHaveBeenCalled();
  });

  test("forgot-password auth window closes when Logto leaves to Workbench origin", () => {
    lastFakeWindow = null;
    const fakeParentWithFocus = { focus: mock(() => {}) } as unknown as NonNullable<
      Parameters<OpenAuthWindowFn>[0]["parent"]
    >;
    openAuthWindow({
      parent: fakeParentWithFocus,
      url: "https://logto.test/reset-password?app_id=workbench",
      kind: "forgot-password",
    });

    lastFakeWindow!.emitNavigate("https://workbench.test/auth/callback?code=x&state=y");

    expect(lastFakeWindow?.closeCount).toBe(1);
    expect(fakeParentWithFocus.focus).toHaveBeenCalled();
  });

  test("forgot-password auth window does not close on unrelated origin drift", () => {
    lastFakeWindow = null;
    const fakeParentWithFocus = { focus: mock(() => {}) } as unknown as NonNullable<
      Parameters<OpenAuthWindowFn>[0]["parent"]
    >;
    openAuthWindow({
      parent: fakeParentWithFocus,
      url: "https://logto.test/reset-password?app_id=workbench",
      kind: "forgot-password",
    });

    lastFakeWindow!.emitNavigate("https://auth-alias.test/reset-password?app_id=workbench");

    expect(lastFakeWindow?.closeCount).toBe(0);
    expect(fakeParentWithFocus.focus).not.toHaveBeenCalled();
  });

  test("sign-in auth window does not close on Logto sign-in page", () => {
    lastFakeWindow = null;
    openAuthWindow({
      parent: null,
      url: "https://logto.test/oidc/auth",
      kind: "sign-in",
    });

    lastFakeWindow!.emitNavigate("https://logto.test/sign-in?app_id=desktop");

    expect(lastFakeWindow?.closeCount).toBe(0);
  });
});
