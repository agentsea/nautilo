import { describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createElectronPreparedMutationJournalVault,
  type ElectronSafeStoragePort,
} from "../../src/client/electron/index.ts";
import {
  PREPARED_MUTATION_JOURNAL_LIMITS,
  PreparedMutationJournalBackpressureError,
  createPreparedMutationJournal,
  decodePreparedMutationJournalIndex,
  type PreparedMutationJournalIndex,
  type PreparedHumanMemoryMutation,
  type PreparedHumanTaskMutation,
} from "../../src/client/memory/prepared-mutation-journal.ts";

const MEMORY_ID = "88000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "88000000-0000-4000-8000-000000000010";
const JOURNAL_FILE = "protected-memory-mutation-journal.json";
const JOURNAL_KEY_FILE = "protected-memory-mutation-journal-key";

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

function mutation(operationId = "electron-create:1"): PreparedHumanMemoryMutation {
  return {
    kind: "create",
    memoryId: MEMORY_ID,
    request: {
      requestVersion: 1,
      operationId,
      memoryId: MEMORY_ID,
      expectedContentRevision: 0,
      nextContentRevision: 1,
      cryptoObjectId: `nautilo-memory-v1:${MEMORY_ID}:1`,
      payloadVersion: 1,
      encryptedPayloadBytesBase64url: "c2VjcmV0LWNpcGhlcnRleHQ",
      accessManifestBytesBase64url: "c2VjcmV0LW1hbmlmZXN0",
      requiredNamespaceIds: [NAMESPACE_ID],
      namespaceEnvelopes: [{
        namespaceId: NAMESPACE_ID,
        envelopeBytesBase64url: "c2VjcmV0LWVudmVsb3Bl",
      }],
      signedContentEmbeddingRequestBytesBase64url: "c2VjcmV0LXNpZ25lZC1wbGFpbnRleHQ",
    },
  };
}

function taskMutation(): PreparedHumanTaskMutation {
  const taskId = "89000000-0000-4000-8000-000000000001";
  return {
    kind: "task_create",
    taskId,
    request: {
      requestVersion: 1,
      operationId: "electron-task-create:1",
      planDigestBase64url: "T".repeat(43),
      taskId,
      expectedContentRevision: 0,
      nextContentRevision: 1,
      expectedCryptoAccessRevision: 0,
      resultCryptoAccessRevision: 0,
      cryptoObjectId: `task:v1:${taskId}:1`,
      payloadVersion: 1,
      requiredNamespaceIds: [NAMESPACE_ID],
      encryptedPayloadBytesBase64url: "dGFzay1jaXBoZXJ0ZXh0",
      accessManifestBytesBase64url: "dGFzay1tYW5pZmVzdA",
      namespaceEnvelopes: [{
        namespaceId: NAMESPACE_ID,
        envelopeBytesBase64url: "dGFzay1lbnZlbG9wZQ",
      }],
      signedPublicationRequestBytesBase64url: "dGFzay1zaWduZWQ",
      representation: "dual",
      ordinaryPayloadBytesBase64url: "c2VjcmV0LXRhc2stcGF5bG9hZA",
      task: {},
      operation: "create",
    },
  };
}

describe("Electron vault-sealed prepared mutation journal", () => {
  test("reopens a prepared Task publication without changing the file generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-mutation-journal-"));
    const storage = safeStorage();
    try {
      const firstVault = createElectronPreparedMutationJournalVault({
        directory,
        safeStorage: storage,
      });
      expect(await firstVault.unlock()).toEqual({ status: "available" });
      await createPreparedMutationJournal({ vault: firstVault, now: () => 1 })
        .putBeforeSend(taskMutation());
      const persisted = await readFile(join(directory, JOURNAL_FILE), "utf8");
      expect(persisted).not.toContain("secret-task-payload");
      expect(persisted).not.toContain("c2VjcmV0LXRhc2stcGF5bG9hZA");
      expect(persisted).not.toContain("ordinaryPayloadBytesBase64url");
      await firstVault.lock();

      const restartedVault = createElectronPreparedMutationJournalVault({
        directory,
        safeStorage: storage,
      });
      expect(await restartedVault.unlock()).toEqual({ status: "available" });
      const restarted = createPreparedMutationJournal({
        vault: restartedVault,
        now: () => 2,
      });
      let opened: unknown;
      await restarted.withPrepared("electron-task-create:1", (mutation) => {
        opened = mutation;
      });
      expect(opened).toEqual(taskMutation());
      expect(await readFile(join(directory, JOURNAL_FILE), "utf8"))
        .toContain('"formatVersion":1');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("accepts the supported Artifact access recovery record after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-mutation-journal-"));
    const storage = safeStorage();
    const operationId = "electron-artifact-access:1";
    const digest = "A".repeat(43);
    const canonicalBody = new TextEncoder().encode("artifact-access-body");
    const index: PreparedMutationJournalIndex = {
      formatVersion: 1,
      operationId,
      authenticatedRequestDigestBase64url: digest,
      kind: "artifact_access",
      artifactId: "88000000-0000-4000-8000-000000000020",
      canonicalBytes: canonicalBody.length,
      sealedBytes: canonicalBody.length + 16,
      createdAt: 1,
      updatedAt: 1,
      attempts: 0,
      attemptWindowStartedAt: null,
      attemptsInWindow: 0,
      nextAttemptAt: 1,
      lastAttemptAt: null,
      state: "pending",
    };
    try {
      const first = createElectronPreparedMutationJournalVault({
        directory,
        safeStorage: storage,
      });
      expect(await first.unlock()).toEqual({ status: "available" });
      expect(await first.putSealed({ index, canonicalBody })).toBe("inserted");
      await first.lock();
      const restarted = createElectronPreparedMutationJournalVault({
        directory,
        safeStorage: storage,
      });
      expect(await restarted.unlock()).toEqual({ status: "available" });
      expect(await restarted.listIndexes()).toEqual([index]);
    } finally {
      canonicalBody.fill(0);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reopens a legacy live-shadow record with a 256-character operation-ID contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-mutation-journal-"));
    const storage = safeStorage();
    const operationId = "l".repeat(256);
    const canonicalBody = new TextEncoder().encode("legacy-live-shadow-body");
    const index: PreparedMutationJournalIndex = {
      formatVersion: 1,
      operationId,
      authenticatedRequestDigestBase64url: "L".repeat(43),
      kind: "live_shadow_message",
      roomId: "88000000-0000-4000-8000-000000000030",
      canonicalBytes: canonicalBody.length,
      sealedBytes: canonicalBody.length + 16,
      createdAt: 1,
      updatedAt: 1,
      attempts: 0,
      attemptWindowStartedAt: null,
      attemptsInWindow: 0,
      nextAttemptAt: 1,
      lastAttemptAt: null,
      state: "pending",
    };
    const { roomId: _roomId, ...commonIndex } = index;
    for (const kind of ["task_create", "task_update"] as const) {
      expect(() => decodePreparedMutationJournalIndex({
        ...commonIndex,
        kind,
        operationId: "t".repeat(129),
        taskId: "89000000-0000-4000-8000-000000000001",
      })).toThrow("corrupt");
    }
    try {
      const first = createElectronPreparedMutationJournalVault({
        directory,
        safeStorage: storage,
      });
      expect(await first.unlock()).toEqual({ status: "available" });
      expect(await first.putSealed({ index, canonicalBody })).toBe("inserted");
      await first.lock();

      const restarted = createElectronPreparedMutationJournalVault({
        directory,
        safeStorage: storage,
      });
      expect(await restarted.unlock()).toEqual({ status: "available" });
      expect(await restarted.listIndexes()).toEqual([index]);
    } finally {
      canonicalBody.fill(0);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("persists atomically, restarts, reseals CAS metadata, and removes exactly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-mutation-journal-"));
    const storage = safeStorage();
    try {
      const firstVault = createElectronPreparedMutationJournalVault({ directory, safeStorage: storage });
      expect(await firstVault.unlock()).toEqual({ status: "available" });
      let now = 1_900_000_000_000;
      const first = createPreparedMutationJournal({ vault: firstVault, now: () => now });
      const inserted = await first.putBeforeSend(mutation());
      expect(inserted.status).toBe("inserted");

      const persisted = await readFile(join(directory, JOURNAL_FILE), "utf8");
      expect(persisted).toContain("electron-create:1");
      expect(persisted).not.toContain("c2VjcmV0LWNpcGhlcnRleHQ");
      expect(persisted).not.toContain("c2VjcmV0LXNpZ25lZC1wbGFpbnRleHQ");

      await firstVault.lock();
      expect(firstVault.listIndexes()).rejects.toThrow("locked");
      const restartedVault = createElectronPreparedMutationJournalVault({ directory, safeStorage: storage });
      expect(await restartedVault.unlock()).toEqual({ status: "available" });
      const restarted = createPreparedMutationJournal({ vault: restartedVault, now: () => now });
      let openedOperation: string | undefined;
      await restarted.withPrepared("electron-create:1", (prepared) => {
        openedOperation = prepared.request.operationId;
      });
      expect(openedOperation).toBe("electron-create:1");

      const current = (await restarted.listStatus())[0]!;
      now += 1;
      await restarted.recordOutcome({
        operationId: current.operationId,
        authenticatedRequestDigestBase64url:
          current.authenticatedRequestDigestBase64url,
        outcome: "retryable",
      });
      const updated = (await restarted.listStatus())[0]!;
      expect(updated.state).toBe("retryable");
      expect(updated.sealedBytes).toBeGreaterThan(updated.canonicalBytes);
      await restarted.recordOutcome({
        operationId: updated.operationId,
        authenticatedRequestDigestBase64url:
          updated.authenticatedRequestDigestBase64url,
        outcome: "completed",
      });
      expect(await restarted.listStatus()).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("serializes two live adapters without losing a record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-mutation-journal-"));
    const storage = safeStorage();
    try {
      const leftVault = createElectronPreparedMutationJournalVault({ directory, safeStorage: storage });
      expect(await leftVault.unlock()).toEqual({ status: "available" });
      const rightVault = createElectronPreparedMutationJournalVault({ directory, safeStorage: storage });
      expect(await rightVault.unlock()).toEqual({ status: "available" });
      const now = () => 1_900_000_000_000;
      const left = createPreparedMutationJournal({ vault: leftVault, now });
      const right = createPreparedMutationJournal({ vault: rightVault, now });
      await Promise.all([
        left.putBeforeSend(mutation("concurrent:left")),
        right.putBeforeSend(mutation("concurrent:right")),
      ]);
      expect((await left.listStatus()).map((entry) => entry.operationId).sort())
        .toEqual(["concurrent:left", "concurrent:right"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails closed for key loss and authenticated-record corruption", async () => {
    const lostDirectory = await mkdtemp(join(tmpdir(), "nautilo-mutation-journal-"));
    const corruptDirectory = await mkdtemp(join(tmpdir(), "nautilo-mutation-journal-"));
    const storage = safeStorage();
    try {
      const lost = createElectronPreparedMutationJournalVault({
        directory: lostDirectory, safeStorage: storage,
      });
      expect(await lost.unlock()).toEqual({ status: "available" });
      await createPreparedMutationJournal({ vault: lost, now: () => 1 })
        .putBeforeSend(mutation("lost:1"));
      await lost.lock();
      await unlink(join(lostDirectory, JOURNAL_KEY_FILE));
      expect(await createElectronPreparedMutationJournalVault({
        directory: lostDirectory, safeStorage: storage,
      }).unlock()).toEqual({
        status: "storage_lost",
        reasonCode: "journal_wrapping_key_missing",
      });

      const corrupt = createElectronPreparedMutationJournalVault({
        directory: corruptDirectory, safeStorage: storage,
      });
      expect(await corrupt.unlock()).toEqual({ status: "available" });
      await createPreparedMutationJournal({ vault: corrupt, now: () => 1 })
        .putBeforeSend(mutation("corrupt:1"));
      await corrupt.lock();
      const path = join(corruptDirectory, JOURNAL_FILE);
      const parsed = JSON.parse(await readFile(path, "utf8")) as {
        records: { ciphertextBase64: string }[];
      };
      const ciphertext = Buffer.from(parsed.records[0]!.ciphertextBase64, "base64");
      ciphertext[0] = ciphertext[0]! ^ 1;
      parsed.records[0]!.ciphertextBase64 = ciphertext.toString("base64");
      await writeFile(path, JSON.stringify(parsed));
      expect(await createElectronPreparedMutationJournalVault({
        directory: corruptDirectory, safeStorage: storage,
      }).unlock()).toEqual({
        status: "corrupt",
        reasonCode: "journal_authentication_failed",
      });
    } finally {
      await rm(lostDirectory, { recursive: true, force: true });
      await rm(corruptDirectory, { recursive: true, force: true });
    }
  });

  test("backpressures at the shared bound without evicting sealed records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-mutation-journal-"));
    try {
      const vault = createElectronPreparedMutationJournalVault({
        directory,
        safeStorage: safeStorage(),
      });
      expect(await vault.unlock()).toEqual({ status: "available" });
      const journal = createPreparedMutationJournal({ vault, now: () => 1 });
      for (let index = 0; index < PREPARED_MUTATION_JOURNAL_LIMITS.maxRecords; index += 1) {
        await journal.putBeforeSend(mutation(`bounded:${String(index).padStart(2, "0")}`));
      }
      expect(journal.putBeforeSend(mutation("bounded:overflow")))
        .rejects.toBeInstanceOf(PreparedMutationJournalBackpressureError);
      expect(await journal.capacity()).toMatchObject({
        records: PREPARED_MUTATION_JOURNAL_LIMITS.maxRecords,
        warning: true,
        full: true,
      });
      expect((await vault.listIndexes())).toHaveLength(
        PREPARED_MUTATION_JOURNAL_LIMITS.maxRecords,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("authenticates the content-free outer index before retry decisions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-mutation-journal-"));
    try {
      const vault = createElectronPreparedMutationJournalVault({
        directory,
        safeStorage: safeStorage(),
      });
      expect(await vault.unlock()).toEqual({ status: "available" });
      await createPreparedMutationJournal({ vault, now: () => 1 })
        .putBeforeSend(mutation("index-tamper:1"));
      await vault.lock();
      const path = join(directory, JOURNAL_FILE);
      const parsed = JSON.parse(await readFile(path, "utf8")) as {
        records: { index: { state: string } }[];
      };
      parsed.records[0]!.index.state = "terminal_denied";
      await writeFile(path, JSON.stringify(parsed));
      expect(await createElectronPreparedMutationJournalVault({
        directory,
        safeStorage: safeStorage(),
      }).unlock()).toEqual({
        status: "corrupt",
        reasonCode: "journal_authentication_failed",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
