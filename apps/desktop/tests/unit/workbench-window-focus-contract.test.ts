import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const desktopRoot = join(import.meta.dir, "../..");

describe("Workbench host-window focus bridge", () => {
  const main = readFileSync(join(desktopRoot, "electron/main.ts"), "utf8");
  const preload = readFileSync(join(desktopRoot, "electron/preload.ts"), "utf8");

  test("publishes main-owned focus and blur transitions", () => {
    expect(main).toContain('mainWindow.on("focus", publishWorkbenchHostWindowFocus)');
    expect(main).toContain('mainWindow.on("blur", publishWorkbenchHostWindowFocus)');
    expect(main).toContain('"workbench:window-focus-changed"');
  });

  test("preload exposes a cached synchronous focus projection", () => {
    expect(preload).toContain('ipcRenderer.on("workbench:window-focus-changed"');
    expect(preload).toContain("isWindowFocused: () => workbenchWindowFocused");
    expect(preload).toContain("onWindowFocusChanged:");
  });
});
