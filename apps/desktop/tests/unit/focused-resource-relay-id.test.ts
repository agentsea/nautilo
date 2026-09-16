/**
 * D423 4.1.3 — focused-resource relay identity surface (desktop side).
 *
 * Pins the contract that exposes the persisted Electron relay identity to the
 * Workbench renderer so a local-file focus ref can carry the EXACT originating
 * relay id. `main.ts` is not importable under `bun:test` (it imports Electron
 * and runs boot side effects at module load), so this is a static-text
 * contract test — the same approach `ipc-parity.test.ts` uses — asserting the
 * three sides agree:
 *
 *   - main.ts    → `ipcMain.handle("relay:getIdentity")` reads the persisted
 *                  tuple-scoped relay-id and NEVER generates a replacement.
 *   - preload.ts → exposes `relayIdentity.getRelayId()` → `relay:getIdentity`.
 *   - workbench desktop.ts → declares the `relayIdentity` API + a
 *                  `getDesktopRelayId()` helper that feature-detects and
 *                  degrades to `null` (fail closed).
 *
 * The relay id is private run metadata; it never reaches model prompt prose
 * (the server-side resolver keeps it in `locator` only — covered by the
 * server focused-resources tests).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const desktopRoot = join(import.meta.dir, "../..");
const workbenchLibDesktop = join(desktopRoot, "../workbench/src/lib/desktop.ts");

function readSrc(rel: string): string {
  return readFileSync(join(desktopRoot, rel), "utf-8");
}

/** Extract the body of an `ipcMain.handle("...", () => { ... })` block. */
function extractHandlerBody(source: string, channel: string): string {
  const start = source.indexOf(`ipcMain.handle("${channel}"`);
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start);
  // Body ends at the first line-anchored `});` that closes the handle call.
  const end = rest.indexOf("\n});");
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

describe("D423 4.1.3 — focused-resource relay identity surface", () => {
  test("main.ts registers relay:getIdentity and reads the persisted relay-id file (never generates)", () => {
    const main = readSrc("electron/main.ts");
    const body = extractHandlerBody(main, "relay:getIdentity");
    expect(body).toContain("ipcMain.handle(\"relay:getIdentity\"");
    // Reads the exact tuple-scoped file startRelay persists.
    expect(body).toContain("getPersistedDesktopRelayId()");
    expect(body).not.toContain("homedir()");
    // The identity IPC must return the persisted id, never mint a replacement.
    expect(body).not.toMatch(/randomUUID|randomBytes|crypto\.randomUUID/);
  });

  test("relay start receives tuple-scoped identity and migrates shared legacy state only for the default tuple", () => {
    const main = readSrc("electron/main.ts");
    expect(main).toContain("relayIdentityFilePath: desktopRelayIdentityFilePath()");
    expect(main).toContain("targetDirName === APP_NAME");
    expect(main).toContain("legacyRelayIdentityFilePath: legacySharedRelayIdentityFilePath()");
  });

  test("main.ts relay:getIdentity delegates to the nullable persisted-id reader", () => {
    const main = readSrc("electron/main.ts");
    const body = extractHandlerBody(main, "relay:getIdentity");
    // The reader degrades to null (fail closed) when the relay has not started.
    expect(body).toContain("{ relayId: getPersistedDesktopRelayId() }");
  });

  test("preload.ts exposes relayIdentity.getRelayId → relay:getIdentity", () => {
    const preload = readSrc("electron/preload.ts");
    expect(preload).toContain("relayIdentity");
    expect(preload).toMatch(/relayIdentity:\s*\{/);
    expect(preload).toMatch(/getRelayId/);
    expect(preload).toContain('ipcRenderer.invoke("relay:getIdentity")');
  });

  test("workbench desktop.ts declares the relayIdentity API + getDesktopRelayId helper", () => {
    const desktop = readFileSync(workbenchLibDesktop, "utf-8");
    expect(desktop).toContain("DesktopRelayIdentityAPI");
    expect(desktop).toMatch(/relayIdentity\?:\s*DesktopRelayIdentityAPI/);
    expect(desktop).toContain("export async function getDesktopRelayId");
    // The helper feature-detects the namespace and degrades to null.
    expect(desktop).toContain("api.relayIdentity?.getRelayId");
  });
});
