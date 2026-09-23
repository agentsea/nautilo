import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const desktopRoot = join(import.meta.dir, "../..");
const main = readFileSync(join(desktopRoot, "electron/main.ts"), "utf8");
const preload = readFileSync(join(desktopRoot, "electron/preload.ts"), "utf8");

function sliceBetween(source: string, startText: string, endText: string): string {
  const start = source.indexOf(startText);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endText, start + startText.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("native mini-app persistence lifecycle", () => {
  test("preload registers only while a renderer owns a quit handler and catches sync throws", () => {
    const exposed = sliceBetween(preload, "onPrepareQuit:", "updates: updatesAPI");
    expect(exposed).toContain("prepareDesktopQuitListeners.size === 1");
    expect(exposed).toContain('ipcRenderer.send("desktop:lifecycle:register-quit-guard")');
    expect(exposed).toContain("prepareDesktopQuitListeners.size === 0");
    expect(exposed).toContain('ipcRenderer.send("desktop:lifecycle:unregister-quit-guard")');

    const request = sliceBetween(
      preload,
      'ipcRenderer.on("desktop:lifecycle:prepare-quit"',
      'ipcRenderer.on("systemPermissions:statusChanged"',
    );
    expect(request).toContain("Promise.resolve().then(() => listener(cancellation))");
    expect(request).toContain("isCancelled: () => controller.signal.aborted");
    expect(request).toContain("onCancelled: (handler)");
    expect(request).toContain("listener(cancellation)");
    expect(request).toContain('ipcRenderer.send("desktop:lifecycle:prepare-quit-result"');
    expect(request).toContain('ipcRenderer.on("desktop:lifecycle:prepare-quit-cancelled"');
    expect(request).toContain("ready: false");
  });

  test("main binds registration and results to verified server-session renderers", () => {
    const registration = sliceBetween(
      main,
      "function forgetQuitGuardRenderer",
      "let rendererQuitPreparationPromise",
    );
    expect(registration).toContain("serverSessions.getBySender(renderer.id)");
    expect(registration).toContain("isVerifiedWorkbenchRenderer(renderer)");
    expect(registration).toContain("if (!isMainFrame || isInPlace) return");
    expect(registration).toContain('renderer.removeListener("did-start-navigation", onDidStartNavigation)');
    expect(registration).toContain("result.requestId");
    expect(registration).toContain("event.sender.id");
    expect(registration).toContain("quitGuardCoordinator.unregister(rendererId)");
    expect(registration).toContain("completedQuitPreparation || quitPersistencePrepared");
    expect(registration).toContain("releaseCompletedQuitPreparation()");
  });

  test("a registered renderer has no timeout-success or absent-response bypass", () => {
    const preparation = sliceBetween(
      main,
      "async function runRegisteredRendererQuitPreparation()",
      "let currentRelayStatus",
    );
    expect(preparation).toContain("Promise.all(responses)");
    expect(preparation).toContain("Promise.race([responsePromise, cancelPromise])");
    expect(preparation).toContain("dialogAbort.abort()");
    expect(preparation).toContain("await cancelPromise");
    expect(preparation).toContain("cancelRendererQuitPreparation(requestId, targets)");
    expect(preparation).toContain('buttons: ["Cancel Quit"]');
    expect(preparation).toContain('buttons: ["Cancel Quit", "Retry"]');
    expect(preparation).not.toContain("setTimeout(");
  });

  test("macOS progress and retry dialogs stay asynchronous and fail closed without a live parent", () => {
    const preparation = sliceBetween(
      main,
      "function resolveQuitProgressDialogParent",
      "let currentRelayStatus",
    );
    expect(preparation).toContain("BrowserWindow.fromWebContents(renderer)");
    expect(preparation).toContain("if (parent.isMinimized()) parent.restore()");
    expect(preparation).toContain("if (!parent.isVisible()) parent.show()");
    expect(preparation).toContain("if (!progressDialogParent)");
    expect(preparation).toContain("return false");
    expect(preparation).toContain("dialog.showMessageBox(progressDialogParent, {");
    expect(preparation.match(/dialog\.showMessageBox\(progressDialogParent, \{/g)).toHaveLength(2);
    expect(preparation).not.toContain("dialog.showMessageBox({");
    expect(preparation).toContain("invalidatedDuringPreparation = true");
    expect(preparation).toContain("outcome.ready && !invalidatedDuringPreparation");
  });

  test("ordinary quit prevents teardown until persistence succeeds", () => {
    const beforeQuit = main.slice(main.indexOf('app.on("before-quit"'));
    const prevented = beforeQuit.indexOf("event.preventDefault()");
    const prepared = beforeQuit.indexOf("prepareRegisteredRenderersForQuit()");
    const quitting = beforeQuit.indexOf("isQuitting = true");
    const teardown = beforeQuit.indexOf("quitTeardownStarted = true");
    expect(prevented).toBeGreaterThanOrEqual(0);
    expect(prepared).toBeGreaterThan(prevented);
    expect(quitting).toBeGreaterThan(prepared);
    expect(teardown).toBeGreaterThan(quitting);
    expect(beforeQuit).toContain("if (!ready) return");

    const trayQuit = sliceBetween(
      main,
      'label: "Quit Nautilo"',
      "// ---------------------------------------------------------------------------\n// Window creation",
    );
    expect(trayQuit).toContain("app.quit()");
    expect(trayQuit).not.toContain("isQuitting = true");
  });

  test("confirmed update restart uses the same persistence guard before install authority", () => {
    const readyDialog = sliceBetween(
      main,
      "async function showReadyUpdateDialog",
      "function showNoUpdateDialog",
    );
    expect(readyDialog).toContain("await prepareRegisteredRenderersForQuit()");
    expect(readyDialog.indexOf("await prepareRegisteredRenderersForQuit()"))
      .toBeLessThan(readyDialog.indexOf('return "restart"'));
    expect(readyDialog).toContain("quitPersistencePrepared = true");
  });

  test("macOS window close remains a reversible hide and does not claim app quit", () => {
    const close = sliceBetween(
      main,
      'mainWindow.on("close"',
      'mainWindow.on("closed"',
    );
    expect(close).toContain('process.platform === "darwin"');
    expect(close).toContain("e.preventDefault()");
    expect(close).toContain("mainWindow?.hide()");
  });
});
