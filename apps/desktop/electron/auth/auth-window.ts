/**
 * M055 follow-up — embedded sign-in `BrowserWindow`.
 *
 * Trade-off vs. `shell.openExternal` (RFC 8252 §7.3 recommendation):
 *
 *  + UX stays in-app — no jarring context switch to Safari/Chrome.
 *  + The window is sandboxed (`contextIsolation`, `sandbox: true`,
 *    `nodeIntegration: false`); the renderer can't reach Electron
 *    APIs even if the OIDC page were compromised.
 *  - Passkeys / WebAuthn are flaky in Electron's bundled Chromium
 *    (no platform-authenticator integration). Password + social
 *    login work; if the user has only a passkey, they'll need a
 *    fallback. Acceptable for the dev / single-user-box surface
 *    today; revisit if family-mode adds passkey-only members.
 *  - The embedded surface doesn't autofill from the OS password
 *    manager. Users with a saved password in their default browser
 *    won't see it here.
 *
 * The loopback HTTP server (`loopback-server.ts`) still catches the
 * `127.0.0.1:<port>/callback` redirect — that part is unchanged. The
 * window only renders the Logto sign-in pages and gets closed once
 * the loopback fires.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { BrowserWindow, nativeTheme, type BaseWindow } from "electron";
import type { App } from "electron";
import { NAUTILO_DESIGN_TOKENS } from "@nautilo/config/design-tokens";
import {
  classifyAuthWindowLoadFailure,
  renderLogtoUnreachablePageHtml,
} from "./logto-unreachable-friendly-page";

/** D154 Phase 7 — same basename as `main.ts` `coldBoot:pairToDifferentServer`. */
const CONFIG_FILE_NAME = "config.json";
const PAIRED_SERVER_IDENTITY_FILE = "paired-server-identity.json";

/**
 * Mirrors `ipcMain.handle("coldBoot:pairToDifferentServer")` in main.ts — the
 * auth `BrowserWindow` has no preload, so we cannot invoke that IPC from the
 * data-URL friendly page. Intent is signaled via `about:blank#nautilo-pair-different`
 * (see `did-navigate` listener) before `window.close()`, then this runs from
 * `closed`.
 *
 * Uses `electronApp` from a dynamic `import("electron")` so unit tests that
 * mock only `BrowserWindow` never need to resolve `app` at module load time.
 */
function pairToDifferentServerRelaunchFromAuthWindow(electronApp: App): void {
  const userData = electronApp.getPath("userData");
  try {
    try {
      fs.unlinkSync(path.join(userData, CONFIG_FILE_NAME));
    } catch {
      /* noop */
    }
    try {
      fs.unlinkSync(path.join(userData, PAIRED_SERVER_IDENTITY_FILE));
    } catch {
      /* noop */
    }
  } catch {
    /* noop */
  }
  electronApp.relaunch();
  electronApp.exit(0);
}

function logtoDisplayEndpoint(validatedURL: string, fallbackUrl: string): string {
  for (const candidate of [validatedURL, fallbackUrl]) {
    if (!candidate || candidate.startsWith("data:")) continue;
    try {
      return new URL(candidate).origin;
    } catch {
      /* try next */
    }
  }
  return "(unknown)";
}

/**
 * The kind of auth surface being rendered. Drives window title and any
 * future telemetry tag. Additive — callers without a `kind` get the
 * default sign-in chrome (back-compat for Phase 2 sites).
 *
 * - `sign-in` — initial Logto authorize URL (default).
 * - `step-up` — fresh-JWT re-prompt with `prompt=login&max_age=N` (Phase 5).
 * - `account-page` — Logto-hosted `/account/*` self-service page (Phase 4).
 * - `forgot-password` — pasted reset URL with `?one_time_token=...` (Phase 4).
 * - `invite-redeem` — Logto sign-up URL with the M104 invite token in
 *   OAuth `state` (Phase 3 deep-link destination).
 */
export type AuthWindowKind =
  | "sign-in"
  | "step-up"
  | "account-page"
  | "forgot-password"
  | "invite-redeem";

export interface OpenAuthWindowOptions {
  /**
   * Parent window — embedded auth window is modal-on-parent for step-up
   * and remains grouped with the host for every other auth surface.
   * Electron's BrowserWindow constructor accepts the honest BaseWindow
   * parent type, which covers both the M161 host and legacy BrowserWindow
   * callers without an adapter or cast.
   */
  parent: BaseWindow | null;
  /** URL to load (the Logto `/oidc/auth?...` URL). */
  url: string;
  /**
   * Surface kind — drives the window title. Defaults to `"sign-in"`.
   */
  kind?: AuthWindowKind;
  /** Workbench-selected appearance. Null/omitted follows the OS. */
  theme?: "light" | "dark" | null;
  /** Ephemeral candidate session partition; omitted preserves the default session. */
  partition?: string;
  /**
   * Fired when the underlying `BrowserWindow` emits `closed`, regardless
   * of who closed it (`closeAuthSurface()` or the user clicking X).
   * `closedByUser` is `true` when the surface was destroyed without an
   * explicit programmatic `closeAuthSurface()` call — Phase 5's step-up
   * flow uses this to differentiate user-cancel from a successful
   * loopback-callback close.
   */
  onClose?: (result: { closedByUser: boolean }) => void;
}

export interface AuthWindowHandle {
  closeAuthSurface: () => void;
}

const TITLE_BY_KIND: Record<AuthWindowKind, string> = {
  "sign-in": "Sign in to Nautilo",
  "step-up": "Verify it's you",
  "account-page": "Update your account",
  "forgot-password": "Reset your password",
  "invite-redeem": "Accept your Nautilo invite",
};

const WIDTH = 520;
const HEIGHT = 720;
const AUTH_WINDOW_BACKGROUND = {
  light: NAUTILO_DESIGN_TOKENS.semantic.light.surface.background.$value,
  dark: NAUTILO_DESIGN_TOKENS.semantic.dark.surface.background.$value,
} as const;

const installIdentifierTabFixScript = String.raw`
(() => {
  if (window.__nautiloIdentifierTabFixInstalled) return true;
  window.__nautiloIdentifierTabFixInstalled = true;

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || event.shiftKey) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement)) return;
    if (active.type === "password") return;

    const label = [
      active.name,
      active.id,
      active.autocomplete,
      active.placeholder,
      active.getAttribute("aria-label"),
    ].filter(Boolean).join(" ").toLowerCase();

    if (!/(user|email|identifier|login)/.test(label)) return;

    const password = [...document.querySelectorAll("input[type='password']")]
      .find((node) => node instanceof HTMLInputElement && !node.disabled && node.offsetParent !== null);
    if (!(password instanceof HTMLInputElement)) return;

    event.preventDefault();
    password.focus();
    password.select();
  }, true);

  return true;
})()
`;

/**
 * Open a modal `BrowserWindow` pointed at the Logto auth URL.
 *
 * The window is intentionally minimal: no node integration, no
 * preload, sandbox on. Same defence-in-depth posture the workbench
 * window uses — even though we control which URLs we load, treating
 * the OIDC origin as untrusted means a future XSS in the IdP can't
 * pivot to the host.
 */
export function openAuthWindow(
  options: OpenAuthWindowOptions,
): AuthWindowHandle {
  const kind: AuthWindowKind = options.kind ?? "sign-in";
  const requestedTheme = options.theme === "light" || options.theme === "dark"
    ? options.theme
    : null;
  const previousThemeSource = nativeTheme.themeSource;
  if (requestedTheme !== null) nativeTheme.themeSource = requestedTheme;
  // Modal-sheet style (macOS sheet, lacks native close chrome) is only
  // safe for step-up: it is nested inside an already-signed-in flow and
  // has explicit cancel handling. Initial sign-in must expose native
  // close chrome so the user can return to the idle sign-in form.
  // Hosted-page kinds (`account-page` / `forgot-password` /
  // `invite-redeem`) also need native close to escape Logto terminal
  // screens. Keep `parent` either way for window-grouping + cleanup.
  const isModalSheet = kind === "step-up";
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    minWidth: 380,
    minHeight: 560,
    title: TITLE_BY_KIND[kind],
    backgroundColor: requestedTheme === null
      ? (nativeTheme.shouldUseDarkColors
          ? AUTH_WINDOW_BACKGROUND.dark
          : AUTH_WINDOW_BACKGROUND.light)
      : AUTH_WINDOW_BACKGROUND[requestedTheme],
    // Conditional spread — exactOptionalPropertyTypes rejects an
    // explicit `parent: undefined` even though it's the documented
    // "no parent" value at runtime.
    ...(options.parent
      ? isModalSheet
        ? { parent: options.parent, modal: true }
        : { parent: options.parent }
      : {}),
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(options.partition ? { partition: options.partition } : {}),
    },
  });

  // Don't expose the renderer-side menu — the workbench's
  // application menu is the source of truth for that surface.
  win.setMenuBarVisibility(false);
  // Keep the native title owned by the trusted surface kind. Hosted Logto
  // pages set document.title (for example, "Sign in to your account"), and
  // Electron otherwise copies that untrusted page title into the native
  // window chrome. Besides making the product identity ambiguous, that breaks
  // the exact-title safety contract used by local accessibility automation.
  win.on("page-title-updated", (event) => event.preventDefault());
  win.once("ready-to-show", () => win.show());

  // Logto owns the hosted form DOM. In the embedded Electron surface, its
  // identifier field can swallow Tab instead of advancing to password. Keep
  // the native-feeling path without injecting any privileged APIs.
  win.webContents.on("did-finish-load", () => {
    void win.webContents.executeJavaScript(installIdentifierTabFixScript, true)
      .catch(() => {});
  });

  // Belt-and-braces: never let the auth page open another tab /
  // popup. Anything it tries to spawn (e.g. a "Forgot password"
  // link clicked with target=_blank) goes through the system
  // browser instead so it can't run inside our sandboxed surface
  // pretending to BE the auth page.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void import("electron").then(({ shell }) => {
      void shell.openExternal(url);
    });
    return { action: "deny" };
  });

  const originalRequestedUrl = options.url;
  let userRequestedPairToDifferent = false;
  let closed = false;
  let closedProgrammatically = false;
  function close() {
    if (closed) return;
    closed = true;
    closedProgrammatically = true;
    if (!win.isDestroyed()) win.close();
  }

  win.webContents.on("did-navigate", (_event, url) => {
    try {
      const parsed = new URL(url);
      const original = new URL(originalRequestedUrl);
      if (parsed.protocol === "about:" && parsed.hash === "#nautilo-pair-different") {
        userRequestedPairToDifferent = true;
      }
      if (
        kind === "forgot-password" &&
        ((parsed.origin === original.origin && parsed.pathname === "/sign-in") ||
          parsed.pathname === "/auth/callback")
      ) {
        // The reset URL is a hosted Logto flow, not Electron's loopback
        // sign-in flow. After password save Logto lands on its own sign-in
        // page or the Workbench web callback/root; close this window so the
        // user returns to Nautilo's "Sign in with new password" button, which
        // uses the desktop app id and loopback callback.
        close();
        options.parent?.focus();
      }
    } catch {
      /* ignore malformed navigations */
    }
  });

  void win.loadURL(options.url);

  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      const kind = classifyAuthWindowLoadFailure(errorCode, errorDescription);
      if (kind === "other") return;
      const logtoEndpoint = logtoDisplayEndpoint(validatedURL, originalRequestedUrl);
      const html = renderLogtoUnreachablePageHtml({
        logtoEndpoint,
        retryUrl: originalRequestedUrl,
      });
      void win.webContents.loadURL(
        "data:text/html;charset=utf-8," + encodeURIComponent(html),
      );
    },
  );

  // If the user closes the window manually (clicks X) before the
  // callback fires, the orchestrator's `awaitCallback` will time out
  // (5min default) or reject if the OIDC page redirects to an error.
  // We don't proactively reject from here — the loopback timeout
  // is the single source of truth for "user gave up." The optional
  // `onClose` hook lets the caller observe user-cancel vs. a clean
  // programmatic close (Phase 5 step-up uses it to differentiate).
  win.on("closed", () => {
    if (requestedTheme !== null && nativeTheme.themeSource === requestedTheme) {
      nativeTheme.themeSource = previousThemeSource;
    }
    if (userRequestedPairToDifferent) {
      closed = true;
      void import("electron").then(({ app: electronApp }) => {
        pairToDifferentServerRelaunchFromAuthWindow(electronApp);
      });
      return;
    }
    const wasOpen = !closed;
    closed = true;
    if (options.onClose) {
      options.onClose({ closedByUser: wasOpen || !closedProgrammatically });
    }
  });

  return { closeAuthSurface: close };
}
