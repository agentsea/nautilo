/**
 * M056 — Electron-bound facade over the pure `relay-pair` module.
 * Imports `electron` + `node:fs` directly; only main-process code
 * should pull this in.
 */
import { app, safeStorage } from "electron";
import * as fs from "node:fs";
import { hostname } from "node:os";
import { installationIdFilePath, physicalDeviceSeedFilePath } from "../paths";
import {
  clearRelayToken as clearRelayTokenImpl,
  retireRelayToken as retireRelayTokenImpl,
  loadRelayToken as loadRelayTokenImpl,
  getOrCreateInstallationId as getOrCreateInstallationIdImpl,
  pairRelay as pairRelayImpl,
  relayTokenRequiresPairingCutover as relayTokenRequiresPairingCutoverImpl,
  type RelayPairDeps,
} from "./relay-pair";

function deps(): RelayPairDeps {
  return {
    fs: {
      writeFileSync: fs.writeFileSync,
      readFileSync: fs.readFileSync,
      renameSync: fs.renameSync,
      unlinkSync: fs.unlinkSync,
      mkdirSync: fs.mkdirSync,
      linkSync: fs.linkSync,
      rmdirSync: fs.rmdirSync,
    },
    safeStorage,
    userDataDir: app.getPath("userData"),
    // D418 — single source of truth for the installation-id basename lives
    // in paths.ts; thread the resolved path through so relay-pair.ts doesn't
    // hardcode a duplicate.
    installationIdPath: installationIdFilePath(),
    physicalDeviceSeedPath: physicalDeviceSeedFilePath(),
    fetchImpl: globalThis.fetch.bind(globalThis),
    hostname,
  };
}

/** Reuse the canonical stable Electron installation coordinate for crypto custody. */
export function getOrCreateInstallationId(): string {
  return getOrCreateInstallationIdImpl(deps());
}

export async function pairRelay(args: {
  serverUrl: string;
  accessToken: string;
  trustedServerFingerprint: string;
  capabilities?: Record<string, unknown>;
}): Promise<string> {
  return pairRelayImpl(deps(), args);
}

export function loadRelayToken(serverUrl: string): string | null {
  return loadRelayTokenImpl(deps(), { serverUrl });
}

export function relayTokenRequiresPairingCutover(args: {
  serverUrl: string;
  trustedServerFingerprint: string;
  requirePairingContractV2?: boolean;
}): boolean {
  return relayTokenRequiresPairingCutoverImpl(deps(), args);
}

export function clearRelayToken(serverUrl: string): void {
  clearRelayTokenImpl(deps(), { serverUrl });
}

export function retireRelayToken(serverUrl: string): void {
  retireRelayTokenImpl(deps(), { serverUrl });
}
