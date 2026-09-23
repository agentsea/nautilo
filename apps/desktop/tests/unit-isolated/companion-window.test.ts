import { afterAll, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "companion-window-test-"));
const handlers = new Map<string, (...args: any[]) => any>();
const application = Object.assign(new EventEmitter(), { whenReady: async () => {}, getPath: () => root });
const display = { workArea: { x: 0, y: 0, width: 1280, height: 800 } };
const screenMock = Object.assign(new EventEmitter(), { getDisplayNearestPoint: () => display, getDisplayMatching: () => display, getCursorScreenPoint: () => ({ x: 600, y: 400 }) });
const partitions: { id: string; request: (details: any, callback: (result: { cancel: boolean }) => void) => void; permissions: () => boolean }[] = [];
let notificationId = 0;
const notifications = new Map<number, { event: string; callback: () => void }>();
const subscribe = (event: string, callback: () => void) => { const id = ++notificationId; notifications.set(id, { event, callback }); return id; };
const notify = (event: string) => { for (const entry of notifications.values()) if (entry.event === event) entry.callback(); };
class Contents extends EventEmitter {
  mainFrame = { url: "http://localhost:9999/" };
  sent: unknown[][] = [];
  destroyed = false;
  isDestroyed() { return this.destroyed; }
  send(...args: unknown[]) { this.sent.push(args); }
  setWindowOpenHandler(_handler: unknown) {}
}
class Window extends EventEmitter {
  webContents = new Contents();
  visible = false;
  focused = false;
  destroyed = false;
  bounds = display.workArea;
  children: Window[] = [];
  static all: Window[] = [];
  constructor(readonly options: any = {}) { super(); this.bounds = { ...display.workArea, ...options }; Window.all.push(this); }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  async loadURL(url: string) { this.webContents.mainFrame.url = url; queueMicrotask(() => this.emit("ready-to-show")); }
  isVisible() { return this.visible; }
  isFocused() { return this.focused; }
  isDestroyed() { return this.destroyed; }
  getChildWindows() { return this.children; }
  getBounds() { return this.bounds; }
  setBounds(bounds: typeof this.bounds) { this.bounds = bounds; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  show() { this.visible = true; }
  focus() { this.focused = true; }
  destroy() { this.destroyed = true; this.webContents.destroyed = true; this.emit("closed"); }
}
mock.module("electron", () => ({
  app: application, BaseWindow: Window, BrowserWindow: Window, screen: screenMock,
  systemPreferences: {
    subscribeWorkspaceNotification: subscribe, subscribeLocalNotification: subscribe,
    unsubscribeWorkspaceNotification: (id: number) => notifications.delete(id),
    unsubscribeLocalNotification: (id: number) => notifications.delete(id),
  },
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) },
  Menu: { buildFromTemplate: () => ({ popup() {} }) },
  session: { fromPartition: (id: string) => {
    const part = { id, request: (_details: any, _cb: any) => {}, permissions: () => true };
    partitions.push(part);
    return { setPermissionRequestHandler() {}, setPermissionCheckHandler: (fn: () => boolean) => { part.permissions = fn; },
      webRequest: { onBeforeRequest: (fn: typeof part.request) => { part.request = fn; } }, on() {}, clearStorageData: async () => {} };
  } },
}));
const { CompanionWindowManager } = await import("../../electron/companion-window");
const main = new Window(); main.visible = true; main.focused = true;
const contents = new Contents();
let active: { contents: Contents; scope: string; serverUrl: string } | null = { contents, scope: "server", serverUrl: "http://localhost:9999" };
let pick = async (_parent: unknown): Promise<{ name: string; sizeBytes: number; base64: string }[]> => [];
let presence = async (_window: unknown): Promise<boolean> => false;
const manager = new CompanionWindowManager({ mainWindow: () => main as any, activeOwner: () => active as any, preload: "preload-companion.js", pickFiles: parent => pick(parent), isMainSpaceVisible: window => presence(window) });
const binding = { roomId: "room", agentId: "agent", botActorId: "bot", name: "Genie" };
const ownerEvent = { sender: contents, senderFrame: contents.mainFrame };
const call = (name: string, event: unknown, ...args: unknown[]) => handlers.get(`companion:${name}`)!(event, ...args);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
afterAll(() => { manager.close(); rmSync(root, { recursive: true, force: true }); mock.restore(); });

test("native IPC admits only the active owner's main frame", () => {
  expect(() => call("enable", { ...ownerEvent, senderFrame: {} }, binding)).toThrow();
  expect(() => call("enable", { ...ownerEvent, sender: new Contents() }, binding)).toThrow();
});
test("activation starts compact even after the user last expanded chat", () => {
  writeFileSync(path.join(root, "companion-layout.json"), JSON.stringify({ view: "chat", dock: "left", bounds: { x: 8, y: 100, width: 440, height: 540 } }));
  call("enable", ownerEvent, binding);
  const child = Window.all.at(-1)!;
  const state = call("state", { sender: child.webContents, senderFrame: child.webContents.mainFrame });
  expect(state.view).toBe("orb");
  expect(state.bubbleAppearance).toBe("avatar");
  expect(state.dock).toBe("left");
  expect(child.bounds.width).toBe(88);
});
test("native child has no auth session or API/media transport; focus keeps its generation", async () => {
  const generation = call("enable", ownerEvent, binding);
  const child = Window.all.at(-1)!;
  const childEvent = { sender: child.webContents, senderFrame: child.webContents.mainFrame };
  call("state", childEvent);
  await tick(); await tick();
  expect(child.visible).toBe(false);
  main.focused = false; manager.reconcile(); await tick();
  expect(child.visible).toBe(true); expect(child.focused).toBe(false);
  child.focused = true; manager.reconcile(); await tick();
  expect(child.visible).toBe(true);
  expect(call("state", childEvent).generation).toBe(generation);
  expect(() => call("command", childEvent, "old", { type: "send", text: "stale" })).toThrow();
  expect(() => call("command", { ...childEvent, senderFrame: {} }, generation, { type: "off" })).toThrow();
  const partition = partitions.at(-1)!;
  expect(partition.id.startsWith("persist:")).toBe(false);
  expect(partition.permissions()).toBe(false);
  const allowed = (url: string, resourceType: string, method = "GET") => {
    let cancel = true; partition.request({ url, resourceType, method }, result => { cancel = result.cancel; }); return !cancel;
  };
  expect(allowed("http://localhost:9999/assets/index.js", "script")).toBe(true);
  expect(allowed("http://localhost:9999/api/profile", "xhr")).toBe(false);
  expect(allowed("http://localhost:9999/api/profile", "script")).toBe(false);
  expect(allowed("https://elsewhere.test/image.png", "image")).toBe(false);
  expect(allowed("http://localhost:9999/companion", "mainFrame")).toBe(true);
  const portrait = "data:image/png;base64,YXZhdGFy";
  call("publish", ownerEvent, generation, { ...call("state", childEvent).snapshot, avatarDataUrl: portrait });
  expect(allowed(portrait, "image")).toBe(true);
  expect(allowed(portrait, "script")).toBe(false);
  expect(allowed("data:image/png;base64,b3RoZXI=", "image")).toBe(false);
  call("command", childEvent, generation, { type: "bubble-appearance", value: "orb" });
  expect(call("state", childEvent).bubbleAppearance).toBe("orb");
  main.focused = true; manager.reconcile(); await tick();
  expect(child.visible).toBe(false); expect(child.destroyed).toBe(false);
  expect(call("state", childEvent).generation).toBe(generation);
});
test("owned dialogs suppress the floater, while stale Off cannot close a replacement", async () => {
  const old = call("enable", ownerEvent, binding);
  const current = call("enable", ownerEvent, binding);
  call("disable", ownerEvent, old);
  const child = Window.all.at(-1)!;
  call("state", { sender: child.webContents, senderFrame: child.webContents.mainFrame });
  const modal = new Window(); modal.focused = true; main.children = [modal]; main.focused = false;
  await tick(); await tick(); manager.reconcile(); await tick();
  expect(child.visible).toBe(false); expect(child.destroyed).toBe(false);
  main.children = []; manager.reconcile(); await tick(); expect(child.visible).toBe(true);
  call("disable", ownerEvent, current); expect(child.destroyed).toBe(true);
});
test("returning to Workbench hides an ordered panel even when native visibility reports false", async () => {
  main.focused = false;
  const generation = call("enable", ownerEvent, binding);
  const child = Window.all.at(-1)!;
  const childEvent = { sender: child.webContents, senderFrame: child.webContents.mainFrame };
  call("state", childEvent);
  await tick();
  expect(child.visible).toBe(true);
  // Reproduce the native getter independently of actual window ordering.
  const mainVisibility = main.isVisible;
  main.isVisible = () => false;
  child.isVisible = () => false;
  try {
    main.focused = true;
    application.emit("browser-window-focus");
    await tick();
    expect(child.visible).toBe(false);
    expect(child.destroyed).toBe(false);
    expect(call("state", childEvent).generation).toBe(generation);
    main.focused = false;
    application.emit("browser-window-blur");
    await tick();
    expect(child.visible).toBe(true);
    child.focused = true;
    application.emit("browser-window-focus");
    await tick();
    expect(child.visible).toBe(true);
    main.focused = true;
    application.emit("browser-window-focus");
    await tick();
    expect(child.visible).toBe(false);
  } finally {
    main.isVisible = mainVisibility;
    manager.close();
  }
});
test("server switch and owner navigation destroy the surface and revoke child commands", async () => {
  call("enable", ownerEvent, binding); const child = Window.all.at(-1)!;
  active = null; manager.reconcile(); await tick(); expect(child.destroyed).toBe(true);
  expect(() => call("state", { sender: child.webContents, senderFrame: child.webContents.mainFrame })).toThrow();
  active = { contents, scope: "server", serverUrl: "http://localhost:9999" };
  call("enable", ownerEvent, binding); const replacement = Window.all.at(-1)!;
  contents.emit("did-start-navigation", {}, "http://localhost:9999/", false, true);
  expect(replacement.destroyed).toBe(true);
});

test.skipIf(process.platform !== "darwin")("repeated Space returns reapply hiding without app focus events and release observers on Off", async () => {
  const generation = call("enable", ownerEvent, binding);
  const child = Window.all.at(-1)!;
  const childEvent = { sender: child.webContents, senderFrame: child.webContents.mainFrame };
  main.focused = true;
  call("state", childEvent); await tick();
  expect(child.visible).toBe(false);
  expect(notifications.size).toBe(4);
  for (let cycle = 0; cycle < 3; cycle++) {
    main.focused = false;
    notify("NSWorkspaceActiveSpaceDidChangeNotification"); await tick();
    expect(child.visible).toBe(true);
    // Notification before the key-window change: the later native key event
    // must reconcile again, without depending on an Electron app event.
    notify("NSWorkspaceActiveSpaceDidChangeNotification"); await tick();
    main.focused = true;
    notify("NSWindowDidBecomeKeyNotification"); await tick();
    expect(child.visible).toBe(false);
    // OS reordering may restore an ordered panel despite our cached state.
    child.visible = true;
    notify("NSWorkspaceActiveSpaceDidChangeNotification"); await tick();
    expect(child.visible).toBe(false);
    expect(call("state", childEvent).generation).toBe(generation);
  }
  const staleCallback = [...notifications.values()][0]!.callback;
  manager.close();
  expect(notifications.size).toBe(0);
  staleCallback(); await tick();
  expect(child.destroyed).toBe(true);
});

test("picker belongs to the floater, returns bytes only to its owner, and fences Off", async () => {
  active = { contents, scope: "server", serverUrl: "http://localhost:9999" };
  const generation = call("enable", ownerEvent, binding);
  const child = Window.all.at(-1)!;
  const childEvent = { sender: child.webContents, senderFrame: child.webContents.mainFrame };
  await expect(call("pick-files", childEvent, generation)).rejects.toThrow();
  await expect(call("pick-files", ownerEvent, "stale")).rejects.toThrow();
  let resolve!: (files: { name: string; sizeBytes: number; base64: string }[]) => void;
  pick = parent => { expect(parent).toBe(child); return new Promise(r => { resolve = r; }); };
  const pending = call("pick-files", ownerEvent, generation);
  manager.close(); resolve([{ name: "example.txt", sizeBytes: 1, base64: "eA==" }]);
  expect(await pending).toEqual([]);
});

test("fullscreen presence hides the bubble with stale panel focus and fences late native samples", async () => {
  main.focused = false;
  call("enable", ownerEvent, binding);
  const child = Window.all.at(-1)!;
  const childEvent = { sender: child.webContents, senderFrame: child.webContents.mainFrame };
  call("state", childEvent); await tick(); await tick();
  expect(child.visible).toBe(true);
  for (let cycle = 0; cycle < 3; cycle++) {
    presence = async window => { expect(window).toBe(main); return true; };
    manager.reconcile(); await tick(); await tick();
    expect(child.visible).toBe(false);
    presence = async () => false;
    manager.reconcile(); await tick(); await tick();
    expect(child.visible).toBe(true);
  }
  let resolve!: (value: boolean) => void;
  presence = () => new Promise(r => { resolve = r; });
  manager.reconcile(); await tick();
  manager.close();
  resolve(false); await tick();
  expect(child.destroyed).toBe(true);
  presence = async () => false;
});
