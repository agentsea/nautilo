import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const desktopRoot = join(import.meta.dir, "../..");
const repositoryRoot = join(desktopRoot, "../..");
const main = readFileSync(join(desktopRoot, "electron/main.ts"), "utf8");
const preload = readFileSync(join(desktopRoot, "electron/preload.ts"), "utf8");
const rendererTypes = readFileSync(join(repositoryRoot, "apps/workbench/src/lib/desktop.ts"), "utf8");

describe("SSH on this Mac managed IPC", () => {
  test("exposes one compact management bridge and removes the grant constructor channels", () => {
    const start = preload.indexOf("const structuredSshAPI = {");
    const end = preload.indexOf("const workstationShellAPI", start);
    const bridge = preload.slice(start, end);
    for (const channel of ["status", "check", "enable", "disable"]) {
      expect(bridge).toContain(`structuredSsh:${channel}`);
      expect(main).toContain(`ipcMain.handle("structuredSsh:${channel}"`);
    }
    for (const removed of ["discoverHostKey", "issue", "revoke"]) {
      expect(bridge).not.toContain(`structuredSsh:${removed}`);
      expect(main).not.toContain(`ipcMain.handle("structuredSsh:${removed}"`);
    }
  });

  test("accepts only the established PIN enablement input", () => {
    const start = main.indexOf('ipcMain.handle("structuredSsh:enable"');
    const end = main.indexOf('ipcMain.handle("structuredSsh:disable"', start);
    const handler = main.slice(start, end);
    expect(handler).toContain('Object.keys(request).length !== 1');
    expect(handler).toContain('typeof request["pin"] !== "string"');
    expect(handler).toContain('structuredSshSetup.enable(request["pin"])');
    expect(handler).not.toMatch(/host|port|identity|fingerprint|privateKey|Current Folder/i);
  });

  test("renderer types contain no legacy key, target, grant, or lifetime DTO", () => {
    const start = rendererTypes.indexOf("export interface DesktopStructuredSshStatus");
    const end = rendererTypes.indexOf("export interface DesktopWorkstationShellAPI", start);
    const bridge = rendererTypes.slice(start, end);
    expect(bridge).toContain("enable: (pin: string)");
    expect(bridge).not.toMatch(/Identity|Target|Grant|Fingerprint|Lifetime|Current Folder/);
  });
});
