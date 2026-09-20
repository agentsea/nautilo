import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createWorkspaceGuard } from "@nautilo/relay";
import { createInteractiveBrowserDispatchHandler } from "../../electron/relay-dispatch/interactive-browser.ts";
import { normalizeStaticSource } from "./static-source";

const desktopRoot = join(import.meta.dir, "../..");

describe("browserControl IPC wiring", () => {
  test("preload exposes the webview adoption bridge", () => {
    const preload = normalizeStaticSource(
      readFileSync(join(desktopRoot, "electron/preload.ts"), "utf-8"),
    );
    expect(preload).toContain("browserControl: browserControlAPI");
    expect(preload).toContain('ipcRenderer.invoke("browserControl:attachWebview"');
    expect(preload).toContain('ipcRenderer.invoke("browserControl:detachWebview"');
    expect(preload).toContain('ipcRenderer.invoke("browserControl:setActive"');
    expect(preload).toContain('ipcRenderer.invoke("browserControl:getViews"');
    expect(preload).toContain('ipcRenderer.on("browserControl:openRequested"');
  });

  test("main attach handler is sender-gated and adopts the guest webContents", () => {
    const main = readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8");
    const attachStart = main.indexOf('"browserControl:attachWebview"');
    expect(attachStart).toBeGreaterThan(-1);
    const attachSlice = main.slice(attachStart, attachStart + 900);
    expect(attachSlice).toContain("assertMainWindowSender(e)");
    expect(attachSlice).toContain("webContents.fromId(args.webContentsId)");
    expect(main).toContain("attachEmbeddedBrowserNavigationHandlers(guest)");
    expect(attachSlice).toContain("browserControlManager.adopt");

    const detachStart = main.indexOf('"browserControl:detachWebview"');
    expect(detachStart).toBeGreaterThan(-1);
    const detachSlice = main.slice(detachStart, detachStart + 300);
    expect(detachSlice).toContain("assertMainWindowSender(e)");
    expect(detachSlice).toContain("browserControlManager?.release(args.appId)");

    const viewsStart = main.indexOf('"browserControl:getViews"');
    expect(viewsStart).toBeGreaterThan(-1);
    const viewsSlice = main.slice(viewsStart, viewsStart + 250);
    expect(viewsSlice).toContain("assertMainWindowSender(e)");
    expect(viewsSlice).toContain("browserControlManager?.list()");
  });

  test("main window enables the webview tag", () => {
    const main = readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8");
    expect(main).toContain("webviewTag: true");
  });

  test("embedded browser external protocols route to shell.openExternal", () => {
    const main = readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8");
    expect(main).toContain("guest.setWindowOpenHandler");
    expect(main).toContain('guest.on("will-navigate"');
    expect(main).toContain("shouldOpenOutsideEmbeddedBrowser");
    expect(main).toContain("shell.openExternal(rawUrl)");
  });

  test("workbench desktop types expose browserControl namespace", () => {
    const desktop = readFileSync(
      join(desktopRoot, "../workbench/src/lib/desktop.ts"),
      "utf-8",
    );
    expect(desktop).toContain("export interface DesktopBrowserControlAPI");
    expect(desktop).toContain("browserControl?: DesktopBrowserControlAPI");
    expect(desktop).toContain("attachWebview");
    expect(desktop).toContain("onOpenRequested");
  });

  test("relay browser_open cold-starts the Workbench Browser surface", () => {
    const main = readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8");
    const shell = readFileSync(
      join(desktopRoot, "../workbench/src/layouts/workbench-shell.tsx"),
      "utf-8",
    );

    expect(main).toContain("ensureBrowserSurface: async ({ url, timeoutMs }) =>");
    expect(main).toContain('renderer.send("browserControl:openRequested", { url })');
    expect(main).toContain('manager.waitForActiveView("browser", timeoutMs)');
    expect(main).toContain("const snapshot = await ready");
    expect(main).toContain("controlBrowserNavigation: async ({ action }) =>");
    expect(main).toContain("browserControlManager?.navigateActive(action)");
    expect(shell).toContain("desktopAPI?.browserControl?.onOpenRequested");
    expect(shell).toContain('appId: "browser"');
    expect(shell).toContain('mode: "browser"');
  });

  test("relay gives cold-open the browser execution budget and trusts exact manager acknowledgement", async () => {
    const readiness: unknown[] = [];
    let waitCalls = 0;
    let publishedView = false;
    const observed = { snapshot: '- button "Continue" [ref=e2]',
      refs: { e2: { role: "button", name: "Continue" } }, origin: "https://example.com/path" };
    const handler = createInteractiveBrowserDispatchHandler({
      resolveBinary: () => "/managed/agent-browser",
      binaryInstallHint: () => "install managed agent-browser",
      ensureConfig: () => "/owned/browser-config.json",
      sessionFor: () => "browser-session",
      hasPublishedView: () => publishedView,
      waitForPublishedView: async () => {
        waitCalls += 1;
        return false;
      },
      ensureBrowserSurface: async (input) => {
        readiness.push(input);
        publishedView = true;
        return { ok: true };
      },
      getCoordinateScale: () => undefined,
      setCoordinateScale: () => {},
      exec: async (_binary, argv) => ({ stdout: argv.includes("snapshot")
        ? JSON.stringify({ success: true, data: observed }) : argv.includes("eval")
          ? JSON.stringify({ ready: true }) : "opened" }),
      pruneCaptures: () => {},
      capturePath: () => "/owned/browser-shot.png",
      readCapturePng: () => Buffer.alloc(24),
      captureDimensions: () => ({ width: 1, height: 1 }),
      visionFromPng: () => ({ status: "error", error: "not used" }),
    });

    expect(await handler({
      request: {
        correlationId: "cold-open",
        toolName: "browser_open",
        args: { url: "https://example.com/path" },
        impact: "low",
        approvalObtained: true,
        executionClass: "browser",
      },
      signal: undefined,
      guard: createWorkspaceGuard({ workspaceRoot: "/tmp" }),
    })).toEqual({
      handled: true,
      result: { status: "ok", result: {
        navigation: { execution: "executed", result: "opened" },
        observation: { version: 1, snapshot: observed.snapshot, refs: observed.refs,
          pageUrl: observed.origin, browserSessionId: "browser-session", observationId: expect.any(String) as unknown },
      } },
    });
    expect(readiness).toEqual([{
      url: "https://example.com/path",
      timeoutMs: 30_000,
    }]);
    expect(waitCalls).toBe(0);
  });

  test("preload and main expose the tool runtime bridge", () => {
    const preload = readFileSync(join(desktopRoot, "electron/preload.ts"), "utf-8");
    const main = readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8");
    const desktop = readFileSync(
      join(desktopRoot, "../workbench/src/lib/desktop.ts"),
      "utf-8",
    );

    expect(preload).toContain("toolRuntimes: toolRuntimesAPI");
    expect(preload).toContain('ipcRenderer.invoke("toolRuntimes:getStatus"');
    expect(preload).toContain('ipcRenderer.invoke("toolRuntimes:refresh"');
    expect(preload).toContain('ipcRenderer.invoke("toolRuntimes:setPath"');
    expect(preload).toContain('ipcRenderer.invoke("toolRuntimes:clearPath"');

    expect(main).toContain('ipcMain.handle("toolRuntimes:getStatus"');
    expect(main).toContain('ipcMain.handle("toolRuntimes:refresh"');
    expect(main).toContain('"toolRuntimes:setPath"');
    expect(main).toContain('"toolRuntimes:clearPath"');

    expect(desktop).toContain("export interface DesktopToolRuntimesAPI");
    expect(desktop).toContain("toolRuntimes?: DesktopToolRuntimesAPI");
  });

  test("tool runtime changes refresh relay registration capabilities", () => {
    const main = readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8");

    const refreshStart = main.indexOf('ipcMain.handle("toolRuntimes:refresh"');
    expect(refreshStart).toBeGreaterThan(-1);
    const refreshSlice = main.slice(refreshStart, refreshStart + 250);
    expect(refreshSlice).toContain('refreshRelayForCurrentFolder("tool runtime refresh")');

    const setPathStart = main.indexOf('"toolRuntimes:setPath"');
    expect(setPathStart).toBeGreaterThan(-1);
    const setPathSlice = main.slice(setPathStart, setPathStart + 650);
    expect(setPathSlice).toContain("setToolRuntimePath(tool, args.path)");
    expect(setPathSlice).toContain("refreshRelayForCurrentFolder(`tool runtime path set: ${tool}`)");

    const clearPathStart = main.indexOf('"toolRuntimes:clearPath"');
    expect(clearPathStart).toBeGreaterThan(-1);
    const clearPathSlice = main.slice(clearPathStart, clearPathStart + 500);
    expect(clearPathSlice).toContain("clearToolRuntimePath(tool)");
    expect(clearPathSlice).toContain("refreshRelayForCurrentFolder(`tool runtime path cleared: ${tool}`)");
  });
});
