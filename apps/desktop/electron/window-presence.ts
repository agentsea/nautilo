import { app, type BaseWindow } from "electron";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Native Space presence complements keyboard focus. Only main
 * process window identity reaches the fixed, read-only helper. */
export async function isMainSpaceVisible(window: BaseWindow): Promise<boolean> {
  if (process.platform !== "darwin" || window.isDestroyed()) return false;
  const id = /^window:(\d+):/.exec(window.getMediaSourceId())?.[1];
  if (!id) return false;
  const executable = app.isPackaged
    ? join(process.resourcesPath, "tools-window-presence", "nautilo-window-presence")
    : join(__dirname, "../vendor/window-presence/nautilo-window-presence");
  try {
    const { stdout } = await run(executable, [String(process.pid), id]);
    return stdout.trim() === "visible";
  } catch {
    // Focus-based behavior and the explicit attach control remain available.
    return false;
  }
}
