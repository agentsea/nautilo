/**
 * Application menu (D057 2a.4) — native macOS menu + minimal fallback
 * for Windows / Linux (the full cross-platform menu lands in Phase 2d).
 *
 * The menu template lives here; click handlers fan out through the
 * renderer via the "menu:action" IPC channel so the workbench can handle
 * navigation and app state itself. The main process only owns actions
 * that must live main-side (show About dialog, toggle DevTools, quit).
 *
 * Layout mirrors research/workbench-ui-vocabulary.md §12.5.
 */

import {
  app,
  type BaseWindow,
  dialog,
  Menu,
  type MenuItemConstructorOptions,
  shell,
  type WebContents,
} from "electron";
import {
  buildAccountSubmenuForProjection,
  type MenuAuthProjection,
} from "./menu-auth-projection";
import { buildServerSubmenu } from "./menu-server-template";

/**
 * Actions the menu can dispatch to the renderer. Kept as a union string
 * so both sides share a schema without a runtime type import. Stay in
 * lock-step with apps/workbench/src/lib/desktop.ts MenuAction.
 */
export type MenuAction =
  | "new-chat"
  | "new-window"
  | "open-settings"
  | "speak"
  | "report-issue"
  | "toggle-browser-column"
  | "toggle-context-panel"
  // D076 Chunk 4 — navigation rail toggle (⌘⇧0).
  | "toggle-nav-rail"
  // M055 — Account → Manage devices… dispatches into the renderer
  // until M056 wires the route. Until then the renderer logs a warn.
  | "open-account-devices"
  // M106 — Account → Change / Restore PIN shortcuts (renderer → Settings).
  | "open-change-pin"
  | "open-restore-pin";

/**
 * Main-process callbacks + state injected when building the menu.
 * Keeps the menu module independent of main.ts globals; main rebuilds
 * the menu on every current-folder commit so Recent Folders stays live.
 */
/**
 * M055/D514 — Account submenu state.  Discovery failure is an explicit
 * projection, not an exception during native menu construction.
 */
export type MenuAuthOptions = MenuAuthProjection;

export interface MenuOptions {
  /** Most-recent-first list of current-folder paths. */
  recentCurrentFolders: string[];
  /** Commit an already-validated path (from Recent Folders). */
  onCommitCurrentFolder: (p: string) => void;
  /** Open native picker + validate + commit. */
  onOpenFolder: () => void | Promise<void>;
  /** Open the main-owned server picker from any renderer/auth state. */
  onSwitchServer: () => void | Promise<void>;
  /** Main-owned updater entry point; never dispatches updater authority to the renderer. */
  onOpenUpdateFlow: () => void | Promise<void>;
  /** M055 — Account submenu (Sign In / Sign Out / hosted account pages / Manage devices). */
  auth: MenuAuthOptions;
}

// Expected build-time injection (see scripts/build-electron.ts). Fallback
// is "unknown" so a direct `bun run` during development still works.
declare const __NAUTILO_SHA__: string;
const NAUTILO_SHA =
  typeof __NAUTILO_SHA__ === "string" && __NAUTILO_SHA__.length > 0
    ? __NAUTILO_SHA__
    : "unknown";

/**
 * Send a menu action to the renderer. Guards against the window being
 * destroyed (right after close, before menu GC) so menu clicks never
 * throw.
 */
function sendAction(renderer: WebContents | null, action: MenuAction): void {
  if (!renderer || renderer.isDestroyed()) return;
  renderer.send("menu:action", action);
}

/**
 * Truncate a string keeping the tail intact. Preserves the most-
 * identifying part of a path (basename + immediate parent) when the
 * full path won't fit in a menu item label. Leaves an ellipsis where
 * the middle was removed.
 */
function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = Math.floor((max - 1) / 2);
  return `${s.slice(0, keep)}…${s.slice(s.length - keep)}`;
}

/**
 * Open the native About dialog. Main-side because Electron's
 * showMessageBox looks correct on each platform (Apple-style "About"
 * panel on macOS, standard modal on Win/Linux) and we don't need the
 * workbench for this. Only called from menu item click handlers
 * within this module.
 */
function showAboutDialog(host: BaseWindow | null): void {
  const electronVersion = process.versions["electron"] ?? "unknown";
  const chromeVersion = process.versions["chrome"] ?? "unknown";
  const nodeVersion = process.versions["node"] ?? "unknown";

  const detail = [
    `Version: ${app.getVersion()} (${NAUTILO_SHA})`,
    `Electron ${electronVersion} · Chromium ${chromeVersion} · Node ${nodeVersion}`,
    "",
    "© 2026 Kentauros. MIT License.",
  ].join("\n");

  // Electron.dialog.showMessageBox has two overloads: (options) → app-modal,
  // or (window, options) → window-modal. We use the window-modal form when
  // a window is alive so the sheet anchors correctly on macOS, otherwise
  // fall through to app-modal — don't cheat a nullable into the signature.
  const options: Electron.MessageBoxOptions = {
    type: "info",
    title: "About Nautilo",
    message: "Nautilo Desktop",
    detail,
    buttons: ["OK"],
    defaultId: 0,
    noLink: true,
  };
  if (host && !host.isDestroyed()) {
    void dialog.showMessageBox(host, options);
  } else {
    void dialog.showMessageBox(options);
  }
}

/**
 * Build the Electron menu for the current platform. macOS gets the full
 * six-submenu layout; Windows/Linux get a minimal `File / Edit / Help`
 * so we're never stuck with Electron's default menu (which has only
 * Edit and nothing app-identifying).
 */
export function createApplicationMenu(
  host: BaseWindow | null,
  renderer: WebContents | null,
  options: MenuOptions,
): Menu {
  const isMac = process.platform === "darwin";
  const isDev = !app.isPackaged;

  const template: MenuItemConstructorOptions[] = [];

  // macOS application menu — goes first, labeled with app name.
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        {
          label: `About ${app.name}`,
          click: () => showAboutDialog(host),
        },
        {
          label: "Check for Updates…",
          click: () => {
            void options.onOpenUpdateFlow();
          },
        },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "Cmd+,",
          click: () => sendAction(renderer, "open-settings"),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  // File
  //
  // D075 chunk 2 → D079 Phase 1 rename — Recent Folders submenu sits
  // alongside Open Folder. Dynamic: main.ts rebuilds the menu via
  // rebuildApplicationMenu() every time the list changes, so the
  // submenu stays live across commits.
  //
  // NOTE: the "Use Default Workspace" item is gone. D079 split the
  // old "workspace" concept into two surfaces (Genie's Workspace + the
  // user's current folder); the current folder has no default (a
  // task-scoped surface doesn't need one). Phase 3 adds a Workspace-
  // scoped analog when the Workspace surface lands.
  const recentSubmenu: MenuItemConstructorOptions[] =
    options.recentCurrentFolders.length === 0
      ? [
          {
            label: "No recent folders",
            enabled: false,
          },
        ]
      : options.recentCurrentFolders.map((p) => ({
          label: truncateMiddle(p, 50),
          toolTip: p,
          click: () => options.onCommitCurrentFolder(p),
        }));

  template.push({
    label: "File",
    submenu: [
      {
        label: "New Chat",
        accelerator: "CmdOrCtrl+N",
        click: () => sendAction(renderer, "new-chat"),
      },
      {
        label: "New Window",
        accelerator: "CmdOrCtrl+Shift+N",
        click: () => sendAction(renderer, "new-window"),
      },
      { type: "separator" },
      {
        label: "Open Folder…",
        click: () => {
          void options.onOpenFolder();
        },
      },
      {
        label: "Recent Folders",
        submenu: recentSubmenu,
      },
      { type: "separator" },
      // On macOS the Nautilo > Quit above handles quit; this Close is
      // window-scoped (Cmd+W) and standard. On Windows/Linux we rely
      // on File > Quit below.
      isMac ? { role: "close" } : { role: "quit" },
    ],
  });

  // Server switching must remain owned by the desktop shell. The main
  // window can be displaying Logto, a disconnected page, or a Workbench
  // maintenance gate, none of which is a reliable renderer for this escape.
  template.push({
    label: "Server",
    submenu: buildServerSubmenu(options.onSwitchServer),
  });

  // Edit — standard editing actions + our voice input
  template.push({
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
      { type: "separator" },
      {
        label: "Speak (voice input)",
        accelerator: "CmdOrCtrl+Shift+V",
        click: () => sendAction(renderer, "speak"),
      },
    ],
  });

  // View — panels + reload + DevTools (dev only) + zoom
  template.push({
    label: "View",
    submenu: [
      // D077 — panel toggles. The workbench owns the actual state; menu
      // just dispatches so the shortcut works whether the native menu,
      // a header button, or a future rail button triggered it.
      {
        label: "Toggle File Browser",
        accelerator: "CmdOrCtrl+Shift+B",
        click: () => sendAction(renderer, "toggle-browser-column"),
      },
      {
        label: "Toggle Context Panel",
        accelerator: "CmdOrCtrl+Shift+I",
        click: () => sendAction(renderer, "toggle-context-panel"),
      },
      // D076 Chunk 4 — navigation rail toggle.
      {
        label: "Toggle Navigation Rail",
        accelerator: "CmdOrCtrl+Shift+0",
        click: () => sendAction(renderer, "toggle-nav-rail"),
      },
      { type: "separator" },
      { role: "reload" },
      { role: "forceReload" },
      ...(isDev ? [{ role: "toggleDevTools" as const }, { type: "separator" as const }] : [{ type: "separator" as const }]),
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  });

  // Window
  template.push({
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      ...(isMac ? [{ type: "separator" as const }, { role: "front" as const }] : []),
    ],
  });

  // M055 — Account submenu (template builder is in menu-account-template.ts
  // so a unit test can verify shape without pulling Electron's runtime.)
  template.push({
    label: "Account",
    submenu: buildAccountSubmenuForProjection(options.auth),
  });

  // Help
  template.push({
    label: "Help",
    submenu: [
      {
        label: "Documentation",
        click: () => {
          void shell.openExternal("https://github.com/agentsea/nautilo-public");
        },
      },
      {
        label: "Report Issue",
        click: () => sendAction(renderer, "report-issue"),
      },
      ...(isMac
        ? []
        : ([
            { type: "separator" as const },
            {
              label: "Check for Updates…",
              click: () => {
                void options.onOpenUpdateFlow();
              },
            },
          ] as MenuItemConstructorOptions[])),
      // On Windows/Linux, About lives in Help rather than an app menu.
      ...(isMac
        ? []
        : ([
            { type: "separator" as const },
            {
              label: `About ${app.name}`,
              click: () => showAboutDialog(host),
            },
          ] as MenuItemConstructorOptions[])),
    ],
  });

  return Menu.buildFromTemplate(template);
}
