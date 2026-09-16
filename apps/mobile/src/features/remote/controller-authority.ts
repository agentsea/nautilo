import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ConsumeRemotePairingChallengeResponse } from "@nautilo/api-client/browser";

const AUTHORITY_PREFIX = "nautilo.remote.controller.authority.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface RemoteControllerAuthority {
  readonly controllerInstallationId: string;
  readonly installationId: string;
  readonly installationGeneration: number;
  readonly serverInstanceId: string;
  readonly serverBindingGeneration: number;
}

export interface ControllerAuthorityStorage {
  readonly getItem: (key: string) => Promise<string | null>;
  readonly setItem: (key: string, value: string) => Promise<void>;
}

function key(serverId: string): string {
  if (!/^[A-Za-z0-9._-]{1,180}$/.test(serverId)) {
    throw new Error("invalid paired-computer server id");
  }
  return AUTHORITY_PREFIX + serverId;
}

function parse(value: string | null): RemoteControllerAuthority | null {
  if (!value) return null;
  try {
    const candidate = JSON.parse(value) as Record<string, unknown>;
    const ids = [
      candidate["controllerInstallationId"],
      candidate["installationId"],
      candidate["serverInstanceId"],
    ];
    if (!ids.every((id) => typeof id === "string" && UUID.test(id))) return null;
    const installationGeneration = candidate["installationGeneration"];
    const serverBindingGeneration = candidate["serverBindingGeneration"];
    if (
      typeof installationGeneration !== "number" ||
      !Number.isSafeInteger(installationGeneration) ||
      installationGeneration < 1 ||
      typeof serverBindingGeneration !== "number" ||
      !Number.isSafeInteger(serverBindingGeneration) ||
      serverBindingGeneration < 1
    ) return null;
    return {
      controllerInstallationId: ids[0] as string,
      installationId: ids[1] as string,
      installationGeneration,
      serverInstanceId: ids[2] as string,
      serverBindingGeneration,
    };
  } catch {
    return null;
  }
}

/** Retains only non-secret server-issued proof context after pairing commits. */
export async function retainRemoteControllerAuthority(
  serverId: string,
  response: ConsumeRemotePairingChallengeResponse,
  storage: ControllerAuthorityStorage = AsyncStorage,
): Promise<void> {
  const authority: RemoteControllerAuthority = {
    controllerInstallationId: response.controllerInstallationId,
    installationId: response.installationId,
    installationGeneration: response.installationGeneration,
    serverInstanceId: response.serverInstanceId,
    serverBindingGeneration: response.serverBindingGeneration,
  };
  await storage.setItem(key(serverId), JSON.stringify(authority));
}

export async function loadRemoteControllerAuthority(
  serverId: string,
  storage: ControllerAuthorityStorage = AsyncStorage,
): Promise<RemoteControllerAuthority | null> {
  return parse(await storage.getItem(key(serverId)));
}
