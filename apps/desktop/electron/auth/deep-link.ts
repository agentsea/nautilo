/**
 * M101 Phase 3 — `nautilo://` custom-protocol deep links (invite, reset-password, account).
 */
import { app, type Event } from "electron";
import { warn } from "@nautilo/logger";
import { parseDeepLink, type DeepLink } from "./deep-link-parse";

export type { DeepLink, DeepLinkKind } from "./deep-link-parse";
export { parseDeepLinksFromArgv } from "./deep-link-parse";

function focusMainWindow(
  getMainWindow: () => import("electron").BrowserWindow | null,
): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) win.show();
  win.focus();
}

export function registerDeepLinkHandler(opts: {
  appName: string;
  getMainWindow: () => import("electron").BrowserWindow | null;
  onDeepLink: (link: DeepLink) => void;
}): { unregister: () => void } {
  const tag = `[deep-link:${opts.appName}]`;

  try {
    app.setAsDefaultProtocolClient("nautilo");
  } catch (e) {
    warn(`${tag} setAsDefaultProtocolClient failed`, e);
  }

  const onOpenUrl = (event: Event, url: string): void => {
    event.preventDefault();
    const link = parseDeepLink(url);
    if (link) opts.onDeepLink(link);
    else warn(`${tag} rejected open-url`, url);
    focusMainWindow(opts.getMainWindow);
  };

  let darwinAttached = false;

  const attachDarwin = (): void => {
    if (process.platform !== "darwin" || darwinAttached) return;
    darwinAttached = true;
    app.on("open-url", onOpenUrl);
  };

  if (process.platform === "darwin") {
    if (app.isReady()) attachDarwin();
    else app.once("ready", attachDarwin);
  }

  return {
    unregister: (): void => {
      if (process.platform === "darwin") {
        app.removeListener("open-url", onOpenUrl);
        darwinAttached = false;
      }
    },
  };
}
