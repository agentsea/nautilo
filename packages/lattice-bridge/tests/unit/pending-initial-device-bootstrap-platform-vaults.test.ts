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
  createElectronPendingInitialDeviceBootstrapVault,
  type ElectronSafeStoragePort,
} from "../../src/client/electron/index.ts";
import {
  decodePendingInitialDeviceBootstrap,
  encodePendingInitialDeviceBootstrap,
} from "../../src/device/pending-initial-device-bootstrap-codec.ts";
import {
  destroyPendingInitialDeviceBootstrap,
  type PendingInitialDeviceBootstrap,
} from "../../src/device/restart-safe-initial-device-client-ceremony.ts";
import { nautiloActorId, nautiloUserId } from
  "../../src/identity/product-ids.ts";

const DOCUMENT_FILE = "pending-initial-device-bootstrap.json";
const KEY_FILE = "pending-initial-device-bootstrap-key";

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

function pending(revision: 1 | 2 = 1): PendingInitialDeviceBootstrap {
  const user = nautiloUserId("00000000-0000-4000-8000-000000000071");
  const human = nautiloActorId("00000000-0000-4000-8000-000000000072");
  if (!user.ok || !human.ok) throw new Error("invalid fixture identity");
  const request = Object.freeze({
    userId: user.value,
    humanActorId: human.value,
    deviceId: "device:electron",
    clientKind: "electron" as const,
    installationLineageDigest: new Uint8Array(32).fill(0x11),
    signingPublicKey: new Uint8Array(32).fill(0x12),
    encryptionPublicKey: new Uint8Array(65).fill(0x13),
    recoveryKeyId: "recovery:electron",
    recoveryPublicKey: new Uint8Array(65).fill(0x14),
    context: Object.freeze({
      kind: "preparation" as const,
      authorityId: "bootstrap:electron",
    }),
    idempotencyKey: "bootstrap:electron",
  });
  const challenge = revision === 1 ? null : Object.freeze({
    ...request,
    formatVersion: 1 as const,
    challengeId: "challenge:electron",
    authorizationEvidenceDigest: new Uint8Array(32).fill(0x15),
    authorizationDigest: new Uint8Array(32).fill(0x16),
    issuedAt: 100,
    expiresAt: 200,
  });
  return Object.freeze({
    formatVersion: 1,
    revision,
    idempotencyKey: request.idempotencyKey,
    coordinates: Object.freeze({
      serverScope: "https://nautilo.test",
      userId: request.userId,
      humanActorId: request.humanActorId,
      profileId: "profile:electron",
      deviceId: request.deviceId,
      installationLineageDigest: "11".repeat(32),
    }),
    request,
    profileBytes: new Uint8Array([0x21, 0x22, 0x23]),
    recoveryArchiveBytes: new Uint8Array([0x31, 0x32, 0x33]),
    publicFingerprint: new Uint8Array(32).fill(0x41),
    challenge,
    deviceProof: revision === 1 ? null : new Uint8Array(64).fill(0x42),
  });
}

describe("pending initial-device bootstrap canonical codec", () => {
  test("round-trips exact detached bytes and rejects noncanonical JSON", () => {
    const original = pending(2);
    const bytes = encodePendingInitialDeviceBootstrap(original);
    const decoded = decodePendingInitialDeviceBootstrap(bytes);
    expect(decoded).toEqual(original);
    decoded.profileBytes.fill(0);
    expect(original.profileBytes).toEqual(new Uint8Array([0x21, 0x22, 0x23]));

    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const noncanonical = new TextEncoder().encode(JSON.stringify({
      ignored: true,
      ...parsed,
    }));
    expect(() => decodePendingInitialDeviceBootstrap(noncanonical))
      .toThrow("not canonical");
    destroyPendingInitialDeviceBootstrap(decoded);
    bytes.fill(0);
    noncanonical.fill(0);
  });

  test("rejects a revision-two challenge substituted from another request", () => {
    const value = pending(2);
    const substituted = Object.freeze({
      ...value,
      challenge: Object.freeze({ ...value.challenge!, deviceId: "other-device" }),
    });
    expect(() => encodePendingInitialDeviceBootstrap(substituted))
      .toThrow("challenge does not match");
  });
});

describe("Electron sealed pending initial-device bootstrap vault", () => {
  test("atomically restarts, detaches loads, CASes, and removes exact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-pending-bootstrap-"));
    try {
      const first = createElectronPendingInitialDeviceBootstrapVault({
        directory,
        safeStorage: safeStorage(),
      });
      const revisionOne = pending(1);
      expect(await first.create(revisionOne)).toBe("inserted");
      expect(await first.create(pending(1))).toBe("exact_duplicate");
      const collision = pending(1);
      collision.profileBytes[0] = 0xff;
      expect(await first.create(collision)).toBe("collision");

      const persisted = await readFile(join(directory, DOCUMENT_FILE), "utf8");
      expect(persisted).not.toContain("ISIj");
      expect(persisted).not.toContain("MTIz");
      expect((await stat(join(directory, DOCUMENT_FILE))).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, KEY_FILE))).mode & 0o777).toBe(0o600);

      const restarted = createElectronPendingInitialDeviceBootstrapVault({
        directory,
        safeStorage: safeStorage(),
      });
      const detached = await restarted.load(revisionOne.idempotencyKey);
      expect(detached).not.toBeNull();
      detached!.profileBytes.fill(0);
      expect((await restarted.load(revisionOne.idempotencyKey))?.profileBytes)
        .toEqual(revisionOne.profileBytes);

      const revisionTwo = pending(2);
      expect(await restarted.compareAndSwap({
        expected: revisionOne,
        replacement: revisionTwo,
      })).toBe(true);
      expect(await first.compareAndSwap({
        expected: revisionOne,
        replacement: revisionTwo,
      })).toBe(false);
      expect(await restarted.removeExact(revisionOne)).toBe(false);
      expect(await restarted.removeExact(revisionTwo)).toBe(true);
      expect(await restarted.load(revisionOne.idempotencyKey)).toBeNull();
      destroyPendingInitialDeviceBootstrap(detached);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("serializes adapters and fails closed for corruption, key loss, and unsafe storage", async () => {
    const concurrent = await mkdtemp(join(tmpdir(), "nautilo-pending-bootstrap-"));
    const corrupt = await mkdtemp(join(tmpdir(), "nautilo-pending-bootstrap-"));
    const lost = await mkdtemp(join(tmpdir(), "nautilo-pending-bootstrap-"));
    try {
      const left = createElectronPendingInitialDeviceBootstrapVault({
        directory: concurrent, safeStorage: safeStorage(),
      });
      const right = createElectronPendingInitialDeviceBootstrapVault({
        directory: concurrent, safeStorage: safeStorage(),
      });
      expect(await Promise.all([left.create(pending(1)), right.create(pending(1))]))
        .toEqual(["inserted", "exact_duplicate"]);

      const corruptVault = createElectronPendingInitialDeviceBootstrapVault({
        directory: corrupt, safeStorage: safeStorage(),
      });
      await corruptVault.create(pending(1));
      const path = join(corrupt, DOCUMENT_FILE);
      const document = JSON.parse(await readFile(path, "utf8")) as {
        records: { ciphertextBase64: string }[];
      };
      const ciphertext = Buffer.from(document.records[0]!.ciphertextBase64, "base64");
      ciphertext[0] = ciphertext[0]! ^ 1;
      document.records[0]!.ciphertextBase64 = ciphertext.toString("base64");
      await writeFile(path, JSON.stringify(document));
      expect(createElectronPendingInitialDeviceBootstrapVault({
        directory: corrupt, safeStorage: safeStorage(),
      }).load("bootstrap:electron")).rejects.toThrow("authentication failed");

      const lostVault = createElectronPendingInitialDeviceBootstrapVault({
        directory: lost, safeStorage: safeStorage(),
      });
      await lostVault.create(pending(1));
      await unlink(join(lost, KEY_FILE));
      expect(createElectronPendingInitialDeviceBootstrapVault({
        directory: lost, safeStorage: safeStorage(),
      }).load("bootstrap:electron")).rejects.toThrow("wrapping key is missing");

      const unsafeDirectory = await mkdtemp(
        join(tmpdir(), "nautilo-pending-bootstrap-"),
      );
      const unsafe = createElectronPendingInitialDeviceBootstrapVault({
        directory: unsafeDirectory,
        safeStorage: {
          ...safeStorage(),
          getSelectedStorageBackend: () => "basic_text",
        },
      });
      expect(unsafe.create(pending(1))).rejects.toThrow("basic_text");
      await rm(unsafeDirectory, { recursive: true, force: true });
    } finally {
      await rm(concurrent, { recursive: true, force: true });
      await rm(corrupt, { recursive: true, force: true });
      await rm(lost, { recursive: true, force: true });
    }
  });
});
