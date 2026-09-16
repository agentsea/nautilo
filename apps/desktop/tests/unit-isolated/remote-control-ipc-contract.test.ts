import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeRemoteOrdinaryRequestBody } from "@nautilo/types";
import { normalizeStaticSource } from "../unit/static-source";

const preload = normalizeStaticSource(
  readFileSync(join(import.meta.dir, "../../electron/preload.ts"), "utf8"),
);
const main = normalizeStaticSource(
  readFileSync(join(import.meta.dir, "../../electron/main.ts"), "utf8"),
);

describe("remote-control Electron IPC contract", () => {
  test("only accepts a policy selector and never exposes native blocker identity", () => {
    expect(preload).toContain('ipcRenderer.invoke("remoteControl:setKeepAwakePolicy", {policy})');
    expect(preload).not.toContain("blockerId");
    expect(main).toContain('powerSaveBlocker.start("prevent-display-sleep")');
    expect(main).toContain('powerSaveBlocker.stop(id)');
  });

  test("uses the active relay identity in main and keeps relay token out of pairing IPC", () => {
    expect(main).toContain("getPersistedDesktopRelayId()");
    expect(main).toContain("client.createRemotePairingChallenge({relayId})");
    expect(preload).not.toContain("relayToken");
  });

  test("registers Electron power monitoring only after app readiness and tears it down on quit", () => {
    const ready = main.indexOf("void app.whenReady().then(() => {");
    const registration = main.indexOf("registerRemoteControlPowerMonitor();");
    expect(ready).toBeGreaterThan(-1);
    expect(registration).toBeGreaterThan(ready);
    expect(main).toContain('powerMonitor.removeListener("on-battery", reconcileRemoteControlPowerState)');
    expect(main).toContain("unregisterRemoteControlPowerMonitor();");
  });

  test("reconciles the native lease synchronously after every relay status update", () => {
    const statusUpdate = main.indexOf("currentRelayStatus = status;");
    const reconciliation = main.indexOf("reconcileRemoteControlKeepAwake();", statusUpdate);
    expect(statusUpdate).toBeGreaterThan(-1);
    expect(reconciliation).toBeGreaterThan(statusUpdate);
  });

  test("keeps launch-bound ordinary-origin credentials entirely in Electron main", () => {
    expect(preload).toContain('ipcRenderer.invoke("ordinaryChat:sendRoomMessage", {roomId, body})');
    expect(preload).not.toContain("mintElectronOriginCredential");
    expect(preload).not.toContain("electronOriginCredential");
    const handler = main.slice(
      main.indexOf('"ordinaryChat:sendRoomMessage"'),
      main.indexOf("type BoundForegroundShadowController"),
    );
    expect(handler).toContain("getDesktopSessionId()");
    expect(handler).toContain("loadRelayToken(senderSession.serverUrl)");
    expect(handler).toContain("client.mintElectronOriginCredential(");
    expect(handler).toContain("electronOriginCredential: issued.credential");
  });

  test("normalizes the cloned ordinary body exactly once before hashing and sending it", () => {
    const handler = main.slice(
      main.indexOf('"ordinaryChat:sendRoomMessage"'),
      main.indexOf("type BoundForegroundShadowController"),
    );
    const cloned = handler.indexOf("const rendererBody = structuredClone(args.body);");
    const normalized = handler.indexOf(
      "const normalizedBody = normalizeRemoteOrdinaryRequestBody(rendererBody) as unknown as Parameters<NautiloApiClient[\"sendRoomMessage\"]>[1];",
    );
    const hashed = handler.indexOf(
      "canonicalRemoteOrdinaryRequestBody(normalizedBody)",
    );
    const sent = handler.indexOf(
      "client.sendRoomMessage(roomId, normalizedBody, {electronOriginCredential: issued.credential})",
    );

    expect(cloned).toBeGreaterThan(-1);
    expect(normalized).toBeGreaterThan(cloned);
    expect(hashed).toBeGreaterThan(normalized);
    expect(sent).toBeGreaterThan(normalized);
    expect(handler.match(/normalizeRemoteOrdinaryRequestBody\(/g)).toHaveLength(1);
    expect(handler).not.toContain("JSON.stringify(");
    expect(handler).not.toContain("JSON.parse(");
    expect(handler).not.toContain("console.");
  });

  test("locks the Writer optional table-cell selection case to JSON omission semantics", () => {
    const writerSelectionBody = {
      content: "send with Writer context",
      activeMiniApp: {
        selection: {
          anchor: { row: 2, column: 3 },
          focus: { row: 2, column: 3 },
          tableCellRange: undefined,
        },
      },
    };

    expect(normalizeRemoteOrdinaryRequestBody(writerSelectionBody)).toEqual({
      content: "send with Writer context",
      activeMiniApp: {
        selection: {
          anchor: { row: 2, column: 3 },
          focus: { row: 2, column: 3 },
        },
      },
    });
  });
});
