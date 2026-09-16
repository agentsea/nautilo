import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeStaticSource } from "../unit/static-source";

const desktopRoot = join(import.meta.dir, "../..");
const main = normalizeStaticSource(
  readFileSync(join(desktopRoot, "electron/main.ts"), "utf8"),
);
const preload = normalizeStaticSource(
  readFileSync(join(desktopRoot, "electron/preload.ts"), "utf8"),
);
const systemPermissionsSection = readFileSync(
  join(desktopRoot, "../workbench/src/components/system-permissions-section.tsx"),
  "utf8",
);

function handler(channel: string): string {
  const start = main.indexOf(`ipcMain.handle("${channel}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = main.indexOf("ipcMain.", start + 1);
  return main.slice(start, next === -1 ? undefined : next);
}

describe("system permission Electron bridge", () => {
  test("exposes a narrow status, fixed-ID resolve, and unsubscribe-safe subscription API", () => {
    expect(preload).toContain("const systemPermissionsAPI = {");
    expect(preload).toContain('ipcRenderer.invoke("systemPermissions:status")');
    expect(preload).toContain('ipcRenderer.invoke("systemPermissions:resolve", id)');
    expect(preload).toContain('ipcRenderer.invoke("systemPermissions:restart")');
    expect(preload).toContain('ipcRenderer.send("systemPermissions:subscribe")');
    expect(preload).toContain('ipcRenderer.send("systemPermissions:unsubscribe")');
    expect(preload).toContain('ipcRenderer.on("systemPermissions:statusChanged"');
    expect(preload).toContain("systemPermissions: systemPermissionsAPI");
  });

  test("gates status and validates a renderer ID before it can resolve a native action", () => {
    expect(handler("systemPermissions:status")).toContain("assertMainWindowSender(e);");
    const resolve = handler("systemPermissions:resolve");
    expect(resolve).toContain("assertMainWindowSender(e);");
    expect(resolve).toContain("if (!isSystemPermissionId(raw))");
    expect(resolve.indexOf("if (!isSystemPermissionId(raw))"))
      .toBeLessThan(resolve.indexOf("resolveSystemPermission(raw)"));
    expect(resolve).not.toContain("url");
    const restart = handler("systemPermissions:restart");
    expect(restart).toContain("assertMainWindowSender(e);");
    expect(restart).toContain("getSystemPermissionsSnapshot().permissions.some(");
    expect(restart).toContain('permission.restart === "required"');
    expect(restart).toContain("app.relaunch();");
    expect(restart).toContain("app.quit();");
    expect(restart).not.toContain("app.exit(");
  });

  test("sender-gates the app-wide onboarding preference and accepts only a boolean", () => {
    const getPreference = handler("systemPermissions:onboardingPreference");
    expect(getPreference).toContain("assertMainWindowSender(e);");
    expect(getPreference).toContain('app.getPath("appData")');
    expect(getPreference).toContain('app.isPackaged ? "packaged" : "development"');
    const setPreference = handler("systemPermissions:setOnboardingPreference");
    expect(setPreference).toContain("assertMainWindowSender(e);");
    expect(setPreference).toContain('typeof raw !== "boolean"');
    expect(preload).toContain('"systemPermissions:onboardingPreference"');
    expect(preload).toContain('"systemPermissions:setOnboardingPreference"');
  });

  test("runs the watcher only for subscribed main renderers and sends changes only", () => {
    expect(main).toContain("const systemPermissionStatusSubscribers = new Map<number, Electron.WebContents>();");
    expect(main).toContain("setInterval(emitSystemPermissionStatusIfChanged, 750)");
    expect(main).toContain('contents.send("systemPermissions:statusChanged", snapshot)');
    expect(main).toContain('contents.once("destroyed", () => {');
    expect(main).toContain("stopSystemPermissionStatusWatchIfUnused();");
    expect(main).toContain('app.on("browser-window-focus", () => {');
    expect(main).toContain("if (signature === lastSystemPermissionStatusSignature) return;");
  });

  test("reconciles an already-running Cua Host only after an observed required-grant transition", () => {
    expect(main).toContain("function computerUsePermissionSignature(snapshot: SystemPermissionsSnapshot): string");
    expect(main).toContain("let lastComputerUsePermissionSignature: string | null = null;");
    expect(main).toContain("const baseline = getSystemPermissionsSnapshot();");
    expect(main).toContain("lastComputerUsePermissionSignature = computerUsePermissionSignature(baseline);");
    expect(main).toContain("let lastCuaHostPermissionCheck:");
    expect(main).toContain("let requestedCuaHostPermissionSignature: string | null = null;");
    expect(main).toContain("function reconcileCuaHostPermissionSignature(signature: string): Promise<void>");
    expect(main).toContain("if (requestedCuaHostPermissionSignature !== target || observed !== target)");
    expect(main).toContain("recordCuaHostPermissionCheck(observed);");
    expect(main).toContain("function reconcileCuaForHostPermissionTransition(): void");
    expect(main).toContain("await refreshComputerUseProviderProjection();");
    expect(main).toContain("function reconcileCuaForObservedHostPermissionChange(): void");
    expect(main).toContain("reconcileCuaForObservedHostPermissionChange();");

    const watcherStart = main.indexOf("function emitSystemPermissionStatusIfChanged(): void");
    const watcherEnd = main.indexOf("function startSystemPermissionStatusWatch(): void", watcherStart);
    expect(watcherStart).toBeGreaterThan(-1);
    const watcher = main.slice(watcherStart, watcherEnd);
    const rowWake = watcher.indexOf('contents.send("systemPermissions:statusChanged", snapshot)');
    const reconcile = watcher.indexOf("reconcileCuaForHostPermissionTransition();");
    expect(rowWake).toBeGreaterThan(-1);
    expect(reconcile).toBeGreaterThan(rowWake);
    expect(watcher).toContain("lastComputerUsePermissionSignature !== null");

    const reconciliationStart = main.indexOf("function reconcileCuaForHostPermissionTransition(): void");
    const reconciliationEnd = main.indexOf("function reconcileCuaForObservedHostPermissionChange", reconciliationStart);
    const reconciliation = main.slice(reconciliationStart, reconciliationEnd);
    expect(reconciliation).not.toContain("await computerUseHostBroker.close();");
    expect(reconciliation).not.toContain("managedComputerUseHostRuntime.bootstrap()");
    expect(reconciliation).toContain("await refreshComputerUseProviderProjection();");
    expect(reconciliation.indexOf('await refreshComputerUseRelay("Cua host permission transition reconciled")'))
      .toBeLessThan(reconciliation.indexOf("notifyComputerUseStatusChanged();"));
  });

  test("subscribing immediately sends the watcher baseline, so an old status promise can be suppressed", () => {
    const subscriptionStart = main.indexOf('ipcMain.on("systemPermissions:subscribe"');
    const subscriptionEnd = main.indexOf('ipcMain.on("systemPermissions:unsubscribe"', subscriptionStart);
    const subscription = main.slice(subscriptionStart, subscriptionEnd);
    expect(subscription).toContain("const baseline = getSystemPermissionsSnapshot();");
    expect(subscription).toContain('contents.send("systemPermissions:statusChanged", baseline);');
    expect(subscription).toContain("startSystemPermissionStatusWatch(baseline);");
    expect(systemPermissionsSection).toContain("versionRef.current += 1;");
  });

  test("sender-gates subscriptions rather than trusting any webContents", () => {
    expect(main).toContain('ipcMain.on("systemPermissions:subscribe", (e) => {');
    expect(main).toContain('ipcMain.on("systemPermissions:unsubscribe", (e) => {');
    expect(main).toContain("acceptSystemPermissionStatusSubscriber(e)");
    expect(main).toContain("assertMainWindowSender(e as Electron.IpcMainInvokeEvent);");
  });
});
