import AsyncStorage from "@react-native-async-storage/async-storage";

const ACTIVE_COMPUTER_KEY_PREFIX = "nautilo.remote.active-computer.v1.";

export interface ActiveComputerStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

function key(serverId: string): string {
  return `${ACTIVE_COMPUTER_KEY_PREFIX}${serverId}`;
}

export async function loadActiveComputer(
  serverId: string,
  storage: ActiveComputerStorage = AsyncStorage,
): Promise<string | null> {
  return storage.getItem(key(serverId));
}

export async function saveActiveComputer(
  serverId: string,
  remoteHostId: string | null,
  storage: ActiveComputerStorage = AsyncStorage,
): Promise<void> {
  if (remoteHostId) {
    await storage.setItem(key(serverId), remoteHostId);
    return;
  }
  await storage.removeItem(key(serverId));
}

/**
 * Preserve an explicit choice. A sole pairing is safe to adopt automatically;
 * multiple pairings without a choice must remain explicit instead of routing
 * file operations to an arbitrary computer.
 */
export function resolveActiveComputer(
  storedRemoteHostId: string | null,
  availableRemoteHostIds: readonly string[],
): string | null {
  if (storedRemoteHostId && availableRemoteHostIds.includes(storedRemoteHostId)) {
    return storedRemoteHostId;
  }
  return availableRemoteHostIds.length === 1 ? availableRemoteHostIds[0] : null;
}
