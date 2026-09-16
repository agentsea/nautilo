import { app, BaseWindow, globalShortcut, session, WebContentsView } from "electron";
import { startCdpShim, type CdpShimHandle } from "./cdp-shim";

const PORT = Number(process.env["D336_SPIKE_PORT"] ?? "47736");
const TOKEN = process.env["D336_SPIKE_TOKEN"] ?? "d336-spike-token";
const START_URL = process.env["D336_SPIKE_URL"] ?? "https://docs.google.com";
const START_HIDDEN = process.env["D336_SPIKE_START_HIDDEN"] === "1";

let win: BaseWindow | null = null;
let view: WebContentsView | null = null;
let shim: CdpShimHandle | null = null;
let viewVisible = true;

function layoutView(): void {
  if (!win || !view) return;
  const bounds = win.getContentBounds();
  view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
}

function setViewVisible(next: boolean): void {
  if (!view || !win) return;
  viewVisible = next;
  view.setVisible(next);
  if (next) {
    layoutView();
    win.show();
    win.focus();
  }
  console.log(`[d336-spike] view visible=${next}`);
}

async function createHarness(): Promise<void> {
  win = new BaseWindow({
    width: 1280,
    height: 900,
    title: "D336 SaaS Control Spike",
    backgroundColor: "#10131f",
  });

  const googleSession = session.fromPartition("persist:d336-google", { cache: true });
  view = new WebContentsView({
    webPreferences: {
      session: googleSession,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });

  win.contentView.addChildView(view);
  layoutView();
  win.on("resize", layoutView);

  view.webContents.on("did-finish-load", () => {
    console.log(`[d336-spike] loaded ${view?.webContents.getURL()}`);
  });
  view.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error(`[d336-spike] failed load ${code} ${description}: ${url}`);
  });

  await view.webContents.loadURL(START_URL);
  if (START_HIDDEN) {
    setViewVisible(false);
  }
  shim = await startCdpShim({ webContents: view.webContents, port: PORT, token: TOKEN });
  console.log(`[d336-spike] CDP direct-page shim: ${shim.url}`);
  console.log("[d336-spike] provider config: apps/desktop/scratch/d336-spike/agent-browser.json");
  console.log("[d336-spike] shortcuts: CmdOrCtrl+Shift+H toggle view, CmdOrCtrl+Shift+F show/focus");

  globalShortcut.register("CommandOrControl+Shift+H", () => {
    setViewVisible(!viewVisible);
  });
  globalShortcut.register("CommandOrControl+Shift+F", () => {
    setViewVisible(true);
  });
}

app.whenReady().then(() => {
  void createHarness().catch((error) => {
    console.error("[d336-spike] failed to start", error);
    app.quit();
  });
});

app.on("before-quit", () => {
  globalShortcut.unregisterAll();
  shim?.close();
  shim = null;
});

app.on("window-all-closed", () => {
  app.quit();
});
