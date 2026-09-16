import { describe, expect, mock, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { canonicalRemotePairingTranscript } from "@nautilo/types";
import type { ControllerInstallationDeps } from "./controller-installation";

// Native modules are not parseable in Bun's Node test runtime. Production
// imports remain static for Metro; these fakes only isolate the unit seam.
mock.module("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => {} },
}));
mock.module("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "when-unlocked-this-device-only",
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));
mock.module("expo-crypto", () => ({
  getRandomBytesAsync: async (size: number) => new Uint8Array(size),
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}));

const { prepareRemotePairingConsumeProof } = await import("./controller-proof");
const { loadOrCreateControllerInstallation } = await import("./controller-installation");

function fakeDeps(): ControllerInstallationDeps {
  const secure = new Map<string, string>();
  const normal = new Map<string, string>();
  let counter = 0;
  return {
    secureStore: {
      getItemAsync: async (key) => secure.get(key) ?? null,
      setItemAsync: async (key, value) => { secure.set(key, value); },
    },
    asyncStorage: {
      getItem: async (key) => normal.get(key) ?? null,
      setItem: async (key, value) => { normal.set(key, value); },
    },
    randomBytes: async () => new Uint8Array(32).fill(++counter),
    randomUuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  };
}

const challengeId = "11111111-1111-4111-8111-111111111111";
const context = "ab".repeat(32);
const installationUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("paired mobile installation", () => {
  test("coalesces concurrent initialization for one server into one stored identity", async () => {
    const base = fakeDeps();
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let secureWrites = 0;
    let markerWrites = 0;
    let randomReads = 0;
    const deps: ControllerInstallationDeps = {
      ...base,
      secureStore: {
        getItemAsync: async (key) => {
          await readGate;
          return base.secureStore.getItemAsync(key);
        },
        setItemAsync: async (key, value, options) => {
          secureWrites += 1;
          await base.secureStore.setItemAsync(key, value, options);
        },
      },
      asyncStorage: {
        getItem: base.asyncStorage.getItem,
        setItem: async (key, value) => {
          markerWrites += 1;
          await base.asyncStorage.setItem(key, value);
        },
      },
      randomBytes: async (size) => {
        randomReads += 1;
        return base.randomBytes(size);
      },
    };

    const first = loadOrCreateControllerInstallation("srv_singleflight", deps);
    const second = loadOrCreateControllerInstallation("srv_singleflight", deps);
    expect(second).toBe(first);
    releaseRead();
    const [left, right] = await Promise.all([first, second]);

    expect(left.installationId).toBe(right.installationId);
    expect(Array.from(left.publicKey)).toEqual(Array.from(right.publicKey));
    expect({ secureWrites, markerWrites, randomReads }).toEqual({
      secureWrites: 1,
      markerWrites: 1,
      randomReads: 1,
    });
  });

  test("initializes different servers independently", async () => {
    const blockedBase = fakeDeps();
    let releaseBlocked!: () => void;
    const blockedGate = new Promise<void>((resolve) => {
      releaseBlocked = resolve;
    });
    const blockedDeps: ControllerInstallationDeps = {
      ...blockedBase,
      secureStore: {
        ...blockedBase.secureStore,
        getItemAsync: async (key) => {
          await blockedGate;
          return blockedBase.secureStore.getItemAsync(key);
        },
      },
    };

    const blocked = loadOrCreateControllerInstallation(
      "srv_blocked",
      blockedDeps,
    );
    const independent = await loadOrCreateControllerInstallation(
      "srv_independent",
      fakeDeps(),
    );
    expect(independent.installationId).toMatch(installationUuid);
    releaseBlocked();
    await blocked;
  });

  test("clears a rejected single-flight so the server can retry", async () => {
    const base = fakeDeps();
    let shouldReject = true;
    let reads = 0;
    const deps: ControllerInstallationDeps = {
      ...base,
      secureStore: {
        ...base.secureStore,
        getItemAsync: async (key) => {
          reads += 1;
          if (shouldReject) throw new Error("secure store unavailable");
          return base.secureStore.getItemAsync(key);
        },
      },
    };

    let rejection: unknown;
    try {
      await loadOrCreateControllerInstallation("srv_retry", deps);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe("secure store unavailable");
    shouldReject = false;
    const retried = await loadOrCreateControllerInstallation("srv_retry", deps);
    expect(retried.installationId).toMatch(installationUuid);
    expect(reads).toBe(2);
  });

  test("rotates a surviving secure key when the ordinary install marker is absent", async () => {
    const deps = fakeDeps();
    const first = await loadOrCreateControllerInstallation("srv_example", deps);
    const second = await loadOrCreateControllerInstallation("srv_example", deps);
    expect(second.installationId).toBe(first.installationId);
    // Simulate uninstall: AsyncStorage disappears while Keychain remains.
    const withoutMarker = { ...deps, asyncStorage: { getItem: async () => null, setItem: deps.asyncStorage.setItem } };
    const reinstalled = await loadOrCreateControllerInstallation("srv_example", withoutMarker);
    expect(reinstalled.installationId).not.toBe(first.installationId);
    expect(Array.from(reinstalled.publicKey)).not.toEqual(Array.from(first.publicKey));
  });

  test("rotates when non-secret application state belongs to another installation", async () => {
    const deps = fakeDeps();
    const first = await loadOrCreateControllerInstallation("srv_example", deps);
    const mismatchedMarker = {
      ...deps,
      asyncStorage: {
        getItem: async () => "00000000-0000-4000-8000-999999999999",
        setItem: deps.asyncStorage.setItem,
      },
    };
    const rotated = await loadOrCreateControllerInstallation("srv_example", mismatchedMarker);
    expect(rotated.installationId).not.toBe(first.installationId);
  });

  test("signs canonical transcript without exposing the stored seed", async () => {
    const prepared = await prepareRemotePairingConsumeProof({
      serverId: "srv_example",
      challengeId,
      ceremonyContext: context,
      deps: fakeDeps(),
    });
    const transcript = canonicalRemotePairingTranscript({
      challengeId,
      ceremonyContext: context,
      installationId: prepared.installationId,
      algorithm: prepared.proof.algorithm,
      publicKey: prepared.proof.publicKey,
    });
    const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((value) => Number.parseInt(value, 16)));
    expect(ed25519.verify(bytes(prepared.proof.signature), new TextEncoder().encode(transcript), bytes(prepared.proof.publicKey))).toBe(true);
  });
});
