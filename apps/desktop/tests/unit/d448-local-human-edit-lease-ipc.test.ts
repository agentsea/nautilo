import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeStaticSource } from "./static-source";

const desktopRoot = join(import.meta.dir, "../..");
const preload = normalizeStaticSource(
  readFileSync(join(desktopRoot, "electron/preload.ts"), "utf8"),
);
const main = normalizeStaticSource(
  readFileSync(join(desktopRoot, "electron/main.ts"), "utf8"),
);

describe("D448 Desktop local human-edit lease IPC", () => {
  test("keeps all local lifecycle channels under document mutations", () => {
    for (const operation of ["register", "update", "renew", "release"]) {
      const channel = `documentMutations:humanEditLeases:${operation}`;
      expect(preload).toContain(`ipcRenderer.invoke("${channel}"`);
      expect(main).toContain(`ipcMain.handle("${channel}"`);
    }
  });

  test("routes lifecycle requests through the runtime after the main-window sender gate", () => {
    const handlerStart = main.indexOf('ipcMain.handle("documentMutations:humanEditLeases:register"');
    const handler = main.slice(handlerStart, handlerStart + 1_800);
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handler).toContain("assertMainWindowSender(event)");
    expect(handler).toContain("getDesktopDocumentMutationRuntime()");
    expect(handler).toContain("runtime.registerHumanEditLease(input)");
    expect(handler).not.toContain("readCanonicalSnapshot");
  });
});
