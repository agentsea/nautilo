/**
 * D362 Phase-0 spike — Electron webview harness (throwaway).
 *
 * Loads a Collabora-hosted document into a WebContentsView, validating the
 * D-4 embed decision (Electron webview surface) and D-2 (engine-rendered
 * tiles). The JSDialog WS tap (preload) logs descriptor frames to the
 * terminal for the 0.3.x JSDialog probe.
 *
 * Assumes `docker compose up` (collabora on :9980) and `wopi-stub.ts` are
 * running. See README.
 */
import { app, BaseWindow, globalShortcut, session, WebContentsView } from "electron";
import { resolve } from "node:path";

const COLLABORA = process.env["D362_COLLABORA"] ?? "http://localhost:9980";
const WOPI_PUBLIC_BASE = process.env["D362_WOPI_PUBLIC_BASE"] ?? "http://host.docker.internal:8628";
const DOC_ID = "spike-doc";
const ACCESS_TOKEN = process.env["D362_ACCESS_TOKEN"] ?? "spike-token";

function editorUrl(): string {
  const wopiSrc = `${WOPI_PUBLIC_BASE}/wopi/files/${DOC_ID}`;
  // cool.html is Collabora's client entrypoint. permission=edit to exercise PutFile.
  const params = new URLSearchParams({
    WOPISrc: wopiSrc,
    access_token: ACCESS_TOKEN,
    permission: "edit",
  });
  return `${COLLABORA}/browser/dist/cool.html?${params.toString()}`;
}

let win: BaseWindow | null = null;
let view: WebContentsView | null = null;

function layout(): void {
  if (!win || !view) return;
  const b = win.getContentBounds();
  view.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
}

async function createHarness(): Promise<void> {
  win = new BaseWindow({ width: 1400, height: 950, title: "D362 LibreOffice Spike", backgroundColor: "#10131f" });
  const officeSession = session.fromPartition("persist:d362-office", { cache: true });
  view = new WebContentsView({
    webPreferences: {
      session: officeSession,
      sandbox: false, // preload needs to run before page scripts to tap WebSocket
      contextIsolation: false,
      preload: resolve(__dirname, "preload.js"),
      backgroundThrottling: false,
    },
  });
  win.contentView.addChildView(view);
  layout();
  win.on("resize", layout);

  view.webContents.on("did-finish-load", () => console.log(`[d362-spike] loaded ${view?.webContents.getURL()}`));
  view.webContents.on("did-fail-load", (_e, code, desc, url) =>
    console.error(`[d362-spike] load failed ${code} ${desc}: ${url}`),
  );

  const url = editorUrl();
  console.log(`[d362-spike] editor URL: ${url}`);
  await view.webContents.loadURL(url);

  globalShortcut.register("CommandOrControl+Shift+R", () => view?.webContents.reload());
  globalShortcut.register("CommandOrControl+Shift+I", () => view?.webContents.openDevTools({ mode: "detach" }));
  console.log("[d362-spike] shortcuts: CmdOrCtrl+Shift+R reload, CmdOrCtrl+Shift+I devtools");
}

app.whenReady().then(() => {
  void createHarness().catch((err) => {
    console.error("[d362-spike] failed to start", err);
    app.quit();
  });
});

app.on("before-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
