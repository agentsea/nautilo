/**
 * Dedicated preload script for the first-run picker window (D057 2a.2).
 *
 * Kept separate from preload.ts because the first-run window should NOT
 * receive the broader nautiloDesktop surface (fs, workspace, relay,
 * etc.). The picker has a single responsibility — ask the user which
 * server they want to pair with — and we expose exactly the IPC handles it
 * needs: getConnectTargets, commit, abortAttempt, cancel.
 *
 * Narrower attack surface, cleaner boundary. If we ever ship federation
 * content in the picker it'll ask for its own bridge extension rather
 * than inheriting desktop APIs.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { ConnectionPresentation } from "./connection-presentation";

interface DesktopConfig {
  version: 1;
  mode: "connect";
  serverUrl: string;
}

type ConnectionResult =
  | { ok: true; url: string }
  | { ok: false; reason: "downgrade-confirmation-required"; decisionId: string }
  | { ok: false; reason: "wrong-server"; decisionId: string }
  | { ok: false; reason: "invalid-target" | "offline" | "incompatible" | "stale" | "identity-changed-again" }
  | { ok: false; reason: "promotion-failed"; authoritativePairingChanged: false | true | "unknown" };

interface PickerCandidate {
  label: string;
  url: string;
  source: "layout" | "mdns";
}

interface RecentServerEntry {
  url: string;
  displayName?: string;
  lastUsedAt: string;
}

interface ConnectTargetsPayload {
  candidates: PickerCandidate[];
  recentServers: RecentServerEntry[];
  suggestedUrl: string | null;
  mode: "first-run" | "switch-server" | "add-server";
  currentServerUrl: string | null;
  localDiscovery: { kind: "completed" | "unavailable" };
}

contextBridge.exposeInMainWorld("nautiloFirstRun", {
  getConnectTargets: () =>
    ipcRenderer.invoke("first-run:get-connect-targets") as Promise<ConnectTargetsPayload>,
  commit: (cfg: DesktopConfig) =>
    ipcRenderer.invoke("first-run:commit", cfg) as Promise<ConnectionResult>,
  confirmDowngrade: (decisionId: string) =>
    ipcRenderer.invoke("first-run:confirm-downgrade", decisionId) as Promise<ConnectionResult>,
  acceptIdentity: (decisionId: string) =>
    ipcRenderer.invoke("first-run:accept-identity", decisionId) as Promise<ConnectionResult>,
  abortAttempt: () => ipcRenderer.invoke("first-run:abort-attempt") as Promise<boolean>,
  onConnectionPresentation: (cb: (snapshot: ConnectionPresentation) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, snapshot: ConnectionPresentation): void => cb(snapshot);
    ipcRenderer.on("first-run:connection-presentation", listener);
    return () => ipcRenderer.off("first-run:connection-presentation", listener);
  },
  cancel: () => ipcRenderer.invoke("first-run:cancel") as Promise<void>,
});
