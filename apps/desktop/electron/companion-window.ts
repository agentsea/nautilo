import { app, BaseWindow, BrowserWindow, ipcMain, Menu, screen, session, systemPreferences, type IpcMainInvokeEvent, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  emptyCompanionSnapshot, companionDocks, companionViews, isCompanionAction, isCompanionBinding,
  isCompanionSnapshot, shouldShowCompanion,
  type CompanionPickedFile, type CompanionAction, type CompanionBinding, type CompanionWindowState,
} from "./companion-contract";
import { clampRect, nearestDock, place, validRect, type Rect } from "./companion-geometry";

interface Owner { contents: WebContents; serverUrl: string; scope: string }
interface BoundWindow {
  owner: Owner;
  window: BrowserWindow;
  url: string;
  state: CompanionWindowState;
  ready: boolean;
  shown: boolean | null;
  session: Electron.Session;
  releaseOwner: () => void;
  releaseVisibility: () => void;
  drag: { cursor: Electron.Point; bounds: Rect } | null;
}

/** One disposable surface over an authenticated Workbench. The child has no
 * auth partition, API transport, media permission or general Desktop bridge. */
export class CompanionWindowManager {
  private bound: BoundWindow | null = null;
  private visibilityQueued = false;
  private visibilityRevision = 0;

  constructor(private readonly deps: {
    mainWindow: () => BaseWindow | null;
    isMainSpaceVisible?: (window: BaseWindow) => Promise<boolean>;
    activeOwner: () => Owner | null;
    preload: string;
    pickFiles?: (parent: BrowserWindow) => Promise<CompanionPickedFile[]>;
  }) {
    ipcMain.handle("companion:enable", (event, binding: unknown) => {
      const owner = this.requireOwner(event);
      if (!isCompanionBinding(binding)) throw new Error("Invalid companion binding");
      return this.enable(owner, binding);
    });
    ipcMain.handle("companion:pick-files", async (event, generation: unknown) => {
      const owner = this.requireOwner(event);
      const bound = this.bound;
      if (!bound || bound.owner.contents !== owner.contents || bound.state.generation !== generation || !this.deps.pickFiles) throw new Error("Companion unavailable");
      const files = await this.deps.pickFiles(bound.window);
      if (this.bound !== bound || !this.ownerCurrent(bound)) return [];
      return files;
    });
    ipcMain.handle("companion:disable", (event, generation: unknown) => {
      this.requireOwner(event);
      // Cleanup from an earlier generation must not close a replacement.
      if (this.bound?.state.generation === generation) this.close();
    });
    ipcMain.handle("companion:publish", (event, generation: unknown, snapshot: unknown) => {
      const owner = this.requireOwner(event);
      const bound = this.bound;
      if (!bound || bound.owner.contents !== owner.contents || bound.state.generation !== generation) return;
      if (!isCompanionSnapshot(snapshot) || Object.keys(bound.state.snapshot.binding).some(
        key => snapshot.binding[key as keyof CompanionBinding] !== bound.state.snapshot.binding[key as keyof CompanionBinding],
      )) throw new Error("Invalid companion snapshot");
      bound.state.snapshot = snapshot;
      this.publish(bound);
    });
    ipcMain.handle("companion:state", event => {
      const bound = this.requireChild(event);
      // The shared React surface has mounted and installed its subscription.
      // Hidden/off-Space windows must not wait indefinitely for a paint event.
      bound.ready = true;
      this.reconcile();
      return bound.state;
    });
    ipcMain.handle("companion:command", (event, generation: unknown, action: unknown) => {
      const bound = this.requireChild(event);
      if (generation !== bound.state.generation || !isCompanionAction(action)) throw new Error("Stale or invalid companion command");
      this.command(bound, action);
    });
    app.on("browser-window-focus", () => this.reconcile());
    app.on("browser-window-blur", () => this.reconcile());
    app.on("did-resign-active", () => this.reconcile());
    app.on("did-become-active", () => this.reconcile());
    app.on("before-quit", () => this.close());
    app.whenReady().then(() => {
      screen.on("display-removed", () => this.relayout());
      screen.on("display-metrics-changed", () => this.relayout());
    }).catch(() => {});
  }

  private requireOwner(event: IpcMainInvokeEvent): Owner {
    const owner = this.deps.activeOwner();
    if (!owner || event.sender !== owner.contents || event.senderFrame !== owner.contents.mainFrame) {
      throw new Error("Companion owner unavailable");
    }
    return owner;
  }

  private requireChild(event: IpcMainInvokeEvent): BoundWindow {
    const bound = this.bound;
    if (!bound || event.sender !== bound.window.webContents || event.senderFrame !== event.sender.mainFrame
      || event.senderFrame.url !== bound.url || !this.ownerCurrent(bound)) {
      throw new Error("Companion surface unavailable");
    }
    return bound;
  }

  private ownerCurrent(bound: BoundWindow): boolean {
    const active = this.deps.activeOwner();
    return active?.contents === bound.owner.contents && active.scope === bound.owner.scope;
  }

  private enable(owner: Owner, binding: CompanionBinding): string {
    this.close();
    const generation = randomUUID();
    const url = new URL("/companion", owner.serverUrl).href;
    const origin = new URL(url).origin;
    const isolated = session.fromPartition(`companion-${generation}`, { cache: false });
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    // Only load the Workbench document and same-origin visual/code assets.
    // In particular no fetch, WebSocket, subframe, microphone or API access.
    isolated.webRequest.onBeforeRequest((details, callback) => {
      if (details.method === "GET" && details.resourceType === "image" && details.url === this.bound?.state.snapshot.avatarDataUrl) {
        callback({ cancel: false }); return;
      }
      const asset = ["script", "stylesheet", "image", "font"].includes(details.resourceType);
      const target = new URL(details.url);
      callback({ cancel: !(details.method === "GET" && target.origin === origin
        && !target.pathname.startsWith("/api/")
        && ((details.resourceType === "mainFrame" && details.url === url) || asset)) });
    });
    isolated.on("will-download", event => event.preventDefault());
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const view: CompanionWindowState["view"] = "orb";
    let bubbleAppearance: CompanionWindowState["bubbleAppearance"] = "avatar";
    let dock: CompanionWindowState["dock"] = "right";
    let previous: Rect = { x: display.workArea.x + display.workArea.width - 96,
      y: display.workArea.y + (display.workArea.height - 88) / 2, width: 88, height: 88 };
    try {
      const saved: unknown = JSON.parse(readFileSync(this.layoutPath(), "utf8"));
      if (saved && typeof saved === "object") {
        const layout = saved as Record<string, unknown>;
        if (isCompanionAction({ type: "dock", value: layout["dock"] })) dock = layout["dock"] as CompanionWindowState["dock"];
        if (layout["bubbleAppearance"] === "orb") bubbleAppearance = "orb";
        if (validRect(layout["bounds"])) previous = layout["bounds"];
      }
    } catch { /* A missing/stale layout uses the accessible default. */ }
    const bounds = place(view, dock, previous, screen.getDisplayMatching(previous).workArea);
    const window = new BrowserWindow({
      ...bounds, show: false, frame: false, transparent: true,
      // Electron's non-activating panel participates in fullscreen Spaces
      // without changing the main application's process/activation policy.
      ...(process.platform === "darwin" ? { type: "panel" } : {}),
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, title: `${binding.name} — Floating Genie`,
      backgroundColor: "#00000000",
      webPreferences: { preload: this.deps.preload, session: isolated, sandbox: true,
        contextIsolation: true, nodeIntegration: false, webviewTag: false, backgroundThrottling: false },
    });
    window.setAlwaysOnTop(true, "floating");
    if (process.platform !== "darwin") window.setVisibleOnAllWorkspaces(true);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.on("page-title-updated", event => event.preventDefault());
    window.webContents.on("will-navigate", event => event.preventDefault());
    window.webContents.on("will-redirect", event => event.preventDefault());
    const close = () => { if (this.bound?.state.generation === generation) this.close(); };
    const navigate = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) close();
    };
    owner.contents.on("did-start-navigation", navigate);
    owner.contents.once("destroyed", close);
    owner.contents.once("render-process-gone", close);
    const bound: BoundWindow = {
      owner, window, url, ready: false, shown: false, drag: null, session: isolated,
      state: { generation, view, dock, bubbleAppearance, snapshot: emptyCompanionSnapshot(binding) },
      releaseVisibility: () => {},
      releaseOwner: () => {
        owner.contents.removeListener("did-start-navigation", navigate);
        owner.contents.removeListener("destroyed", close);
        owner.contents.removeListener("render-process-gone", close);
      },
    };
    this.bound = bound;
    if (process.platform === "darwin") {
      // A Space swipe need not transfer key-window focus. Reapply ordering
      // after every Space change, including when macOS restores a panel.
      const workspace = systemPreferences.subscribeWorkspaceNotification("NSWorkspaceActiveSpaceDidChangeNotification", () => {
        if (this.bound !== bound) return;
        bound.shown = null;
        this.reconcile();
      });
      // Space animation and key-window delivery can settle in either order.
      const local = ["NSWindowDidBecomeKeyNotification", "NSWindowDidResignKeyNotification", "NSWindowDidChangeOcclusionStateNotification"].map(event =>
        systemPreferences.subscribeLocalNotification(event, () => {
          if (this.bound === bound) this.reconcile();
        }));
      bound.releaseVisibility = () => {
        systemPreferences.unsubscribeWorkspaceNotification(workspace);
        for (const id of local) systemPreferences.unsubscribeLocalNotification(id);
      };
    }
    window.on("closed", close);
    window.webContents.on("render-process-gone", close);
    void window.loadURL(url).catch(close);
    return generation;
  }

  /** Coalesce focus transfers so the main window's owned dialogs never cause
   * an intermediate appearance. Companion focus itself does not hide it. */
  reconcile(): void {
    this.visibilityRevision++;
    if (this.visibilityQueued) return;
    this.visibilityQueued = true;
    setImmediate(() => { void this.reconcileVisibility(); });
  }

  private async reconcileVisibility(): Promise<void> {
    const revision = this.visibilityRevision;
    const bound = this.bound;
    try {
      if (!bound) return;
      if (!this.ownerCurrent(bound)) { this.close(); return; }
      if (!bound.ready || bound.window.isDestroyed()) return;
      const main = this.deps.mainWindow();
      const mainUsable = !!main && !main.isDestroyed();
      const mainSpaceVisible = mainUsable && !main.isFocused() && this.deps.isMainSpaceVisible
        ? await this.deps.isMainSpaceVisible(main) : false;
      // A swipe, Off, rebind or focus change may arrive during native sampling.
      if (revision !== this.visibilityRevision || this.bound !== bound || !this.ownerCurrent(bound) || bound.window.isDestroyed()) return;
      const dialogFocused = (window: BaseWindow): boolean => window.getChildWindows().some(child =>
        !child.isDestroyed() && (child.isFocused() || dialogFocused(child)));
      const show = shouldShowCompanion({ enabled: true, ownerCurrent: true,
        mainFocused: !!main && !main.isDestroyed() && (main.isFocused() || mainSpaceVisible),
        mainDialogFocused: !!main && !main.isDestroyed() && dialogFocused(main) });
      // macOS occlusion/Space transitions can report isVisible() as false
      // for an ordered window. Focus decides whether to hide; our own show
      // state ensures that hide is delivered even during that transition.
      if (show !== bound.shown) {
        bound.shown = show;
        if (show) bound.window.showInactive();
        else bound.window.hide();
      }
    } catch {
      if (this.bound === bound) this.close();
    } finally {
      this.visibilityQueued = false;
      if (revision !== this.visibilityRevision) this.reconcile();
    }
  }

  close(): void {
    const bound = this.bound;
    if (!bound) return;
    this.bound = null;
    bound.releaseVisibility();
    bound.releaseOwner();
    if (!bound.window.isDestroyed()) { this.saveLayout(bound); bound.window.destroy(); }
    if (!bound.owner.contents.isDestroyed()) bound.owner.contents.send("companion:closed", bound.state.generation);
    // The partition is ephemeral; purge cached document data on explicit Off.
    void bound.session.clearStorageData().catch(() => {});
  }

  private publish(bound: BoundWindow): void {
    if (!bound.window.isDestroyed()) bound.window.webContents.send("companion:changed", bound.state);
  }

  private relayout(): void {
    const bound = this.bound;
    if (!bound || bound.window.isDestroyed()) return;
    const previous = bound.window.getBounds();
    bound.window.setBounds(place(bound.state.view, bound.state.dock, previous, screen.getDisplayMatching(previous).workArea));
    this.saveLayout(bound);
    this.publish(bound);
  }

  private command(bound: BoundWindow, action: CompanionAction): void {
    if (action.type === "off") { this.close(); return; }
    if (action.type === "view" || action.type === "dock") {
      if (action.type === "view") bound.state.view = action.value;
      else bound.state.dock = action.value;
      this.relayout();
    } else if (action.type === "bubble-appearance") {
      bound.state.bubbleAppearance = action.value;
      this.saveLayout(bound);
      this.publish(bound);
    } else if (action.type === "menu") {
      Menu.buildFromTemplate([
        ...companionViews.map(view => ({ label: ({ orb: "Bubble", waveform: "Waveform", prompt: "Prompt", chat: "Chat" })[view], type: "radio" as const, checked: bound.state.view === view, click: () => { if (this.bound === bound) this.command(bound, { type: "view", value: view }); } })),
        { type: "separator" },
        { label: "Bubble appearance", submenu: (["avatar", "orb"] as const).map(value => ({ label: value === "avatar" ? "Genie avatar" : "Abstract orb", type: "radio" as const, checked: bound.state.bubbleAppearance === value, click: () => { if (this.bound === bound) this.command(bound, { type: "bubble-appearance", value }); } })) },
        { label: "Dock", submenu: companionDocks.map(dock => ({ label: dock === "free" ? "Free floating" : dock[0]!.toUpperCase() + dock.slice(1), type: "radio" as const, checked: bound.state.dock === dock, click: () => { if (this.bound === bound) this.command(bound, { type: "dock", value: dock }); } })) },
        { label: bound.state.snapshot.capture === "listening" ? "Finish recording and send" : "Record a message", enabled: !["requesting", "transcribing"].includes(bound.state.snapshot.capture), click: () => { if (this.bound === bound) this.command(bound, { type: "mic" }); } },
        { label: "Mute microphone / discard recording", click: () => { if (this.bound === bound) this.command(bound, { type: "mute" }); } },
        { label: "Stop talking", enabled: bound.state.snapshot.voiceEnabled, click: () => { if (this.bound === bound) this.command(bound, { type: "stop-talking" }); } },
        { label: "Stop task in this Room", click: () => { if (this.bound === bound) this.command(bound, { type: "stop-task" }); } },
        { label: "Attach files…", enabled: bound.state.snapshot.canAttach, click: () => { if (this.bound === bound) this.command(bound, { type: "view", value: "chat" }); if (this.bound === bound) this.command(bound, { type: "attach" }); } },
        { type: "separator" },
        { label: "Open Room in Nautilo", click: () => { if (this.bound === bound) this.command(bound, { type: "return" }); } },
        { label: "Turn off floating Genie", click: () => { if (this.bound === bound) this.close(); } },
      ]).popup({ window: bound.window });
    } else if (action.type === "drag-start") {
      bound.drag = { cursor: screen.getCursorScreenPoint(), bounds: bound.window.getBounds() };
    } else if (action.type === "drag-move" && bound.drag) {
      const cursor = screen.getCursorScreenPoint();
      const start = bound.drag;
      if (Math.hypot(cursor.x - start.cursor.x, cursor.y - start.cursor.y) < 5) return;
      const next = { ...start.bounds, x: start.bounds.x + cursor.x - start.cursor.x, y: start.bounds.y + cursor.y - start.cursor.y };
      bound.window.setBounds(clampRect(next, screen.getDisplayNearestPoint(cursor).workArea));
    } else if (action.type === "drag-end" && bound.drag) {
      const current = bound.window.getBounds();
      bound.drag = null;
      bound.state.dock = nearestDock(current, screen.getDisplayMatching(current).workArea);
      this.relayout();
    } else if (action.type === "drag-cancel") bound.drag = null;
    else if (action.type === "send" || action.type === "draft" || action.type === "refresh" || action.type === "return" || action.type === "mic" || action.type === "mute" || action.type === "stop-talking" || action.type === "stop-task" || action.type === "attach" || action.type === "remove-attachment") {
      if (!this.ownerCurrent(bound)) { this.close(); return; }
      bound.owner.contents.send("companion:action", bound.state.generation, action);
      if (action.type === "return") { this.deps.mainWindow()?.show(); this.deps.mainWindow()?.focus(); }
    }
  }

  private layoutPath(): string { return path.join(app.getPath("userData"), "companion-layout.json"); }
  private saveLayout(bound: BoundWindow): void {
    try { writeFileSync(this.layoutPath(), JSON.stringify({ view: bound.state.view, dock: bound.state.dock, bubbleAppearance: bound.state.bubbleAppearance, bounds: bound.window.getBounds() }), { mode: 0o600 }); }
    catch { /* Layout preferences must not prevent Off or access revocation. */ }
  }
}
