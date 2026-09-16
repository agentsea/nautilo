/**
 * D357 Phase 3 — static mkdir checks plus executable structural IPC checks
 * (no Electron runtime).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerFsStructuralIpcHandlers } from "../../electron/fs-structural-ipc";

const desktopRoot = join(import.meta.dir, "../..");

describe("fs:mkdir IPC wiring", () => {
  test("main handler calls assertMainWindowSender before path jail", () => {
    const main = readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8");
    const handlerStart = main.indexOf('ipcMain.handle(\n  "fs:mkdir"');
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerSlice = main.slice(handlerStart, handlerStart + 600);
    const senderIdx = handlerSlice.indexOf("assertMainWindowSender(e)");
    const pathIdx = handlerSlice.indexOf("assertPathInAllowedRoot");
    expect(senderIdx).toBeGreaterThan(-1);
    expect(pathIdx).toBeGreaterThan(-1);
    expect(senderIdx).toBeLessThan(pathIdx);
  });

  test("main handler uses fs.promises.mkdir with recursive:false", () => {
    const main = readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8");
    const handlerStart = main.indexOf('ipcMain.handle(\n  "fs:mkdir"');
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerSlice = main.slice(handlerStart, handlerStart + 800);
    expect(handlerSlice).toContain("fsp.mkdir(args.path, { recursive: false })");
  });

  test("main handler maps EEXIST → code 'exists'", () => {
    const main = readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8");
    const handlerStart = main.indexOf('ipcMain.handle(\n  "fs:mkdir"');
    const handlerSlice = main.slice(handlerStart, handlerStart + 1200);
    expect(handlerSlice).toContain('err.code === "EEXIST"');
    expect(handlerSlice).toContain('code: "exists"');
  });

  test("main handler returns 'forbidden' when path is outside allowed root", () => {
    const main = readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8");
    const handlerStart = main.indexOf('ipcMain.handle(\n  "fs:mkdir"');
    const handlerSlice = main.slice(handlerStart, handlerStart + 1200);
    expect(handlerSlice).toContain('code: "forbidden"');
  });

  test("preload exposes fs.mkdir invoking fs:mkdir", () => {
    const preload = readFileSync(join(desktopRoot, "electron/preload.ts"), "utf-8");
    expect(preload).toContain("mkdir:");
    expect(preload).toContain('ipcRenderer.invoke("fs:mkdir"');
  });

  test("workbench desktop types expose fs.mkdir + FsMkdirResult", () => {
    const desktop = readFileSync(
      join(desktopRoot, "../workbench/src/lib/desktop.ts"),
      "utf-8",
    );
    expect(desktop).toContain("export type FsMkdirResult");
    expect(desktop).toContain("mkdir:");
    expect(desktop).toContain('code: "exists" | "forbidden" | "error"');
  });
});

describe("fs:rename IPC wiring", () => {
  test("registered handler checks sender then both roots, uses one rename call, and maps collisions", async () => {
    const handlers = new Map<string, (event: { main: boolean }, args: unknown) => Promise<unknown>>();
    const calls: string[] = [];
    registerFsStructuralIpcHandlers({
      ipcMain: { handle: (channel, listener) => handlers.set(channel, listener as (event: { main: boolean }, args: unknown) => Promise<unknown>) },
      assertSender: (event) => {
        calls.push("sender");
        if (!event.main) throw new Error("foreign sender");
      },
      assertPathInAllowedRoot: (target) => {
        calls.push(`path:${target}`);
        if (target === "/outside") throw new Error("outside root");
      },
      fs: {
        readFile: async () => Buffer.alloc(0),
        writeFile: async () => {},
        rename: async (from, to) => {
          calls.push(`rename:${from}:${to}`);
          if (to === "/collision") throw Object.assign(new Error("exists"), { code: "EEXIST" });
        },
        unlink: async () => {},
      },
      shell: { trashItem: async () => {} },
      createFileExclusive: async () => {
        throw new Error("not used");
      },
    });
    const rename = handlers.get("fs:rename");
    if (!rename) throw new Error("fs:rename was not registered");
    expect(await rename({ main: true }, { from: "/source", to: "/destination" })).toEqual({ ok: true });
    expect(calls).toEqual(["sender", "path:/source", "path:/destination", "rename:/source:/destination"]);
    calls.length = 0;
    expect(await rename({ main: true }, { from: "/source", to: "/collision" })).toEqual({ ok: false, code: "exists" });
    expect(calls).toEqual(["sender", "path:/source", "path:/collision", "rename:/source:/collision"]);
    calls.length = 0;
    expect(await rename({ main: true }, { from: "/source", to: "/outside" })).toEqual({ ok: false, code: "forbidden" });
    expect(calls).toEqual(["sender", "path:/source", "path:/outside"]);
  });

  test("preload exposes fs.rename invoking fs:rename with {from, to}", () => {
    const preload = readFileSync(join(desktopRoot, "electron/preload.ts"), "utf-8");
    expect(preload).toContain("rename:");
    expect(preload).toContain('ipcRenderer.invoke("fs:rename"');
    expect(preload).toContain("from: fromPath");
    expect(preload).toContain("to: toPath");
  });

  test("workbench desktop types expose fs.rename + FsRenameResult", () => {
    const desktop = readFileSync(
      join(desktopRoot, "../workbench/src/lib/desktop.ts"),
      "utf-8",
    );
    expect(desktop).toContain("export type FsRenameResult");
    expect(desktop).toContain("rename:");
  });
});

describe("fs:trash IPC wiring", () => {
  test("registered handler uses the injected recoverable trash port after sender and root checks", async () => {
    const handlers = new Map<string, (event: { main: boolean }, args: unknown) => Promise<unknown>>();
    const calls: string[] = [];
    registerFsStructuralIpcHandlers({
      ipcMain: { handle: (channel, listener) => handlers.set(channel, listener as (event: { main: boolean }, args: unknown) => Promise<unknown>) },
      assertSender: (event) => {
        calls.push("sender");
        if (!event.main) throw new Error("foreign sender");
      },
      assertPathInAllowedRoot: (target) => {
        calls.push(`path:${target}`);
        if (target === "/outside") throw new Error("outside root");
      },
      fs: { readFile: async () => Buffer.alloc(0), writeFile: async () => {}, rename: async () => {}, unlink: async () => {} },
      shell: { trashItem: async (target) => calls.push(`trash:${target}`) },
      createFileExclusive: async () => {
        throw new Error("not used");
      },
    });
    const trash = handlers.get("fs:trash");
    if (!trash) throw new Error("fs:trash was not registered");
    expect(await trash({ main: true }, { path: "/target" })).toEqual({ ok: true });
    expect(calls).toEqual(["sender", "path:/target", "trash:/target"]);
    calls.length = 0;
    expect(await trash({ main: true }, { path: "/outside" })).toEqual({ ok: false, code: "forbidden" });
    expect(calls).toEqual(["sender", "path:/outside"]);
  });

  test("preload exposes fs.trash invoking fs:trash", () => {
    const preload = readFileSync(join(desktopRoot, "electron/preload.ts"), "utf-8");
    expect(preload).toContain("trash:");
    expect(preload).toContain('ipcRenderer.invoke("fs:trash"');
  });

  test("workbench desktop types expose fs.trash + FsTrashResult", () => {
    const desktop = readFileSync(
      join(desktopRoot, "../workbench/src/lib/desktop.ts"),
      "utf-8",
    );
    expect(desktop).toContain("export type FsTrashResult");
    expect(desktop).toContain("trash:");
  });
});
