import type { DetailedHTMLProps, HTMLAttributes } from "react";
import type { GenieHandoffV1 } from "@nautilo/types";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Focus,
  Globe,
  Home,
  HousePlus,
  Loader2,
  MessageSquarePlus,
  PanelRightClose,
  PanelRightOpen,
  RotateCw,
  Search,
  Square,
  Star,
  X,
} from "lucide-react";
import { desktopAPI } from "../lib/desktop";
import { useAuth } from "../hooks/use-auth";
import { stableViewerKeyForStorage } from "../rooms/room-navigation-storage";
import {
  addPinnedSite,
  getHome,
  isPinned,
  pushHistory,
  removePinnedSite,
  setHome,
  subscribeWebPrefs,
} from "../lib/web-prefs";
import { resolveAddressInput } from "../lib/web-address";
import { buildBrowserPageGenieHandoff } from "../lib/genie-handoff";
import { PasswordBar } from "./password-autofill/PasswordBar";

export interface SaasAppSurfaceProps {
  appId: string;
  displayName: string;
  initialUrl: string;
  mode?: "app" | "browser";
  onClose: () => void;
  onFocus?: () => void;
  onToggleChat?: () => void;
  chatVisible?: boolean;
  assistantName?: string;
  /** Shell-owned, reader-rail scoped bridge; absent means no active draft. */
  onSendToGenie?: (handoff: GenieHandoffV1) => Promise<boolean>;
}

/**
 * Minimal surface of Electron's <webview> element that we rely on. The webview
 * is a real DOM element laid out and clipped by the compositor, so (unlike a
 * native WebContentsView) it stays inside its panel. We only need its
 * webContents id to hand the main process a CDP target.
 */
interface WebviewElement extends HTMLElement {
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  getTitle(): string;
  getWebContentsId(): number;
  executeJavaScript(code: string): Promise<unknown>;
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }): number;
  stopFindInPage(action: "clearSelection" | "keepSelection" | "activateSelection"): void;
  goBack(): void;
  goForward(): void;
  loadURL(url: string): void;
  reload(): void;
  stop(): void;
}

type WebviewProps = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
  src?: string;
  partition?: string;
  allowpopups?: string;
  /**
   * D403 (ISSUE-D403) P0 — guest preload (file:// URL) for the embedded-browser
   * password autofill layer. Path is resolved by main and surfaced via
   * `desktopAPI.embeddedBrowserGuestPreloadPath`.
   */
  preload?: string;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      webview: WebviewProps;
    }
  }
}

function partitionForApp(appId: string): string {
  const safe = appId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `persist:${safe || "saas-app"}`;
}

function pinnedAppIdFor(url: string): string {
  let host = url;
  try {
    host = new URL(url).hostname || url;
  } catch {
    host = url;
  }
  const safe = host.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `pinned-${safe || "site"}`;
}

export function SaasAppSurface({
  appId,
  displayName,
  initialUrl,
  mode = "app",
  onClose,
  onFocus,
  onToggleChat,
  chatVisible,
  assistantName = "Genie",
  onSendToGenie,
}: SaasAppSurfaceProps) {
  const auth = useAuth();
  const viewerKey = stableViewerKeyForStorage(auth.viewer);
  const webviewRef = useRef<WebviewElement | null>(null);
  const partition = partitionForApp(appId);
  // D403 P0 — guest preload for the embedded-browser password autofill layer.
  // Resolved by main and surfaced through the desktop bridge; undefined in the
  // browser and on desktop builds that predate D403 (webview then behaves as
  // before, with no guest preload).
  const guestPreloadPath = desktopAPI?.embeddedBrowserGuestPreloadPath ?? undefined;
  const [address, setAddress] = useState(initialUrl);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [pageTitle, setPageTitle] = useState("");
  const [favicon, setFavicon] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [pinnedNow, setPinnedNow] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [sendToGenieError, setSendToGenieError] = useState<string | null>(null);
  const [findMatches, setFindMatches] = useState<{ active: number; total: number }>({
    active: 0,
    total: 0,
  });
  // D403 P3 — this surface's live guest webContents id, used to filter the
  // save/autofill bar's notices so multiple panels don't cross-wire.
  const [guestWebContentsId, setGuestWebContentsId] = useState<number | null>(null);
  // D403 — origin of the currently-shown page (from the live address). The
  // password Save offer is origin-keyed and shown only while this matches, so it
  // survives the post-submit navigation and hides when the user leaves the site.
  const currentOrigin = ((): string | null => {
    try {
      return new URL(address).origin;
    } catch {
      return null;
    }
  })();
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const isBrowserMode = mode === "browser";

  // Keep the ⭐ state in sync with the current address AND with pin/unpin
  // actions taken elsewhere (e.g. the Web rail) via the web-prefs notifier.
  useEffect(() => {
    const recompute = () => setPinnedNow(isPinned(viewerKey, address));
    recompute();
    return subscribeWebPrefs(recompute);
  }, [viewerKey, address]);

  useEffect(() => {
    const webview = webviewRef.current;
    const browserControl = desktopAPI?.browserControl;
    if (!webview || !browserControl) return;

    let disposed = false;
    let lastWebContentsId: number | null = null;
    const attach = () => {
      // getWebContentsId is only valid once the guest is attached. The guest
      // webContents can be REPLACED (e.g. a full-page sign-in flow swaps the
      // guest), which yields a new id and destroys the old one. Re-adopt
      // whenever the id changes so the CDP shim tracks the live guest; adopt()
      // is idempotent for an unchanged id.
      let webContentsId: number;
      try {
        webContentsId = webview.getWebContentsId();
      } catch {
        return;
      }
      if (webContentsId === lastWebContentsId) return;
      lastWebContentsId = webContentsId;
      // D403 P3 — publish the live guest id to the save/autofill bar.
      setGuestWebContentsId(webContentsId);
      void browserControl
        .attachWebview({
          appId,
          mode,
          partition,
          url: initialUrl,
          webContentsId,
        })
        .catch(() => {
          // A failed adoption may be retried by a later dom-ready, but never
          // let a late failure from this effect disturb a newer surface.
          if (!disposed && webviewRef.current === webview && lastWebContentsId === webContentsId) {
            lastWebContentsId = null;
          }
        });
    };

    webview.addEventListener("dom-ready", attach);
    const updateNavigationState = () => {
      try {
        const url = webview.getURL() || initialUrl;
        setAddress(url);
        setCanGoBack(webview.canGoBack());
        setCanGoForward(webview.canGoForward());
        // History is the shared ad-hoc-browser trail only; per-app SaaS
        // partitions have their own context and are not recorded.
        if (isBrowserMode) {
          let title = "";
          try {
            title = webview.getTitle();
          } catch {
            title = "";
          }
          pushHistory(viewerKey, {
            url,
            ...(title ? { title } : {}),
            at: Date.now(),
          });
        }
      } catch {
        // The guest may be between swaps; the next event will refresh state.
      }
    };
    webview.addEventListener("did-navigate", updateNavigationState);
    webview.addEventListener("did-navigate-in-page", updateNavigationState);
    webview.addEventListener("did-stop-loading", updateNavigationState);

    const onTitle = (event: Event) => {
      const title = (event as unknown as { title?: string }).title;
      setPageTitle(typeof title === "string" ? title : "");
    };
    const onFavicon = (event: Event) => {
      const favicons = (event as unknown as { favicons?: string[] }).favicons;
      setFavicon(Array.isArray(favicons) && favicons.length > 0 ? favicons[0] : null);
    };
    const onStartLoading = () => setIsLoading(true);
    const onStopLoading = () => setIsLoading(false);
    const onFoundInPage = (event: Event) => {
      const result = (event as unknown as {
        result?: { activeMatchOrdinal?: number; matches?: number };
      }).result;
      setFindMatches({
        active: result?.activeMatchOrdinal ?? 0,
        total: result?.matches ?? 0,
      });
    };
    webview.addEventListener("page-title-updated", onTitle);
    webview.addEventListener("page-favicon-updated", onFavicon);
    webview.addEventListener("did-start-loading", onStartLoading);
    webview.addEventListener("did-stop-loading", onStopLoading);
    webview.addEventListener("found-in-page", onFoundInPage);

    // browser_open can mount a visible surface after its guest has already
    // emitted dom-ready. Try the same idempotent adoption path once after all
    // listeners are registered; dom-ready remains the retry path for guests
    // that are not attached yet or are subsequently replaced.
    attach();

    return () => {
      disposed = true;
      webview.removeEventListener("dom-ready", attach);
      webview.removeEventListener("did-navigate", updateNavigationState);
      webview.removeEventListener("did-navigate-in-page", updateNavigationState);
      webview.removeEventListener("did-stop-loading", updateNavigationState);
      webview.removeEventListener("page-title-updated", onTitle);
      webview.removeEventListener("page-favicon-updated", onFavicon);
      webview.removeEventListener("did-start-loading", onStartLoading);
      webview.removeEventListener("did-stop-loading", onStopLoading);
      webview.removeEventListener("found-in-page", onFoundInPage);
      setGuestWebContentsId(null);
      void browserControl.detachWebview({ appId });
    };
  }, [appId, initialUrl, mode, partition, isBrowserMode, viewerKey]);

  const runFind = (query: string, forward = true) => {
    const webview = webviewRef.current;
    if (!webview) return;
    if (query.length === 0) {
      try {
        webview.stopFindInPage("clearSelection");
      } catch {
        /* guest may be mid-swap */
      }
      setFindMatches({ active: 0, total: 0 });
      return;
    }
    try {
      webview.findInPage(query, { forward, findNext: true });
    } catch {
      /* guest may be mid-swap; next keystroke retries */
    }
  };

  const openFind = () => {
    setFindOpen(true);
    // focus after the find bar row mounts
    setTimeout(() => findInputRef.current?.focus(), 0);
    if (findQuery) runFind(findQuery, true);
  };

  const closeFind = () => {
    setFindOpen(false);
    setFindMatches({ active: 0, total: 0 });
    try {
      webviewRef.current?.stopFindInPage("clearSelection");
    } catch {
      /* no-op */
    }
  };

  const navigateToAddress = () => {
    const webview = webviewRef.current;
    const raw = address.trim();
    if (!webview || raw.length === 0) return;
    const nextUrl = resolveAddressInput(raw).url;
    setAddress(nextUrl);
    webview.loadURL(nextUrl);
  };

  const goHome = () => {
    const home = getHome(viewerKey);
    setAddress(home);
    webviewRef.current?.loadURL(home);
  };

  const saveAsHome = () => {
    const webview = webviewRef.current;
    let current = address;
    try {
      current = webview?.getURL() || address;
    } catch {
      current = address;
    }
    if (current) setHome(viewerKey, current);
  };

  const togglePinned = () => {
    const webview = webviewRef.current;
    let url = address;
    try {
      url = webview?.getURL() || address;
    } catch {
      url = address;
    }
    if (!url) return;
    if (isPinned(viewerKey, url)) {
      removePinnedSite(viewerKey, url);
    } else {
      addPinnedSite(viewerKey, {
        appId: pinnedAppIdFor(url),
        displayName: pageTitle || url,
        url,
        mode: "browser",
      });
    }
  };

  const currentUrl = (): string => {
    const webview = webviewRef.current;
    try {
      return webview?.getURL() || address;
    } catch {
      return address;
    }
  };

  const copyCurrentUrl = () => {
    const url = currentUrl();
    if (url) void navigator.clipboard?.writeText(url);
  };

  const openInExternalBrowser = () => {
    const url = currentUrl();
    if (url) void desktopAPI?.browserControl?.openExternal?.({ url });
  };

  const sendToGenie = async () => {
    const webview = webviewRef.current;
    let url = address;
    try {
      url = webview?.getURL() || address;
    } catch {
      url = address;
    }
    let selection: string | undefined;
    try {
      const result = await webview?.executeJavaScript(
        "String(window.getSelection && window.getSelection() || '').slice(0, 4097)",
      );
      selection = typeof result === "string" ? result.normalize("NFC").trim() : undefined;
    } catch {
      selection = undefined;
    }
    try {
      const handoff = buildBrowserPageGenieHandoff({
        intent: "Help me understand this page.",
        context: { url, ...(selection ? { selection } : {}) },
      });
      if (!onSendToGenie || !await onSendToGenie(handoff)) {
        setSendToGenieError("Could not add this page to Genie’s draft.");
        return;
      }
      setSendToGenieError(null);
    } catch {
      setSendToGenieError("Could not add this page to Genie’s draft.");
    }
  };

  return (
    <section
      className={
        isBrowserMode
          ? findOpen
            ? "grid h-full min-h-0 min-w-0 grid-cols-1 grid-rows-[48px_40px_36px_1fr] overflow-hidden bg-background"
            : "grid h-full min-h-0 min-w-0 grid-cols-1 grid-rows-[48px_40px_1fr] overflow-hidden bg-background"
          : "grid h-full min-h-0 min-w-0 grid-cols-1 grid-rows-[48px_1fr] overflow-hidden bg-background"
      }
      data-testid="saas-app-surface"
    >
      <header className="flex items-center justify-between border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2">
          {isBrowserMode ? (
            favicon ? (
              <img
                src={favicon}
                alt=""
                aria-hidden="true"
                className="h-4 w-4 shrink-0 rounded-sm"
                onError={() => setFavicon(null)}
              />
            ) : (
              <Globe aria-hidden="true" className="h-4 w-4 shrink-0 text-foreground-muted" />
            )
          ) : null}
          <div className="min-w-0 truncate text-sm font-medium">
            {isBrowserMode ? pageTitle || displayName : displayName}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={`Send to ${assistantName}`}
            title={`Send this page to ${assistantName}`}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-foreground-muted hover:bg-muted hover:text-foreground"
            onClick={() => {
              void sendToGenie();
            }}
          >
            <MessageSquarePlus aria-hidden="true" className="h-3.5 w-3.5" />
            Send to {assistantName}
          </button>
          {sendToGenieError ? <span role="status" className="text-xs text-destructive">{sendToGenieError}</span> : null}
          {onToggleChat ? (
            <button
              type="button"
              aria-label={chatVisible ? `Hide ${assistantName}` : `Show ${assistantName}`}
              title={chatVisible ? `Hide ${assistantName}` : `Show ${assistantName}`}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-foreground-muted hover:bg-muted hover:text-foreground"
              onClick={onToggleChat}
            >
              {chatVisible ? (
                <PanelRightClose aria-hidden="true" className="h-3.5 w-3.5" />
              ) : (
                <PanelRightOpen aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              {chatVisible ? `Hide ${assistantName}` : `Show ${assistantName}`}
            </button>
          ) : null}
          {onFocus ? (
            <button
              type="button"
              aria-label="Focus"
              title="Focus"
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-foreground-muted hover:bg-muted hover:text-foreground"
              onClick={onFocus}
            >
              <Focus aria-hidden="true" className="h-3.5 w-3.5" />
              Focus
            </button>
          ) : null}
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-foreground-muted hover:bg-muted hover:text-foreground"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </header>
      {isBrowserMode ? (
        <form
          className="flex min-w-0 items-center gap-2 border-b border-border px-3"
          data-testid="browser-chrome"
          onSubmit={(event) => {
            event.preventDefault();
            navigateToAddress();
          }}
        >
          <button
            type="button"
            aria-label="Back"
            title="Back"
            disabled={!canGoBack}
            className="rounded p-1.5 text-foreground-muted hover:bg-muted hover:text-foreground disabled:opacity-40"
            onClick={() => webviewRef.current?.goBack()}
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Forward"
            title="Forward"
            disabled={!canGoForward}
            className="rounded p-1.5 text-foreground-muted hover:bg-muted hover:text-foreground disabled:opacity-40"
            onClick={() => webviewRef.current?.goForward()}
          >
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </button>
          {isLoading ? (
            <button
              type="button"
              aria-label="Stop"
              title="Stop"
              className="rounded p-1.5 text-foreground-muted hover:bg-muted hover:text-foreground"
              onClick={() => webviewRef.current?.stop()}
            >
              <Square aria-hidden="true" className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Reload"
              title="Reload"
              className="rounded p-1.5 text-foreground-muted hover:bg-muted hover:text-foreground"
              onClick={() => webviewRef.current?.reload()}
            >
              <RotateCw aria-hidden="true" className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            aria-label="Home"
            title="Home"
            className="rounded p-1.5 text-foreground-muted hover:bg-muted hover:text-foreground"
            onClick={goHome}
          >
            <Home aria-hidden="true" className="h-4 w-4" />
          </button>
          <input
            aria-label="Browser address"
            className="min-w-0 flex-1 rounded border border-border bg-background-element px-2 py-1 text-xs text-foreground outline-none"
            value={address}
            onInput={(event) => setAddress(event.currentTarget.value)}
          />
          {isLoading ? (
            <Loader2
              aria-hidden="true"
              className="h-4 w-4 shrink-0 animate-spin text-foreground-muted"
            />
          ) : null}
          <button
            type="button"
            aria-label={pinnedNow ? "Unpin site" : "Pin site"}
            aria-pressed={pinnedNow}
            title={pinnedNow ? "Unpin from Web panel" : "Pin to Web panel"}
            className="rounded p-1.5 text-foreground-muted hover:bg-muted hover:text-foreground"
            onClick={togglePinned}
          >
            <Star
              aria-hidden="true"
              className={pinnedNow ? "h-4 w-4 fill-current text-foreground" : "h-4 w-4"}
            />
          </button>
          <button
            type="button"
            aria-label="Set as home"
            title="Set current page as home"
            className="rounded p-1.5 text-foreground-muted hover:bg-muted hover:text-foreground"
            onClick={saveAsHome}
          >
            <HousePlus aria-hidden="true" className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Copy URL"
            title="Copy page URL"
            className="rounded p-1.5 text-foreground-muted hover:bg-muted hover:text-foreground"
            onClick={copyCurrentUrl}
          >
            <Copy aria-hidden="true" className="h-4 w-4" />
          </button>
          {desktopAPI?.browserControl?.openExternal ? (
            <button
              type="button"
              aria-label="Open in external browser"
              title="Open in external browser"
              className="rounded p-1.5 text-foreground-muted hover:bg-muted hover:text-foreground"
              onClick={openInExternalBrowser}
            >
              <ExternalLink aria-hidden="true" className="h-4 w-4" />
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Find in page"
            aria-pressed={findOpen}
            title="Find in page"
            className="rounded p-1.5 text-foreground-muted hover:bg-muted hover:text-foreground"
            onClick={() => (findOpen ? closeFind() : openFind())}
          >
            <Search aria-hidden="true" className="h-4 w-4" />
          </button>
        </form>
      ) : null}
      {isBrowserMode && findOpen ? (
        <div
          className="flex min-w-0 items-center gap-2 border-b border-border bg-background-panel px-3"
          data-testid="browser-find-bar"
        >
          <Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-foreground-muted" />
          <input
            ref={findInputRef}
            aria-label="Find in page input"
            placeholder="Find in page…"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none"
            value={findQuery}
            onInput={(event) => {
              const value = event.currentTarget.value;
              setFindQuery(value);
              runFind(value, true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                runFind(findQuery, !event.shiftKey);
              } else if (event.key === "Escape") {
                event.preventDefault();
                closeFind();
              }
            }}
          />
          <span className="shrink-0 text-[11px] tabular-nums text-foreground-muted">
            {findQuery ? `${findMatches.active}/${findMatches.total}` : ""}
          </span>
          <button
            type="button"
            aria-label="Previous match"
            title="Previous match"
            disabled={findMatches.total === 0}
            className="rounded p-1 text-foreground-muted hover:bg-muted hover:text-foreground disabled:opacity-40"
            onClick={() => runFind(findQuery, false)}
          >
            <ChevronUp aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Next match"
            title="Next match"
            disabled={findMatches.total === 0}
            className="rounded p-1 text-foreground-muted hover:bg-muted hover:text-foreground disabled:opacity-40"
            onClick={() => runFind(findQuery, true)}
          >
            <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Close find"
            title="Close find"
            className="rounded p-1 text-foreground-muted hover:bg-muted hover:text-foreground"
            onClick={closeFind}
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
      <div className="relative min-h-0 min-w-0">
        {/* D403 P3 — gesture-only save/autofill bar, overlaid at the top of the
            guest webview and filtered to this surface's guest webContents id. */}
        <PasswordBar
          webContentsId={guestWebContentsId}
          currentOrigin={currentOrigin}
        />
        <webview
          ref={webviewRef as unknown as React.Ref<HTMLElement>}
          src={initialUrl}
          partition={partition}
          {...(guestPreloadPath ? { preload: guestPreloadPath } : {})}
          className="min-h-0 min-w-0"
          style={{ width: "100%", height: "100%" }}
          data-testid="saas-app-webview"
        />
      </div>
    </section>
  );
}
