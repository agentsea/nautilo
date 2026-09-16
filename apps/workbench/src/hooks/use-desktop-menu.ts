/**
 * React hook that wires native menu clicks to workbench actions
 * (D057 2a.4, updated in D075 chunk 2 to drop change-workspace).
 *
 * Mounts once from App. No-op in the browser (when isDesktop is false)
 * so the hook is safe to leave mounted unconditionally.
 *
 * Routing decisions:
 *   - `new-chat`         → navigate to "/" (workbench entry route)
 *   - `new-window`       → stubbed with console.info; multi-window
 *                          support needs main-process coordination.
 *   - `open-settings`    → navigate to "/settings"
 *   - `speak`            → dispatched as a window event the composer
 *                          listens for. Loose coupling keeps this hook
 *                          out of the speech-recognition internals.
 *   - `report-issue`     → opens the GitHub issues URL in the system
 *                          browser.
 *   - `toggle-browser-column` / `toggle-context-panel` → window events
 *                          for WorkbenchShell's panel-sizes hook.
 *
 * NOT handled here:
 *   - `change-workspace` — per D075 chunk 2 the native File menu
 *     action is handled main-side (pick + validate + commit directly).
 *     Renderer updates via `workspace:pathChanged` push. No renderer
 *     dispatch required.
 */

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { isDesktop, desktopAPI, type MenuAction } from "../lib/desktop";

/**
 * Custom DOM event composer can listen for to trigger mic capture from
 * a menu/shortcut. Bubbles on window — composer attaches at mount.
 */
export const MENU_SPEAK_EVENT = "nautilo:menu-speak";

/**
 * D077 — panel toggle events. Shell listens for these to drive
 * usePanelSizes().toggleCollapsed(kind). Dispatched by (a) native menu
 * accelerator on desktop via this hook, (b) the web-keyboard hook when
 * running outside Electron. One listener, two dispatch paths, consistent
 * behavior across surfaces.
 */
export const MENU_TOGGLE_BROWSER_COLUMN_EVENT = "nautilo:toggle-browser-column";
export const MENU_TOGGLE_CONTEXT_PANEL_EVENT = "nautilo:toggle-context-panel";
/** D076 Chunk 4 — navigation rail toggle (⌘⇧0). Same pattern as the
 *  two panel toggles above. */
export const MENU_TOGGLE_NAV_RAIL_EVENT = "nautilo:toggle-nav-rail";

export function useDesktopMenu(): void {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isDesktop || !desktopAPI) return;
    // Capture into a local const so TS narrows it inside the closure;
    // the module-level `desktopAPI` retains its nullable union type and
    // would re-widen inside the callback if used directly.
    const api = desktopAPI;

    const handler = (action: MenuAction): void => {
      switch (action) {
        case "new-chat": {
          // Simplest implementation for 2a scope: navigate to root and
          // let the chat view take care of session creation. Real
          // new-session endpoint wiring lives with D031 Phase 2; for
          // now this mirrors the user clicking the app icon.
          void navigate("/");
          return;
        }
        case "open-settings": {
          void navigate("/settings");
          return;
        }
        case "speak": {
          // Broadcast; the composer owns the mic button + speech hook.
          // Keeping this loosely coupled avoids pulling the speech
          // internals into a top-level hook.
          window.dispatchEvent(new CustomEvent(MENU_SPEAK_EVENT));
          return;
        }
        case "report-issue": {
          window.open(
            "https://github.com/agentsea/nautilo-public/issues/new",
            "_blank",
            "noopener,noreferrer",
          );
          return;
        }
        case "new-window": {
          // Stub: real multi-window support needs a main-process IPC to
          // spawn a second BrowserWindow. Not in 2a scope.
          console.info("[menu] new-window requested (not yet supported)");
          return;
        }
        case "toggle-browser-column": {
          window.dispatchEvent(
            new CustomEvent(MENU_TOGGLE_BROWSER_COLUMN_EVENT),
          );
          return;
        }
        case "toggle-context-panel": {
          window.dispatchEvent(
            new CustomEvent(MENU_TOGGLE_CONTEXT_PANEL_EVENT),
          );
          return;
        }
        case "toggle-nav-rail": {
          window.dispatchEvent(
            new CustomEvent(MENU_TOGGLE_NAV_RAIL_EVENT),
          );
          return;
        }
        case "open-change-pin": {
          void navigate("/settings#security");
          window.dispatchEvent(new CustomEvent("nautilo:open-change-pin"));
          return;
        }
        case "open-restore-pin": {
          void navigate("/settings#security");
          window.dispatchEvent(new CustomEvent("nautilo:open-restore-pin"));
          return;
        }
        case "open-account-devices": {
          // M056 — Account → Manage devices… deep-links into the
          // Settings page's Devices section. The hash drives the
          // SettingsPage's mount-time scroll.
          void navigate("/settings#devices");
          return;
        }
      }
    };

    const unsubscribe = api.menu.onAction(handler);
    return unsubscribe;
  }, [navigate]);
}
