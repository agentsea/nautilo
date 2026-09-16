/**
 * D453 — Electron lifecycle wiring checks without importing main.ts, whose
 * top-level boot path requires a real Electron runtime.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const desktopRoot = join(import.meta.dir, "../..");
const main = readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8");

function sliceBetween(startText: string, endText: string): string {
  const start = main.indexOf(startText);
  expect(start).toBeGreaterThan(-1);
  const end = main.indexOf(endText, start + startText.length);
  expect(end).toBeGreaterThan(start);
  return main.slice(start, end);
}

function expectOrdered(slice: string, ...values: string[]): void {
  let previous = -1;
  for (const value of values) {
    const next = slice.indexOf(value);
    expect(next).toBeGreaterThan(previous);
    previous = next;
  }
}

describe("Codex connection lifecycle wiring", () => {
  test("maps the existing boolean relay refresh to acked, deferred, or failed", () => {
    const slice = sliceBetween(
      "const codexConnection = new ElectronCodexConnection",
      "function grantIpcFailure",
    );
    expect(slice).toContain('getRelayStatus() === "connected"');
    expect(slice).toContain('if (acknowledged) return "acked"');
    expect(slice).toContain('? "failed"');
    expect(slice).toContain(': "deferred"');
  });

  test("sign-out stops relay and disables Codex before actor/profile cleanup", () => {
    const slice = sliceBetween("async function handleSignOut()", "function rebuildApplicationMenu");
    expectOrdered(
      slice,
      "await stopRelay()",
      "await codexConnection.disable()",
      "clearTokens()",
      "activeWorkstationProfileController.deactivate()",
    );
  });

  test("recovery and server-picker paths retain authority until guarded in-process promotion", () => {
    const coldBoot = sliceBetween(
      'ipcMain.handle("coldBoot:pairToDifferentServer"',
      'ipcMain.handle("coldBoot:useThisServerAnyway"',
    );
    expectOrdered(
      coldBoot,
      "assertColdBootActionSender(e)",
      "await showGuardedServerPicker({ mode: \"switch-server\"",
      'if (!result?.ok || !("verified" in result))',
      "recoveryReplacementCohort = { url: result.url, verified: result.verified }",
      "projectVerifiedConnectionCohort(recoveryReplacementCohort)",
    );
    // A picker cancel, mismatch, or offline result must leave the existing
    // authority alive; the successful cohort is promoted by the shared flow.
    expect(coldBoot).toContain("A remains the durable/visible authority while the picker prepares B.");
    expect(coldBoot).not.toContain("await stopRelay()");
    expect(coldBoot).not.toContain("await codexConnection.disable()");
    expect(coldBoot).not.toContain("app.relaunch()");
    expect(coldBoot).not.toContain("app.exit(0)");

    const switchServer = sliceBetween(
      "function showGuardedServerPicker(",
      'ipcMain.handle("servers:open-picker"',
    );
    expectOrdered(
      switchServer,
      "if (activeServerPicker) return activeServerPicker",
      "const opened = showFirstRunPicker(opts)",
      "activeServerPicker = guarded",
    );
    expect(switchServer).toContain("if (activeServerPicker === guarded) activeServerPicker = null");
    expect(switchServer).toContain('mode: "switch-server"');
    expect(switchServer).not.toContain("app.relaunch()");
    expect(switchServer).not.toContain("app.exit(0)");

    const menu = sliceBetween(
      "function rebuildApplicationMenu()",
      "// Window state persistence",
    );
    expect(menu).toContain("onSwitchServer: () => openServerPicker()");

    const handler = sliceBetween(
      'ipcMain.handle("servers:open-picker"',
      'ipcMain.on("servers:subscribe-changed"',
    );
    expect(handler).toContain("assertMainWindowSender(e)");
    expect(handler).toContain("await openServerPicker()");
  });

  test("before-quit waits once for relay stop and final Codex shutdown", () => {
    const start = main.indexOf('app.on("before-quit"');
    expect(start).toBeGreaterThan(-1);
    const slice = main.slice(start);
    expect(slice).toContain("event.preventDefault()");
    expect(slice).toContain("quitTeardownStarted");
    expect(slice).toContain("quitTeardownComplete");
    expectOrdered(
      slice,
      "await stopRelay()",
      "await codexConnection.shutdown()",
      "activeWorkstationProfileController.deactivate()",
      "quitTeardownComplete = true",
      "app.quit()",
    );
  });

  test("ordinary process termination signals enter the awaited before-quit teardown", () => {
    const signalStart = main.indexOf('for (const signal of ["SIGINT", "SIGTERM"] as const)');
    const quitStart = main.indexOf('app.on("before-quit"');
    expect(signalStart).toBeGreaterThan(-1);
    expect(quitStart).toBeGreaterThan(signalStart);
    const slice = main.slice(signalStart, quitStart);
    expect(slice).toContain("process.once(signal");
    expect(slice).toContain("app.quit()");
  });
});
