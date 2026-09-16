/**
 * D103 P4.5 — Navigation containment.
 *
 * Apply this to every BrowserWindow per `apps/desktop/PRODUCTION.md`
 * §6 ("Per-origin threat model"). Without it, any code that runs in
 * the renderer (a future XSS, a misbehaving Workbench dependency, an
 * `<a href="https://attacker.example/...">` slipping through markdown)
 * can navigate the host window away from its origin and pivot to
 * whatever URL the attacker chose. The guards close that vector by
 * (a) sending external links to the system browser via
 * `shell.openExternal`, and (b) blocking in-app navigation away from
 * the window's allowed origin set.
 *
 * Allowed origins are passed in as plain origin strings (the value
 * returned by `URL.origin` — protocol + host + port). Anything else
 * is denied. An empty allowed-origins array means the window allows
 * no top-level navigation at all — appropriate for `file://`-loaded
 * SPAs that talk to the main process exclusively via IPC (first-run
 * picker, onboarding wizard).
 *
 * Auth windows (`apps/desktop/electron/auth/auth-window.ts`) get
 * their own bespoke `setWindowOpenHandler` because they need to
 * track an OIDC redirect chain across multiple origins; that file
 * remains the source of truth for that flow. This module is for the
 * three first-class app windows (main / first-run / onboarding).
 */
import { type BrowserWindow, shell, type WebContents } from "electron";
import log from "electron-log/main";

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

interface NavigationGuardOptions {
  /**
   * Origins (as returned by `URL.origin` — e.g. `http://127.0.0.1:38492`)
   * that may host or be navigated to within this window. An empty
   * array means no top-level navigation is allowed at all.
   */
  allowedOrigins: readonly string[];
  /** Exact origins permitted only inside child frames. */
  allowedFrameOrigins?: readonly string[];
  /** Exact trusted local shell paths; query parameters are never authority. */
  allowedLocalFilePaths?: readonly string[];
  /**
   * Identifier for log lines when something is blocked. Convention:
   * the window's purpose ("main", "first-run", "onboarding").
   */
  windowName: string;
}

export interface NavigationGuardController {
  /** Atomically release only exact remote origins (no local shell paths). */
  replaceAllowedOrigins(origins: readonly string[]): void;
  /** Atomically hold navigation on exact trusted local shell paths only. */
  holdLocalNavigation(): void;
}

export function isExternalLink(rawUrl: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

/** Preserve the public origin for diagnosis without logging paths or URL capabilities. */
export function safeNavigationUrlForLogging(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.origin;
    }
    return `${parsed.protocol}[redacted]`;
  } catch {
    return "[invalid URL]";
  }
}

/** Pure policy seam for exact-origin and exact-local-shell regression tests. */
export function isAllowedNavigationTarget(
  rawUrl: string,
  allowedOrigins: ReadonlySet<string>,
  allowedLocalFilePaths: ReadonlySet<string>,
): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "file:") {
      return parsed.host === "" && allowedLocalFilePaths.has(decodeURIComponent(parsed.pathname));
    }
    return allowedOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

export function attachNavigationGuards(
  target: BrowserWindow | WebContents,
  options: NavigationGuardOptions,
): NavigationGuardController {
  // BrowserWindow callers (first-run/onboarding) retain their existing
  // behavior. M161's BaseWindow host has no webContents of its own, so the
  // active WebContentsView passes its WebContents directly.
  const contents = "webContents" in target ? target.webContents : target;
  let allowed = toExactOriginSet(options.allowedOrigins);
  const allowedFrames = toExactOriginSet(options.allowedFrameOrigins ?? []);
  const localShellPaths = new Set(options.allowedLocalFilePaths ?? []);
  let allowedLocalFilePaths = new Set(localShellPaths);
  const { windowName } = options;

  const isAllowedOrigin = (rawUrl: string): boolean => {
    return isAllowedNavigationTarget(rawUrl, allowed, allowedLocalFilePaths);
  };

  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedOrigin(url)) return { action: "allow" };
    if (isExternalLink(url)) {
      void shell.openExternal(url).catch((err: unknown) => {
        log.warn(`[nav-guard:${windowName}] shell.openExternal failed`, {
          url: safeNavigationUrlForLogging(url),
          errorName: err instanceof Error ? err.name : typeof err,
        });
      });
    } else {
      log.warn(`[nav-guard:${windowName}] denied window.open`, {
        url: safeNavigationUrlForLogging(url),
      });
    }
    return { action: "deny" };
  });

  contents.on("will-navigate", (event, rawUrl) => {
    if (isAllowedOrigin(rawUrl)) return;
    event.preventDefault();
    if (isExternalLink(rawUrl)) {
      log.info(`[nav-guard:${windowName}] redirected will-navigate to system browser`, {
        url: safeNavigationUrlForLogging(rawUrl),
      });
      void shell.openExternal(rawUrl).catch(() => {});
    } else {
      log.warn(`[nav-guard:${windowName}] blocked will-navigate`, {
        url: safeNavigationUrlForLogging(rawUrl),
      });
    }
  });

  contents.on("will-frame-navigate", (event) => {
    // The main-frame event is enforced by will-navigate. Frame-only authority
    // must never broaden the Workbench's top-level navigation authority.
    if (event.isMainFrame) return;
    if (
      isAllowedOrigin(event.url) ||
      isAllowedNavigationTarget(event.url, allowedFrames, new Set<string>())
    ) return;
    event.preventDefault();
    // A blocked child frame is never externalized: doing so leaks embedded
    // bearer URLs and turns an iframe policy failure into a system-browser launch.
    log.warn(`[nav-guard:${windowName}] blocked will-frame-navigate`, {
      url: safeNavigationUrlForLogging(event.url),
    });
  });

  contents.on("did-fail-load", (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
    if (errorCode === -3 /* ERR_ABORTED — user-initiated navigation cancel */) return;
    log.warn(`[nav-guard:${windowName}] did-fail-load`, {
      errorCode,
      validatedURL: safeNavigationUrlForLogging(validatedURL),
      isMainFrame,
    });
  });

  return {
    replaceAllowedOrigins(origins): void {
      allowed = toExactOriginSet(origins);
      allowedLocalFilePaths = new Set();
    },
    holdLocalNavigation(): void {
      allowed = new Set();
      allowedLocalFilePaths = new Set(localShellPaths);
    },
  };
}

function toExactOriginSet(origins: readonly string[]): Set<string> {
  const next = new Set<string>();
  for (const origin of origins) {
    try {
      if (new URL(origin).origin === origin) next.add(origin);
    } catch {
      // A malformed requested release is ignored; default-deny remains.
    }
  }
  return next;
}
