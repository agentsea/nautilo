/**
 * Per-server mobile controller identity.
 *
 * The Ed25519 seed is read only long enough to build the signing closure. It
 * is never returned, logged, placed in AsyncStorage, or included in a request.
 * The ordinary AsyncStorage marker distinguishes a genuine install from an
 * iOS Keychain item which survived uninstall/reinstall.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ed25519 } from "@noble/curves/ed25519.js";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const SEED_PREFIX = "nautilo.remote.controller.seed.";
const MARKER_PREFIX = "nautilo.remote.controller.marker.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEED_HEX = /^[0-9a-f]{64}$/;
const installationInitializations = new Map<
  string,
  Promise<ControllerInstallation>
>();

export interface ControllerInstallation {
  readonly installationId: string;
  /** Raw 32-byte Ed25519 public key. */
  readonly publicKey: Uint8Array;
  /** Signs exact UTF-8 transcript bytes; the private seed is closure-only. */
  sign(transcript: Uint8Array): Uint8Array;
}

export interface ControllerInstallationDeps {
  readonly secureStore: Pick<typeof SecureStore, "getItemAsync" | "setItemAsync">;
  readonly asyncStorage: Pick<typeof AsyncStorage, "getItem" | "setItem">;
  readonly randomBytes: (byteCount: number) => Promise<Uint8Array>;
  readonly randomUuid: () => string;
}

const defaultDeps: ControllerInstallationDeps = {
  secureStore: SecureStore,
  asyncStorage: AsyncStorage,
  randomBytes: Crypto.getRandomBytesAsync,
  randomUuid: Crypto.randomUUID,
};

function keys(serverId: string): { seed: string; marker: string } {
  // Server IDs are app-internal `srv_...` values. Refusing an arbitrary key
  // here keeps SecureStore's key requirements explicit at this boundary.
  if (!/^[A-Za-z0-9._-]{1,180}$/.test(serverId)) {
    throw new Error("invalid paired-computer server id");
  }
  return { seed: SEED_PREFIX + serverId, marker: MARKER_PREFIX + serverId };
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array | null {
  if (!SEED_HEX.test(value)) return null;
  const output = new Uint8Array(32);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

function parseStored(value: string | null): { installationId: string; seed: Uint8Array } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { installationId?: unknown; seedHex?: unknown };
    if (typeof parsed.installationId !== "string" || !UUID.test(parsed.installationId)) return null;
    if (typeof parsed.seedHex !== "string") return null;
    const seed = fromHex(parsed.seedHex);
    return seed ? { installationId: parsed.installationId, seed } : null;
  } catch {
    return null;
  }
}

function materialToInstallation(material: { installationId: string; seed: Uint8Array }): ControllerInstallation {
  // `keygen(seed)` is deliberate: it lets us retain exactly the 32-byte seed
  // in SecureStore instead of a derived/private-expanded representation.
  const keyPair = ed25519.keygen(material.seed);
  return {
    installationId: material.installationId,
    publicKey: keyPair.publicKey,
    sign: (transcript) => ed25519.sign(transcript, keyPair.secretKey),
  };
}

async function rotate(
  storageKeys: { seed: string; marker: string },
  deps: ControllerInstallationDeps,
): Promise<ControllerInstallation> {
  const seed = await deps.randomBytes(32);
  if (seed.length !== 32) throw new Error("mobile installation random seed has invalid length");
  const installationId = deps.randomUuid().toLowerCase();
  if (!UUID.test(installationId)) throw new Error("mobile installation random UUID is invalid");
  await deps.secureStore.setItemAsync(
    storageKeys.seed,
    JSON.stringify({ installationId, seedHex: toHex(seed) }),
    { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
  );
  // Write this last. If it fails, next boot safely rotates rather than treating
  // an uncertain installation as the prior one.
  // The marker is non-secret, but it must match this exact SecureStore record.
  // That detects a partial restore/backup divergence as well as Keychain
  // survival after uninstall.
  await deps.asyncStorage.setItem(storageKeys.marker, installationId);
  return materialToInstallation({ installationId, seed });
}

async function initializeControllerInstallation(
  storageKeys: { seed: string; marker: string },
  deps: ControllerInstallationDeps,
): Promise<ControllerInstallation> {
  const [marker, stored] = await Promise.all([
    deps.asyncStorage.getItem(storageKeys.marker),
    deps.secureStore.getItemAsync(storageKeys.seed),
  ]);
  // Keychain/Keystore surviving while application data did not is a reinstall,
  // not continuity. Rotate both controller identity and installation UUID.
  const parsed = parseStored(stored);
  const material = parsed && marker === parsed.installationId ? parsed : null;
  return material ? materialToInstallation(material) : rotate(storageKeys, deps);
}

export function loadOrCreateControllerInstallation(
  serverId: string,
  deps: ControllerInstallationDeps = defaultDeps,
): Promise<ControllerInstallation> {
  // Validate before publishing an entry in the process-local single-flight map.
  let storageKeys: { seed: string; marker: string };
  try {
    storageKeys = keys(serverId);
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  const existing = installationInitializations.get(serverId);
  if (existing) return existing;

  const initialization = initializeControllerInstallation(storageKeys, deps);
  installationInitializations.set(serverId, initialization);
  void initialization.then(
    () => {
      if (installationInitializations.get(serverId) === initialization) {
        installationInitializations.delete(serverId);
      }
    },
    () => {
      // A transient native/storage rejection must not poison this server id.
      if (installationInitializations.get(serverId) === initialization) {
        installationInitializations.delete(serverId);
      }
    },
  );
  return initialization;
}
