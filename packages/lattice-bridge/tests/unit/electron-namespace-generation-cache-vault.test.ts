import { describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createElectronClientNamespaceGenerationCacheVaultV1,
} from "../../src/client/electron/namespace-generation-cache-vault.ts";
import type { ElectronSafeStoragePort } from
  "../../src/client/electron/index.ts";
import {
  CLIENT_NAMESPACE_GENERATION_CACHE_MAX_ENTRIES_V1,
  CLIENT_NAMESPACE_GENERATION_CACHE_MAX_PENDING_V1,
  destroyClientNamespaceGenerationCacheEntryV1,
  destroyPendingClientNamespaceGenerationPublicationV1,
  type ClientNamespaceGenerationCacheEntryV1,
  type PendingClientNamespaceGenerationPublicationV1,
} from "../../src/client-vault/namespace-generation-cache-v1.ts";
import type { ClientProfileCoordinates } from
  "../../src/client-vault/types.ts";

const DOCUMENT_FILE = "namespace-generation-cache-v1.json";
const KEY_FILE = "namespace-generation-cache-v1-key";

const COORDINATES: ClientProfileCoordinates = Object.freeze({
  serverScope: "https://electron-cache.test",
  userId: "10000000-0000-4000-8000-000000000300",
  humanActorId: "20000000-0000-4000-8000-000000000300",
  profileId: "profile_m300_electron_cache",
  deviceId: "device_m300_electron_cache",
  installationLineageDigest: "30".repeat(32),
});

const OTHER_COORDINATES: ClientProfileCoordinates = Object.freeze({
  ...COORDINATES,
  profileId: "profile_m300_electron_cache_other",
  deviceId: "device_m300_electron_cache_other",
});

function safeStorage(): ElectronSafeStoragePort {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "keychain",
    encryptString: (plaintext) => Buffer.from(`protected:${plaintext}`, "utf8"),
    decryptString: (ciphertext) => {
      const value = ciphertext.toString("utf8");
      if (!value.startsWith("protected:")) throw new Error("safeStorage corrupt");
      return value.slice("protected:".length);
    },
  };
}

function entry(seed = 1, namespaceId = `namespace:m300:${seed}`):
ClientNamespaceGenerationCacheEntryV1 {
  return Object.freeze({
    namespaceId,
    keyClass: "ai" as const,
    accessRevision: 2,
    generation: 1,
    headDigest: new Uint8Array(32).fill(seed % 256),
    publicationDigest: new Uint8Array(32).fill((seed + 1) % 256),
    publicationSetDigest: new Uint8Array(32).fill((seed + 2) % 256),
    audienceFingerprint: new Uint8Array(32).fill((seed + 3) % 256),
    recipientKeyGeneration: 4,
    generationKey: new Uint8Array(32).fill((seed + 4) % 256),
  });
}

function publication(
  operationId: string,
  expiresAt: number,
): PendingClientNamespaceGenerationPublicationV1 {
  const ai = entry(10, `namespace:m300:${operationId}`);
  const human = Object.freeze({ ...entry(10, ai.namespaceId), keyClass: "human" as const });
  return Object.freeze({
    formatVersion: 1 as const,
    operationId,
    namespaceId: ai.namespaceId,
    expiresAt,
    publicationSetBytes: new Uint8Array([1, 2, 3, 4]),
    entries: Object.freeze([ai, human]),
  });
}

describe("Electron sealed Namespace generation cache", () => {
  test("seals privately, detaches bytes, and resumes after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-electron-cache-"));
    const storage = safeStorage();
    const current = entry();
    try {
      const vault = createElectronClientNamespaceGenerationCacheVaultV1({
        directory,
        safeStorage: storage,
      });
      expect(await vault.availability()).toEqual({ status: "locked" });
      expect(vault.putEntries(COORDINATES, [current])).rejects.toThrow("locked");
      expect(vault.withEntries(COORDINATES, [current], () => true))
        .rejects.toThrow("locked");
      expect(await vault.unlock()).toEqual({ status: "available" });
      await vault.putEntries(COORDINATES, [current]);

      current.generationKey.fill(99);
      const first = await vault.withEntries(COORDINATES, [current], (entries) => {
        const opened = entries[0]!.generationKey.slice();
        entries[0]!.generationKey.fill(88);
        return opened;
      });
      expect(first.status).toBe("hit");
      if (first.status === "hit") {
        expect(first.value).toEqual(new Uint8Array(32).fill(5));
        first.value.fill(0);
      }

      const sealed = await readFile(join(directory, DOCUMENT_FILE), "utf8");
      expect(sealed).not.toContain(current.namespaceId);
      expect((await stat(join(directory, DOCUMENT_FILE))).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, KEY_FILE))).mode & 0o777).toBe(0o600);
      await vault.lock();

      const restarted = createElectronClientNamespaceGenerationCacheVaultV1({
        directory,
        safeStorage: storage,
      });
      expect(await restarted.unlock()).toEqual({ status: "available" });
      const requirement = entry();
      try {
        expect(await restarted.withEntries(
          COORDINATES,
          [requirement],
          (entries) => entries[0]!.generationKey[0],
        )).toEqual({ status: "hit", value: 5 });
      } finally {
        destroyClientNamespaceGenerationCacheEntryV1(requirement);
      }
    } finally {
      destroyClientNamespaceGenerationCacheEntryV1(current);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("serializes live adapters and preserves pending publication lifecycle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-electron-cache-"));
    const storage = safeStorage();
    const first = publication("publication:m300:first", 100);
    const second = publication("publication:m300:second", 200);
    try {
      const left = createElectronClientNamespaceGenerationCacheVaultV1({ directory, safeStorage: storage });
      const right = createElectronClientNamespaceGenerationCacheVaultV1({ directory, safeStorage: storage });
      expect(await left.unlock()).toEqual({ status: "available" });
      expect(await right.unlock()).toEqual({ status: "available" });
      await Promise.all([
        left.stagePublication(COORDINATES, first),
        right.stagePublication(OTHER_COORDINATES, second),
      ]);
      expect(await left.withPendingPublication(
        OTHER_COORDINATES,
        second.operationId,
        (pending) => pending.expiresAt,
      )).toEqual({ status: "present", value: 200 });
      expect(await left.pruneExpiredPublications?.(COORDINATES, 150)).toBe(1);
      expect(await left.withPendingPublication(
        COORDINATES,
        first.operationId,
        () => true,
      )).toEqual({ status: "absent" });
      expect(await left.withPendingPublication(
        OTHER_COORDINATES,
        second.operationId,
        () => true,
      )).toEqual({ status: "present", value: true });
      await left.activatePublication(OTHER_COORDINATES, second.operationId);
      expect(await left.withEntries(
        OTHER_COORDINATES,
        [second.entries[0]!],
        () => "activated",
      )).toEqual({ status: "hit", value: "activated" });
    } finally {
      destroyPendingClientNamespaceGenerationPublicationV1(first);
      destroyPendingClientNamespaceGenerationPublicationV1(second);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("enforces the shared entry bound by evicting the oldest entry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-electron-cache-"));
    const entries = Array.from(
      { length: CLIENT_NAMESPACE_GENERATION_CACHE_MAX_ENTRIES_V1 + 1 },
      (_, index) => entry(index + 1, `namespace:m300:bounded:${index}`),
    );
    try {
      const vault = createElectronClientNamespaceGenerationCacheVaultV1({
        directory,
        safeStorage: safeStorage(),
      });
      expect(await vault.unlock()).toEqual({ status: "available" });
      await vault.putEntries(COORDINATES, entries);
      expect(await vault.withEntries(COORDINATES, [entries[0]!], () => true))
        .toEqual({ status: "miss" });
      expect(await vault.withEntries(COORDINATES, [entries.at(-1)!], () => true))
        .toEqual({ status: "hit", value: true });
    } finally {
      entries.forEach(destroyClientNamespaceGenerationCacheEntryV1);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("isolates coordinates and implements collision, abort, evict, and forget semantics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-electron-cache-"));
    const current = entry(21, "namespace:m300:lifecycle");
    const first = publication("publication:m300:lifecycle:first", 100);
    const second = publication("publication:m300:lifecycle:second", 200);
    const third = publication("publication:m300:lifecycle:third", 300);
    const collision = publication(first.operationId, first.expiresAt + 1);
    try {
      const vault = createElectronClientNamespaceGenerationCacheVaultV1({
        directory,
        safeStorage: safeStorage(),
      });
      expect(await vault.unlock()).toEqual({ status: "available" });
      await vault.putEntries(COORDINATES, [current]);
      expect(await vault.withEntries(OTHER_COORDINATES, [current], () => true))
        .toEqual({ status: "miss" });

      await vault.stagePublication(COORDINATES, first);
      await vault.stagePublication(COORDINATES, first);
      expect(vault.stagePublication(COORDINATES, collision)).rejects.toThrow(
        "collided",
      );
      await vault.stagePublication(OTHER_COORDINATES, second);
      expect(CLIENT_NAMESPACE_GENERATION_CACHE_MAX_PENDING_V1).toBe(2);
      expect(vault.stagePublication(COORDINATES, third)).rejects.toThrow(
        "inventory is full",
      );
      await vault.abortPublication(OTHER_COORDINATES, second.operationId);
      await vault.stagePublication(COORDINATES, third);

      await vault.evict(COORDINATES, current.namespaceId);
      expect(await vault.withEntries(COORDINATES, [current], () => true))
        .toEqual({ status: "miss" });
      await vault.forget(COORDINATES);
      expect(await vault.withPendingPublication(
        COORDINATES,
        first.operationId,
        () => true,
      )).toEqual({ status: "absent" });
      expect(await vault.withPendingPublication(
        COORDINATES,
        third.operationId,
        () => true,
      )).toEqual({ status: "absent" });
    } finally {
      destroyClientNamespaceGenerationCacheEntryV1(current);
      for (const pending of [first, second, third, collision]) {
        destroyPendingClientNamespaceGenerationPublicationV1(pending);
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails closed when the dedicated wrapping key is lost or ciphertext is corrupt", async () => {
    const lostDirectory = await mkdtemp(join(tmpdir(), "nautilo-electron-cache-"));
    const corruptDirectory = await mkdtemp(join(tmpdir(), "nautilo-electron-cache-"));
    const storage = safeStorage();
    const current = entry();
    try {
      const lost = createElectronClientNamespaceGenerationCacheVaultV1({
        directory: lostDirectory,
        safeStorage: storage,
      });
      expect(await lost.unlock()).toEqual({ status: "available" });
      await lost.putEntries(COORDINATES, [current]);
      await lost.lock();
      await unlink(join(lostDirectory, KEY_FILE));
      expect(await createElectronClientNamespaceGenerationCacheVaultV1({
        directory: lostDirectory,
        safeStorage: storage,
      }).unlock()).toEqual({
        status: "storage_lost",
        reasonCode: "namespace_cache_wrapping_key_missing",
      });

      const corrupt = createElectronClientNamespaceGenerationCacheVaultV1({
        directory: corruptDirectory,
        safeStorage: storage,
      });
      expect(await corrupt.unlock()).toEqual({ status: "available" });
      await corrupt.putEntries(COORDINATES, [current]);
      await corrupt.lock();
      const documentPath = join(corruptDirectory, DOCUMENT_FILE);
      const document = JSON.parse(await readFile(documentPath, "utf8")) as {
        ciphertextBase64: string;
      };
      const ciphertext = Buffer.from(document.ciphertextBase64, "base64");
      ciphertext[0] = ciphertext[0]! ^ 1;
      document.ciphertextBase64 = ciphertext.toString("base64");
      await writeFile(documentPath, JSON.stringify(document));
      expect(await createElectronClientNamespaceGenerationCacheVaultV1({
        directory: corruptDirectory,
        safeStorage: storage,
      }).unlock()).toEqual({
        status: "corrupt",
        reasonCode: "namespace_cache_authentication_failed",
      });
    } finally {
      destroyClientNamespaceGenerationCacheEntryV1(current);
      await rm(lostDirectory, { recursive: true, force: true });
      await rm(corruptDirectory, { recursive: true, force: true });
    }
  });

  test("heals an interrupted wrapping-key rotation from the authentic previous key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-electron-cache-"));
    const storage = safeStorage();
    const current = entry(31, "namespace:m300:rotation");
    try {
      const vault = createElectronClientNamespaceGenerationCacheVaultV1({
        directory,
        safeStorage: storage,
      });
      expect(await vault.unlock()).toEqual({ status: "available" });
      await vault.putEntries(COORDINATES, [current]);
      await vault.lock();

      const keyPath = join(directory, KEY_FILE);
      const protectedKey = (await readFile(keyPath, "utf8"))
        .slice("protected:".length);
      const envelope = JSON.parse(protectedKey) as { currentBase64: string };
      const interrupted = {
        formatVersion: 1,
        currentBase64: Buffer.alloc(32, 0xab).toString("base64"),
        previousBase64: envelope.currentBase64,
      };
      await writeFile(
        keyPath,
        `protected:${JSON.stringify(interrupted)}`,
        { mode: 0o600 },
      );

      const restarted = createElectronClientNamespaceGenerationCacheVaultV1({
        directory,
        safeStorage: storage,
      });
      expect(await restarted.unlock()).toEqual({ status: "available" });
      expect(await restarted.withEntries(
        COORDINATES,
        [current],
        (entries) => entries[0]!.generationKey[0],
      )).toEqual({ status: "hit", value: 35 });
      const healed = JSON.parse(
        (await readFile(keyPath, "utf8")).slice("protected:".length),
      ) as Record<string, unknown>;
      expect(healed).toEqual({
        formatVersion: 1,
        currentBase64: envelope.currentBase64,
      });
    } finally {
      destroyClientNamespaceGenerationCacheEntryV1(current);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects unavailable and insecure safeStorage backends", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-electron-cache-"));
    try {
      expect(await createElectronClientNamespaceGenerationCacheVaultV1({
        directory,
        safeStorage: { ...safeStorage(), isEncryptionAvailable: () => false },
      }).unlock()).toEqual({
        status: "unsupported",
        reasonCode: "electron_safe_storage_unavailable",
      });
      expect(await createElectronClientNamespaceGenerationCacheVaultV1({
        directory,
        safeStorage: { ...safeStorage(), getSelectedStorageBackend: () => "basic_text" },
      }).unlock()).toEqual({
        status: "unsupported",
        reasonCode: "electron_safe_storage_basic_text",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
