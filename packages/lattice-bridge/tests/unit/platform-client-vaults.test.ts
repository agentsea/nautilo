import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createElectronClientProfileVault,
  type ElectronSafeStoragePort,
} from "../../src/client/electron/index.ts";
import { runClientProfileVaultConformance } from "../../src/testing/index.ts";
import { BrowserClientProfileVault } from "../../src/client/browser/index.ts";

test("Browser lock stays safe when encrypted storage is unsupported", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  try {
    const vault = new BrowserClientProfileVault();
    await vault.lock();
    expect(await vault.availability()).toEqual({ status: "locked" });
  } finally {
    if (originalNavigator === undefined) Reflect.deleteProperty(globalThis, "navigator");
    else Object.defineProperty(globalThis, "navigator", originalNavigator);
  }
});

test("Browser lock waits behind pending profile storage operations", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let releaseOperation!: () => void;
  const operationHeld = new Promise<void>((resolve) => { releaseOperation = resolve; });
  let requestedExclusiveLock = false;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: (_name: string, options: { mode: string }, use: () => Promise<void>) => {
          requestedExclusiveLock = options.mode === "exclusive";
          return operationHeld.then(use);
        },
      },
    },
  });
  try {
    const vault = new BrowserClientProfileVault();
    let finished = false;
    const locking = vault.lock().then(() => { finished = true; });
    await Promise.resolve();
    expect(requestedExclusiveLock).toBe(true);
    expect(finished).toBe(false);
    releaseOperation();
    await locking;
    expect(finished).toBe(true);
    expect(await vault.availability()).toEqual({ status: "locked" });
  } finally {
    releaseOperation();
    if (originalNavigator === undefined) Reflect.deleteProperty(globalThis, "navigator");
    else Object.defineProperty(globalThis, "navigator", originalNavigator);
  }
});

function fakeSafeStorage(
  backend = "keychain",
): ElectronSafeStoragePort {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (value) =>
      Buffer.from(`protected:${value}`, "utf8"),
    decryptString: (value) => {
      const text = value.toString("utf8");
      if (!text.startsWith("protected:")) throw new Error("corrupt");
      return text.slice("protected:".length);
    },
  };
}

describe("Electron client profile vault", () => {
  test("passes the shared vault contract and stores no plaintext profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-electron-vault-"));
    try {
      const vault = createElectronClientProfileVault({
        directory,
        safeStorage: fakeSafeStorage(),
      });
      const report = await runClientProfileVaultConformance(() => vault);
      expect(report.checks).toHaveLength(12);

      const persisted = await readFile(
        join(directory, "client-profile-vault.json"),
        "utf8",
      );
      expect(persisted).not.toContain("[7,8,9]");
      expect(persisted).not.toContain("[11]");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects Electron's Linux basic_text backend", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-electron-vault-"));
    try {
      const vault = createElectronClientProfileVault({
        directory,
        safeStorage: fakeSafeStorage("basic_text"),
      });

      expect(await vault.unlock()).toEqual({
        status: "unsupported",
        reasonCode: "electron_safe_storage_basic_text",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects a stale candidate after another v3 state wins activation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-electron-vault-"));
    try {
      const first = createElectronClientProfileVault({
        directory,
        safeStorage: fakeSafeStorage(),
      });
      const stale = createElectronClientProfileVault({
        directory,
        safeStorage: fakeSafeStorage(),
      });
      expect((await first.unlock()).status).toBe("available");
      expect((await stale.unlock()).status).toBe("available");
      const coordinates = {
        serverScope: "https://nautilo.test",
        userId: "10000000-0000-4000-8000-000000000001",
        humanActorId: "20000000-0000-4000-8000-000000000001",
        profileId: "profile_electron_generation_cas",
        deviceId: "device_electron_generation_cas",
        installationLineageDigest: "ab".repeat(32),
      };
      const publicState = {
        clientKind: "electron" as const,
        publicFingerprint: "cd".repeat(32),
      };
      await first.stageProfile({ coordinates, stageId: "initial", generation: 1,
        profileBytes: new TextEncoder().encode("v3-initial"), publicState });
      await first.activateProfile(coordinates, "initial");
      const contenders = await Promise.allSettled([
        first.stageProfile({ coordinates, stageId: "anchor-wins", generation: 2,
          profileBytes: new TextEncoder().encode("v3-anchor-preserved"), publicState }),
        stale.stageProfile({ coordinates, stageId: "provider-wins", generation: 2,
          profileBytes: new TextEncoder().encode("v3-provider-preserved"), publicState }),
      ]);
      expect(contenders.map(({ status }) => status).sort())
        .toEqual(["fulfilled", "rejected"]);
      const firstWon = contenders[0].status === "fulfilled";
      const winner = firstWon ? first : stale;
      const loser = firstWon ? stale : first;
      const winningStage = firstWon ? "anchor-wins" : "provider-wins";
      const winningProfile = firstWon
        ? "v3-anchor-preserved"
        : "v3-provider-preserved";
      await winner.activateProfile(coordinates, winningStage);

      expect(loser.stageProfile({ coordinates, stageId: "stale-retry", generation: 2,
        profileBytes: new TextEncoder().encode("v3-state-would-overwrite"), publicState }))
        .rejects.toThrow("generation is stale");
      expect(await loser.withOpenProfile(coordinates,
        (bytes) => new TextDecoder().decode(bytes)))
        .toBe(winningProfile);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects a corrupt staged recovery record without rewriting the vault", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-electron-vault-"));
    try {
      const vault = createElectronClientProfileVault({
        directory,
        safeStorage: fakeSafeStorage(),
      });
      expect((await vault.unlock()).status).toBe("available");
      const coordinates = {
        serverScope: "https://nautilo.test",
        userId: "10000000-0000-4000-8000-000000000001",
        humanActorId: "20000000-0000-4000-8000-000000000001",
        profileId: "profile_electron_recovery_corruption",
        deviceId: "device_electron_recovery_corruption",
        installationLineageDigest: "ab".repeat(32),
      };
      const publicState = {
        clientKind: "electron" as const,
        publicFingerprint: "cd".repeat(32),
      };
      const activeBytes = new TextEncoder().encode("active-profile");
      const candidateBytes = new TextEncoder().encode("candidate-profile");
      await vault.stageProfile({ coordinates, stageId: "active", generation: 1,
        profileBytes: activeBytes, publicState });
      await vault.activateProfile(coordinates, "active");
      await vault.stageProfile({ coordinates, stageId: "candidate", generation: 2,
        profileBytes: candidateBytes, publicState });

      const path = join(directory, "client-profile-vault.json");
      const document = JSON.parse(await readFile(path, "utf8")) as {
        records: Array<{ lifecycle: string; ciphertextBase64: string }>;
      };
      const staged = document.records.find((record) => record.lifecycle === "staged")!;
      staged.ciphertextBase64 = `${staged.ciphertextBase64[0] === "A" ? "B" : "A"}${staged.ciphertextBase64.slice(1)}`;
      await writeFile(path, JSON.stringify(document));
      const corruptDocument = await readFile(path, "utf8");

      expect(vault.recoverExactStagedProfile!({
        coordinates,
        expectedActive: { generation: 1, profileBytes: activeBytes, publicState },
        candidate: { generation: 2, profileBytes: candidateBytes, publicState },
      })).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(corruptDocument);
      expect(activeBytes).toEqual(new TextEncoder().encode("active-profile"));
      expect(candidateBytes).toEqual(new TextEncoder().encode("candidate-profile"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
