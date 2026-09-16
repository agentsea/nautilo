/** D103 — native updater wiring and window-close lifecycle regression. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { normalizeStaticSource } from "../unit/static-source";

const desktopRoot = join(import.meta.dir, "../..");
const mainSource = readFileSync(join(desktopRoot, "electron/main.ts"), "utf8");
const main = normalizeStaticSource(mainSource);
const menu = readFileSync(join(desktopRoot, "electron/menu.ts"), "utf8");
const preload = normalizeStaticSource(readFileSync(join(desktopRoot, "electron/preload.ts"), "utf8"));
const builder = readFileSync(join(desktopRoot, "electron-builder.yml"), "utf8");

function handlerBody(channel: string): string {
  const start = main.indexOf(`ipcMain.handle("${channel}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = main.indexOf(" ipcMain.handle(", start + 1);
  return main.slice(start, next === -1 ? undefined : next);
}

describe("D103 native updater wiring", () => {
  test("activates only the compiled vendor-owned stable feed from main-owned eligibility", () => {
    expect(main).toContain('import {autoUpdater} from "electron-updater"');
    expect(main).toContain('import {resolveProductionUpdaterEligibility} from "./updater-eligibility"');
    expect(main).toContain("const productionUpdaterFeedEnabled = productionUpdaterEligibility.enabled;");
    expect(main).toContain("isPackaged: app.isPackaged");
    expect(main).toContain("version: app.getVersion()");
    expect(main).toContain("if (productionUpdaterFeedEnabled && !releasedDesktopBootUpdaterStarted)");
    expect(main).toContain("releasedDesktopBootUpdaterStarted = true; updateController.startScheduling();");
    expect(main).not.toMatch(/process\.env\[[^\]]*(?:UPDATE|FEED)/i);
    expect(main).not.toMatch(/setFeedURL\s*\(/);
    expect(builder).toContain("provider: generic");
    expect(builder).toContain("url: https://media.nautilo.ai/desktop/stable/mac/");
    expect(builder).toContain("useMultipleRangeRequest: false");
    expect(builder).not.toMatch(/updates\.invalid|process\.env|\$\{[^}]+\}/);
  });

  test("keeps all IPC narrow, sender-gated, and data-only", () => {
    for (const channel of ["updates:get-status", "updates:open", "updates:subscribe"]) {
      const body = handlerBody(channel);
      expect(body).toContain("assertMainWindowSender(e);");
    }
    expect(handlerBody("updates:get-status")).toContain("updateController.getSanitizedStatus()");
    expect(handlerBody("updates:open")).toContain("updateController.openUpdateFlow()");
    expect(handlerBody("updates:subscribe")).toContain("addUpdateStatusSubscriber(e.sender);");
    expect(handlerBody("updates:subscribe")).toContain('e.sender.send("updates:status", status)');
    expect(main).toContain("const updateStatusSubscribers = new Map<number, Electron.WebContents>();");
    expect(main).toContain('contents.once("destroyed", () => updateStatusSubscribers.delete(contents.id))');
    expect(main).toContain('contents.send("updates:status", status)');
    expect(main).not.toContain('sendToActiveRenderer("updates:status", status)');
    expect(main).not.toContain("MAX_UPDATE_STATUS_SUBSCRIBERS");
  });

  test("provides native Later/Download and explicit Cancel/Restart dialogs", () => {
    expect(main).toContain('buttons: ["Later", "Download"]');
    expect(main).toContain('buttons: ["Cancel", "Restart & Update"]');
    expect(main).toContain("Running terminal commands, browser automation, connectors, and local actions will stop.");
    const availableDialog = main.slice(
      main.indexOf("async function showAvailableUpdateDialog"),
      main.indexOf("async function showReadyUpdateDialog"),
    );
    const readyDialog = main.slice(
      main.indexOf("async function showReadyUpdateDialog"),
      main.indexOf("function showNoUpdateDialog"),
    );
    expect(availableDialog).toContain("defaultId: 0");
    expect(readyDialog).toContain("defaultId: 0");
    expect(main).toContain("showNoUpdateDialog");
    expect(main).toContain("showUpdaterErrorDialog");
  });

  test("admits installation synchronously and uses canonical awaited quit cleanup", () => {
    const admission = main.slice(main.indexOf("beforeInstall: () => {"), main.indexOf("onStateChange: (state) => {"));
    expect(admission).toContain("if (!quitPersistencePrepared) return false");
    expect(admission).not.toContain("await ");
    expect(admission).not.toContain("stopOutboxPump");
    expect(admission).not.toContain("setTimeout");
    expect(main).toContain("Installing update… Nautilo will restart automatically.");
    const teardown = main.slice(main.indexOf('app.on("before-quit"'));
    expect(teardown).toContain("desktopDocumentMutationRuntime?.stopOutboxPump()");
    expect(teardown).toContain("invalidatePendingDocumentMutationAcks()");
    expect(teardown).toContain("disposeAllTerminals()");
    expect(teardown).toContain("await binaryReadSessions.closeAll()");
    expect(teardown).toContain("await stopRelay()");
    expect(teardown).toContain("await activeWorkstationProfileController.deactivate()");
  });

  test.each([
    { name: "prepared update closes before before-quit", state: "installing", prepared: true, quitting: false, platform: "darwin", hides: false },
    { name: "invalidated save preparation still prevents close", state: "installing", prepared: false, quitting: false, platform: "darwin", hides: true },
    { name: "downloaded update still hides on ordinary close", state: "ready", prepared: true, quitting: false, platform: "darwin", hides: true },
    { name: "failed update restores ordinary close behavior", state: "error", prepared: true, quitting: false, platform: "darwin", hides: true },
    { name: "ordinary macOS close hides", state: "idle", prepared: false, quitting: false, platform: "darwin", hides: true },
    { name: "ordinary admitted quit closes", state: "idle", prepared: true, quitting: true, platform: "darwin", hides: false },
    { name: "ordinary Windows close closes", state: "idle", prepared: false, quitting: false, platform: "win32", hides: false },
  ])("$name", ({ state, prepared, quitting, platform, hides }) => {
    // Execute the actual main-window handler without booting the Desktop.
    // Native quitAndInstall closes windows before app's before-quit handler
    // can set isQuitting; the old handler prevented and hid this very close.
    const start = mainSource.indexOf('mainWindow.on("close",');
    const end = mainSource.indexOf('mainWindow.on("closed",', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    let prevented = false;
    let hidden = false;
    runInNewContext(mainSource.slice(start, end), {
      isQuitting: quitting,
      quitPersistencePrepared: prepared,
      process: { platform },
      updateController: { getState: () => ({ kind: state }) },
      mainWindow: {
        on: (_event: string, listener: (event: { preventDefault(): void }) => void) => {
          listener({ preventDefault: () => { prevented = true; } });
        },
        hide: () => { hidden = true; },
      },
    });
    expect(prevented).toBe(hides);
    expect(hidden).toBe(hides);
  });

  test("places a direct main-owned update action in the macOS app menu and non-mac Help", () => {
    const appMenuStart = menu.indexOf("// macOS application menu");
    const macMenu = menu.slice(appMenuStart, menu.indexOf("// File", appMenuStart));
    expect(macMenu.indexOf('label: `About ${app.name}`')).toBeLessThan(macMenu.indexOf('label: "Check for Updates…"'));
    expect(macMenu.indexOf('label: "Check for Updates…"')).toBeLessThan(macMenu.indexOf('label: "Settings…"'));
    expect(macMenu).toContain("options.onOpenUpdateFlow()");
    expect(macMenu).not.toContain('sendAction(renderer, "check-for-updates")');
    expect(menu).toContain("...(isMac\n        ? []\n        : ([");
    expect(menu).not.toContain("coming soon");
  });

  test("preload exposes only status subscription and an argument-free open request", () => {
    expect(preload).toContain("const updatesAPI = {");
    expect(preload).toContain('ipcRenderer.invoke("updates:get-status")');
    expect(preload).toContain('ipcRenderer.invoke("updates:subscribe")');
    expect(preload).toContain('ipcRenderer.invoke("updates:open")');
    expect(preload).toContain('ipcRenderer.on("updates:status", eventListener)');
    expect(preload).toContain("updates: updatesAPI");
    expect(preload).not.toContain('updatesAPI.download');
    expect(preload).not.toContain('updatesAPI.install');
  });
});
