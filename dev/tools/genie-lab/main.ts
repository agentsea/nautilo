import { app, BrowserWindow, ipcMain, Menu, net, nativeTheme, protocol, screen, session, systemPreferences, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { docks, initialState, isCommand, states, views, visuals, type LabCommand, type LabState, type Rect } from "./contract";
import { clampRect, nearestDock, place, validRect } from "./geometry";

const origin = "genie-lab://app";
protocol.registerSchemesAsPrivileged([{ scheme: "genie-lab", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName("Genie Lab");
// This contributor lab has no production profile, credentials, Relay, or DB.
app.setPath("userData", join(app.getPath("appData"), "Nautilo Genie Lab"));
if (!app.requestSingleInstanceLock()) app.quit();

let window: BrowserWindow | null = null;
const state: LabState = { ...initialState };
let drag: { cursor: { x: number; y: number }; bounds: Rect; moved: boolean } | null = null;
const savedPath = join(app.getPath("userData"), "placement.json");

function save() {
  if (!window || window.isDestroyed()) return;
  try { writeFileSync(savedPath, JSON.stringify({ view: state.view, dock: state.dock, visual: state.visual, bounds: window.getBounds() })); }
  catch { /* Placement persistence must never strand the window. */ }
}
function emit() {
  window?.webContents.send("genie-lab:changed", state);
}
function reflow() {
  if (!window) return;
  const bounds = window.getBounds();
  const display = screen.getDisplayMatching(bounds);
  window.setBounds(place(state.view, state.dock, bounds, display.workArea));
  save(); emit();
}
function select(command: LabCommand) {
  if (!window) return;
  switch (command.type) {
    case "view": state.view = command.value; reflow(); break;
    case "dock": state.dock = command.value; reflow(); break;
    case "state": state.state = command.value; emit(); break;
    case "visual": state.visual = command.value; save(); emit(); break;
    case "menu": popup(); break;
    case "drag-start": drag = { cursor: screen.getCursorScreenPoint(), bounds: window.getBounds(), moved: false }; break;
    case "drag-move": {
      if (!drag) return;
      const point = screen.getCursorScreenPoint();
      const dx = point.x - drag.cursor.x, dy = point.y - drag.cursor.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      const target = { ...drag.bounds, x: drag.bounds.x + dx, y: drag.bounds.y + dy };
      // Native cursor coordinates are authoritative; renderers cannot request
      // arbitrary geometry or move any window other than this one.
      window.setBounds(clampRect(target, screen.getDisplayNearestPoint(point).workArea));
      break;
    }
    case "drag-end":
      if (drag?.moved) {
        state.dock = nearestDock(window.getBounds(), screen.getDisplayMatching(window.getBounds()).workArea);
        reflow();
      }
      drag = null;
      break;
    case "drag-cancel": drag = null; break;
  }
}
function popup() {
  if (!window) return;
  Menu.buildFromTemplate([
    { label: "Genie Lab · microphone off", enabled: false },
    { type: "separator" },
    ...views.map((value, i) => ({ label: ({ orb: "Tiny orb", waveform: "Voice only", prompt: "Slim prompt", chat: "Expanded chat" })[value], type: "radio" as const, checked: state.view === value, accelerator: `CommandOrControl+${i + 1}`, click: () => select({ type: "view", value }) })),
    { type: "separator" },
    { label: "Dock", submenu: docks.map(value => ({ label: value === "free" ? "Float freely" : value[0]!.toUpperCase() + value.slice(1), type: "radio" as const, checked: state.dock === value, click: () => select({ type: "dock", value }) })) },
    { label: "Visual", submenu: visuals.map(value => ({ label: value === "nautilo" ? "Nautilo orb" : "Persona · Opal", type: "radio" as const, checked: state.visual === value, click: () => select({ type: "visual", value }) })) },
    { label: "Preview state (no microphone)", submenu: states.map(value => ({ label: value, type: "radio" as const, checked: state.state === value, click: () => select({ type: "state", value }) })) },
    { type: "separator" },
    { label: "Quit lab", accelerator: "CommandOrControl+Q", click: () => app.quit() },
  ]).popup({ window });
}
function trusted(event: IpcMainEvent | IpcMainInvokeEvent) {
  return !!window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === `${origin}/index.html`;
}

async function createWindow() {
  if (window) { window.show(); return; }
  const primary = screen.getPrimaryDisplay().workArea;
  let previous: Rect = { x: primary.x + primary.width / 2, y: primary.y + primary.height / 2, width: 0, height: 0 };
  try {
    const saved = JSON.parse(readFileSync(savedPath, "utf8")) as Record<string, unknown>;
    if (views.some(v => v === saved["view"])) state.view = saved["view"] as LabState["view"];
    if (docks.some(v => v === saved["dock"])) state.dock = saved["dock"] as LabState["dock"];
    if (visuals.some(v => v === saved["visual"])) state.visual = saved["visual"] as LabState["visual"];
    if (validRect(saved["bounds"])) previous = saved["bounds"];
  } catch { /* Fresh lab or malformed saved placement: use safe defaults. */ }
  state.reducedMotion = systemPreferences.getAnimationSettings().prefersReducedMotion;
  const labSession = session.fromPartition("genie-lab");
  labSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  labSession.setPermissionCheckHandler(() => false);
  labSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${origin}/`) }));
  const files = new Set(["index.html", "renderer.js", "renderer.css", "persona.riv", "rive.wasm"]);
  labSession.protocol.handle("genie-lab", request => {
    const url = new URL(request.url);
    const file = url.pathname.slice(1);
    if (url.host !== "app" || !files.has(file)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(join(__dirname, file)).href);
  });
  const bounds = place(state.view, state.dock, previous, screen.getDisplayMatching(previous).workArea);
  window = new BrowserWindow({
    ...bounds, title: "Genie Lab — shell preview", frame: false, transparent: true,
    backgroundColor: "#00000000", hasShadow: false, resizable: false, maximizable: false,
    fullscreenable: false, show: false, alwaysOnTop: true,
    webPreferences: { preload: join(__dirname, "preload.cjs"), session: labSession, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  window.webContents.on("context-menu", () => popup());
  window.webContents.on("before-input-event", (event, input) => {
    if ((input.meta || input.control) && input.type === "keyDown") {
      const index = Number(input.key) - 1;
      if (views[index]) { event.preventDefault(); select({ type: "view", value: views[index] }); }
      if (input.key.toLowerCase() === "q") app.quit();
    }
    if (input.key === "F10" && input.shift && input.type === "keyDown") { event.preventDefault(); popup(); }
  });
  window.on("blur", () => { drag = null; });
  window.on("closed", () => { window = null; });
  window.webContents.on("render-process-gone", () => { state.state = "error"; drag = null; window?.reload(); });
  await window.loadURL(`${origin}/index.html`);
  window.showInactive();
}

void app.whenReady().then(async () => {
  ipcMain.handle("genie-lab:state", event => { if (!trusted(event)) throw new Error("Untrusted sender"); return state; });
  ipcMain.on("genie-lab:command", (event, command: unknown) => { if (trusted(event) && isCommand(command)) select(command); });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Genie Lab", submenu: [{ label: "Show companion", click: () => window?.show() }, { label: "Companion controls", click: popup }, { type: "separator" }, { role: "quit" }] },
    { role: "editMenu" },
  ]));
  screen.on("display-added", reflow);
  screen.on("display-removed", reflow);
  screen.on("display-metrics-changed", reflow);
  nativeTheme.on("updated", () => { state.reducedMotion = systemPreferences.getAnimationSettings().prefersReducedMotion; emit(); });
  await createWindow();
});
app.on("activate", () => { void createWindow(); });
app.on("second-instance", () => window?.show());
app.on("before-quit", save);
app.on("window-all-closed", () => app.quit());
